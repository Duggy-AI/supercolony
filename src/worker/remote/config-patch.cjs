#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

// Streamed to `node -e` on the worker host.  Input arrives on stdin so wallet
// addresses, token ids and paths never have to survive remote shell parsing.
const fs = require('node:fs');
const path = require('node:path');

function readInput() {
  const raw = fs.readFileSync(0, 'utf8');
  return JSON.parse(raw);
}

function main() {
  const input = readInput();
  const configPath = input.path;
  const wallet = input.wallet;
  const tokenId = String(input.tokenId ?? '');

  if (!configPath || !path.isAbsolute(configPath)) throw new Error('config path must be absolute');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(wallet ?? ''))) throw new Error('invalid wallet address');
  if (!/^[1-9][0-9]*$/.test(tokenId)) throw new Error('invalid tokenId');

  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config.json is not an object');
  }
  if (typeof config.devicePrivateKey !== 'string' || config.devicePrivateKey.length === 0) {
    throw new Error('config.json has no devicePrivateKey; refusing to patch the wrong file');
  }
  if (input.deviceKey && config.deviceKey !== input.deviceKey) {
    throw new Error('config.json deviceKey does not match this worker; refusing to patch');
  }

  config.wallet = String(wallet).toLowerCase();
  config.tokenId = tokenId;

  const tmp = `${configPath}.colony-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, configPath);
  fs.chmodSync(configPath, 0o600);

  // Deliberately never serialise the whole config.  devicePrivateKey stays on
  // the worker and is not echoed here.
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      path: configPath,
      wallet: config.wallet,
      tokenId: config.tokenId,
      deviceKey: config.deviceKey ?? null,
      devicePrivateKeyPreserved: true,
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(`colony worker config: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
}
