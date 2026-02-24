import { activeBuildKey, CONCURRENCY_LOCK_TTL } from "../kv/schema.js";

export interface LockResult {
  acquired: boolean;
  existingBuildId?: string;
}

/**
 * Acquire a per-customer concurrency lock.
 * Only one active build per customer_id at a time.
 * Lock auto-expires after 30 min as a safety net.
 */
export async function acquireBuildLock(
  kv: KVNamespace,
  customerId: string,
  buildId: string,
): Promise<LockResult> {
  const key = activeBuildKey(customerId);

  const existing = await kv.get(key);
  if (existing) {
    return { acquired: false, existingBuildId: existing };
  }

  await kv.put(key, buildId, { expirationTtl: CONCURRENCY_LOCK_TTL });
  return { acquired: true };
}

/** Release lock if it is still held by this build. */
export async function releaseBuildLock(
  kv: KVNamespace,
  customerId: string,
  buildId: string,
): Promise<void> {
  const key = activeBuildKey(customerId);
  const current = await kv.get(key);
  if (current === buildId) {
    await kv.delete(key);
  }
}
