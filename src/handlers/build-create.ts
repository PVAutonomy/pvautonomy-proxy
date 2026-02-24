import type { ApiKeyRecord, BuildRecord, BuildRequest, Env } from "../types.js";
import { jsonError, jsonResponse } from "../errors.js";
import { buildKey, BUILD_RECORD_TTL, runLookupKey, RUN_LOOKUP_TTL, sha256 } from "../kv/schema.js";
import { validateBuildRequest } from "../guards/validation.js";
import { checkRateLimit } from "../guards/rate-limit.js";
import { acquireBuildLock, releaseBuildLock } from "../guards/concurrency.js";
import { triggerWorkflowDispatch } from "../github/dispatch.js";

/** POST /build — validate, guard, dispatch, persist. */
export async function handleBuildCreate(
  request: Request,
  env: Env,
  customer: ApiKeyRecord,
): Promise<Response> {
  // 1. Parse body with size limit
  const maxBytes = parseInt(env.MAX_PAYLOAD_BYTES);
  const body = await request.text();
  if (body.length > maxBytes) {
    return jsonError(413, `Payload exceeds ${maxBytes} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  // 2. Validate schema
  const validationErr = validateBuildRequest(parsed);
  if (validationErr) {
    return jsonError(400, validationErr);
  }
  const req = parsed as BuildRequest;

  // 3. Verify customer_id matches API key
  if (req.customer_id !== customer.customer_id) {
    return jsonError(403, "customer_id does not match API key");
  }

  // 4. Rate limit
  const maxPerDay = customer.rate_limit_override ?? parseInt(env.MAX_BUILDS_PER_DAY);
  const rateCheck = await checkRateLimit(env.BUILD_STATE, customer.customer_id, maxPerDay);
  if (!rateCheck.allowed) {
    return jsonError(
      429,
      `Daily build limit exceeded (${rateCheck.current}/${rateCheck.limit})`,
    );
  }

  // 5. Concurrency lock
  const buildId = crypto.randomUUID();
  const lock = await acquireBuildLock(env.BUILD_STATE, customer.customer_id, buildId);
  if (!lock.acquired) {
    return jsonError(409, `Build already in progress: ${lock.existingBuildId}`);
  }

  // 6. Create build record
  const now = new Date().toISOString();
  const record: BuildRecord = {
    build_id: buildId,
    customer_id: customer.customer_id,
    device_key: req.device_key,
    model: req.model,
    build_profile: req.build_profile,
    status: "queued",
    github_run_id: null,
    github_run_url: null,
    progress: 0,
    created_at: now,
    updated_at: now,
    completed_at: null,
    artifact: null,
    error: null,
    payload_hash: await sha256(body),
    payload: req.payload,
  };

  // 7. Dispatch to GitHub Actions
  try {
    const dispatch = await triggerWorkflowDispatch(env, buildId, req.payload);
    record.status = "dispatched";
    record.github_run_id = dispatch.run_id;
    record.github_run_url = dispatch.run_url;
    record.progress = 5;
    record.updated_at = new Date().toISOString();

    // Reverse lookup: run_id → build_id
    await env.BUILD_STATE.put(
      runLookupKey(dispatch.run_id),
      buildId,
      { expirationTtl: RUN_LOOKUP_TTL },
    );
  } catch (err) {
    // Dispatch failed — release lock, mark failed
    record.status = "failed";
    record.error = `Dispatch failed: ${(err as Error).message}`;
    record.completed_at = new Date().toISOString();
    await releaseBuildLock(env.BUILD_STATE, customer.customer_id, buildId);
  }

  // 8. Persist build record
  await env.BUILD_STATE.put(buildKey(buildId), JSON.stringify(record), {
    expirationTtl: BUILD_RECORD_TTL,
  });

  // 9. Response
  const status = record.status === "failed" ? 502 : 201;
  return jsonResponse(
    {
      build_id: buildId,
      status: record.status,
      ...(record.github_run_url ? { run_url: record.github_run_url } : {}),
      ...(record.error ? { error: record.error } : {}),
    },
    status,
  );
}
