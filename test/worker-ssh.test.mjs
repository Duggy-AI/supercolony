import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildRemoteCommand,
  buildSshArgs,
  quotePosix,
  validatePort,
  validateSshHost,
} from '../src/worker/ssh.mjs';
import { runProcess } from '../src/worker/process.mjs';

// These two tests deliberately use Git Bash's `sh` to model the remote login
// shell.  Skip (rather than fail) when the suite is run without it.
const hasGitBashSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

test('ssh host validation rejects option injection and whitespace', () => {
  assert.equal(validateSshHost('worker@example.com'), 'worker@example.com');
  assert.equal(validateSshHost('[::1]'), '[::1]');
  assert.throws(() => validateSshHost('-oProxyCommand=touch /tmp/x'), /must not start/);
  assert.throws(() => validateSshHost('host name'), /whitespace/);
  assert.throws(() => validateSshHost('host\nx'), /whitespace/);
  assert.throws(() => validatePort('0'), /invalid/);
  assert.throws(() => validatePort('65536'), /invalid/);
  assert.equal(validatePort('2222'), 2222);
});

test('ssh argv is separated from the host and uses --', () => {
  const args = buildSshArgs(
    { host: 'user@example.com', identity: '/home/me/key with space', port: 2222 },
    "'/home/me/.colony/bin/imd' 'service' 'status'",
  );
  assert.deepEqual(args, [
    '-i',
    '/home/me/key with space',
    '-p',
    '2222',
    '--',
    'user@example.com',
    "'/home/me/.colony/bin/imd' 'service' 'status'",
  ]);
});

test('POSIX quoting keeps spaces and quotes as one remote argument', { skip: !hasGitBashSh && 'requires Git Bash sh' }, () => {
  const value = `a b'c"d; touch /tmp/nope`;
  assert.equal(quotePosix(value), `'a b'\\''c"d; touch /tmp/nope'`);
  const remote = buildRemoteCommand('printf', ['%s', value]);
  const result = spawnSync('sh', ['-c', remote], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, value);
});

test('remote shell metacharacters in an argument are not executed', { skip: !hasGitBashSh && 'requires Git Bash sh' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-ssh-'));
  const marker = path.join(dir, 'pwned');
  try {
    const payload = `x'; touch ${marker}; echo '`;
    const remote = buildRemoteCommand('printf', ['%s', payload]);
    const result = spawnSync('sh', ['-c', remote], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, payload);
    assert.equal(fs.existsSync(marker), false, 'injected command must not run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local process runner passes argv without a shell', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-local-'));
  const marker = path.join(dir, 'pwned');
  const script = path.join(dir, 'argv.mjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  try {
    const payload = `value; touch ${marker}`;
    const result = await runProcess({
      command: process.execPath,
      args: [script, payload, '"quoted"'],
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [payload, '"quoted"']);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
