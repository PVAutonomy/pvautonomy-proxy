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
    "encrypted_secrets": "<base64>"
  }
}
```

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
| 400 | Invalid request body |
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
| Payload size | 64 KB | 413 |
| Build timeout | 15 minutes | status: "timeout" |

---

## Integration with pvautonomy_ops

The HA integration's `ProxyRemoteBuildBackend` maps to this API:

| BuildBackend method | Proxy endpoint |
|--------------------|-|
| `start_build()` | `POST /build` |
| `get_status()` | `GET /build/{build_id}` |
| `fetch_artifact()` | Download from `artifact.firmware_url` directly |
| `health_check()` | `GET /health` |
