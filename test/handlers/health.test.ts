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
