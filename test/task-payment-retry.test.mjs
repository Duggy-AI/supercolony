import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTaskWallet } from '../src/lib/task-wallet.mjs';
import { publishJob, submitOrder } from '../src/lib/publish.mjs';
import { authorizationUnpaid } from '../src/lib/payment-recovery.mjs';
import { findOrder, orderActions, saveOrder } from '../src/lib/orders.mjs';
import { IMD_TOKENS, paymentCoin } from '../src/lib/payment-coins.mjs';
import { paymentApi, ORDER } from './helpers/payment-api.mjs';
import { TEST_KEY, TEST_ADDRESS } from './helpers/cli.mjs';

const NEXT = '99999999-9999-4999-8999-999999999999';
async function fixture(t, network = 'ethereum', payWith = 'IMD') {
  const home = await mkdtemp(join(tmpdir(), 'colony-payment-retry-'));
  const mock = await paymentApi(home);
  mock.control.chainId = network === 'ethereum' ? 1 : 4663;
  mock.control.funding = true;
  process.env.COLONY_RETRY_TEST_KEY = TEST_KEY;
  t.after(async () => { delete process.env.COLONY_RETRY_TEST_KEY; await mock.close(); await rm(home, { recursive: true, force: true }); });
  return { ...mock, home, options: { api: mock.url, home, rpc: mock.url + '/rpc', keyEnv: 'COLONY_RETRY_TEST_KEY',
    paymentChain: network, payWith, input: { objective: 'A coffee website', template: 'website' },
    confirm: async () => {}, intervalMs: 1, timeoutMs: 1000 } };
}

for (const network of ['ethereum', 'robinhood']) {
  test(`${network}: read-only preflight reports both task funds and gas with the receiving address`, async t => {
    const f = await fixture(t, network);
    f.control.nativeBalance = 0n;
    await assert.rejects(checkTaskWallet(f.options), error => {
      assert.equal(error.code, 'funding_required');
      assert.equal(error.funding.address, TEST_ADDRESS);
      const [only] = error.funding.networks;
      assert.equal(only.key, network);
      assert.deepEqual(only.options.map(option => option.coin), ['IMD']);
      assert.deepEqual(only.options[0].shortages.map(s => s.coin), ['IMD', 'ETH']);
      assert.match(error.message, /Your wallet: 0x/);
      assert.match(error.message, /Plus gas \(network fee, always ETH\)/);
      assert.ok(error.message.includes(network === 'ethereum' ? 'Ethereum' : 'Robinhood Chain'));
      return true;
    });
    assert.equal(f.control.broadcasts.length, 0);
    assert.equal(f.requests.some(r => r.path === '/requests/quote'), false);
    await assert.rejects(readdir(join(f.home, 'orders')), { code: 'ENOENT' });
    f.control.nativeBalance = 10n ** 18n;
    f.control.balances.set(IMD_TOKENS[network], 10n ** 18n);
    assert.equal((await checkTaskWallet(f.options)).address, TEST_ADDRESS);
  });

  test(`${network}: top-up resumes one local task with a fresh remote quote`, async t => {
    const f = await fixture(t, network);
    await assert.rejects(publishJob(f.options), { code: 'funding_required' });
    const saved = await findOrder(f.home, ORDER);
    saved.quote.expiresAt = Math.floor(Date.now() / 1000) - 10;
    saved.status = 'expired';
    await saveOrder(f.home, saved);
    assert.equal(orderActions(saved).canResume, true);
    f.control.balances.set(IMD_TOKENS[network], 10n ** 18n);
    f.control.onQuote = (_, quote, terms) => { quote.id = NEXT; terms.expiresAt = quote.expiresAt; };
    let reviews = 0;
    const resumed = await submitOrder({ ...f.options, id: ORDER, confirm: async state => {
      reviews++;
      assert.equal(state.orderId, NEXT);
      assert.ok(state.quote.expiresAt * 1000 > Date.now());
      assert.equal(f.control.broadcasts.length, 0);
    } });
    assert.equal(resumed.status, 'admitted');
    assert.equal(resumed.requestKey, saved.requestKey);
    assert.equal(reviews, 1);
    assert.deepEqual(await readdir(join(f.home, 'orders')), [saved.requestKey + '.json']);
    const quotes = f.requests.filter(r => r.path === '/requests/quote');
    assert.equal(quotes.length, 2);
    assert.notEqual(quotes[0].body.requestKey, quotes[1].body.requestKey);
    assert.equal((await findOrder(f.home, ORDER)).orderId, NEXT);
  });
}

test('USDC top-up reviews a new exchange rate instead of reusing the failed quote', async t => {
  const f = await fixture(t, 'ethereum', 'USDC');
  const token = paymentCoin('ethereum', 'USDC').address;
  f.control.balances.set(token, 0n);
  await assert.rejects(publishJob(f.options), error => error.code === 'funding_required' && error.funding.canChangePayment === true);
  const state = await findOrder(f.home, ORDER);
  f.control.balances.set(token, 100_000_000n);
  f.control.rateMultiplier = 2n;
  let reviewed;
  const result = await submitOrder({ ...f.options, id: state.requestKey, confirm: async state => { reviewed = state.funding.quotedInput; } });
  assert.equal(result.status, 'admitted');
  assert.equal(reviewed, '5000000');
  assert.equal(f.requests.filter(r => r.path === '/requests/quote').length, 1);
});

test('a confirmed conversion and support payment survive quote renewal without being charged again', async t => {
  const f = await fixture(t, 'robinhood', 'ETH');
  f.control.beforeNonce = () => {
    if (f.control.broadcasts.length === 3) return 'Pause before task payment';
  };
  await assert.rejects(publishJob({ ...f.options, chooseSupport: async () => 0 }), /Pause before task payment/);
  const first = await findOrder(f.home, ORDER);
  assert.equal(first.funding.steps.filter(s => s.status === 'confirmed').length, 3);
  assert.equal(first.onchainPayment, undefined);
  first.quote.expiresAt = Math.floor(Date.now() / 1000) - 1;
  await saveOrder(f.home, first);
  f.control.beforeNonce = undefined;
  f.control.onQuote = (_, quote) => { quote.id = NEXT; };
  const resumed = await submitOrder({ ...f.options, id: ORDER });
  assert.equal(resumed.status, 'admitted');
  assert.equal(resumed.funding.steps.filter(s => s.kind === 'swap').length, 1);
  assert.equal(resumed.funding.steps.filter(s => s.kind === 'support').length, 1);
  assert.equal(f.control.broadcasts.length, 4);
});

test('expired Permit2 authorization can only be replaced after finalized expiry and an unused nonce', async t => {
  const f = await fixture(t);
  const state = { payment: { payload: { permit2Authorization: { from: TEST_ADDRESS, nonce: '7', deadline: '100' } } } };
  f.control.blockTimestamp = 99n;
  assert.equal(await authorizationUnpaid(state, f.options), false);
  f.control.blockTimestamp = 101n;
  assert.equal(await authorizationUnpaid(state, f.options), true);
  f.control.nonceBitmap = 1n << 7n;
  assert.equal(await authorizationUnpaid(state, f.options), false);
  assert.equal(f.control.broadcasts.length, 0);
});

for (const paid of [false, true]) {
  test(`signed failed payment recovery checks the original nonce before renewal (used=${paid})`, async t => {
    const f = await fixture(t);
    f.control.balances.set(IMD_TOKENS.ethereum, 10n ** 18n);
    f.control.rejectPayment = true;
    await assert.rejects(publishJob(f.options), /Insufficient IMD/);
    const first = await findOrder(f.home, ORDER);
    const now = Math.floor(Date.now() / 1000);
    first.quote.expiresAt = now - 10;
    const permit = first.payment.payload.permit2Authorization;
    permit.deadline = String(now - 11);
    f.control.nonceBitmap = paid ? 1n << (BigInt(permit.nonce) & 255n) : 0n;
    f.control.blockTimestamp = BigInt(now);
    await saveOrder(f.home, first);
    f.control.rejectPayment = false;
    f.control.onQuote = (_, quote) => { quote.id = NEXT; };
    if (paid) {
      await assert.rejects(submitOrder({ ...f.options, id: ORDER }), /still being reconciled/);
      assert.equal(f.requests.filter(r => r.path === '/requests/quote').length, 1);
    } else {
      let reviews = 0;
      const resumed = await submitOrder({ ...f.options, id: ORDER, confirm: async () => { reviews++; } });
      assert.equal(resumed.status, 'admitted');
      assert.equal(reviews, 1);
      assert.equal(resumed.paymentHistory[0].paymentHeader, first.paymentHeader);
      assert.equal(resumed.quoteHistory.length, 1);
      assert.notEqual(resumed.paymentHeader, first.paymentHeader);
      assert.equal(f.control.broadcasts.length, 1, 'the IMD approval is not repeated');
    }
  });
}
