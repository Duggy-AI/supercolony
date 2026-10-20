import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  InstallChecksumError,
  defaultRunNpm,
  installReleaseLocal,
  installedCliPath,
  sha256,
} from '../src/worker/install.mjs';
import { parseReleaseMetadata, parseSha256Sums, resolveRelease, selectSum } from '../src/worker/release.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REMOTE_INSTALL = path.join(HERE, '..', 'src', 'worker', 'remote', 'install.cjs');

function fixtureRelease() {
  return {
    tag: 'worker-v0.1.2-c3fba9eb12cc',
    version: '0.1.2',
    tgzUrl: 'https://example.invalid/identitymd-worker.tgz',
    sumsUrl: 'https://example.invalid/SHA256SUMS',
    assetDigest: null,
  };
}

test('release metadata is pinned to the tag, not latest/download', () => {
  const release = parseReleaseMetadata({
    tag_name: 'worker-v0.1.2-c3fba9eb12cc',
    name: 'Worker 0.1.2+c3fba9eb',
    html_url: 'https://github.com/Identity-md/worker/releases/tag/x',
    assets: [
      {
        name: 'identitymd-worker.tgz',
        browser_download_url:
          'https://github.com/Identity-md/worker/releases/download/worker-v0.1.2-c3fba9eb12cc/identitymd-worker.tgz',
        digest: 'sha256:29f25dbc62284be449c2083544cffc2ab29eea4a06b2f8556d10acfdff1d495b',
        size: 668700,
      },
      {
        name: 'SHA256SUMS',
        browser_download_url:
          'https://github.com/Identity-md/worker/releases/download/worker-v0.1.2-c3fba9eb12cc/SHA256SUMS',
      },
    ],
  });
  assert.equal(release.tag, 'worker-v0.1.2-c3fba9eb12cc');
  assert.match(release.tgzUrl, /releases\/download\/worker-v0\.1\.2-c3fba9eb12cc\//);
  assert.equal(release.assetDigest, '29f25dbc62284be449c2083544cffc2ab29eea4a06b2f8556d10acfdff1d495b');
  assert.equal(selectSum('29f25dbc62284be449c2083544cffc2ab29eea4a06b2f8556d10acfdff1d495b  identitymd-worker.tgz\n', 'identitymd-worker.tgz'), release.assetDigest);
});

test('resolveRelease looks up metadata and rejects unknown versions', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) {
      return new Response(
        JSON.stringify({
          tag_name: 'worker-v9.9.9-abcdef123456',
          assets: [
            { name: 'identitymd-worker.tgz', browser_download_url: 'https://x/y.tgz' },
            { name: 'SHA256SUMS', browser_download_url: 'https://x/SHA256SUMS' },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  };
  const release = await resolveRelease({ fetchImpl });
  assert.equal(release.tag, 'worker-v9.9.9-abcdef123456');
  assert.match(calls[0], /releases\/latest$/);
  await assert.rejects(
    resolveRelease({
      version: '7.7.7',
      fetchImpl: async (url) =>
        url.includes('/releases/tags/')
          ? new Response('{}', { status: 404 })
          : new Response('[]', { status: 200 }),
    }),
    /no worker release matches/,
  );
});

test('checksum mismatch never invokes npm', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-install-'));
  const prefix = path.join(tempRoot, 'prefix');
  let npmCalls = 0;
  const wrong = '0'.repeat(64);
  const fetchImpl = async (url) =>
    url.endsWith('SHA256SUMS')
      ? new Response(`${wrong}  identitymd-worker.tgz\n`, { status: 200 })
      : new Response(Buffer.from('fake tarball'), { status: 200 });
  try {
    await assert.rejects(
      installReleaseLocal({
        release: fixtureRelease(),
        prefix,
        fetchImpl,
        tempRoot,
        runNpm: async () => {
          npmCalls += 1;
          return { exitCode: 0 };
        },
      }),
      (error) => error instanceof InstallChecksumError && error.code === 'CHECKSUM_MISMATCH',
    );
    assert.equal(npmCalls, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a verified archive invokes npm exactly once with the explicit prefix', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-install-'));
  const prefix = path.join(tempRoot, 'private prefix');
  const bytes = Buffer.from('verified tarball bytes');
  const digest = sha256(bytes);
  const specs = [];
  const fetchImpl = async (url) =>
    url.endsWith('SHA256SUMS')
      ? new Response(`${digest}  identitymd-worker.tgz\n`, { status: 200 })
      : new Response(bytes, { status: 200 });
  try {
    const result = await installReleaseLocal({
      release: fixtureRelease(),
      prefix,
      fetchImpl,
      tempRoot,
      runNpm: async (spec) => {
        specs.push(spec);
        const cli = installedCliPath(prefix);
        fs.mkdirSync(path.dirname(cli), { recursive: true });
        fs.writeFileSync(cli, '#!/usr/bin/env node\n');
        return { exitCode: 0 };
      },
    });
    assert.equal(specs.length, 1);
    const args = specs[0].args;
    assert.ok(args.includes('--global'));
    assert.equal(args[args.indexOf('--prefix') + 1], prefix);
    assert.ok(args.at(-1).endsWith('identitymd-worker.tgz'));
    assert.equal(result.sha256, digest);
    assert.equal(result.prefix, prefix);
    assert.ok(fs.existsSync(installedCliPath(prefix)));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('default npm runner keeps npm output off colony stdout (for --json)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-npm-output-'));
  try {
    const fakeNpm = path.join(dir, 'npm-fake.mjs');
    fs.writeFileSync(
      fakeNpm,
      "process.stdout.write('NPM_STDOUT\\n'); process.stderr.write('NPM_STDERR\\n');\n",
    );
    const installModule = pathToFileURL(path.join(HERE, '..', 'src', 'worker', 'install.mjs')).href;
    const runner = path.join(dir, 'runner.mjs');
    fs.writeFileSync(
      runner,
      `import { defaultRunNpm } from ${JSON.stringify(installModule)};\n` +
        `await defaultRunNpm({ command: process.execPath, args: [${JSON.stringify(fakeNpm)}] });\n`,
    );
    const result = await runAsync(process.execPath, [runner]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', 'npm stdout must not reach colony stdout');
    assert.match(result.stderr, /NPM_STDOUT/);
    assert.match(result.stderr, /NPM_STDERR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSha256Sums handles standard sha256sum output', () => {
  const sums = parseSha256Sums(`# comment\n${'a'.repeat(64)}  identitymd-worker.tgz\n${'b'.repeat(64)} *other.tgz\n`);
  assert.equal(sums.get('identitymd-worker.tgz'), 'a'.repeat(64));
  assert.equal(sums.get('other.tgz'), 'b'.repeat(64));
});

function runAsync(command, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('remote install script refuses a hash mismatch before npm', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-remote-install-'));
  const prefix = path.join(tempRoot, 'prefix');
  const fakeBin = path.join(tempRoot, 'bin');
  const marker = path.join(tempRoot, 'npm-ran');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'npm'), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
  const server = http.createServer((req, res) => {
    if (req.url === '/SHA256SUMS') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${'0'.repeat(64)}  identitymd-worker.tgz\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from('not the expected tarball'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await runAsync(
      process.execPath,
      [
        REMOTE_INSTALL,
        prefix,
        `http://127.0.0.1:${port}/identitymd-worker.tgz`,
        `http://127.0.0.1:${port}/SHA256SUMS`,
        'worker-v0.1.2-test',
        '',
      ],
      {
        env: {
          ...process.env,
          npm_execpath: '',
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /SHA-256 mismatch/);
    assert.equal(fs.existsSync(marker), false, 'npm must not run after a checksum failure');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
