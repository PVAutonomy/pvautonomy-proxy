import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { handleBuildArtifact } from "../../src/handlers/build-artifact.js";
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
    GITHUB_PAT: "ghp_test_secret",
    GITHUB_OWNER: "PVAutonomy",
    GITHUB_REPO: "inverter-registry",
    GITHUB_WORKFLOW_FILE: "build-firmware-on-demand.yml",
    MAX_BUILDS_PER_DAY: "10",
    MAX_PAYLOAD_BYTES: "65536",
    BUILD_TIMEOUT_MS: "900000",
  };
}

const successBuild: BuildRecord = {
  build_id: "550e8400-e29b-41d4-a716-446655440000",
  customer_id: "cust-001",
  device_key: "17e9c4",
  model: "edge101",
  build_profile: "production",
  status: "success",
  github_run_id: 12345,
  github_run_url:
    "https://github.com/PVAutonomy/inverter-registry/actions/runs/12345",
  progress: 100,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  artifact: {
    manifest_url:
      "https://github.com/PVAutonomy/inverter-registry/releases/download/sph10k-haus-03-v1/manifest.json",
    firmware_url:
      "https://github.com/PVAutonomy/inverter-registry/releases/download/sph10k-haus-03-v1/firmware.ota.bin",
    sha256: "deadbeef",
    size_bytes: 512000,
  },
  error: null,
  payload_hash: "abc123",
  payload: {
    registry_file: "inverters/growatt/sph/sph10k.json",
    device_name: "sph10k-haus-03",
  },
};

const RELEASES_BODY = [
  {
    tag_name: "sph10k-haus-03-v1",
    published_at: "2026-05-22T10:00:00Z",
    assets: [
      {
        name: "manifest.json",
        url: "https://api.github.com/repos/PVAutonomy/inverter-registry/releases/assets/111",
        browser_download_url:
          "https://github.com/PVAutonomy/inverter-registry/releases/download/sph10k-haus-03-v1/manifest.json",
        size: 1024,
      },
      {
        name: "firmware.ota.bin",
        url: "https://api.github.com/repos/PVAutonomy/inverter-registry/releases/assets/222",
        browser_download_url:
          "https://github.com/PVAutonomy/inverter-registry/releases/download/sph10k-haus-03-v1/firmware.ota.bin",
        size: 512000,
      },
    ],
  },
];

describe("handleBuildArtifact", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 404 for unknown build_id", async () => {
    const env = createMockEnv();
    const response = await handleBuildArtifact(
      env,
      "nonexistent-id",
      "firmware.ota.bin",
    );
    expect(response.status).toBe(404);
  });

  it("returns 409 when build is not yet successful", async () => {
    const pending: BuildRecord = { ...successBuild, status: "running" };
    const store = new Map([
      [`build:${pending.build_id}`, JSON.stringify(pending)],
    ]);
    const env = createMockEnv(store);

    const response = await handleBuildArtifact(
      env,
      pending.build_id,
      "firmware.ota.bin",
    );
    expect(response.status).toBe(409);
  });

  it("returns 404 when the build record has no artifact", async () => {
    const noArtifact: BuildRecord = { ...successBuild, artifact: null };
    const store = new Map([
      [`build:${noArtifact.build_id}`, JSON.stringify(noArtifact)],
    ]);
    const env = createMockEnv(store);

    const response = await handleBuildArtifact(
      env,
      noArtifact.build_id,
      "firmware.ota.bin",
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for a disallowed artifact name", async () => {
    const store = new Map([
      [`build:${successBuild.build_id}`, JSON.stringify(successBuild)],
    ]);
    const env = createMockEnv(store);

    const response = await handleBuildArtifact(
      env,
      successBuild.build_id,
      "secrets.env",
    );
    expect(response.status).toBe(404);
  });

  it("streams firmware.ota.bin from the private release via GITHUB_PAT", async () => {
    const store = new Map([
      [`build:${successBuild.build_id}`, JSON.stringify(successBuild)],
    ]);
    const env = createMockEnv(store);

    const firmwareBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      // Every GitHub call must carry the PAT — never anonymous.
      expect(auth).toBe("Bearer ghp_test_secret");

      if (url.includes("/releases?")) {
        return new Response(JSON.stringify(RELEASES_BODY), { status: 200 });
      }
      if (url.endsWith("/releases/assets/222")) {
        return new Response(firmwareBytes, {
          status: 200,
          headers: { "Content-Length": String(firmwareBytes.length) },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await handleBuildArtifact(
      env,
      successBuild.build_id,
      "firmware.ota.bin",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Length")).toBe("4");

    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual([0x01, 0x02, 0x03, 0x04]);

    // Asset must be pulled via the API url, not browser_download_url.
    const fetchedUrls = fetchMock.mock.calls.map((c) => c[0]);
    expect(
      fetchedUrls.some((u) => u.endsWith("/releases/assets/222")),
    ).toBe(true);
    expect(
      fetchedUrls.some((u) => u.includes("/releases/download/")),
    ).toBe(false);
  });

  it("streams manifest.json with a JSON content-type", async () => {
    const store = new Map([
      [`build:${successBuild.build_id}`, JSON.stringify(successBuild)],
    ]);
    const env = createMockEnv(store);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/releases?")) {
        return new Response(JSON.stringify(RELEASES_BODY), { status: 200 });
      }
      if (url.endsWith("/releases/assets/111")) {
        return new Response(JSON.stringify({ name: "sph10k-haus-03" }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await handleBuildArtifact(
      env,
      successBuild.build_id,
      "manifest.json",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns 404 when the release asset cannot be located", async () => {
    const store = new Map([
      [`build:${successBuild.build_id}`, JSON.stringify(successBuild)],
    ]);
    const env = createMockEnv(store);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/releases?")) {
        // No matching release for the device.
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await handleBuildArtifact(
      env,
      successBuild.build_id,
      "firmware.ota.bin",
    );
    expect(response.status).toBe(404);
  });
});
