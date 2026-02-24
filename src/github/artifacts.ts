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

  if (!response.ok) return null;

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

  if (!response.ok) return null;

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
      return {
        manifest_url: manifest.browser_download_url,
        firmware_url: firmware.browser_download_url,
        sha256: "",
        size_bytes: firmware.size,
      };
    }
  }

  return null;
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

  if (!response.ok) return null;

  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
