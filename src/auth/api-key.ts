import type { ApiKeyRecord, Env } from "../types.js";
import { sha256 } from "../kv/schema.js";

/**
 * Validate a Bearer token against hashed keys in KV.
 * Returns the ApiKeyRecord if valid, or null.
 */
export async function validateApiKey(
  kv: KVNamespace,
  bearerToken: string,
): Promise<ApiKeyRecord | null> {
  if (!bearerToken.startsWith("pva_")) {
    return null;
  }

  const hashHex = await sha256(bearerToken);
  const record = await kv.get<ApiKeyRecord>(`key:${hashHex}`, "json");
  if (!record || !record.active) {
    return null;
  }

  return record;
}

/**
 * Extract API key from request and validate.
 * Returns the customer record or a 401/403 error string.
 */
export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<{ customer: ApiKeyRecord } | { error: string; status: number }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "Missing Authorization: Bearer <token>", status: 401 };
  }

  const token = authHeader.slice(7);
  const customer = await validateApiKey(env.API_KEYS, token);
  if (!customer) {
    return { error: "Invalid or inactive API key", status: 403 };
  }

  return { customer };
}
