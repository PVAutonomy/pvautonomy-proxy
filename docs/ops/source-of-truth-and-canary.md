# Proxy source of truth & Canary guardrails

Tracking: PVAutonomy/pvautonomy-config#141. Related: #139, #142.

## Source of truth

**`PVAutonomy/pvautonomy-proxy` (this repo) is the sole source of truth for the
proxy code.** Production runs from this repo (`GET /health` → `version` /
`git_sha`).

The old private monorepo proxy copy at
`gshubi/home-assistant-config/pvautonomy-proxy/` (version `0.4.x`) **must not be
used for new deploys.** It is frozen as a deploy source (its `deploy:canary` /
`deploy:production` scripts hard-fail). Any still-relevant behavior from that
copy is ported here via PR or explicitly documented as out of scope; see the
#141a parity audit on #141.

## The existing Canary is NOT isolated (do not rely on it yet)

A Cloudflare Worker `pvautonomy-proxy-canary` exists
(`https://pvautonomy-proxy-canary.pvautonomy-proxy.workers.dev`), but as of
#141 it is **not** a safe non-production sandbox:

- it may be sourced from the old private monorepo proxy copy (it reported
  `version 0.4.2`), not this repo;
- it shares the **production `API_KEYS`** KV namespace;
- it shares the **production `BUILD_STATE`** KV namespace;
- it can use **real GitHub App credentials**;
- it can **dispatch real `inverter-registry` builds**;
- it accepts **real customer `pva_` keys**.

**No HPKE live validation (#139) may use this Canary until isolation is in place
(#141d/#141e).**

## Required path before any future proxy deploy / HPKE live validation

1. deploy only from this repo (`PVAutonomy/pvautonomy-proxy`);
2. add an isolated `[env.canary]` (#141d);
3. use **separate** canary KV namespaces (distinct IDs from production);
4. provision a **dedicated non-production** Build-Key (no real customer keys);
5. deploy canary via an explicit workflow/command (no accidental production
   deploy);
6. verify `GET /health` `git_sha` matches the deployed commit;
7. only then resume #139 HPKE live validation.

**Production deploy remains manual/explicit only** (see the README "Deployment"
section and `scripts/deploy.sh`).

## #141d — repo-side canary guardrails (this change)

Implemented in this repo (no deploy, no Cloudflare resources created):

- **`.github/workflows/deploy-canary.yml`** — a `workflow_dispatch`-only Canary
  deploy, deliberately separate from `deploy.yml` so a canary deploy can never
  trigger or be confused with production. It runs `wrangler deploy --env canary`
  and a pre-deploy safety check.
- **`scripts/check-canary-config.mjs`** — fails closed if any `[env.canary*]`
  table reuses a production KV namespace id, if the canary worker name is wrong,
  or if the top-level production worker name was changed. Runs in CI / the
  canary workflow; contacts nothing.
- **`wrangler.canary.example.toml`** — the intended isolated `[env.canary]`
  shape (separate KV namespaces, lowered limits, `GITHUB_APP_*` omitted so the
  canary cannot dispatch real builds). **Example only — wrangler never reads
  `*.example.toml`.**

(History: in #141d `[env.canary]` was deliberately deferred because real canary
KV ids did not exist yet and placeholder ids in active config are unsafe.)

## #141e — operational provisioning

**Decision:** the HPKE-validation Canary is a **new clean-slate worker
`pvautonomy-proxy-hpke-canary`**, not a reuse of the old `pvautonomy-proxy-canary`
(which carries inherited real secrets and stale lineage; `wrangler deploy` does
not delete secrets, so a reused worker keeps real build-dispatch credentials).
The old canary is left untouched and retired later.

Status:

- **#141e-2 (done):** isolated canary KV namespaces created — `API_KEYS`
  `198c1f7255e84f8298c128807d56102e`, `BUILD_STATE`
  `d928e34e235f441a989a7658d76b1191` (both distinct from production).
- **#141e-3 (this change):** active `[env.canary]` added to `wrangler.toml` for
  `pvautonomy-proxy-hpke-canary` using those KV ids, `GITHUB_APP_*` omitted; the
  safety check (`scripts/check-canary-config.mjs`) and tests/template/docs are
  updated to the new worker name. **No deploy.**

Still required (operator, separate GOs):

1. **#141e-4:** seed a **dedicated non-production** `pva_` Build-Key into the
   canary `API_KEYS` namespace **only** — never a real customer key; no
   `GITHUB_APP_*` / `COMPILE_SECRET_KEY` secrets on this worker.
2. **#141e-5:** run **Deploy worker (canary)** (`workflow_dispatch`); verify
   `GET /health` `git_sha` matches the deployed commit; check the auth gate
   (unauth → 401, invalid → 403, valid + no keyset → 404).
3. **#141e-6 (for #139):** set the signed **TEST** `HPKE_TEST_KEYSET` as a
   canary-only secret; validate the keyset response.

No production or customer keys are ever copied into the canary.

### #139 validation sequence (after #141e)

1. canary `/health` `git_sha` == this repo's deployed commit;
2. authenticated canary Build-Key + no `HPKE_TEST_KEYSET` → `404`;
3. set `HPKE_TEST_KEYSET` (canary only) → `200` signed public keyset
   (`no-store`, no private fields);
4. unauthenticated / invalid key → auth rejection, no keyset leak.

### Keyset tier binding (HPKE-3, ADR-0003 D-A)

`GET /build-backend/keys` selects its keyset binding from the explicit
`HPKE_KEYSET_TIER` var — never from hostname or Worker name:

| Tier (`HPKE_KEYSET_TIER`) | Binding served | Required `keyset.environment` |
|---|---|---|
| `"production"` (also the default when unset) | `HPKE_KEYSET` | `"production"` |
| `"test"` | `HPKE_TEST_KEYSET` | `"test"` |

- The canary sets `HPKE_KEYSET_TIER = "test"` and uses **only** `HPKE_TEST_KEYSET`
  (this validation flow, #139/#141/G2). It never serves a production keyset.
- Production sets `HPKE_KEYSET_TIER = "production"` and uses **only** `HPKE_KEYSET`.
  It never serves the canary `HPKE_TEST_KEYSET`.
- A selected binding that is unset/empty → `404` (legacy fallback preserved). A
  present binding that is malformed, carries private material, or whose
  `environment` does not match the tier → generic `500` (fail closed, no config
  echoed). An unrecognised tier value → `500`.
- **G5** sets `HPKE_KEYSET` in production only, after the G3 ceremony and G4
  keyring injection. This repo change is code + config only — no secret is set
  and nothing is deployed here.

## References

- PVAutonomy/pvautonomy-config#141 — source-of-truth split-brain & isolated Canary
- PVAutonomy/pvautonomy-config#142 — envelope shape/AAD validation (split out)
- PVAutonomy/pvautonomy-config#139 — HPKE-1 (blocked on Canary isolation)
- PR #19 / commit `a43f1cf` — BuildRecord persistence sanitizer (#141b)
