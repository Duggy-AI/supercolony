export const PAIR_DOMAIN = {
  name: 'IdentityMD Worker',
  version: '2',
};

export const WORKER_AUTHORIZATION_TYPES = {
  WorkerAuthorization: [
    { name: 'deviceKey', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'relayOrigin', type: 'string' },
  ],
};

// Research note: the docs describe `expiresAt` as the Unix seconds form of the
// /pair/start expiry, while the official pairing page signs now + 900s.  The
// CLI follows the instruction to use /pair/start's expiry; this discrepancy is
// recorded here so it is not silently "fixed" by a later refactor.
export const PAIR_EXPIRES_AT_NOTE =
  'expiresAt uses the /pair/start expiresAt Unix seconds; the official page uses now+900s';

export function normalizeDeviceKey(value) {
  const text = String(value ?? '').trim();
  const bare = text.startsWith('0x') || text.startsWith('0X') ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) {
    throw new Error(`invalid device key: ${JSON.stringify(value)}`);
  }
  return bare.toLowerCase();
}

export function normalizeNonce(value) {
  const text = String(value ?? '').trim();
  const bare = text.startsWith('0x') || text.startsWith('0X') ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) {
    throw new Error(`invalid pairing nonce: ${JSON.stringify(value)}`);
  }
  return bare.toLowerCase();
}

export function normalizeWallet(wallet) {
  const text = String(wallet ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`invalid wallet address: ${wallet}`);
  return text.toLowerCase();
}

export function normalizeTokenId(tokenId) {
  const text = String(tokenId ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`invalid token id: ${tokenId}`);
  return text;
}

export function assertPairingStart(data) {
  if (!data || typeof data !== 'object') throw new Error('/pair/start returned no pairing data');
  if (typeof data.code !== 'string' || data.code.length === 0) {
    throw new Error('/pair/start response is missing code');
  }
  const expiresMs = Date.parse(data.expiresAt);
  if (!Number.isFinite(expiresMs)) {
    throw new Error('/pair/start response has an invalid expiresAt');
  }
  if (!Number.isInteger(data.chainId) || data.chainId <= 0) {
    throw new Error('/pair/start response has an invalid chainId');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(data.nftContract ?? ''))) {
    throw new Error('/pair/start response has an invalid nftContract');
  }
  const relay = new URL(String(data.relayOrigin));
  if (relay.protocol !== 'https:' && relay.protocol !== 'http:') {
    throw new Error('/pair/start response has an invalid relayOrigin');
  }
  return {
    ...data,
    code: data.code,
    nonce: normalizeNonce(data.nonce),
    deviceKey: data.deviceKey ? normalizeDeviceKey(data.deviceKey) : null,
    chainId: data.chainId,
    nftContract: data.nftContract.toLowerCase(),
    relayOrigin: relay.origin,
  };
}

export function pairExpiresAt(pairing, nowMs = Date.now()) {
  const expiresMs = Date.parse(pairing.expiresAt);
  if (!Number.isFinite(expiresMs)) throw new Error('pairing has an invalid expiresAt');
  const seconds = Math.floor(expiresMs / 1000);
  if (seconds <= Math.floor(nowMs / 1000)) {
    throw new Error('the pairing code has already expired; run pair again');
  }
  return seconds;
}

export function buildPairTypedData(pairing, { deviceKey, wallet, tokenId, expiresAt }) {
  const device = normalizeDeviceKey(deviceKey);
  const nonce = normalizeNonce(pairing.nonce);
  const owner = normalizeWallet(wallet);
  const token = normalizeTokenId(tokenId);
  const expiry = BigInt(expiresAt ?? pairExpiresAt(pairing));
  if (expiry <= 0n) throw new Error('invalid pairing expiresAt');

  return {
    domain: {
      ...PAIR_DOMAIN,
      chainId: pairing.chainId,
      verifyingContract: pairing.nftContract,
    },
    types: WORKER_AUTHORIZATION_TYPES,
    primaryType: 'WorkerAuthorization',
    message: {
      deviceKey: `0x${device}`,
      wallet: owner,
      tokenId: token,
      nonce: `0x${nonce}`,
      expiresAt: expiry,
      relayOrigin: pairing.relayOrigin,
    },
  };
}

/** Wire format: bytes32 fields lose the 0x prefix, tokenId/expiresAt are scalars. */
export function buildPairWireMessage(typedData) {
  const message = typedData.message;
  return {
    deviceKey: message.deviceKey.replace(/^0x/, '').toLowerCase(),
    wallet: message.wallet.toLowerCase(),
    tokenId: String(message.tokenId),
    nonce: message.nonce.replace(/^0x/, '').toLowerCase(),
    expiresAt: Number(message.expiresAt),
    relayOrigin: message.relayOrigin,
  };
}

export async function signPairAuthorization(account, pairing, { deviceKey, wallet, tokenId, expiresAt }) {
  const typedData = buildPairTypedData(pairing, {
    deviceKey,
    wallet: wallet ?? account.address,
    tokenId,
    expiresAt,
  });
  const signature = await account.signTypedData(typedData);
  return { typedData, signature, message: buildPairWireMessage(typedData) };
}

export function selectWalletToken(walletInfo, requestedTokenId) {
  const tokens = Array.isArray(walletInfo?.tokens) ? walletInfo.tokens : [];
  if (requestedTokenId !== undefined && requestedTokenId !== null && requestedTokenId !== '') {
    const requested = normalizeTokenId(requestedTokenId);
    const found = tokens.find((token) => String(token.tokenId) === requested);
    if (!found) {
      throw new Error(`wallet ${walletInfo?.wallet ?? ''} does not hold token ${requested}`);
    }
    return found;
  }
  if (tokens.length === 0) {
    throw new Error(`wallet ${walletInfo?.wallet ?? ''} holds no IdentityMD seat`);
  }
  if (tokens.length > 1) {
    const ids = tokens.map((token) => String(token.tokenId)).join(', ');
    throw new Error(`wallet holds multiple tokens (${ids}); pass --token-id`);
  }
  return tokens[0];
}

export function assertPairCompleteState(state, { wallet, tokenId }) {
  if (!state || typeof state !== 'object') throw new Error('pair status returned no state');
  if (state.enrolled !== true) {
    throw new Error(`pairing was not confirmed by the server (enrolled=${String(state.enrolled)}); config was not changed`);
  }
  if (state.wallet && normalizeWallet(state.wallet) !== normalizeWallet(wallet)) {
    throw new Error('pair status reported a different wallet; config was not changed');
  }
  if (state.tokenId !== null && state.tokenId !== undefined && String(state.tokenId) !== normalizeTokenId(tokenId)) {
    throw new Error('pair status reported a different tokenId; config was not changed');
  }
  return state;
}
