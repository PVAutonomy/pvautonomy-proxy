import { dailyRateKey, RATE_LIMIT_TTL } from "../kv/schema.js";

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
}

/** Check and increment per-customer daily build counter. */
export async function checkRateLimit(
  kv: KVNamespace,
  customerId: string,
  maxPerDay: number,
): Promise<RateLimitResult> {
  const key = dailyRateKey(customerId);
  const currentStr = await kv.get(key);
  const current = currentStr ? parseInt(currentStr, 10) : 0;

  if (current >= maxPerDay) {
    return { allowed: false, current, limit: maxPerDay };
  }

  await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_TTL });
  return { allowed: true, current: current + 1, limit: maxPerDay };
}
