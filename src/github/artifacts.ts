import type { ArtifactInfo, BuildRecord, Env } from "../types.js";

const USER_AGENT = "pvautonomy-proxy/0.1.0";

/**
 * Resolve firmware artifacts after a successful build.
 *
 * Strategy: find the GitHub Release matching the device_name, download
 * the ESPHome manifest.json for firmware path + md5, return URLs.
 */
export async function resolveArtifacts(
  env: Env,
  record: BuildRecord,
): Promise<ArtifactInfo | null> {
  if (!record.github_run_id) return null;

  // Try workflow artifacts first (workflow doesn't upload them, but check anyway)
  const fromWorkflow = await resolveFromWorkflowArtifacts(env, record.github_run_id);
  if (fromWorkflow) return fromWorkflow;

  // Resolve from release assets
  return resolveFromReleaseAssets(env, record);
}

async function resolveFromWorkflowArtifacts(
  env: Env,
  runId: number,
): Promise<ArtifactInfo | null> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${runId}/artifacts`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    // ISSUE-6 follow-up: silent nulls made resolution failures
    // undiagnosable — say WHY (visible in Workers Logs).
    console.warn(
      `[artifacts] workflow-artifacts list for run ${runId} failed: ` +
        `HTTP ${response.status}`,
    );
    return null;
  }

  const data = (await response.json()) as {
    artifacts: Array<{
      name: string;
      archive_download_url: string;
      size_in_bytes: number;
    }>;
  };

  const fwArtifact = data.artifacts.find(
    (a) => a.name === "firmware" || a.name.includes("firmware"),
  );
  // No warn here: the build workflow publishes release assets, not workflow
  // artifacts, so "none found" is the expected path, not a failure.
  if (!fwArtifact) return null;

  return {
    manifest_url: fwArtifact.archive_download_url,
    firmware_url: fwArtifact.archive_download_url,
    sha256: "",
    size_bytes: fwArtifact.size_in_bytes,
  };
}

/** GitHub release asset shape (subset). */
interface ReleaseAsset {
  name: string;
  url: string; // API URL (use with Accept: application/octet-stream)
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  published_at: string;
  assets: ReleaseAsset[];
}

/** ESPHome manifest.json shape. */
interface ESPHomeManifest {
  name?: string;
  version?: string;
  builds?: Array<{
    chipFamily?: string;
    ota?: {
      path?: string;
      md5?: string;
      sha256?: string;
      size_bytes?: number;
    };
  }>;
}

async function resolveFromReleaseAssets(
  env: Env,
  record: BuildRecord,
): Promise<ArtifactInfo | null> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases?per_page=10`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    console.warn(
      `[artifacts] release list for build ${record.build_id} failed: ` +
        `HTTP ${response.status}`,
    );
    return null;
  }

  const releases = (await response.json()) as Release[];

  const deviceName = record.payload?.device_name ?? "";

  // Find the newest release matching device_name in tag.
  // The workflow may update an existing release rather than creating a new one,
  // so we match by tag pattern only (no timing constraint).
  // GitHub returns releases newest-first, so first match is correct.
  for (const release of releases) {
    if (deviceName && !release.tag_name.startsWith(deviceName)) continue;

    const manifest = release.assets.find(
      (a) => a.name === "manifest.json" || a.name.endsWith("-manifest.json"),
    );
    const firmware = release.assets.find((a) => a.name.endsWith(".ota.bin"));

    if (manifest && firmware) {
      // Fetch manifest via API URL (required for private repos)
      const manifestData = await fetchAssetJson<ESPHomeManifest>(env, manifest.url);
      if (manifestData) {
        const otaBuild = manifestData.builds?.[0]?.ota;
        return {
          manifest_url: manifest.browser_download_url,
          firmware_url: firmware.browser_download_url,
          sha256: otaBuild?.sha256 ?? otaBuild?.md5 ?? "",
          size_bytes: otaBuild?.size_bytes ?? firmware.size,
        };
      }

      // Manifest fetch failed — return URLs without hash
      console.warn(
        `[artifacts] build ${record.build_id}: manifest.json fetch failed ` +
          `for release ${release.tag_name} — returning URLs without sha256`,
      );
      return {
        manifest_url: manifest.browser_download_url,
        firmware_url: firmware.browser_download_url,
        sha256: "",
        size_bytes: firmware.size,
      };
    }
  }

  console.warn(
    `[artifacts] build ${record.build_id}: no release with manifest+firmware ` +
      `assets matching device "${deviceName}" among ${releases.length} ` +
      `releases (eventual-consistency lag or wrong tag?)`,
  );
  return null;
}

/** Canonical artifact names exposed via GET /build/:id/artifact/:name. */
export type ArtifactName = "firmware.ota.bin" | "manifest.json";

/** Match a release asset by canonical artifact name. */
function matchReleaseAsset(
  assets: ReleaseAsset[],
  name: ArtifactName,
): ReleaseAsset | undefined {
  if (name === "firmware.ota.bin") {
    return assets.find((a) => a.name.endsWith(".ota.bin"));
  }
  // manifest.json
  return assets.find(
    (a) => a.name === "manifest.json" || a.name.endsWith("-manifest.json"),
  );
}

/**
 * Locate the GitHub API asset URL for a canonical artifact name.
 *
 * The browser_download_url stored in ArtifactInfo is unusable for private
 * repos (anonymous access → 404), so we re-resolve the release and return the
 * asset's API `url`, which streams the bytes when fetched with the PAT and
 * `Accept: application/octet-stream`.
 */
async function findReleaseAssetApiUrl(
  env: Env,
  record: BuildRecord,
  name: ArtifactName,
): Promise<ReleaseAsset | null> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases?per_page=10`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) return null;

  const releases = (await response.json()) as Release[];
  const deviceName = record.payload?.device_name ?? "";

  for (const release of releases) {
    if (deviceName && !release.tag_name.startsWith(deviceName)) continue;
    const asset = matchReleaseAsset(release.assets, name);
    if (asset) return asset;
  }

  return null;
}

/**
 * Stream a private GitHub Release asset through the proxy using GITHUB_PAT.
 *
 * Returns a streaming Response (200) on success, or null when the asset cannot
 * be located or the upstream fetch fails. Never returns browser_download_url
 * content anonymously — the bytes are always pulled with the PAT.
 */
export async function streamReleaseAsset(
  env: Env,
  record: BuildRecord,
  name: ArtifactName,
): Promise<Response | null> {
  const asset = await findReleaseAssetApiUrl(env, record, name);
  if (!asset) return null;

  const upstream = await fetch(asset.url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });

  if (!upstream.ok || !upstream.body) return null;

  const headers = new Headers();
  headers.set(
    "Content-Type",
    name === "manifest.json" ? "application/json" : "application/octet-stream",
  );
  // Prefer the upstream length; fall back to the asset metadata size.
  const upstreamLen = upstream.headers.get("Content-Length");
  if (upstreamLen) {
    headers.set("Content-Length", upstreamLen);
  } else if (asset.size > 0) {
    headers.set("Content-Length", String(asset.size));
  }
  headers.set("Content-Disposition", `attachment; filename="${name}"`);

  return new Response(upstream.body, { status: 200, headers });
}

/** Fetch a release asset as JSON via the GitHub API (handles private repos). */
async function fetchAssetJson<T>(env: Env, apiUrl: string): Promise<T | null> {
  const response = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    console.warn(
      `[artifacts] asset fetch ${apiUrl} failed: HTTP ${response.status}`,
    );
    return null;
  }

  try {
    return (await response.json()) as T;
  } catch {
    console.warn(`[artifacts] asset ${apiUrl} is not parseable JSON`);
    return null;
  }
}
