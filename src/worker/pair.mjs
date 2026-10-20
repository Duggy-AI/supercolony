import { runImd } from './context.mjs';
import { patchWorkerConfig } from './config.mjs';
import {
  assertPairCompleteState,
  assertPairingStart,
  normalizeDeviceKey,
  normalizeTokenId,
  normalizeWallet,
  pairExpiresAt,
  selectWalletToken,
  signPairAuthorization,
} from './pairing.mjs';

function deviceKeyFromWhoami(result) {
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || 'imd whoami failed').trim());
  }
  const matches = String(result.stdout ?? '').match(/[0-9a-fA-F]{64}/g) ?? [];
  const unique = [...new Set(matches.map((value) => value.toLowerCase()))];
  if (unique.length !== 1) {
    throw new Error('could not read a single device key from imd whoami; is this worker configured?');
  }
  return normalizeDeviceKey(unique[0]);
}

/**
 * Pure-CLI pairing: the device key is read from the worker, the wallet key is
 * used only in this local process to sign EIP-712, and the remote config is
 * patched in place with wallet/tokenId while preserving devicePrivateKey.
 */
export async function runPair({ ctx, options, shared, log = () => {} }) {
  const { request, getSigner } = shared;
  const api = options.api ?? 'https://api.imd.fun';

  const signer = await getSigner(options);
  const wallet = normalizeWallet(signer.address);

  const walletInfo = (
    await request(api, `/pair/wallet/${encodeURIComponent(wallet)}`)
  ).data;
  const token = selectWalletToken(walletInfo, options.tokenId);
  const tokenId = normalizeTokenId(token.tokenId);

  const who = await runImd(ctx, ['whoami'], { timeoutMs: 20_000 });
  const deviceKey = deviceKeyFromWhoami(who);

  const started = assertPairingStart(
    (
      await request(api, '/pair/start', {
        method: 'POST',
        body: { deviceKey },
      })
    ).data,
  );
  if (started.deviceKey && started.deviceKey !== deviceKey) {
    throw new Error('/pair/start returned a different device key; aborting');
  }

  const expiresAt = pairExpiresAt(started);
  const { signature, message } = await signPairAuthorization(signer, started, {
    deviceKey,
    wallet,
    tokenId,
    expiresAt,
  });
  // Only the signature and the wire message (bytes32 fields without 0x) go to
  // the relay; the wallet key never leaves this process.
  await request(api, '/pair/complete', {
    method: 'POST',
    body: { code: started.code, signature, message },
  });

  log('server accepted the signature; verifying pairing status before touching config');
  const state = (await request(api, `/pair/${encodeURIComponent(started.code)}`)).data;
  assertPairCompleteState(state, { wallet, tokenId });

  const summary = await patchWorkerConfig(ctx, { wallet, tokenId, deviceKey });
  const agentId = state.agentId ? String(state.agentId) : null;
  return {
    wallet,
    tokenId,
    deviceKey,
    expiresAt,
    agentId,
    registered: agentId !== null,
    config: summary,
  };
}
