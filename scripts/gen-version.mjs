#!/usr/bin/env node
// ISSUE-7: stamp src/version.generated.ts with the current git SHA and the
// build timestamp, so GET /health reports which commit is actually deployed.
//
// This is THE single injection mechanism — called by scripts/deploy.sh
// (local deploys) and .github/workflows/deploy.yml (CI deploys) immediately
// before `wrangler deploy`. built_at is the BUILD time, baked into the
// bundle here; the worker never computes it at request time.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gitSha = execSync("git rev-parse --short HEAD", { cwd: root })
  .toString()
  .trim();
const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const content = `// AUTO-GENERATED at deploy time by scripts/gen-version.mjs (ISSUE-7).
// Do NOT edit or commit real values — scripts/deploy.sh restores the
// committed "dev" defaults after deploying.
export const GIT_SHA = "${gitSha}";
export const BUILT_AT = "${builtAt}";
`;

writeFileSync(join(root, "src", "version.generated.ts"), content);
console.log(`version.generated.ts stamped: ${gitSha} @ ${builtAt}`);
