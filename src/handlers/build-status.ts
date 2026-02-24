import type { BuildRecord, BuildResponse, BuildStatus, Env } from "../types.js";
import { jsonError, jsonResponse } from "../errors.js";
import { buildKey, BUILD_RECORD_TTL } from "../kv/schema.js";
import { pollGitHubRun } from "../github/poll.js";
import { resolveArtifacts } from "../github/artifacts.js";
import { releaseBuildLock } from "../guards/concurrency.js";

const TERMINAL_STATES: BuildStatus[] = ["success", "failed", "timeout"];

function isTerminal(status: BuildStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/** GET /build/:id — lazy-refresh from GitHub if non-terminal. */
export async function handleBuildStatus(
  env: Env,
  buildId: string,
): Promise<Response> {
  const record = await env.BUILD_STATE.get<BuildRecord>(
    buildKey(buildId),
    "json",
  );

  if (!record) {
    return jsonError(404, `Build not found: ${buildId}`);
  }

  // Terminal → return cached
  if (isTerminal(record.status)) {
    return jsonResponse(formatResponse(record));
  }

  // Non-terminal → poll GitHub for fresh status
  if (record.github_run_id) {
    try {
      // Check build timeout
      const elapsed = Date.now() - new Date(record.created_at).getTime();
      const timeoutMs = parseInt(
        (typeof env.BUILD_TIMEOUT_MS === "string" ? env.BUILD_TIMEOUT_MS : null) ?? "900000",
      );
      if (elapsed > timeoutMs) {
        record.status = "timeout";
        record.error = `Build exceeded ${Math.round(timeoutMs / 60000)}min timeout`;
        record.completed_at = new Date().toISOString();
        record.progress = 100;
        await releaseBuildLock(env.BUILD_STATE, record.customer_id, record.build_id);
        await persistRecord(env, record);
        return jsonResponse(formatResponse(record));
      }

      const ghStatus = await pollGitHubRun(env, record.github_run_id);
      record.status = ghStatus.status;
      record.progress = ghStatus.progress;
      record.github_run_url = ghStatus.run_url;
      record.updated_at = new Date().toISOString();

      // On success → resolve artifacts
      if (record.status === "success") {
        record.completed_at = new Date().toISOString();
        record.artifact = await resolveArtifacts(env, record);
        await releaseBuildLock(env.BUILD_STATE, record.customer_id, record.build_id);
      }

      // On failure → release lock
      if (isTerminal(record.status) && record.status !== "success") {
        record.completed_at = new Date().toISOString();
        record.error = `Build ${record.status}`;
        await releaseBuildLock(env.BUILD_STATE, record.customer_id, record.build_id);
      }

      await persistRecord(env, record);
    } catch {
      // Poll failure is non-fatal; return last known state
    }
  }

  return jsonResponse(formatResponse(record));
}

function formatResponse(record: BuildRecord): BuildResponse {
  return {
    build_id: record.build_id,
    status: record.status,
    progress: record.progress,
    run_url: record.github_run_url,
    artifact: record.artifact,
    error: record.error,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

async function persistRecord(env: Env, record: BuildRecord): Promise<void> {
  await env.BUILD_STATE.put(buildKey(record.build_id), JSON.stringify(record), {
    expirationTtl: BUILD_RECORD_TTL,
  });
}
