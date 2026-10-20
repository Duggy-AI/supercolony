import { choosePayment } from './payment-options.mjs';

// Uses the public address only. No wallet password or model download is needed.
// Returns the network and coin this wallet can already pay with, or throws
// funding_required describing every network side by side.
export async function checkTaskWallet(options) {
  return choosePayment({ ...options, action: options.action ?? 'job.open' });
}
