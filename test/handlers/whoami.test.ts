import { describe, it, expect } from "vitest";
import { handleWhoami } from "../../src/handlers/whoami.js";
import { route } from "../../src/router.js";
import type { ApiKeyRecord, Env } from "../../src/types.js";

const CUSTOMER: ApiKeyRecord = {
  customer_id: "cust_test_001",
  label: "test key",
  created_at: "2026-01-01T00:00:00Z",
  active: true,
  rate_limit_override: null,
};

/** Minimal KVNamespace stub: returns `record` for any get(). */
function kvReturning(record: ApiKeyRecord | null): KVNamespace {
  return { get: async () => record } as unknown as KVNamespace;
}

function envWith(record: ApiKeyRecord | null): Env {
  return { API_KEYS: kvReturning(record) } as unknown as Env;
}

describe("handleWhoami (unit)", () => {
  it("returns 200 with the key-derived customer_id", async () => {
    const res = handleWhoami(CUSTOMER);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.customer_id).toBe("cust_test_001");
  });

  it("exposes only customer_id — no secrets in the body", async () => {
    const res = handleWhoami(CUSTOMER);
    const raw = await res.clone().text();
    const data = (await res.json()) as Record<string, unknown>;
    // Exactly one field; nothing sensitive leaks.
    expect(Object.keys(data)).toEqual(["customer_id"]);
    for (const needle of [
      "pva_",
      "api_key",
      "apiKey",
      "token",
      "secret",
      "hash",
      "label",
      "key:",
    ]) {
      expect(raw.toLowerCase()).not.toContain(needle.toLowerCase());
    }
  });
});

describe("GET /whoami (router)", () => {
  it("returns customer_id for a valid API key", async () => {
    const req = new Request("https://proxy.example/whoami", {
      headers: { Authorization: "Bearer pva_validkey" },
    });
    const res = await route(req, envWith(CUSTOMER));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.customer_id).toBe("cust_test_001");
  });

  it("is registered (auth-gated, not 404) when no key is supplied", async () => {
    const req = new Request("https://proxy.example/whoami");
    const res = await route(req, envWith(CUSTOMER));
    expect(res.status).toBe(401);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.customer_id).toBeUndefined();
  });

  it("rejects an invalid/inactive key without leaking customer_id", async () => {
    const req = new Request("https://proxy.example/whoami", {
      headers: { Authorization: "Bearer pva_badkey" },
    });
    const res = await route(req, envWith(null));
    expect(res.status).toBe(403);
    const raw = await res.text();
    expect(raw).not.toContain("cust_test_001");
  });
});
