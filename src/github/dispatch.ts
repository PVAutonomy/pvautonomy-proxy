import type { BuildPayload, Env } from "../types.js";

export interface DispatchResult {
  run_id: number;
  run_url: string;
}

const USER_AGENT = "pvautonomy-proxy/0.1.0";

/**
 * EPIC-006-B7 hotfix #3: normalize ota_required to the workflow's
 * string wire shape ("1" for truthy, "" for falsy).
 *
 * HA's ProxyRemoteBuildBackend.start_build() sends ota_required as a
 * JSON boolean (Python True/False); other callers may send a string.
 * Validation has already restricted the value space to:
 *   - undefined
 *   - boolean
 *   - one of "", "0", "1", "true", "false" (case-insensitive)
 * so this helper does the deterministic string mapping without any
 * further error path.
 */
export function normalizeOtaRequired(
  v: string | boolean | undefined,
): string {
  if (v === true) return "1";
  if (v === false || v === undefined) return "";
  const norm = v.toLowerCase();
  return norm === "1" || norm === "true" ? "1" : "";
}

/**
 * Trigger a GitHub Actions workflow_dispatch with return_run_details.
 * Returns the run_id directly (no correlation heuristics needed).
 *
 * Requires GitHub API 2022-11-28+ and the Feb 2026 return_run_details feature.
 */
export async function triggerWorkflowDispatch(
  env: Env,
  buildId: string,
  deviceKey: string,
  payload: BuildPayload,
): Promise<DispatchResult> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`;

  // EPIC-006-B7: forward every input declared by
  // inverter-registry/.github/workflows/build-firmware-on-demand.yml
  // (11 inputs after PVAutonomy/inverter-registry#7 added yaml_hash).
  // Empty strings are sent for absent optional fields — workflow input
  // defaults are "". When the workflow sees a non-empty yaml_hash it
  // verifies it against the SHA-256 of the decoded yaml_content and
  // fails closed on mismatch, giving end-to-end binding between the
  // YAML bytes HA hashed and the YAML bytes the runner compiles.
  const inputs: Record<string, string> = {
    registry_file: payload.registry_file,
    device_name: payload.device_name,
    version: payload.version ?? "",
    build_id: buildId,
    // EPIC-006-B7 hotfix #3: normalize boolean / string ota_required.
    ota_required: normalizeOtaRequired(payload.ota_required),
    device_key: deviceKey,
    encrypted_secrets: payload.encrypted_secrets ?? "",
    build_contract: payload.build_contract ?? "",
    yaml_content: payload.yaml_content ?? "",
    yaml_hash: payload.yaml_hash ?? "",
    compile_secret_envelope: payload.compile_secret_envelope ?? "",
  };

  const body = {
    ref: "main",
    return_run_details: true,
    inputs,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });

  // New API (return_run_details: true) → 200 with run details
  if (response.status === 200) {
    const data = (await response.json()) as Record<string, unknown>;

    // The run object may be at top level or nested under a key.
    // Robustly extract run_id and html_url.
    const htmlUrl = (data.html_url ?? data.url ?? "") as string;
    let runId = typeof data.id === "number" ? data.id : 0;

    // Fallback: parse run_id from URL (.../actions/runs/12345)
    if (!runId && htmlUrl) {
      const match = htmlUrl.match(/\/runs\/(\d+)/);
      if (match) runId = parseInt(match[1], 10);
    }

    if (!runId) {
      throw new Error(
        `GitHub returned 200 but no run_id found. Response keys: ${Object.keys(data).join(",")}`,
      );
    }

    return { run_id: runId, run_url: htmlUrl };
  }

  // Legacy 204 (shouldn't happen with return_run_details)
  if (response.status === 204) {
    throw new Error(
      "GitHub returned 204 without run details. " +
        "Verify GitHub API supports return_run_details.",
    );
  }

  // Error
  const errorText = await response.text();
  throw new Error(
    `GitHub dispatch failed: HTTP ${response.status} — ${errorText}`,
  );
}
