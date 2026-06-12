import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getGithubToken,
  _resetTokenCacheForTests,
} from "../../src/github/auth.js";
import type { Env } from "../../src/types.js";

// GHAPP-1: real WebCrypto throughout — only fetch is mocked. A fresh RSA
// test key is generated per suite; no real credentials anywhere.

interface TestKey {
  pem: string;
  publicKey: CryptoKey;
}

async function generateTestKey(): Promise<TestKey> {
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
  const lines = b64.match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function b64urlDecode(part: string): Uint8Array {
  const b64 =
    part.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (part.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split(".");
  return JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
}

function appEnv(key: TestKey, overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_APP_ID: "2940147",
    GITHUB_APP_INSTALLATION_ID: "112192181",
    GITHUB_APP_PRIVATE_KEY: key.pem,
    ...overrides,
  } as unknown as Env;
}

/** fetch mock that returns a 201 installation-token response. */
function mintFetchMock(token: string, expiresAt: string) {
  return vi.fn(async () =>
    Response.json({ token, expires_at: expiresAt }, { status: 201 }),
  );
}

describe("getGithubToken — credential guard", () => {
  beforeEach(() => {
    _resetTokenCacheForTests();
    vi.restoreAllMocks();
  });

  it("throws a clear error when nothing is configured", async () => {
    const env = {} as unknown as Env;
    await expect(getGithubToken(env)).rejects.toThrow(
      /GitHub App credentials incomplete/,
    );
  });

  it("throws when the private-key secret is missing (GHAPP-2: no PAT fallback)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      GITHUB_APP_ID: "2940147",
      GITHUB_APP_INSTALLATION_ID: "112192181",
    } as unknown as Env;
    await expect(getGithubToken(env)).rejects.toThrow(
      /GitHub App credentials incomplete/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when an ID is missing even though the key is set", async () => {
    const env = {
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
      GITHUB_APP_INSTALLATION_ID: "112192181",
    } as unknown as Env;
    await expect(getGithubToken(env)).rejects.toThrow(
      /GitHub App credentials incomplete/,
    );
  });
});

describe("getGithubToken — App installation tokens", () => {
  let key: TestKey;

  beforeEach(async () => {
    _resetTokenCacheForTests();
    vi.restoreAllMocks();
    key = await generateTestKey();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints an installation token with a valid RS256 app JWT", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const fetchMock = mintFetchMock("test-installation-token", expiresAt);
    vi.stubGlobal("fetch", fetchMock);

    const token = await getGithubToken(appEnv(key));
    expect(token).toBe("test-installation-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.github.com/app/installations/112192181/access_tokens",
    );
    expect(init.method).toBe("POST");

    // Verify the JWT cryptographically against the test public key.
    const authHeader = (init.headers as Record<string, string>).Authorization;
    const jwt = authHeader.replace("Bearer ", "");
    const [header, payload, signature] = jwt.split(".");
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key.publicKey,
      b64urlDecode(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(ok).toBe(true);

    const claims = decodeJwtPayload(jwt);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(claims.iss).toBe("2940147");
    expect(claims.iat).toBeLessThanOrEqual(nowSec - 60);
    expect(claims.exp).toBeLessThanOrEqual(nowSec + 540);
    expect(claims.exp as number).toBeGreaterThan(nowSec);
  });

  it("treats the token as opaque — no prefix or length assumptions", async () => {
    // GitHub is moving to stateless tokens up to ~520 chars; no ghs_ prefix
    // is guaranteed.
    const longToken = "x".repeat(520);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    vi.stubGlobal("fetch", mintFetchMock(longToken, expiresAt));

    await expect(getGithubToken(appEnv(key))).resolves.toBe(longToken);
  });

  it("reuses the cached token until 10 minutes before expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T10:00:00Z"));

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const fetchMock = mintFetchMock("cached-token", expiresAt);
    vi.stubGlobal("fetch", fetchMock);

    const env = appEnv(key);
    await expect(getGithubToken(env)).resolves.toBe("cached-token");
    // 45 min in: 15 min lifetime left > 10 min margin → cache hit.
    vi.setSystemTime(new Date("2026-06-12T10:45:00Z"));
    await expect(getGithubToken(env)).resolves.toBe("cached-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-mints once the token is within the 10-minute expiry margin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T10:00:00Z"));

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const fetchMock = mintFetchMock("first-token", expiresAt);
    vi.stubGlobal("fetch", fetchMock);

    const env = appEnv(key);
    await expect(getGithubToken(env)).resolves.toBe("first-token");
    // 55 min in: 5 min lifetime left < 10 min margin → fresh mint.
    vi.setSystemTime(new Date("2026-06-12T10:55:00Z"));
    fetchMock.mockImplementation(async () =>
      Response.json(
        {
          token: "second-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        { status: 201 },
      ),
    );
    await expect(getGithubToken(env)).resolves.toBe("second-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws with status and body when the mint request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad credentials", { status: 401 })),
    );

    await expect(getGithubToken(appEnv(key))).rejects.toThrow(
      /installation token mint failed: HTTP 401 — bad credentials/,
    );
  });

  it("throws when the mint response is missing token fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true }, { status: 201 })),
    );

    await expect(getGithubToken(appEnv(key))).rejects.toThrow(
      /missing token\/expires_at/,
    );
  });
});
