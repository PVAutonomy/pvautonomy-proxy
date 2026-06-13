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

// ISSUE-14: persist-on-transition. Only these fields change a build's *meaning*
// to callers and downstream consumers; `progress`/`updated_at` churn on every
// poll. Gating the non-terminal poll-path write on a change to this signature
// drops per-build KV writes from ~1/poll (~120/build) to a handful (create +
// real transitions + bounded deferred-success attempts), keeping the free-tier
// daily write budget viable. The terminal self-heal (attempt-increment),
// timeout, and ?refresh=1 paths persist independently and are unaffected.
function transitionSignature(record: BuildRecord): string {
  return JSON.stringify([
    record.status,
    record.artifact,
    record.error,
    record.completed_at ?? null,
    record.artifact_resolve_attempts ?? 0,
  ]);
}

/** GET /build/:id — lazy-refresh from GitHub if non-terminal.
 *
 * ISSUE-6 follow-up (deferred success): a run that GitHub reports as
 * success is only reported "success" to callers once its artifact info is
 * resolved — until then the record stays non-terminal ("running",
 * progress 95) so polling callers retry, bounded by
 * MAX_ARTIFACT_RESOLVE_ATTEMPTS; after the budget, terminal success
 * without artifact is persisted (previous behavior, ?refresh=1 as last
 * resort).
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

  // ISSUE-14: snapshot the meaning-bearing fields before any mutation so the
  // non-terminal poll path can skip the KV write when nothing transitioned.
  const beforeSignature = transitionSignature(record);

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

      // On success → resolve artifacts BEFORE reporting success.
      // ISSUE-6 follow-up: callers stop polling on "success", so reporting
      // success without artifact info loses the race against GitHub's
      // release-API lag (incidents dd8ed40d 2026-06-11, 4121c62c
      // 2026-06-12: resolution returned null in the seconds window right
      // after run completion although all assets were published). Defer:
      // stay non-terminal ("running", progress 95) so the polling pipeline
      // naturally retries, bounded by MAX_ARTIFACT_RESOLVE_ATTEMPTS. Only
      // after the budget is exhausted is success-without-artifact persisted
      // (previous behavior — ops' ?refresh=1 remains the last resort).
      if (record.status === "success") {
        const resolved = await resolveArtifacts(env, record);
        const attempts = record.artifact_resolve_attempts ?? 0;
        if (resolved) {
          record.artifact = resolved;
          record.completed_at = new Date().toISOString();
          await releaseBuildLock(env.BUILD_STATE, record.customer_id, record.build_id);
        } else if (attempts < MAX_ARTIFACT_RESOLVE_ATTEMPTS) {
          record.artifact_resolve_attempts = attempts + 1;
          record.status = "running";
          record.progress = 95;
          console.warn(
            `[build ${record.build_id}] run succeeded but artifact ` +
              `resolution returned null (attempt ${attempts + 1}/` +
              `${MAX_ARTIFACT_RESOLVE_ATTEMPTS}) — deferring success, ` +
              `caller will re-poll`,
          );
          // Lock deliberately NOT released: the build is not done for the
          // caller until its artifact exists (or the budget is exhausted).
        } else {
          record.artifact = null;
          record.completed_at = new Date().toISOString();
          console.warn(
            `[build ${record.build_id}] artifact resolution budget ` +
              `exhausted (${MAX_ARTIFACT_RESOLVE_ATTEMPTS} attempts) — ` +
              `persisting terminal success without artifact; ` +
              `?refresh=1 is the remaining repair path`,
          );
          await releaseBuildLock(env.BUILD_STATE, record.customer_id, record.build_id);
        }
      }

      // On failure → release lock
      if (isTerminal(record.status) && record.status !== "success") {
        record.completed_at = new Date().toISOString();
        record.error = `Build ${record.status}`;
        await releaseBuildLock(env.BUILD_STATE, record.customer_id, record.build_id);
      }

      // ISSUE-14: persist only when a meaning-bearing field transitioned;
      // skip the write for pure progress/updated_at churn between polls.
      if (transitionSignature(record) !== beforeSignature) {
        await persistRecord(env, record);
      }
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
