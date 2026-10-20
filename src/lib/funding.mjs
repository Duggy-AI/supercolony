import { decodeFunctionData, encodeFunctionData, erc20Abi, EstimateGasExecutionError, formatEther, keccak256 } from 'viem';
import { getPublicRpcClient, getRpcClients, getSigner } from '../shared.mjs';
import { paymentCoin } from './payment-coins.mjs';
import { paymentNetwork } from './payment-networks.mjs';
import { assertQuotePayment, orderPayment, loadPaymentConfig } from './payments.mjs';
import { assertOrderNotCancelled, findOrder, saveOrder } from './orders.mjs';
import { quoteSwap, buildSwap, UNISWAP, APPROVAL_GAS, SWAP_ABI } from './swaps.mjs';
import { submitTransaction } from './transactions.mjs';
import { fundingRequired } from './funding-error.mjs';
import { walletInfo } from './local-wallet.mjs';
import { transactionFees, reviewedFees } from './transaction-fees.mjs';
import { resumeTransaction, recoveryNonce, retireExpiredSwap } from './transaction-recovery.mjs';

const PAYMENT_GAS = 500_000n;
const balanceOf = (client, token, address) => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
const allowanceOf = (client, token, address, spender) => client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [address, spender] });
const approval = (kind, token, spender, amount) => ({
  kind, to: token, value: '0', gas: String(APPROVAL_GAS),
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
});

export async function prepareFunding(state, options, client, account, paymentConfig) {
  const { funding, shortages, requirement } = await planFunding(state, options, client, account, paymentConfig);
  if (shortages.length) throw fundingRequired(account.address, state.paymentChain ?? 'ethereum', shortages, requirement);
  return funding;
}

// Computes the payment plan and what this wallet is missing without throwing
// for missing funds, so every network and coin can be compared side by side.
export async function planFunding(state, options, client, account, paymentConfig) {
  const network = state.paymentChain ?? 'ethereum';
  const coin = paymentCoin(network, state.payWith);
  const config = paymentConfig ?? await loadPaymentConfig(options.api, state.action, network, options);
  const payment = paymentConfig ? paymentConfig.payment : orderPayment(state);
  assertQuotePayment(payment);
  if (payment.asset.toLowerCase() !== config.payment.asset.toLowerCase()) throw new Error('IMD payment asset differs from the selected network.');
  const amount = BigInt(payment.amount);
  const [imdAllowance, nativeBalance, fees] = await Promise.all([
    allowanceOf(client, payment.asset, account.address, config.spender),
    client.getBalance({ address: account.address }), transactionFees(client, paymentNetwork(network).chain.id),
  ]);
  const completed = (state.funding?.steps ?? []).filter(step => step.status === 'confirmed');
  let purchased = 0n;
  let supportPaid = 0n;
  for (const step of completed) {
    if (step.kind === 'swap') {
      const multicall = decodeFunctionData({ abi: SWAP_ABI, data: step.data });
      purchased += decodeFunctionData({ abi: SWAP_ABI, data: multicall.args[1][0] }).args[0].amountOut;
    } else if (step.kind === 'support') supportPaid += decodeFunctionData({ abi: erc20Abi, data: step.data }).args[1];
  }
  const supportAmount = BigInt(state.support?.amount ?? 0) - supportPaid;
  const target = amount + supportAmount;
  const router = UNISWAP[network].router;
  const paymentGas = network === 'robinhood' ? PAYMENT_GAS : 0n;
  const supportGas = supportAmount > 0n ? 100_000n : 0n;
  const fixedGas = paymentGas + supportGas + (imdAllowance < amount ? APPROVAL_GAS : 0n);
  const steps = [];
  const shortages = [];
  let route;
  const expiresAt = Math.min(Number(state.quote.expiresAt), Math.floor(Date.now() / 1000) + 300);
  let coinBalance = coin.symbol === 'ETH' ? nativeBalance : null;
  if (coin.symbol === 'IMD') {
    const balance = await balanceOf(client, payment.asset, account.address);
    coinBalance = balance;
    if (balance < target) shortages.push({ coin: 'IMD', balance: String(balance), required: String(target) });
  }
  const credit = purchased > supportPaid ? purchased - supportPaid : 0n;
  const swapTarget = target > credit ? target - credit : 0n;
  if (credit > 0n) {
    const balance = await balanceOf(client, payment.asset, account.address);
    const required = target < credit ? target : credit;
    if (balance < required) shortages.push({ coin: 'IMD', balance: String(balance), required: String(required) });
  }
  if (coin.symbol !== 'IMD' && swapTarget > 0n) {
    const sourceAllowance = coin.symbol === 'ETH' ? 0n : await allowanceOf(client, coin.address, account.address, router);
    route = await quoteSwap(network, coin, swapTarget, {
      client, maxFeePerGas: fees.maxFeePerGas, sourceAllowance, fixedGas, signal: options.signal,
    });
    const amountIn = BigInt(route.amountIn);
    if (coin.symbol !== 'ETH') {
      const balance = await balanceOf(client, coin.address, account.address);
      coinBalance = balance;
      const allowance = sourceAllowance;
      if (balance < amountIn) shortages.push({ coin: coin.symbol, balance: String(balance), required: String(amountIn) });
      if (allowance < amountIn) {
        // USDT requires clearing an existing nonzero allowance before changing it.
        if (coin.symbol === 'USDT' && allowance > 0n) steps.push(approval('reset_source_allowance', coin.address, router, 0n));
        steps.push(approval('approve_source', coin.address, router, amountIn));
      }
    }
    const transaction = buildSwap(network, coin, route, swapTarget, account.address, expiresAt);
    steps.push({ kind: 'swap', ...transaction, gas: String(route.gas), expiresAt });
  }
  if (imdAllowance < amount) steps.push(approval('approve_imd', payment.asset, config.spender, amount));
  if (supportAmount > 0n) steps.push({
    kind: 'support', to: payment.asset, value: '0', gas: String(supportGas),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [state.support.recipient, supportAmount] }),
  });
  const feeCap = (steps.reduce((sum, step) => sum + BigInt(step.gas), paymentGas)) * fees.maxFeePerGas;
  const amountIn = coin.symbol === 'IMD' ? target : BigInt(route?.amountIn ?? 0);
  const maximumDebit = amountIn + (coin.symbol === 'ETH' ? feeCap : 0n);
  const nativeRequired = feeCap + (coin.symbol === 'ETH' ? amountIn : 0n);
  if (nativeBalance < nativeRequired) shortages.push({ coin: 'ETH', balance: String(nativeBalance), required: String(nativeRequired) });
  const requirement = {
    coin: coin.symbol, imd: String(target), price: String(amount), support: String(supportAmount > 0n ? supportAmount : 0n), payment: String(amountIn),
    estimate: String(coin.symbol === 'IMD' ? target : route?.quotedInput ?? 0), gas: String(feeCap),
    balance: coinBalance === null ? null : String(coinBalance), nativeBalance: String(nativeBalance),
  };
  return { shortages, requirement, funding: {
    chainId: paymentNetwork(network).chain.id, account: account.address, coin: coin.symbol,
    amountIn: String(amountIn), minimumOut: String(target), maximumDebit: String(maximumDebit),
    quotedInput: String(coin.symbol === 'IMD' ? target : route?.quotedInput ?? 0),
    ...(route ? { slippageBps: route.slippageBps } : {}),
    feeCap: String(feeCap), maxFeePerGas: String(fees.maxFeePerGas), maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
    paymentGas: String(paymentGas), expiresAt, steps: [...completed, ...steps],
  } };
}

export async function fundOrder(state, options, confirm) {
  const chainId = paymentNetwork(state.paymentChain ?? 'ethereum').chain.id;
  const wallet = walletInfo(options);
  if (!wallet.configured) throw new Error('Create or import a wallet in Wallets before paying.');
  if (options.expectedWallet && options.expectedWallet.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Payment wallet changed. Review this task with the selected wallet before paying.');
  const publicClient = await getPublicRpcClient(options, chainId);
  if (state.funding && state.funding.account.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Resume funding with the same wallet that started this order.');
  // Resolve signed transactions first. Only the unsigned remainder gets new
  // rates and gas estimates; confirmed conversions and support are retained.
  for (const step of state.funding?.steps ?? []) {
    if (step.rawTransaction && step.status !== 'confirmed' && await retireExpiredSwap(state, step, publicClient, options)) continue;
    if (step.status === 'reverted') throw new Error(`The ${step.kind} transaction reverted: ${step.hash}. No replacement swap will be made for this order.`);
    if (!step.rawTransaction || step.status === 'confirmed') continue;
    const receipt = await resumeTransaction(state, step, publicClient, options);
    step.status = receipt.status === 'success' ? 'confirmed' : 'reverted';
    step.confirmedHash = receipt.transactionHash;
    delete state.pendingTransaction;
    await saveOrder(options.home, state);
    if (step.status === 'reverted') throw new Error(`The ${step.kind} transaction reverted: ${step.hash}. No replacement swap will be made for this order.`);
  }
  options.onProgress?.({ phase: 'checking_funds', message: 'Checking balances, current exchange rate and network fees...' });
  state.funding = await prepareFunding(state, options, publicClient, wallet);
  const funding = state.funding;
  state.paymentReview = { networkFeeCap: formatEther(BigInt(funding.feeCap)) };
  await confirm(state);
  options.signal?.throwIfAborted();
  assertOrderNotCancelled(await findOrder(options.home, state.requestKey));
  await saveOrder(options.home, state);
  const { walletClient, account } = await getRpcClients({ ...options, expectedWallet: wallet.address }, chainId);
  options.signal?.throwIfAborted();
  assertOrderNotCancelled(await findOrder(options.home, state.requestKey));
  if (funding.expiresAt * 1000 <= Date.now()) throw Object.assign(new Error('Refreshing the payment review. No new transaction was signed.'), { code: 'payment_review_expired' });
  for (const step of funding.steps) {
    if (step.status === 'confirmed') continue;
    if (step.status === 'reverted') throw new Error(`The ${step.kind} transaction reverted: ${step.hash}. No replacement swap will be made for this order.`);
    if (!step.rawTransaction) {
      if (funding.expiresAt * 1000 <= Date.now()) throw Object.assign(new Error('Refreshing the payment review. No new transaction was signed.'), { code: 'payment_review_expired' });
      const fees = reviewedFees(await transactionFees(publicClient, chainId), funding);
      options.onProgress?.({ phase: 'signing', message: `Preparing ${step.kind === 'swap' ? 'coin conversion' : step.kind === 'support' ? 'optional support transfer' : 'token authorization'}...` });
      const transaction = { account, to: step.to, data: step.data, value: BigInt(step.value), ...fees };
      let gas;
      try { gas = await publicClient.estimateGas(transaction); }
      catch (error) {
        if (!(error instanceof EstimateGasExecutionError)) throw error;
        throw new Error(`${step.kind === 'swap' ? 'The swap quote' : step.kind === 'support' ? 'The support transfer' : 'The token authorization'} cannot currently execute. No new transaction was signed. Any completed steps remain saved in this order.`, { cause: error });
      }
      if (gas > BigInt(step.gas)) throw new Error('Required network fees exceed the reviewed cap. No new transaction was signed.');
      const prepared = await walletClient.prepareTransactionRequest({ ...transaction, gas: BigInt(step.gas),
        nonce: await recoveryNonce(state, publicClient, account.address) });
      await getSigner({ ...options, expectedWallet: account.address });
      options.signal?.throwIfAborted();
      assertOrderNotCancelled(await findOrder(options.home, state.requestKey));
      if (funding.expiresAt * 1000 <= Date.now()) throw Object.assign(new Error('Refreshing the payment review. No new transaction was signed.'), { code: 'payment_review_expired' });
      Object.assign(prepared, reviewedFees(await transactionFees(publicClient, chainId), funding));
      step.rawTransaction = await walletClient.signTransaction(prepared);
      step.hash = keccak256(step.rawTransaction);
      step.status = 'signed';
      delete state.replacementNonce;
      state.status = 'funding';
      await saveOrder(options.home, state);
    }
    const receipt = await submitTransaction(publicClient, step, options);
    step.status = receipt.status === 'success' ? 'confirmed' : 'reverted';
    step.confirmedHash = receipt.transactionHash;
    delete state.pendingTransaction;
    await saveOrder(options.home, state);
    if (step.status === 'reverted') throw new Error(`The ${step.kind} transaction reverted: ${step.hash}. Your order was not paid.`);
  }
  const payment = orderPayment(state);
  if (await balanceOf(publicClient, payment.asset, account.address) < BigInt(payment.amount)) throw new Error('The saved swap has finished, but this wallet no longer has enough IMD. No additional swap was made.');
  assertOrderNotCancelled(await findOrder(options.home, state.requestKey));
  funding.status = 'ready';
  await saveOrder(options.home, state);
}
