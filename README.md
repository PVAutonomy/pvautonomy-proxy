# pvautonomy-proxy
PVAutonomy firmware build proxy — brokers GitHub Actions builds for customer HA instances

> **Source of truth & Canary:** this repo is the sole source of truth for the proxy.
> The old private monorepo copy is frozen as a deploy source, and the existing
> `pvautonomy-proxy-canary` Worker is **not** yet isolated — see
> [docs/ops/source-of-truth-and-canary.md](docs/ops/source-of-truth-and-canary.md)
> (PVAutonomy/pvautonomy-config#141) before any deploy or HPKE live validation.

## Deployment (ISSUE-7)

The deployed worker version is visible at `GET /health` (`git_sha` +
`built_at`, stamped at build time). Deploys MUST go through one of the two
stamped paths below — bare `npx wrangler deploy` would ship the `"dev"`
fallbacks and make drift invisible again.

### Local (canonical operator path)

```bash
npm run deploy                # stamp + deploy (needs Cloudflare auth)
npm run deploy -- --dry-run   # stamp + build only, no upload
```

`scripts/deploy.sh` stamps `src/version.generated.ts` via
`scripts/gen-version.mjs`, runs `wrangler deploy`, and restores the
committed `"dev"` defaults afterwards (the clone stays clean).

### GitHub Actions

`Deploy worker` workflow (`.github/workflows/deploy.yml`) —
**workflow_dispatch only**; deploys stay explicit operator actions, merges
to main never deploy by themselves. It runs tests + typecheck, stamps the
version with the same `scripts/gen-version.mjs`, and deploys via
`cloudflare/wrangler-action`.

Required repo secret (operator-created): `CLOUDFLARE_API_TOKEN` — a
Cloudflare API token with Workers deploy permission for this worker.

### Post-deploy verification

```bash
curl -s https://<worker-host>/health | jq '{version, git_sha, built_at}'
```

`git_sha` must match the deployed commit.
