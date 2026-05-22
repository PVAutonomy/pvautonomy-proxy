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

import { route } from "../../src/router.js";
import { handleBuildArtifact } from "../../src/handlers/build-artifact.js";
import type { Env } from "../../src/types.js";

function createEnv(): Env {
  return {
    BUILD_STATE: {} as KVNamespace,
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
