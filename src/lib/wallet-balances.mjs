import { erc20Abi, formatUnits } from 'viem';
import { paymentCoins } from './payment-coins.mjs';

export async function walletBalances(client, network, address) {
  return Promise.all(paymentCoins(network).map(async (coin) => {
    const amount = coin.symbol === 'ETH' ? await client.getBalance({ address })
      : await client.readContract({ address: coin.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    return { ...coin, amount: String(amount), balance: formatUnits(amount, coin.decimals) };
  }));
}
