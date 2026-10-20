import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractFunctionRevertedError, decodeFunctionData } from 'viem';
import { autoSlippageBps, buildSwap, quoteSwap, swapPaths, SWAP_ABI, UNISWAP } from '../src/lib/swaps.mjs';
import { paymentCoin } from '../src/lib/payment-coins.mjs';

function fixture(coin = 'USDC') {
  const token = paymentCoin('ethereum', coin);
  const paths = swapPaths('ethereum', token);
  const routes = new Map(paths.map(p => [p.path, { input: 3000000n, gas: 100000n }]));
  const blocks = [];
  const client = {
    getBlockNumber: async () => 123n,
    simulateContract: async ({ args: [path], blockNumber }) => {
      blocks.push(blockNumber);
      const route = routes.get(path);
      if (route instanceof Error) throw route;
      return { result: route ? [route.input, [], [], route.gas] : [2500000n, [], [], 100000n] };
    },
  };
  const options = { client, maxFeePerGas: 1000000000n, fixedGas: 100000n };
  return { token, paths, routes, blocks, options, run: (overrides={}) => quoteSwap('ethereum', token, 500000000000000000n, { ...options, ...overrides }) };
}

test('cost comparison chooses a slightly dearer swap when it saves more in gas', async () => {
  const f = fixture();
  f.routes.set(f.paths[0].path, { input: 3000000n, gas: 50000n });
  f.routes.set(f.paths[1].path, { input: 2900000n, gas: 250000n });
  assert.equal((await f.run()).path, f.paths[0].path);
  assert.ok(f.blocks.every(block => block === 123n));
});

test('a cheaper multi-hop path wins when its saving outweighs gas', async () => {
  const f = fixture();
  f.routes.set(f.paths[1].path, { input: 2000000n, gas: 200000n });
  assert.equal((await f.run()).path, f.paths[1].path);
});

test('existing allowance can change the lowest total cost route', async () => {
  const f = fixture('USDT');
  f.routes.set(f.paths[0].path, { input: 3000000n, gas: 50000n });
  f.routes.set(f.paths[1].path, { input: 2900000n, gas: 80000n });
  assert.equal((await f.run()).path, f.paths[0].path);
  // The cheaper input fits this allowance and avoids reset + approval gas.
  assert.equal((await f.run({ sourceAllowance: 3045000n })).path, f.paths[1].path);
});

test('Ethereum auto slippage uses gas/trade value with headroom, a floor and a ceiling', () => {
  assert.equal(autoSlippageBps('ethereum', 0n, 1000000n), 75);
  assert.equal(autoSlippageBps('ethereum', 6000n, 1000000n), 75);
  assert.equal(autoSlippageBps('ethereum', 10000n, 1000000n), 125);
  assert.equal(autoSlippageBps('ethereum', 10001n, 1000000n), 126);
  assert.equal(autoSlippageBps('ethereum', 40000n, 1000000n), 500);
  assert.equal(autoSlippageBps('ethereum', 1000000n, 1000000n), 500);
  assert.equal(autoSlippageBps('ethereum', 10n ** 28n, 10n ** 30n), 125);
  assert.equal(autoSlippageBps('robinhood', 0n, 1000000n), 75);
  assert.equal(autoSlippageBps('robinhood', 1000000n, 1000000n), 75);
});

test('the reviewed maximum caps auto slippage at 5% for a small high-gas swap', async () => {
  const f = fixture();
  const route = await f.run();
  assert.equal(route.slippageBps, 500);
  assert.equal(route.amountIn, 3150000n);
  assert.equal(route.quotedInput, 3000000n);
});

test('auto slippage values swap gas in the input coin, excluding unrelated payment and approval gas', async () => {
  const f = fixture();
  // 300k swap gas at 0.04 gwei costs 30,000 USDC atomic units (1% of the quote).
  const route = await f.run({ maxFeePerGas: 40000000n });
  assert.equal(route.slippageBps, 125);
  assert.equal(route.amountIn, 3037500n);
  const withOtherFees = await f.run({ maxFeePerGas: 40000000n, fixedGas: 50000000n, sourceAllowance: 10n ** 20n });
  assert.equal(withOtherFees.slippageBps, 125);
  assert.equal(withOtherFees.amountIn, route.amountIn);
  assert.notEqual(withOtherFees.feeCap, route.feeCap);
  // Same economic quote with 18-decimal input units instead of 6 decimals.
  const factor = 10n ** 12n;
  const scaledClient = { ...f.options.client, simulateContract: async args => {
    const { result } = await f.options.client.simulateContract(args);
    return { result: [result[0] * factor, ...result.slice(1)] };
  } };
  const scaled = await f.run({ maxFeePerGas: 40000000n, client: scaledClient });
  assert.equal(scaled.slippageBps, 125);
  assert.equal(scaled.amountIn, route.amountIn * factor);
});

test('low-gas quotes round the 0.75% maximum input upwards to a whole atomic unit', async () => {
  const f = fixture();
  for (const p of f.paths) f.routes.set(p.path, { input: 3000001n, gas: 100000n });
  const route = await f.run({ maxFeePerGas: 1n });
  assert.equal(route.slippageBps, 75);
  assert.equal(route.amountIn, 3022502n);
});

test('Robinhood exact-output quotes keep 0.75% tolerance regardless of gas costs', async () => {
  for (const symbol of ['ETH', 'USDG']) {
    const coin = paymentCoin('robinhood', symbol);
    const client = { getBlockNumber: async () => 123n,
      simulateContract: async () => ({ result: [1000000n, [], [], 100000n] }) };
    const route = await quoteSwap('robinhood', coin, 500000000000000000n, { client, maxFeePerGas: 1000000000n });
    assert.equal(route.slippageBps, 75);
    assert.equal(route.amountIn, 1007500n);
  }
});

test('the reviewed ETH maximum debit includes capped network fees', async () => {
  const f = fixture('ETH');
  for (const p of f.paths) f.routes.set(p.path, { input: 1000000000000000n, gas: 50000n });
  const route = await f.run();
  assert.equal(route.slippageBps, 500);
  assert.equal(route.amountIn, 1050000000000000n);
  assert.equal(route.maximumDebit, 1350000000000000n);
});

test('unavailable paths are excluded, but infrastructure failures are reported', async () => {
  const f = fixture();
  const reverted = new ContractFunctionRevertedError({ abi: [], functionName: 'quoteExactOutput', data: '0x' });
  f.routes.set(f.paths[0].path, reverted);
  assert.equal((await f.run()).path, f.paths[1].path);
  const disconnected = new Error('RPC disconnected');
  f.routes.set(f.paths[0].path, disconnected);
  await assert.rejects(f.run(), error => error === disconnected);
  for (const p of f.paths) f.routes.set(p.path, reverted);
  await assert.rejects(f.run(), /No available exchange route/);
});

test('large quotes have no independent price ceiling or price-impact veto', async () => {
  const f = fixture();
  for (const p of f.paths) f.routes.set(p.path, { input: 100000000n, gas: 100000n });
  assert.equal((await f.run()).quotedInput, 100000000n);
});

test('native exact-output call fixes recipient, output, deadline and max input and refunds ETH', () => {
  const coin = paymentCoin('robinhood', 'ETH');
  const path = swapPaths('robinhood', coin)[0].path;
  const account = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  const transaction = buildSwap('robinhood', coin, { path, amountIn: 100n }, 50n, account, 123456);
  assert.equal(transaction.to, UNISWAP.robinhood.router);
  assert.equal(transaction.value, '100');
  const { args: [deadline, calls] } = decodeFunctionData({ abi: SWAP_ABI, data: transaction.data });
  assert.equal(deadline, 123456n);
  const { args: [swap] } = decodeFunctionData({ abi: SWAP_ABI, data: calls[0] });
  assert.equal(swap.path, path);
  assert.equal(swap.recipient.toLowerCase(), account);
  assert.equal(swap.amountOut, 50n);
  assert.equal(swap.amountInMaximum, 100n);
  assert.equal(decodeFunctionData({ abi: SWAP_ABI, data: calls[1] }).functionName, 'refundETH');
});
