import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { triggerWorkflowDispatch } from "../../src/github/dispatch.js";
import type { BuildPayload, Env } from "../../src/types.js";

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

const successResponse = {
  id: 123456,
  html_url:
    "https://github.com/PVAutonomy/inverter-registry/actions/runs/123456",
};

/** Capture what was POSTed to GitHub. */
function mockFetchOnce(status = 200, body: unknown = successResponse) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const parsed = JSON.parse(init.body as string) as {
      ref: string;
      return_run_details: boolean;
      inputs: Record<string, string>;
    };
    (mockFetchOnce as unknown as { lastInputs?: Record<string, string> }).lastInputs =
      parsed.inputs;
    return new Response(JSON.stringify(body), { status });
  });
}

describe("triggerWorkflowDispatch", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function legacyPayload(extra: Partial<BuildPayload> = {}): BuildPayload {
    return {
      registry_file: "inverters/growatt/sph/sph10k.json",
      device_name: "sph10k-haus-03",
      version: "2026.05.19",
      ...extra,
    };
  }

  it("forwards all 10 workflow inputs on a legacy payload (no yaml_authority)", async () => {
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-1",
      "17e9c4",
      legacyPayload(),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    expect(Object.keys(inputs).sort()).toEqual(
      [
        "build_contract",
        "build_id",
        "compile_secret_envelope",
        "device_key",
        "device_name",
        "encrypted_secrets",
        "ota_required",
        "registry_file",
        "version",
        "yaml_content",
      ].sort(),
    );
    expect(inputs.registry_file).toBe("inverters/growatt/sph/sph10k.json");
    expect(inputs.device_name).toBe("sph10k-haus-03");
    expect(inputs.version).toBe("2026.05.19");
    expect(inputs.build_id).toBe("build-uuid-1");
    expect(inputs.device_key).toBe("17e9c4");
    // Optional fields default to empty string so the workflow input defaults apply.
    expect(inputs.build_contract).toBe("");
    expect(inputs.yaml_content).toBe("");
    expect(inputs.encrypted_secrets).toBe("");
    expect(inputs.compile_secret_envelope).toBe("");
    expect(inputs.ota_required).toBe("");
  });

  it("forwards build_contract and yaml_content on yaml_authority path", async () => {
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-2",
      "2eb1e4",
      legacyPayload({
        build_contract: "yaml_authority",
        yaml_content: Buffer.from("esphome:\n  name: x\n").toString("base64"),
        yaml_hash:
          "a".repeat(64),
        ota_required: "1",
      }),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    expect(inputs.build_contract).toBe("yaml_authority");
    expect(inputs.yaml_content.length).toBeGreaterThan(0);
    expect(inputs.ota_required).toBe("1");
  });

  it("does NOT forward yaml_hash yet (workflow input not declared at current HEAD)", async () => {
    // EPIC-006-B7: yaml_hash is validated at the proxy edge but not yet
    // dispatched to the workflow. The Repo-2 workflow PR adds the input;
    // a follow-up commit then turns on dispatch forwarding.
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-3",
      "2eb1e4",
      legacyPayload({
        build_contract: "yaml_authority",
        yaml_content: Buffer.from("esphome:\n  name: x\n").toString("base64"),
        yaml_hash: "b".repeat(64),
      }),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    expect(inputs).not.toHaveProperty("yaml_hash");
  });

  it("forwards encrypted_secrets on legacy secret path", async () => {
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-4",
      "17e9c4",
      legacyPayload({ encrypted_secrets: "k1=v1\nk2=v2" }),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    expect(inputs.encrypted_secrets).toBe("k1=v1\nk2=v2");
    expect(inputs.compile_secret_envelope).toBe("");
  });

  it("forwards compile_secret_envelope on envelope secret path", async () => {
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-5",
      "17e9c4",
      legacyPayload({
        compile_secret_envelope: '{"hpke":"v1","ct":"…"}',
      }),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    expect(inputs.compile_secret_envelope).toBe('{"hpke":"v1","ct":"…"}');
    expect(inputs.encrypted_secrets).toBe("");
  });

  it("throws on GitHub HTTP error", async () => {
    const fetchMock = mockFetchOnce(422, { message: "Unexpected inputs" });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      triggerWorkflowDispatch(
        createEnv(),
        "build-uuid-6",
        "17e9c4",
        legacyPayload(),
      ),
    ).rejects.toThrow(/HTTP 422/);
  });
});
