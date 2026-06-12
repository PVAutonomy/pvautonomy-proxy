#!/usr/bin/env bash
# ISSUE-7: canonical LOCAL deploy entrypoint — use `npm run deploy`, not
# bare `npx wrangler deploy` (which would ship the "dev" version fallbacks
# and make /health useless for drift detection).
#
# Stamps src/version.generated.ts with the current git SHA + build time,
# runs wrangler deploy, and restores the committed "dev" defaults so the
# working clone stays clean.
#
# Usage:
#   npm run deploy                # real deploy (needs Cloudflare auth)
#   npm run deploy -- --dry-run   # build-only validation, no upload
set -euo pipefail
cd "$(dirname "$0")/.."

restore() { git checkout --quiet -- src/version.generated.ts || true; }
trap restore EXIT

node scripts/gen-version.mjs
npx wrangler deploy "$@"
