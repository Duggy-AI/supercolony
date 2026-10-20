import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeFunctionData, erc20Abi, parseTransaction } from 'viem';
import { publishJob, submitOrder } from '../src/lib/publish.mjs';
import { cancelOrder, deleteOrder, findOrder, orderSummary } from '../src/lib/orders.mjs';
import { paymentCoin, IMD_TOKENS } from '../src/lib/payment-coins.mjs';
import { UNISWAP, SWAP_ABI } from '../src/lib/swaps.mjs';
import { paymentApi, ORDER, PARENT } from './helpers/payment-api.mjs';
import { runEntry, TEST_KEY, TEST_ADDRESS } from './helpers/cli.mjs';
import { SUPPORT_RECIPIENT } from '../src/lib/support-recipient.mjs';

async function fixture(t, network = 'ethereum', coin = 'USDC') {
  const home = await mkdtemp(join(tmpdir(), 'colony-funding-'));
  const mock = await paymentApi(home);
  mock.control.chainId = network === 'ethereum' ? 1 : 4663;
  mock.control.funding = true;
  process.env.COLONY_TEST_FUNDING_KEY = TEST_KEY;
  t.after(async () => { delete process.env.COLONY_TEST_FUNDING_KEY; await mock.close(); await rm(home, { recursive: true, force: true }); });
  return { ...mock, home, options: { api: mock.url, home, rpc: mock.url + '/rpc', keyEnv: 'COLONY_TEST_FUNDING_KEY',
    paymentChain: network, payWith: coin, input: { objective: 'Coffee website', template: 'website' },
    confirm: async () => {}, intervalMs: 1, timeoutMs: 2000 } };
}

for (const network of ['ethereum', 'robinhood']) {
  test(`${network}: original-price IMD payment authorizes a new wallet within one review`, async t => {
    const f = await fixture(t, network, 'IMD');
    f.control.balances.set(IMD_TOKENS[network], 10n ** 18n);
    let reviews = 0;
    const result = await publishJob({ ...f.options, chooseSupport: async () => 1, confirm: async state => {
      reviews++;
      assert.equal(f.control.broadcasts.length, 0);
      assert.deepEqual(state.funding.steps.map(s => s.kind), ['approve_imd']);
      assert.equal(state.funding.maximumDebit, '500000000000000000');
    } });
    assert.equal(reviews, 1);
    assert.equal(result.status, 'admitted');
    const approval = decodeFunctionData({ abi: erc20Abi, data: parseTransaction(f.control.broadcasts[0]).data });
    assert.equal(approval.functionName, 'approve');
    assert.equal(approval.args[1], 500000000000000000n);
    assert.equal(f.control.broadcasts.length, network === 'ethereum' ? 1 : 2);
    const resumed = await submitOrder({ ...f.options, id: ORDER });
    assert.equal(resumed.status, 'admitted');
    assert.equal(f.control.broadcasts.length, network === 'ethereum' ? 1 : 2);
  });

  test(`${network}: cancelling the original-price IMD review never authorizes or pays`, async t => {
    const f = await fixture(t, network, 'IMD');
    f.control.balances.set(IMD_TOKENS[network], 10n ** 18n);
    await assert.rejects(publishJob({ ...f.options, chooseSupport: async () => 1,
      confirm: () => { throw new Error('User declined'); } }), /User declined/);
    assert.equal(f.control.broadcasts.length, 0);
    const state = await findOrder(f.home, ORDER);
    assert.equal(state.paymentHeader, undefined);
    assert.equal(state.onchainPayment, undefined);
    assert.ok(orderSummary(state).canCancel);
  });
}

for (const [network, coin] of [['ethereum', 'IMD'], ['robinhood', 'IMD'], ['ethereum', 'USDC'], ['robinhood', 'ETH']]) {
  test(`${network} ${coin}: optional support transfers exactly 10% once and preserves the original admission fee`, async t => {
    const f = await fixture(t, network, coin);
    f.control.balances.set(IMD_TOKENS[network], 10n ** 18n);
    let reviewed = false;
    const result = await publishJob({ ...f.options, chooseSupport: async choices => {
      assert.match(choices[0].label, /0.55 IMD.*10%.*Help us make Colony better/);
      assert.match(choices[1].label, /0.5 IMD.*Original price/);
      return 0;
    }, confirm: async state => {
      reviewed = true;
      assert.equal(f.control.broadcasts.length, 0);
      assert.equal(state.support.amount, '50000000000000000');
      assert.equal(state.funding.minimumOut, '550000000000000000');
    } });
    assert.equal(reviewed, true);
    assert.equal(result.status, 'admitted');
    const step = result.state.funding.steps.find(step => step.kind === 'support');
    const decoded = decodeFunctionData({ abi: erc20Abi, data: parseTransaction(step.rawTransaction).data });
    assert.equal(decoded.functionName, 'transfer');
    assert.equal(decoded.args[0].toLowerCase(), SUPPORT_RECIPIENT.toLowerCase());
    assert.equal(decoded.args[1], 50000000000000000n);
    assert.equal(step.status, 'confirmed');
    const saved = f.control.persisted.find(state => state.funding.steps.some(s => s.hash === step.hash));
    assert.equal(saved.funding.steps.find(s => s.hash === step.hash).rawTransaction, step.rawTransaction);
    const count = f.control.broadcasts.length;
    await publishJob({ ...f.options, requestKey: result.state.requestKey });
    assert.equal(f.control.broadcasts.length, count);
  });
}

test('cancelling while the first authorization is being prepared prevents signing', async t => {
  const f = await fixture(t, 'ethereum', 'IMD');
  f.control.balances.set(IMD_TOKENS.ethereum, 10n ** 18n);
  f.control.beforeEstimate = async () => { await cancelOrder(f.home, ORDER); };
  await assert.rejects(publishJob(f.options), /cancelled locally/);
  assert.equal(f.control.broadcasts.length, 0);
  const saved = await findOrder(f.home, ORDER);
  assert.ok(saved.cancelledAt);
  assert.equal(saved.funding.steps[0].rawTransaction, undefined);
});

test('changing the wallet during authorization preparation stops before any broadcast', async t => {
  const f = await fixture(t, 'ethereum', 'IMD');
  f.control.balances.set(IMD_TOKENS.ethereum, 10n ** 18n);
  f.control.beforeEstimate = async () => { process.env.COLONY_TEST_FUNDING_KEY = '0x' + '12'.repeat(32); };
  await assert.rejects(publishJob(f.options), /Payment wallet changed/);
  assert.equal(f.control.broadcasts.length, 0);
  const saved = await findOrder(f.home, ORDER);
  assert.equal(saved.funding.steps[0].rawTransaction, undefined);
  assert.ok(orderSummary(saved).canCancel);
});

test('support transfer interrupted after broadcast resumes the saved transaction without paying twice', async t => {
  const f = await fixture(t, 'ethereum', 'IMD');
  f.control.balances.set(IMD_TOKENS.ethereum, 10n ** 18n);
  f.control.dropAt = 2;
  await assert.rejects(publishJob({ ...f.options, chooseSupport: async () => 0, timeoutMs: 40 }), /lost broadcast response/i);
  const first = await findOrder(f.home, ORDER);
  const support = first.funding.steps.find(s => s.kind === 'support');
  assert.equal(support.status, 'signed');
  f.control.dropBroadcast = false;
  f.control.dropAt = undefined;
  const resumed = await publishJob({ ...f.options, requestKey: first.requestKey, chooseSupport: async () => { throw new Error('Must retain signed amounts'); } });
  assert.equal(resumed.status, 'admitted');
  assert.equal(f.control.broadcasts.filter(raw => raw === support.rawTransaction).length, 1);
});

test('unsupported payment coins are rejected', () => {
  assert.throws(() => paymentCoin('robinhood', 'USDC'), /not supported/);
});

for (const [network, coin] of [['ethereum','USDC'], ['ethereum','USDT'], ['ethereum','ETH'], ['robinhood','ETH'], ['robinhood','USDG']]) {
  test(`${network} ${coin}: confirms a finite maximum debit before signing`, async t => {
    const f = await fixture(t, network, coin);
    let review;
    const result = await publishJob({ ...f.options,
      confirm: async state => {
        assert.equal(f.control.broadcasts.length, 0);
        review = structuredClone(state.funding);
      },
    });
    assert.equal(result.status, 'admitted');
    assert.equal(result.state.budget, undefined);
    assert.ok(review.slippageBps >= 75 && review.slippageBps <= 500);
    if (network === 'robinhood') assert.equal(review.slippageBps, 75);
    assert.equal(BigInt(review.amountIn), (BigInt(review.quotedInput) * (10000n + BigInt(review.slippageBps)) + 9999n) / 10000n);
    assert.equal(BigInt(review.maximumDebit), BigInt(review.amountIn) + (coin === 'ETH' ? BigInt(review.feeCap) : 0n));
    const swapTx = f.control.broadcasts.map(parseTransaction).find(tx => tx.to.toLowerCase() === UNISWAP[network].router);
    const multicall = decodeFunctionData({ abi: SWAP_ABI, data: swapTx.data });
    const swap = decodeFunctionData({ abi: SWAP_ABI, data: multicall.args[1][0] }).args[0];
    assert.equal(swap.amountInMaximum, BigInt(review.amountIn));
  });
  test(`${network} ${coin}: review, exact approvals, swap and IMD payment use the confirmed amounts`, async (t) => {
    const f = await fixture(t, network, coin);
    let review;
    const result = await publishJob({ ...f.options, confirm: async (state) => { review = structuredClone(state.funding); assert.equal(f.control.broadcasts.length, 0); } });
    assert.equal(result.status, 'admitted');
    assert.equal(review.minimumOut, '500000000000000000');
    assert.ok(result.state.funding.steps.every((step) => step.status === 'confirmed'));
    const txs = f.control.broadcasts.map(parseTransaction);
    const swaps = txs.filter((tx) => tx.to.toLowerCase() === UNISWAP[network].router);
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].value ?? 0n, coin === 'ETH' ? BigInt(review.amountIn) : 0n);
    const multicall = decodeFunctionData({ abi: SWAP_ABI, data: swaps[0].data });
    const swap = decodeFunctionData({ abi: SWAP_ABI, data: multicall.args[1][0] }).args[0];
    assert.equal(swap.recipient.toLowerCase(), TEST_ADDRESS.toLowerCase());
    assert.equal(swap.amountOut, 500000000000000000n);
    assert.equal(swap.amountInMaximum, BigInt(review.amountIn));
    assert.equal(multicall.args[0], BigInt(review.expiresAt));
    if (coin !== 'ETH') {
      const approval = txs.find((tx) => tx.to.toLowerCase() === paymentCoin(network, coin).address);
      assert.equal(decodeFunctionData({ abi: erc20Abi, data: approval.data }).args[1], BigInt(review.amountIn));
    }
    assert.ok(f.control.persisted.every((saved, index) => saved.funding.steps.some((step) => step.rawTransaction === f.control.broadcasts[index]) || saved.onchainPayment?.rawTransaction === f.control.broadcasts[index]));
    const summary = orderSummary(result.state);
    assert.doesNotMatch(JSON.stringify(summary), /rawTransaction|requestToken|paymentHeader|quoteSignature/);
    await assert.rejects(cancelOrder(f.home, ORDER), /unsigned/);
    await assert.rejects(deleteOrder(f.home, ORDER), /recovery/);
  });
}

test('USDT clears a nonzero insufficient allowance, then authorizes only the swap amount', async (t) => {
  const f = await fixture(t, 'ethereum', 'USDT');
  const token = paymentCoin('ethereum', 'USDT').address;
  f.control.allowances.set(token + ':' + UNISWAP.ethereum.router, 1n);
  const { state } = await publishJob(f.options);
  assert.deepEqual(state.funding.steps.map((step) => step.kind), ['reset_source_allowance', 'approve_source', 'swap', 'approve_imd']);
  const txs = f.control.broadcasts.slice(0, 2).map(parseTransaction);
  assert.deepEqual(txs.map((tx) => decodeFunctionData({ abi: erc20Abi, data: tx.data }).args[1]), [0n, BigInt(state.funding.amountIn)]);
});

test('unavailable exchange routes stop before authorization', async (t) => {
  const f = await fixture(t);
  f.control.noRoute = true;
  await assert.rejects(publishJob(f.options), /No available exchange route/);
  assert.equal(f.control.broadcasts.length, 0);
});

test('declining the combined review signs neither approvals, swap nor task payment', async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishJob({ ...f.options, confirm: async () => { throw new Error('declined'); } }), /declined/);
  assert.equal(f.control.broadcasts.length, 0);
  const state = await findOrder(f.home, ORDER);
  assert.ok(orderSummary(state).canCancel);
});

for (const acceptBroadcast of [true, false]) {
  test(`lost swap broadcast response (accepted=${acceptBroadcast}) resumes the same bytes without another purchase`, async (t) => {
    const f = await fixture(t, 'robinhood', 'ETH');
    f.control.dropAt = 1;
    f.control.acceptBroadcast = acceptBroadcast;
    await assert.rejects(publishJob(f.options), /lost broadcast response/i);
    const original = f.control.broadcasts[0];
    const saved = await findOrder(f.home, ORDER);
    assert.equal(saved.funding.steps[0].rawTransaction, original);
    assert.equal(orderSummary(saved).canCancel, false);
    f.control.dropBroadcast = false;
    f.control.acceptBroadcast = true;
    const resumed = await submitOrder({ ...f.options, paymentChain: 'ethereum', payWith: 'USDC', id: ORDER });
    assert.equal(resumed.status, 'admitted');
    const swapBytes = f.control.broadcasts.filter((raw) => parseTransaction(raw).to.toLowerCase() === UNISWAP.robinhood.router);
    assert.equal(new Set(swapBytes).size, 1);
    assert.equal(swapBytes.length, acceptBroadcast ? 1 : 2);
    assert.equal(resumed.paymentChain, 'robinhood');
    assert.equal(resumed.payWith, 'ETH');
  });
}

test('a reverted swap is retained and is never automatically purchased again', async (t) => {
  const f = await fixture(t, 'robinhood', 'ETH');
  f.control.reverted = true;
  await assert.rejects(publishJob(f.options), /transaction reverted/);
  f.control.reverted = false;
  await assert.rejects(submitOrder({ ...f.options, id: ORDER }), /No replacement swap/);
  assert.equal(f.control.broadcasts.length, 1);
});

test('existing IMD is not silently spent instead of the selected payment coin', async (t) => {
  const f = await fixture(t);
  f.control.balances.set(IMD_TOKENS.ethereum, 1000n * 10n ** 18n);
  const result = await publishJob(f.options);
  assert.equal(result.state.funding.minimumOut, '500000000000000000');
  assert.equal(result.state.funding.steps.filter((step) => step.kind === 'swap').length, 1);
});

for (const args of [
  ['task', 'publish', '--file', 'examples/research-job.json'],
  ['task', 'create', 'Coffee site', '--preset', 'report'],
  ['task', 'continue', PARENT, 'Coffee site', '--template', 'same'],
]) {
  test(`CLI ${args[1]} publishes with USDG auto conversion`, async (t) => {
    const f = await fixture(t, 'robinhood', 'USDG');
    if (args[1] === 'continue') f.control.action = 'job.continue';
    const output = await runEntry([
      '--home', f.home, '--api', f.url, '--rpc', f.options.rpc,
      '--payment-chain', 'robinhood', '--yes', '--json', ...args, '--pay-with', 'usdg',
    ]);
    assert.equal(output.status, 0, output.stderr);
    const result = JSON.parse(output.stdout);
    assert.equal(result.status, 'admitted');
    assert.equal(result.payWith, 'USDG');
    assert.equal(result.paymentChain, 'robinhood');
    assert.equal(f.control.broadcasts.length, 4);
    assert.doesNotMatch(output.stdout, /rawTransaction|requestToken|quoteSignature|paymentHeader/);
  });
}

test('stopping a pending swap preserves it and recovery only waits for that transaction', async (t) => {
  const f = await fixture(t, 'robinhood', 'ETH');
  f.control.pendingReceipt = true;
  const abort = new AbortController();
  const pending = publishJob({ ...f.options, signal: abort.signal });
  const rejected = assert.rejects(pending, /abort/i);
  while (f.control.broadcasts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  abort.abort();
  await rejected;
  f.control.pendingReceipt = false;
  const result = await submitOrder({ ...f.options, id: ORDER });
  assert.equal(result.status, 'admitted');
  assert.equal(f.control.broadcasts.filter((raw) => parseTransaction(raw).to.toLowerCase() === UNISWAP.robinhood.router).length, 1);
});
