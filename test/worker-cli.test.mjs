import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const MOCK_ENV = 'COLONY_WORKER_CLI_MOCK';
const TAG = 'worker-v9.9.9-abcdef123456';
const RELEASE = {
  tag_name: TAG,
  name: 'Worker 9.9.9',
  html_url: `https://github.com/Identity-md/worker/releases/tag/${TAG}`,
  draft: false,
  assets: [
    {
      name: 'identitymd-worker.tgz',
      browser_download_url: `https://github.com/Identity-md/worker/releases/download/${TAG}/identitymd-worker.tgz`,
      digest: `sha256:${'1'.repeat(64)}`,
      size: 1234,
    },
    {
      name: 'SHA256SUMS',
      browser_download_url: `https://github.com/Identity-md/worker/releases/download/${TAG}/SHA256SUMS`,
    },
  ],
};

if (process.env[MOCK_ENV] === '1') {
  // Loaded with `node --import` by the integration tests below.  Only the
  // release metadata read used by `deploy --dry-run` is allowed.
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (!text.startsWith('https://api.github.com/repos/Identity-md/worker/releases/latest')) {
      throw new Error(`unexpected network request in worker CLI test: ${text}`);
    }
    return new Response(JSON.stringify(RELEASE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
} else {
  function runNode(args, env = {}) {
    return spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ...env },
    });
  }

  function runCli(args, env = {}) {
    return runNode([CLI, ...args], env);
  }

  function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  function installFakeImd(prefix, marker) {
    const source = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
      '  args: process.argv.slice(2),',
      '  identitymdHome: process.env.IDENTITYMD_HOME ?? null,',
      "}) + '\\n');",
      "process.stdout.write(process.env.COLONY_FAKE_STDOUT ?? 'fake-imd stdout\\n');",
      "if (process.env.COLONY_FAKE_STDOUT_2) process.stdout.write(process.env.COLONY_FAKE_STDOUT_2);",
      "process.stderr.write(process.env.COLONY_FAKE_STDERR ?? 'fake-imd stderr\\n');",
      "if (process.env.COLONY_FAKE_STDERR_2) process.stderr.write(process.env.COLONY_FAKE_STDERR_2);",
      'process.exitCode = Number(process.env.COLONY_FAKE_IMD_EXIT ?? 0);',
      '',
    ].join('\n');
    const cliDir = path.join(prefix, 'node_modules', '@identitymd', 'worker', 'dist');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'cli.js'), source);
    if (process.platform !== 'win32') {
      const binDir = path.join(prefix, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'imd'), source, { mode: 0o755 });
    }
  }

  test('real CLI: deploy --dry-run --json plans a fixed tag and prefix', () => {
    const home = tempDir('colony-cli-dry-');
    const prefix = path.join(home, 'private prefix');
    try {
      const result = runNode(
        [
          '--import',
          import.meta.url,
          CLI,
          'worker',
          'deploy',
          '--dry-run',
          '--json',
          '--home',
          home,
          '--prefix',
          prefix,
        ],
        { [MOCK_ENV]: '1' },
      );
      assert.equal(result.status, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.release.tag, TAG);
      assert.match(plan.release.tgzUrl, new RegExp(`/releases/download/${TAG}/identitymd-worker\\.tgz$`));
      assert.equal(plan.install.prefix, prefix);
      assert.equal(plan.target.kind, 'local');
      assert.match(plan.install.steps.join('\n'), /SHA-256/);
      assert.match(plan.install.steps.join('\n'), /npm install --global --prefix/);
      assert.deepEqual(plan.install.doesNot, ['pair the device', 'register the ERC-8004 agent', 'install or start a service']);
      assert.equal(result.stderr.trim(), '');
      assert.equal(fs.existsSync(path.join(home, 'worker-state.json')), false);
      assert.equal(fs.existsSync(prefix), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('real CLI: worker argument validation fails cleanly before any remote work', () => {
    const home = tempDir('colony-cli-args-');
    try {
      const result = runCli([
        'worker',
        'deploy',
        '--dry-run',
        '--json',
        '--home',
        home,
        '--ssh',
        'example.com',
        '--port',
        '0',
      ]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /invalid --port/);
      assert.doesNotMatch(result.stderr, /optsWithGlobals/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('real CLI: service commands map to official imd argv and propagate exit code', () => {
    const home = tempDir('colony-cli-service-');
    const prefix = path.join(home, 'prefix');
    const workerHome = path.join(home, 'worker-profile');
    const marker = path.join(home, 'imd-calls.jsonl');
    try {
      installFakeImd(prefix, marker);

      const installed = runCli(
        [
          'worker',
          'service',
          'install',
          '--boot',
          '--auto-update',
          '--runtime',
          'codex',
          '--concurrency',
          '2',
          '--json',
          '--home',
          home,
          '--prefix',
          prefix,
          '--worker-home',
          workerHome,
        ],
        { COLONY_FAKE_IMD_EXIT: '0' },
      );
      assert.equal(installed.status, 0, installed.stderr);
      const installDoc = JSON.parse(installed.stdout);
      assert.equal(installDoc.exitCode, 0);
      assert.match(installDoc.stdout, /fake-imd stdout/);
      const installCall = JSON.parse(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).at(-1));
      assert.deepEqual(installCall.args, [
        'service',
        'install',
        '--boot',
        '--auto-update',
        '--runtime',
        'codex',
        '--concurrency',
        '2',
      ]);
      assert.equal(installCall.identitymdHome, workerHome);

      const started = runCli(
        ['worker', 'start', '--json', '--home', home, '--prefix', prefix],
        { COLONY_FAKE_IMD_EXIT: '7' },
      );
      assert.equal(started.status, 7);
      const startDoc = JSON.parse(started.stdout);
      assert.equal(startDoc.exitCode, 7);
      const startCall = JSON.parse(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).at(-1));
      assert.deepEqual(startCall.args, ['service', 'start']);

      for (const extra of [[], ['--json']]) {
        const status = runCli(
          ['worker', 'status', ...extra, '--home', home, '--prefix', prefix],
          { COLONY_FAKE_IMD_EXIT: '7' },
        );
        assert.equal(status.status, 7, `status ${extra.join(' ') || 'text'} must propagate 7`);
        if (extra.length === 0) {
          assert.match(status.stdout, /fake-imd stdout/);
          assert.match(status.stderr, /fake-imd stderr/);
        } else {
          const doc = JSON.parse(status.stdout);
          assert.equal(doc.service.exitCode, 7);
          assert.equal(doc.service.stdout, 'fake-imd stdout\n');
          assert.equal(doc.service.stderr, 'fake-imd stderr\n');
          assert.ok('deviceKey' in doc && 'standing' in doc && 'standingError' in doc);
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('real CLI: worker logs/status strip terminal controls from remote output', () => {
    const home = tempDir('colony-cli-terminal-');
    const prefix = path.join(home, 'prefix');
    const marker = path.join(home, 'imd-calls.jsonl');
    const hostileOut = 'LOG before\u001b]52;c;';
    const hostileOut2 = 'cHduZWQ=\u0007 after\n';
    const hostileErr = 'ERR\u001b[';
    const hostileErr2 = '2J\n';
    try {
      installFakeImd(prefix, marker);
      for (const argv of [
        ['worker', 'logs'],
        ['worker', 'logs', '--follow'],
        ['worker', 'status'],
        ['worker', 'skills', 'list'],
        ['worker', 'doctor'],
        ['worker', 'start'],
      ]) {
        const result = runCli([...argv, '--home', home, '--prefix', prefix], {
          COLONY_FAKE_STDOUT: hostileOut,
          COLONY_FAKE_STDOUT_2: hostileOut2,
          COLONY_FAKE_STDERR: hostileErr,
          COLONY_FAKE_STDERR_2: hostileErr2,
        });
        assert.equal(result.status, 0, `${argv.join(' ')}: ${result.stderr}`);
        assert.equal(result.stdout.includes('\u001b'), false, `${argv.join(' ')} stdout: ${JSON.stringify(result.stdout)}`);
        assert.equal(result.stdout.includes('\u0007'), false, `${argv.join(' ')} stdout: ${JSON.stringify(result.stdout)}`);
        assert.match(result.stdout, /LOG before/);
        assert.match(result.stdout, /after/);
        assert.equal(result.stderr.includes('\u001b'), false, `${argv.join(' ')} stderr: ${JSON.stringify(result.stderr)}`);
        assert.match(result.stderr, /ERR/);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
