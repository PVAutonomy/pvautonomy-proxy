import type { Env } from "../types.js";

/**
 * GET /build-backend/keys — authenticated (router auth gate), environment-gated
 * TEST-only keyset endpoint. HPKE-1, pvautonomy-config#139.
 *
 * Serves a pre-signed PUBLIC build-backend keyset supplied out-of-band via the
 * HPKE_TEST_KEYSET binding. The Worker holds no signing private key: the
 * Ed25519 root key lives offline and the keyset is signed during the (future,
 * HPKE-3) production ceremony. This endpoint is a pass-through document server,
 * not a signer.
 *
 * Fail-closed contract with the HA verifier (pvautonomy_ops/secret_envelope.py
 * verify_signed_keyset / load_or_refresh_keyset):
 * - binding unset/empty  -> 404. 404/405 are the ONLY conditions under which HA
 *   may fall back to the legacy payload.encrypted_secrets path, so an
 *   unconfigured proxy keeps the legacy path working.
 * - binding present but unparseable / wrong shape / carries private material
 *   -> 500 (generic error, no configured bytes echoed). HA fails closed; we
 *   never silently fall back and never leak the misconfigured value.
 * - binding present and a valid PUBLIC keyset document -> 200, served verbatim.
 *
 * The signature itself is verified by HA against its pinned Ed25519 root
 * anchors; the proxy only guarantees it never serves private key material.
 *
 * Never logs the keyset, the Authorization header, or the request body. Does
 * not process payload.compile_secret_envelope.
 */

/**
 * Field names that must never appear anywhere in a served keyset document —
 * a public keyset endpoint shipping any of these signals a leaked private half
 * or a misconfigured backend. Defense-in-depth mirror of the HA verifier's
 * private-material guard (it rejects `private_key`); we widen it slightly.
 */
const FORBIDDEN_FIELDS = new Set([
  "private_key",
  "privateKey",
  "secret",
  "seed",
]);

const KEYSET_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
  // Key rotation + anti-rollback are serial-driven and re-verified by HA on
  // every fetch; during the TEST phase we keep dry-runs deterministic with no
  // edge caching. A rotation-aware cache policy is deferred to HPKE-4/HPKE-7.
  "Cache-Control": "no-store",
};

export function handleBuildBackendKeys(env: Env): Response {
  const raw = env.HPKE_TEST_KEYSET;
  if (typeof raw !== "string" || raw.trim() === "") {
    return jsonResponse(
      { error: "build-backend keyset not configured", status: 404 },
      404,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return misconfigured();
  }

  if (!isPublicKeysetDocument(parsed)) {
    return misconfigured();
  }

  return jsonResponse(parsed, 200);
}

/** Generic 500 — never include the configured keyset or any of its bytes. */
function misconfigured(): Response {
  return jsonResponse(
    { error: "build-backend keyset misconfigured", status: 500 },
    500,
  );
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: KEYSET_HEADERS,
  });
}

/**
 * Minimal shape + safety gate. We deliberately validate only the structural
 * invariants the HA verifier also requires (so a shape it would reject never
 * leaves the proxy) plus the no-private-material rule. The cryptographic
 * verification (signature against pinned roots, serial, expiry) stays HA-side.
 */
function isPublicKeysetDocument(doc: unknown): boolean {
  if (!isPlainObject(doc)) return false;

  const keyset = doc.keyset;
  if (!isPlainObject(keyset)) return false;

  const signatures = doc.signatures;
  if (!Array.isArray(signatures) || signatures.length === 0) return false;

  const keys = keyset.keys;
  if (!Array.isArray(keys) || keys.length === 0) return false;

  if (containsForbiddenField(doc)) return false;

  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Iterative walk over the parsed document; returns true if any object key is a
 * forbidden (private-material) name. Iterative, not recursive, to keep stack
 * usage bounded on adversarial input. Never logs the offending node.
 */
function containsForbiddenField(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (FORBIDDEN_FIELDS.has(key)) return true;
        stack.push(child);
      }
    }
  }
  return false;
}
