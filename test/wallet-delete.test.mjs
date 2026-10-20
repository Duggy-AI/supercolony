import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveLocalWallet, deleteLocalWallet, listWallets, walletInfo, walletFile, walletSigner,
  selectWallet, backupWallet, lockWallet } from '../src/lib/local-wallet.mjs';
import { TEST_KEY } from './helpers/cli.mjs';

const password = 'wallet deletion test password';
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'colony-wallet-delete-'));
  t.after(async () => { lockWallet(); await rm(home, { recursive: true, force: true }); });
  const first = await saveLocalWallet(home, password, TEST_KEY);
  const second = await saveLocalWallet(home);
  return { home, first, second };
}

test('deleting the first wallet keeps the current wallet, shared password, backups and task records', async t => {
  const { home, first, second } = await fixture(t);
  const third = await saveLocalWallet(home);
  const thirdFile = walletFile(home);
  const encryptedThird = await readFile(thirdFile, 'utf8');
  const secondFile = join(home, 'wallets', second.address.toLowerCase() + '.json');
  const encryptedSecond = await readFile(secondFile, 'utf8');
  const backup = join(home, 'saved-backup.json');
  await backupWallet(home, backup, first.address);
  const encryptedBackup = await readFile(backup, 'utf8');
  const taskRecord = join(home, 'saved-task.json');
  await writeFile(taskRecord, 'keep payment recovery data');

  const result = await deleteLocalWallet(home, first.address);
  assert.deepEqual(result, { deletedAddress: first.address, currentAddress: third.address });
  assert.deepEqual(new Set(listWallets(home).map(wallet => wallet.address)), new Set([second.address, third.address]));
  assert.equal(await readFile(join(home, 'wallet.json'), 'utf8'), encryptedThird);
  await assert.rejects(access(thirdFile), { code: 'ENOENT' });
  assert.equal(await readFile(secondFile, 'utf8'), encryptedSecond);
  assert.equal(await readFile(backup, 'utf8'), encryptedBackup);
  assert.equal(await readFile(taskRecord, 'utf8'), 'keep payment recovery data');
  assert.equal(walletInfo({ home }).address, third.address);
  assert.equal(walletInfo({ home }).locked, true, 'cached password and signers are cleared');
  const signer = await walletSigner({ home, requestPassword: async () => password });
  assert.equal(signer.address, third.address);
  await selectWallet(home, second.address);
  assert.equal((await walletSigner({ home })).address, second.address);
});

test('deleting the current first wallet promotes the remaining wallet and deleting the last resets setup', async t => {
  const { home, first, second } = await fixture(t);
  await selectWallet(home, first.address);
  assert.equal((await deleteLocalWallet(home, first.address)).currentAddress, second.address);
  assert.equal(walletFile(home), join(home, 'wallet.json'));
  await assert.rejects(walletSigner({ home, requestPassword: async () => 'wrong password' }), /Could not unlock/);
  assert.equal((await walletSigner({ home, requestPassword: async () => password })).address, second.address);

  assert.deepEqual(await deleteLocalWallet(home, second.address), { deletedAddress: second.address, currentAddress: null });
  assert.deepEqual(listWallets(home), []);
  const options = { home, keyEnv: 'COLONY_DELETE_TEST_NO_KEY' };
  assert.equal(walletInfo(options).configured, false);
  await assert.rejects(access(join(home, 'wallet.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(home, 'wallet-selection.json')), { code: 'ENOENT' });
  await assert.rejects(walletSigner(options), /No wallet configured/);
  await saveLocalWallet(home, 'a different local password', TEST_KEY);
  lockWallet();
  await assert.rejects(walletSigner({ home, requestPassword: async () => password }), /Could not unlock/);
  assert.equal((await walletSigner({ home, requestPassword: async () => 'a different local password' })).address, first.address);
});

test('deleting an additional wallet preserves an unrelated current wallet and rejects unknown addresses', async t => {
  const { home, first, second } = await fixture(t);
  await selectWallet(home, first.address);
  const root = await readFile(join(home, 'wallet.json'), 'utf8');
  await assert.rejects(deleteLocalWallet(home, '0x' + '11'.repeat(20)), /Saved wallet not found/);
  assert.equal(listWallets(home).length, 2);
  assert.equal((await deleteLocalWallet(home, second.address)).currentAddress, first.address);
  assert.equal(await readFile(join(home, 'wallet.json'), 'utf8'), root);
  assert.equal(walletInfo({ home }).address, first.address);
  assert.deepEqual(listWallets(home).map(wallet => wallet.address), [first.address]);
  assert.equal((await walletSigner({ home, requestPassword: async () => password })).address, first.address);
});

test('deleting a wallet while password entry is pending prevents its signer from being returned', async t => {
  const { home, first, second } = await fixture(t);
  lockWallet();
  await assert.rejects(walletSigner({ home, requestPassword: async () => {
    await deleteLocalWallet(home, second.address);
    return password;
  } }), /Wallets were locked/);
  assert.equal(walletInfo({ home }).address, first.address);
  assert.equal(walletInfo({ home }).locked, true);
  assert.equal((await walletSigner({ home, requestPassword: async () => password })).address, first.address);
});
