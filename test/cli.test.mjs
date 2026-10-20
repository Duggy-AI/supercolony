import assert from 'node:assert/strict';
import test from 'node:test';
import { runEntry } from './helpers/cli.mjs';
import { createProgram } from '../src/program.mjs';

test('main entry registers task, order, wallet and worker commands', async () => {
  const help = await runEntry(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /task/);
  assert.match(help.stdout, /order/);
  assert.match(help.stdout, /wallet/);
  assert.match(help.stdout, /worker/);
});

test('main entry exposes worker deploy/pair/register/service commands', async () => {
  const help = await runEntry(['worker', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /deploy/);
  assert.match(help.stdout, /pair/);
  assert.match(help.stdout, /register/);
  assert.match(help.stdout, /service/);
});

test('global flags are accepted after the subcommand', async () => {
  const result = await runEntry(['task', 'list', '--limit', '0', '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--limit must be an integer from 1 to 500/);
});

test('worker release version reaches the subcommand and globals work in either position', async () => {
  for (const flags of [
    ['--api', 'http://before.test', '--json', 'worker', 'deploy', '--version', 'worker-v1'],
    ['worker', 'deploy', '--version', 'worker-v1', '--api', 'http://after.test', '--json'],
  ]) {
    let received;
    const program = createProgram((root) => {
      root.command('worker').command('deploy')
        .option('--version <tag>')
        .action((_options, command) => { received = command.optsWithGlobals(); });
    });
    program.exitOverride();
    await program.parseAsync(flags, { from: 'user' });
    assert.equal(received.version, 'worker-v1');
    assert.equal(received.json, true);
    assert.match(received.api, /^http:\/\/(before|after)\.test$/);
  }
});

test('root --version still prints the colony version', async () => {
  const result = await runEntry(['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
