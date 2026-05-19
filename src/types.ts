/** Proxy-level build status (superset of GitHub run states). */
export type BuildStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "success"
  | "failed"
  | "timeout";

/** Persisted in KV under `build:{build_id}`. */
export interface BuildRecord {
  build_id: string;
  customer_id: string;
  device_key: string;
  model: string;
  build_profile: string;
  status: BuildStatus;
  github_run_id: number | null;
  github_run_url: string | null;
  progress: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  artifact: ArtifactInfo | null;
  error: string | null;
  payload_hash: string;
  payload: BuildPayload | null;
}

export interface ArtifactInfo {
  manifest_url: string;
  firmware_url: string;
  sha256: string;
  size_bytes: number;
}

/** POST /build request body. */
export interface BuildRequest {
  customer_id: string;
  device_key: string;
  model: string;
  build_profile: string;
  payload: BuildPayload;
}

export interface BuildPayload {
  registry_file: string;
  device_name: string;
  version?: string;
  encrypted_secrets?: string;
  // EPIC-006-B7: yaml_authority build contract. When build_contract is
  // "yaml_authority", the GHA runner compiles the decoded yaml_content
  // verbatim. The proxy requires both yaml_content and yaml_hash to be
  // present and rejects the request at the edge otherwise.
  build_contract?: string;
  yaml_content?: string;
  yaml_hash?: string;
  // EPIC-006-B7: HPKE compile-secret envelope. Mutually exclusive with
  // encrypted_secrets — both set is rejected at the proxy edge and again
  // at the workflow.
  compile_secret_envelope?: string;
  // EPIC-006-B7: OTA-authentication flag forwarded to the workflow.
  ota_required?: string;
}

/** Persisted in KV under `key:{sha256}`. */
export interface ApiKeyRecord {
  customer_id: string;
  label: string;
  created_at: string;
  active: boolean;
  rate_limit_override: number | null;
}

/** Cloudflare Worker environment bindings. */
export interface Env {
  // KV namespaces
  BUILD_STATE: KVNamespace;
  API_KEYS: KVNamespace;

  // Secrets (set via `wrangler secret put`)
  GITHUB_PAT: string;

  // Vars (set in wrangler.toml)
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW_FILE: string;
  MAX_BUILDS_PER_DAY: string;
  MAX_PAYLOAD_BYTES: string;
  BUILD_TIMEOUT_MS: string;
}

/** Public response shape for GET /build/:id. */
export interface BuildResponse {
  build_id: string;
  status: BuildStatus;
  progress: number;
  run_url: string | null;
  artifact: ArtifactInfo | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
