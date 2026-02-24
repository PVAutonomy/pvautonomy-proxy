import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkRateLimit } from "../../src/guards/rate-limit.js";

function createMockKV(store: Map<string, string> = new Map()) {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace;
}

describe("checkRateLimit", () => {
  it("allows first build of the day", async () => {
    const kv = createMockKV();
    const result = await checkRateLimit(kv, "cust-001", 10);
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(1);
    expect(result.limit).toBe(10);
  });

  it("allows builds up to limit", async () => {
    const store = new Map<string, string>();
    const kv = createMockKV(store);

    for (let i = 0; i < 9; i++) {
      const result = await checkRateLimit(kv, "cust-001", 10);
      expect(result.allowed).toBe(true);
    }
  });

  it("rejects build at limit", async () => {
    const today = new Date().toISOString().split("T")[0];
    const store = new Map([[`customer:cust-001:daily:${today}`, "10"]]);
    const kv = createMockKV(store);

    const result = await checkRateLimit(kv, "cust-001", 10);
    expect(result.allowed).toBe(false);
    expect(result.current).toBe(10);
  });

  it("tracks different customers independently", async () => {
    const store = new Map<string, string>();
    const kv = createMockKV(store);

    await checkRateLimit(kv, "cust-001", 10);
    await checkRateLimit(kv, "cust-002", 10);

    const today = new Date().toISOString().split("T")[0];
    expect(store.get(`customer:cust-001:daily:${today}`)).toBe("1");
    expect(store.get(`customer:cust-002:daily:${today}`)).toBe("1");
  });
});
