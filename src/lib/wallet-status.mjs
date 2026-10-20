import { erc20Abi, formatUnits } from 'viem';
import { getPublicRpcClient } from '../shared.mjs';
import { walletInfo } from './local-wallet.mjs';
import { PAYMENT_NETWORKS, paymentNetwork } from './payment-networks.mjs';
import { loadPaymentConfig } from './payments.mjs';
import { walletBalances } from './wallet-balances.mjs';

export async function networkStatus(options, network, wallet) {
  const configRequest = loadPaymentConfig(options.api, 'job.open', network.key, options);
  const clientRequest = getPublicRpcClient(options, network.chain.id);
  const [config, coins, allowance] = await Promise.all([
    configRequest,
    clientRequest.then(client => walletBalances(client, network.key, wallet.address)),
    Promise.all([configRequest, clientRequest]).then(([{ payment, spender }, client]) =>
      client.readContract({ address: payment.asset, abi: erc20Abi, functionName: 'allowance', args: [wallet.address, spender] })),
  ]);
  const { payment, chainId, spender } = config;
  const imd = coins.find(coin => coin.symbol === 'IMD');
  return { paymentChain: network.key, chainName: network.chain.name, chainId,
    spender, asset: payment.asset, decimals: payment.decimals,
    balance: imd.balance, balanceAtomic: imd.amount,
    allowance: formatUnits(allowance, payment.decimals), allowanceAtomic: String(allowance),
    price: formatUnits(BigInt(payment.amount), payment.decimals), priceAtomic: payment.amount, coins };
}

// Balances on every payment network at once. One unreachable network does
// not hide the others; it is reported on its own entry.
export async function walletStatus(options, wallet = walletInfo(options)) {
  const timeout = AbortSignal.timeout(15_000);
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout };
  if (!wallet.configured) throw new Error('Create or import a wallet first.');
  const networks = options.paymentChain ? [paymentNetwork(options.paymentChain)] : PAYMENT_NETWORKS;
  const results = await Promise.all(networks.map(network => networkStatus(options, network, wallet).catch(error => {
    if (networks.length === 1) throw error;
    return { paymentChain: network.key, chainName: network.chain.name, chainId: network.chain.id, error: error.message };
  })));
  if (results.every(result => result.error)) throw new Error(results.map(result => result.chainName + ': ' + result.error).join('\n'));
  return { ...wallet, networks: results };
}
