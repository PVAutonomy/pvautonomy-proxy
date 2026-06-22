import { describe, it, expect } from "vitest";
import { validateBuildRequest } from "../../src/guards/validation.js";

describe("validateBuildRequest", () => {
  const validRequest = {
    customer_id: "cust-001",
    device_key: "17e9c4",
    model: "edge101",
    build_profile: "production",
    payload: {
      registry_file: "inverters/growatt/sph/sph10k.json",
      device_name: "sph10k-haus-03",
    },
  };

  it("accepts a valid request", () => {
    expect(validateBuildRequest(validRequest)).toBeNull();
  });

  it("accepts factory build_profile", () => {
    expect(
      validateBuildRequest({ ...validRequest, build_profile: "factory" }),
    ).toBeNull();
  });

  it("rejects missing customer_id", () => {
    const { customer_id, ...rest } = validRequest;
    expect(validateBuildRequest(rest)).toContain("customer_id");
  });

  it("rejects invalid device_key (too short)", () => {
    expect(
      validateBuildRequest({ ...validRequest, device_key: "abc" }),
    ).toContain("device_key");
  });

  it("rejects invalid device_key (non-hex)", () => {
    expect(
      validateBuildRequest({ ...validRequest, device_key: "zzzzzz" }),
    ).toContain("device_key");
  });

  it("rejects unsupported model", () => {
    expect(
      validateBuildRequest({ ...validRequest, model: "core2" }),
    ).toContain("model");
  });

  it("rejects invalid build_profile", () => {
    expect(
      validateBuildRequest({ ...validRequest, build_profile: "staging" }),
    ).toContain("build_profile");
  });

  it("rejects missing payload", () => {
    const { payload, ...rest } = validRequest;
    expect(validateBuildRequest(rest)).toContain("payload");
  });

  it("rejects missing registry_file", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { device_name: "test-01" },
      }),
    ).toContain("registry_file");
  });

  it("rejects invalid device_name (uppercase)", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, device_name: "SPH10K-haus-03" },
      }),
    ).toContain("device_name");
  });

  it("rejects non-object body", () => {
    expect(validateBuildRequest("string")).toContain("JSON object");
  });

  it("rejects null body", () => {
    expect(validateBuildRequest(null)).toContain("JSON object");
  });

  // ── EPIC-006-B7: yaml_authority contract + strict payload ──────────────

  const yamlContentB64 = Buffer.from("esphome:\n  name: x\n").toString("base64");
  const validHash = "a".repeat(64);

  it("accepts a well-formed yaml_authority payload", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: {
          ...validRequest.payload,
          build_contract: "yaml_authority",
          yaml_content: yamlContentB64,
          yaml_hash: validHash,
        },
      }),
    ).toBeNull();
  });

  it("accepts a legacy payload with explicit empty build_contract", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, build_contract: "" },
      }),
    ).toBeNull();
  });

  it("rejects yaml_authority without yaml_content", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        build_contract: "yaml_authority",
        yaml_hash: validHash,
      },
    });
    expect(err).toContain("yaml_content");
  });

  it("rejects yaml_authority without yaml_hash", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        build_contract: "yaml_authority",
        yaml_content: yamlContentB64,
      },
    });
    expect(err).toContain("yaml_hash");
  });

  it("rejects yaml_authority with empty yaml_content string", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        build_contract: "yaml_authority",
        yaml_content: "",
        yaml_hash: validHash,
      },
    });
    expect(err).toContain("yaml_content");
  });

  it("rejects yaml_hash with wrong length", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        yaml_hash: "a".repeat(63),
      },
    });
    expect(err).toContain("64 hex");
  });

  it("rejects yaml_hash with non-hex characters", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        yaml_hash: "z".repeat(64),
      },
    });
    expect(err).toContain("64 hex");
  });

  it("accepts well-formed yaml_hash on the legacy path (as a cache key)", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, yaml_hash: validHash },
      }),
    ).toBeNull();
  });

  it("rejects unknown payload field", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        not_a_real_field: "anything",
      },
    });
    expect(err).toContain("not_a_real_field");
    expect(err).toContain("not a known field");
  });

  it("rejects an unrecognized build_contract value", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        build_contract: "registry_authority",
      },
    });
    expect(err).toContain("build_contract");
  });

  it("rejects dual secret path (encrypted_secrets + compile_secret_envelope)", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        encrypted_secrets: "k=v",
        compile_secret_envelope: '{"hpke":"v1"}',
      },
    });
    expect(err).toContain("mutually exclusive");
  });

  it("accepts encrypted_secrets alone (legacy secret path)", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, encrypted_secrets: "k=v" },
      }),
    ).toBeNull();
  });

  it("accepts compile_secret_envelope alone (HPKE secret path)", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: {
          ...validRequest.payload,
          compile_secret_envelope: '{"hpke":"v1"}',
        },
      }),
    ).toBeNull();
  });

  it("accepts compile_secret_envelope as a deterministic JSON string (HA wire shape)", () => {
    // HA serializes the sealed envelope deterministically (sorted keys,
    // compact separators) into a single JSON *string*. The proxy must
    // accept that string verbatim.
    const envelopeJson = JSON.stringify(
      { alg: "HPKE", ciphertext: "abc", enc: "def", key_id: "bb-2026-04", v: 1 },
      Object.keys({ alg: 0, ciphertext: 0, enc: 0, key_id: 0, v: 0 }).sort(),
    );
    expect(typeof envelopeJson).toBe("string");
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: {
          ...validRequest.payload,
          compile_secret_envelope: envelopeJson,
        },
      }),
    ).toBeNull();
  });

  it("rejects compile_secret_envelope sent as an object (must be a string)", () => {
    // Wire-type guard: the envelope must ride as a JSON string, never a
    // nested object. An object form is a fail-closed 400 with a clear
    // string-type error.
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        compile_secret_envelope: { hpke: "v1" } as unknown as string,
      },
    });
    expect(err).toContain("payload.compile_secret_envelope");
    expect(err).toContain("string");
  });

  it("rejects optional string field of wrong type", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: { ...validRequest.payload, version: 1234 },
    });
    expect(err).toContain("version");
    expect(err).toContain("string");
  });

  // ── EPIC-006-B7 hotfix: payload.device_key legacy/HA-compat ────────────

  it("accepts payload.device_key when it matches the top-level device_key", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: {
          ...validRequest.payload,
          device_key: validRequest.device_key,
        },
      }),
    ).toBeNull();
  });

  it("rejects payload.device_key when it does not match the top-level device_key", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        device_key: "deadbe",
      },
    });
    expect(err).toContain("payload.device_key");
    expect(err).toContain("top-level");
  });

  it("rejects payload.device_key with malformed value (not 6-hex)", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        device_key: "zzz",
      },
    });
    expect(err).toContain("payload.device_key");
    expect(err).toContain("6 hex");
  });

  it("rejects payload.device_key of wrong type", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        device_key: 12345,
      },
    });
    expect(err).toContain("payload.device_key");
    expect(err).toContain("string");
  });

  // ── EPIC-006-B7 hotfix #2: payload.secret_context_hash ─────────────────

  const SECRET_CTX_HASH = "b".repeat(64);

  it("accepts a well-formed secret_context_hash on the legacy secret path", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: {
          ...validRequest.payload,
          encrypted_secrets: "k=v",
          secret_context_hash: SECRET_CTX_HASH,
        },
      }),
    ).toBeNull();
  });

  it("accepts the full HA non-envelope yaml_authority payload shape", () => {
    // Mirrors exactly what custom_components/pvautonomy_ops/build_backend.py
    // emits on a customer proxy build with build_contract=yaml_authority
    // and no envelope: every payload-level field HA writes is here.
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: {
          registry_file: "inverters/growatt/sph/sph10k.json",
          device_name: "sph10k-home-02",
          version: "2026.05.19-2116",
          yaml_hash: validHash,
          build_contract: "yaml_authority",
          yaml_content: yamlContentB64,
          device_key: validRequest.device_key,
          encrypted_secrets: "edge101_api_key_17e9c4=fixture\nedge101_ota_password_17e9c4=fixture",
          secret_context_hash: SECRET_CTX_HASH,
          ota_required: "1",
        },
      }),
    ).toBeNull();
  });

  it("rejects payload.secret_context_hash with wrong format (not 64 hex)", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        secret_context_hash: "deadbeef",
      },
    });
    expect(err).toContain("payload.secret_context_hash");
    expect(err).toContain("64 hex");
  });

  it("rejects payload.secret_context_hash with non-hex characters", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        secret_context_hash: "z".repeat(64),
      },
    });
    expect(err).toContain("payload.secret_context_hash");
    expect(err).toContain("64 hex");
  });

  it("rejects payload.secret_context_hash of wrong type", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: {
        ...validRequest.payload,
        secret_context_hash: 12345,
      },
    });
    expect(err).toContain("payload.secret_context_hash");
    expect(err).toContain("string");
  });

  // ── EPIC-006-B7 hotfix #3: ota_required boolean/string ────────────────

  it("accepts ota_required as boolean true (HA-native wire shape)", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, ota_required: true },
      }),
    ).toBeNull();
  });

  it("accepts ota_required as boolean false", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, ota_required: false },
      }),
    ).toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["string 0", "0"],
    ["string 1", "1"],
    ["lowercase true", "true"],
    ["lowercase false", "false"],
    ["uppercase TRUE", "TRUE"],
    ["mixed-case True", "True"],
  ])(
    "accepts ota_required as canonical string (%s)",
    (_label: string, value: string) => {
      expect(
        validateBuildRequest({
          ...validRequest,
          payload: { ...validRequest.payload, ota_required: value },
        }),
      ).toBeNull();
    },
  );

  it("rejects ota_required string outside the canonical set", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: { ...validRequest.payload, ota_required: "yes" },
    });
    expect(err).toContain("payload.ota_required");
    expect(err).toContain("case-insensitive");
  });

  it("rejects ota_required of non-boolean / non-string type", () => {
    const err = validateBuildRequest({
      ...validRequest,
      payload: { ...validRequest.payload, ota_required: 1 },
    });
    expect(err).toContain("payload.ota_required");
    expect(err).toContain("boolean or string");
  });

  it("accepts the full HA non-envelope yaml_authority payload with boolean ota_required", () => {
    // Updated full-shape probe: ota_required is now a boolean (matches
    // the live HA wire shape from build_backend.py line 1700).
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: {
          registry_file: "inverters/growatt/sph/sph10k.json",
          device_name: "sph10k-home-02",
          version: "2026.05.19-2116",
          yaml_hash: validHash,
          build_contract: "yaml_authority",
          yaml_content: yamlContentB64,
          device_key: validRequest.device_key,
          encrypted_secrets:
            "edge101_api_key_17e9c4=fixture\nedge101_ota_password_17e9c4=fixture",
          secret_context_hash: "b".repeat(64),
          ota_required: true,
        },
      }),
    ).toBeNull();
  });

  // ── #97: defs_version (ADR-0001 P2-b2) ──────────────────────────────────
  it("accepts a valid defs_version", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, defs_version: "1.0.0" },
      }),
    ).toBeNull();
  });

  it("accepts a payload without defs_version (optional)", () => {
    expect(validateBuildRequest(validRequest)).toBeNull();
  });

  it("rejects an empty defs_version", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, defs_version: "" },
      }),
    ).toContain("defs_version");
  });

  it("rejects a non-string defs_version", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, defs_version: 100 },
      }),
    ).toContain("defs_version");
  });

  it("rejects a malformed defs_version (illegal characters)", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, defs_version: "1.0.0 drop;" },
      }),
    ).toContain("defs_version");
  });

  it("rejects a too-long defs_version", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, defs_version: "1".repeat(65) },
      }),
    ).toContain("defs_version");
  });

  it("still rejects an unknown payload field even with a valid defs_version", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: { ...validRequest.payload, defs_version: "1.0.0", bogus: "x" },
      }),
    ).toContain("is not a known field");
  });

  it("keeps accepting yaml_hash alongside defs_version (no regression)", () => {
    expect(
      validateBuildRequest({
        ...validRequest,
        payload: {
          ...validRequest.payload,
          defs_version: "1.0.0",
          yaml_hash: "a".repeat(64),
        },
      }),
    ).toBeNull();
  });
});
