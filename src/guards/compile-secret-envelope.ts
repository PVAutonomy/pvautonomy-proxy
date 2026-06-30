// Edge validation for payload.compile_secret_envelope (pvautonomy-config#142).
//
// Defense-in-depth ONLY: the proxy never decrypts and holds no keys. This guard
// rejects a malformed envelope or an AAD that does not bind to the POST /build
// request context, BEFORE the envelope is forwarded to the GHA workflow. HPKE
// provides the cryptographic enforcement end-to-end; the GHA decrypt re-checks
// the same AAD against the runner inputs.
//
// Shape is aligned to the ONLY producer — HA's
// custom_components/pvautonomy_ops/secret_envelope.py seal_compile_secret_envelope()
// (and the GHA consumer .github/scripts/decrypt_compile_secret_envelope.py).
// The producer AAD contains NO customer_id and NO model, so this guard does not
// (cannot) bind those via AAD; customer_id and model are validated elsewhere
// (build-create customer_id match; SUPPORTED_MODELS).
//
// Error strings name fields only — never enc, ciphertext, request_nonce, or any
// secret-bearing value.

const PINNED_ALG =
  "HPKE-Base-DHKEM_X25519_HKDF_SHA256-HKDF_SHA256-CHACHA20_POLY1305";
const ENVELOPE_VERSION = 1;

// Producer uses STANDARD base64 (Python base64.b64encode), not base64url.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64_RE = /^[a-f0-9]{64}$/i;
const ENC_BYTES = 32; // X25519 HPKE encapsulation
const REQUEST_NONCE_BYTES = 16; // producer REQUEST_NONCE_LEN
// Compile-secret plaintext is a few k=v lines; its b64 ciphertext stays small.
// Generous cap as a cheap DoS/shape guard (the whole body is already capped by
// MAX_PAYLOAD_BYTES upstream).
const MAX_CIPHERTEXT_B64_LEN = 16384;

/** Request context the envelope AAD must bind to. */
export interface EnvelopeBindContext {
  device_key: string; // top-level req.device_key (6-hex)
  build_profile: string; // req.build_profile
  device_name: string; // req.payload.device_name
  registry_file: string; // req.payload.registry_file
  yaml_hash?: string; // req.payload.yaml_hash (when present)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
/** Decoded byte length of a (charset-validated) standard-base64 string, or -1. */
function base64ByteLength(s: string): number {
  try {
    return atob(s).length;
  } catch {
    return -1;
  }
}

/**
 * Validate a non-empty compile_secret_envelope JSON string. Returns an error
 * message (HTTP 400 to the caller) or null when valid. Pure; no I/O, no crypto.
 */
export function validateCompileSecretEnvelope(
  raw: string,
  ctx: EnvelopeBindContext,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "payload.compile_secret_envelope is not valid JSON";
  }
  if (!isPlainObject(parsed)) {
    return "payload.compile_secret_envelope must be a JSON object";
  }
  const e = parsed;

  // ── top-level shape ──
  if (e.v !== ENVELOPE_VERSION) {
    return "payload.compile_secret_envelope.v must be 1";
  }
  if (e.alg !== PINNED_ALG) {
    return "payload.compile_secret_envelope.alg is not the supported HPKE suite";
  }
  if (!isNonEmptyString(e.key_id)) {
    return "payload.compile_secret_envelope.key_id missing";
  }
  if (!isNonEmptyString(e.enc) || !BASE64_RE.test(e.enc)) {
    return "payload.compile_secret_envelope.enc must be non-empty base64";
  }
  if (base64ByteLength(e.enc) !== ENC_BYTES) {
    return "payload.compile_secret_envelope.enc has wrong length";
  }
  if (!isNonEmptyString(e.ciphertext) || !BASE64_RE.test(e.ciphertext)) {
    return "payload.compile_secret_envelope.ciphertext must be non-empty base64";
  }
  if (e.ciphertext.length > MAX_CIPHERTEXT_B64_LEN) {
    return "payload.compile_secret_envelope.ciphertext too large";
  }

  // ── aad shape + self-consistency ──
  if (!isPlainObject(e.aad)) {
    return "payload.compile_secret_envelope.aad missing";
  }
  const aad = e.aad;
  for (const f of [
    "envelope_v",
    "alg",
    "key_id",
    "build_profile",
    "registry_file",
    "device_name",
    "device_key",
    "yaml_hash",
    "request_nonce",
  ]) {
    if (!(f in aad)) {
      return `payload.compile_secret_envelope.aad.${f} missing`;
    }
  }
  if (aad.envelope_v !== e.v) {
    return "payload.compile_secret_envelope.aad.envelope_v mismatch";
  }
  if (aad.alg !== e.alg) {
    return "payload.compile_secret_envelope.aad.alg mismatch";
  }
  if (aad.key_id !== e.key_id) {
    return "payload.compile_secret_envelope.aad.key_id mismatch";
  }
  if (typeof aad.yaml_hash !== "string" || !HEX64_RE.test(aad.yaml_hash)) {
    return "payload.compile_secret_envelope.aad.yaml_hash must be 64 hex";
  }
  if (
    !isNonEmptyString(aad.request_nonce) ||
    !BASE64_RE.test(aad.request_nonce) ||
    base64ByteLength(aad.request_nonce) !== REQUEST_NONCE_BYTES
  ) {
    return "payload.compile_secret_envelope.aad.request_nonce invalid";
  }
  for (const f of [
    "build_profile",
    "registry_file",
    "device_name",
    "device_key",
  ]) {
    if (!isNonEmptyString(aad[f])) {
      return `payload.compile_secret_envelope.aad.${f} must be a non-empty string`;
    }
  }

  // ── AAD binding to the /build request context ──
  if (aad.build_profile !== ctx.build_profile) {
    return "payload.compile_secret_envelope.aad.build_profile does not match the request";
  }
  if (aad.registry_file !== ctx.registry_file) {
    return "payload.compile_secret_envelope.aad.registry_file does not match the request";
  }
  if (aad.device_name !== ctx.device_name) {
    return "payload.compile_secret_envelope.aad.device_name does not match the request";
  }
  if (
    (aad.device_key as string).toLowerCase() !== ctx.device_key.toLowerCase()
  ) {
    return "payload.compile_secret_envelope.aad.device_key does not match the request";
  }
  // Bind yaml_hash when the request carries one (yaml_authority path).
  if (
    isNonEmptyString(ctx.yaml_hash) &&
    aad.yaml_hash !== ctx.yaml_hash
  ) {
    return "payload.compile_secret_envelope.aad.yaml_hash does not match the request";
  }

  return null;
}
