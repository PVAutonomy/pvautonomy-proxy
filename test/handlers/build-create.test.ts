import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub dispatch before importing handler
vi.mock("../../src/github/dispatch.js", () => ({
  triggerWorkflowDispatch: vi.fn(async () => ({
    run_id: 12345,
    run_url: "https://github.com/PVAutonomy/inverter-registry/actions/runs/12345",
  })),
}));

import { handleBuildCreate } from "../../src/handlers/build-create.js";
import type { ApiKeyRecord, Env } from "../../src/types.js";

function createMockEnv(store: Map<string, string> = new Map()): Env {
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
    GITHUB_PAT: "ghp_test",
    GITHUB_OWNER: "PVAutonomy",
    GITHUB_REPO: "inverter-registry",
    GITHUB_WORKFLOW_FILE: "build-firmware-on-demand.yml",
    MAX_BUILDS_PER_DAY: "10",
    MAX_PAYLOAD_BYTES: "65536",
    BUILD_TIMEOUT_MS: "900000",
  };
}

const validBody = JSON.stringify({
  customer_id: "cust-001",
  device_key: "17e9c4",
  model: "edge101",
  build_profile: "production",
  payload: {
    registry_file: "inverters/growatt/sph/sph10k.json",
    device_name: "sph10k-haus-03",
  },
});

const customer: ApiKeyRecord = {
  customer_id: "cust-001",
  label: "test",
  created_at: "2026-01-01T00:00:00Z",
  active: true,
  rate_limit_override: null,
};

describe("handleBuildCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates build and returns 201 with build_id", async () => {
    const env = createMockEnv();
    const request = new Request("https://proxy.test/build", {
      method: "POST",
      body: validBody,
      headers: { "Content-Type": "application/json" },
    });

    const response = await handleBuildCreate(request, env, customer);
    expect(response.status).toBe(201);

    const data = (await response.json()) as Record<string, unknown>;
    expect(data.build_id).toBeDefined();
    expect(data.status).toBe("dispatched");
    expect(data.run_url).toContain("github.com");
  });

  it("rejects payload exceeding size limit", async () => {
    const env = createMockEnv();
    (env as Record<string, unknown>).MAX_PAYLOAD_BYTES = "10";

    const request = new Request("https://proxy.test/build", {
      method: "POST",
      body: validBody,
    });

    const response = await handleBuildCreate(request, env, customer);
    expect(response.status).toBe(413);
  });

  it("rejects invalid JSON", async () => {
    const env = createMockEnv();
    const request = new Request("https://proxy.test/build", {
      method: "POST",
      body: "not json",
    });

    const response = await handleBuildCreate(request, env, customer);
    expect(response.status).toBe(400);
  });

  it("rejects mismatched customer_id", async () => {
    const env = createMockEnv();
    const body = JSON.stringify({
      ...JSON.parse(validBody),
      customer_id: "wrong-customer",
    });
    const request = new Request("https://proxy.test/build", {
      method: "POST",
      body,
    });

    const response = await handleBuildCreate(request, env, customer);
    expect(response.status).toBe(403);
  });

  it("rejects when rate limit exceeded", async () => {
    const today = new Date().toISOString().split("T")[0];
    const store = new Map([[`customer:cust-001:daily:${today}`, "10"]]);
    const env = createMockEnv(store);

    const request = new Request("https://proxy.test/build", {
      method: "POST",
      body: validBody,
    });

    const response = await handleBuildCreate(request, env, customer);
    expect(response.status).toBe(429);
  });

  it("rejects when concurrent build active", async () => {
    const store = new Map([["customer:cust-001:active", "existing-build"]]);
    const env = createMockEnv(store);

    const request = new Request("https://proxy.test/build", {
      method: "POST",
      body: validBody,
    });

    const response = await handleBuildCreate(request, env, customer);
    expect(response.status).toBe(409);
  });
});
