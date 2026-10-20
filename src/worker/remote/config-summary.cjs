#!/usr/bin/env node
'use strict';

// Streamed to `node -e`.  Returns only non-secret config fields; the raw file
// (which contains devicePrivateKey) is never written to stdout.
const fs = require('node:fs');

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const configPath = input.path;
  if (!configPath || !require('node:path').isAbsolute(configPath)) {
    throw new Error('config path must be absolute');
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      process.stdout.write(`${JSON.stringify({ exists: false, path: configPath })}\n`);
      return;
    }
    throw error;
  }
  const config = JSON.parse(raw);
  process.stdout.write(
    `${JSON.stringify({
      exists: true,
      path: configPath,
      deviceKey: config.deviceKey ?? null,
      wallet: config.wallet ?? null,
      tokenId: config.tokenId ?? null,
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(`colony worker config: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
}
