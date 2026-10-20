import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fundingSummary } from './funding-state.mjs';
import { mapConcurrent } from './concurrent.mjs';
import lockfile from 'proper-lockfile';
import { imdTaskUrl } from './task-link.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ordersDir(home) {
  return join(home, 'orders');
}

function orderPath(home, requestKey) {
  if (!UUID_PATTERN.test(requestKey)) {
    throw new Error(`invalid request key: ${requestKey}`);
  }
  return join(ordersDir(home), `${requestKey}.json`);
}

async function withOrderLock(home, requestKey, operation) {
  const dir = ordersDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = orderPath(home, requestKey);
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 2, minTimeout: 100, maxTimeout: 200 } });
  try { return await operation(path); }
  finally { await release(); }
}

export async function saveOrder(home, state) {
  return withOrderLock(home, state.requestKey, async path => {
    const current = await loadOrder(home, state.requestKey);
    if (current && !state.cancelledAt) assertOrderNotCancelled(current);
    // A writer may have waited on a quote, password or RPC while another
    // terminal changed this order. Never replace that newer state.
    if ((!current && state.revision !== undefined) || (current && (state.revision ?? 0) !== current.revision)) {
      throw Object.assign(new Error('This task was updated in another terminal. Reopen it to continue from its saved progress.'), { code: 'order_changed' });
    }
    if (state.cancelledAt && current && !current.cancelledAt && !orderActions(current).canCancel) {
      throw new Error('This payment has already started. Reopen the task to inspect its progress.');
    }
    const next = { ...state, revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    const temporary = join(ordersDir(home), `.${state.requestKey}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
    Object.assign(state, next);
    return state;
  });
}

export async function loadOrder(home, requestKey) {
  const path = orderPath(home, requestKey);
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    state.revision ??= 0;
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error(`invalid order file ${path}: ${error.message}`);
    }
    throw error;
  }
}

export async function listOrders(home) {
  let entries;
  try {
    entries = await readdir(ordersDir(home), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
  const orders = await mapConcurrent(files, 8, async entry => {
    const state = JSON.parse(await readFile(join(ordersDir(home), entry.name), 'utf8'));
    state.revision ??= 0;
    return state;
  });
  orders.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return orders;
}

export async function findOrder(home, id) {
  const orders = await listOrders(home);
  const found = orders.find((state) => state.orderId === id || state.requestKey === id || state.quoteHistory?.some(quote => quote.orderId === id));
  if (!found) {
    throw new Error(`unknown order: ${id}`);
  }
  return found;
}

const UNPAID_STATES = new Set(['created', 'blocked', 'quoted', 'challenged', 'expired', 'payment_failed']);

export function orderActions(state) {
  // A saved signature or submit attempt must remain recoverable. Removing a
  // local file cannot revoke a payment authorization held by the server.
  const unpaid = UNPAID_STATES.has(state.status)
    && !state.paymentHeader && !state.quoteSignature && !state.payment && !state.onchainPayment
    && !state.funding?.steps.some((step) => step.rawTransaction)
    && !state.paymentHistory?.length
    && !state.expiredFunding?.length
    && !state.submittedAt && !state.jobId && !state.paymentStatus && !state.transactionHash;
  return {
    canCancel: unpaid && !state.cancelledAt,
    canDelete: unpaid && Boolean(state.cancelledAt),
    canResume: !state.cancelledAt && !state.jobId
      && !['admitted', 'refused'].includes(state.status),
  };
}

export function assertOrderNotCancelled(state) {
  if (state.cancelledAt) {
    throw Object.assign(new Error('This request was cancelled locally and cannot be paid or resumed. Create a new task to start again.'), { code: 'order_cancelled' });
  }
}

export async function cancelOrder(home, id) {
  const state = await findOrder(home, id);
  if (!orderActions(state).canCancel) {
    throw new Error('Only unsigned, unsubmitted requests can be cancelled locally. Signed payments and published tasks cannot be cancelled through the IMD public API.');
  }
  state.cancelledAt = new Date().toISOString();
  state.lastError = null;
  await saveOrder(home, state);
  return state;
}

export async function deleteOrder(home, id) {
  const state = await findOrder(home, id);
  return withOrderLock(home, state.requestKey, async path => {
    const current = await loadOrder(home, state.requestKey);
    if (!orderActions(current).canDelete) {
      throw new Error('Cancel this unsigned request before deleting its local record. Signed payment recovery records must be kept.');
    }
    await unlink(path);
    return current;
  });
}

export function orderSummary(state) {
  const payment = state.paymentChain === 'robinhood'
    ? state.onchainQuotes?.find((entry) => entry.chainId === 4663)
    : state.quote?.payment;
  return {
    requestKey: state.requestKey,
    orderId: state.orderId ?? null,
    status: state.cancelledAt && !state.jobId ? 'cancelled' : ['admitted', 'refused'].includes(state.status) ? state.status
      : state.recoveryStatus ?? (state.pendingTransaction ? 'transaction_pending' : state.status),
    cancelledAt: state.cancelledAt ?? null,
    ...orderActions(state),
    remoteStatus: state.lastStatus ?? null,
    action: state.action,
    paymentChain: state.paymentChain ?? 'ethereum',
    payWith: state.payWith ?? 'IMD',
    funding: state.funding ? fundingSummary(state.funding) : null,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    amount: payment?.amount ?? null,
    asset: payment?.asset ?? null,
    payTo: payment?.payTo ?? null,
    quoteExpiresAt: state.quote?.expiresAt ?? null,
    paymentSigned: Boolean(state.paymentHeader || state.quoteSignature || state.onchainPayment),
    paymentStatus: state.paymentStatus ?? null,
    transactionHash: state.transactionHash ?? null,
    refusalProblems: state.refusalProblems ?? null,
    jobId: state.jobId ?? null,
    taskUrl: imdTaskUrl(state.jobId),
    statusUrl: state.statusUrl ?? null,
    resultUrl: state.resultUrl ?? null,
    lastError: state.lastError ?? null,
    pendingTransaction: state.pendingTransaction ?? null,
  };
}
