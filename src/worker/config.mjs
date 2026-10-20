import fs from 'node:fs';
import path from 'node:path';
import { runNodeEval } from './context.mjs';

const PATCH_SCRIPT = fs.readFileSync(new URL('./remote/config-patch.cjs', import.meta.url), 'utf8');
const SUMMARY_SCRIPT = fs.readFileSync(new URL('./remote/config-summary.cjs', import.meta.url), 'utf8');

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

/**
 * Pure read-modify-write.  Only wallet/tokenId change; every other field
 * (notably devicePrivateKey) is carried through untouched.  The returned
 * summary intentionally omits the private key.
 */
export function applyConfigPatch(config, { wallet, tokenId, deviceKey } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config.json is not an object');
  }
  if (typeof config.devicePrivateKey !== 'string' || config.devicePrivateKey.length === 0) {
    throw new Error('config.json has no devicePrivateKey; refusing to patch the wrong file');
  }
  if (deviceKey && config.deviceKey !== deviceKey) {
    throw new Error('config.json deviceKey does not match this worker; refusing to patch');
  }
  const next = {
    ...config,
    wallet: normalizeWallet(wallet),
    tokenId: normalizeTokenId(tokenId),
  };
  return {
    config: next,
    summary: {
      ok: true,
      wallet: next.wallet,
      tokenId: next.tokenId,
      deviceKey: next.deviceKey ?? null,
      devicePrivateKeyPreserved: true,
    },
  };
}

export function patchConfigFile(configPath, patch) {
  if (!path.isAbsolute(configPath)) throw new Error('config path must be absolute');
  const raw = fs.readFileSync(configPath, 'utf8');
  const { config, summary } = applyConfigPatch(JSON.parse(raw), patch);
  const tmp = `${configPath}.colony-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, configPath);
  if (process.platform !== 'win32') fs.chmodSync(configPath, 0o600);
  return { ...summary, path: configPath };
}

export function readConfigSummary(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, path: configPath };
    throw error;
  }
  const config = JSON.parse(raw);
  return {
    exists: true,
    path: configPath,
    deviceKey: config.deviceKey ?? null,
    wallet: config.wallet ?? null,
    tokenId: config.tokenId ?? null,
  };
}

function parseSingleJsonLine(result, label) {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim().slice(-800)}`);
  }
  const line = result.stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .reverse()
    .find((candidate) => candidate.startsWith('{'));
  if (!line) throw new Error(`${label} returned no result`);
  return JSON.parse(line);
}

export async function readWorkerConfigSummary(ctx) {
  if (ctx.kind === 'local') return readConfigSummary(ctx.configPath);
  const result = await runNodeEval(ctx, SUMMARY_SCRIPT, {
    input: JSON.stringify({ path: ctx.configPath }),
  });
  return parseSingleJsonLine(result, 'reading worker config');
}

export async function patchWorkerConfig(ctx, patch) {
  const payload = { path: ctx.configPath, ...patch };
  if (ctx.kind === 'local') return patchConfigFile(ctx.configPath, patch);
  const result = await runNodeEval(ctx, PATCH_SCRIPT, { input: JSON.stringify(payload) });
  return { ...parseSingleJsonLine(result, 'patching worker config'), path: ctx.configPath };
}
