import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleHealth } from "../../src/handlers/health.js";
import { _resetTokenCacheForTests } from "../../src/github/auth.js";
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

// GHAPP-1: auth_mode, github_contents_ok, token_days_left.
describe("handleHealth — GitHub App auth fields", () => {
  beforeEach(() => {
    _resetTokenCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports auth_mode pat, contents ok and null expiry without header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );

    const env = {
      GITHUB_PAT: "ghp_test",
      GITHUB_OWNER: "PVAutonomy",
      GITHUB_REPO: "inverter-registry",
    } as unknown as Env;
    const response = await handleHealth(env);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("ok");
    expect(data.auth_mode).toBe("pat");
    expect(data.github_contents_ok).toBe(true);
    expect(data.token_days_left).toBeNull();
  });

  it("probes the Contents-read path against the configured repo", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      GITHUB_PAT: "ghp_test",
      GITHUB_OWNER: "PVAutonomy",
      GITHUB_REPO: "inverter-registry",
    } as unknown as Env;
    await handleHealth(env);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(
      "https://api.github.com/repos/PVAutonomy/inverter-registry/releases?per_page=1",
    );
  });

  it("degrades when Contents read fails even though rate_limit is ok", async () => {
    // The 2026-06-12 incident shape: PAT valid (rate_limit 200) but missing
    // the Contents permission (releases 403).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        String(url).includes("/releases")
          ? new Response("forbidden", { status: 403 })
          : new Response("{}", { status: 200 }),
      ),
    );

    const env = {
      GITHUB_PAT: "ghp_test",
      GITHUB_OWNER: "PVAutonomy",
      GITHUB_REPO: "inverter-registry",
    } as unknown as Env;
    const response = await handleHealth(env);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("degraded");
    expect(data.github_api_ok).toBe(true);
    expect(data.github_contents_ok).toBe(false);
  });

  it("parses token_days_left from the PAT expiration header (UTC format)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", {
            status: 200,
            headers: {
              "github-authentication-token-expiration":
                "2026-07-04 09:00:00 UTC",
            },
          }),
      ),
    );

    const env = {
      GITHUB_PAT: "ghp_test",
      GITHUB_OWNER: "PVAutonomy",
      GITHUB_REPO: "inverter-registry",
    } as unknown as Env;
    const response = await handleHealth(env);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.token_days_left).toBe(22);
  });

  it("parses token_days_left from an ISO-8601 expiration header", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", {
            status: 200,
            headers: {
              "github-authentication-token-expiration": "2026-06-22T09:00:00Z",
            },
          }),
      ),
    );

    const env = {
      GITHUB_PAT: "ghp_test",
      GITHUB_OWNER: "PVAutonomy",
      GITHUB_REPO: "inverter-registry",
    } as unknown as Env;
    const response = await handleHealth(env);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.token_days_left).toBe(10);
  });

  it("reports auth_mode app with null expiry when App credentials are set", async () => {
    // Real WebCrypto key; fetch dispatched by URL: mint endpoint → 201
    // token, everything else → 200 (App tokens carry no expiration header).
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        String(url).includes("/app/installations/")
          ? Response.json(
              {
                token: "test-installation-token",
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              },
              { status: 201 },
            )
          : new Response("[]", { status: 200 }),
      ),
    );

    const env = {
      GITHUB_APP_ID: "2940147",
      GITHUB_APP_INSTALLATION_ID: "112192181",
      GITHUB_APP_PRIVATE_KEY: pem,
      GITHUB_OWNER: "PVAutonomy",
      GITHUB_REPO: "inverter-registry",
    } as unknown as Env;
    const response = await handleHealth(env);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("ok");
    expect(data.auth_mode).toBe("app");
    expect(data.github_api_ok).toBe(true);
    expect(data.github_contents_ok).toBe(true);
    expect(data.token_days_left).toBeNull();
  });

  it("degrades when no credential source is configured at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );

    const env = {
      GITHUB_OWNER: "PVAutonomy",
      GITHUB_REPO: "inverter-registry",
    } as unknown as Env;
    const response = await handleHealth(env);
    const data = (await response.json()) as Record<string, unknown>;

    expect(data.status).toBe("degraded");
    expect(data.github_api_ok).toBe(false);
    expect(data.github_contents_ok).toBe(false);
  });
});
