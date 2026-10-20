import { encodeFunctionData, erc20Abi, formatUnits, keccak256, parseAbi } from 'viem';
import { getPublicRpcClient, getRpcClients, getSigner } from '../shared.mjs';
import { assertOrderNotCancelled, findOrder, saveOrder } from './orders.mjs';
import { loadPaymentConfig, onchainTerms } from './payments.mjs';
import { submitTransaction } from './transactions.mjs';
import { resumeTransaction, recoveryNonce } from './transaction-recovery.mjs';
import { transactionFees, reviewedFees } from './transaction-fees.mjs';

const INTAKE_ABI = parseAbi(['function pay(bytes32 quoteHash, address asset, uint256 amount, uint64 expiresAt, bytes signature)']);

export async function signOnchainPayment(state, options) {
  const terms = onchainTerms(state);
  const { payment, spender } = await loadPaymentConfig(options.api, state.action, 'robinhood');
  if (terms.asset.toLowerCase() !== payment.asset.toLowerCase()
    || terms.intake.toLowerCase() !== spender.toLowerCase()
    || payment.decimals !== state.quote.payment.decimals) {
    throw new Error('The Robinhood quote does not match the payment contract configured by IMD.');
  }
  const { publicClient, walletClient, account } = await getRpcClients(options, terms.chainId);
  const fees = reviewedFees(await transactionFees(publicClient, terms.chainId), state.funding);
  options.onProgress?.({ phase: 'signing', message: 'Preparing task payment...' });
  const allowance = await publicClient.readContract({
    address: terms.asset, abi: erc20Abi, functionName: 'allowance', args: [account.address, terms.intake],
  });
  if (allowance < BigInt(terms.amount)) {
    throw new Error('Authorize IMD payment on Robinhood Chain first: run colony wallet approve --payment-chain robinhood --amount ' + formatUnits(BigInt(terms.amount), payment.decimals) + '. No task payment was signed.');
  }
  const transaction = await walletClient.prepareTransactionRequest({
    account, to: terms.intake, value: 0n,
    data: encodeFunctionData({ abi: INTAKE_ABI, functionName: 'pay', args: [terms.quoteHash, terms.asset, BigInt(terms.amount), BigInt(terms.expiresAt), terms.signature] }),
    gas: BigInt(state.funding.paymentGas), ...fees,
    nonce: await recoveryNonce(state, publicClient, account.address),
  });
  await getSigner({ ...options, expectedWallet: account.address });
  options.signal?.throwIfAborted();
  assertOrderNotCancelled(await findOrder(options.home, state.requestKey));
  if (terms.expiresAt * 1000 <= Date.now()) {
    throw Object.assign(new Error('The quote expired before signing. No task payment was signed.'), { code: 'quote_expired' });
  }
  Object.assign(transaction, reviewedFees(await transactionFees(publicClient, terms.chainId), state.funding));
  const rawTransaction = await walletClient.signTransaction(transaction);
  state.onchainPayment = { chainId: terms.chainId, kind: 'payment', expiresAt: terms.expiresAt, rawTransaction, hash: keccak256(rawTransaction) };
  delete state.replacementNonce;
  state.payer = account.address;
  state.status = 'signed';
  state.lastError = null;
  await saveOrder(options.home, state);
}

export async function submitOnchainPayment(state, options) {
  const payment = state.onchainPayment;
  const publicClient = await getPublicRpcClient(options, payment.chainId);
  const resuming = Boolean(state.submittedAt);
  payment.kind = 'payment';
  payment.expiresAt = onchainTerms(state).expiresAt;
  state.transactionHash = payment.hash;
  state.paymentStatus = 'pending';
  state.status = 'submitted';
  state.submittedAt = new Date().toISOString();
  await saveOrder(options.home, state);
  options.signal?.throwIfAborted();
  const receipt = resuming ? await resumeTransaction(state, payment, publicClient, options)
    : await submitTransaction(publicClient, payment, options);
  state.transactionHash = receipt.transactionHash;
  payment.confirmedHash = receipt.transactionHash;
  delete state.pendingTransaction;
  if (receipt.status !== 'success') {
    state.status = 'payment_failed';
    state.paymentStatus = 'failed';
    await saveOrder(options.home, state);
    throw new Error('The Robinhood payment transaction reverted: ' + payment.hash);
  }
  state.paymentStatus = 'confirmed';
  await saveOrder(options.home, state);
}
