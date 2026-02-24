import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub modules
vi.mock("../../src/github/poll.js", () => ({
  pollGitHubRun: vi.fn(async () => ({
    status: "running" as const,
    progress: 50,
    run_url: "https://github.com/PVAutonomy/inverter-registry/actions/runs/12345",
  })),
}));

vi.mock("../../src/github/artifacts.js", () => ({
  resolveArtifacts: vi.fn(async () => null),
}));

import { handleBuildStatus } from "../../src/handlers/build-status.js";
import type { BuildRecord, Env } from "../../src/types.js";

function createMockEnv(store: Map<string, string> = new Map()): Env {
  return {
    BUILD_STATE: {
      get: vi.fn(async (key: string, format?: string) => {
        const val = store.get(key);
        if (!val) return null;
        return format === "json" ? JSON.parse(val) : val;
      }),
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

const baseBuild: BuildRecord = {
  build_id: "test-uuid-1234",
  customer_id: "cust-001",
  device_key: "17e9c4",
  model: "edge101",
  build_profile: "production",
  status: "dispatched",
  github_run_id: 12345,
  github_run_url: "https://github.com/PVAutonomy/inverter-registry/actions/runs/12345",
  progress: 5,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: null,
  artifact: null,
  error: null,
  payload_hash: "abc123",
  payload: { registry_file: "inverters/growatt/sph/sph10k.json", device_name: "sph10k-haus-03" },
};

describe("handleBuildStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for unknown build_id", async () => {
    const env = createMockEnv();
    const response = await handleBuildStatus(env, "nonexistent-id");
    expect(response.status).toBe(404);
  });

  it("returns cached terminal state without polling GitHub", async () => {
    const completedBuild: BuildRecord = {
      ...baseBuild,
      status: "success",
      progress: 100,
      completed_at: new Date().toISOString(),
      artifact: {
        manifest_url: "https://example.com/manifest.json",
        firmware_url: "https://example.com/firmware.ota.bin",
        sha256: "deadbeef",
        size_bytes: 500000,
      },
    };
    const store = new Map([
      [`build:${completedBuild.build_id}`, JSON.stringify(completedBuild)],
    ]);
    const env = createMockEnv(store);

    const response = await handleBuildStatus(env, completedBuild.build_id);
    expect(response.status).toBe(200);

    const data = (await response.json()) as Record<string, unknown>;
    expect(data.status).toBe("success");
    expect(data.artifact).toBeTruthy();

    // Should NOT have polled GitHub
    const { pollGitHubRun } = await import("../../src/github/poll.js");
    expect(pollGitHubRun).not.toHaveBeenCalled();
  });

  it("polls GitHub for non-terminal build", async () => {
    const store = new Map([
      [`build:${baseBuild.build_id}`, JSON.stringify(baseBuild)],
    ]);
    const env = createMockEnv(store);

    const response = await handleBuildStatus(env, baseBuild.build_id);
    expect(response.status).toBe(200);

    const data = (await response.json()) as Record<string, unknown>;
    expect(data.status).toBe("running");
    expect(data.progress).toBe(50);

    const { pollGitHubRun } = await import("../../src/github/poll.js");
    expect(pollGitHubRun).toHaveBeenCalledWith(env, 12345);
  });

  it("detects timeout for old builds", async () => {
    const oldBuild: BuildRecord = {
      ...baseBuild,
      created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
    };
    const store = new Map([
      [`build:${oldBuild.build_id}`, JSON.stringify(oldBuild)],
    ]);
    const env = createMockEnv(store);

    const response = await handleBuildStatus(env, oldBuild.build_id);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.status).toBe("timeout");
  });
});
