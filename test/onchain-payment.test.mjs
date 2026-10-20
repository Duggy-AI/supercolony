import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { decodeFunctionData, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';
import { publishJob, submitOrder } from '../src/lib/publish.mjs';
import { cancelOrder, deleteOrder, findOrder, orderSummary } from '../src/lib/orders.mjs';
import { paymentView } from '../src/tui/services.mjs';
import { INTAKE, JOB, ORDER, PARENT, paymentApi, RH_ASSET } from './helpers/payment-api.mjs';
import { runEntry, TEST_ADDRESS, TEST_KEY } from './helpers/cli.mjs';

const abi = parseAbi(['function pay(bytes32 quoteHash, address asset, uint256 amount, uint64 expiresAt, bytes signature)']);

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'colony-onchain-'));
  const mock = await paymentApi(home);
  const keyEnv = 'COLONY_ONCHAIN_TEST_KEY';
  process.env[keyEnv] = TEST_KEY;
  t.after(async () => { delete process.env[keyEnv]; await mock.close(); await rm(home, { recursive: true, force: true }); });
  const options = { home, api: mock.url, rpc: mock.url + '/rpc', keyEnv, paymentChain: 'robinhood',
    input: { objective: 'Coffee site' },
    plan: { summary: 'Coffee site', deliverables: ['A website'] }, intervalMs: 1, timeoutMs: 1000 };
  return { ...mock, options };
}

test('Robinhood stops if the selected wallet changes during final transaction preparation', async t => {
  const f = await fixture(t);
  f.control.beforeNonce = () => { process.env[f.options.keyEnv] = '0x' + '11'.repeat(32); };
  await assert.rejects(publishJob({ ...f.options, yes: true }), /Payment wallet changed/);
  assert.equal(f.control.broadcasts.length, 0);
  assert.equal((await findOrder(f.options.home, ORDER)).onchainPayment, undefined);
});

test('Ethereum continuation rechecks the wallet after payment confirmation', async t => {
  const f = await fixture(t);
  f.control.chainId = 1;
  f.control.action = 'job.continue';
  await assert.rejects(publishJob({ ...f.options, paymentChain: 'ethereum', action: 'job.continue',
    input: { parentJobId: PARENT, objective: 'Update the website' },
    confirm: () => { process.env[f.options.keyEnv] = '0x' + '11'.repeat(32); },
  }), /Payment wallet changed/);
  assert.equal(f.requests.some(r => r.headers['payment-signature']), false);
  assert.equal((await findOrder(f.options.home, ORDER)).paymentHeader, undefined);
});

test('Robinhood signs a chain-bound payment, saves its exact bytes before broadcast, then admits the same order', async (t) => {
  const f = await fixture(t);
  let card;
  const result = await publishJob({ ...f.options, confirm: async (state) => { card = paymentView(state); } });
  assert.equal(result.status, 'admitted');
  assert.equal(result.state.jobId, JOB);
  assert.equal(card.chainName, 'Robinhood Chain');
  assert.equal(card.amount, '0.5');
  assert.ok(Number(card.networkFeeCap) > 0);
  assert.equal(f.control.broadcasts.length, 1);
  const raw = f.control.broadcasts[0];
  const transaction = parseTransaction(raw);
  assert.equal(transaction.chainId, 4663);
  assert.equal(transaction.to.toLowerCase(), INTAKE);
  assert.equal((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(), TEST_ADDRESS.toLowerCase());
  const { functionName, args } = decodeFunctionData({ abi, data: transaction.data });
  assert.equal(functionName, 'pay');
  assert.equal(args[0], f.terms.quoteHash);
  assert.equal(args[1].toLowerCase(), RH_ASSET);
  assert.deepEqual(args.slice(2, 4), [BigInt(f.terms.amount), BigInt(f.terms.expiresAt)]);
  assert.equal(f.control.persisted[0].onchainPayment.rawTransaction, raw);
  assert.equal(f.control.persisted[0].status, 'submitted');
  const summary = orderSummary(result.state);
  assert.equal(summary.paymentChain, 'robinhood');
  assert.equal(summary.paymentSigned, true);
  assert.equal(summary.asset, RH_ASSET);
  assert.doesNotMatch(JSON.stringify(summary), /rawTransaction|privateKey/);
  assert.equal(f.requests.some((entry) => entry.headers['payment-signature']), false);
});

test('the selected chain price reaches confirmation and is signed without a separate spending limit', async (t) => {
  const f = await fixture(t);
  f.terms.amount = '5000000000000000000';
  let reviewed;
  await publishJob({ ...f.options, confirm: state => { reviewed = paymentView(state).amount; } });
  assert.equal(reviewed, '5');
  assert.equal(f.control.broadcasts.length, 1);
  const tx = parseTransaction(f.control.broadcasts[0]);
  assert.equal(decodeFunctionData({ abi, data: tx.data }).args[2], 5000000000000000000n);
});

test('missing Robinhood terms prevent signing; a missing allowance requires payment confirmation', async (t) => {
  const f = await fixture(t);
  f.control.includeTerms = false;
  await assert.rejects(publishJob(f.options), /no Robinhood payment quote/);
  f.control.includeTerms = true;
  f.control.allowance = 0n;
  await assert.rejects(publishJob(f.options), /confirmation required/);
  assert.equal(f.control.broadcasts.length, 0);
});

test('declining a Robinhood payment leaves an unsigned request that can be cancelled', async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishJob({ ...f.options, confirm: () => { throw new Error('User declined'); } }), /User declined/);
  const state = await findOrder(f.options.home, ORDER);
  assert.equal(state.onchainPayment, undefined);
  await cancelOrder(f.options.home, ORDER);
  assert.equal(f.control.broadcasts.length, 0);
});

for (const accepted of [true, false]) {
  test(`a lost broadcast response recovers the same transaction (${accepted ? 'already accepted' : 'not yet accepted'})`, async (t) => {
    const f = await fixture(t);
    f.control.dropBroadcast = true;
    f.control.acceptBroadcast = accepted;
    await assert.rejects(publishJob({ ...f.options, yes: true }), /resume with: colony .*order submit/);
    const saved = await findOrder(f.options.home, ORDER);
    const raw = saved.onchainPayment.rawTransaction;
    const before = f.control.broadcasts.length;
    await assert.rejects(cancelOrder(f.options.home, ORDER), /Only unsigned/);
    await assert.rejects(deleteOrder(f.options.home, ORDER), /recovery records must be kept/);
    f.control.dropBroadcast = false;
    f.control.acceptBroadcast = true;
    delete process.env[f.options.keyEnv];
    const resumed = await submitOrder({ ...f.options, id: ORDER });
    assert.equal(resumed.status, 'admitted');
    assert.equal(resumed.jobId, JOB);
    assert.equal(f.control.broadcasts.length, before + (accepted ? 0 : 1));
    assert.ok(f.control.broadcasts.every((bytes) => bytes === raw));
    assert.equal(f.requests.filter((entry) => entry.path === '/requests/quote').length, 1);
    assert.equal(f.requests.filter((entry) => entry.body?.method === 'eth_getTransactionCount').length, 1);
  });
}

test('a reverted onchain payment is kept as a failed payment and is never automatically sent again', async (t) => {
  const f = await fixture(t);
  f.control.reverted = true;
  await assert.rejects(publishJob({ ...f.options, yes: true }), /transaction reverted/);
  const failed = await findOrder(f.options.home, ORDER);
  assert.equal(failed.status, 'payment_failed');
  assert.equal(orderSummary(failed).paymentSigned, true);
  await assert.rejects(submitOrder({ ...f.options, id: ORDER }), { code: 'payment_reconciling' });
  assert.equal(f.control.broadcasts.length, 1);
});

test('an existing order keeps its payment method unless an unsigned order is explicitly switched', async (t) => {
  const f = await fixture(t);
  f.control.funding = true;
  f.control.balances.set(RH_ASSET, 10n ** 18n);
  const options = { ...f.options, confirm: () => { throw new Error('Review later'); } };
  await assert.rejects(publishJob(options), /Review later/);
  const state = await findOrder(f.options.home, ORDER);
  assert.equal(state.paymentChain, 'robinhood');
  assert.equal(state.payWith, 'IMD');
  await assert.rejects(publishJob({ ...options, paymentChain: undefined, requestKey: state.requestKey }), /Review later/);
  assert.equal((await findOrder(f.options.home, ORDER)).paymentChain, 'robinhood');
  let reviewed;
  const switched = await publishJob({ ...options, payWith: 'ETH', requestKey: state.requestKey,
    confirm: async order => { reviewed = order.funding.coin; } });
  assert.equal(switched.status, 'admitted');
  assert.equal(reviewed, 'ETH');
  assert.equal(switched.state.payWith, 'ETH');
  assert.equal(switched.state.paymentChain, 'robinhood');
  await assert.rejects(publishJob({ ...options, payWith: 'IMD', requestKey: state.requestKey }), /original payment coin/);
});

test('cancelling while a transaction is pending stops polling and keeps the payment recoverable', async (t) => {
  const f = await fixture(t);
  f.control.pendingReceipt = true;
  const abort = new AbortController();
  const publishing = publishJob({ ...f.options, yes: true, signal: abort.signal });
  const assertion = assert.rejects(publishing, /abort/i);
  while (!f.control.broadcasts.length) await delay(5);
  abort.abort();
  await assertion;
  const saved = await findOrder(f.options.home, ORDER);
  assert.ok(saved.onchainPayment.rawTransaction);
  assert.equal(saved.paymentStatus, 'pending');
  f.control.pendingReceipt = false;
  const resumed = await submitOrder({ ...f.options, id: ORDER });
  assert.equal(resumed.status, 'admitted');
  assert.equal(f.control.broadcasts.length, 1);
});

for (const args of [
  ['task', 'publish', '--file', 'examples/research-job.json'],
  ['task', 'create', 'Coffee site', '--preset', 'report'],
  ['task', 'continue', PARENT, 'Coffee site', '--template', 'same'],
]) {
  test(`CLI ${args[1]} forwards Robinhood network and RPC through its complete payment flow`, async (t) => {
    const f = await fixture(t);
    if (args[1] === 'continue') f.control.action = 'job.continue';
    const output = await runEntry([
      '--home', f.options.home, '--api', f.url, '--rpc', f.options.rpc,
      '--key-env', f.options.keyEnv, '--payment-chain', 'robinhood', '--yes', '--json',
      ...args,
    ]);
    assert.equal(output.status, 0, output.stderr);
    const result = JSON.parse(output.stdout);
    assert.equal(result.status, 'admitted');
    assert.equal(result.paymentChain, 'robinhood');
    assert.equal(result.quote.asset, RH_ASSET);
    assert.equal(f.control.broadcasts.length, 1);
    assert.doesNotMatch(output.stdout, /rawTransaction|requestToken|quoteSignature|paymentHeader/);
  });
}
