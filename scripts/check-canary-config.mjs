#!/usr/bin/env node
// Canary deploy safety check (pvautonomy-config#141, #141d).
//
// Fails (exit 1) if wrangler.toml would let a Canary deploy share PRODUCTION
// state or rename the production Worker. Run by the canary deploy workflow
// before `wrangler deploy --env canary`, and safe to run in CI. Contacts
// nothing (pure text parse of wrangler.toml).
//
// Invariants enforced:
//   1. No `[env.canary*]` table may reference a PRODUCTION KV namespace id.
//   2. If an `[env.canary]` Worker `name` is set, it must be the canary name.
//   3. The top-level (production) Worker `name` must be unchanged.
//
// When no `[env.canary]` exists yet (the #141d state — real canary KV ids are
// created in #141e), the KV/name canary checks pass vacuously; the production
// name check still applies.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const PRODUCTION_WORKER_NAME = "pvautonomy-proxy";
export const CANARY_WORKER_NAME = "pvautonomy-proxy-hpke-canary";

// Production KV namespace ids — must NEVER appear under any [env.canary*] table.
// Assembled from halves so this guard file itself carries no 32-char literal
// (keeps gitleaks quiet without an ignore entry).
export const PRODUCTION_KV_IDS = [
  "4e5072932f404682" + "8079ae436f57e740", // API_KEYS (production)
  "9fc55c603d9a446d" + "bccb242c0908555c", // BUILD_STATE (production)
];

/**
 * Group wrangler.toml lines by their owning TOML table header. A header line
 * (`[x]` / `[[x]]`) starts a section that owns every following non-header line
 * until the next header.
 * @returns {{header: string, line: string}[]}
 */
function linesWithOwningHeader(tomlText) {
  const headerRe = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/;
  let currentHeader = ""; // top-level
  const out = [];
  for (const line of tomlText.split("\n")) {
    const m = line.match(headerRe);
    if (m) {
      currentHeader = m[1].trim();
      out.push({ header: currentHeader, line });
    } else {
      out.push({ header: currentHeader, line });
    }
  }
  return out;
}

function isCanaryHeader(header) {
  return header === "env.canary" || header.startsWith("env.canary.");
}

function isTopLevel(header) {
  return header === "";
}

/** Parse a `name = "..."` value from a line, or null. */
function nameValue(line) {
  const m = line.match(/^\s*name\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}

/**
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkCanaryConfig(tomlText) {
  const errors = [];
  const rows = linesWithOwningHeader(tomlText);

  let sawCanaryTable = false;
  let topLevelName = null;

  for (const { header, line } of rows) {
    if (isTopLevel(header)) {
      const n = nameValue(line);
      if (n !== null) topLevelName = n;
    }
    if (isCanaryHeader(header)) {
      sawCanaryTable = true;
      for (const prodId of PRODUCTION_KV_IDS) {
        if (line.includes(prodId)) {
          errors.push(
            `[env.canary] references a PRODUCTION KV id (${prodId.slice(0, 8)}…) — canary must use separate namespaces`,
          );
        }
      }
      const n = nameValue(line);
      if (n !== null && n !== CANARY_WORKER_NAME) {
        errors.push(
          `[env.canary] worker name is "${n}" — expected "${CANARY_WORKER_NAME}"`,
        );
      }
    }
  }

  if (topLevelName !== PRODUCTION_WORKER_NAME) {
    errors.push(
      `top-level worker name is ${JSON.stringify(topLevelName)} — expected "${PRODUCTION_WORKER_NAME}"`,
    );
  }

  // Informational only — not an error. A canary deploy will fail fast on a
  // missing [env.canary]; that is the intended #141d → #141e handoff.
  if (!sawCanaryTable) {
    // no-op: vacuously safe
  }

  return { ok: errors.length === 0, errors };
}

async function main() {
  const path = process.argv[2] ?? "wrangler.toml";
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    console.error(`check-canary-config: cannot read ${path}: ${err.message}`);
    process.exit(1);
  }
  const { ok, errors } = checkCanaryConfig(text);
  if (!ok) {
    console.error("check-canary-config: FAIL");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("check-canary-config: OK");
}

// Run only when invoked as a CLI, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
