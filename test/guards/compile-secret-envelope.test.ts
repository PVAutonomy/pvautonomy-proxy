import { describe, it, expect } from "vitest";
import {
  validateCompileSecretEnvelope,
  type EnvelopeBindContext,
} from "../../src/guards/compile-secret-envelope.js";
import { validateBuildRequest } from "../../src/guards/validation.js";

const PINNED =
  "HPKE-Base-DHKEM_X25519_HKDF_SHA256-HKDF_SHA256-CHACHA20_POLY1305";
const ENC32 = btoa(String.fromCharCode(...new Uint8Array(32))); // 32-byte b64
const NONCE16 = btoa(String.fromCharCode(...new Uint8Array(16))); // 16-byte b64
const CT = btoa("synthetic-ciphertext-not-real"); // non-empty std base64
const YAML_HASH = "a".repeat(64);

const ctx: EnvelopeBindContext = {
  device_key: "17e9c4",
  build_profile: "production",
  device_name: "sph10k-haus-03",
  registry_file: "inverters/growatt/sph/sph10k.json",
  yaml_hash: YAML_HASH,
};

function aad(patch: Record<string, unknown> = {}) {
  return {
    envelope_v: 1,
    alg: PINNED,
    key_id: "bb-2026-06",
    build_profile: ctx.build_profile,
    registry_file: ctx.registry_file,
    device_name: ctx.device_name,
    device_key: ctx.device_key,
    yaml_hash: YAML_HASH,
    request_nonce: NONCE16,
    ...patch,
  };
}
function env(patch: Record<string, unknown> = {}, aadPatch: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    alg: PINNED,
    key_id: "bb-2026-06",
    enc: ENC32,
    ciphertext: CT,
    aad: aad(aadPatch),
    envelope_fingerprint: "0123456789abcdef01234567",
    ...patch,
  });
}

describe("validateCompileSecretEnvelope — accept", () => {
  it("accepts a valid envelope", () => {
    expect(validateCompileSecretEnvelope(env(), ctx)).toBeNull();
  });
  it("accepts a valid envelope when request has no yaml_hash (binding skipped)", () => {
    const { yaml_hash, ...noHashCtx } = ctx;
    expect(validateCompileSecretEnvelope(env(), noHashCtx)).toBeNull();
  });
});

describe("validateCompileSecretEnvelope — shape reject", () => {
  it("invalid JSON", () => {
    expect(validateCompileSecretEnvelope("{not json", ctx)).toMatch(/not valid JSON/);
  });
  it("array instead of object", () => {
    expect(validateCompileSecretEnvelope("[1,2,3]", ctx)).toMatch(/must be a JSON object/);
  });
  it("missing/!=1 version", () => {
    expect(validateCompileSecretEnvelope(env({ v: undefined }), ctx)).toMatch(/\.v must be 1/);
    expect(validateCompileSecretEnvelope(env({ v: 2 }), ctx)).toMatch(/\.v must be 1/);
  });
  it("wrong alg", () => {
    expect(validateCompileSecretEnvelope(env({ alg: "AES-GCM" }), ctx)).toMatch(/alg is not the supported/);
  });
  it("missing key_id", () => {
    expect(validateCompileSecretEnvelope(env({ key_id: undefined }), ctx)).toMatch(/key_id missing/);
  });
  it("missing enc", () => {
    expect(validateCompileSecretEnvelope(env({ enc: undefined }), ctx)).toMatch(/\.enc must be non-empty base64/);
  });
  it("empty enc", () => {
    expect(validateCompileSecretEnvelope(env({ enc: "" }), ctx)).toMatch(/\.enc must be non-empty base64/);
  });
  it("enc wrong length", () => {
    expect(validateCompileSecretEnvelope(env({ enc: btoa("short") }), ctx)).toMatch(/\.enc has wrong length/);
  });
  it("missing ciphertext", () => {
    expect(validateCompileSecretEnvelope(env({ ciphertext: undefined }), ctx)).toMatch(/\.ciphertext must be non-empty base64/);
  });
  it("empty ciphertext", () => {
    expect(validateCompileSecretEnvelope(env({ ciphertext: "" }), ctx)).toMatch(/\.ciphertext must be non-empty base64/);
  });
  it("oversized ciphertext", () => {
    expect(validateCompileSecretEnvelope(env({ ciphertext: "A".repeat(16385) }), ctx)).toMatch(/ciphertext too large/);
  });
  it("missing aad", () => {
    expect(validateCompileSecretEnvelope(env({ aad: undefined }), ctx)).toMatch(/\.aad missing/);
  });
  it("missing aad sub-field (request_nonce)", () => {
    expect(validateCompileSecretEnvelope(env({}, { request_nonce: undefined }), ctx)).toMatch(/aad\.request_nonce/);
  });
  it("bad request_nonce length", () => {
    expect(validateCompileSecretEnvelope(env({}, { request_nonce: btoa("x") }), ctx)).toMatch(/aad\.request_nonce invalid/);
  });
  it("bad aad.yaml_hash format", () => {
    expect(validateCompileSecretEnvelope(env({}, { yaml_hash: "nothex" }), ctx)).toMatch(/aad\.yaml_hash must be 64 hex/);
  });
});

describe("validateCompileSecretEnvelope — aad self-consistency reject", () => {
  it("aad.envelope_v mismatch", () => {
    expect(validateCompileSecretEnvelope(env({}, { envelope_v: 2 }), ctx)).toMatch(/aad\.envelope_v mismatch/);
  });
  it("aad.alg mismatch", () => {
    expect(validateCompileSecretEnvelope(env({}, { alg: "AES-GCM" }), ctx)).toMatch(/aad\.alg mismatch/);
  });
  it("aad.key_id mismatch", () => {
    expect(validateCompileSecretEnvelope(env({}, { key_id: "other" }), ctx)).toMatch(/aad\.key_id mismatch/);
  });
});

describe("validateCompileSecretEnvelope — aad binding reject", () => {
  it("device_key mismatch", () => {
    expect(validateCompileSecretEnvelope(env({}, { device_key: "aabbcc" }), ctx)).toMatch(/aad\.device_key does not match/);
  });
  it("build_profile mismatch", () => {
    expect(validateCompileSecretEnvelope(env({}, { build_profile: "factory" }), ctx)).toMatch(/aad\.build_profile does not match/);
  });
  it("device_name mismatch", () => {
    expect(validateCompileSecretEnvelope(env({}, { device_name: "other-device" }), ctx)).toMatch(/aad\.device_name does not match/);
  });
  it("registry_file mismatch", () => {
    expect(validateCompileSecretEnvelope(env({}, { registry_file: "inverters/x/y.json" }), ctx)).toMatch(/aad\.registry_file does not match/);
  });
  it("yaml_hash mismatch (request carries a different hash)", () => {
    expect(validateCompileSecretEnvelope(env({}, { yaml_hash: "b".repeat(64) }), ctx)).toMatch(/aad\.yaml_hash does not match/);
  });
  // NOTE: customer_id and model are NOT in the producer AAD, so they cannot be
  // AAD-bound here. They are validated elsewhere (build-create customer_id
  // match; SUPPORTED_MODELS). See PR body for the producer-shape rationale.
});

describe("validateBuildRequest — integration", () => {
  const base = {
    customer_id: "cust-001",
    device_key: "17e9c4",
    model: "edge101",
    build_profile: "production",
  };
  function req(payloadExtra: Record<string, unknown>) {
    return {
      ...base,
      payload: {
        registry_file: ctx.registry_file,
        device_name: ctx.device_name,
        ...payloadExtra,
      },
    };
  }

  it("legacy request without envelope still valid", () => {
    expect(validateBuildRequest(req({}))).toBeNull();
  });
  it("valid envelope passes full validation (with yaml_hash bound)", () => {
    expect(
      validateBuildRequest(req({ yaml_hash: YAML_HASH, compile_secret_envelope: env() })),
    ).toBeNull();
  });
  it("malformed envelope rejected via validateBuildRequest (→ 400)", () => {
    expect(validateBuildRequest(req({ compile_secret_envelope: "{not json" }))).toMatch(/not valid JSON/);
  });
  it("aad mismatch rejected via validateBuildRequest", () => {
    expect(
      validateBuildRequest(req({ compile_secret_envelope: env({}, { device_name: "other" }) })),
    ).toMatch(/aad\.device_name does not match/);
  });
  it("encrypted_secrets + compile_secret_envelope still mutually exclusive", () => {
    expect(
      validateBuildRequest(req({ encrypted_secrets: "x", compile_secret_envelope: env() })),
    ).toMatch(/mutually exclusive/);
  });
  it("error messages never echo enc/ciphertext/nonce values", () => {
    const e = validateBuildRequest(req({ compile_secret_envelope: env({}, { device_key: "aabbcc" }) }));
    expect(e).toBeTruthy();
    expect(e).not.toContain(CT);
    expect(e).not.toContain(ENC32);
    expect(e).not.toContain(NONCE16);
  });
});
