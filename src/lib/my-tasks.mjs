import { request } from '../shared.mjs';
import { walletInfo } from './local-wallet.mjs';
import { listOrders, orderActions } from './orders.mjs';
import { mapConcurrent } from './concurrent.mjs';

export const DEFAULT_MY_TASKS_LIMIT = 20;
export const MAX_MY_TASKS_LIMIT = 100;
export const REMOTE_PAID_BY_CAP = 100;
const JOB_FETCH_CONCURRENCY = 4;
const ACTIONS = new Set(['job.open', 'job.continue']);
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MY_TASKS_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MY_TASKS_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_MY_TASKS_LIMIT}`);
  }
  return limit;
}

function isAddress(value) {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value.trim());
}

function sameAddress(a, b) {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

function text(value) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean || null;
}

function time(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function newestFirst(a, b) {
  const diff = Math.max(time(b.paidAt), time(b.updatedAt), time(b.createdAt))
    - Math.max(time(a.paidAt), time(a.updatedAt), time(a.createdAt));
  return diff || String(a.orderId ?? a.jobId ?? '').localeCompare(
    String(b.orderId ?? b.jobId ?? ''),
  );
}

function combineSource(a, b) {
  return a === b ? a : 'both';
}

/** Only state.payer or the signed Permit2 payload are payer evidence. */
export function payerFromLocalState(state) {
  if (isAddress(state?.payer)) return state.payer;
  const from = state?.payment?.payload?.permit2Authorization?.from;
  return isAddress(from) ? from : null;
}

function localCandidate(state, payer) {
  const jobId = typeof state?.jobId === 'string' && state.jobId ? state.jobId : null;
  return {
    kind: jobId ? 'task' : 'order',
    jobId,
    orderId: typeof state?.orderId === 'string' ? state.orderId : null,
    requestKey: typeof state?.requestKey === 'string' ? state.requestKey : null,
    source: 'local',
    payer: payer ?? null,
    ownership: payer ? 'known' : 'unknown',
    objective: text(state?.input?.objective),
    executionState: null,
    project: null,
    orderStatus: state?.lastStatus ?? state?.status ?? null,
    paymentChain: state.paymentChain ?? 'ethereum',
    cancelledAt: state.cancelledAt ?? null,
    ...orderActions(state),
    paymentStatus: state?.paymentStatus ?? null,
    transactionHash: state?.transactionHash ?? null,
    refusalProblems: state?.refusalProblems ?? null,
    createdAt: state?.createdAt ?? null,
    updatedAt: state?.updatedAt ?? null,
    paidAt: null,
  };
}

function remoteCandidate(order, payer) {
  const jobId = typeof order?.result?.jobId === 'string' && order.result.jobId
    ? order.result.jobId
    : null;
  return {
    kind: jobId ? 'task' : 'order',
    jobId,
    orderId: order.orderId,
    requestKey: null,
    source: 'remote',
    payer,
    ownership: 'known',
    objective: null,
    executionState: null,
    project: null,
    orderStatus: order.status ?? null,
    paymentStatus: order.payment?.status ?? null,
    transactionHash: order.payment?.transactionHash ?? null,
    refusalProblems: order.result?.kind === 'refused' ? order.result.problems ?? [] : null,
    createdAt: order.createdAt ?? null,
    updatedAt: null,
    paidAt: order.paidAt ?? null,
  };
}

function mergeSameOrder(local, remote) {
  return {
    ...local,
    kind: remote.jobId ?? local.jobId ? 'task' : 'order',
    jobId: remote.jobId ?? local.jobId ?? null,
    source: 'both',
    payer: remote.payer,
    ownership: 'known',
    objective: local.objective ?? null,
    orderStatus: remote.orderStatus ?? local.orderStatus ?? null,
    paymentStatus: remote.paymentStatus ?? local.paymentStatus ?? null,
    transactionHash: remote.transactionHash ?? local.transactionHash ?? null,
    refusalProblems: remote.refusalProblems ?? local.refusalProblems ?? null,
    createdAt: remote.createdAt ?? local.createdAt ?? null,
    updatedAt: local.updatedAt ?? null,
    paidAt: remote.paidAt ?? local.paidAt ?? null,
  };
}

function mergeTaskGroup(a, b) {
  const newest = newestFirst(a, b) <= 0 ? a : b;
  const older = newest === a ? b : a;
  const remote = [a, b]
    .filter((item) => item.source !== 'local')
    .sort(newestFirst)[0] ?? null;
  return {
    ...newest,
    kind: 'task',
    jobId: a.jobId,
    source: combineSource(a.source, b.source),
    payer: remote?.payer ?? newest.payer ?? older.payer ?? null,
    ownership: (remote?.payer ?? newest.payer ?? older.payer) ? 'known' : 'unknown',
    objective: newest.objective ?? older.objective ?? null,
    executionState: newest.executionState ?? older.executionState ?? null,
    project: newest.project ?? older.project ?? null,
    orderStatus: remote?.orderStatus ?? newest.orderStatus ?? older.orderStatus ?? null,
    paymentStatus: remote?.paymentStatus ?? newest.paymentStatus ?? older.paymentStatus ?? null,
    transactionHash: remote?.transactionHash
      ?? newest.transactionHash
      ?? older.transactionHash
      ?? null,
    refusalProblems: remote?.refusalProblems
      ?? newest.refusalProblems
      ?? older.refusalProblems
      ?? null,
    createdAt: newest.createdAt ?? older.createdAt ?? null,
    updatedAt: newest.updatedAt ?? older.updatedAt ?? null,
    paidAt: remote?.paidAt ?? newest.paidAt ?? older.paidAt ?? null,
  };
}

function publicTask(task) {
  return {
    kind: 'task',
    jobId: task.jobId,
    orderId: task.orderId ?? null,
    requestKey: task.requestKey ?? null,
    source: task.source,
    payer: task.payer ?? null,
    ownership: task.ownership,
    objective: task.objective ?? null,
    executionState: task.executionState ?? null,
    project: task.project ?? null,
    orderStatus: task.orderStatus ?? null,
    paymentChain: task.paymentChain ?? null,
    paymentStatus: task.paymentStatus ?? null,
    transactionHash: task.transactionHash ?? null,
    refusalProblems: task.refusalProblems ?? null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    paidAt: task.paidAt ?? null,
  };
}

function publicOrder(order) {
  return {
    kind: 'order',
    orderId: order.orderId ?? null,
    requestKey: order.requestKey ?? null,
    source: order.source,
    payer: order.payer ?? null,
    ownership: order.ownership,
    objective: order.objective ?? null,
    orderStatus: order.orderStatus ?? null,
    paymentChain: order.paymentChain ?? null,
    cancelledAt: order.cancelledAt ?? null,
    canCancel: Boolean(order.canCancel),
    canDelete: Boolean(order.canDelete),
    canResume: Boolean(order.canResume),
    paymentStatus: order.paymentStatus ?? null,
    transactionHash: order.transactionHash ?? null,
    refusalProblems: order.refusalProblems ?? null,
    createdAt: order.createdAt ?? null,
    updatedAt: order.updatedAt ?? null,
    paidAt: order.paidAt ?? null,
  };
}

function resolveWallet(options) {
  if (options.address !== undefined && options.address !== null && options.address !== '') {
    const address = String(options.address).trim();
    if (!isAddress(address)) {
      throw new Error('--address must be a 0x-prefixed 20-byte hex address');
    }
    return { address, source: 'option' };
  }
  if (options.local) return { address: null, source: null };
  const wallet = walletInfo(options);
  return { address: wallet.address, source: wallet.configured ? 'key' : null };
}

async function fetchPaidBy(api, address, signal) {
  const endpoint = `/requests/paid-by/${encodeURIComponent(address)}`;
  let response;
  try {
    response = await request(api, endpoint, { signal });
  } catch (error) {
    error.message += '\nremote paid-by failed; rerun with --local for local orders only '
      + '(there is no automatic fallback)';
    throw error;
  }

  const data = response.data;
  if (!data || !Array.isArray(data.orders)) {
    throw new Error(`paid-by response from ${endpoint} is missing orders`);
  }
  if (!isAddress(data.payer) || !sameAddress(data.payer, address)) {
    throw new Error(`paid-by response from ${endpoint} does not match ${address}`);
  }
  for (const order of data.orders) {
    if (typeof order?.orderId !== 'string' || !order.orderId) {
      throw new Error(`paid-by response from ${endpoint} has an order without orderId`);
    }
  }

  return {
    endpoint,
    payer: data.payer,
    orders: data.orders.filter((order) => ACTIONS.has(order.action)),
  };
}

async function fetchJobs(tasks, api, signal) {
  await mapConcurrent(tasks, JOB_FETCH_CONCURRENCY, async task => {
    signal?.throwIfAborted();
    try {
      const response = await request(api, `/jobs/${encodeURIComponent(task.jobId)}`, { signal });
      const job = response.data;
      if (!job?.id || !job.state) throw new Error('job response is missing id or state');
      task.objective = text(job.objective) ?? task.objective;
      task.executionState = job.state;
      task.project = job.project ?? task.project;
      task.updatedAt = job.updatedAt ?? task.updatedAt;
    } catch (error) {
      throw new Error(`job ${task.jobId}: ${error.message}`);
    }
  });
}

export async function collectMyTasks(options = {}) {
  if (!options.api) throw new Error('missing API URL');
  const limit = parseLimit(options.limit);
  const wallet = resolveWallet(options);
  const localOnly = Boolean(options.local) || !wallet.address;

  let remote = {
    queried: false,
    endpoint: null,
    returned: 0,
    cap: REMOTE_PAID_BY_CAP,
    note: `GET /requests/paid-by/:address returns at most the newest ${REMOTE_PAID_BY_CAP} orders; no pagination.`,
  };
  let remoteOrders = [];
  let remotePayer = null;
  const [allLocal, fetched] = await Promise.all([
    listOrders(options.home),
    localOnly ? null : fetchPaidBy(options.api, wallet.address, options.signal),
  ]);
  if (fetched) {
    remoteOrders = fetched.orders;
    remotePayer = fetched.payer;
    remote = {
      queried: true,
      endpoint: fetched.endpoint,
      returned: fetched.orders.length,
      cap: REMOTE_PAID_BY_CAP,
      note: `GET /requests/paid-by/:address returns at most the newest ${REMOTE_PAID_BY_CAP} orders; no pagination.`,
    };
  }
  const remoteOrderIds = new Set(remoteOrders.map((order) => order.orderId));

  let matchedApi = 0;
  let excludedApi = 0;
  let excludedAction = 0;
  let excludedPayer = 0;
  const localCandidates = [];

  for (const state of allLocal) {
    if (state.api !== options.api) {
      excludedApi += 1;
      continue;
    }
    matchedApi += 1;
    if (!ACTIONS.has(state.action)) {
      excludedAction += 1;
      continue;
    }

    const payer = payerFromLocalState(state);
    if (wallet.address) {
      const proven = sameAddress(payer, wallet.address);
      // An explicit --address still accepts an unknown local payer when the
      // remote paid-by list proves the same orderId. Without that proof the
      // strict address view drops it.
      const provenByRemote = !payer && state.orderId && remoteOrderIds.has(state.orderId);
      const defaultKeyUnknown = wallet.source === 'key' && !payer;
      if (!proven && !provenByRemote && !defaultKeyUnknown) {
        excludedPayer += 1;
        continue;
      }
    }
    localCandidates.push(localCandidate(state, payer));
  }

  const byOrder = new Map();
  for (const order of remoteOrders) {
    const candidate = remoteCandidate(order, remotePayer);
    if (!byOrder.has(`order:${candidate.orderId}`)) {
      byOrder.set(`order:${candidate.orderId}`, candidate);
    }
  }
  for (const candidate of localCandidates) {
    const key = candidate.orderId
      ? `order:${candidate.orderId}`
      : `request:${candidate.requestKey}`;
    const existing = byOrder.get(key);
    byOrder.set(
      key,
      existing && existing.source !== 'local'
        ? mergeSameOrder(candidate, existing)
        : existing ?? candidate,
    );
  }

  const tasksByJob = new Map();
  const orders = [];
  for (const candidate of byOrder.values()) {
    if (candidate.jobId) {
      const existing = tasksByJob.get(candidate.jobId);
      tasksByJob.set(
        candidate.jobId,
        existing ? mergeTaskGroup(existing, candidate) : candidate,
      );
    } else {
      orders.push(candidate);
    }
  }

  const candidates = [...tasksByJob.values(), ...orders].sort(newestFirst);
  const selected = candidates.slice(0, limit);
  const tasks = selected.filter((candidate) => candidate.kind === 'task');
  const shownOrders = selected.filter((candidate) => candidate.kind === 'order');
  if (!localOnly) await fetchJobs(tasks, options.api, options.signal);

  return {
    api: options.api,
    wallet: { address: wallet.address, source: wallet.source },
    mode: localOnly ? 'local' : 'wallet',
    limit,
    remote,
    local: {
      orders: allLocal.length,
      matchedApi,
      included: localCandidates.length,
      excludedApi,
      excludedAction,
      excludedPayer,
    },
    truncated: candidates.length > limit,
    totals: {
      candidates: candidates.length,
      shown: selected.length,
      tasks: tasks.length,
      orders: shownOrders.length,
    },
    tasks: tasks.map(publicTask),
    orders: shownOrders.map(publicOrder),
  };
}

function oneLine(value, max = 140) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function formatMyTasksText(doc) {
  const lines = [
    `api:      ${doc.api}`,
    `wallet:   ${doc.wallet.address ?? 'none (local orders only)'}`
      + (doc.wallet.source ? ` [${doc.wallet.source}]` : ''),
    `mode:     ${doc.mode}`,
    `showing:  ${doc.totals.shown} of ${doc.totals.candidates} (limit ${doc.limit})`,
    doc.remote.queried
      ? `remote:   ${doc.remote.returned} order(s), newest ${doc.remote.cap} cap, no pagination`
      : 'remote:   not queried (local only)',
    `local:    ${doc.local.included} included, ${doc.local.matchedApi} for this API, `
      + `${doc.local.excludedApi} other API, ${doc.local.excludedAction} other action, `
      + `${doc.local.excludedPayer} other payer`,
  ];
  if (doc.truncated) {
    lines.push('note:     older items hidden; --limit can go up to 100');
  }

  lines.push('', `tasks (${doc.tasks.length}):`);
  if (doc.tasks.length === 0) lines.push('  none');
  for (const task of doc.tasks) {
    lines.push(
      `- ${task.jobId}  ${task.executionState ?? 'unknown'}`
      + `  order=${task.orderStatus ?? '-'}`
      + `  payment=${task.paymentStatus ?? '-'}`
      + `  source=${task.source}`
      + (task.ownership === 'unknown' ? '  ownership=unknown' : ''),
    );
    if (task.objective) lines.push(`  objective: ${oneLine(task.objective)}`);
    if (task.project) {
      lines.push(`  project:   ${task.project.id ?? 'unknown'}`
        + (task.project.version !== undefined ? ` v${task.project.version}` : ''));
    }
  }

  lines.push('', `orders without a job (${doc.orders.length}):`);
  if (doc.orders.length === 0) lines.push('  none');
  for (const order of doc.orders) {
    const id = order.orderId ?? order.requestKey ?? 'unknown';
    lines.push(
      `- ${id}  order=${order.cancelledAt ? 'cancelled' : order.orderStatus ?? '-'}`
      + `  payment=${order.paymentStatus ?? '-'}`
      + `  source=${order.source}`
      + (order.ownership === 'unknown' ? '  ownership=unknown' : ''),
    );
    if (order.objective) lines.push(`  objective: ${oneLine(order.objective)}`);
    for (const problem of order.refusalProblems ?? []) {
      lines.push(`  refused:   ${problem.code ?? 'refused'}`
        + (problem.detail ? `: ${problem.detail}` : ''));
    }
    if (order.requestKey) {
      lines.push(`  inspect: colony order show ${order.requestKey}${order.orderId ? ' --refresh' : ''}`);
      if (order.canCancel) lines.push(`  cancel:  colony order cancel ${order.requestKey}`);
      if (order.canDelete) lines.push(`  delete:  colony order delete ${order.requestKey}`);
    }
  }

  lines.push(
    '',
    'next:',
    '  colony task show <jobId>',
    '  colony task wait <jobId>',
    '  colony task continue <jobId> "Describe the changes" --dry-run',
  );
  return lines.join('\n');
}
