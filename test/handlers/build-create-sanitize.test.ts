import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the args passed to dispatch so we can prove it received the
// ORIGINAL (unredacted) payload.
vi.mock("../../src/github/dispatch.js", () => ({
  triggerWorkflowDispatch: vi.fn(async () => ({
    run_id: 999,
    run_url: "https://github.com/PVAutonomy/inverter-registry/actions/runs/999",
  })),
}));

import { handleBuildCreate } from "../../src/handlers/build-create.js";
import { triggerWorkflowDispatch } from "../../src/github/dispatch.js";
import { REDACTED } from "../../src/secrets/sanitize.js";
import { _seedTokenCacheForTests } from "../../src/github/auth.js";
import type { ApiKeyRecord, Env } from "../../src/types.js";

// Low-entropy synthetic markers (gitleaks-safe).
const ENC_MARKER = "SYNTHETIC-ENCRYPTED-SECRETS-NOT-REAL";
const ENV_MARKER = '{"v":1,"marker":"SYNTHETIC-ENVELOPE-NOT-REAL"}';

function createMockEnv(store: Map<string, string>): Env {
  _seedTokenCacheForTests("ghp_test");
  return {
    BUILD_STATE: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    } as unknown as KVNamespace,
    API_KEYS: {} as KVNamespace,
    GITHUB_APP_ID: "2940147",
    GITHUB_APP_INSTALLATION_ID: "112192181",
    GITHUB_APP_PRIVATE_KEY: "test-key-pem",
    GITHUB_OWNER: "PVAutonomy",
    GITHUB_REPO: "inverter-registry",
    GITHUB_WORKFLOW_FILE: "build-firmware-on-demand.yml",
    MAX_BUILDS_PER_DAY: "10",
    MAX_PAYLOAD_BYTES: "65536",
    BUILD_TIMEOUT_MS: "900000",
  };
}

const customer: ApiKeyRecord = {
  customer_id: "cust-001",
  label: "test",
  created_at: "2026-01-01T00:00:00Z",
  active: true,
  rate_limit_override: null,
};

function makeReq(payloadExtra: Record<string, unknown>): Request {
  return new Request("https://proxy.test/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_id: "cust-001",
      device_key: "17e9c4",
      model: "edge101",
      build_profile: "production",
      payload: {
        registry_file: "inverters/growatt/sph/sph10k.json",
        device_name: "sph10k-haus-03",
        ...payloadExtra,
      },
    }),
  });
}

function persistedBuildRecord(store: Map<string, string>): Record<string, any> {
  const key = [...store.keys()].find((k) => k.startsWith("build:"));
  expect(key).toBeDefined();
  return JSON.parse(store.get(key as string) as string);
}

function noStoreValueContains(store: Map<string, string>, marker: string): boolean {
  return ![...store.values()].some((v) => v.includes(marker));
}

describe("build-create persistence sanitizer (#141 / #141b)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatch receives the original encrypted_secrets; persisted KV record is redacted", async () => {
    const store = new Map<string, string>();
    const env = createMockEnv(store);

    const res = await handleBuildCreate(
      makeReq({ encrypted_secrets: ENC_MARKER, secret_context_hash: "a".repeat(64) }),
      env,
      customer,
    );
    expect(res.status).toBe(201);

    // dispatch got the ORIGINAL payload (4th arg)
    const calls = vi.mocked(triggerWorkflowDispatch).mock.calls;
    expect(calls.length).toBe(1);
    const dispatchedPayload = calls[0][3] as Record<string, unknown>;
    expect(dispatchedPayload.encrypted_secrets).toBe(ENC_MARKER);

    // persisted record is redacted; marker absent from ALL KV values
    const persisted = persistedBuildRecord(store);
    expect(persisted.payload.encrypted_secrets).toBe(REDACTED);
    expect(noStoreValueContains(store, ENC_MARKER)).toBe(true);

    // non-secret metadata preserved
    expect(persisted.payload.registry_file).toBe("inverters/growatt/sph/sph10k.json");
    expect(persisted.payload.device_name).toBe("sph10k-haus-03");
    expect(persisted.payload.secret_context_hash).toBe("a".repeat(64));
    expect(persisted.customer_id).toBe("cust-001");
  });

  it("dispatch receives the original compile_secret_envelope; persisted KV record is redacted", async () => {
    const store = new Map<string, string>();
    const env = createMockEnv(store);

    const res = await handleBuildCreate(
      makeReq({ compile_secret_envelope: ENV_MARKER }),
      env,
      customer,
    );
    expect(res.status).toBe(201);

    const calls = vi.mocked(triggerWorkflowDispatch).mock.calls;
    const dispatchedPayload = calls[0][3] as Record<string, unknown>;
    expect(dispatchedPayload.compile_secret_envelope).toBe(ENV_MARKER);

    const persisted = persistedBuildRecord(store);
    expect(persisted.payload.compile_secret_envelope).toBe(REDACTED);
    expect(noStoreValueContains(store, "SYNTHETIC-ENVELOPE-NOT-REAL")).toBe(true);
  });

  it("GET-style response does not expose payload and build still succeeds", async () => {
    const store = new Map<string, string>();
    const env = createMockEnv(store);
    const res = await handleBuildCreate(
      makeReq({ encrypted_secrets: ENC_MARKER }),
      env,
      customer,
    );
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).not.toHaveProperty("payload");
    expect(data.build_id).toBeDefined();
    expect(data.status).toBe("dispatched");
  });
});
