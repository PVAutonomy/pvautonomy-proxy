import type { BuildRequest } from "../types.js";

const DEVICE_KEY_RE = /^[a-f0-9]{6}$/i;
const DEVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,50}$/;
const SUPPORTED_MODELS = ["edge101"];
const SUPPORTED_PROFILES = ["production", "factory"];

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

  if (!p.registry_file || typeof p.registry_file !== "string") {
    return "payload.registry_file is required";
  }
  if (!p.device_name || typeof p.device_name !== "string" || !DEVICE_NAME_RE.test(p.device_name)) {
    return "payload.device_name must be lowercase alphanumeric with hyphens/underscores (2-51 chars)";
  }

  return null;
}
