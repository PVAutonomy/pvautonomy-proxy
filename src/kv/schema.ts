/** TTL constants (seconds). */
export const BUILD_RECORD_TTL = 86_400; // 24 hours
export const CONCURRENCY_LOCK_TTL = 1_800; // 30 minutes (safety net)
export const RATE_LIMIT_TTL = 90_000; // 25 hours
export const RUN_LOOKUP_TTL = 86_400; // 24 hours

/** KV key builders. */
export function buildKey(buildId: string): string {
  return `build:${buildId}`;
}

export function activeBuildKey(customerId: string): string {
  return `customer:${customerId}:active`;
}

export function dailyRateKey(customerId: string): string {
  const today = new Date().toISOString().split("T")[0];
  return `customer:${customerId}:daily:${today}`;
}

export function runLookupKey(runId: number): string {
  return `run:${runId}`;
}

/** Compute SHA-256 hex digest. */
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
