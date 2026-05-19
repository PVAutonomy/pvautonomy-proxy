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
});
