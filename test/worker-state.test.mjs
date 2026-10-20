import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  emptyState,
  readState,
  resolveContext,
  statePath,
  updateTargetState,
  writeState,
} from '../src/worker/context.mjs';
import { recordInstall } from '../src/worker/deploy.mjs';

test('missing state is empty, existing state is parsed as-is', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-state-'));
  try {
    assert.deepEqual(readState(home), emptyState());
    writeState(home, { targets: { local: { prefix: '/p' } }, registrations: {}, extra: 'kept' });
    const state = readState(home);
    assert.equal(state.extra, 'kept');
    assert.equal(state.targets.local.prefix, '/p');
    updateTargetState(home, 'local', { tag: 'worker-v1' });
    assert.equal(readState(home).targets.local.tag, 'worker-v1');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('malformed state is not silently replaced with empty defaults', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-state-'));
  try {
    fs.writeFileSync(statePath(home), JSON.stringify({ targets: {} }));
    assert.throws(() => readState(home), /unexpected shape/);
    fs.writeFileSync(statePath(home), '{');
    assert.throws(() => readState(home), /not valid JSON/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('remote installs preserve the SSH identity for subsequent commands and permit an explicit override', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-ssh-state-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const identity = path.join(home, 'key with spaces');
  const ctx = { kind: 'ssh', key: 'ssh:user@example.com:2222', home, remoteHome: '/home/user', identity,
    prefix: '/home/user/worker', workerHome: '/home/user/profile' };
  recordInstall(ctx, { tag: 'worker-v1', version: '1' }, { imdPath: '/home/user/worker/bin/imd' });
  const restored = await resolveContext({ home, ssh: 'user@example.com', port: 2222 }, { needImd: false });
  assert.equal(restored.identity, identity);
  assert.equal(restored.prefix, ctx.prefix);
  const replacement = path.join(home, 'replacement');
  const overridden = await resolveContext({ home, ssh: 'user@example.com', port: 2222, identity: replacement }, { needImd: false });
  assert.equal(overridden.identity, replacement);
});
