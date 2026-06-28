import { describe, it, expect } from "vitest";
import {
  sanitizeBuildRecordForPersist,
  REDACTED,
} from "../../src/secrets/sanitize.js";
import type { BuildRecord, BuildPayload } from "../../src/types.js";

// Low-entropy synthetic markers (gitleaks-safe — not base64/high-entropy).
const ENC_MARKER = "SYNTHETIC-ENCRYPTED-SECRETS-NOT-REAL";
const ENV_MARKER = '{"v":1,"marker":"SYNTHETIC-ENVELOPE-NOT-REAL"}';

function record(payload: BuildPayload | null): BuildRecord {
  return {
    build_id: "11111111-1111-1111-1111-111111111111",
    customer_id: "cust-001",
    device_key: "17e9c4",
    model: "edge101",
    build_profile: "production",
    status: "dispatched",
    github_run_id: 999,
    github_run_url: "https://github.com/PVAutonomy/inverter-registry/actions/runs/999",
    progress: 5,
    created_at: "2026-06-28T00:00:00Z",
    updated_at: "2026-06-28T00:00:01Z",
    completed_at: null,
    artifact: null,
    error: null,
    payload_hash: "deadbeef",
    payload,
  };
}

describe("sanitizeBuildRecordForPersist", () => {
  it("redacts encrypted_secrets and compile_secret_envelope", () => {
    const out = sanitizeBuildRecordForPersist(
      record({
        registry_file: "inverters/growatt/sph/sph10k.json",
        device_name: "sph10k-haus-03",
        encrypted_secrets: ENC_MARKER,
      }),
    );
    expect(out.payload?.encrypted_secrets).toBe(REDACTED);

    const out2 = sanitizeBuildRecordForPersist(
      record({
        registry_file: "inverters/growatt/sph/sph10k.json",
        device_name: "sph10k-haus-03",
        compile_secret_envelope: ENV_MARKER,
      }),
    );
    expect(out2.payload?.compile_secret_envelope).toBe(REDACTED);
    expect(JSON.stringify(out2)).not.toContain("SYNTHETIC-ENVELOPE-NOT-REAL");
  });

  it("preserves non-secret metadata (incl. secret_context_hash, yaml_content)", () => {
    const out = sanitizeBuildRecordForPersist(
      record({
        registry_file: "inverters/growatt/sph/sph10k.json",
        device_name: "sph10k-haus-03",
        version: "2026.06.28",
        yaml_content: "ZXNwaG9tZToK",
        yaml_hash: "a".repeat(64),
        secret_context_hash: "b".repeat(64), // contains "secret" substring — must survive
        defs_version: "1.0.0",
        ota_required: true,
        encrypted_secrets: ENC_MARKER,
      }),
    );
    expect(out.payload?.registry_file).toBe("inverters/growatt/sph/sph10k.json");
    expect(out.payload?.device_name).toBe("sph10k-haus-03");
    expect(out.payload?.version).toBe("2026.06.28");
    expect(out.payload?.yaml_content).toBe("ZXNwaG9tZToK");
    expect(out.payload?.yaml_hash).toBe("a".repeat(64));
    expect(out.payload?.secret_context_hash).toBe("b".repeat(64)); // exact-match guard
    expect(out.payload?.defs_version).toBe("1.0.0");
    expect(out.payload?.ota_required).toBe(true);
    // top-level identity metadata preserved
    expect(out.customer_id).toBe("cust-001");
    expect(out.device_key).toBe("17e9c4");
    expect(out.status).toBe("dispatched");
  });

  it("does not mutate the original record", () => {
    const original = record({
      registry_file: "inverters/growatt/sph/sph10k.json",
      device_name: "sph10k-haus-03",
      encrypted_secrets: ENC_MARKER,
    });
    sanitizeBuildRecordForPersist(original);
    expect(original.payload?.encrypted_secrets).toBe(ENC_MARKER); // unchanged
  });

  it("is idempotent", () => {
    const once = sanitizeBuildRecordForPersist(
      record({
        registry_file: "inverters/growatt/sph/sph10k.json",
        device_name: "sph10k-haus-03",
        encrypted_secrets: ENC_MARKER,
      }),
    );
    const twice = sanitizeBuildRecordForPersist(once);
    expect(twice.payload?.encrypted_secrets).toBe(REDACTED);
  });

  it("recursively redacts nested forbidden keys (defensive)", () => {
    // BuildPayload has no nested objects today; cast to prove the recursive
    // guard covers any future/unexpected nested secret-bearing field.
    const payload = {
      registry_file: "inverters/growatt/sph/sph10k.json",
      device_name: "sph10k-haus-03",
      nested: { private_key: "SYNTHETIC-PRIV-NOT-REAL", keep: "ok" },
    } as unknown as BuildPayload;
    const out = sanitizeBuildRecordForPersist(record(payload));
    const nested = (out.payload as unknown as Record<string, any>).nested;
    expect(nested.private_key).toBe(REDACTED);
    expect(nested.keep).toBe("ok");
  });

  it("returns null payload unchanged", () => {
    const out = sanitizeBuildRecordForPersist(record(null));
    expect(out.payload).toBeNull();
  });

  it("leaves absent/empty secret fields as-is", () => {
    const out = sanitizeBuildRecordForPersist(
      record({
        registry_file: "inverters/growatt/sph/sph10k.json",
        device_name: "sph10k-haus-03",
        encrypted_secrets: "",
      }),
    );
    expect(out.payload?.encrypted_secrets).toBe(""); // empty stays empty, not redacted
    expect(out.payload?.compile_secret_envelope).toBeUndefined();
  });
});
