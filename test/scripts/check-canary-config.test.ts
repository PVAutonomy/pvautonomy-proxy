import { describe, it, expect } from "vitest";
import {
  checkCanaryConfig,
  PRODUCTION_KV_IDS,
  CANARY_WORKER_NAME,
  PRODUCTION_WORKER_NAME,
} from "../../scripts/check-canary-config.mjs";

const PROD_API_KEYS_ID = PRODUCTION_KV_IDS[0];
const PROD_BUILD_STATE_ID = PRODUCTION_KV_IDS[1];

// Current production-only wrangler.toml (the #141d state: no [env.canary] yet).
const PROD_ONLY = `
name = "${PRODUCTION_WORKER_NAME}"
main = "src/index.ts"

[[kv_namespaces]]
binding = "BUILD_STATE"
id = "${PROD_BUILD_STATE_ID}"

[[kv_namespaces]]
binding = "API_KEYS"
id = "${PROD_API_KEYS_ID}"
`;

function withCanary(canaryBlock: string): string {
  return PROD_ONLY + "\n" + canaryBlock;
}

describe("checkCanaryConfig", () => {
  it("passes for production-only config (no [env.canary] yet — #141d state)", () => {
    const r = checkCanaryConfig(PROD_ONLY);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("passes for a well-formed isolated canary env (separate KV ids)", () => {
    const r = checkCanaryConfig(
      withCanary(`
[env.canary]
name = "${CANARY_WORKER_NAME}"

[[env.canary.kv_namespaces]]
binding = "BUILD_STATE"
id = "canarybuildstate0000000000000000"

[[env.canary.kv_namespaces]]
binding = "API_KEYS"
id = "canaryapikeys00000000000000000000"
`),
    );
    expect(r.ok).toBe(true);
  });

  it("fails when canary reuses the production API_KEYS id", () => {
    const r = checkCanaryConfig(
      withCanary(`
[env.canary]
name = "${CANARY_WORKER_NAME}"

[[env.canary.kv_namespaces]]
binding = "API_KEYS"
id = "${PROD_API_KEYS_ID}"
`),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/PRODUCTION KV id/);
  });

  it("fails when canary reuses the production BUILD_STATE id", () => {
    const r = checkCanaryConfig(
      withCanary(`
[env.canary]

[[env.canary.kv_namespaces]]
binding = "BUILD_STATE"
id = "${PROD_BUILD_STATE_ID}"
`),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/PRODUCTION KV id/);
  });

  it("fails when [env.canary] worker name is wrong", () => {
    const r = checkCanaryConfig(
      withCanary(`
[env.canary]
name = "pvautonomy-proxy"
`),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/expected "pvautonomy-proxy-hpke-canary"/);
  });

  it("fails when the top-level production worker name is changed", () => {
    const r = checkCanaryConfig(`
name = "pvautonomy-proxy-canary"
main = "src/index.ts"

[[kv_namespaces]]
binding = "API_KEYS"
id = "${PROD_API_KEYS_ID}"
`);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/top-level worker name/);
  });
});
