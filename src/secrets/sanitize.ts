import type { BuildRecord } from "../types.js";

/**
 * Persistence-only secret guard (pvautonomy-config#141, #141b).
 *
 * The proxy receives per-build secret-bearing fields inside `BuildPayload`
 * (`encrypted_secrets`, `compile_secret_envelope`) so it can forward them to
 * the GHA workflow_dispatch call. Only that dispatch needs the live values:
 * everything persisted to KV (`build:*` records) must use the sanitized form
 * produced here, so a KV dump can never reconstruct the secret-bearing bytes.
 * This restores the "secret-blind proxy" property from the private proxy line
 * that was dropped in the public repo-split extraction.
 *
 * Scope (deliberately narrow): this redacts secret-bearing fields before
 * persistence. It does NOT validate envelope shape/AAD — `compile_secret_envelope`
 * is an opaque string in this codebase, so the whole value is redacted rather
 * than stripped to metadata. Object-level envelope validation/stripping is a
 * separate follow-up (it needs an envelope string->object model change).
 */

/** Sentinel substituted for redacted fields. */
export const REDACTED = "[redacted]";

/**
 * Exact key names whose values must never be persisted. `encrypted_secrets`
 * and `compile_secret_envelope` are the real `BuildPayload` fields; the rest
 * are defensive guards against future/nested secret-bearing keys.
 *
 * Exact-match ONLY (never substring) so audit-safe fields are preserved —
 * e.g. `secret_context_hash` is a sha256 hex, not a secret, and must survive.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "encrypted_secrets",
  "compile_secret_envelope",
  "compile_secret",
  "compile_secret_key",
  "secrets",
  "secret",
  "private_key",
  "privateKey",
  "seed",
  "authorization",
  "Authorization",
  "proxy_api_key",
  "api_key",
]);

/** Recursively redact secret-bearing keys (exact-match) in place. */
function redactInPlace(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) redactInPlace(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SECRET_KEYS.has(key)) {
      const value = obj[key];
      // Only redact present, non-empty values — keep undefined/null/"" as-is
      // so the persisted shape matches what the client sent.
      if (value !== undefined && value !== null && value !== "") {
        obj[key] = REDACTED;
      }
    } else {
      redactInPlace(obj[key]);
    }
  }
}

/**
 * Return a deep clone of `record` safe to persist to KV: every secret-bearing
 * field in `payload` is replaced with {@link REDACTED}. Non-secret metadata
 * (customer_id, device_name, registry_file, version, yaml_hash,
 * secret_context_hash, yaml_content, status/timestamps/artifact) is preserved
 * so build-status polling and audit are unaffected.
 *
 * Pure: never mutates the input. Idempotent. Persistence-only — the live
 * `req.payload` is dispatched to GitHub BEFORE this runs, so workflow_dispatch
 * still receives the original values.
 */
export function sanitizeBuildRecordForPersist(record: BuildRecord): BuildRecord {
  const clone: BuildRecord = structuredClone(record);
  if (clone.payload) redactInPlace(clone.payload);
  return clone;
}
