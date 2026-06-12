import type { Env } from "../types.js";
import { jsonResponse } from "../errors.js";
import { getGithubToken } from "../github/auth.js";
// ISSUE-7: deploy metadata stamped at build time by scripts/gen-version.mjs
// (via `npm run deploy` or the deploy workflow); "dev" in tests/dev builds.
import { BUILT_AT, GIT_SHA } from "../version.generated.js";
import pkg from "../../package.json";

/** GET /health — public, no auth required. */
export async function handleHealth(env: Env): Promise<Response> {
  let githubOk = false;
  let contentsOk = false;
  let tokenDaysLeft: number | null = null;

  try {
    const token = await getGithubToken(env);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": `pvautonomy-proxy/${pkg.version}`,
    };

    const rateResp = await fetch("https://api.github.com/rate_limit", {
      headers,
    });
    githubOk = rateResp.ok;

    // GHAPP-1: probe the Contents-read path that failed in the 2026-06-12
    // 403 incident (PAT missing the Contents permission) — the rate_limit
    // check alone cannot see permission gaps.
    const contentsResp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases?per_page=1`,
      { headers },
    );
    contentsOk = contentsResp.ok;
    tokenDaysLeft = parseTokenDaysLeft(
      contentsResp.headers.get("github-authentication-token-expiration"),
    );
  } catch {
    githubOk = false;
    contentsOk = false;
  }

  return jsonResponse({
    status: githubOk && contentsOk ? "ok" : "degraded",
    version: pkg.version,
    git_sha: GIT_SHA,
    built_at: BUILT_AT,
    github_api_ok: githubOk,
    github_contents_ok: contentsOk,
    // GHAPP-2: kept for API stability; PAT fallback removed, app is the
    // only auth mode.
    auth_mode: "app",
    token_days_left: tokenDaysLeft,
  });
}

/**
 * GHAPP-1: days until the GitHub token expires, from the
 * `github-authentication-token-expiration` response header. GitHub sends
 * it for (fine-grained) PATs, either ISO-8601 or "YYYY-MM-DD HH:MM:SS UTC".
 * App installation tokens do NOT get this header (they self-renew hourly),
 * so null means "no expiry exposed", not an error.
 */
function parseTokenDaysLeft(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const normalized = headerValue.includes("UTC")
    ? headerValue.replace(" UTC", "Z").replace(" ", "T")
    : headerValue;
  const expiresMs = Date.parse(normalized);
  if (Number.isNaN(expiresMs)) return null;
  return Math.floor((expiresMs - Date.now()) / 86_400_000);
}
