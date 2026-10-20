import { setTimeout as sleep } from 'node:timers/promises';
import { parseTransaction, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';

export const TRANSACTION_LABELS = {
  reset_source_allowance: 'token authorization reset', approve_source: 'token authorization',
  approve_imd: 'IMD authorization', swap: 'coin conversion', support: 'optional support transfer',
  payment: 'task payment',
};

export async function transactionReceipt(client, transaction) {
  // Replacements share a nonce. Either hash can win, but only one executes.
  for (const candidate of [transaction, ...(transaction.replacements ?? [])]) {
    try { return await client.getTransactionReceipt({ hash: candidate.hash }); }
    catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error; }
  }
  return null;
}

export async function pendingTransaction(client, transaction) {
  const parsed = parseTransaction(transaction.rawTransaction);
  const block = await client.getBlock({ blockTag: 'latest' });
  const lowFee = parsed.maxFeePerGas < block.baseFeePerGas;
  const zeroTip = parsed.chainId === 1 && parsed.maxPriorityFeePerGas === 0n;
  const reason = lowFee ? 'The saved network fee is below the current base fee.'
    : zeroTip ? 'The saved transaction offers no priority fee.' : 'The network has not confirmed this transaction yet.';
  const explorer = parsed.chainId === 1 ? 'https://etherscan.io' : 'https://robinhoodchain.blockscout.com';
  return { hash: transaction.hash, kind: transaction.kind ?? 'payment', reason,
    explorerUrl: `${explorer}/tx/${transaction.hash}`, lowFee: lowFee || zeroTip };
}

export async function submitTransaction(client, transaction, options) {
  const receipt = await transactionReceipt(client, transaction);
  if (receipt) return receipt;
  let known = false;
  try { await client.getTransaction({ hash: transaction.hash }); known = true; }
  catch (error) { if (!(error instanceof TransactionNotFoundError)) throw error; }
  options.signal?.throwIfAborted();
  if (!known) {
    if (transaction.kind !== 'support' && transaction.expiresAt && transaction.expiresAt * 1000 <= Date.now()) {
      throw Object.assign(new Error('The saved transaction is past its execution deadline. Its result must be reconciled before another payment.'),
        { code: 'payment_reconciling', transaction: await pendingTransaction(client, transaction) });
    }
    options.onProgress?.({ phase: 'broadcasting', hash: transaction.hash,
      message: `Sending ${TRANSACTION_LABELS[transaction.kind ?? 'payment']}...` });
    await client.sendRawTransaction({ serializedTransaction: transaction.rawTransaction });
  }
  return waitForReceipt(client, transaction.hash, { ...options, transaction });
}

export async function waitForReceipt(client, hash, options) {
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  const transaction = options.transaction;
  options.onProgress?.({ phase: 'confirming', hash,
    message: `Waiting for ${TRANSACTION_LABELS[transaction?.kind ?? 'payment']} confirmation...` });
  for (;;) {
    options.signal?.throwIfAborted();
    const receipt = await transactionReceipt(client, transaction ?? { hash });
    if (receipt) return receipt;
    if (Date.now() >= deadline) {
      const pending = transaction ? await pendingTransaction(client, transaction) : { hash, kind: 'payment', reason: 'Confirmation is still pending.' };
      throw Object.assign(new Error(`Awaiting ${TRANSACTION_LABELS[pending.kind]} confirmation. ${pending.reason}\nContinue this task to check it again or review an updated network fee.\nTransaction: ${hash}`),
        { code: 'transaction_pending', transaction: pending });
    }
    await sleep(options.intervalMs ?? 2_000, undefined, { signal: options.signal });
  }
}
