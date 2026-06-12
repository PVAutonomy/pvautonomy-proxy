import type { Env } from "../types.js";
import { jsonResponse } from "../errors.js";
// ISSUE-7: deploy metadata stamped at build time by scripts/gen-version.mjs
// (via `npm run deploy` or the deploy workflow); "dev" in tests/dev builds.
import { BUILT_AT, GIT_SHA } from "../version.generated.js";
import pkg from "../../package.json";

/** GET /health — public, no auth required. */
export async function handleHealth(env: Env): Promise<Response> {
  let githubOk = false;
  try {
    const resp = await fetch("https://api.github.com/rate_limit", {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: "application/vnd.github+json",
        "User-Agent": `pvautonomy-proxy/${pkg.version}`,
      },
    });
    githubOk = resp.ok;
  } catch {
    githubOk = false;
  }

  return jsonResponse({
    status: githubOk ? "ok" : "degraded",
    version: pkg.version,
    git_sha: GIT_SHA,
    built_at: BUILT_AT,
    github_api_ok: githubOk,
  });
}
