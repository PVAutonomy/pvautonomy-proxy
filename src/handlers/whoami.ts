import type { ApiKeyRecord } from "../types.js";
import { jsonResponse } from "../errors.js";

/**
 * GET /whoami — authenticated. Returns the customer_id derived from the
 * authenticated API key, so a fresh account-free setup (no pre-existing
 * config entry to inherit from) can resolve its customer_id without the
 * operator typing it. See pvautonomy-config issue #96.
 *
 * Security:
 * - customer_id comes ONLY from the server-side authenticated key record
 *   (ApiKeyRecord resolved by authenticateRequest); it is never taken from
 *   client query/body/header, so it cannot be spoofed.
 * - The response carries only the non-sensitive customer_id — never the API
 *   key, token, hashes, KV names, or other account/build internals.
 */
export function handleWhoami(customer: ApiKeyRecord): Response {
  return jsonResponse({ customer_id: customer.customer_id });
}
