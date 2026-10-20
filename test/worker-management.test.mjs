import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildRpcArgs,
  buildSkillsArgs,
  buildToolsArgs,
  buildUnlinkArgs,
  buildWhoamiArgs,
  runManagement,
} from '../src/worker/manage.mjs';
import { buildRemoteCommand, buildSshArgs } from '../src/worker/ssh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

function installFakeImd(prefix, marker) {
  const source = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
    '  args: process.argv.slice(2),',
    '  identitymdHome: process.env.IDENTITYMD_HOME ?? null,',
    "}) + '\\n');",
    "process.stdout.write(process.env.COLONY_FAKE_STDOUT ?? 'official stdout\\n');",
    "process.stderr.write(process.env.COLONY_FAKE_STDERR ?? 'official stderr\\n');",
    'process.exitCode = Number(process.env.COLONY_FAKE_EXIT ?? 0);',
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

function calls(marker) {
  if (!fs.existsSync(marker)) return [];
  return fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test('management builders map to the official imd argv exactly', () => {
  assert.deepEqual(buildWhoamiArgs(), ['whoami']);
  assert.deepEqual(buildUnlinkArgs(), ['unlink']);
  assert.deepEqual(buildSkillsArgs(), ['skills', 'list']);
  assert.deepEqual(buildSkillsArgs('list'), ['skills', 'list']);
  assert.deepEqual(buildSkillsArgs('add', 'web'), ['skills', 'add', 'web']);
  assert.deepEqual(buildSkillsArgs('remove', 'web'), ['skills', 'remove', 'web']);
  assert.deepEqual(buildToolsArgs('list'), ['tools', 'list']);
  assert.deepEqual(buildToolsArgs('forget', { id: 'OPENAI_API_KEY' }), [
    'tools',
    'forget',
    'OPENAI_API_KEY',
  ]);
  assert.deepEqual(buildToolsArgs('remove', { id: 'image' }), ['tools', 'remove', 'image']);
  assert.deepEqual(
    buildToolsArgs('add', {
      id: 'image',
      command: '/opt/imd-tools/image-server',
      args: ['--stdio', '--fast'],
      env: ['IMAGE_PROVIDER_API_KEY'],
      probe: ['--version'],
      enable: ['generate', 'edit'],
    }),
    [
      'tools',
      'add',
      'image',
      '--command',
      '/opt/imd-tools/image-server',
      '--arg=--stdio',
      '--arg=--fast',
      '--env',
      'IMAGE_PROVIDER_API_KEY',
      '--probe=--version',
      '--enable',
      'generate',
      '--enable',
      'edit',
    ],
  );
  assert.deepEqual(buildToolsArgs('add'), ['tools', 'add'], 'no id starts the official wizard');
  assert.deepEqual(buildRpcArgs(), ['rpc', 'list']);
  assert.deepEqual(buildRpcArgs('add', '8453'), ['rpc', 'add', '8453']);
  assert.deepEqual(buildRpcArgs('remove', '1'), ['rpc', 'remove', '1']);
});

test('management builders reject incomplete or unsafe arguments', () => {
  assert.throws(() => buildSkillsArgs('add'), /skill id is required/);
  assert.throws(() => buildSkillsArgs('remove', '--help'), /must not start with/);
  assert.throws(() => buildToolsArgs('add', { id: 'image' }), /--command/);
  assert.throws(
    () => buildToolsArgs('add', { id: 'image', command: '/opt/image' }),
    /--enable/,
  );
  assert.throws(
    () =>
      buildToolsArgs('add', {
        id: 'image',
        command: '/opt/image',
        env: ['IMAGE_PROVIDER_API_KEY=sk-do-not-print'],
        enable: ['generate'],
      }),
    (error) => /NAME only/.test(error.message) && !error.message.includes('sk-do-not-print'),
  );
  assert.throws(() => buildToolsArgs('add', { command: '/opt/image' }), /require a tool id/);
  assert.throws(() => buildToolsArgs('key'), /requires a name or id/);
  assert.throws(() => buildRpcArgs('add'), /chain id is required/);
  assert.throws(() => buildRpcArgs('add', '0'), /invalid chain id/);
  assert.throws(() => buildRpcArgs('remove', 'abc'), /invalid chain id/);
});

test('tools add help says --env is names only and keys use hidden input', () => {
  const result = runCli(['worker', 'tools', 'add', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--env <NAME>/);
  assert.match(result.stdout, /NAME only, never NAME=value/);
  assert.match(result.stdout, /colony worker tools key OPENAI_API_KEY/);
  assert.match(result.stdout, /Do not put secrets in --arg/);
});

test('runManagement keeps the resolved SSH target and exits with the official code', async () => {
  const ctx = { kind: 'ssh', host: 'worker@example.com', port: 2222, imdPath: '/opt/imd' };
  const seen = [];
  const result = await runManagement(ctx, ['skills', 'remove', 'web'], {}, {
    run: async (seenCtx, args, options) => {
      seen.push({ seenCtx, args, options });
      return { exitCode: 9, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.exitCode, 9);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].seenCtx, ctx);
  assert.equal(seen[0].seenCtx.host, 'worker@example.com');
  assert.equal(seen[0].seenCtx.port, 2222);
  assert.deepEqual(seen[0].args, ['skills', 'remove', 'web']);
  assert.equal(seen[0].options.stdio, 'inherit');
  assert.equal(seen[0].options.terminal, true);
});

test('SSH interactive construction allocates a remote TTY', () => {
  const remote = buildRemoteCommand('/opt/imd', ['tools', 'key', 'SECRET_NAME']);
  assert.deepEqual(
    buildSshArgs({ host: 'worker@example.com', identity: '/home/me/key', port: 2222 }, remote, {
      tty: true,
    }),
    [
      '-i',
      '/home/me/key',
      '-p',
      '2222',
      '-t',
      '--',
      'worker@example.com',
      "'/opt/imd' 'tools' 'key' 'SECRET_NAME'",
    ],
  );
  assert.deepEqual(
    buildSshArgs({ host: 'worker@example.com' }, remote),
    ['--', 'worker@example.com', "'/opt/imd' 'tools' 'key' 'SECRET_NAME'"],
  );
});

test('real CLI: non-interactive management maps argv, target and exit code', () => {
  const home = tempDir('colony-manage-');
  const prefix = path.join(home, 'prefix');
  const workerHome = path.join(home, 'profile');
  const marker = path.join(home, 'calls.jsonl');
  try {
    installFakeImd(prefix, marker);

    const who = runCli(
      [
        'worker',
        'whoami',
        '--json',
        '--home',
        home,
        '--prefix',
        prefix,
        '--worker-home',
        workerHome,
      ],
      {
        COLONY_FAKE_EXIT: '7',
        COLONY_FAKE_STDOUT: 'device-key-from-official\n',
        COLONY_FAKE_STDERR: 'official warning\n',
      },
    );
    assert.equal(who.status, 7);
    assert.equal(who.stderr, '', 'captured imd stderr must stay inside JSON');
    assert.deepEqual(JSON.parse(who.stdout), {
      exitCode: 7,
      stdout: 'device-key-from-official\n',
      stderr: 'official warning\n',
    });
    const whoCall = calls(marker).at(-1);
    assert.deepEqual(whoCall.args, ['whoami']);
    assert.equal(whoCall.identitymdHome, workerHome);

    const commands = [
      [['worker', 'unlink'], ['unlink']],
      [['worker', 'skills', 'list'], ['skills', 'list']],
      [['worker', 'skills', 'add', 'web'], ['skills', 'add', 'web']],
      [['worker', 'skills', 'remove', 'web'], ['skills', 'remove', 'web']],
      [['worker', 'tools', 'list'], ['tools', 'list']],
      [
        [
          'worker',
          'tools',
          'add',
          'image',
          '--command',
          '/opt/imd-tools/image-server',
          '--arg',
          '--stdio',
          '--env',
          'IMAGE_PROVIDER_API_KEY',
          '--probe',
          '--version',
          '--enable',
          'generate',
        ],
        [
          'tools',
          'add',
          'image',
          '--command',
          '/opt/imd-tools/image-server',
          '--arg=--stdio',
          '--env',
          'IMAGE_PROVIDER_API_KEY',
          '--probe=--version',
          '--enable',
          'generate',
        ],
      ],
      [['worker', 'tools', 'forget', 'IMAGE_PROVIDER_API_KEY'], ['tools', 'forget', 'IMAGE_PROVIDER_API_KEY']],
      [['worker', 'tools', 'remove', 'image'], ['tools', 'remove', 'image']],
      [['worker', 'rpc', 'list'], ['rpc', 'list']],
      [['worker', 'rpc', 'remove', '8453'], ['rpc', 'remove', '8453']],
    ];

    for (const [argv, expected] of commands) {
      const result = runCli([...argv, '--home', home, '--prefix', prefix]);
      assert.equal(result.status, 0, `${argv.join(' ')}: ${result.stderr}`);
      assert.deepEqual(calls(marker).at(-1).args, expected);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('real CLI: hidden-input commands refuse non-TTY and --json before executing imd', () => {
  const home = tempDir('colony-manage-tty-');
  const prefix = path.join(home, 'prefix');
  const marker = path.join(home, 'calls.jsonl');
  try {
    installFakeImd(prefix, marker);

    for (const argv of [
      ['worker', 'tools', 'key', 'SECRET_NAME'],
      ['worker', 'tools', 'add'],
      ['worker', 'rpc', 'add', '1'],
    ]) {
      const result = runCli([...argv, '--home', home, '--prefix', prefix], {
        COLONY_FAKE_EXIT: '0',
      });
      assert.equal(result.status, 1, argv.join(' '));
      assert.match(result.stderr, /interactive terminal/);
      assert.equal(calls(marker).length, 0, 'no secret prompt may reach imd without a TTY');
    }

    for (const argv of [
      ['worker', 'tools', 'key', 'SECRET_NAME'],
      ['worker', 'tools', 'add'],
      ['worker', 'rpc', 'add', '1'],
    ]) {
      const result = runCli([...argv, '--json', '--home', home, '--prefix', prefix], {
        COLONY_FAKE_EXIT: '0',
      });
      assert.equal(result.status, 1, argv.join(' '));
      assert.match(result.stderr, /--json is not supported/);
      assert.equal(calls(marker).length, 0);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
