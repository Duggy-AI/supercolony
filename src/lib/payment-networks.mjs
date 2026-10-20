import { mainnet, robinhood } from 'viem/chains';

export const PAYMENT_NETWORKS = [
  { key: 'ethereum', chain: mainnet },
  { key: 'robinhood', chain: robinhood },
];

export function paymentNetwork(key) {
  const network = PAYMENT_NETWORKS.find((entry) => entry.key === key);
  if (!network) throw new Error('Choose a payment network: ethereum or robinhood.');
  return network;
}

export function networkName(key) {
  return paymentNetwork(key ?? 'ethereum').chain.name;
}

// Colony picks the payment network per task from the wallet's balances.
// Commands that act on a single network use --payment-chain or Ethereum.
export function selectedPaymentNetwork(options) {
  return paymentNetwork(options.paymentChain ?? 'ethereum');
}
