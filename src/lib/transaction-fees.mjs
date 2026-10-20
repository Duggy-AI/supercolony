const increase = (value, percent) => (value * percent + 99n) / 100n;
const ETHEREUM_MIN_PRIORITY_FEE = 100_000_000n; // 0.1 gwei inclusion policy.

// Prefer timely inclusion: recent 75th-percentile tips plus 25%, with about
// nine full blocks of Ethereum base-fee headroom. L2 retains its own estimator.
export async function transactionFees(client, chainId) {
  if (chainId !== 1) {
    const fees = await client.estimateFeesPerGas();
    return { maxFeePerGas: increase(fees.maxFeePerGas, 150n),
      maxPriorityFeePerGas: increase(fees.maxPriorityFeePerGas, 125n) };
  }
  const [history, suggested] = await Promise.all([
    client.getFeeHistory({ blockCount: 5, blockTag: 'latest', rewardPercentiles: [75] }),
    client.estimateMaxPriorityFeePerGas(),
  ]);
  const tips = history.reward.map(([tip]) => tip).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const median = tips[Math.floor(tips.length / 2)];
  const marketTip = suggested > median ? suggested : median;
  const boostedTip = increase(marketTip, 125n);
  const maxPriorityFeePerGas = boostedTip > ETHEREUM_MIN_PRIORITY_FEE ? boostedTip : ETHEREUM_MIN_PRIORITY_FEE;
  const baseFeePerGas = history.baseFeePerGas.at(-1);
  return { maxPriorityFeePerGas, maxFeePerGas: baseFeePerGas * 3n + maxPriorityFeePerGas, baseFeePerGas };
}

export function reviewedFees(fees, reviewed) {
  const maxFeePerGas = BigInt(reviewed.maxFeePerGas);
  const required = fees.baseFeePerGas === undefined ? fees.maxFeePerGas : fees.baseFeePerGas + fees.maxPriorityFeePerGas;
  if (required > maxFeePerGas) {
    throw Object.assign(new Error('Network fees changed. Refreshing the payment review before signing.'), { code: 'payment_review_expired' });
  }
  return { maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
}
