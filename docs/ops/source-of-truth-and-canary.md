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

## References

- PVAutonomy/pvautonomy-config#141 — source-of-truth split-brain & isolated Canary
- PVAutonomy/pvautonomy-config#142 — envelope shape/AAD validation (split out)
- PVAutonomy/pvautonomy-config#139 — HPKE-1 (blocked on Canary isolation)
- PR #19 / commit `a43f1cf` — BuildRecord persistence sanitizer (#141b)
