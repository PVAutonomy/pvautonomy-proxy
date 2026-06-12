import type { BuildRecord, BuildResponse, BuildStatus, Env } from "../types.js";
import { jsonError, jsonResponse } from "../errors.js";
import { buildKey, BUILD_RECORD_TTL } from "../kv/schema.js";
import { pollGitHubRun } from "../github/poll.js";
import { resolveArtifacts } from "../github/artifacts.js";
import { releaseBuildLock } from "../guards/concurrency.js";

const TERMINAL_STATES: BuildStatus[] = ["success", "failed", "timeout"];

// ISSUE-6: read-side self-heal budget for success-without-artifact records.
// Heal attempts only happen on client polls of a poisoned record, so the cap
// bounds the extra GitHub API calls to 5 per record lifetime regardless of
// client cadence; the 24h record TTL ends even that. ?refresh=1 deliberately
// ignores this cap (explicit, client-initiated escape hatch).
const MAX_ARTIFACT_RESOLVE_ATTEMPTS = 5;

function isTerminal(status: BuildStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/** GET /build/:id — lazy-refresh from GitHub if non-terminal.
 *
 * ISSUE-6 additions for terminal records:
 * - Self-heal: status "success" with artifact null gets artifact resolution
 *   re-attempted on read (bounded by MAX_ARTIFACT_RESOLVE_ATTEMPTS); a
 *   successful re-resolve is persisted.
 * - ?refresh=1 (ops EPIC-006-D2): force a GitHub re-poll + artifact
 *   re-resolution instead of returning the cache. Status transitions only
 *   as reported by GitHub.
 */
export async function handleBuildStatus(
  env: Env,
  buildId: string,
  opts: { refresh?: boolean } = {},
): Promise<Response> {
  const record = await env.BUILD_STATE.get<BuildRecord>(
    buildKey(buildId),
    "json",
  );

  if (!record) {
    return jsonError(404, `Build not found: ${buildId}`);
  }

  if (isTerminal(record.status)) {
    if (opts.refresh) {
      // ISSUE-6: explicit refresh — re-poll GitHub and re-resolve artifacts.
      await refreshTerminalRecord(env, record);
      return jsonResponse(formatResponse(record));
    }

    // ISSUE-6: self-heal a poisoned record (success but no artifact) —
    // success-only; failed/timeout records have no artifact to resolve.
    if (
      record.status === "success" &&
      record.artifact === null &&
      (record.artifact_resolve_attempts ?? 0) < MAX_ARTIFACT_RESOLVE_ATTEMPTS
    ) {
      record.artifact_resolve_attempts =
        (record.artifact_resolve_attempts ?? 0) + 1;
      try {
        const artifact = await resolveArtifacts(env, record);
        if (artifact) {
          record.artifact = artifact;
        }
      } catch {
        // Heal failure is non-fatal; the attempt still counts
      }
      record.updated_at = new Date().toISOString();
      try {
        await persistRecord(env, record);
      } catch {
        // KV write failure is non-fatal; respond with in-memory state
      }
    }

    // Terminal → return cached (possibly just repaired)
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

/** ISSUE-6: ?refresh=1 on a terminal record — re-poll GitHub for the run
 * status and re-resolve artifacts, then persist. Never invents state:
 * status/progress only change to what GitHub reports, and a healthy
 * artifact is never overwritten with null. Deliberately does NOT check or
 * increment artifact_resolve_attempts: refresh is the explicit,
 * client-initiated escape hatch that must keep working after the read-side
 * heal budget is exhausted.
 */
async function refreshTerminalRecord(
  env: Env,
  record: BuildRecord,
): Promise<void> {
  if (record.github_run_id) {
    try {
      const ghStatus = await pollGitHubRun(env, record.github_run_id);
      record.status = ghStatus.status;
      record.progress = ghStatus.progress;
      record.github_run_url = ghStatus.run_url;
      if (!isTerminal(record.status)) {
        // GitHub reports the run as live again (e.g. re-run): the stored
        // error/completed_at described a terminal state GitHub no longer
        // reports — clear them rather than mixing old and new state.
        record.error = null;
        record.completed_at = null;
      }
    } catch {
      // Poll failure is non-fatal; keep last known status
    }
  }

  if (record.status === "success") {
    try {
      const artifact = await resolveArtifacts(env, record);
      if (artifact) {
        record.artifact = artifact;
      }
    } catch {
      // Resolution failure is non-fatal; keep last known artifact
    }
    if (!record.completed_at) {
      record.completed_at = new Date().toISOString();
    }
  }

  record.updated_at = new Date().toISOString();
  try {
    await persistRecord(env, record);
  } catch {
    // KV write failure is non-fatal; respond with in-memory state
  }
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
