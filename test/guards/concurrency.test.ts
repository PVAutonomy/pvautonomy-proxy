import { describe, it, expect, vi } from "vitest";
import {
  acquireBuildLock,
  releaseBuildLock,
} from "../../src/guards/concurrency.js";

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

describe("acquireBuildLock", () => {
  it("acquires lock when no active build", async () => {
    const kv = createMockKV();
    const result = await acquireBuildLock(kv, "cust-001", "build-1");
    expect(result.acquired).toBe(true);
  });

  it("rejects when another build is active", async () => {
    const store = new Map([["customer:cust-001:active", "build-1"]]);
    const kv = createMockKV(store);

    const result = await acquireBuildLock(kv, "cust-001", "build-2");
    expect(result.acquired).toBe(false);
    expect(result.existingBuildId).toBe("build-1");
  });

  it("different customers can build concurrently", async () => {
    const store = new Map<string, string>();
    const kv = createMockKV(store);

    const r1 = await acquireBuildLock(kv, "cust-001", "build-1");
    const r2 = await acquireBuildLock(kv, "cust-002", "build-2");

    expect(r1.acquired).toBe(true);
    expect(r2.acquired).toBe(true);
  });
});

describe("releaseBuildLock", () => {
  it("releases lock held by the same build", async () => {
    const store = new Map([["customer:cust-001:active", "build-1"]]);
    const kv = createMockKV(store);

    await releaseBuildLock(kv, "cust-001", "build-1");
    expect(store.has("customer:cust-001:active")).toBe(false);
  });

  it("does not release lock held by a different build", async () => {
    const store = new Map([["customer:cust-001:active", "build-1"]]);
    const kv = createMockKV(store);

    await releaseBuildLock(kv, "cust-001", "build-2");
    expect(store.get("customer:cust-001:active")).toBe("build-1");
  });
});
