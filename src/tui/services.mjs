import { fileURLToPath } from 'node:url';
import { formatUnits } from 'viem';
import { request } from '../shared.mjs';
import { collectMyTasks, newestFirst } from '../lib/my-tasks.mjs';
import { assertOrderNotCancelled, cancelOrder, deleteOrder, findOrder, orderSummary } from '../lib/orders.mjs';
import { publishJob, refreshOrder } from '../lib/publish.mjs';
import { downloadTaskFiles } from '../lib/task-result.mjs';
import { orderPayment } from '../lib/payments.mjs';
import { networkName } from '../lib/payment-networks.mjs';
import { paymentOptions } from '../lib/payment-options.mjs';
import { fundingSummary } from '../lib/funding-state.mjs';
import { supportView } from '../lib/support.mjs';
import { walletInfo, saveLocalWallet, backupWallet, restoreWallet, listWallets, selectWallet, revealPrivateKey, deleteLocalWallet } from '../lib/local-wallet.mjs';
import { networkWorkers } from '../lib/network-workers.mjs';
import { walletStatus } from '../lib/wallet-status.mjs';
import { checkTaskWallet } from '../lib/task-wallet.mjs';
import { receiveWallet, receiveQrText, saveReceiveQr } from '../lib/wallet-receive.mjs';
import { planTask } from '../planner/flow.mjs';
import { readState, makeTarget, targetKey } from '../worker/context.mjs';
import { runProcess } from '../worker/process.mjs';
import { saveDraft, loadDraft, listDrafts, deleteDraft } from '../lib/drafts.mjs';

const entry = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const nativeEntry = fileURLToPath(new URL('./native.mjs', import.meta.url));
const EPOCH = '1970-01-01T00:00:00.000Z';

function jobItems(jobs) {
  return jobs.map((job) => ({
    id: job.id, jobId: job.id, kind: 'task', title: job.objective,
    state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt,
  }));
}

function latestUpdate(jobs, since = EPOCH) {
  return jobs.reduce((latest, job) => job.updatedAt > latest ? job.updatedAt : latest, since);
}

function taskTotal(api, signal) {
  return request(api, '/swarm', { signal }).then(({ data }) => data.counts.jobs);
}

async function jobChanges(api, query, since, signal) {
  // The public list is cached for 30 seconds. Overlap that window so an
  // update from a cached response cannot fall behind the next watermark.
  const params = new URLSearchParams({ limit: '500', since: new Date(Date.parse(since) - 30_000).toISOString() });
  if (query) params.set('q', query);
  const items = [];
  let watermark = since;
  for (;;) {
    const { data } = await request(api, '/jobs?' + params, { signal });
    items.push(...jobItems(data.jobs));
    watermark = latestUpdate(data.jobs, watermark);
    if (data.jobs.length < 500) return { items, since: watermark };
    params.set('before', data.jobs.at(-1).createdAt);
  }
}

export function paymentView(state) {
  const payment = orderPayment(state);
  return {
    orderId: state.orderId,
    objective: state.input.objective,
    deliverables: state.plan?.deliverables ?? [],
    amount: formatUnits(BigInt(payment.amount), payment.decimals),
    support: supportView(state),
    funding: state.funding ? fundingSummary(state.funding) : null,
    network: payment.network,
    chainName: networkName(state.paymentChain),
    payWith: state.payWith ?? 'IMD',
    paymentChain: state.paymentChain ?? 'ethereum',
    networkFeeCap: state.paymentReview?.networkFeeCap,
    asset: payment.asset,
    payTo: payment.payTo,
    expiresAt: new Date(Number(state.quote.expiresAt) * 1000).toISOString(),
    prepared: state.challenge.input,
  };
}

export function workerTargets(home) {
  const targets = readState(home).targets;
  const result = [{ id: 'local', title: 'This computer', options: {}, installed: Boolean(targets.local) }];
  for (const [id, saved] of Object.entries(targets)) {
    if (id === 'local') continue;
    const [, host, port] = id.match(/^ssh:(.+):(\d+)$/);
    result.push({
      id, title: host, installed: true,
      options: { ssh: host, port, identity: saved.identity, prefix: saved.prefix, workerHome: saved.workerHome },
    });
  }
  return result;
}

export function createWorkerTarget({ host, port, identity }) {
  const options = host.trim() ? { ssh: host.trim(), port: port || '22', identity: identity || undefined } : {};
  const target = makeTarget(options);
  return { id: targetKey(target), title: target.host ?? 'This computer', options, installed: false };
}

export function commandArguments(options, args, target = null, json = false) {
  const globals = ['--api', options.api, '--home', options.home, '--key-env', options.keyEnv];
  if (options.rpc) globals.push('--rpc', options.rpc);
  if (options.paymentChain) globals.push('--payment-chain', options.paymentChain);
  if (options.payWith) globals.push('--pay-with', options.payWith);
  const flags = [];
  for (const [key, value] of Object.entries(target?.options ?? {})) {
    if (value !== undefined && value !== null) {
      flags.push('--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(value));
    }
  }
  return [entry, ...globals, ...args, ...flags, ...(json ? ['--json'] : [])];
}

export function createServices(options, { loadPlanner, run = runProcess } = {}) {
  return {
    options,
    async mine(signal) {
      const [doc, drafts] = await Promise.all([
        collectMyTasks({ ...options, limit: 100, signal }), listDrafts(options.home),
      ]);
      const savedDrafts = drafts.filter(draft => draft.api === options.api).map(draft => ({
        ...draft, draftId: draft.id, kind: 'draft', title: draft.objective, state: 'draft',
      }));
      const tasks = [...doc.tasks, ...doc.orders].map((item) => ({
        ...item, id: item.jobId ?? item.orderId ?? item.requestKey,
        title: item.objective ?? 'Payment order',
        state: item.executionState ?? (item.cancelledAt && !item.jobId ? 'cancelled' : item.orderStatus) ?? 'unknown',
      }));
      return {
        items: [...savedDrafts, ...tasks].sort(newestFirst),
        note: doc.mode === 'local' ? 'Local records · wallet not configured' : 'Local + wallet · newest 100 orders',
        address: doc.wallet.address,
      };
    },
    async explore(query = '', before, signal) {
      const pageSize = 50;
      const params = new URLSearchParams({ limit: String(pageSize) });
      if (query) params.set('q', query);
      if (before) params.set('before', before);
      const [{ data }, total] = await Promise.all([
        request(options.api, '/jobs?' + params, { signal }),
        !query && !before ? taskTotal(options.api, signal) : null,
      ]);
      return {
        items: jobItems(data.jobs),
        cursor: data.jobs.length === pageSize ? data.jobs.at(-1).createdAt : null,
        total, since: latestUpdate(data.jobs),
        note: (query ? 'Search results' : 'Public tasks') + ' · auto-refresh 30s',
      };
    },
    async exploreUpdates(query, since, signal) {
      const [changes, total] = await Promise.all([
        jobChanges(options.api, query, since, signal),
        query ? null : taskTotal(options.api, signal),
      ]);
      return { ...changes, total };
    },
    async detail(item, signal) {
      if (item.draftId) return { ...await loadDraft(options.home, item.draftId), status: 'draft' };
      if (item.jobId) return (await request(options.api, '/jobs/' + encodeURIComponent(item.jobId), { signal })).data;
      if (item.requestKey) {
        const order = await findOrder(options.home, item.requestKey);
        return {
          ...orderSummary(order), objective: order.input.objective, plan: order.plan,
          pendingTransaction: order.pendingTransaction ?? null, transaction: order.transaction ?? null,
        };
      }
      return { ...item, objective: item.title };
    },
    async result(id, signal) {
      return (await request(options.api, '/jobs/' + encodeURIComponent(id) + '/result', { signal })).data;
    },
    plan: (intent) => planTask({ ...options, ...intent, loadPlanner }),
    saveDraft: draft => saveDraft(options.home, { ...draft, api: options.api }),
    loadDraft: id => loadDraft(options.home, id),
    deleteDraft: id => deleteDraft(options.home, id),
    checkTaskWallet: input => checkTaskWallet({ ...options, ...input }),
    publish: (input) => publishJob({ ...options, ...input, yes: false }),
    paymentOptions: input => paymentOptions({ ...options, ...input }),
    async resume(item, confirm, signal, chooseSupport, onProgress, confirmReplacement, { payment, review } = {}) {
      const id = item.requestKey ?? item.orderId;
      const local = await findOrder(options.home, id);
      assertOrderNotCancelled(local);
      const signed = local.onchainPayment || local.paymentHeader || local.quoteSignature;
      const state = signed && local.orderId ? await refreshOrder({ home: options.home, id }) : local;
      if (state.status === 'admitted' || state.status === 'refused') return { state, status: state.status };
      if ((state.onchainPayment || (state.paymentHeader && state.quoteSignature)) && Number(state.quote.expiresAt) * 1000 > Date.now()) {
        const accepted = await confirm({
          title: 'Resume the saved payment?',
          lines: ['Order: ' + state.orderId, 'Resume the saved payment on ' + networkName(state.paymentChain) + '.', 'Any refreshed payment will be shown for review before signing.'],
        });
        if (!accepted) throw new Error('Order recovery cancelled.');
      }
      return publishJob({ ...options, paymentChain: payment?.paymentChain ?? state.paymentChain ?? 'ethereum', payWith: payment?.payWith ?? state.payWith ?? 'IMD', input: state.input, action: state.action, requestKey: state.requestKey, confirm: review ?? (async (order) => {
        if (!await confirm({ payment: paymentView(order) })) throw new Error('Order recovery cancelled. No new payment was signed.');
      }), signal, chooseSupport, onProgress, confirmReplacement, yes: false });
    },
    cancel: (item) => cancelOrder(options.home, item.requestKey),
    delete: (item) => deleteOrder(options.home, item.requestKey),
    download: ({ id, out, onProgress, signal }) => downloadTaskFiles({ api: options.api, id, out, onProgress, signal }),
    targets: () => workerTargets(options.home),
    networkWorkers: signal => networkWorkers(options.api, signal),
    async command(args, target, signal) {
      const result = await run({ command: process.execPath, args: commandArguments(options, args, target, true), signal });
      if (!result.stdout.trim()) throw new Error(result.stderr.trim() || 'Command exited with code ' + result.exitCode);
      const output = JSON.parse(result.stdout);
      // Worker queries can return a useful diagnostic report with a nonzero exit.
      if (result.exitCode !== 0 && (output.exitCode ?? output.service?.exitCode) !== result.exitCode) throw new Error(result.stderr.trim() || 'Command exited with code ' + result.exitCode);
      return output;
    },
    async interactive(args, target) {
      const result = await run({ command: process.execPath, args: [nativeEntry, ...commandArguments(options, args, target).slice(1)], stdio: 'inherit' });
      if (result.exitCode !== 0) throw new Error('Command exited with code ' + result.exitCode + '.');
      return result;
    },
    async wallet(signal, address, { balances = true } = {}) {
      const current = walletInfo(options);
      const selected = address ? listWallets(options.home).find(wallet => wallet.address === address) : null;
      const info = { ...(selected ? { ...selected, configured: true, source: 'local' } : current), currentAddress: current.address };
      if (!info.configured || !balances) return info;
      // Receiving and backing up are local operations and remain available
      // when the balance service is offline. Show that failure explicitly.
      try { return await walletStatus({ ...options, signal }, info); }
      catch (error) { return { ...info, balanceError: error.message }; }
    },
    createWallet: (password, key, signal) => saveLocalWallet(options.home, password, key, { ...options, signal }),
    wallets: () => listWallets(options.home),
    selectWallet: address => selectWallet(options.home, address),
    deleteWallet: address => deleteLocalWallet(options.home, address),
    backupWallet: (out, address) => backupWallet(options.home, out, address),
    revealPrivateKey: (address, password, signal) => revealPrivateKey(options.home, address, password, { signal }),
    restoreWallet: (file, password, signal) => restoreWallet(options.home, file, password, { ...options, signal }),
    async receiveWallet(address, network) {
      const info = await receiveWallet({ ...options, paymentChain: network }, address ? { configured: true, address } : walletInfo(options));
      return { ...info, qr: await receiveQrText(info.address) };
    },
    saveQr: (address, out) => saveReceiveQr(address, out),
  };
}
