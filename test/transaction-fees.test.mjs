import assert from 'node:assert/strict';
import test from 'node:test';
import { transactionFees, reviewedFees } from '../src/lib/transaction-fees.mjs';

test('Ethereum uses recent upper-quartile tips with headroom rather than a zero RPC suggestion', async () => {
  const fees = await transactionFees({
    getFeeHistory: async params => {
      assert.deepEqual(params, { blockCount: 5, blockTag: 'latest', rewardPercentiles: [75] });
      return { baseFeePerGas: [200000000n, 220000000n], reward: [[100000000n], [300000000n], [200000001n], [100000000n], [900000000n]] };
    },
    estimateMaxPriorityFeePerGas: async () => 0n,
  }, 1);
  assert.equal(fees.maxPriorityFeePerGas, 250000002n, 'round atomic units upward');
  assert.equal(fees.maxFeePerGas, 910000002n);
  assert.deepEqual(reviewedFees(fees, fees), { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
});

test('Ethereum keeps a positive priority fee in zero-tip blocks and honors a higher RPC suggestion', async () => {
  const client = { getFeeHistory: async () => ({ baseFeePerGas: [1n], reward: Array(5).fill([0n]) }),
    estimateMaxPriorityFeePerGas: async () => 0n };
  assert.equal((await transactionFees(client, 1)).maxPriorityFeePerGas, 100000000n);
  client.estimateMaxPriorityFeePerGas = async () => 400000000n;
  assert.equal((await transactionFees(client, 1)).maxPriorityFeePerGas, 500000000n);
});

test('Robinhood adds headroom to its own estimates without importing the Ethereum minimum tip', async () => {
  const fees = await transactionFees({ estimateFeesPerGas: async () => ({ maxFeePerGas: 101n, maxPriorityFeePerGas: 0n }) }, 4663);
  assert.deepEqual(fees, { maxFeePerGas: 152n, maxPriorityFeePerGas: 0n });
  assert.throws(() => reviewedFees(fees, { maxFeePerGas: '151' }), { code: 'payment_review_expired' });
  assert.deepEqual(await transactionFees({ estimateFeesPerGas: async () => ({ maxFeePerGas: 101n, maxPriorityFeePerGas: 5n }) }, 4663),
    { maxFeePerGas: 152n, maxPriorityFeePerGas: 7n });
});
