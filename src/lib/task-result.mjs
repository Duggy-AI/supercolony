import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from '../shared.mjs';

export const DEFAULT_INTERVAL_SECONDS = 5;
export const DEFAULT_TIMEOUT_SECONDS = 600;

const RESULT_HTTP_TIMEOUT_MS = 30_000;
const ARTIFACT_HTTP_TIMEOUT_MS = 120_000;

// Local evidence: `/jobs/:id/result` returns blocked and cancelled with
// complete:false. Other states stay unknown and keep polling to the timeout.
const FAILED_STATES = new Set(['blocked', 'cancelled']);

export function positiveSeconds(value, label) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${label} must be a positive number of seconds`);
  }
  return seconds;
}

function assertResult(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('result response is not an object');
  }
  if (typeof data.jobId !== 'string' || data.jobId === '') {
    throw new Error('result response is missing jobId');
  }
  if (typeof data.state !== 'string' || data.state === '') {
    throw new Error('result response is missing state');
  }
}

export async function waitForResult({
  api,
  id,
  interval = DEFAULT_INTERVAL_SECONDS,
  timeout = DEFAULT_TIMEOUT_SECONDS,
  onProgress = () => {},
}) {
  const intervalMs = Math.max(1, Math.round(positiveSeconds(interval, '--interval') * 1000));
  const timeoutSeconds = positiveSeconds(timeout, '--timeout');
  const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000));
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  const interrupted = new AbortController();
  const expired = new AbortController();
  const deadlineTimer = setTimeout(() => expired.abort(), timeoutMs);
  const signal = AbortSignal.any([interrupted.signal, expired.signal]);
  const onSigint = () => interrupted.abort();
  process.once('SIGINT', onSigint);

  let last = null;
  let attempts = 0;

  const timedOut = () => ({
    outcome: 'timeout',
    result: last,
    message: `timed out after ${timeoutSeconds}s; last state: ${last?.state ?? 'no response'}`,
  });

  try {
    while (true) {
      if (expired.signal.aborted) return timedOut();
      attempts += 1;
      try {
        const response = await request(api, `/jobs/${encodeURIComponent(id)}/result`, {
          signal,
          onRetry: ({ error, retries, delayMs }) => onProgress({
            type: 'retry', status: error.status, attempt: attempts, retries, delayMs,
            elapsedMs: Date.now() - startedAt,
          }),
        });
        const data = response.data;
        assertResult(data);
        last = data;
        onProgress({
          type: 'poll',
          attempt: attempts,
          state: data.state,
          complete: data.complete === true,
          elapsedMs: Date.now() - startedAt,
        });

        if (data.complete === true && data.state === 'completed') {
          return { outcome: 'completed', result: data };
        }
        if (FAILED_STATES.has(data.state)) {
          return {
            outcome: 'failed',
            result: data,
            message: `job ${data.jobId} ended in state ${data.state}`,
          };
        }
      } catch (error) {
        if (interrupted.signal.aborted) return { outcome: 'interrupted', result: last };
        if (expired.signal.aborted) return timedOut();

        throw error;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return timedOut();
      await sleep(Math.min(intervalMs, remaining), undefined, { signal });
    }
  } catch (error) {
    if (interrupted.signal.aborted) return { outcome: 'interrupted', result: last };
    if (expired.signal.aborted) return timedOut();
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    process.removeListener('SIGINT', onSigint);
  }
}

function artifactComponents(raw) {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error('result file is missing path');
  }
  if (raw.includes('\0')) throw new Error(`unsafe artifact path ${JSON.stringify(raw)}: NUL byte`);
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    throw new Error(`unsafe artifact path ${raw}: absolute paths are not allowed`);
  }
  if (raw.includes(':')) {
    throw new Error(`unsafe artifact path ${raw}: Windows drives and alternate data streams are not allowed`);
  }

  const parts = raw.split(/[\\/]/);
  for (const part of parts) {
    if (part === '') throw new Error(`unsafe artifact path ${raw}: empty segment`);
    if (part === '.' || part === '..') {
      throw new Error(`unsafe artifact path ${raw}: relative segments are not allowed`);
    }
    if (/[ .]$/.test(part)) {
      throw new Error(`unsafe artifact path ${raw}: Windows trailing space or dot`);
    }
    const base = part.split('.')[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)$/.test(base)) {
      throw new Error(`unsafe artifact path ${raw}: Windows device name`);
    }
  }
  return parts;
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function artifactHash(value, path) {
  const hash = String(value ?? '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`artifact ${path} has an invalid SHA-256 hash`);
  }
  return hash;
}

function artifactBytes(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`artifact ${path} has invalid bytes`);
  }
  return value;
}

function artifactUrl(value, path) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`artifact ${path} has an invalid download URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`artifact ${path} has an unsupported download URL`);
  }
  return url;
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoSymlinkParents(root, target) {
  const parent = dirname(target);
  const rel = relative(root, parent);
  if (rel === '') return;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`unsafe artifact path ${target}: escapes --out`);
  }

  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstatOrNull(current);
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw new Error(`unsafe artifact path ${target}: symlink parent ${current}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`unsafe artifact path ${target}: parent ${current} is not a directory`);
    }
  }
}

export async function downloadTaskFiles({ api, id, out, onProgress = () => {}, signal }) {
  const networkSignal = (ms) => {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };
  const response = await request(api, `/jobs/${encodeURIComponent(id)}/result`, {
    signal: networkSignal(RESULT_HTTP_TIMEOUT_MS),
  });
  const result = response.data;
  assertResult(result);
  if (result.complete !== true || result.state !== 'completed') {
    throw new Error(
      `job ${result.jobId} is not complete (state: ${result.state}, complete: ${result.complete === true})`,
    );
  }
  if (!Array.isArray(result.files)) {
    throw new Error('result response is missing files');
  }

  if ((await lstatOrNull(out))?.isSymbolicLink()) {
    throw new Error(`refusing --out symlink: ${out}`);
  }
  await mkdir(out, { recursive: true });
  const root = await realpath(out);
  const prepared = [];
  const seen = new Set();

  for (const file of result.files) {
    if (!file || typeof file !== 'object') throw new Error('result contains an invalid file');
    const target = join(root, ...artifactComponents(file.path));
    const key = process.platform === 'win32' || process.platform === 'darwin'
      ? target.toLowerCase()
      : target;
    if (seen.has(key)) throw new Error(`duplicate target path in result: ${file.path}`);
    seen.add(key);

    if (!inside(root, target)) {
      throw new Error(`unsafe artifact path ${file.path}: escapes --out`);
    }
    const hash = artifactHash(file.hash, file.path);
    const bytes = artifactBytes(file.bytes, file.path);
    const url = artifactUrl(file.url, file.path);

    if (await lstatOrNull(target)) {
      throw new Error(`refusing to overwrite existing file: ${target}`);
    }
    await assertNoSymlinkParents(root, target);

    prepared.push({ source: file, target, hash, bytes, url });
  }

  const temps = new Set();
  const saved = [];
  try {
    for (const item of prepared) {
      signal?.throwIfAborted();
      await mkdir(dirname(item.target), { recursive: true });
      await assertNoSymlinkParents(root, item.target);
      if (await lstatOrNull(item.target)) {
        throw new Error(`refusing to overwrite existing file: ${item.target}`);
      }

      const temp = join(
        dirname(item.target),
        `.${basename(item.target)}.${randomBytes(8).toString('hex')}.tmp`,
      );
      temps.add(temp);

      const artifact = await fetch(item.url, {
        headers: { 'accept-encoding': 'identity' },
        signal: networkSignal(ARTIFACT_HTTP_TIMEOUT_MS),
      });
      if (!artifact.ok) {
        const detail = (await artifact.text()).slice(0, 300);
        throw new Error(`HTTP ${artifact.status} downloading ${item.source.path}${detail ? `: ${detail}` : ''}`);
      }

      let bytes = 0;
      const hash = createHash('sha256');
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > item.bytes) {
            callback(new Error(`bytes mismatch for ${item.source.path}: expected ${item.bytes}, got more`));
            return;
          }
          hash.update(buffer);
          callback(null, buffer);
        },
      });
      const source = artifact.body ? Readable.fromWeb(artifact.body) : Readable.from([]);
      await pipeline(source, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });

      const size = (await stat(temp)).size;
      if (bytes !== item.bytes || size !== item.bytes) {
        throw new Error(`bytes mismatch for ${item.source.path}: expected ${item.bytes}, got ${size}`);
      }
      const actual = hash.digest('hex');
      if (actual !== item.hash) {
        throw new Error(`hash mismatch for ${item.source.path}: expected ${item.hash}, got ${actual}`);
      }

      try {
        await link(temp, item.target);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new Error(`refusing to overwrite existing file: ${item.target}`);
        }
        throw error;
      }
      saved.push({
        path: item.source.path,
        file: item.target,
        hash: item.hash,
        bytes: item.bytes,
        mediaType: item.source.mediaType ?? null,
      });
      await unlink(temp);
      temps.delete(temp);
      onProgress({
        type: 'saved',
        path: item.source.path,
        file: item.target,
        hash: item.hash,
        bytes: item.bytes,
      });
    }
  } catch (error) {
    for (const temp of temps) await unlink(temp).catch(() => {});
    if (saved.length > 0) {
      error.message = `${error.message}; already saved: ${saved.map((item) => item.file).join(', ')}`;
    }
    throw error;
  }

  return {
    jobId: result.jobId,
    state: result.state,
    complete: result.complete,
    files: saved,
  };
}
