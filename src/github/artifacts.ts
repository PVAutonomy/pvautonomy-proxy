import type { ArtifactInfo, BuildRecord, Env } from "../types.js";

const USER_AGENT = "pvautonomy-proxy/0.1.0";

/**
 * Resolve firmware artifacts from GitHub workflow artifacts API.
 *
 * Strategy: fetch the workflow run's artifacts list, find manifest.json,
 * download and parse it for firmware URL + SHA-256.
 *
 * Falls back to release assets if workflow artifacts are unavailable.
 */
export async function resolveArtifacts(
  env: Env,
  record: BuildRecord,
): Promise<ArtifactInfo | null> {
  if (!record.github_run_id) return null;

  // Try workflow artifacts first
  const fromWorkflow = await resolveFromWorkflowArtifacts(env, record.github_run_id);
  if (fromWorkflow) return fromWorkflow;

  // Fallback: try release assets
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

  // Find the firmware artifact (workflow should upload a single artifact
  // containing manifest.json + firmware.ota.bin)
  const fwArtifact = data.artifacts.find(
    (a) => a.name === "firmware" || a.name.includes("firmware"),
  );
  if (!fwArtifact) return null;

  // The archive_download_url returns a zip; for MVP we return a proxy URL
  // that the customer integration can use to download via the proxy.
  // The actual download/extraction will be handled by the integration (D1).
  return {
    manifest_url: fwArtifact.archive_download_url,
    firmware_url: fwArtifact.archive_download_url,
    sha256: "", // Will be populated from manifest.json by the integration
    size_bytes: fwArtifact.size_in_bytes,
  };
}

async function resolveFromReleaseAssets(
  env: Env,
  record: BuildRecord,
): Promise<ArtifactInfo | null> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases?per_page=5`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) return null;

  const releases = (await response.json()) as Array<{
    tag_name: string;
    created_at: string;
    assets: Array<{
      name: string;
      browser_download_url: string;
      size: number;
    }>;
  }>;

  // Find release matching this build (by device_name in tag and timing)
  const buildTime = new Date(record.created_at).getTime();
  for (const release of releases) {
    const releaseTime = new Date(release.created_at).getTime();
    if (releaseTime < buildTime) continue;

    const manifest = release.assets.find(
      (a) => a.name === "manifest.json" || a.name.endsWith("-manifest.json"),
    );
    const firmware = release.assets.find((a) => a.name.endsWith(".ota.bin"));

    if (manifest && firmware) {
      // Fetch manifest for sha256
      const manifestResp = await fetch(manifest.browser_download_url, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (manifestResp.ok) {
        const manifestData = (await manifestResp.json()) as {
          sha256?: string;
          size_bytes?: number;
        };
        return {
          manifest_url: manifest.browser_download_url,
          firmware_url: firmware.browser_download_url,
          sha256: manifestData.sha256 ?? "",
          size_bytes: manifestData.size_bytes ?? firmware.size,
        };
      }
    }
  }

  return null;
}
