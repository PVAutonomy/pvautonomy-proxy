# PVAutonomy Proxy — API Contract (MVP)

**Version:** 0.1.0
**Base URL:** `https://proxy.pvautonomy.com` (or Cloudflare Workers URL)

---

## Authentication

All endpoints except `GET /health` require a Bearer token:

```
Authorization: Bearer pva_<api_key>
```

API keys are provisioned out-of-band and stored SHA-256-hashed in Workers KV.

---

## Endpoints

### `POST /build`

Start a firmware build via GitHub Actions.

**Request:**
```json
{
  "customer_id": "cust-001",
  "device_key": "17e9c4",
  "model": "edge101",
  "build_profile": "production",
  "payload": {
    "registry_file": "inverters/growatt/sph/sph10k.json",
    "device_name": "sph10k-haus-03",
    "version": "2026.02.24",

    "build_contract": "yaml_authority",
    "yaml_content": "<base64 of generated ESPHome YAML>",
    "yaml_hash": "<sha256 hex of decoded yaml_content, 64 chars>",

    "encrypted_secrets": "<base64 of legacy compile secrets>",
    "compile_secret_envelope": "<JSON HPKE envelope; mutually exclusive with encrypted_secrets>",

    "ota_required": "1"
  }
}
```

**Payload fields:**
| Field | Required | Notes |
|-------|----------|-------|
| `registry_file` | yes | Path under `inverters/` in the registry repo. |
| `device_name` | yes | Lowercase alphanumeric, `[a-z0-9][a-z0-9_-]{1,50}`. |
| `version` | no | Firmware version tag. Empty → workflow generates timestamp tag. |
| `build_contract` | no | `""` (legacy registry-regeneration) or `"yaml_authority"`. Defaults to `""`. |
| `yaml_content` | conditional | Base64-encoded ESPHome YAML. **Required** when `build_contract = "yaml_authority"`. |
| `yaml_hash` | conditional | SHA-256 hex (64 chars) of decoded `yaml_content`. **Required** when `build_contract = "yaml_authority"`. Validated at the proxy edge and forwarded to the workflow, which fails closed before compile if the decoded YAML hash does not match (PVAutonomy/inverter-registry#7). |
| `encrypted_secrets` | no | Legacy compile secrets. Mutually exclusive with `compile_secret_envelope`. |
| `compile_secret_envelope` | no | HPKE compile-secret envelope. Mutually exclusive with `encrypted_secrets`. |
| `ota_required` | no | OTA authentication flag forwarded to the workflow. |

Unknown payload fields are **rejected with HTTP 400** — the proxy will not silently drop fields. This is the EPIC-006-B7 strict-validation contract.

**Response (201):**
```json
{
  "build_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "dispatched",
  "run_url": "https://github.com/PVAutonomy/inverter-registry/actions/runs/12345"
}
```

**Errors:**
| Status | Meaning |
|--------|---------|
| 400 | Invalid request body, unknown payload field, malformed `yaml_hash`, missing `yaml_content`/`yaml_hash` when `build_contract = yaml_authority`, both `encrypted_secrets` and `compile_secret_envelope` set, or invalid `build_contract` value |
| 403 | customer_id mismatch or invalid key |
| 409 | Concurrent build already in progress |
| 413 | Payload too large |
| 429 | Daily build limit exceeded |
| 502 | GitHub dispatch failed |

---

### `GET /build/{build_id}`

Poll build status. Non-terminal builds trigger a live GitHub API poll.

**Response (200):**
```json
{
  "build_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",
  "progress": 50,
  "run_url": "https://github.com/...",
  "artifact": null,
  "error": null,
  "created_at": "2026-02-24T10:00:00Z",
  "updated_at": "2026-02-24T10:05:00Z"
}
```

**Status values:** `queued` | `dispatched` | `running` | `success` | `failed` | `timeout`

**On success, artifact is populated:**
```json
{
  "artifact": {
    "manifest_url": "https://github.com/.../manifest.json",
    "firmware_url": "https://github.com/.../firmware.ota.bin",
    "sha256": "abc123...",
    "size_bytes": 512000
  }
}
```

**Terminal records (ISSUE-6):**

- Terminal builds (`success` | `failed` | `timeout`) are normally served from
  the KV cache without any GitHub API traffic.
- **Self-heal:** a cached `success` record with `artifact: null` (artifact
  resolution failed transiently on the poll that first saw the run complete)
  gets artifact resolution re-attempted on read. A successful re-resolve is
  persisted. Read-side heal attempts are bounded to **5 per record** (internal
  counter, not exposed in the response); after that the record is served
  as-is and `?refresh=1` is the escape hatch.
- **`?refresh=1`** (query parameter): forces a GitHub re-poll of the run
  status plus artifact re-resolution for terminal records, then persists and
  returns the updated record. Status changes only to what GitHub reports
  (a re-run may legitimately move a `failed` record back to `running`; its
  stale `error`/`completed_at` are cleared in that case). A healthy
  `artifact` is never overwritten by a failed re-resolution. Refresh ignores
  the self-heal attempt budget. Any value other than `1` is treated as
  absent. On non-terminal records the flag is a no-op (they poll live
  anyway).

---

### `GET /build/{build_id}/artifact/{name}`

Stream a build artifact through the proxy. HA calls this after a successful
build to fetch the firmware for OTA install. The bytes are pulled from the
**private** GitHub Release asset using `GITHUB_PAT` (via the asset API URL with
`Accept: application/octet-stream`) — never from `browser_download_url`
anonymously. Auth is identical to `GET /build/{build_id}`.

**Allowed `{name}` values:** `firmware.ota.bin` | `manifest.json`

**Response (200):** the raw artifact bytes.
- `Content-Type`: `application/octet-stream` (firmware) or `application/json`
  (manifest).
- `Content-Length`: set from the upstream asset when available.
- `Content-Disposition`: `attachment; filename="{name}"`.

**Errors:**
| Status | Meaning |
|--------|---------|
| 401/403 | Missing/invalid API key |
| 404 | Unknown `build_id`, no artifact on the record, disallowed `{name}`, or the release asset could not be located |
| 409 | Build not yet `status: success` |

---

### `GET /health`

Public health check (no auth required).

**Response (200):**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "github_api_ok": true
}
```

---

## Guardrails

| Guard | Limit | Response |
|-------|-------|----------|
| Rate limit | 10 builds/day per customer (configurable) | 429 |
| Concurrency | 1 active build per customer | 409 |
| Payload size | 64 KB (`MAX_PAYLOAD_BYTES`) | 413 |
| Build timeout | 15 minutes | status: "timeout" |

### `yaml_authority` transport sizing

GitHub `workflow_dispatch` allows up to **25 inputs** with a **65,535-char total
payload** across all inputs (per GitHub Actions docs and the 2025-12-04
changelog). The workflow currently declares 10 inputs.

Measured base64 `yaml_content` for current registries (SPH10K worst case at
the `unsafe` tier with all 51 sensors enabled, MIC600 max):

| Inverter | Raw YAML | Base64 `yaml_content` | % of 65,535 total |
|----------|---------:|----------------------:|------------------:|
| SPH10K (unsafe) | 26,515 B | 35,356 chars | 53.9% |
| MIC600 | 6,282 B | 8,376 chars | 12.8% |

Headroom is comfortable today. A future registry with significantly more
sensors (or a second large inverter family) should re-measure before relying
on the `workflow_dispatch.inputs` transport.

---

## Integration with pvautonomy_ops

The HA integration's `ProxyRemoteBuildBackend` maps to this API:

| BuildBackend method | Proxy endpoint |
|--------------------|-|
| `start_build()` | `POST /build` |
| `get_status()` | `GET /build/{build_id}` |
| `fetch_artifact()` | `GET /build/{build_id}/artifact/{name}` (proxy-streamed via PAT) |
| `health_check()` | `GET /health` |
