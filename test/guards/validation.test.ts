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
});
