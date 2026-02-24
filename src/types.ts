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
