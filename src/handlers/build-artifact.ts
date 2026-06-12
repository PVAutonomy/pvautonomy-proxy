import type { BuildRecord, Env } from "../types.js";
import { jsonError } from "../errors.js";
import { buildKey } from "../kv/schema.js";
import { streamReleaseAsset, type ArtifactName } from "../github/artifacts.js";

/** Artifact names the proxy is allowed to serve. */
const ALLOWED_ARTIFACTS = new Set<ArtifactName>([
  "firmware.ota.bin",
  "manifest.json",
]);

function isAllowedArtifact(name: string): name is ArtifactName {
  return ALLOWED_ARTIFACTS.has(name as ArtifactName);
}

/**
 * GET /build/:id/artifact/:name
 *
 * Streams a build artifact (firmware.ota.bin or manifest.json) from the
 * private GitHub Release through the proxy using the GitHub App
 * installation token. HA calls this
 * after a successful build to fetch the firmware for OTA install.
 */
export async function handleBuildArtifact(
  env: Env,
  buildId: string,
  name: string,
): Promise<Response> {
  const record = await env.BUILD_STATE.get<BuildRecord>(
    buildKey(buildId),
    "json",
  );

  if (!record) {
    return jsonError(404, `Build not found: ${buildId}`);
  }

  if (record.status !== "success") {
    return jsonError(
      409,
      `Build not ready: status=${record.status}`,
    );
  }

  if (!record.artifact || !isAllowedArtifact(name)) {
    return jsonError(404, `Artifact not available: ${name}`);
  }

  const streamed = await streamReleaseAsset(env, record, name);
  if (!streamed) {
    return jsonError(404, `Artifact asset not found: ${name}`);
  }

  return streamed;
}
