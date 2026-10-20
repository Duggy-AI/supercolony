#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

// This script is streamed to `node -` on the worker host.  It must stay
// self-contained (no relative imports) because it is executed from stdin.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const TGZ = 'identitymd-worker.tgz';
const RESULT = 'COLONY_INSTALL_RESULT=';

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function checksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function expectedFromSums(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+[* ]?(.+?)\s*$/.exec(line.trim());
    if (!match) continue;
    const name = match[2].replace(/^\.\//, '');
    if (name === TGZ || name.endsWith(`/${TGZ}`)) return match[1].toLowerCase();
  }
  return null;
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const [prefix, tgzUrl, sumsUrl, tag, assetDigest] = process.argv.slice(2);
  if (!prefix || !path.isAbsolute(prefix)) fail('install prefix must be an absolute path');
  if (!tgzUrl || !sumsUrl) fail('missing release asset URLs');
  // colony itself only passes HTTPS URLs from GitHub metadata.  Loopback HTTP
  // is accepted so this streamed script can be exercised against a fixture.
  const secure = (value) => {
    const url = new URL(value);
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  };
  if (!secure(tgzUrl) || !secure(sumsUrl)) fail('release asset URLs must be HTTPS');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-worker-'));
  try {
    const sumsText = (await download(sumsUrl)).toString('utf8');
    const expected = expectedFromSums(sumsText);
    if (!expected) fail(`${TGZ} is not listed in SHA256SUMS`, 2);

    const bytes = await download(tgzUrl);
    const actual = checksum(bytes);
    if (actual !== expected) {
      fail(`SHA-256 mismatch for ${TGZ}: expected ${expected}, got ${actual}; refusing to run npm`, 2);
    }
    if (assetDigest && assetDigest.toLowerCase() !== actual) {
      fail(`SHA-256 mismatch against release metadata: expected ${assetDigest}, got ${actual}; refusing to run npm`, 2);
    }

    const tgz = path.join(temp, TGZ);
    fs.writeFileSync(tgz, bytes, { mode: 0o600 });
    fs.mkdirSync(prefix, { recursive: true });

    const npm = spawnSync('npm', ['install', '--global', '--prefix', prefix, tgz], {
      stdio: 'inherit',
      shell: false,
    });
    if (npm.error) fail(`could not run npm: ${npm.error.message}`);
    if (npm.status !== 0) fail(`npm install failed with exit code ${npm.status}`);

    const cliPath = path.join(prefix, 'lib', 'node_modules', '@identitymd', 'worker', 'dist', 'cli.js');
    if (!fs.existsSync(cliPath)) fail(`npm finished but ${cliPath} is missing`);
    const imdPath = path.join(prefix, 'bin', 'imd');
    process.stdout.write(
      `${RESULT}${JSON.stringify({ ok: true, prefix, imdPath, cliPath, tag: tag || null, sha256: actual })}\n`,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`colony worker install: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = error && error.exitCode ? error.exitCode : 1;
});
