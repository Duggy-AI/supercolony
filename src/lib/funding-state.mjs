import { formatEther } from 'viem';
import { coinAmount, friendlyAmount } from './payment-coins.mjs';

export function fundingSummary(funding) {
  return {
    coin: funding.coin, amount: coinAmount(funding.amountIn, funding.coin),
    estimatedAmount: funding.quotedInput === undefined ? undefined : coinAmount(funding.quotedInput, funding.coin),
    minimumImd: coinAmount(funding.minimumOut, 'IMD'), maximumDebit: coinAmount(funding.maximumDebit, funding.coin),
    networkFeeCap: formatEther(BigInt(funding.feeCap)),
    display: {
      payment: friendlyAmount(funding.amountIn, funding.coin, { up: true }),
      ...(funding.quotedInput === undefined ? {} : { estimate: friendlyAmount(funding.quotedInput, funding.coin, { up: true }) }),
      gas: friendlyAmount(funding.feeCap, 'ETH', { up: true }),
      maximumDebit: friendlyAmount(funding.maximumDebit, funding.coin, { up: true }),
    },
    converted: funding.steps.some(step => step.kind === 'swap' && step.status === 'confirmed')
      && !funding.steps.some(step => step.kind === 'swap' && step.status !== 'confirmed'),
    steps: funding.steps.map(({ kind, hash, confirmedHash, status }) => ({ kind, hash: confirmedHash ?? hash, status })),
  };
}
