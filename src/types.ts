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
  // ISSUE-6: read-side self-heal budget for success-without-artifact
  // records. Optional + additive: records persisted before this field
  // existed read as undefined (treated as 0). Internal only — never
  // exposed via BuildResponse.
  artifact_resolve_attempts?: number;
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
  // P2-f / ADR-0001 P2-b2 (PVAutonomy/pvautonomy-config#97): firmware-defs
  // bundle version, recorded next to yaml_hash as build provenance. Accepted
  // and persisted via BuildRecord.payload; NOT forwarded to the GHA workflow
  // (the compile does not consume it). Format-validated at the proxy edge.
  defs_version?: string;
  // EPIC-006-B7: HPKE compile-secret envelope. Mutually exclusive with
  // encrypted_secrets — both set is rejected at the proxy edge and again
  // at the workflow.
  compile_secret_envelope?: string;
  // EPIC-006-B7: OTA-authentication flag forwarded to the workflow.
  //
  // EPIC-006-B7 hotfix #3: HA's ProxyRemoteBuildBackend.start_build()
  // emits ota_required as a Python bool (True/False) — wire type
  // `boolean`, not `string`. The GHA workflow_dispatch input is typed
  // `string`. The proxy accepts both shapes here, validates the allowed
  // value space, and normalizes deterministically to "1" (truthy) or ""
  // (falsy) at dispatch time. Never silently coerce a malformed string.
  ota_required?: string | boolean;
  // EPIC-006-B7 hotfix: legacy/HA-compat shape. HA's
  // ProxyRemoteBuildBackend.start_build() echoes the 6-hex MAC suffix
  // into payload.device_key in addition to the top-level
  // BuildRequest.device_key. The proxy validates equality with the
  // top-level value and forwards only the top-level value to the GHA
  // workflow input. Never sent as a separate workflow input.
  device_key?: string;
  // EPIC-006-B7 hotfix #2: sha256(encrypted_secrets) cache/audit
  // metadata that HA attaches on the legacy non-envelope secret path
  // (custom_components/pvautonomy_ops/build_backend.py line 1733).
  // Hash, not secret. Validated as 64 lowercase/uppercase hex chars at
  // the proxy edge and may later be persisted in BuildRecord for cache
  // invalidation; NOT forwarded to the GHA workflow as an input.
  secret_context_hash?: string;
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
  // GHAPP-1: GitHub App private key, PKCS#8 PEM (operator converts the
  // PKCS#1 download via `openssl pkcs8 -topk8 -nocrypt` before secret put).
  // Optional in the type so misconfiguration fails with the clear error in
  // getGithubToken rather than a TypeScript lie at the call sites.
  GITHUB_APP_PRIVATE_KEY?: string;

  // Vars (set in wrangler.toml)
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
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
