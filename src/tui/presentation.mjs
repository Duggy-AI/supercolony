import { terminalText as clean } from '../lib/terminal-text.mjs';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { networkWorkerText } from '../lib/network-workers.mjs';

export { clean };
export function short(value, width) {
  const text = clean(value).replace(/\s+/g, ' ');
  if (stringWidth(text) <= width) return text;
  let result = '';
  for (const char of text) {
    if (stringWidth(result + char) > width - 1) break;
    result += char;
  }
  return result + '~';
}
export function lines(text, width) {
  return wrapAnsi(clean(text), Math.max(1, width), { hard: true, trim: false }).split('\n');
}
export function outputText(output) {
  if (typeof output === 'string') return output;
  if (output && 'stdout' in output) return [output.exitCode ? 'Command failed (exit code ' + output.exitCode + ')' : null, output.stdout, output.stderr].filter(Boolean).join('\n');
  return JSON.stringify(output, null, 2);
}
export function statusLabel(state) {
  return state === 'draft' ? 'Draft' : state === 'challenged' ? 'Awaiting payment'
    : ['expired', 'payment_failed'].includes(state) ? 'Payment needs review'
      : ['transaction_pending', 'payment_reconciling'].includes(state) ? 'Payment result pending'
        : state === 'funding' ? 'Preparing payment' : state === 'cancelled' ? 'Cancelled' : state;
}
const PAYMENT_RECOVERY_STATES = new Set(['expired', 'payment_failed', 'transaction_pending', 'payment_reconciling']);
export function taskActions(item, view) {
  if (!item) return [];
  if (item.draftId) return ['[o] Continue draft', '[m] Actions'];
  if (view === 'explore') return ['[d] Files', '[s] Save', '[v] IMD link'];
  if (item.jobId) return ['[d] Files', '[s] Save', ...(item.state === 'completed' ? ['[c] Changes'] : []), '[m] Actions', '[v] IMD link'];
  return [item.canResume ? '[o] ' + (item.canCancel ? 'Review & pay' : 'Resume') : null, item.canCancel ? '[x] Cancel' : null, '[m] Actions'].filter(Boolean);
}
function walletNetworkText(network) {
  const heading = network.chainName.toUpperCase() + (network.price ? ' · task price ' + network.price + ' IMD' : '');
  if (network.error) return heading + '\nBalances unavailable: ' + network.error;
  return heading + '\n' + network.coins.map(coin => '  ' + coin.symbol + ': ' + coin.balance + (coin.symbol === 'ETH' ? '  (pays gas)' : '')).join('\n');
}
function paymentMethod(detail) {
  return (detail.payWith ?? 'IMD') + ' on ' + (detail.paymentChain === 'robinhood' ? 'Robinhood Chain' : 'Ethereum');
}
export function detailText(state) {
  const item = state.items.find((entry) => entry.id === state.selectedId);
  const detail = state.detail;
  if (state.detailLoading && !(state.view === 'wallet' && detail)) return 'Loading details...';
  if (!detail) return 'Select an item to view details.';
  if (detail.output !== undefined) return outputText(detail.output);
  if (state.view === 'wallet') {
    if (!detail.configured) return 'No wallet selected.\n\nUse Wallet management to create, import or restore a wallet.\n\nYour key is encrypted locally.\nBrowsing does not need a wallet.';
    const current = detail.address === state.address;
    const balances = state.detailLoading && !detail.networks ? 'Loading balances on all networks...'
      : detail.balanceError ? 'Balances unavailable: ' + detail.balanceError
        : (detail.networks ?? []).map(walletNetworkText).join('\n\n');
    return (current ? 'CURRENT WALLET\n' : 'SAVED WALLET\n') + detail.address
      + '\nSame address on Ethereum and Robinhood Chain. Balances are separate per network.'
      + (detail.source === 'local' ? '' : '\nEnvironment wallet · import it here to save it encrypted')
      + '\n\n' + balances
      + '\n\nPaying: Colony picks a network and coin with enough balance for each task. Gas (network fee) is always paid in ETH on the same network.'
      + '\n\n[d] Receive funds / QR code\n[b] Back up this wallet'
      + (current ? '' : '\n[u] Use this wallet for payments')
      + '\n[m] Selected wallet actions';
  }
  if (state.view === 'workers') {
    if (detail.kind === 'network-worker') return networkWorkerText(detail);
    if (detail.notInstalled) return 'Worker not deployed\n\n[m] Open worker actions to deploy the official release, pair a wallet, register, and install its service.';
    if (detail.output) return outputText(detail.output);
    return 'SERVICE\n' + outputText(detail.service) + '\n\nSTANDING\n' + (detail.standing ? outputText(detail.standing) : detail.standingError ?? 'Not available') + '\n\n[m] Worker actions · [l] Logs · [g] Diagnostics';
  }
  if (detail.status === 'draft') {
    return ['YOUR REQUEST', detail.objective, '', 'Status: Draft', 'Saved locally. Not published.',
      ...(detail.parent ? ['Continues task: ' + detail.parent] : []),
      'Payment: picked from your balances when you continue', '',
      state.address ? 'Continue this draft to review and publish.' : 'Create or import a wallet in Wallets, then continue this draft.',
      '', '[o] Continue draft', '[m] Actions · delete draft'].join('\n');
  }
  if (state.tab === 'Files') {
    if (!item?.jobId) return detail.cancelledAt ? 'Cancelled requests do not produce files.' : 'Files become available after payment and task execution.';
    if (!state.result) return 'Press d to fetch the result files.';
    const files = state.result.files ?? [];
    return 'DELIVERED FILES\n\n' + (files.length ? files.map((file) => file.path + '\n' + file.bytes + ' bytes · ' + file.mediaType + '\n' + file.url).join('\n\n') + '\n\n[s] Save verified files' : 'No delivered files yet.\nTask state: ' + state.result.state);
  }
  if (state.tab === 'Activity') {
    if (detail.cancelledAt) return 'REQUEST CANCELLED\n\nCancelled locally: ' + detail.cancelledAt + '\nNo payment was signed or submitted.';
    if (detail.funding) return 'PAYMENT PREPARATION\n\n' + detail.funding.steps.map((step) => step.kind.replaceAll('_', ' ') + ': ' + (step.status ?? 'not started') + (step.hash ? '\n' + step.hash : '')).join('\n\n');
    return 'EXECUTION\n\n' + (detail.nodes?.length ? detail.nodes.map((node) => node.key + ': ' + node.state + '\nAttempt: ' + node.attempt + (node.verdict ? '\nVerdict: ' + node.verdict.status : '')).join('\n\n') : 'No execution steps reported yet.') + (detail.reviews?.length ? '\n\nREVIEWS\n' + outputText(detail.reviews) : '');
  }
  const status = detail.state ?? detail.status ?? item?.state ?? 'unknown';
  const pendingTransaction = detail.pendingTransaction ?? detail.transaction;
  const recovery = PAYMENT_RECOVERY_STATES.has(status) || Boolean(pendingTransaction?.hash);
  const parts = ['YOUR REQUEST', detail.objective ?? item?.title ?? '', '', 'Status: ' + statusLabel(status)];
  if (detail.template) parts.push('Type: ' + detail.template);
  if (detail.project) parts.push('Project: ' + detail.project.id);
  if (detail.paidBy) parts.push('Paid by: ' + detail.paidBy);
  if (detail.paymentStatus) parts.push('Payment: ' + detail.paymentStatus);
  if (pendingTransaction?.hash) parts.push('Transaction: ' + pendingTransaction.hash + (pendingTransaction.kind ? ' (' + pendingTransaction.kind + ')' : ''));
  if (pendingTransaction?.reason) parts.push('Payment note: ' + pendingTransaction.reason);
  if (pendingTransaction?.explorerUrl) parts.push('Explorer: ' + pendingTransaction.explorerUrl);
  if (recovery) parts.push('', 'PAYMENT RECOVERY', 'Payment needs review. Continue payment to check the original payment before retrying.');
  const network = detail.paymentChain ?? item?.paymentChain;
  if (network) parts.push('Pay with: ' + paymentMethod({ ...detail, paymentChain: network }) + (item?.canCancel ? ' · can change before paying' : ''));
  if (detail.funding) {
    const display = detail.funding.display ?? {};
    parts.push('', 'PAYMENT PLAN',
      ...(detail.funding.coin === 'IMD' ? [] : ['Payment: at most ' + (display.payment ?? detail.funding.amount) + ', converted to IMD']),
      'Gas (network fee, ETH): at most ' + (display.gas ?? detail.funding.networkFeeCap + ' ETH'),
      'Activity shows the saved transaction progress.');
  }
  if (detail.delivery) parts.push('', 'DELIVERY', outputText(detail.delivery));
  if (detail.launch) parts.push('', 'LAUNCH', outputText(detail.launch));
  if (detail.refusalProblems?.length) parts.push('', 'REFUSED', ...detail.refusalProblems.map((problem) => problem.detail ?? problem.code));
  if (detail.lastError) parts.push('', 'LAST ERROR', detail.lastError);
  if (detail.orderId) parts.push('', 'Order: ' + detail.orderId);
  if (detail.transactionHash) parts.push('Transaction: ' + detail.transactionHash);
  if (!item?.jobId) {
    if (detail.cancelledAt) parts.push('', 'Cancelled locally. No payment was signed or submitted.', '[m] Actions · delete local record');
    else {
      if (item?.canResume) parts.push('', item.canCancel ? '[o] Review quote and pay' : '[o] Inspect / resume saved order', recovery ? 'Continue payment to check the original payment.' : 'Continue here after adding funds. Unpaid quotes and exchange rates are refreshed.');
      if (item?.canCancel) parts.push('[x] Cancel request · no payment');
      if (!item?.canCancel && item?.requestKey) parts.push('', 'Check the payment result before retrying. This order cannot currently be cancelled from Colony.');
    }
  } else if (state.view === 'tasks') parts.push('', '[m] Task actions', 'Published tasks cannot currently be cancelled or refunded from Colony.');
  return parts.join('\n');
}
