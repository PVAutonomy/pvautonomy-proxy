import type { BuildRequest } from "../types.js";

const DEVICE_KEY_RE = /^[a-f0-9]{6}$/i;
const DEVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,50}$/;
const SUPPORTED_MODELS = ["edge101"];
const SUPPORTED_PROFILES = ["production", "factory"];

// EPIC-006-B7: explicit whitelist of payload keys. Unknown keys are rejected
// so future fields cannot be silently dropped by an older proxy build.
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
]);

// EPIC-006-B7: build_contract whitelist. Empty string means the legacy
// registry-regeneration path; "yaml_authority" means HA-supplied YAML.
const VALID_BUILD_CONTRACTS: ReadonlySet<string> = new Set([
  "",
  "yaml_authority",
]);

const BUILD_CONTRACT_YAML_AUTHORITY = "yaml_authority";
const YAML_HASH_RE = /^[a-f0-9]{64}$/i;

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
  const stringFields: ReadonlyArray<string> = [
    "version",
    "encrypted_secrets",
    "build_contract",
    "yaml_content",
    "yaml_hash",
    "compile_secret_envelope",
    "ota_required",
  ];
  for (const field of stringFields) {
    if (p[field] !== undefined && typeof p[field] !== "string") {
      return `payload.${field} must be a string when present`;
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
