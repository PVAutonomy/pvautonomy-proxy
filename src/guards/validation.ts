import type { BuildRequest } from "../types.js";

const DEVICE_KEY_RE = /^[a-f0-9]{6}$/i;
const DEVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,50}$/;
const SUPPORTED_MODELS = ["edge101"];
const SUPPORTED_PROFILES = ["production", "factory"];

// EPIC-006-B7: explicit whitelist of payload keys. Unknown keys are rejected
// so future fields cannot be silently dropped by an older proxy build.
//
// EPIC-006-B7 hotfix: HA's ProxyRemoteBuildBackend.start_build() emits
// payload.device_key alongside the top-level req.device_key for legacy
// shape compatibility (see custom_components/pvautonomy_ops/
// build_backend.py "EPIC-011: Forward device_key (MAC suffix) for GHA
// context"). The proxy never forwards payload.device_key — workflow's
// device_key input is sourced from top-level req.device_key — but we
// accept the field so a strict-validation 400 doesn't reject a
// legitimate HA build. A cross-check enforces equality below.
const ALLOWED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "registry_file",
  "device_name",
  "version",
  "encrypted_secrets",
  "build_contract",
  "yaml_content",
  "yaml_hash",
  "compile_secret_envelope",
  "ota_required",
  "device_key",
  // #97 (ADR-0001 P2-b2): firmware-defs bundle version recorded next to
  // yaml_hash. Accepted + persisted via BuildRecord.payload; not forwarded
  // to the GHA workflow.
  "defs_version",
  // EPIC-006-B7 hotfix #2: HA's ProxyRemoteBuildBackend.start_build()
  // attaches secret_context_hash alongside encrypted_secrets on the
  // legacy non-envelope secret path (build_backend.py line 1733). It is
  // sha256(encrypted_secrets) — a hash, not a secret — used by the proxy
  // BuildRecord cache for secrets-aware cache invalidation. Accept it at
  // the edge with format validation; NEVER forward to the workflow.
  "secret_context_hash",
]);

// EPIC-006-B7: build_contract whitelist. Empty string means the legacy
// registry-regeneration path; "yaml_authority" means HA-supplied YAML.
const VALID_BUILD_CONTRACTS: ReadonlySet<string> = new Set([
  "",
  "yaml_authority",
]);

const BUILD_CONTRACT_YAML_AUTHORITY = "yaml_authority";
const YAML_HASH_RE = /^[a-f0-9]{64}$/i;
// #97 (ADR-0001 P2-b2): firmware-defs bundle version, e.g. "1.0.0". Moderate
// shape check — non-empty, version-ish charset, capped length. Provenance
// metadata only (never forwarded to the workflow).
const DEFS_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;

// EPIC-006-B7 hotfix #3: HA may send ota_required as either a JSON
// boolean (Python True/False from build_backend.py) or a string. The
// proxy normalizes both shapes to a workflow-input string at dispatch
// time. Only the canonical string forms below are accepted; anything
// else is a 400. Case-insensitive on the textual forms.
const OTA_REQUIRED_ALLOWED_STRINGS: ReadonlySet<string> = new Set([
  "",
  "0",
  "1",
  "true",
  "false",
]);

/** Validate POST /build request body. Returns error message or null if valid. */
export function validateBuildRequest(req: unknown): string | null {
  if (!req || typeof req !== "object") {
    return "Request body must be a JSON object";
  }

  const r = req as Record<string, unknown>;

  if (!r.customer_id || typeof r.customer_id !== "string") {
    return "Missing or invalid customer_id";
  }
  if (!r.device_key || typeof r.device_key !== "string" || !DEVICE_KEY_RE.test(r.device_key)) {
    return "device_key must be 6 hex characters (last6 MAC)";
  }
  if (!r.model || typeof r.model !== "string" || !SUPPORTED_MODELS.includes(r.model)) {
    return `Unsupported model (supported: ${SUPPORTED_MODELS.join(", ")})`;
  }
  if (
    !r.build_profile ||
    typeof r.build_profile !== "string" ||
    !SUPPORTED_PROFILES.includes(r.build_profile)
  ) {
    return `build_profile must be one of: ${SUPPORTED_PROFILES.join(", ")}`;
  }
  if (!r.payload || typeof r.payload !== "object") {
    return "Missing payload object";
  }

  const p = r.payload as Record<string, unknown>;

  // EPIC-006-B7: strict key whitelist. Reject before any other payload check
  // so unknown fields surface a clear error instead of being silently dropped
  // downstream.
  for (const key of Object.keys(p)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
      return `payload.${key} is not a known field`;
    }
  }

  if (!p.registry_file || typeof p.registry_file !== "string") {
    return "payload.registry_file is required";
  }
  if (!p.device_name || typeof p.device_name !== "string" || !DEVICE_NAME_RE.test(p.device_name)) {
    return "payload.device_name must be lowercase alphanumeric with hyphens/underscores (2-51 chars)";
  }

  // Optional-field type checks. Wrong type is a 400, not a silent coerce.
  // ota_required is handled separately below — HA may send it as a bool.
  const stringFields: ReadonlyArray<string> = [
    "version",
    "encrypted_secrets",
    "build_contract",
    "yaml_content",
    "yaml_hash",
    "compile_secret_envelope",
    "device_key",
    "secret_context_hash",
    "defs_version",
  ];
  for (const field of stringFields) {
    if (p[field] !== undefined && typeof p[field] !== "string") {
      return `payload.${field} must be a string when present`;
    }
  }

  // EPIC-006-B7 hotfix #3: ota_required — accept boolean (HA-native) or
  // a small canonical string set; reject anything else fail-closed.
  // Normalization to the workflow's "" / "1" wire shape happens in
  // dispatch.ts so this guard stays a pure accept-or-reject.
  if (p.ota_required !== undefined) {
    const v = p.ota_required;
    if (typeof v === "boolean") {
      // ok
    } else if (typeof v === "string") {
      if (!OTA_REQUIRED_ALLOWED_STRINGS.has(v.toLowerCase())) {
        return (
          'payload.ota_required string must be one of: "", "0", "1", "true", "false" ' +
          "(case-insensitive)"
        );
      }
    } else {
      return "payload.ota_required must be a boolean or string when present";
    }
  }

  // EPIC-006-B7 hotfix: payload.device_key, when present, must match the
  // 6-hex DEVICE_KEY_RE and equal the top-level req.device_key. The proxy
  // does not forward this field — it is accepted for legacy/HA-compat
  // shape only. A mismatch is a fail-closed 400; never silently override.
  if (p.device_key !== undefined) {
    const payloadDeviceKey = p.device_key as string;
    if (!DEVICE_KEY_RE.test(payloadDeviceKey)) {
      return "payload.device_key must be 6 hex characters (last6 MAC)";
    }
    if (payloadDeviceKey !== r.device_key) {
      return "payload.device_key must equal top-level device_key when present";
    }
  }

  // build_contract whitelist
  const buildContract = (p.build_contract ?? "") as string;
  if (!VALID_BUILD_CONTRACTS.has(buildContract)) {
    const allowed = [...VALID_BUILD_CONTRACTS]
      .map((v) => (v === "" ? '""' : v))
      .join(", ");
    return `payload.build_contract must be one of: ${allowed}`;
  }

  // yaml_authority contract: require yaml_content + yaml_hash
  if (buildContract === BUILD_CONTRACT_YAML_AUTHORITY) {
    if (typeof p.yaml_content !== "string" || p.yaml_content.length === 0) {
      return "payload.yaml_content is required when build_contract=yaml_authority";
    }
    if (typeof p.yaml_hash !== "string" || p.yaml_hash.length === 0) {
      return "payload.yaml_hash is required when build_contract=yaml_authority";
    }
  }

  // yaml_hash format check (always when present, even on legacy path — a
  // malformed hash is always a caller bug, never something to forward).
  if (
    typeof p.yaml_hash === "string" &&
    p.yaml_hash.length > 0 &&
    !YAML_HASH_RE.test(p.yaml_hash)
  ) {
    return "payload.yaml_hash must be 64 hex characters (sha256)";
  }

  // EPIC-006-B7 hotfix #2: secret_context_hash format check.
  // Same sha256-hex shape as yaml_hash. HA computes it as
  // sha256(encrypted_secrets payload) for cache invalidation; the
  // proxy may persist it in BuildRecord later but never forwards it
  // to the GHA workflow. Malformed → fail-closed 400.
  if (
    typeof p.secret_context_hash === "string" &&
    p.secret_context_hash.length > 0 &&
    !YAML_HASH_RE.test(p.secret_context_hash)
  ) {
    return "payload.secret_context_hash must be 64 hex characters (sha256)";
  }

  // #97 (ADR-0001 P2-b2): defs_version format check. Optional; when present
  // it must be a non-empty, version-ish string (the empty string and odd
  // characters are caller bugs). The stringFields check above already
  // rejects non-string values. Provenance only — not forwarded to the
  // workflow; persisted via BuildRecord.payload.
  if (
    typeof p.defs_version === "string" &&
    !DEFS_VERSION_RE.test(p.defs_version)
  ) {
    return "payload.defs_version must be 1-64 chars: letters, digits, . _ + -";
  }

  // Dual secret path: encrypted_secrets and compile_secret_envelope are
  // mutually exclusive (the workflow re-asserts this same gate).
  const legacySecrets = typeof p.encrypted_secrets === "string" ? p.encrypted_secrets : "";
  const envelopeSecrets =
    typeof p.compile_secret_envelope === "string" ? p.compile_secret_envelope : "";
  if (legacySecrets.length > 0 && envelopeSecrets.length > 0) {
    return "payload.encrypted_secrets and payload.compile_secret_envelope are mutually exclusive";
  }

  return null;
}
