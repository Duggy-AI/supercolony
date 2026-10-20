import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import {
  PAIR_EXPIRES_AT_NOTE,
  assertPairCompleteState,
  buildPairTypedData,
  buildPairWireMessage,
  pairExpiresAt,
  selectWalletToken,
  signPairAuthorization,
} from '../src/worker/pairing.mjs';
import { applyConfigPatch, patchConfigFile } from '../src/worker/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCH_SCRIPT = fs.readFileSync(
  path.join(HERE, '..', 'src', 'worker', 'remote', 'config-patch.cjs'),
  'utf8',
);

const pairing = {
  code: '2QQRNHJP',
  nonce: 'f6a05d2e0fa88e340f71a8ef2fa6186913efb2b710832af9d77047dac954f1d2',
  expiresAt: '2030-10-17T15:10:21.503Z',
  relayOrigin: 'https://api.imd.fun',
  chainId: 1,
  nftContract: '0x0000ec93127baa929e58e97dd0095a2bfb38ec1d',
};
const deviceKey = 'f1006806116538ac367bd59eb04775ae63f3d6cd34f18efe9139ae9a678f04f0';

test('pairing typed data recovers the local signer and wire fields drop 0x', async () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const tokenId = '1368';
  const expiresAt = Math.floor(Date.parse(pairing.expiresAt) / 1000);
  const { typedData, signature, message } = await signPairAuthorization(account, pairing, {
    deviceKey,
    wallet: account.address,
    tokenId,
    expiresAt,
  });

  assert.equal(typedData.primaryType, 'WorkerAuthorization');
  assert.equal(typedData.domain.name, 'IdentityMD Worker');
  assert.equal(typedData.domain.version, '2');
  assert.equal(typedData.domain.verifyingContract, pairing.nftContract);
  assert.equal(typedData.message.deviceKey, `0x${deviceKey}`);
  assert.equal(typedData.message.nonce, `0x${pairing.nonce}`);
  assert.equal(typedData.message.expiresAt, BigInt(expiresAt));

  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());

  assert.equal(message.deviceKey, deviceKey);
  assert.equal(message.nonce, pairing.nonce);
  assert.equal(message.tokenId, tokenId);
  assert.equal(message.expiresAt, expiresAt);
  assert.equal(message.wallet, account.address.toLowerCase());
  assert.equal(message.deviceKey.startsWith('0x'), false);
  assert.equal(message.nonce.startsWith('0x'), false);
  assert.equal(JSON.stringify(message).includes('0x'), true); // wallet only
});

test('expiresAt follows /pair/start Unix seconds (documented discrepancy)', () => {
  assert.equal(pairExpiresAt(pairing, 0), Math.floor(Date.parse(pairing.expiresAt) / 1000));
  assert.match(PAIR_EXPIRES_AT_NOTE, /now\+900/);
});

test('multiple wallet tokens require an explicit --token-id', () => {
  const wallet = {
    wallet: '0xbc15ac912c4af743eed5c0f033824de9de95cd4f',
    tokens: [{ tokenId: '650' }, { tokenId: '1368' }],
  };
  assert.throws(() => selectWalletToken(wallet), /multiple tokens/);
  assert.equal(selectWalletToken(wallet, '1368').tokenId, '1368');
  assert.throws(() => selectWalletToken(wallet, '42'), /does not hold/);
  assert.throws(() => selectWalletToken({ tokens: [] }), /holds no IdentityMD seat/);
});

test('config patch preserves devicePrivateKey without printing it', () => {
  const secret = 'DEVICE-PRIVATE-KEY-MATERIAL';
  const original = {
    deviceKey,
    devicePrivateKey: secret,
    wallet: null,
    tokenId: null,
    server: 'https://api.imd.fun',
    maxConcurrency: 2,
    inference: { premium: { claude: { model: 'x' } } },
  };
  const { config, summary } = applyConfigPatch(original, {
    wallet: '0xBC15AC912C4AF743EED5C0F033824DE9DE95CD4F',
    tokenId: '1368',
    deviceKey,
  });
  assert.equal(config.devicePrivateKey, secret);
  assert.equal(config.wallet, '0xbc15ac912c4af743eed5c0f033824de9de95cd4f');
  assert.equal(config.tokenId, '1368');
  assert.deepEqual(config.inference, original.inference);
  assert.equal(config.server, original.server);
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(summary.devicePrivateKeyPreserved, true);

  assert.throws(
    () => applyConfigPatch({ deviceKey }, { wallet: config.wallet, tokenId: '1' }),
    /no devicePrivateKey/,
  );
  assert.throws(
    () => applyConfigPatch(original, { wallet: config.wallet, tokenId: '1', deviceKey: 'a'.repeat(64) }),
    /does not match/,
  );
});

test('local config patch writes wallet/tokenId and keeps the private key on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-config-'));
  const file = path.join(dir, 'config.json');
  const secret = 'PRIVATE-KEY-STAYS';
  fs.writeFileSync(
    file,
    JSON.stringify({ deviceKey, devicePrivateKey: secret, wallet: null, tokenId: null, maxConcurrency: 1 }),
    { mode: 0o600 },
  );
  try {
    const summary = patchConfigFile(file, {
      wallet: '0xbc15ac912c4af743eed5c0f033824de9de95cd4f',
      tokenId: '42',
      deviceKey,
    });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.devicePrivateKey, secret);
    assert.equal(saved.tokenId, '42');
    assert.equal(JSON.stringify(summary).includes(secret), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remote config patch script returns a safe summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-remote-config-'));
  const file = path.join(dir, 'config.json');
  const secret = 'REMOTE-DEVICE-KEY';
  fs.writeFileSync(
    file,
    JSON.stringify({ deviceKey, devicePrivateKey: secret, wallet: null, tokenId: null, maxConcurrency: 3 }),
    { mode: 0o600 },
  );
  try {
    const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', PATCH_SCRIPT], {
      input: JSON.stringify({
        path: file,
        wallet: '0xbc15ac912c4af743eed5c0f033824de9de95cd4f',
        tokenId: '1368',
        deviceKey,
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(secret), false);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.devicePrivateKeyPreserved, true);
    assert.equal(summary.tokenId, '1368');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.devicePrivateKey, secret);
    assert.equal(saved.maxConcurrency, 3);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pair status must be enrolled before config is changed', () => {
  assert.throws(() => assertPairCompleteState({ enrolled: false }, { wallet: '0x' + 'ab'.repeat(20), tokenId: '1' }), /not confirmed/);
  assert.throws(
    () =>
      assertPairCompleteState(
        { enrolled: true, wallet: '0x' + 'cd'.repeat(20), tokenId: '1' },
        { wallet: '0x' + 'ab'.repeat(20), tokenId: '1' },
      ),
    /different wallet/,
  );
  assert.doesNotThrow(() =>
    assertPairCompleteState(
      { enrolled: true, wallet: '0x' + 'ab'.repeat(20), tokenId: '1' },
      { wallet: '0x' + 'ab'.repeat(20), tokenId: '1' },
    ),
  );
});

test('typed data builder keeps bytes32 0x only for signing', () => {
  const typedData = buildPairTypedData(pairing, {
    deviceKey,
    wallet: '0xbc15ac912c4af743eed5c0f033824de9de95cd4f',
    tokenId: '1368',
    expiresAt: 1900000000,
  });
  const wire = buildPairWireMessage(typedData);
  assert.equal(typedData.message.deviceKey, `0x${deviceKey}`);
  assert.equal(wire.deviceKey, deviceKey);
  assert.equal(wire.nonce, pairing.nonce);
});
