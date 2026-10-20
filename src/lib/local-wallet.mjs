import { readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile, rename, unlink, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readPassword } from './password.mjs';

const unlocked = new Map();
const passwords = new Map();
let lockVersion = 0;

function session(home) {
  const saved = passwords.get(resolve(home));
  return saved?.root === readOptional(join(home, 'wallet.json')) ? saved : null;
}

export async function unlockWallet(options, password) {
  const { home, signal } = options;
  if (session(home)) return session(home).password;
  const root = record(join(home, 'wallet.json'), readFileSync(join(home, 'wallet.json'), 'utf8'));
  const version = lockVersion;
  password ??= await (options.requestPassword ?? readPassword)('Local wallet password', { signal });
  const { decryptKeystoreJson } = await import('ethers');
  let decrypted;
  try { decrypted = await decryptKeystoreJson(root.json, password); }
  catch { throw new Error('Could not unlock wallets. Check your local wallet password.'); }
  signal?.throwIfAborted();
  if (version !== lockVersion) throw new Error('Wallets were locked. Unlock again to continue.');
  if (keyAccount(decrypted.privateKey).address !== root.address) throw new Error('Wallet address does not match its encrypted key.');
  passwords.set(resolve(home), { password, root: root.json });
  return password;
}

function readOptional(file) {
  try { return readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function record(file, json) {
  const document = JSON.parse(json);
  if (document.version !== 3) throw new Error('Unsupported wallet file. Restore a JSON keystore backup.');
  return { file, json, address: getAddress('0x' + document.address.replace(/^0x/, '')) };
}

function records(home) {
  if (!home) return [];
  const first = join(home, 'wallet.json');
  const json = readOptional(first);
  const wallets = json ? [record(first, json)] : [];
  let files;
  try { files = readdirSync(join(home, 'wallets')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
  for (const name of files.filter(name => /^0x[0-9a-f]{40}\.json$/.test(name)).sort()) {
    const file = join(home, 'wallets', name);
    wallets.push(record(file, readFileSync(file, 'utf8')));
  }
  return wallets;
}

function selectedRecord(home, wallets = records(home)) {
  if (!home) return null;
  const saved = readOptional(join(home, 'wallet-selection.json'));
  if (!saved) return wallets[0] ?? null;
  const { address } = JSON.parse(saved);
  const selected = wallets.find(wallet => wallet.address === address);
  if (!selected) throw new Error('The selected wallet file is missing. Use wallet list and wallet use to select another wallet.');
  return selected;
}

export const walletFile = home => selectedRecord(home)?.file ?? join(home, 'wallet.json');

export function listWallets(home) {
  const wallets = records(home);
  const saved = home ? readOptional(join(home, 'wallet-selection.json')) : null;
  const active = saved ? JSON.parse(saved).address : wallets[0]?.address;
  return wallets.map(wallet => ({ address: wallet.address, active: wallet.address === active,
    locked: !session(home) }));
}

export async function selectWallet(home, address) {
  const normalized = getAddress(address);
  if (!records(home).some(wallet => wallet.address === normalized)) throw new Error('Wallet not found. Create, import or restore it first.');
  const file = join(home, 'wallet-selection.json');
  const temporary = join(home, '.wallet-selection-' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify({ address: normalized }) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return walletInfo({ home });
}

export async function deleteLocalWallet(home, address) {
  const normalized = getAddress(address);
  const wallets = records(home);
  const target = wallets.find(wallet => wallet.address === normalized);
  if (!target) throw new Error('Saved wallet not found.');
  const current = selectedRecord(home, wallets);
  const remaining = wallets.filter(wallet => wallet !== target);
  const next = current.address === target.address ? remaining[0] : current;
  lockWallet();
  // wallet.json verifies the shared password. Promote a remaining encrypted
  // wallet atomically so deleting the first wallet preserves that password.
  if (target.file === join(home, 'wallet.json') && next) {
    await rename(next.file, target.file);
  } else {
    await unlink(target.file);
  }
  if (next) await selectWallet(home, next.address);
  else await rm(join(home, 'wallet-selection.json'), { force: true });
  return { deletedAddress: target.address, currentAddress: next?.address ?? null };
}

export function keyAccount(raw, label = 'Private key') {
  const key = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${label} must be a 0x-prefixed 32-byte hex private key`);
  try { return privateKeyToAccount(key); }
  catch { throw new Error(`${label} is not a valid wallet private key.`); }
}

export function walletInfo(options = {}) {
  const selected = selectedRecord(options.home);
  if (selected) {
    return { configured: true, address: selected.address, source: 'local', locked: !session(options.home) };
  }
  const keyEnv = options.keyEnv ?? 'COLONY_PRIVATE_KEY';
  const raw = process.env[keyEnv];
  return raw ? { configured: true, address: keyAccount(raw, keyEnv).address, source: 'environment', locked: false }
    : { configured: false, address: null, source: null, locked: true };
}

export function lockWallet() { unlocked.clear(); passwords.clear(); lockVersion++; }

export async function walletSigner(options = {}) {
  if (options.expectedWallet && walletInfo(options).address !== getAddress(options.expectedWallet)) {
    throw new Error('Payment wallet changed. Review the order with the intended wallet before paying.');
  }
  const selected = selectedRecord(options.home);
  if (!selected) {
    const keyEnv = options.keyEnv ?? 'COLONY_PRIVATE_KEY';
    if (!process.env[keyEnv]) throw new Error('No wallet configured. Open Wallet to create or import one, or run colony wallet create.');
    return keyAccount(process.env[keyEnv], keyEnv);
  }
  const { json } = selected;
  const file = resolve(selected.file);
  const version = lockVersion;
  const password = await unlockWallet(options);
  if (walletInfo(options).address !== selected.address) throw new Error('Active wallet changed while unlocking. Review the payment again.');
  if (unlocked.get(file)?.json === json) return unlocked.get(file).account;
  const { decryptKeystoreJson } = await import('ethers');
  let decrypted;
  try { decrypted = await decryptKeystoreJson(json, password); }
  catch { throw new Error('Could not unlock wallet. Check your password and wallet file.'); }
  options.signal?.throwIfAborted();
  if (version !== lockVersion) throw new Error('Wallets were locked. Unlock again to continue.');
  const account = keyAccount(decrypted.privateKey);
  if (account.address !== selected.address) throw new Error('Wallet address does not match its encrypted key.');
  if (walletInfo(options).address !== account.address) throw new Error('Active wallet changed while unlocking. Review the payment again.');
  unlocked.set(file, { json, account });
  return account;
}

export async function saveLocalWallet(home, password, privateKey = generatePrivateKey(), options = {}) {
  const { signal } = options;
  const account = keyAccount(privateKey);
  const wallets = records(home);
  if (wallets.some(wallet => wallet.address === account.address)) throw new Error('This wallet already exists. Select it in Wallets and press u, or use colony wallet use <address>. Its encrypted file will not be overwritten.');
  if (wallets.length) password = await unlockWallet({ ...options, home }, password);
  if (!password || password.length < 8) throw new Error('Use a wallet password with at least 8 characters.');
  const version = lockVersion;
  const { encryptKeystoreJson } = await import('ethers');
  const json = await encryptKeystoreJson({ address: account.address, privateKey: privateKey.trim() }, password);
  signal?.throwIfAborted();
  if (version !== lockVersion) throw new Error('Wallets were locked. Unlock again to continue.');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = wallets.length === 0 ? join(home, 'wallet.json') : join(home, 'wallets', account.address.toLowerCase() + '.json');
  if (wallets.length) await mkdir(join(home, 'wallets'), { recursive: true, mode: 0o700 });
  await writeFile(file, json + '\n', { flag: 'wx', mode: 0o600 });
  passwords.set(resolve(home), { password, root: readFileSync(join(home, 'wallet.json'), 'utf8') });
  return selectWallet(home, account.address);
}

export async function backupWallet(home, out, address) {
  const target = resolve(out);
  const source = address ? records(home).find(wallet => wallet.address === getAddress(address))?.file : walletFile(home);
  if (!source) throw new Error('Saved wallet not found.');
  await copyFile(source, target, constants.COPYFILE_EXCL);
  return { path: target };
}

export async function revealPrivateKey(home, address, password, { signal } = {}) {
  const wallet = records(home).find(wallet => wallet.address === getAddress(address));
  if (!wallet) throw new Error('Saved wallet not found.');
  const { decryptKeystoreJson } = await import('ethers');
  let decrypted;
  try { decrypted = await decryptKeystoreJson(wallet.json, password); }
  catch { throw new Error('Incorrect wallet password.'); }
  signal?.throwIfAborted();
  if (keyAccount(decrypted.privateKey).address !== wallet.address) throw new Error('Wallet address does not match its encrypted key.');
  return { address: wallet.address, privateKey: decrypted.privateKey };
}

export async function restoreWallet(home, file, password, options = {}) {
  const json = await readFile(file, 'utf8');
  const { decryptKeystoreJson } = await import('ethers');
  let account;
  try { account = await decryptKeystoreJson(json, password); }
  catch { throw new Error('Could not restore wallet. Check the backup file and password.'); }
  return saveLocalWallet(home, records(home).length ? undefined : password, account.privateKey, options);
}
