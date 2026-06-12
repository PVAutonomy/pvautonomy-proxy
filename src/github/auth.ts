import type { Env } from "../types.js";

const USER_AGENT = "pvautonomy-proxy/0.1.0";

/**
 * GHAPP-1: central GitHub auth helper.
 *
 * Two auth modes, selected per request by configuration:
 *
 *  - "app": GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY
 *    are all set → mint a GitHub App installation token (RS256 app JWT →
 *    POST /app/installations/{id}/access_tokens) and cache it in-memory.
 *  - "pat": anything missing → fall back to the legacy GITHUB_PAT secret.
 *
 * The fallback is deliberate migration behavior: the [vars] GITHUB_APP_ID /
 * GITHUB_APP_INSTALLATION_ID ship with the code, but the
 * GITHUB_APP_PRIVATE_KEY secret is set in a later GO. With IDs present but
 * the key missing the worker must keep using the PAT (not throw), so the
 * merge stays deployable before the secret exists.
 */

/** Which credential source getGithubToken(env) will use. */
export function getAuthMode(env: Env): "app" | "pat" {
  return env.GITHUB_APP_ID &&
    env.GITHUB_APP_INSTALLATION_ID &&
    env.GITHUB_APP_PRIVATE_KEY
    ? "app"
    : "pat";
}

interface CachedToken {
  token: string;
  /** Epoch ms; stop reusing this long before GitHub's expires_at. */
  reuseUntilMs: number;
}

// In-memory cache, one slot per Worker isolate (Planner decision: NOT KV —
// no secret-at-rest; re-minting after isolate recycling is negligible at
// this traffic). Installation tokens live 60 min; we reuse until 10 min
// before expiry.
let cachedToken: CachedToken | null = null;

const REUSE_MARGIN_MS = 10 * 60 * 1000;

/** Test-only: clear the module-level token cache between test cases. */
export function _resetTokenCacheForTests(): void {
  cachedToken = null;
}

/**
 * Resolve the bearer token for GitHub API calls.
 *
 * App path: returns a cached installation token while it has more than
 * 10 minutes of lifetime left, otherwise mints a fresh one. PAT path:
 * returns the PAT as-is. Throws only when neither credential source is
 * configured at all.
 */
export async function getGithubToken(env: Env): Promise<string> {
  if (getAuthMode(env) === "pat") {
    if (env.GITHUB_PAT) return env.GITHUB_PAT;
    throw new Error(
      "No GitHub credentials configured: set GITHUB_APP_ID + " +
        "GITHUB_APP_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY (app auth) " +
        "or GITHUB_PAT (legacy fallback).",
    );
  }

  if (cachedToken && Date.now() < cachedToken.reuseUntilMs) {
    return cachedToken.token;
  }

  const minted = await mintInstallationToken(env);
  cachedToken = {
    token: minted.token,
    reuseUntilMs: Date.parse(minted.expires_at) - REUSE_MARGIN_MS,
  };
  return minted.token;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

/**
 * Mint a GitHub App installation token: sign a short-lived RS256 app JWT
 * with WebCrypto, then exchange it at the installation access_tokens
 * endpoint.
 *
 * The returned token is an OPAQUE string — no length, prefix, or format
 * assumptions anywhere (GitHub is moving to stateless ghs_… tokens up to
 * ~520 chars).
 */
async function mintInstallationToken(
  env: Env,
): Promise<InstallationTokenResponse> {
  const jwt = await signAppJwt(env.GITHUB_APP_PRIVATE_KEY!, env.GITHUB_APP_ID!);

  const url = `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `GitHub App installation token mint failed: HTTP ${response.status} — ${errorText}`,
    );
  }

  const data = (await response.json()) as Partial<InstallationTokenResponse>;
  if (!data.token || !data.expires_at) {
    throw new Error(
      "GitHub App installation token response missing token/expires_at",
    );
  }
  return { token: data.token, expires_at: data.expires_at };
}

/**
 * Build and sign the GitHub App JWT (RS256 via WebCrypto).
 *
 * Claims per GitHub docs: iat backdated 60 s for clock drift, exp 9 min
 * out (max allowed is 10), iss = App ID.
 *
 * ASSUMPTION: the private key secret is a PKCS#8 PEM
 * ("-----BEGIN PRIVATE KEY-----"). GitHub downloads keys as PKCS#1; the
 * operator converts before `wrangler secret put`:
 *   openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem
 */
async function signAppJwt(privateKeyPem: string, appId: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iat: nowSec - 60, exp: nowSec + 540, iss: appId };

  const encoder = new TextEncoder();
  const signingInput =
    base64UrlEncode(encoder.encode(JSON.stringify(header))) +
    "." +
    base64UrlEncode(encoder.encode(JSON.stringify(claims)));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );

  return signingInput + "." + base64UrlEncode(new Uint8Array(signature));
}

/** Decode a PKCS#8 PEM body to DER bytes for crypto.subtle.importKey. */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
