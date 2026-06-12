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

// ISSUE-6 follow-up: mock the lock module so deferral tests can assert
// whether the customer build lock is held or released.
vi.mock("../../src/guards/concurrency.js", () => ({
  releaseBuildLock: vi.fn(async () => {}),
}));

import { handleBuildStatus } from "../../src/handlers/build-status.js";
import { resolveArtifacts } from "../../src/github/artifacts.js";
import { pollGitHubRun } from "../../src/github/poll.js";
import { releaseBuildLock } from "../../src/guards/concurrency.js";
import type { ArtifactInfo, BuildRecord, Env } from "../../src/types.js";
import { _seedTokenCacheForTests } from "../../src/github/auth.js";

function createMockEnv(store: Map<string, string> = new Map()): Env {
  // GHAPP-2: handler suites mock their own GitHub calls; pre-seed the
  // token cache so no mint round-trip interferes with those mocks.
  _seedTokenCacheForTests("ghp_test");
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

// ISSUE-6: self-healing records + ?refresh=1
describe("handleBuildStatus — ISSUE-6", () => {
  const ARTIFACT: ArtifactInfo = {
    manifest_url: "https://example.com/manifest.json",
    firmware_url: "https://example.com/firmware.ota.bin",
    sha256: "deadbeef",
    size_bytes: 500000,
  };

  // Poisoned record: GHA succeeded, but the first artifact resolution
  // transiently failed and null was persisted terminal.
  // Deliberately has NO artifact_resolve_attempts field — proves records
  // persisted before the field existed are handled (read as 0).
  const poisonedBuild: BuildRecord = {
    ...baseBuild,
    status: "success",
    progress: 100,
    completed_at: new Date().toISOString(),
    artifact: null,
  };

  function envWith(record: BuildRecord): {
    env: Env;
    store: Map<string, string>;
  } {
    const store = new Map([
      [`build:${record.build_id}`, JSON.stringify(record)],
    ]);
    return { env: createMockEnv(store), store };
  }

  function storedRecord(store: Map<string, string>, id: string): BuildRecord {
    return JSON.parse(store.get(`build:${id}`)!) as BuildRecord;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) poisoned record is repaired on a later poll
  it("heals a success record with null artifact when resolution succeeds", async () => {
    const { env, store } = envWith(poisonedBuild);
    vi.mocked(resolveArtifacts).mockResolvedValueOnce(ARTIFACT);

    const response = await handleBuildStatus(env, poisonedBuild.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("success");
    expect(data.artifact).toEqual(ARTIFACT);
    // Repair is persisted, with the attempt counted
    const persisted = storedRecord(store, poisonedBuild.build_id);
    expect(persisted.artifact).toEqual(ARTIFACT);
    expect(persisted.artifact_resolve_attempts).toBe(1);
    // Healing re-resolves artifacts only — no GitHub run re-poll
    expect(pollGitHubRun).not.toHaveBeenCalled();
  });

  // (b) attempts are counted on failure and the budget is enforced
  it("increments the attempt counter when heal resolution fails", async () => {
    const { env, store } = envWith(poisonedBuild);
    // default resolveArtifacts mock resolves null (failure)

    const response = await handleBuildStatus(env, poisonedBuild.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.artifact).toBeNull();
    const persisted = storedRecord(store, poisonedBuild.build_id);
    expect(persisted.artifact).toBeNull();
    expect(persisted.artifact_resolve_attempts).toBe(1);
    expect(resolveArtifacts).toHaveBeenCalledTimes(1);
  });

  it("stops healing once the attempt budget is exhausted", async () => {
    const exhausted: BuildRecord = {
      ...poisonedBuild,
      artifact_resolve_attempts: 5,
    };
    const { env } = envWith(exhausted);

    const response = await handleBuildStatus(env, exhausted.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.artifact).toBeNull();
    expect(resolveArtifacts).not.toHaveBeenCalled();
    expect(env.BUILD_STATE.put).not.toHaveBeenCalled();
  });

  // Amendment 2: heal is success-only
  it("never heals failed or timeout records (zero resolve calls)", async () => {
    for (const status of ["failed", "timeout"] as const) {
      vi.clearAllMocks();
      const terminal: BuildRecord = {
        ...poisonedBuild,
        status,
        error: `Build ${status}`,
      };
      const { env } = envWith(terminal);

      const response = await handleBuildStatus(env, terminal.build_id);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.status).toBe(status);
      expect(resolveArtifacts).not.toHaveBeenCalled();
      expect(pollGitHubRun).not.toHaveBeenCalled();
      expect(env.BUILD_STATE.put).not.toHaveBeenCalled();
    }
  });

  // (c) ?refresh=1 re-polls GitHub and re-resolves — even past the budget
  it("refresh re-polls GitHub and re-resolves, ignoring the heal budget", async () => {
    const exhausted: BuildRecord = {
      ...poisonedBuild,
      artifact_resolve_attempts: 5,
    };
    const { env, store } = envWith(exhausted);
    vi.mocked(pollGitHubRun).mockResolvedValueOnce({
      status: "success",
      progress: 100,
      run_url: exhausted.github_run_url!,
    });
    vi.mocked(resolveArtifacts).mockResolvedValueOnce(ARTIFACT);

    const response = await handleBuildStatus(env, exhausted.build_id, {
      refresh: true,
    });
    const data = (await response.json()) as Record<string, unknown>;

    expect(pollGitHubRun).toHaveBeenCalledWith(env, exhausted.github_run_id);
    expect(resolveArtifacts).toHaveBeenCalledTimes(1);
    expect(data.artifact).toEqual(ARTIFACT);
    const persisted = storedRecord(store, exhausted.build_id);
    expect(persisted.artifact).toEqual(ARTIFACT);
    // Amendment 1: refresh neither checks nor increments the counter
    expect(persisted.artifact_resolve_attempts).toBe(5);
  });

  it("refresh keeps a healthy artifact when re-resolution fails", async () => {
    const healthy: BuildRecord = {
      ...poisonedBuild,
      artifact: ARTIFACT,
    };
    const { env, store } = envWith(healthy);
    vi.mocked(pollGitHubRun).mockResolvedValueOnce({
      status: "success",
      progress: 100,
      run_url: healthy.github_run_url!,
    });
    // default resolveArtifacts mock resolves null (failure)

    const response = await handleBuildStatus(env, healthy.build_id, {
      refresh: true,
    });
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.artifact).toEqual(ARTIFACT);
    expect(storedRecord(store, healthy.build_id).artifact).toEqual(ARTIFACT);
  });

  it("refresh adopts a live state reported by GitHub after a re-run", async () => {
    const failed: BuildRecord = {
      ...poisonedBuild,
      status: "failed",
      error: "Build failed",
    };
    const { env, store } = envWith(failed);
    vi.mocked(pollGitHubRun).mockResolvedValueOnce({
      status: "running",
      progress: 50,
      run_url: failed.github_run_url!,
    });

    const response = await handleBuildStatus(env, failed.build_id, {
      refresh: true,
    });
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("running");
    expect(data.error).toBeNull();
    const persisted = storedRecord(store, failed.build_id);
    expect(persisted.completed_at).toBeNull();
    expect(resolveArtifacts).not.toHaveBeenCalled();
  });

  // (d) healthy terminal record: pure cache hit, zero GitHub traffic
  it("returns a healthy terminal record from cache with zero GitHub calls", async () => {
    const healthy: BuildRecord = {
      ...poisonedBuild,
      artifact: ARTIFACT,
    };
    const { env } = envWith(healthy);
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const response = await handleBuildStatus(env, healthy.build_id);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.artifact).toEqual(ARTIFACT);
      expect(pollGitHubRun).not.toHaveBeenCalled();
      expect(resolveArtifacts).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(env.BUILD_STATE.put).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // (e) response shape is unchanged — internal fields never leak
  it("keeps the response shape; artifact_resolve_attempts never leaks", async () => {
    const { env } = envWith(poisonedBuild);
    vi.mocked(resolveArtifacts).mockResolvedValueOnce(ARTIFACT);

    const response = await handleBuildStatus(env, poisonedBuild.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(data).sort()).toEqual([
      "artifact",
      "build_id",
      "created_at",
      "error",
      "progress",
      "run_url",
      "status",
      "updated_at",
    ]);
  });
});

// ISSUE-6 follow-up: deferred success — "success" is only reported once
// artifact info is resolved (bounded), so callers that stop polling on
// success can no longer lose the race against GitHub release-API lag.
describe("handleBuildStatus — deferred success", () => {
  const ARTIFACT: ArtifactInfo = {
    manifest_url: "https://example.com/manifest.json",
    firmware_url: "https://example.com/firmware.ota.bin",
    sha256: "deadbeef",
    size_bytes: 500000,
  };

  function envWith(record: BuildRecord): {
    env: Env;
    store: Map<string, string>;
  } {
    const store = new Map([
      [`build:${record.build_id}`, JSON.stringify(record)],
    ]);
    return { env: createMockEnv(store), store };
  }

  function storedRecord(store: Map<string, string>, id: string): BuildRecord {
    return JSON.parse(store.get(`build:${id}`)!) as BuildRecord;
  }

  function ghSuccess() {
    vi.mocked(pollGitHubRun).mockResolvedValueOnce({
      status: "success",
      progress: 100,
      run_url: baseBuild.github_run_url!,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) run success + resolve null + attempts 0 → deferral
  it("defers success when the run is green but the artifact is unresolved", async () => {
    const { env, store } = envWith(baseBuild);
    ghSuccess();
    // default resolveArtifacts mock resolves null

    const response = await handleBuildStatus(env, baseBuild.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("running");
    expect(data.progress).toBe(95);
    expect(data.artifact).toBeNull();

    const persisted = storedRecord(store, baseBuild.build_id);
    expect(persisted.status).toBe("running");
    expect(persisted.progress).toBe(95);
    expect(persisted.artifact_resolve_attempts).toBe(1);
    expect(persisted.completed_at).toBeNull();
    expect(releaseBuildLock).not.toHaveBeenCalled();
  });

  // (b) later poll resolves → terminal success, lock released
  it("completes the deferred build once the artifact resolves", async () => {
    const deferred: BuildRecord = {
      ...baseBuild,
      status: "running",
      progress: 95,
      artifact_resolve_attempts: 2,
    };
    const { env, store } = envWith(deferred);
    ghSuccess();
    vi.mocked(resolveArtifacts).mockResolvedValueOnce(ARTIFACT);

    const response = await handleBuildStatus(env, deferred.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("success");
    expect(data.artifact).toEqual(ARTIFACT);

    const persisted = storedRecord(store, deferred.build_id);
    expect(persisted.status).toBe("success");
    expect(persisted.artifact).toEqual(ARTIFACT);
    expect(persisted.completed_at).toBeTruthy();
    expect(releaseBuildLock).toHaveBeenCalledTimes(1);
  });

  // (c) budget exhausted → today's fallback (terminal success, null artifact)
  it("persists terminal success without artifact after the deferral budget", async () => {
    const exhausted: BuildRecord = {
      ...baseBuild,
      status: "running",
      progress: 95,
      artifact_resolve_attempts: 5,
    };
    const { env, store } = envWith(exhausted);
    ghSuccess();
    // resolve stays null

    const response = await handleBuildStatus(env, exhausted.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("success");
    expect(data.artifact).toBeNull();

    const persisted = storedRecord(store, exhausted.build_id);
    expect(persisted.status).toBe("success");
    expect(persisted.artifact).toBeNull();
    expect(persisted.artifact_resolve_attempts).toBe(5);
    expect(persisted.completed_at).toBeTruthy();
    expect(releaseBuildLock).toHaveBeenCalledTimes(1);
  });

  // (d) failure/timeout from GitHub → immediate terminal, deferral untouched
  it("keeps run failures immediately terminal", async () => {
    const { env, store } = envWith(baseBuild);
    vi.mocked(pollGitHubRun).mockResolvedValueOnce({
      status: "failed",
      progress: 100,
      run_url: baseBuild.github_run_url!,
    });

    const response = await handleBuildStatus(env, baseBuild.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("failed");
    expect(resolveArtifacts).not.toHaveBeenCalled();
    const persisted = storedRecord(store, baseBuild.build_id);
    expect(persisted.status).toBe("failed");
    expect(persisted.error).toBe("Build failed");
    expect(releaseBuildLock).toHaveBeenCalledTimes(1);
  });

  // (e) artifact resolves on the first try → immediate terminal success
  it("reports success immediately when the artifact resolves first try", async () => {
    const { env, store } = envWith(baseBuild);
    ghSuccess();
    vi.mocked(resolveArtifacts).mockResolvedValueOnce(ARTIFACT);

    const response = await handleBuildStatus(env, baseBuild.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("success");
    expect(data.artifact).toEqual(ARTIFACT);
    expect(resolveArtifacts).toHaveBeenCalledTimes(1);

    const persisted = storedRecord(store, baseBuild.build_id);
    expect(persisted.status).toBe("success");
    expect(persisted.artifact_resolve_attempts).toBeUndefined();
    expect(releaseBuildLock).toHaveBeenCalledTimes(1);
  });

  // (f) deferred response keeps the 8-key shape; counter never leaks
  it("keeps the response shape while deferring", async () => {
    const { env } = envWith(baseBuild);
    ghSuccess();

    const response = await handleBuildStatus(env, baseBuild.build_id);
    const data = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(data).sort()).toEqual([
      "artifact",
      "build_id",
      "created_at",
      "error",
      "progress",
      "run_url",
      "status",
      "updated_at",
    ]);
  });
});
