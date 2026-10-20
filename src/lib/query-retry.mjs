import { setTimeout as sleep } from 'node:timers/promises';

export const QUERY_ATTEMPTS = 3;
export const QUERY_RETRY_DELAY_MS = 3000;

export function isTransientQueryError(error) {
  return error instanceof TypeError || error.retryable === true
    || [408, 429].includes(error.status) || error.status >= 500;
}

function retryDelay(error, defaultMs) {
  const value = error.headers?.get('retry-after');
  if (value === undefined || value === null) return defaultMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : defaultMs;
}

export async function retryQuery(operation, { signal, delayMs = QUERY_RETRY_DELAY_MS, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      signal?.throwIfAborted();
      if (attempt === QUERY_ATTEMPTS || !isTransientQueryError(error)) throw error;
      const waitMs = retryDelay(error, delayMs);
      onRetry?.({ error, retries: attempt, delayMs: waitMs });
      await sleep(waitMs, undefined, { signal });
    }
  }
}
