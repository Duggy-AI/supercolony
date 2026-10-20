import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseTransaction } from 'viem';
import { publishJob, submitOrder, refreshOrder } from '../src/lib/publish.mjs';
import { findOrder, orderSummary } from '../src/lib/orders.mjs';
import { IMD_TOKENS } from '../src/lib/payment-coins.mjs';
import { paymentApi, ORDER } from './helpers/payment-api.mjs';
import { TEST_KEY } from './helpers/cli.mjs';

const NEXT = '99999999-9999-4999-8999-999999999999';
async function fixture(t, network = 'ethereum') {
  const home = await mkdtemp(join(tmpdir(), 'colony-flow-'));
  const f = await paymentApi(home);
  f.control.chainId = network === 'ethereum' ? 1 : 4663;
  f.control.funding = true;
  f.control.balances.set(IMD_TOKENS[network], 10n ** 18n);
  process.env.COLONY_FLOW_TEST_KEY = TEST_KEY;
  t.after(async () => { delete process.env.COLONY_FLOW_TEST_KEY; await f.close(); await rm(home, { recursive: true, force: true }); });
  return { ...f, home, options: { api: f.url, home, rpc: f.url + '/rpc', keyEnv: 'COLONY_FLOW_TEST_KEY',
    paymentChain: network, input: { objective: 'Coffee site' }, confirm: async () => {}, timeoutMs: 30, intervalMs: 1 } };
}

test('a zero RPC priority suggestion uses included tips; progress identifies authorization and payment separately', async t => {
  const f = await fixture(t);
  f.control.priorityFee = 0n;
  f.control.minedTip = 100000000n;
  const progress = [];
  const result = await publishJob({ ...f.options, onProgress: event => progress.push(event) });
  assert.equal(result.status, 'admitted');
  const tx = parseTransaction(f.control.broadcasts[0]);
  assert.equal(tx.maxPriorityFeePerGas, 125000000n);
  assert.equal(tx.maxFeePerGas, 3125000000n);
  assert.ok(progress.some(e => e.phase === 'confirming' && /IMD authorization/.test(e.message)));
  assert.ok(progress.some(e => e.phase === 'admission'));
});

for (const network of ['ethereum', 'robinhood']) {
  test(`${network}: a pending approval resumes with a reviewed same-nonce gas replacement`, async t => {
    const f = await fixture(t, network);
    f.control.pendingReceipt = true;
    await assert.rejects(publishJob(f.options), { code: 'transaction_pending' });
    const saved = await findOrder(f.home, ORDER);
    const step = saved.funding.steps[0];
    assert.equal(saved.pendingTransaction.hash, step.hash);
    f.control.pendingReceipt = false;
    f.control.pendingHashes = new Set([step.hash]);
    f.control.baseFee = 4000000000n;
    let reviews = 0;
    const result = await submitOrder({ ...f.options, id: ORDER, confirmReplacement: async review => {
      reviews++;
      assert.equal(review.hash, step.hash);
      assert.ok(Number(review.networkFeeCap) > Number(review.previousNetworkFeeCap));
    } });
    assert.equal(result.status, 'admitted');
    assert.equal(reviews, 1);
    const old = parseTransaction(step.rawTransaction);
    const updated = parseTransaction(f.control.broadcasts[1]);
    for (const key of ['nonce', 'to', 'data', 'value', 'gas', 'chainId']) assert.equal(updated[key], old[key], key);
    assert.ok(updated.maxFeePerGas > old.maxFeePerGas);
    assert.ok(updated.maxPriorityFeePerGas > old.maxPriorityFeePerGas);
    assert.equal(f.control.persisted[1].funding.steps[0].replacements[0].hash, step.hash);
    assert.equal(result.pendingTransaction, undefined);
    assert.equal(f.requests.filter(r => r.path === '/requests/quote').length, 1);
  });
}

test('declining a gas update preserves the pending bytes and never broadcasts another transaction', async t => {
  const f = await fixture(t);
  f.control.pendingReceipt = true;
  await assert.rejects(publishJob(f.options), { code: 'transaction_pending' });
  const saved = await findOrder(f.home, ORDER);
  await assert.rejects(submitOrder({ ...f.options, id: ORDER, confirmReplacement: () => { throw new Error('Declined'); } }), /Declined/);
  assert.equal(f.control.broadcasts.length, 1);
  assert.equal((await findOrder(f.home, ORDER)).funding.steps[0].rawTransaction, saved.funding.steps[0].rawTransaction);
});

test('if the original mines during the gas review, it is used without signing a replacement', async t => {
  const f = await fixture(t);
  f.control.pendingReceipt = true;
  await assert.rejects(publishJob(f.options), { code: 'transaction_pending' });
  const result = await submitOrder({ ...f.options, id: ORDER, confirmReplacement: () => { f.control.pendingReceipt = false; } });
  assert.equal(result.status, 'admitted');
  assert.equal(f.control.broadcasts.length, 1);
  assert.equal(result.funding.steps[0].replacements, undefined);
});

test('a lost replacement broadcast response preserves both hashes and resumes without another debit', async t => {
  const f = await fixture(t);
  f.control.pendingReceipt = true;
  await assert.rejects(publishJob(f.options), { code: 'transaction_pending' });
  const first = await findOrder(f.home, ORDER);
  f.control.pendingReceipt = false;
  f.control.pendingHashes = new Set([first.funding.steps[0].hash]);
  f.control.dropAt = 2;
  await assert.rejects(submitOrder({ ...f.options, id: ORDER, confirmReplacement: async () => {} }), /lost broadcast response/i);
  const saved = await findOrder(f.home, ORDER);
  assert.equal(saved.funding.steps[0].replacements.length, 1);
  f.control.dropBroadcast = false;
  // The original wins while this process was offline. The replacement stays pending.
  f.control.pendingHashes = new Set([saved.funding.steps[0].hash]);
  const result = await submitOrder({ ...f.options, id: ORDER, confirmReplacement: () => assert.fail('No further replacement') });
  assert.equal(result.status, 'admitted');
  assert.equal(result.funding.steps[0].confirmedHash, first.funding.steps[0].hash);
  assert.equal(orderSummary(result).funding.steps[0].hash, first.funding.steps[0].hash);
  assert.equal(f.control.broadcasts.length, 2);
});

test('an admitted order refresh clears pending UI state and its old error', async t => {
  const f = await fixture(t, 'robinhood');
  f.control.beforeReceipt = hash => {
    if (f.control.known.get(hash)?.to?.toLowerCase() === f.terms.intake) f.control.pendingReceipt = true;
  };
  await assert.rejects(publishJob(f.options), { code: 'transaction_pending' });
  const saved = await findOrder(f.home, ORDER);
  assert.equal(orderSummary(saved).status, 'transaction_pending');
  f.control.orderStatus = 'admitted';
  const refreshed = await refreshOrder({ ...f.options, id: ORDER });
  assert.equal(orderSummary(refreshed).status, 'admitted');
  assert.equal(refreshed.pendingTransaction, undefined);
  assert.equal(refreshed.recoveryStatus, undefined);
  assert.equal(refreshed.lastError, null);
});

test('expired server status does not start a new payment while the old authorization is live', async t => {
  const f = await fixture(t);
  f.control.onSubmit = () => { f.control.orderStatus = 'expired'; return { body: { status: 'submitted' } }; };
  await assert.rejects(publishJob(f.options), { code: 'payment_reconciling' });
  const saved = await findOrder(f.home, ORDER);
  assert.ok(saved.paymentHeader);
  assert.equal(f.requests.filter(r => r.path === '/requests/quote').length, 1);
  assert.equal(f.requests.filter(r => r.headers['payment-signature']).length, 1);
});

test('expired server status renews the same local task after finalized proof of no payment', async t => {
  const f = await fixture(t);
  let submits = 0;
  let quotes = 0;
  let reviews = 0;
  f.control.onSubmit = () => {
    if (++submits === 1) {
      f.control.blockTimestamp = BigInt(Math.floor(Date.now() / 1000) + 1000);
      f.control.orderStatus = 'expired';
      return { body: { status: 'submitted' } };
    }
  };
  f.control.onQuote = (_, quote) => {
    if (++quotes === 2) { quote.id = NEXT; f.control.orderStatus = undefined; }
  };
  const result = await publishJob({ ...f.options, confirm: () => { reviews++; } });
  assert.equal(result.status, 'admitted');
  assert.equal(reviews, 2);
  assert.equal(quotes, 2);
  assert.equal(submits, 2);
  assert.equal(result.state.paymentHistory.length, 1);
  assert.equal(f.control.broadcasts.length, 1, 'confirmed IMD approval is retained');
  assert.equal((await readdir(join(f.home, 'orders'))).length, 1);
});

test('quote expiry during authorization renews prices and retains the completed approval', async t => {
  const f = await fixture(t);
  let reviewed;
  let reviews = 0;
  let quotes = 0;
  f.control.onQuote = (_, quote) => { if (++quotes === 2) quote.id = NEXT; };
  f.control.beforeReceipt = hash => {
    if (reviewed && reviews === 1 && f.control.known.has(hash)) {
      reviewed.quote.expiresAt = Math.floor(Date.now() / 1000) - 1;
      reviewed.challenge.quote.expiresAt = reviewed.quote.expiresAt;
    }
  };
  const result = await publishJob({ ...f.options, confirm: state => { reviewed = state; reviews++; } });
  assert.equal(result.status, 'admitted');
  assert.equal(reviews, 2);
  assert.equal(f.control.broadcasts.length, 1);
  assert.equal(result.state.quoteHistory.length, 1);
});

test('a fee increase beyond the review triggers a fresh review before any transaction is signed', async t => {
  const f = await fixture(t);
  let reviews = 0;
  const result = await publishJob({ ...f.options, confirm: () => {
    reviews++;
    assert.equal(f.control.broadcasts.length, 0);
    if (reviews === 1) f.control.baseFee = 4000000000n;
  } });
  assert.equal(result.status, 'admitted');
  assert.equal(reviews, 2);
  assert.equal(parseTransaction(f.control.broadcasts[0]).maxFeePerGas, 13250000000n);
});

test('an expired unmined swap is re-quoted in its original nonce slot after finalized expiry', async t => {
  const f = await fixture(t);
  f.quote.expiresAt = Math.floor(Date.now() / 1000) + 2;
  f.control.pendingReceipt = true;
  const options = { ...f.options, payWith: 'ETH' };
  await assert.rejects(publishJob(options), { code: 'transaction_pending' });
  const saved = await findOrder(f.home, ORDER);
  const old = saved.funding.steps[0];
  assert.equal(old.kind, 'swap');
  await sleep(Math.max(0, old.expiresAt * 1000 - Date.now() + 20));
  f.control.blockTimestamp = BigInt(old.expiresAt + 1);
  f.control.pendingReceipt = false;
  f.control.pendingHashes = new Set([old.hash]);
  f.control.onQuote = (_, quote) => { quote.id = NEXT; quote.expiresAt = Math.floor(Date.now() / 1000) + 600; };
  const result = await submitOrder({ ...options, id: ORDER });
  assert.equal(result.status, 'admitted');
  assert.equal(result.expiredFunding[0].hash, old.hash);
  const replacement = parseTransaction(f.control.broadcasts[1]);
  assert.equal(replacement.nonce, parseTransaction(old.rawTransaction).nonce);
  assert.equal(result.funding.steps.filter(s => s.kind === 'swap').length, 1);
});

test('an expired unmined Robinhood payment renews in its old nonce slot, not behind the stuck transaction', async t => {
  const f = await fixture(t, 'robinhood');
  f.quote.expiresAt = Math.floor(Date.now() / 1000) + 2;
  f.terms.expiresAt = f.quote.expiresAt;
  f.control.beforeReceipt = hash => {
    if (f.control.known.get(hash)?.to?.toLowerCase() === f.terms.intake) f.control.pendingReceipt = true;
  };
  await assert.rejects(publishJob(f.options), { code: 'transaction_pending' });
  const saved = await findOrder(f.home, ORDER);
  const old = saved.onchainPayment;
  await sleep(Math.max(0, old.expiresAt * 1000 - Date.now() + 20));
  f.control.blockTimestamp = BigInt(old.expiresAt + 1);
  f.control.beforeReceipt = undefined;
  f.control.pendingReceipt = false;
  f.control.pendingHashes = new Set([old.hash]);
  f.control.onQuote = (_, quote, terms) => {
    quote.id = NEXT;
    terms.expiresAt = quote.expiresAt = Math.floor(Date.now() / 1000) + 600;
  };
  const result = await submitOrder({ ...f.options, id: ORDER });
  assert.equal(result.status, 'admitted');
  assert.equal(result.paymentHistory[0].onchainPayment.hash, old.hash);
  assert.equal(parseTransaction(result.onchainPayment.rawTransaction).nonce, parseTransaction(old.rawTransaction).nonce);
  assert.equal(f.control.broadcasts.length, 3, 'one approval, expired task payment, renewed task payment');
});
