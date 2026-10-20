import { retryQuery } from '../lib/query-retry.mjs';

export const WORKER_REPOSITORY = 'Identity-md/worker';
export const WORKER_ASSET = 'identitymd-worker.tgz';
export const WORKER_SUMS_ASSET = 'SHA256SUMS';

function githubHeaders() {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'colony-worker-cli',
    'x-github-api-version': '2022-11-28',
  };
}

async function fetchJson(url, { fetchImpl = fetch, allow404 = false } = {}) {
  return retryQuery(async () => {
    const response = await fetchImpl(url, { headers: githubHeaders(), redirect: 'follow' });
    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw Object.assign(new Error(`GitHub release request failed: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`), { status: response.status });
    }
    return response.json();
  });
}

export function parseReleaseMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('release metadata is empty');
  }
  const tag = metadata.tag_name;
  if (typeof tag !== 'string' || !tag.startsWith('worker-v')) {
    throw new Error(`release metadata has an unexpected tag: ${JSON.stringify(tag)}`);
  }
  if (metadata.draft === true) throw new Error(`release ${tag} is a draft`);
  const assets = Array.isArray(metadata.assets) ? metadata.assets : [];
  const tgz = assets.find((asset) => asset?.name === WORKER_ASSET);
  const sums = assets.find((asset) => asset?.name === WORKER_SUMS_ASSET);
  if (!tgz?.browser_download_url || !sums?.browser_download_url) {
    throw new Error(`release ${tag} is missing ${WORKER_ASSET} or ${WORKER_SUMS_ASSET}`);
  }
  for (const asset of [tgz, sums]) {
    if (!/^https:\/\//.test(asset.browser_download_url)) {
      throw new Error(`release ${tag} has a non-HTTPS asset URL`);
    }
  }
  return {
    tag,
    name: metadata.name ?? tag,
    htmlUrl: metadata.html_url ?? null,
    publishedAt: metadata.published_at ?? null,
    version: tag.slice('worker-v'.length),
    tgzUrl: tgz.browser_download_url,
    sumsUrl: sums.browser_download_url,
    tgzSize: tgz.size ?? null,
    assetDigest: typeof tgz.digest === 'string' ? tgz.digest.replace(/^sha256:/i, '').toLowerCase() : null,
  };
}

function versionCandidates(version) {
  const text = String(version).trim();
  if (!text) return [];
  if (text.startsWith('worker-v')) return [text];
  const normalized = /^v[0-9]/.test(text) ? text.slice(1) : text;
  return [text, `worker-v${normalized}`];
}

function releaseMatches(release, version) {
  const tag = String(release?.tag_name ?? '');
  if (!tag.startsWith('worker-v')) return false;
  const text = String(version).trim();
  if (tag === text) return true;
  const suffix = tag.slice('worker-v'.length);
  const normalized = text.replace(/^v/, '');
  return suffix === normalized || suffix.startsWith(`${normalized}-`) || String(release?.name ?? '').includes(text);
}

/**
 * Resolve a release to a fixed, immutable tag before any asset is downloaded.
 * `latest` is only used to look up metadata; downloads always use that tag's
 * own asset URLs, never `releases/latest/download`.
 */
export async function resolveRelease({ version, fetchImpl = fetch } = {}) {
  const base = `https://api.github.com/repos/${WORKER_REPOSITORY}`;
  if (!version || version === 'latest') {
    const metadata = await fetchJson(`${base}/releases/latest`, { fetchImpl });
    return parseReleaseMetadata(metadata);
  }

  for (const candidate of versionCandidates(version)) {
    const metadata = await fetchJson(`${base}/releases/tags/${encodeURIComponent(candidate)}`, {
      fetchImpl,
      allow404: true,
    });
    if (metadata) return parseReleaseMetadata(metadata);
  }

  const releases = await fetchJson(`${base}/releases?per_page=100`, { fetchImpl });
  if (!Array.isArray(releases)) throw new Error('GitHub releases response is not an array');
  const match = releases.find((release) => !release.draft && releaseMatches(release, version));
  if (!match) {
    throw new Error(`no worker release matches version/tag ${JSON.stringify(version)}`);
  }
  return parseReleaseMetadata(match);
}

export function parseSha256Sums(text) {
  const entries = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+[* ]?(.+)$/.exec(line);
    if (!match) continue;
    const name = match[2].trim().replace(/^\.\//, '');
    entries.set(name, match[1].toLowerCase());
  }
  return entries;
}

export function selectSum(sumsText, filename) {
  const entries = parseSha256Sums(sumsText);
  const direct = entries.get(filename);
  if (direct) return direct;
  for (const [name, hash] of entries) {
    if (name.endsWith(`/${filename}`)) return hash;
  }
  throw new Error(`SHA256SUMS has no entry for ${filename}; refusing to install`);
}
