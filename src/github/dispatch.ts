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
  payload: BuildPayload,
): Promise<DispatchResult> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`;

  const body = {
    ref: "main",
    return_run_details: true,
    inputs: {
      registry_file: payload.registry_file,
      device_name: payload.device_name,
      version: payload.version || "",
      build_id: buildId,
      ...(payload.encrypted_secrets
        ? { encrypted_secrets: payload.encrypted_secrets }
        : {}),
    },
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
    const data = (await response.json()) as {
      id: number;
      html_url: string;
    };
    return { run_id: data.id, run_url: data.html_url };
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
