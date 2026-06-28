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

`[env.canary]` is **deliberately NOT yet added to `wrangler.toml`**: it requires
real canary KV namespace ids, which do not exist until #141e. Inventing
placeholder ids in active config is unsafe (wrangler would treat them as real),
so the active `wrangler.toml` is unchanged. The canary workflow therefore
**fails until #141e** adds the real `[env.canary]` block — by design.

## #141e — operational prerequisites (NOT done here)

Before the first canary deploy / #139 validation, an operator must:

1. create a **separate** canary `API_KEYS` KV namespace (new id);
2. create a **separate** canary `BUILD_STATE` KV namespace (new id);
3. add `[env.canary]` to `wrangler.toml` with those real ids (use
   `wrangler.canary.example.toml` as the template; the safety check must pass);
4. seed a **dedicated non-production** `pva_` Build-Key into the canary
   `API_KEYS` namespace **only** — never a real customer key;
5. provision **canary-scoped** vars/secrets only (`wrangler … --env canary`);
6. **omit** `GITHUB_APP_*` so the canary cannot dispatch real
   `inverter-registry` builds during #139 keyset validation;
7. (for #139) set the signed **TEST** `HPKE_TEST_KEYSET` as a canary secret only;
8. merge the config PR, then run **Deploy worker (canary)**;
9. verify `GET /health` `git_sha` matches the deployed commit.

### #139 validation sequence (after #141e)

1. canary `/health` `git_sha` == this repo's deployed commit;
2. authenticated canary Build-Key + no `HPKE_TEST_KEYSET` → `404`;
3. set `HPKE_TEST_KEYSET` (canary only) → `200` signed public keyset
   (`no-store`, no private fields);
4. unauthenticated / invalid key → auth rejection, no keyset leak.

## References

- PVAutonomy/pvautonomy-config#141 — source-of-truth split-brain & isolated Canary
- PVAutonomy/pvautonomy-config#142 — envelope shape/AAD validation (split out)
- PVAutonomy/pvautonomy-config#139 — HPKE-1 (blocked on Canary isolation)
- PR #19 / commit `a43f1cf` — BuildRecord persistence sanitizer (#141b)
