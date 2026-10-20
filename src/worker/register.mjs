import { readState, writeState } from './context.mjs';
import { readWorkerConfigSummary } from './config.mjs';
import { sleep } from './process.mjs';

export function normalizeTxHash(value) {
  const text = String(value ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error(`invalid transaction hash: ${JSON.stringify(value)}`);
  }
  return text.toLowerCase();
}

export function registrationKey(ctx, tokenId) {
  return `${ctx.key}:${tokenId}`;
}

export function readRegistration(ctx, tokenId) {
  const state = readState(ctx.home);
  return state.registrations[registrationKey(ctx, tokenId)] ?? null;
}

export function saveRegistration(ctx, tokenId, patch) {
  const state = readState(ctx.home);
  const key = registrationKey(ctx, tokenId);
  state.registrations[key] = { ...(state.registrations[key] ?? {}), ...patch };
  writeState(ctx.home, state);
  return state.registrations[key];
}

export function assertRegisterIntent(intent) {
  if (!intent || typeof intent !== 'object') throw new Error('register-intent returned no data');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(intent.to ?? ''))) {
    throw new Error('register-intent has an invalid target address');
  }
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(String(intent.data ?? ''))) {
    throw new Error('register-intent has invalid calldata');
  }
  if (!Number.isInteger(intent.chainId) || intent.chainId <= 0) {
    throw new Error('register-intent has an invalid chainId');
  }
  return intent;
}

export function buildRegisterPlan({ chainId, chainName, from, to, data, value, gas, gasPrice, agentURI }) {
  return {
    chainId,
    chainName: chainName ?? `chain-${chainId}`,
    from,
    to,
    data,
    value: String(value),
    gas: String(gas),
    gasPrice: String(gasPrice),
    maxFeeWei: String(gas * gasPrice),
    agentURI: agentURI ?? null,
  };
}

export function formatRegisterPlan(plan) {
  return [
    'Register this token as an ERC-8004 agent?',
    `  chain:     ${plan.chainName} (${plan.chainId})`,
    `  from:      ${plan.from}`,
    `  to:        ${plan.to}`,
    `  value:     ${plan.value} wei`,
    `  gas:       ${plan.gas}`,
    `  gas price: ${plan.gasPrice} wei`,
    `  max fee:   ${plan.maxFeeWei} wei`,
    `  calldata:  ${plan.data}`,
    ...(plan.agentURI ? [`  agentURI:  ${plan.agentURI}`] : []),
  ].join('\n');
}

export async function pollAgentBind({
  request,
  api,
  tokenId,
  txHash,
  attempts = 30,
  intervalMs = 4000,
  sleepFn = sleep,
  onPoll = () => {},
}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await request(api, '/agents/bind', {
      method: 'POST',
      body: { tokenId, txHash },
    });
    last = response.data;
    if (last && typeof last === 'object' && last.agentId) {
      return { agentId: String(last.agentId), response: last, attempts: attempt };
    }
    onPoll(attempt, last);
    if (attempt < attempts) await sleepFn(intervalMs);
  }
  throw new Error(`transaction ${txHash} was sent but bind did not report an agentId after ${attempts} polls; rerun with --tx-hash ${txHash}`);
}

export async function runRegister({ ctx, options, shared, log = () => {} }) {
  const { request, getRpcClients, confirmAction } = shared;
  const api = options.api ?? 'https://api.imd.fun';

  let tokenId = options.tokenId ? String(options.tokenId).trim() : null;
  if (tokenId === null) {
    const config = await readWorkerConfigSummary(ctx);
    tokenId = config.tokenId ? String(config.tokenId) : null;
  }
  if (!tokenId || !/^[1-9][0-9]*$/.test(tokenId)) {
    throw new Error('no token id: pass --token-id or pair the worker first');
  }

  const existing = await request(api, '/agents/bind', {
    method: 'POST',
    body: { tokenId },
  });
  if (existing.data?.agentId) {
    saveRegistration(ctx, tokenId, { agentId: String(existing.data.agentId), status: 'registered' });
    return { tokenId, agentId: String(existing.data.agentId), alreadyRegistered: true };
  }
  if (existing.data?.pending === true && !options.txHash) {
    throw new Error('registration already pending; no new transaction; retry later or resume with --tx-hash');
  }

  let txHash = options.txHash ? normalizeTxHash(options.txHash) : null;
  let plan = null;

  if (!txHash) {
    const saved = readRegistration(ctx, tokenId);
    if (saved?.status === 'sending' && !saved.txHash) {
      throw new Error(
        'a previous registration attempt was interrupted before a transaction hash was recorded; ' +
          'its outcome is unknown, so colony will not send another transaction. Check the chain/agent, ' +
          'or resume with --tx-hash if you have one.',
      );
    }
    if (saved?.txHash && saved.status !== 'registered') {
      throw new Error(
        `a previous registration transaction ${saved.txHash} was saved but not confirmed; ` +
          `resume with --tx-hash ${saved.txHash} (colony will not send another transaction automatically)`,
      );
    }

    const intent = assertRegisterIntent(
      (await request(api, `/agents/register-intent?tokenId=${encodeURIComponent(tokenId)}`)).data,
    );

    const { publicClient, walletClient, account } = await getRpcClients(options, intent.chainId);
    const gas = await publicClient.estimateGas({
      account: account.address,
      to: intent.to,
      data: intent.data,
      value: 0n,
    });
    const gasPrice = await publicClient.getGasPrice();
    plan = buildRegisterPlan({
      chainId: intent.chainId,
      chainName: publicClient.chain?.name,
      from: account.address,
      to: intent.to,
      data: intent.data,
      value: 0n,
      gas,
      gasPrice,
      agentURI: intent.agentURI,
    });

    await confirmAction(formatRegisterPlan(plan), options);

    saveRegistration(ctx, tokenId, {
      status: 'sending',
      chainId: intent.chainId,
      to: intent.to,
      gas: String(gas),
      gasPrice: String(gasPrice),
      startedAt: new Date().toISOString(),
    });

    const sent = await walletClient.sendTransaction({
      account,
      to: intent.to,
      data: intent.data,
      value: 0n,
      gas,
      gasPrice,
    });
    txHash = normalizeTxHash(sent);
    try {
      saveRegistration(ctx, tokenId, {
        status: 'submitted',
        txHash,
        chainId: intent.chainId,
        to: intent.to,
        gas: String(gas),
        gasPrice: String(gasPrice),
        submittedAt: new Date().toISOString(),
      });
    } catch (error) {
      throw new Error(`transaction ${txHash} was sent but its hash could not be saved (${error.message}); resume with --tx-hash ${txHash}`);
    }
    log(`sent registration transaction ${txHash}; waiting for confirmation`);
    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (error) {
      throw new Error(
        `transaction ${txHash} was sent but confirmation could not be read (${error.message}); resume with --tx-hash ${txHash}`,
      );
    }
    if (receipt.status !== 'success') {
      throw new Error(`transaction ${txHash} was mined but reverted; no bind was attempted`);
    }
  } else {
    saveRegistration(ctx, tokenId, { status: 'submitted', txHash });
  }

  const bound = await pollAgentBind({
    request,
    api,
    tokenId,
    txHash,
    onPoll: (attempt) => log(`waiting for agent registration (${attempt}/30)`),
  });
  saveRegistration(ctx, tokenId, {
    status: 'registered',
    txHash,
    agentId: bound.agentId,
    registeredAt: new Date().toISOString(),
  });
  return { tokenId, txHash, agentId: bound.agentId, plan };
}
