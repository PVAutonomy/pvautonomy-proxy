import type { BuildPayload, Env } from "../types.js";

export interface DispatchResult {
  run_id: number;
  run_url: string;
}

const USER_AGENT = "pvautonomy-proxy/0.1.0";

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

  // EPIC-006-B7: forward every input currently declared by
  // inverter-registry/.github/workflows/build-firmware-on-demand.yml
  // (10 inputs). Empty strings are sent for absent optional fields —
  // workflow input defaults are "".
  //
  // yaml_hash is deliberately NOT forwarded yet: the workflow at HEAD
  // (475c787) does not declare a yaml_hash input, so passing it would
  // cause GitHub to reject the dispatch with HTTP 422. Forwarding will
  // be enabled in a follow-up commit once inverter-registry adds the
  // input and the hash-binding compare step (handover step 2).
  const inputs: Record<string, string> = {
    registry_file: payload.registry_file,
    device_name: payload.device_name,
    version: payload.version ?? "",
    build_id: buildId,
    ota_required: payload.ota_required ?? "",
    device_key: deviceKey,
    encrypted_secrets: payload.encrypted_secrets ?? "",
    build_contract: payload.build_contract ?? "",
    yaml_content: payload.yaml_content ?? "",
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
