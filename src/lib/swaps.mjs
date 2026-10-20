import { ContractFunctionRevertedError, encodeFunctionData, encodePacked, parseAbi } from 'viem';
import { IMD_TOKENS, paymentCoin } from './payment-coins.mjs';

// Official deployments: https://developers.uniswap.org/deployments.json
export const UNISWAP = {
  ethereum: {
    router: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
    weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  },
  robinhood: {
    router: '0xcaf681a66d020601342297493863e78c959e5cb2',
    quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
    weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  },
};
export const QUOTER_ABI = parseAbi([
  'function quoteExactOutput(bytes path,uint256 amountOut) returns(uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
]);
export const SWAP_ABI = parseAbi([
  'function exactOutput((bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum) params) payable returns(uint256 amountIn)',
  'function refundETH() payable',
  'function multicall(uint256 deadline,bytes[] data) payable returns(bytes[])',
]);
export const APPROVAL_GAS = 100_000n;
const FEES = [100, 500, 3000, 10000];
const ceilDiv = (a, b) => (a + b - 1n) / b;

// Gas/value heuristic used by Uniswap's historical auto-slippage hook:
// https://github.com/Uniswap/interface/blob/682215a574d9b3164bc7ce0587f84de080edf8ed/src/hooks/useAutoSlippageTolerance.ts
// Use the exact-output input quote as the trade value, in the same coin as gas.
// Colony adds 25% headroom, raises the floor to 0.75%, and retains the 5% ceiling.
// Low L2 gas costs are not a useful signal, so Robinhood uses the floor.
export function autoSlippageBps(network, swapGasCost, quotedInput) {
  if (network === 'robinhood') return 75;
  const bps = ceilDiv(swapGasCost * 12500n, quotedInput);
  return Number(bps < 75n ? 75n : bps > 500n ? 500n : bps);
}

// Exact-output paths are encoded from output back to input.
export function encodePath(tokens, fees) {
  const reversed = [...tokens].reverse();
  const types = ['address'];
  const values = [reversed[0]];
  for (const [i, fee] of [...fees].reverse().entries()) {
    types.push('uint24', 'address');
    values.push(fee, reversed[i + 1]);
  }
  return encodePacked(types, values);
}

export function swapPaths(network, coin) {
  const { weth } = UNISWAP[network];
  const imd = IMD_TOKENS[network];
  const path = (tokens, fees) => ({ path: encodePath(tokens, fees) });
  if (network === 'robinhood') {
    if (coin.symbol === 'ETH') return [path([weth, imd], [3000])];
    return [path([coin.address, imd], [10000]), ...FEES.map(fee => path([coin.address, weth, imd], [fee, 3000]))];
  }
  if (coin.symbol === 'ETH') return [
    path([weth, imd], [10000]),
    ...['USDC', 'USDT'].flatMap(symbol => FEES.map(fee => path([weth, paymentCoin(network, symbol).address, imd], [fee, 3000]))),
  ];
  const other = paymentCoin(network, coin.symbol === 'USDC' ? 'USDT' : 'USDC').address;
  return [path([coin.address, imd], [3000]), ...FEES.map(fee => path([coin.address, other, imd], [fee, 3000]))];
}

async function quote(client, network, path, target, blockNumber) {
  try {
    const { result } = await client.simulateContract({
      address: UNISWAP[network].quoter, abi: QUOTER_ABI,
      functionName: 'quoteExactOutput', args: [path, target], blockNumber,
    });
    return { path, quotedInput: result[0], gas: result[3] * 2n + 100_000n };
  } catch (error) {
    // A reverted pool quote is an unavailable candidate. RPC/network errors are
    // not liquidity signals: surface them rather than silently choosing a route.
    if (error.walk?.(cause => cause instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) return null;
    throw error;
  }
}

export async function quoteSwap(network, coin, target, {
  client, maxFeePerGas, sourceAllowance = 0n, fixedGas = 0n, signal,
}) {
  signal?.throwIfAborted();
  const blockNumber = await client.getBlockNumber();
  const paths = swapPaths(network, coin);
  const quoted = (await Promise.all(paths.map(p => quote(client, network, p.path, target, blockNumber)))).filter(Boolean);
  if (!quoted.length) throw new Error('No available exchange route can buy the required IMD. Please try again later.');
  // Value ETH gas in the chosen coin using a small onchain WETH purchase quote.
  // This is only a comparison unit; gas is still paid separately in ETH.
  const gasUnit = 10n ** 15n;
  let gasPriceInCoin = gasUnit;
  if (coin.symbol !== 'ETH') {
    const prices = (await Promise.all(FEES.map(fee => quote(client, network,
      encodePath([coin.address, UNISWAP[network].weth], [fee]), gasUnit, blockNumber)))).filter(Boolean);
    if (!prices.length) throw new Error('Cannot compare exchange costs right now. Please try again later.');
    gasPriceInCoin = prices.reduce((best, p) => p.quotedInput < best ? p.quotedInput : best, prices[0].quotedInput);
  }
  signal?.throwIfAborted();
  const candidates = quoted.map(route => {
    // Only the swap contributes to slippage; approvals and task payments do not.
    const swapGasCost = ceilDiv(route.gas * maxFeePerGas * gasPriceInCoin, gasUnit);
    const slippageBps = autoSlippageBps(network, swapGasCost, route.quotedInput);
    const amountIn = ceilDiv(route.quotedInput * (10000n + BigInt(slippageBps)), 10000n);
    const baseFees = (route.gas + fixedGas) * maxFeePerGas;
    const approvalGas = coin.symbol !== 'ETH' && sourceAllowance < amountIn
      ? APPROVAL_GAS * (coin.symbol === 'USDT' && sourceAllowance > 0n ? 2n : 1n) : 0n;
    const feeCap = baseFees + approvalGas * maxFeePerGas;
    return { ...route, slippageBps, amountIn, feeCap, maximumDebit: amountIn + (coin.symbol === 'ETH' ? feeCap : 0n),
      totalCost: route.quotedInput + ceilDiv(feeCap * gasPriceInCoin, gasUnit) };
  });
  return candidates.reduce((best, route) => route.totalCost < best.totalCost ? route : best);
}

export function buildSwap(network, coin, route, target, account, expiresAt) {
  const calls = [encodeFunctionData({ abi: SWAP_ABI, functionName: 'exactOutput', args: [{
    path: route.path, recipient: account, amountOut: target, amountInMaximum: BigInt(route.amountIn),
  }] })];
  if (coin.symbol === 'ETH') calls.push(encodeFunctionData({ abi: SWAP_ABI, functionName: 'refundETH' }));
  return { to: UNISWAP[network].router,
    data: encodeFunctionData({ abi: SWAP_ABI, functionName: 'multicall', args: [BigInt(expiresAt), calls] }),
    value: coin.symbol === 'ETH' ? String(route.amountIn) : '0' };
}
