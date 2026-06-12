import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  triggerWorkflowDispatch,
  normalizeOtaRequired,
} from "../../src/github/dispatch.js";
import type { BuildPayload, Env } from "../../src/types.js";
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
        "yaml_hash",
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
    expect(inputs.yaml_hash).toBe("");
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

  it("forwards yaml_hash on the yaml_authority path (end-to-end binding)", async () => {
    // EPIC-006-B7 follow-up: now that inverter-registry#7 added the
    // yaml_hash workflow input and the fail-closed compare step, the
    // proxy forwards yaml_hash so the runner can verify the bytes it
    // decoded match the hash HA computed.
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const expectedHash = "b".repeat(64);
    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-3",
      "2eb1e4",
      legacyPayload({
        build_contract: "yaml_authority",
        yaml_content: Buffer.from("esphome:\n  name: x\n").toString("base64"),
        yaml_hash: expectedHash,
      }),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    expect(inputs).toHaveProperty("yaml_hash");
    expect(inputs.yaml_hash).toBe(expectedHash);
    expect(inputs.build_contract).toBe("yaml_authority");
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

  it("forwards compile_secret_envelope as exactly one string input (no object, no extra input)", async () => {
    // Wire-type proof for the dormant envelope path: GitHub Actions
    // workflow_dispatch inputs can only be strings. The proxy must forward
    // the envelope as a single string-valued input — never an object, and
    // without adding any input beyond the 11 the workflow declares.
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const envelopeJson =
      '{"alg":"HPKE","ciphertext":"abc","enc":"def","key_id":"bb-2026-04","v":1}';

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-env-wire",
      "17e9c4",
      legacyPayload({ compile_secret_envelope: envelopeJson }),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    // Exactly one compile_secret_envelope input, value is a string.
    const envEntries = Object.keys(inputs).filter(
      (k) => k === "compile_secret_envelope",
    );
    expect(envEntries).toHaveLength(1);
    expect(typeof inputs.compile_secret_envelope).toBe("string");
    expect(inputs.compile_secret_envelope).toBe(envelopeJson);
    expect(inputs.encrypted_secrets).toBe("");

    // No object form leaked through, and exactly the 11 declared inputs.
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
        "yaml_hash",
      ].sort(),
    );
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

  it("does NOT forward payload.secret_context_hash as a workflow input", async () => {
    // EPIC-006-B7 hotfix #2: secret_context_hash is HA-side cache/audit
    // metadata (sha256 of encrypted_secrets). It's accepted at the proxy
    // edge but is NOT a workflow input — the build-firmware-on-demand.yml
    // workflow does not declare it and forwarding it would 422 every
    // dispatch.
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-secret-ctx",
      "17e9c4",
      legacyPayload({
        encrypted_secrets: "k=v",
        // Note: BuildPayload type allows secret_context_hash since the
        // hotfix; the cast keeps TS happy if the field hasn't been
        // exposed in the test's BuildPayload narrowing.
        ...({ secret_context_hash: "c".repeat(64) } as Partial<BuildPayload>),
      }),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    expect(inputs).not.toHaveProperty("secret_context_hash");
    // And still exactly the 11 declared workflow inputs.
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
        "yaml_hash",
      ].sort(),
    );
  });

  it("uses the deviceKey parameter (top-level) for the workflow input, ignoring payload.device_key", async () => {
    // EPIC-006-B7 hotfix: HA's ProxyRemoteBuildBackend echoes the MAC
    // suffix into payload.device_key in addition to top-level
    // BuildRequest.device_key. The proxy validates equality at the edge
    // (validation.ts) and dispatch only uses the top-level value as the
    // workflow input source — payload.device_key is NOT forwarded as a
    // separate input. There is only one device_key input on the workflow.
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-7",
      "17e9c4", // <-- top-level deviceKey arg (from BuildRequest.device_key)
      legacyPayload({ device_key: "17e9c4" }), // <-- HA's payload echo
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    // Exactly one device_key input, sourced from the top-level arg.
    const deviceKeyEntries = Object.keys(inputs).filter(
      (k) => k === "device_key",
    );
    expect(deviceKeyEntries).toHaveLength(1);
    expect(inputs.device_key).toBe("17e9c4");
  });

  // ── EPIC-006-B7 hotfix #3: ota_required normalization at dispatch ─────

  it.each([
    [true, "1"],
    [false, ""],
    [undefined, ""],
    ["1", "1"],
    ["0", ""],
    ["true", "1"],
    ["false", ""],
    ["TRUE", "1"],
    ["False", ""],
    ["", ""],
  ] as Array<[string | boolean | undefined, string]>)(
    "normalizeOtaRequired(%j) -> %j",
    (input, expected) => {
      expect(normalizeOtaRequired(input)).toBe(expected);
    },
  );

  it("forwards HA-realistic boolean ota_required=true as workflow input '1'", async () => {
    // Mirrors HA's actual wire shape: build_backend.py emits
    // payload["payload"]["ota_required"] = True (Python bool → JSON true).
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-ota-true",
      "17e9c4",
      legacyPayload({ ota_required: true }),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    expect(inputs.ota_required).toBe("1");
    // Still exactly the 11 declared workflow inputs (no new keys, no
    // missing keys).
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
        "yaml_hash",
      ].sort(),
    );
  });

  it("forwards boolean ota_required=false as workflow input ''", async () => {
    const fetchMock = mockFetchOnce();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await triggerWorkflowDispatch(
      createEnv(),
      "build-uuid-ota-false",
      "17e9c4",
      legacyPayload({ ota_required: false }),
    );

    const inputs = (mockFetchOnce as unknown as {
      lastInputs: Record<string, string>;
    }).lastInputs;

    expect(inputs.ota_required).toBe("");
  });
});
