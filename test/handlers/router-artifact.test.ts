import { describe, it, expect, vi, beforeEach } from "vitest";

// Authenticate every request as a valid customer.
vi.mock("../../src/auth/api-key.js", () => ({
  authenticateRequest: vi.fn(async () => ({
    customer: {
      customer_id: "cust-001",
      label: "test",
      created_at: "2026-05-22T00:00:00Z",
      active: true,
      rate_limit_override: null,
    },
  })),
}));

// Stub the artifact handler so this test only proves routing wiring.
vi.mock("../../src/handlers/build-artifact.js", () => ({
  handleBuildArtifact: vi.fn(
    async () => new Response("ok", { status: 200 }),
  ),
}));

// Stub the status handler to prove ?refresh=1 threading (ISSUE-6).
vi.mock("../../src/handlers/build-status.js", () => ({
  handleBuildStatus: vi.fn(
    async () => new Response("ok", { status: 200 }),
  ),
}));

import { route } from "../../src/router.js";
import { handleBuildArtifact } from "../../src/handlers/build-artifact.js";
import { handleBuildStatus } from "../../src/handlers/build-status.js";
import type { Env } from "../../src/types.js";
import { _seedTokenCacheForTests } from "../../src/github/auth.js";

function createEnv(): Env {
  // GHAPP-2: handler suites mock their own GitHub calls; pre-seed the
  // token cache so no mint round-trip interferes with those mocks.
  _seedTokenCacheForTests("ghp_test");
  return {
    BUILD_STATE: {} as KVNamespace,
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

const BUILD_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("router — GET /build/:id/artifact/:name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes to handleBuildArtifact with id and artifact name", async () => {
    const request = new Request(
      `https://proxy.example/build/${BUILD_ID}/artifact/firmware.ota.bin`,
      { method: "GET", headers: { Authorization: "Bearer pva_test" } },
    );

    const response = await route(request, createEnv());
    expect(response.status).toBe(200);
    expect(handleBuildArtifact).toHaveBeenCalledWith(
      expect.anything(),
      BUILD_ID,
      "firmware.ota.bin",
    );
  });

  it("does not match the artifact route as a plain status request", async () => {
    const request = new Request(
      `https://proxy.example/build/${BUILD_ID}/artifact/firmware.ota.bin`,
      { method: "GET", headers: { Authorization: "Bearer pva_test" } },
    );

    await route(request, createEnv());
    // handleBuildArtifact handled it (asserted above); confirm it was reached.
    expect(handleBuildArtifact).toHaveBeenCalledTimes(1);
  });
});

// ISSUE-6: the router threads ?refresh=1 to the status handler.
describe("router — GET /build/:id ?refresh threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes refresh: true when ?refresh=1 is present", async () => {
    const request = new Request(
      `https://proxy.example/build/${BUILD_ID}?refresh=1`,
      { method: "GET", headers: { Authorization: "Bearer pva_test" } },
    );

    const response = await route(request, createEnv());
    expect(response.status).toBe(200);
    expect(handleBuildStatus).toHaveBeenCalledWith(
      expect.anything(),
      BUILD_ID,
      { refresh: true },
    );
  });

  it("passes refresh: false without the parameter", async () => {
    const request = new Request(`https://proxy.example/build/${BUILD_ID}`, {
      method: "GET",
      headers: { Authorization: "Bearer pva_test" },
    });

    await route(request, createEnv());
    expect(handleBuildStatus).toHaveBeenCalledWith(
      expect.anything(),
      BUILD_ID,
      { refresh: false },
    );
  });

  it("treats refresh values other than 1 as false", async () => {
    const request = new Request(
      `https://proxy.example/build/${BUILD_ID}?refresh=true`,
      { method: "GET", headers: { Authorization: "Bearer pva_test" } },
    );

    await route(request, createEnv());
    expect(handleBuildStatus).toHaveBeenCalledWith(
      expect.anything(),
      BUILD_ID,
      { refresh: false },
    );
  });
});
