import { request } from '../shared.mjs';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { paymentNetwork } from './payment-networks.mjs';
import { IMD_TOKENS } from './payment-coins.mjs';

export function assertQuotePayment(payment) {
  const asset = { 'eip155:1': IMD_TOKENS.ethereum, 'eip155:4663': IMD_TOKENS.robinhood }[payment.network];
  if (payment.asset.toLowerCase() !== asset || payment.decimals !== 18) {
    throw new Error('The quote currency must be the supported IMD token with 18 decimals; no payment will be made');
  }
  if (!/^\d+$/.test(String(payment.amount))) throw new Error('Invalid quote amount');
}

export async function loadPaymentConfig(api, actionName = 'job.open', network = 'ethereum', { signal } = {}) {
  const response = await request(api, '/requests/capabilities', { signal });
  const actions = response.data?.actions;
  if (!Array.isArray(actions)) throw new Error('capabilities response is missing actions');
  const action = actions.find((entry) => entry.action === actionName);
  if (!action?.payment) throw new Error(`action is not enabled: ${actionName}`);

  if (network === 'robinhood') {
    const chainId = paymentNetwork(network).chain.id;
    const entry = response.data.onchain?.chains.find((entry) => entry.chainId === chainId);
    const priced = entry?.actions.find((entry) => entry.action === actionName);
    if (!priced) throw new Error(`${actionName} is not enabled on Robinhood Chain.`);
    return {
      action, chainId, spender: entry.intake,
      payment: { network: entry.network, asset: entry.asset, amount: priced.amount, decimals: entry.decimals, payTo: entry.payTo },
    };
  }

  const payment = action.payment;
  const match = /^eip155:(\d+)$/.exec(String(payment.network));
  if (!match) throw new Error(`unsupported payment network: ${payment.network}`);
  const chainId = Number(match[1]);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`invalid chain id in payment network: ${payment.network}`);
  }
  if (chainId !== paymentNetwork(network).chain.id) throw new Error('The payment network returned by IMD does not match Ethereum.');
  return { action, payment, chainId, spender: PERMIT2_ADDRESS };
}

export function onchainTerms(state) {
  const terms = state.onchainQuotes?.find((entry) => entry.chainId === 4663);
  if (!terms) throw new Error('This order has no Robinhood payment quote. No payment was signed.');
  const hash = '0x' + state.quote.quoteHash.replace(/^0x/, '');
  if (terms.quoteHash.toLowerCase() !== hash.toLowerCase() || terms.expiresAt !== state.quote.expiresAt) {
    throw new Error('The Robinhood payment terms do not match this order.');
  }
  return terms;
}

export function orderPayment(state) {
  if (state.paymentChain !== 'robinhood') return state.quote.payment;
  const terms = onchainTerms(state);
  return { ...state.quote.payment, network: 'eip155:4663', amount: terms.amount, asset: terms.asset };
}
