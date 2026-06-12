import type { BuildStatus, Env } from "../types.js";
import { getGithubToken } from "./auth.js";

const USER_AGENT = "pvautonomy-proxy/0.1.0";

/** Map GitHub workflow run status + conclusion to proxy BuildStatus. */
export function mapGitHubStatus(
  ghStatus: string,
  ghConclusion: string | null,
): { status: BuildStatus; progress: number } {
  // Terminal: GitHub sets conclusion when status=completed
  if (ghConclusion) {
    const conclusionMap: Record<string, BuildStatus> = {
      success: "success",
      failure: "failed",
      cancelled: "failed",
      timed_out: "timeout",
      action_required: "failed",
      stale: "failed",
      skipped: "failed",
    };
    return { status: conclusionMap[ghConclusion] ?? "failed", progress: 100 };
  }

  // Non-terminal
  const statusMap: Record<string, { status: BuildStatus; progress: number }> = {
    queued: { status: "queued", progress: 5 },
    waiting: { status: "queued", progress: 5 },
    requested: { status: "queued", progress: 5 },
    pending: { status: "queued", progress: 5 },
    in_progress: { status: "running", progress: 50 },
  };

  return statusMap[ghStatus] ?? { status: "queued", progress: 0 };
}

export interface GitHubRunStatus {
  status: BuildStatus;
  progress: number;
  run_url: string;
}

/** Poll a single GitHub Actions workflow run. */
export async function pollGitHubRun(
  env: Env,
  runId: number,
): Promise<GitHubRunStatus> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${runId}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await getGithubToken(env)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: HTTP ${response.status}`);
  }

  const run = (await response.json()) as {
    status: string;
    conclusion: string | null;
    html_url: string;
  };

  const mapped = mapGitHubStatus(run.status, run.conclusion);
  return { ...mapped, run_url: run.html_url };
}
