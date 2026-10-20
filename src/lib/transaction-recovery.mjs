import { formatEther, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { confirmAction, getRpcClients, getSigner } from '../shared.mjs';
import { assertOrderNotCancelled, findOrder, saveOrder } from './orders.mjs';
import { pendingTransaction, submitTransaction, transactionReceipt, TRANSACTION_LABELS } from './transactions.mjs';
import { transactionFees, reviewedFees } from './transaction-fees.mjs';
import { fundingRequired } from './funding-error.mjs';

const bump = value => (value * 1125n + 999n) / 1000n + 1n;
const max = (a, b) => a > b ? a : b;

// An expired contract call may still occupy the pending nonce. Reuse that
// slot for the newly reviewed operation instead of queueing behind it.
export function retainExpiredNonce(state, transaction) {
  state.replacementNonce = parseTransaction(transaction.rawTransaction).nonce;
}

export async function recoveryNonce(state, client, address) {
  if (state.replacementNonce === undefined) return undefined;
  const consumed = await client.getTransactionCount({ address, blockTag: 'latest' });
  return consumed > state.replacementNonce ? undefined : state.replacementNonce;
}

export async function retireExpiredSwap(state, step, client, options) {
  if (step.kind !== 'swap' || step.expiresAt * 1000 > Date.now()) return false;
  const [block, receipt] = await Promise.all([
    client.getBlock({ blockTag: 'finalized' }), transactionReceipt(client, step),
  ]);
  if (block.timestamp <= BigInt(step.expiresAt) || receipt?.status === 'success'
    || (receipt && receipt.blockNumber > block.number)) return false;
  if (!receipt) retainExpiredNonce(state, step);
  state.expiredFunding = [...(state.expiredFunding ?? []), { ...step, status: 'expired_unpaid' }];
  state.funding.steps = state.funding.steps.filter(candidate => candidate !== step);
  delete state.pendingTransaction;
  await saveOrder(options.home, state);
  return true;
}

export async function resumeTransaction(state, transaction, client, options) {
  options.onProgress?.({ phase: 'checking_payment', message: `Checking saved ${TRANSACTION_LABELS[transaction.kind ?? 'payment']}...` });
  const receipt = await transactionReceipt(client, transaction);
  if (receipt) return receipt;
  const pending = await pendingTransaction(client, transaction);
  const expired = transaction.kind !== 'support' && transaction.expiresAt && transaction.expiresAt * 1000 <= Date.now();
  const timedOut = state.pendingTransaction?.hash === transaction.hash;
  if (expired || (!pending.lowFee && !timedOut)) return submitTransaction(client, transaction, options);

  const original = parseTransaction(transaction.rawTransaction);
  const address = await recoverTransactionAddress({ serializedTransaction: transaction.rawTransaction });
  const current = await transactionFees(client, original.chainId);
  const fees = {
    maxFeePerGas: max(current.maxFeePerGas, bump(original.maxFeePerGas)),
    maxPriorityFeePerGas: max(current.maxPriorityFeePerGas, bump(original.maxPriorityFeePerGas)),
  };
  const required = original.gas * fees.maxFeePerGas + (original.value ?? 0n);
  const balance = await client.getBalance({ address });
  if (balance < required) throw fundingRequired(address, state.paymentChain ?? 'ethereum',
    [{ coin: 'ETH', balance: String(balance), required: String(required) }]);
  const networkFeeCap = formatEther(original.gas * fees.maxFeePerGas);
  const previousNetworkFeeCap = formatEther(original.gas * original.maxFeePerGas);
  const message = [
    `Update the network fee for the pending ${TRANSACTION_LABELS[pending.kind]}?`,
    pending.reason, `Previous maximum: ${previousNetworkFeeCap} ETH`, `New maximum: ${networkFeeCap} ETH`,
    'The transaction keeps the same recipient, amount and nonce. Only one version can execute.',
    `Transaction: ${transaction.hash}`,
  ].join('\n');
  if (options.confirmReplacement) await options.confirmReplacement({ ...pending, message, networkFeeCap, previousNetworkFeeCap });
  else await confirmAction(message, options);
  options.signal?.throwIfAborted();
  const confirmed = await transactionReceipt(client, transaction);
  if (confirmed) return confirmed;
  const { walletClient, account } = await getRpcClients({ ...options, expectedWallet: address }, original.chainId);
  await getSigner({ ...options, expectedWallet: account.address });
  options.signal?.throwIfAborted();
  assertOrderNotCancelled(await findOrder(options.home, state.requestKey));
  if (transaction.kind !== 'support' && transaction.expiresAt && transaction.expiresAt * 1000 <= Date.now()) {
    throw Object.assign(new Error('The transaction deadline passed during review. Continue this task to reconcile it.'), { code: 'payment_reconciling' });
  }
  reviewedFees(await transactionFees(client, original.chainId), fees);
  options.onProgress?.({ phase: 'signing', message: `Signing updated ${TRANSACTION_LABELS[pending.kind]} network fee...` });
  const rawTransaction = await walletClient.signTransaction({
    account, chainId: original.chainId, type: 'eip1559', nonce: original.nonce,
    to: original.to, data: original.data, value: original.value ?? 0n,
    gas: original.gas, accessList: original.accessList, ...fees,
  });
  transaction.replacements = [...(transaction.replacements ?? []), {
    hash: transaction.hash, rawTransaction: transaction.rawTransaction,
  }];
  transaction.rawTransaction = rawTransaction;
  transaction.hash = keccak256(rawTransaction);
  delete state.pendingTransaction;
  delete state.recoveryStatus;
  // Both candidates are durable before broadcasting. Never allocate a new nonce.
  await saveOrder(options.home, state);
  return submitTransaction(client, transaction, options);
}
