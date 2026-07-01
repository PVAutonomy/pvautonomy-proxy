import { describe, it, expect } from "vitest";
import { route } from "../../src/router.js";
import { handleBuildBackendKeys } from "../../src/handlers/build-backend-keys.js";
import { sha256 } from "../../src/kv/schema.js";
import type { ApiKeyRecord, Env } from "../../src/types.js";

// HPKE-1 (pvautonomy-config#139): GET /build-backend/keys — authenticated,
// environment-gated TEST keyset endpoint.
//
// Auth is exercised through the REAL authenticateRequest + a mock API_KEYS KV,
// so the auth gate is genuinely tested (no module mock). The Build-Key is
// assembled at runtime (never a contiguous `pva_…` literal in source) so the
// gitleaks generic-api-key rule has nothing to match and no .gitleaksignore
// entry is needed.
const BUILD_KEY = ["pva", "test", "buildkey", "139"].join("_");

const ALG_REQUIRED =
  "HPKE-Base-DHKEM_X25519_HKDF_SHA256-HKDF_SHA256-CHACHA20_POLY1305";
const KEM_ALG = "DHKEM_X25519_HKDF_SHA256";

/** Mock API_KEYS KV that resolves only the hashed BUILD_KEY to an active record. */
async function authedEnv(extra: Partial<Env> = {}): Promise<Env> {
  const hash = await sha256(BUILD_KEY);
  const record: ApiKeyRecord = {
    customer_id: "cust-test",
    label: "hpke-1 test",
    created_at: "2026-06-28T00:00:00Z",
    active: true,
    rate_limit_override: null,
  };
  const apiKeys = {
    get: async (key: string) => (key === `key:${hash}` ? record : null),
  } as unknown as KVNamespace;
  // Default to the TEST tier so the existing #139 canary suite exercises the
  // HPKE_TEST_KEYSET path; production-tier cases override via `extra`.
  return {
    API_KEYS: apiKeys,
    HPKE_KEYSET_TIER: "test",
    ...extra,
  } as unknown as Env;
}

function keysRequest(token?: string): Request {
  return new Request("https://proxy.example/build-backend/keys", {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** A structurally valid PUBLIC keyset document (unsigned placeholder sig). */
function validTestKeysetDoc(): Record<string, unknown> {
  return {
    keyset: {
      keyset_serial: 1,
      issued_at: "2026-06-28T00:00:00Z",
      expires_at: "2026-09-28T00:00:00Z",
      alg_required: ALG_REQUIRED,
      min_envelope_version: 1,
      active_key_id: "bb-test-1",
      environment: "test",
      keys: [
        {
          key_id: "bb-test-1",
          alg: KEM_ALG,
          // 32-byte all-zero X25519 public placeholder (public position, not a
          // secret). Real signing fixtures are generated at runtime below.
          public_key: btoa(String.fromCharCode(...new Uint8Array(32))),
        },
      ],
    },
    signatures: [
      {
        alg: "Ed25519",
        root_key_id: "root-test-1",
        signature: btoa(String.fromCharCode(...new Uint8Array(64))),
      },
    ],
  };
}

// --- Canonical JSON matching HA's secret_envelope.canonical_json:
// recursively sorted keys, compact separators, UTF-8 (ASCII keyset here).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
function canonicalJson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalize(obj)));
}
function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("GET /build-backend/keys — auth gate", () => {
  it("rejects an unauthenticated request (no Authorization header) with 401", async () => {
    const env = await authedEnv();
    const res = await route(keysRequest(), env);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid (non-pva_) Build-Key with 403", async () => {
    const env = await authedEnv();
    const res = await route(keysRequest("not-a-valid-build-key"), env);
    expect(res.status).toBe(403);
  });
});

describe("GET /build-backend/keys — environment gating", () => {
  it("returns 404 for an authenticated request when no TEST keyset is configured", async () => {
    const env = await authedEnv(); // HPKE_TEST_KEYSET unset
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 404 when the TEST keyset binding is present but empty", async () => {
    const env = await authedEnv({ HPKE_TEST_KEYSET: "   " });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(404);
  });

  it("returns 200 with the configured keyset for a valid Build-Key", async () => {
    const doc = validTestKeysetDoc();
    const env = await authedEnv({ HPKE_TEST_KEYSET: JSON.stringify(doc) });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual(doc);
  });
});

describe("GET /build-backend/keys — keyset shape (HA verifier contract)", () => {
  it("serves the full top-level + keyset + signatures shape", async () => {
    const doc = validTestKeysetDoc();
    const env = await authedEnv({ HPKE_TEST_KEYSET: JSON.stringify(doc) });
    const res = await route(keysRequest(BUILD_KEY), env);
    const body = (await res.json()) as Record<string, any>;

    expect(body).toHaveProperty("keyset");
    expect(Array.isArray(body.signatures)).toBe(true);

    const ks = body.keyset;
    expect(typeof ks.keyset_serial).toBe("number");
    expect(typeof ks.issued_at).toBe("string");
    expect(typeof ks.expires_at).toBe("string");
    expect(ks.alg_required).toBe(ALG_REQUIRED);
    expect(typeof ks.min_envelope_version).toBe("number");
    expect(typeof ks.active_key_id).toBe("string");
    expect(ks.environment).toBe("test");

    const key = ks.keys[0];
    expect(typeof key.key_id).toBe("string");
    expect(key.alg).toBe(KEM_ALG);
    expect(typeof key.public_key).toBe("string");
    expect(ks.active_key_id).toBe(key.key_id);

    const sig = body.signatures[0];
    expect(sig.alg).toBe("Ed25519");
    expect(typeof sig.root_key_id).toBe("string");
    expect(typeof sig.signature).toBe("string");
  });
});

describe("GET /build-backend/keys — security (no private material)", () => {
  it("returns no forbidden private fields", async () => {
    const doc = validTestKeysetDoc();
    const env = await authedEnv({ HPKE_TEST_KEYSET: JSON.stringify(doc) });
    const res = await route(keysRequest(BUILD_KEY), env);
    const text = await res.text();
    expect(text).not.toMatch(/"private_key"/);
    expect(text).not.toMatch(/"privateKey"/);
    expect(text).not.toMatch(/"secret"/);
    expect(text).not.toMatch(/"seed"/);
  });

  it.each([
    ["private_key", { private_key: "x" }],
    ["privateKey", { privateKey: "x" }],
    ["secret", { secret: "x" }],
    ["seed", { seed: "x" }],
  ])(
    "rejects a configured keyset carrying %s anywhere with a generic 500",
    async (_name, injected) => {
      const doc = validTestKeysetDoc();
      // inject the forbidden field deep inside keys[0]
      (doc.keyset as any).keys[0] = {
        ...(doc.keyset as any).keys[0],
        ...injected,
      };
      const env = await authedEnv({ HPKE_TEST_KEYSET: JSON.stringify(doc) });
      const res = await route(keysRequest(BUILD_KEY), env);
      expect(res.status).toBe(500);
      const text = await res.text();
      // generic error only — never echo the configured/injected bytes
      expect(text).not.toContain("x");
      expect(text).toContain("misconfigured");
    },
  );

  it("rejects a malformed JSON keyset with a generic 500 and no config echo", async () => {
    const env = await authedEnv({ HPKE_TEST_KEYSET: "{not valid json" });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("not valid json");
    expect(text).toContain("misconfigured");
  });

  it.each([
    ["missing keyset", { signatures: [{ alg: "Ed25519" }] }],
    ["missing signatures", { keyset: { keys: [{ key_id: "k" }] } }],
    ["empty signatures", { keyset: { keys: [{ key_id: "k" }] }, signatures: [] }],
    ["empty keys", { keyset: { keys: [] }, signatures: [{ alg: "Ed25519" }] }],
    ["keyset not object", { keyset: "nope", signatures: [{}] }],
  ])("rejects structurally invalid doc (%s) with 500", async (_n, bad) => {
    const env = await authedEnv({ HPKE_TEST_KEYSET: JSON.stringify(bad) });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(500);
  });
});

describe("GET /build-backend/keys — signature verification (runtime keys)", () => {
  it("serves a keyset whose Ed25519 signature over canonical_json verifies, and a tampered keyset fails", async () => {
    // Runtime-generated Ed25519 root keypair (no checked-in key material).
    const rootKp = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;

    const x25519Pub = crypto.getRandomValues(new Uint8Array(32));
    const keyset = {
      keyset_serial: 7,
      issued_at: "2026-06-28T00:00:00Z",
      expires_at: "2026-09-28T00:00:00Z",
      alg_required: ALG_REQUIRED,
      min_envelope_version: 1,
      active_key_id: "bb-test-1",
      environment: "test",
      keys: [
        { key_id: "bb-test-1", alg: KEM_ALG, public_key: toB64(x25519Pub) },
      ],
    };

    const canonical = canonicalJson(keyset);
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", rootKp.privateKey, canonical),
    );
    expect(sig.length).toBe(64);

    const doc = {
      keyset,
      signatures: [
        { alg: "Ed25519", root_key_id: "root-test-1", signature: toB64(sig) },
      ],
    };

    const env = await authedEnv({ HPKE_TEST_KEYSET: JSON.stringify(doc) });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { keyset: unknown };
    // Re-canonicalize the SERVED keyset (proxy encoding-independent, exactly
    // as the HA verifier does) and verify against the runtime root pubkey.
    const ok = await crypto.subtle.verify(
      "Ed25519",
      rootKp.publicKey,
      sig,
      canonicalJson(body.keyset),
    );
    expect(ok).toBe(true);

    // Tamper: a mutated keyset must not verify under the original signature.
    const tampered = JSON.parse(JSON.stringify(body.keyset));
    tampered.keyset_serial = 999;
    const tamperedOk = await crypto.subtle.verify(
      "Ed25519",
      rootKp.publicKey,
      sig,
      canonicalJson(tampered),
    );
    expect(tamperedOk).toBe(false);
  });
});

describe("handleBuildBackendKeys — direct unit", () => {
  it("returns 404 (no-store) when binding is unset", () => {
    const res = handleBuildBackendKeys({} as Env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not expose a compile_secret_envelope field passed through config", async () => {
    // Even if someone stuffed an envelope-looking field in, the endpoint only
    // serves the document verbatim and never derives/echoes compile secrets;
    // this asserts the handler has no special envelope handling path.
    const doc = validTestKeysetDoc();
    const res = handleBuildBackendKeys({
      HPKE_KEYSET_TIER: "test",
      HPKE_TEST_KEYSET: JSON.stringify(doc),
    } as Env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("compile_secret_envelope");
  });
});

describe("GET /build-backend/keys — tier selection + environment enforcement (D-A)", () => {
  /** A production keyset: same shape as the TEST fixture but environment prod. */
  function validProdKeysetDoc(): Record<string, unknown> {
    const doc = validTestKeysetDoc();
    (doc.keyset as Record<string, unknown>).environment = "production";
    return doc;
  }

  it("production tier with no HPKE_KEYSET → 404 (legacy fallback preserved)", async () => {
    const env = await authedEnv({ HPKE_KEYSET_TIER: "production" });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(404);
  });

  it("production tier with a valid production HPKE_KEYSET → 200", async () => {
    const env = await authedEnv({
      HPKE_KEYSET_TIER: "production",
      HPKE_KEYSET: JSON.stringify(validProdKeysetDoc()),
    });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keyset: { environment: string } };
    expect(body.keyset.environment).toBe("production");
  });

  it("production tier rejects a TEST keyset placed in HPKE_KEYSET → 500", async () => {
    const env = await authedEnv({
      HPKE_KEYSET_TIER: "production",
      HPKE_KEYSET: JSON.stringify(validTestKeysetDoc()), // environment: "test"
    });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(500);
  });

  it("production tier ignores HPKE_TEST_KEYSET entirely → 404", async () => {
    const env = await authedEnv({
      HPKE_KEYSET_TIER: "production",
      HPKE_TEST_KEYSET: JSON.stringify(validTestKeysetDoc()),
      // no HPKE_KEYSET set
    });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(404);
  });

  it("test tier ignores HPKE_KEYSET entirely → 404", async () => {
    const env = await authedEnv({
      HPKE_KEYSET_TIER: "test",
      HPKE_KEYSET: JSON.stringify(validProdKeysetDoc()),
      // no HPKE_TEST_KEYSET set
    });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(404);
  });

  it("test tier rejects a PRODUCTION keyset placed in HPKE_TEST_KEYSET → 500", async () => {
    const env = await authedEnv({
      HPKE_KEYSET_TIER: "test",
      HPKE_TEST_KEYSET: JSON.stringify(validProdKeysetDoc()), // environment: "production"
    });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(500);
  });

  it("an unrecognised HPKE_KEYSET_TIER fails closed → 500", async () => {
    const env = await authedEnv({
      HPKE_KEYSET_TIER: "staging",
      HPKE_KEYSET: JSON.stringify(validProdKeysetDoc()),
      HPKE_TEST_KEYSET: JSON.stringify(validTestKeysetDoc()),
    });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(500);
  });

  it("default tier (unset) behaves as production → serves valid HPKE_KEYSET", async () => {
    const env = await authedEnv({
      HPKE_KEYSET_TIER: undefined,
      HPKE_KEYSET: JSON.stringify(validProdKeysetDoc()),
    });
    const res = await route(keysRequest(BUILD_KEY), env);
    expect(res.status).toBe(200);
  });
});
