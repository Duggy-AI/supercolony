import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleStatus,
  buildDoctorArgs,
  buildRunArgs,
  buildServiceArgs,
  exitCodeOf,
  extractDeviceKey,
  runService,
} from '../src/worker/service.mjs';

const deviceKey = 'f1006806116538ac367bd59eb04775ae63f3d6cd34f18efe9139ae9a678f04f0';

test('service mapping uses the official imd service commands', () => {
  assert.deepEqual(buildServiceArgs('install', {}), ['service', 'install']);
  assert.deepEqual(
    buildServiceArgs('install', {
      boot: true,
      autoUpdate: true,
      runtime: 'codex',
      concurrency: '2',
    }),
    [
      'service',
      'install',
      '--boot',
      '--auto-update',
      '--runtime',
      'codex',
      '--concurrency',
      '2',
    ],
  );
  assert.deepEqual(buildServiceArgs('restart', { runtime: 'claude' }), [
    'service',
    'restart',
    '--runtime',
    'claude',
  ]);
  assert.deepEqual(buildServiceArgs('logs', { follow: true }), ['service', 'logs', '--follow']);
  assert.deepEqual(buildServiceArgs('uninstall'), ['service', 'uninstall']);
  assert.throws(() => buildServiceArgs('install', { runtime: 'other' }), /claude or codex/);
  assert.throws(() => buildServiceArgs('install', { concurrency: '5' }), /1 and 4/);
});

test('foreground run maps to official imd start, not a service command', () => {
  assert.deepEqual(
    buildRunArgs({ runtime: 'claude', concurrency: '2', autoUpdate: true, server: 'https://api.imd.fun' }),
    ['start', '--server', 'https://api.imd.fun', '--runtime', 'claude', '--concurrency', '2', '--auto-update'],
  );
  assert.deepEqual(buildDoctorArgs({ runtime: 'codex' }), ['doctor', '--runtime', 'codex']);
});

test('service exit codes propagate unchanged', async () => {
  let seen;
  const result = await runService(
    { kind: 'local' },
    'status',
    {},
    {
      run: async (ctx, args) => {
        seen = args;
        return { exitCode: 7, stdout: 'text', stderr: '' };
      },
    },
  );
  assert.deepEqual(seen, ['service', 'status']);
  assert.equal(exitCodeOf(result), 7);
  assert.equal(exitCodeOf({ exitCode: null }), 1);
});

test('status assembles raw service fields and public standing without parsing text', async () => {
  const standing = {
    deviceKey,
    enrollment: { status: 'active', tokenId: '1600' },
    presence: { connected: true, acceptingWork: true },
  };
  const run = async (ctx, args) => {
    if (args[0] === 'service') {
      return { exitCode: 3, stdout: 'Active: active (running)\n', stderr: 'warn line\n' };
    }
    if (args[0] === 'whoami') return { exitCode: 0, stdout: `${deviceKey}\n`, stderr: '' };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const status = await assembleStatus({
    ctx: { kind: 'local', host: null, port: null, imdPath: '/opt/imd' },
    api: 'https://api.imd.fun',
    request: async (api, path_) => {
      assert.equal(path_, `/workers/${deviceKey}/standing`);
      return { status: 200, data: standing };
    },
    run,
  });
  assert.equal(status.service.command, '/opt/imd service status');
  assert.equal(status.service.exitCode, 3);
  assert.equal(status.service.stdout, 'Active: active (running)\n');
  assert.equal(status.service.stderr, 'warn line\n');
  assert.deepEqual(status.standing, standing);
  assert.equal(status.standingError, null);
  assert.equal('state' in status.service, false, 'unstable text must not become a fake state field');
});

test('standing 404 is reported as unavailable, not invented', async () => {
  const status = await assembleStatus({
    ctx: { kind: 'ssh', host: 'worker', port: 22, imdPath: '/opt/imd' },
    api: 'https://api.imd.fun',
    request: async () => ({ status: 404, data: { error: 'not_found' } }),
    run: async (ctx, args) =>
      args[0] === 'service'
        ? { exitCode: 0, stdout: 'status text', stderr: '' }
        : { exitCode: 0, stdout: deviceKey, stderr: '' },
  });
  assert.equal(status.standing, null);
  assert.match(status.standingError, /HTTP 404/);
});

test('device key extraction requires one unambiguous 64-hex value', () => {
  assert.equal(extractDeviceKey(`${deviceKey}\n`), deviceKey);
  assert.throws(() => extractDeviceKey('not configured'), /device key/);
  assert.throws(() => extractDeviceKey(`${deviceKey}\n${'a'.repeat(64)}`), /multiple keys/);
});
