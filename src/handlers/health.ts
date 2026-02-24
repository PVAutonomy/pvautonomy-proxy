import type { Env } from "../types.js";
import { jsonResponse } from "../errors.js";

/** GET /health — public, no auth required. */
export async function handleHealth(env: Env): Promise<Response> {
  let githubOk = false;
  try {
    const resp = await fetch("https://api.github.com/rate_limit", {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "pvautonomy-proxy/0.1.0",
      },
    });
    githubOk = resp.ok;
  } catch {
    githubOk = false;
  }

  return jsonResponse({
    status: githubOk ? "ok" : "degraded",
    version: "0.1.0",
    github_api_ok: githubOk,
  });
}
