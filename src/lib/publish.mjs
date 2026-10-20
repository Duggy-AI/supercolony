import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { formatUnits, sha256, stringToBytes } from 'viem';
import { confirmAction, getPublicRpcClient, getSigner, request } from '../shared.mjs';
import { assertOrderNotCancelled, findOrder, loadOrder, orderActions, saveOrder } from './orders.mjs';
import { assertQuotePayment, orderPayment } from './payments.mjs';
import { networkName, selectedPaymentNetwork } from './payment-networks.mjs';
import { signOnchainPayment, submitOnchainPayment } from './onchain-payment.mjs';
import { coinSymbol, paymentCoin } from './payment-coins.mjs';
import { fundingSummary } from './funding-state.mjs';
import { fundOrder } from './funding.mjs';
import { walletInfo } from './local-wallet.mjs';
import { selectSupport, supportView } from './support.mjs';
import { authorizationUnpaid } from './payment-recovery.mjs';
import { retainExpiredNonce } from './transaction-recovery.mjs';
import { transactionReceipt } from './transactions.mjs';
import { withSubmissionAttribution } from './submission-attribution.mjs';

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export async function readJobFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`invalid JSON in ${file}: ${error.message}`);
    }
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed;
}

export async function checkJob(api, input, action = 'job.open', signal) {
  const response = await request(api, '/requests/check', {
    method: 'POST',
    query: true,
    body: { action, input },
    signal,
  });
  if (!Array.isArray(response.data?.blockers)) {
    throw new Error('check response is missing blockers');
  }
  return response.data;
}

export async function quoteJob(api, token, requestKey, input, action = 'job.open', signal) {
  const response = await request(api, '/requests/quote', {
    method: 'POST',
    token,
    body: { requestKey, action, input },
    signal,
  });
  const order = response.data?.order;
  if (!order?.id || !order.quote?.payment) {
    throw new Error('quote response is missing order or quote');
  }
  return { ...order, onchain: response.data.onchain };
}

async function continueOwner(api, input, check) {
  if (check?.owner) return check.owner;
  const parentJobId = input?.parentJobId;
  if (!parentJobId) {
    throw new Error('job.continue input is missing parentJobId');
  }
  const response = await request(api, `/jobs/${encodeURIComponent(parentJobId)}`);
  const paidBy = response.data?.paidBy;
  if (!paidBy) {
    throw new Error(`cannot verify the project owner for ${parentJobId}: the parent job has no paidBy`);
  }
  return paidBy;
}

function ownerMismatch(account, owner) {
  const error = new Error(
    `wallet ${account} is not the project owner ${owner}; no payment was signed in this attempt`,
  );
  error.code = 'owner_mismatch';
  return error;
}

export async function assertContinueOwner({ api, input, check, account, owner: knownOwner }) {
  const owner = knownOwner ?? await continueOwner(api, input, check);
  if (!account?.address) {
    throw new Error('missing signer address');
  }
  if (!sameAddress(owner, account.address)) {
    throw ownerMismatch(account.address, owner);
  }
  return owner;
}

async function getChallenge(api, token, orderId, signal) {
  const response = await request(api, `/requests/${orderId}/submit`, {
    method: 'POST',
    token,
    allowStatuses: [402],
    signal,
  });
  if (response.status !== 402) {
    throw new Error(`expected HTTP 402 payment challenge, got HTTP ${response.status}`);
  }
  const challenge = response.data;
  if (!Array.isArray(challenge?.accepts) || challenge.accepts.length === 0) {
    throw new Error('payment challenge is missing accepts');
  }
  if (!challenge.resourceUrl || !challenge.requesterScopeHash) {
    throw new Error('payment challenge is missing resourceUrl or requesterScopeHash');
  }
  return challenge;
}

function sameAddress(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function assertChallengeMatchesQuote(challenge, state) {
  const accepted = challenge.accepts[0];
  const payment = state.quote.payment;
  if (state.quote?.action !== state.action) {
    throw new Error(
      `saved quote action ${state.quote?.action ?? '<missing>'} does not match ${state.action}`,
    );
  }
  if (challenge.quote?.action !== state.action) {
    throw new Error(
      `payment challenge action ${challenge.quote?.action ?? '<missing>'} does not match ${state.action}`,
    );
  }
  if (challenge.quote?.id !== state.orderId) {
    throw new Error('payment challenge belongs to a different order');
  }
  if (challenge.quote?.quoteHash !== state.quote.quoteHash) {
    throw new Error('payment challenge quoteHash does not match the saved quote');
  }
  if (challenge.quote?.expiresAt !== state.quote.expiresAt) {
    throw new Error('payment challenge expiry does not match the saved quote');
  }
  // Permit2 and QuoteApproval are separate signatures. Bind both to the
  // saved terms that the user reviews, not only the Permit2 requirement.
  for (const [label, terms] of [['payment challenge', accepted], ['quote approval', challenge.quote.payment]]) {
    for (const field of ['network', 'asset', 'amount', 'payTo']) {
      const matches = field === 'asset' || field === 'payTo'
        ? sameAddress(terms?.[field], payment[field])
        : String(terms?.[field]) === String(payment[field]);
      if (!matches) throw new Error(`${label} ${field} does not match the saved quote`);
    }
  }
  if (accepted.extra?.assetTransferMethod !== 'permit2') {
    throw new Error('payment challenge does not use Permit2');
  }
  if (!challenge.input || typeof challenge.input !== 'object' || Array.isArray(challenge.input)) {
    throw new Error('payment challenge is missing the prepared input');
  }
  if (Number(challenge.quote.expiresAt) * 1000 <= Date.now()) {
    const error = new Error('quote has expired; no payment was signed');
    error.code = 'quote_expired';
    throw error;
  }
}

export async function buildPayment(account, challenge) {
  const requirement = challenge.accepts[0];
  const expiresAt = Number(challenge.quote.expiresAt);
  const remaining = expiresAt - Math.floor(Date.now() / 1000);
  if (!Number.isInteger(remaining) || remaining <= 1) {
    const error = new Error('quote expires too soon to sign a payment; no payment was signed');
    error.code = 'quote_expired';
    throw error;
  }
  if (!Number.isInteger(Number(requirement.maxTimeoutSeconds))) {
    throw new Error('payment requirement is missing maxTimeoutSeconds');
  }

  const maxTimeoutSeconds = Math.max(
    1,
    Math.min(Number(requirement.maxTimeoutSeconds), remaining - 1),
  );
  const signingRequirement = { ...requirement, maxTimeoutSeconds };
  const client = x402Client.fromConfig({
    schemes: [{ network: signingRequirement.network, client: new ExactEvmScheme(account) }],
    spendControls: {
      allowedAssets: [{
        network: signingRequirement.network,
        asset: signingRequirement.asset,
        maxAmountPerPayment: signingRequirement.amount,
      }],
    },
  });
  const generated = await client.createPaymentPayload({
    x402Version: 2,
    resource: challenge.resource,
    accepts: [signingRequirement],
  });
  const { extensions, ...rest } = generated;
  const payment = JSON.parse(JSON.stringify({ ...rest, accepted: requirement }));
  const deadline = payment.payload?.permit2Authorization?.deadline;
  if (deadline === undefined || BigInt(deadline) >= BigInt(expiresAt)) {
    throw new Error(`payment deadline ${deadline} is not before quote expiry ${expiresAt}`);
  }
  return {
    payment,
    paymentHeader: encodePaymentSignatureHeader(payment),
    paymentHash: sha256(stringToBytes(canonicalJson(payment))),
  };
}

function bytes32(value, label) {
  const hex = String(value ?? '').replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return `0x${hex}`;
}

export function quoteApprovalTypedData(challenge, paymentHash) {
  const quote = challenge.quote;
  const chainId = Number(String(quote.payment.network).slice(7));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`invalid quote network: ${quote.payment.network}`);
  }
  return {
    domain: {
      name: 'IdentityMD Paid Action',
      version: '1',
      chainId,
    },
    types: {
      QuoteApproval: [
        { name: 'resource', type: 'string' },
        { name: 'requesterScopeHash', type: 'bytes32' },
        { name: 'quoteId', type: 'string' },
        { name: 'quoteHash', type: 'bytes32' },
        { name: 'paymentHash', type: 'bytes32' },
        { name: 'action', type: 'string' },
        { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'payTo', type: 'address' },
        { name: 'expiresAt', type: 'uint256' },
      ],
    },
    primaryType: 'QuoteApproval',
    message: {
      resource: challenge.resourceUrl,
      requesterScopeHash: bytes32(challenge.requesterScopeHash, 'requesterScopeHash'),
      quoteId: quote.id,
      quoteHash: bytes32(quote.quoteHash, 'quoteHash'),
      paymentHash: bytes32(paymentHash, 'paymentHash'),
      action: quote.action,
      asset: quote.payment.asset,
      amount: BigInt(quote.payment.amount),
      payTo: quote.payment.payTo,
      expiresAt: BigInt(quote.expiresAt),
    },
  };
}

export async function signQuoteApproval(account, challenge, paymentHash) {
  const typedData = quoteApprovalTypedData(challenge, paymentHash);
  return account.signTypedData(typedData);
}

export function paymentSummary(state) {
  const payment = orderPayment(state);
  const amount = formatUnits(BigInt(payment.amount), payment.decimals);
  const funding = state.funding ? fundingSummary(state.funding) : null;
  const gas = state.paymentReview ? [(state.payWith === 'ETH' ? 'Included network fee cap: ' : 'Additional network fee cap: ') + state.paymentReview.networkFeeCap + ' ETH'] : [];
  if (!state.challenge?.input || typeof state.challenge.input !== 'object') {
    throw new Error('payment challenge is missing the prepared input');
  }
  if (state.plan) {
    const coin = state.payWith ?? 'IMD';
    return [
      `Task: ${state.input.objective}`,
      ...state.plan.deliverables.map((item) => `  - ${item}`),
      `Price: ${amount} IMD`,
      `Pay with: ${coin} on ${networkName(state.paymentChain)}`,
      ...(funding ? [
        coin === 'IMD' ? `Payment: ${funding.display.payment}`
          : funding.converted ? `Payment: conversion already confirmed (${funding.display.payment} at most)`
            : `Payment: ≈ ${funding.display.estimate ?? funding.display.payment} (at most ${funding.display.payment}), converted to IMD`,
        `Gas (network fee, paid in ETH): at most ${funding.display.gas}${coin === 'ETH' ? ' from the same ETH balance' : ''}`,
        ...(coin === 'ETH' ? [`Total ETH at most: ${funding.display.maximumDebit}`] : []),
        ...(funding.coin !== 'IMD' ? ['Conversion and task payment are separate transactions.'] : []),
      ] : gas),
      'Payment covers task admission; a completed result is not guaranteed.',
    ].join('\n');
  }
  return [
    `Order: ${state.orderId}`,
    `Action: ${state.action ?? 'job.open'}`,
    `Network: ${payment.network}`,
    `Amount: ${amount} (${payment.amount} atomic units)`,
    `Asset: ${payment.asset}`,
    `Pay to: ${payment.payTo}`,
    `Quote expires: ${new Date(Number(state.quote.expiresAt) * 1000).toISOString()}`,
    ...(funding ? [`Maximum debit: ${funding.maximumDebit}`, ...(funding.coin !== 'IMD' ? ['Conversion and task payment are separate transactions.'] : [])] : []),
    ...gas,
    `Requested objective: ${String(state.input.objective ?? '')}`,
    'Prepared input (this is what will be paid for):',
    JSON.stringify(state.challenge.input, null, 2),
  ].join('\n');
}

async function confirmOrder(state, options) {
  if (options.confirm) return options.confirm(state);
  const support = supportView(state);
  const supportText = support ? `\nOptional support: ${support.amount} IMD · Help us make Colony better.\nTotal: ${support.total} IMD + network fees\nSupport recipient: ${support.recipient}\nSupport is sent before task payment and is not refunded if admission fails.` : '';
  await confirmAction(`Sign and pay this order?\n${paymentSummary(state)}${supportText}`, options);
}

function retryCommand(state, context) {
  if (typeof context.retryCommand === 'function') return context.retryCommand(state);
  if (context.retryCommand) return context.retryCommand;
  const { file, home, api } = context;
  const base = `colony --api ${api} --home ${home}`;
  const key = state.requestKey;
  if (state.action === 'job.continue') {
    const parent = state.input?.parentJobId ?? '<parent-job-id>';
    return file
      ? `${base} task continue ${parent} --file ${file} --request-key ${key}`
      : `${base} task continue ${parent} --request-key ${key}`;
  }
  return file
    ? `${base} task publish --file ${file} --request-key ${key}`
    : `${base} task create --file <saved-input.json> --request-key ${key}`;
}

function recoveryError(error, state, context) {
  const { home, api } = context;
  const saved = `saved request key ${state.requestKey} at ${home} (api ${api})`;
  const paymentSigned = Boolean(state.paymentHeader || state.quoteSignature || state.onchainPayment);
  const fundingSigned = Boolean(state.funding?.steps.some((step) => step.rawTransaction));
  const signed = paymentSigned || fundingSigned;
  let hint;
  if ((error.code === 'quote_expired' || error.status === 410) && fundingSigned && !paymentSigned) {
    hint = `${saved}; continue this task with: colony --api ${api} --home ${home} order submit ${state.requestKey}. Saved transactions will be checked before refreshing prices.`;
  } else if ((error.code === 'quote_expired' || error.status === 410) && !signed) {
    hint = `${saved}; no payment was signed. Continue this task with a fresh quote: colony --api ${api} --home ${home} order submit ${state.requestKey}`;
  } else if ((error.code === 'quote_expired' || error.status === 410) && signed) {
    hint = `${saved}; a payment is already signed for order ${state.orderId}. Do not start a new order. Check it with: colony --api ${api} --home ${home} order show ${state.orderId} --refresh`;
  } else if (signed && state.orderId) {
    hint = `${saved}; resume with: colony --api ${api} --home ${home} order submit ${state.orderId}`;
  } else {
    hint = `${saved}; retry the same order with: ${retryCommand(state, context)}`;
  }
  return Object.assign(new Error(`${error.message}\n${hint}`, { cause: error }), {
    code: error.code ?? (error.status === 410 && !paymentSigned ? 'quote_expired' : undefined), status: error.status, data: error.data, headers: error.headers,
    funding: error.funding,
    transaction: error.transaction,
  });
}

export function applyOrderStatus(state, data) {
  state.lastStatus = data.status;
  state.admission = data.admission ?? null;
  const result = data.admission?.result;
  if (result) {
    state.jobId = result.jobId ?? null;
    state.statusUrl = result.statusUrl ?? null;
    state.resultUrl = result.resultUrl ?? null;
  }
  if (data.payment) {
    state.paymentStatus = data.payment.status;
    state.transactionHash = data.payment.transactionHash ?? state.onchainPayment?.confirmedHash ?? state.onchainPayment?.hash ?? null;
  }
  if (data.status === 'admitted') {
    delete state.pendingTransaction;
    delete state.recoveryStatus;
    state.lastError = null;
    if (result?.kind === 'refused') {
      state.status = 'refused';
      state.refusalProblems = result.problems ?? [];
    } else {
      state.status = 'admitted';
      state.refusalProblems = null;
    }
  } else if (data.status === 'payment_failed') state.status = 'payment_failed';
  else if (data.status === 'expired') state.status = 'expired';
}

export async function fetchOrderStatus(api, token, orderId) {
  const response = await request(api, `/requests/${orderId}`, { token });
  if (!response.data?.status) throw new Error('order status response is missing status');
  return response.data;
}

export async function refreshOrder(options) {
  const { home, id } = options;
  const state = await findOrder(home, id);
  if (!state.orderId) {
    throw new Error(`order ${state.requestKey} has not been quoted; there is no server order to refresh`);
  }
  const data = await fetchOrderStatus(state.api, state.requestToken, state.orderId);
  applyOrderStatus(state, data);
  state.lastError = null;
  await saveOrder(home, state);
  return state;
}

export async function pollOrder(api, token, orderId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const response = await request(api, `/requests/${orderId}`, { token, signal: options.signal });
    const data = response.data;
    if (!data?.status) {
      throw new Error('order status response is missing status');
    }
    if (data.status === 'admitted' || data.status === 'payment_failed' || data.status === 'expired') {
      return data;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for order ${orderId}; last status: ${data.status}`);
    }
    await sleep(intervalMs, undefined, { signal: options.signal });
  }
}

async function submitSignedOrder(api, token, state, home, signal) {
  state.submittedAt = new Date().toISOString();
  state.status = 'submitted';
  await saveOrder(home, state);
  const response = await request(api, `/requests/${state.orderId}/submit`, {
    method: 'POST',
    token,
    headers: { 'PAYMENT-SIGNATURE': state.paymentHeader },
    body: { quoteSignature: state.quoteSignature },
    allowStatuses: [402],
    signal,
  });
  if (response.status === 402) {
    const reason = response.data?.reason ?? response.data?.error ?? 'payment rejected';
    const error = new Error(`payment rejected: ${reason}`);
    error.status = 402;
    error.data = response.data;
    throw error;
  }
  return response.data;
}

async function refreshAfterSignedExpiry(error, api, state, home) {
  if (error.status !== 410 && error.code !== 'quote_expired') return null;
  if (!state.paymentHeader || !state.quoteSignature || !state.orderId) return null;
  try {
    const data = await fetchOrderStatus(api, state.requestToken, state.orderId);
    applyOrderStatus(state, data);
    state.lastError = null;
    await saveOrder(home, state);
    if (state.status === 'admitted' || state.status === 'refused'
      || state.status === 'payment_failed' || state.status === 'expired') {
      return true;
    }
  } catch (refreshError) {
    error.message += `
order status refresh failed: ${refreshError.message}`;
  }
  return null;
}

export async function publishJob(options) {
  let requestKey = options.requestKey;
  const onSaved = async state => { requestKey = state.requestKey; await options.onSaved?.(state); };
  // Re-enter the same persisted request. A renewed quote always gets another
  // review; signed payments are reconciled by publishAttempt before renewal.
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await publishAttempt({ ...options, requestKey, onSaved });
      if (!['expired', 'payment_failed'].includes(result.status)) return result;
      if (attempt >= 2) return result;
    } catch (error) {
      if (attempt >= 2 || !['quote_expired', 'payment_review_expired'].includes(error.code)) throw error;
    }
    options.onProgress?.({ phase: 'checking_payment', message: 'Checking the previous payment and refreshing prices...' });
  }
}

async function publishAttempt(options) {
  options = { ...options, expectedWallet: options.expectedWallet ?? walletInfo(options).address };
  const { api, home, file, requestKey } = options;
  const existing = requestKey ? await loadOrder(home, requestKey) : null;
  const payWith = coinSymbol(options.payWith ?? existing?.payWith);
  const network = options.paymentChain ?? existing?.paymentChain ?? selectedPaymentNetwork(options).key;
  paymentCoin(network, payWith);
  const action = options.action ?? 'job.open';
  if (action !== 'job.open' && action !== 'job.continue') {
    throw new Error(`unsupported action: ${action}`);
  }
  const input = options.input ?? await readJobFile(file);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('job input must be a JSON object');
  }
  const inputHash = hashJson(input);

  let state = existing;
  if (state) {
    assertOrderNotCancelled(state);
    if (state.api !== api) {
      throw new Error(`order ${state.requestKey} belongs to ${state.api}; rerun with --api ${state.api}`);
    }
    if (state.action !== action) {
      throw new Error(
        `request key ${state.requestKey} was created for action ${state.action}, not ${action}`,
      );
    }
    if (state.inputHash !== inputHash) {
      throw new Error(`request key ${state.requestKey} was created for a different input`);
    }
    const networkChanged = network !== (state.paymentChain ?? 'ethereum');
    if (networkChanged || payWith !== (state.payWith ?? 'IMD')) {
      // Nothing has been signed yet, so the payer may still pick another
      // network or coin. Signed work must finish on its original terms.
      if (!orderActions(state).canCancel) {
        throw new Error(networkChanged ? 'This order already uses a different payment network. Resume it on its original network.'
          : 'Resume this order with its original payment coin.');
      }
      state.paymentChain = network;
      state.payWith = payWith;
      for (const field of ['funding', 'paymentReview', 'support']) delete state[field];
      await saveOrder(home, state);
    }
  } else {
    const key = requestKey ?? randomUUID();
    state = {
      version: 1,
      requestKey: key,
      requestToken: randomBytes(32).toString('hex'),
      api,
      action,
      input,
      inputHash,
      submissionInput: withSubmissionAttribution(input),
      ...(options.plan ? { plan: options.plan } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'created',
      paymentChain: network,
      payWith,
    };
    await saveOrder(home, state);
  }

  await options.onSaved?.(state);

  if (state.status === 'admitted') {
    return { state, status: 'admitted' };
  }
  if (state.status === 'refused') {
    return { state, status: state.status };
  }

  try {
    let paymentSigned = state.onchainPayment || state.paymentHeader || state.quoteSignature;
    if (paymentSigned && (Number(state.quote.expiresAt) * 1000 <= Date.now()
      || ['expired', 'payment_failed'].includes(state.status))) {
      options.onProgress?.({ phase: 'checking_payment', message: 'Checking the original payment before continuing...' });
      applyOrderStatus(state, await fetchOrderStatus(api, state.requestToken, state.orderId));
      await saveOrder(home, state);
      if (state.status === 'admitted' || state.status === 'refused') return { state, status: state.status };
      if (await authorizationUnpaid(state, options)) {
        if (state.onchainPayment) {
          const client = await getPublicRpcClient(options, state.onchainPayment.chainId);
          if (!await transactionReceipt(client, state.onchainPayment)) retainExpiredNonce(state, state.onchainPayment);
        }
        state.paymentHistory = [...(state.paymentHistory ?? []), {
          orderId: state.orderId, quote: state.quote, onchainQuotes: state.onchainQuotes,
          payment: state.payment, paymentHeader: state.paymentHeader, quoteSignature: state.quoteSignature,
          onchainPayment: state.onchainPayment, transactionHash: state.transactionHash,
          submittedAt: state.submittedAt, unpaid: true,
        }];
        for (const field of ['payment', 'paymentHeader', 'paymentHash', 'quoteSignature', 'onchainPayment', 'transactionHash', 'submittedAt', 'paymentStatus']) delete state[field];
        paymentSigned = false;
        delete state.pendingTransaction;
        await saveOrder(home, state);
      } else {
        throw Object.assign(new Error('The previous payment is still being reconciled. Your task is saved. Continue this task again after chain confirmation; no new payment was signed.'), { code: 'payment_reconciling' });
      }
    }
    if (!paymentSigned && state.orderId && (['expired', 'payment_failed'].includes(state.status)
      || Number(state.quote.expiresAt) * 1000 <= Date.now() + 30_000)) {
      // A remote quote has a fixed lifetime. Keep one local task and its
      // transaction history while requesting new terms with a new server key.
      state.quoteHistory = [...(state.quoteHistory ?? []), {
        orderId: state.orderId, requestKey: state.serverRequestKey ?? state.requestKey,
        quote: state.quote, onchainQuotes: state.onchainQuotes, status: state.status,
      }];
      state.serverRequestKey = randomUUID();
      for (const field of ['orderId', 'orderStatus', 'quote', 'onchainQuotes', 'challenge', 'lastStatus', 'paymentStatus', 'paymentReview']) delete state[field];
      state.status = 'created';
      state.lastError = null;
      await saveOrder(home, state);
    }
    if (!state.orderId) {
      options.onProgress?.({ phase: 'quote', message: 'Checking your task and requesting a current price...' });
      const submissionInput = state.submissionInput ?? state.input;
      const check = await checkJob(api, submissionInput, action, options.signal);
      state.check = check;
      if (options.onCheck) await options.onCheck(check);
      if (check.blockers.length > 0) {
        state.status = 'blocked';
        state.lastError = null;
        await saveOrder(home, state);
        return { state, status: 'blocked', check };
      }

      if (action === 'job.continue') {
        const account = await getSigner(options);
        state.owner = await assertContinueOwner({
          api,
          input,
          check,
          account,
          owner: state.owner,
        });
      }

      let order;
      try { order = await quoteJob(api, state.requestToken, state.serverRequestKey ?? state.requestKey, submissionInput, action, options.signal); }
      catch (error) {
        // The first quote response may have been lost and expired before retry.
        if (error.status !== 410) throw error;
        state.serverRequestKey = randomUUID();
        await saveOrder(home, state);
        order = await quoteJob(api, state.requestToken, state.serverRequestKey, submissionInput, action, options.signal);
      }
      state.orderId = order.id;
      state.orderStatus = order.status;
      state.quote = order.quote;
      state.onchainQuotes = order.onchain;
      state.status = 'quoted';
      state.lastError = null;
      await saveOrder(home, state);
    }

    assertQuotePayment(orderPayment(state));

    if (!state.onchainPayment && (!state.paymentHeader || !state.quoteSignature)) {
      if (!state.challenge) {
        const challenge = await getChallenge(api, state.requestToken, state.orderId, options.signal);
        assertChallengeMatchesQuote(challenge, state);
        state.challenge = challenge;
        state.status = 'challenged';
        await saveOrder(home, state);
      } else {
        assertChallengeMatchesQuote(state.challenge, state);
      }

      let account;
      if (action === 'job.continue') {
        account = await getSigner(options);
        state.owner = await assertContinueOwner({
          api,
          input,
          check: state.check,
          account,
          owner: state.owner,
        });
        await saveOrder(home, state);
      }

      await selectSupport(state, options);
      options.signal?.throwIfAborted();
      assertOrderNotCancelled(await findOrder(home, state.requestKey));
      await saveOrder(home, state);
      await fundOrder(state, options, (order) => confirmOrder(order, options));
      if (state.paymentChain === 'robinhood') {
        await signOnchainPayment(state, options);
      } else {
        options.onProgress?.({ phase: 'signing', message: 'Signing task payment authorization...' });
        options.signal?.throwIfAborted();
        assertOrderNotCancelled(await findOrder(home, state.requestKey));
        account = await getSigner(options);
        options.signal?.throwIfAborted();
        assertOrderNotCancelled(await findOrder(home, state.requestKey));
        state.payer = account.address;
        await saveOrder(home, state);
        const built = await buildPayment(account, state.challenge);
        const quoteSignature = await signQuoteApproval(account, state.challenge, built.paymentHash);
        state.payment = built.payment;
        state.paymentHeader = built.paymentHeader;
        state.paymentHash = built.paymentHash;
        state.quoteSignature = quoteSignature;
        state.status = 'signed';
        state.lastError = null;
        await saveOrder(home, state);
      }
    }

    if (state.onchainPayment) await submitOnchainPayment(state, options);
    else {
      options.onProgress?.({ phase: 'broadcasting', message: 'Submitting task payment to IMD...' });
      await submitSignedOrder(api, state.requestToken, state, home, options.signal);
    }
    options.onProgress?.({ phase: 'admission', message: 'Payment submitted. Waiting for IMD to accept the task...' });
    const final = await pollOrder(api, state.requestToken, state.orderId, options);
    applyOrderStatus(state, final);
    delete state.recoveryStatus;
    await saveOrder(home, state);
    return { state, status: state.status };
  } catch (error) {
    if (['order_cancelled', 'order_changed', 'change_payment'].includes(error.code)) throw error;
    // Unlocking can wait for user input while another terminal cancels this request.
    // Do not overwrite that cancellation when recording an unlock or network error.
    assertOrderNotCancelled(await findOrder(home, state.requestKey));
    const refreshed = await refreshAfterSignedExpiry(error, api, state, home);
    if (refreshed) return { state, status: state.status };
    state.lastError = error.message;
    if (['transaction_pending', 'payment_reconciling'].includes(error.code)) state.recoveryStatus = error.code;
    if (error.transaction) state.pendingTransaction = error.transaction;
    if (error.status === 402) state.status = 'signed';
    await saveOrder(home, state);
    if (error.code === 'funding_required' && error.funding) error.funding.canChangePayment = orderActions(state).canCancel;
    if (error.code === 'owner_mismatch') throw error;
    throw recoveryError(error, state, { file, home, api, retryCommand: options.retryCommand });
  }
}

export async function submitOrder(options) {
  const { home, id } = options;
  const state = await findOrder(home, id);
  assertOrderNotCancelled(state);

  if (state.status === 'admitted') return state;
  if (state.status === 'refused') return state;
  if (state.api !== options.api) {
    throw new Error(`order ${state.requestKey} belongs to ${state.api}; rerun with --api ${state.api}`);
  }
  return (await publishJob({ ...options, requestKey: state.requestKey, input: state.input, action: state.action,
    paymentChain: state.paymentChain ?? 'ethereum', payWith: state.payWith })).state;
}
