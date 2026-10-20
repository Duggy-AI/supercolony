import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const REQUEST_TIMEOUT_MS = 15_000;
// Guards a single network read only: a slow disk or a slow onProgress
// callback can never be mistaken for a stalled connection.
const IDLE_TIMEOUT_MS = 15_000;

function failure(message, { cause, network = false } = {}) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.network = network;
  return error;
}

// One short line naming the underlying cause, e.g.
// `request failed: ECONNRESET (Client network socket disconnected ...)`.
function describe(error) {
  const cause = error?.cause;
  const code = cause?.code ?? error?.code;
  if (!code && !cause?.message) return error?.message ?? String(error);
  return `${error.message} [${[code, cause?.message].filter(Boolean).join(' ')}]`;
}

// Failures that another download host could plausibly fix. Everything else
// (checksum, size, disk, permissions, cleanup) fails loudly without switching.
async function downloadFrom(options) {
  const { url, directory, fileName, size, onProgress, requestTimeoutMs, idleTimeoutMs } = options;
  const target = join(directory, fileName);
  const temp = join(directory, `.${fileName}.${randomUUID()}.part`);
  const controller = new AbortController();
  let requestTimer;
  let idleTimer;
  let file;
  let moved = false;

  const clearIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  try {
    let response;
    requestTimer = setTimeout(
      () => controller.abort(new Error('request timed out')),
      requestTimeoutMs,
    );
    try {
      response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    } catch (error) {
      // `fetch failed` hides the socket reason one level down; surface it once
      // here instead of walking the cause chain later.
      const reason = error.cause?.code ?? error.cause?.message;
      throw failure(`request failed: ${error.message}${reason ? ` (${reason})` : ''}`, {
        network: true,
      });
    }
    // Headers are in; from here only the per-read idle timer babysits the socket.
    clearTimeout(requestTimer);
    requestTimer = undefined;

    if (!response.ok) {
      throw failure(`HTTP ${response.status}`, { network: true });
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== size) {
      throw failure(`content length ${contentLength} does not match expected ${size}`);
    }
    if (response.body === null) {
      throw failure('response has no body', { network: true });
    }

    try {
      file = await open(temp, 'wx');
    } catch (error) {
      throw failure(`cannot create temporary file: ${error.message}`, { cause: error });
    }

    // Only the network read is classified as a source failure. Size checks,
    // disk writes and progress callbacks sit outside that try block, so their
    // errors surface as-is and never switch to the mirror.
    const chunks = response.body[Symbol.asyncIterator]();
    let bytes = 0;
    while (true) {
      let part;
      idleTimer = setTimeout(
        () => controller.abort(new Error('download stalled')),
        idleTimeoutMs,
      );
      try {
        part = await chunks.next();
      } catch (cause) {
        throw failure(`download interrupted after ${bytes} bytes: ${cause.message}`, {
          cause,
          network: true,
        });
      } finally {
        clearIdleTimer();
      }
      if (part.done) break;

      const chunk = part.value;
      if (bytes + chunk.length > size) {
        throw failure(`download exceeds expected size ${size}`);
      }
      try {
        await file.writeFile(chunk);
      } catch (error) {
        throw failure(`cannot write model file: ${error.message}`, { cause: error });
      }
      bytes += chunk.length;
      onProgress?.({ downloadedSize: bytes, totalSize: size });
    }

    if (bytes !== size) {
      throw failure(`download ended at ${bytes}/${size} bytes`, { network: true });
    }

    try {
      await file.close();
      file = undefined;
    } catch (error) {
      throw failure(`cannot close model file: ${error.message}`, { cause: error });
    }

    try {
      await rename(temp, target);
      moved = true;
    } catch (error) {
      throw failure(`cannot move model file into place: ${error.message}`, { cause: error });
    }

    return target;
  } finally {
    clearTimeout(requestTimer);
    clearIdleTimer();
    // Abort before any cleanup so an unread response body cannot keep the
    // socket and its download alive.
    controller.abort();
    try {
      await file?.close();
    } finally {
      if (!moved) await rm(temp, { force: true });
    }
  }
}

export async function downloadModelFile({
  onSwitch = (message) => process.stderr.write(`${message}\n`),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  ...downloadOptions
}) {
  const shared = { ...downloadOptions, requestTimeoutMs, idleTimeoutMs };

  let officialFailure;
  try {
    return await downloadFrom({ ...shared, url: downloadOptions.officialUrl });
  } catch (error) {
    if (error.network !== true) throw error;
    officialFailure = error;
  }

  onSwitch(`Hugging Face download failed (${describe(officialFailure)}); switching to hf-mirror.com`);
  try {
    return await downloadFrom({ ...shared, url: downloadOptions.mirrorUrl });
  } catch (error) {
    if (error.network !== true) throw error;
    throw failure(
      'model download failed from Hugging Face and hf-mirror.com; '
        + `huggingface: ${describe(officialFailure)}; hf-mirror: ${describe(error)}`,
      { cause: error, network: true },
    );
  }
}
