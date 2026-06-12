import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleHealth } from "../../src/handlers/health.js";
import type { Env } from "../../src/types.js";

describe("handleHealth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok when GitHub API is reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    const env = {
      GITHUB_PAT: "ghp_test",
    } as unknown as Env;

    const response = await handleHealth(env);
    expect(response.status).toBe(200);

    const data = (await response.json()) as Record<string, unknown>;
    expect(data.status).toBe("ok");
    expect(data.github_api_ok).toBe(true);
    expect(data.version).toBe("0.1.0");
  });

  // ISSUE-7: without deploy-time stamping (tests, dev) the committed
  // fallbacks are reported.
  it("falls back to dev version metadata when not stamped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    const env = { GITHUB_PAT: "ghp_test" } as unknown as Env;
    const response = await handleHealth(env);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.git_sha).toBe("dev");
    expect(data.built_at).toBe("dev");
  });

  // ISSUE-7: with deploy-time stamping (scripts/gen-version.mjs) the
  // injected SHA and build timestamp are reported.
  it("reports stamped git_sha and built_at when generated at deploy time", async () => {
    vi.resetModules();
    vi.doMock("../../src/version.generated.js", () => ({
      GIT_SHA: "abc1234",
      BUILT_AT: "2026-06-12T10:00:00Z",
    }));
    try {
      const { handleHealth: stampedHealth } = await import(
        "../../src/handlers/health.js"
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 200 })),
      );

      const env = { GITHUB_PAT: "ghp_test" } as unknown as Env;
      const response = await stampedHealth(env);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.git_sha).toBe("abc1234");
      expect(data.built_at).toBe("2026-06-12T10:00:00Z");
      expect(data.version).toBe("0.1.0");
      expect(data.status).toBe("ok");
    } finally {
      vi.doUnmock("../../src/version.generated.js");
      vi.resetModules();
    }
  });

  it("returns degraded when GitHub API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );

    const env = {
      GITHUB_PAT: "ghp_test",
    } as unknown as Env;

    const response = await handleHealth(env);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.status).toBe("degraded");
    expect(data.github_api_ok).toBe(false);
  });
});
