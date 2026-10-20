import { getPublicRpcClient } from '../shared.mjs';
import { planFunding } from './funding.mjs';
import { fundingRequiredOptions } from './funding-error.mjs';
import { walletInfo } from './local-wallet.mjs';
import { coinSymbol, paymentCoins } from './payment-coins.mjs';
import { PAYMENT_NETWORKS, paymentNetwork } from './payment-networks.mjs';
import { loadPaymentConfig } from './payments.mjs';

// Paying directly in IMD needs no conversion; stablecoins keep ETH free for gas.
const COIN_RANK = { IMD: 0, USDC: 1, USDT: 1, USDG: 1, ETH: 2 };

async function networkOptions(options, network, wallet, action, failures) {
  const entry = { key: network.key, chainName: network.chain.name, chainId: network.chain.id, options: [] };
  const coins = paymentCoins(network.key).filter(coin => !options.payWith || coin.symbol === coinSymbol(options.payWith));
  if (!coins.length) return null;
  try {
    const [config, client] = await Promise.all([
      loadPaymentConfig(options.api, action, network.key, options),
      getPublicRpcClient(options, network.chain.id),
    ]);
    entry.price = String(config.payment.amount);
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    entry.options = await Promise.all(coins.map(async coin => {
      const state = { action, paymentChain: network.key, payWith: coin.symbol, quote: { payment: config.payment, expiresAt } };
      try {
        const { requirement, shortages } = await planFunding(state, options, client, wallet, config);
        return { ...requirement, funded: shortages.length === 0, shortages };
      } catch (error) {
        options.signal?.throwIfAborted();
        return { coin: coin.symbol, error: error.message };
      }
    }));
    if (entry.options.every(option => option.error)) throw new Error(entry.options[0].error);
    entry.nativeBalance = entry.options.find(option => option.nativeBalance !== undefined)?.nativeBalance;
  } catch (error) {
    options.signal?.throwIfAborted();
    failures.push(error);
    entry.error = error.message;
  }
  return entry;
}

export function bestPaymentOption(networks, prefer) {
  const ready = networks.flatMap(network => (network.options ?? []).filter(option => option.funded)
    .map(option => ({ paymentChain: network.key, payWith: option.coin, chainName: network.chainName, option })));
  const preferred = prefer && ready.find(entry => entry.paymentChain === prefer.paymentChain && entry.payWith === prefer.payWith);
  if (preferred) return preferred;
  return ready.sort((a, b) => COIN_RANK[a.payWith] - COIN_RANK[b.payWith]
    || (BigInt(a.option.gas) < BigInt(b.option.gas) ? -1 : BigInt(a.option.gas) > BigInt(b.option.gas) ? 1 : 0))[0] ?? null;
}

// Reads every payment network at once using only the public address.
// options.paymentChain and options.payWith narrow the search when given.
export async function paymentOptions(options) {
  const wallet = walletInfo(options);
  if (!wallet.configured) throw Object.assign(new Error('Create or import a wallet in Wallets before creating a task.'), { code: 'wallet_required' });
  const action = options.action ?? 'job.open';
  const networks = options.paymentChain ? [paymentNetwork(options.paymentChain)] : PAYMENT_NETWORKS;
  const failures = [];
  const results = (await Promise.all(networks.map(network => networkOptions(options, network, wallet, action, failures)))).filter(Boolean);
  if (!results.length) throw new Error(coinSymbol(options.payWith) + ' payments are not supported on ' + networks.map(network => network.chain.name).join(' or ') + '.');
  if (failures.length === results.length) {
    if (failures.length === 1) throw failures[0];
    throw new Error(results.map(network => network.chainName + ': ' + network.error).join('\n'), { cause: failures[0] });
  }
  return { address: wallet.address, networks: results, best: bestPaymentOption(results, options.prefer) };
}

export function paymentOptionLabel(choice) {
  return choice.payWith + ' on ' + choice.chainName;
}

export async function choosePayment(options) {
  const result = await paymentOptions(options);
  if (!result.best) throw fundingRequiredOptions(result.address, result.networks);
  return { address: result.address, paymentChain: result.best.paymentChain, payWith: result.best.payWith,
    chainName: result.best.chainName, networks: result.networks };
}
