import { formatUnits } from 'viem';
import { paymentNetwork } from './payment-networks.mjs';

export const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const IMD_TOKENS = {
  ethereum: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
  robinhood: '0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127',
};
const TOKENS = {
  ethereum: { USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
  robinhood: { USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' },
};

export function coinSymbol(value = 'IMD') {
  const symbol = value.toUpperCase();
  if (!['IMD', 'ETH', 'USDC', 'USDT', 'USDG'].includes(symbol)) throw new Error('Choose a payment coin: IMD, ETH, USDC, USDT or USDG.');
  return symbol;
}

export function coinDecimals(symbol) {
  return ['IMD', 'ETH'].includes(coinSymbol(symbol)) ? 18 : 6;
}

export function paymentCoins(network) {
  paymentNetwork(network);
  return [
    { symbol: 'IMD', address: IMD_TOKENS[network], decimals: 18 },
    { symbol: 'ETH', address: NATIVE_TOKEN, decimals: 18 },
    ...Object.entries(TOKENS[network]).map(([symbol, address]) => ({ symbol, address, decimals: 6 })),
  ];
}

export function paymentCoin(network, value) {
  const symbol = coinSymbol(value);
  const coin = paymentCoins(network).find((coin) => coin.symbol === symbol);
  if (!coin) throw new Error(`${symbol} payments are not supported on ${paymentNetwork(network).chain.name}.`);
  return coin;
}

export function coinAmount(amount, symbol) {
  return `${formatUnits(BigInt(amount), coinDecimals(symbol))} ${coinSymbol(symbol)}`;
}

// Short, readable amounts for people: stablecoins keep cents, other coins
// keep four significant digits. Amounts someone must send are rounded up so
// the displayed figure is never slightly too small.
export function friendlyAmount(amount, symbol, { up = false } = {}) {
  const value = BigInt(amount);
  const decimals = coinDecimals(symbol);
  const label = coinSymbol(symbol);
  if (value === 0n) return '0 ' + label;
  const digits = value.toString().length;
  const stable = decimals === 6;
  let fraction = stable && value >= 10n ** BigInt(decimals - 2) ? 2 : Math.max(0, 4 - digits + decimals);
  fraction = Math.min(fraction, decimals);
  const scale = 10n ** BigInt(decimals - fraction);
  let units = value / scale;
  const remainder = value % scale;
  if (up ? remainder > 0n : remainder * 2n >= scale) units += 1n;
  return formatUnits(units, fraction) + ' ' + label;
}
