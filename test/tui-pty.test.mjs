import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import * as pty from '@lydell/node-pty';
import { sendJson, startMock } from './helpers/mock-api.mjs';
import { clean } from '../src/tui/presentation.mjs';
import { listOrders, saveOrder } from '../src/lib/orders.mjs';
import { TEST_KEY, TEST_ADDRESS } from './helpers/cli.mjs';
import { walletInfo } from '../src/lib/local-wallet.mjs';

test('native PTY: wallet private key and passwords are hidden during import', { timeout: 30000 }, async t => {
  const home=await mkdtemp(join(tmpdir(),'colony-wallet-pty-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const session=spawnTerminal(t,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'--home',home,'wallet','import']);
  await session.sees('Private key (hidden):');
  session.term.write(TEST_KEY+'\r');
  await session.sees('Local wallet password (at least 8 characters):');
  session.term.write('hidden pty password\r');
  await session.sees('Confirm password:');
  session.term.write('hidden pty password\r');
  await session.sees('Wallet ready:',20000);
  assert.equal((await session.exit).exitCode,0);
  assert.equal(walletInfo({home}).address,TEST_ADDRESS);
  assert.doesNotMatch(clean(session.output()),new RegExp(TEST_KEY+'|hidden pty password'));
  const next = spawnTerminal(t, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--home', home, 'wallet', 'create']);
  await next.sees('Local wallet password:');
  next.term.write('hidden pty password\r');
  await next.sees('Wallet ready:', 20000);
  assert.equal((await next.exit).exitCode, 0);
  assert.doesNotMatch(clean(next.output()), /Confirm password|hidden pty password/);
  assert.notEqual(walletInfo({ home }).address, TEST_ADDRESS);
});

function spawnTerminal(t, args) {
  const term = pty.spawn(process.execPath, args, {
    name: 'xterm-256color', cols: 120, rows: 32,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, COLONY_PRIVATE_KEY: '', CI: '', NO_COLOR: '1', TERM: 'xterm-256color' },
  });
  let output = '';
  let consumed = 0;
  let exited = false;
  term.onData((chunk) => { output += chunk; });
  const exit = new Promise((resolve) => term.onExit((event) => { exited = true; resolve(event); }));
  // ConPTY's IPC pipe outlives onExit until its terminal handle is closed.
  t.after(() => term.kill());
  async function sees(text, timeout = 5000) {
    const end = Date.now() + timeout;
    let at;
    while ((at = clean(output).indexOf(text, consumed)) < 0) {
      if (exited || Date.now() > end) throw new Error('Missing terminal text: ' + text + '\n' + clean(output).slice(-4500) + '\nRaw tail: ' + JSON.stringify(output.slice(-1000)));
      await delay(20);
    }
    consumed = at + text.length;
  }
  // Fresh homes have no wallet, so every launch first offers to create one.
  async function skipWelcome() {
    await sees('Welcome to Colony');
    term.write('2');
    await sees('No wallet created');
  }
  return { term, exit, sees, skipWelcome, output: () => output };
}

test('native PTY: default launch, keyboard, resize, forms and clean terminal exit', { timeout: 20000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-pty-'));
  const mock = await startMock(({ response, record }) => {
    if (record.path === '/swarm') return sendJson(response, 200, { counts: { jobs: 1 } });
    if (record.path === '/jobs') return sendJson(response, 200, { count: 1, jobs: [{ id: 'pty-job', objective: 'Native terminal acceptance', state: 'completed' }] });
    if (record.path === '/jobs/pty-job') return sendJson(response, 200, { id: 'pty-job', objective: 'Native terminal acceptance', state: 'completed', nodes: [] });
    return sendJson(response, 404, { error: 'not_found' });
  });
  t.after(async () => { await mock.close(); await rm(home, { recursive: true, force: true }); });
  const session = spawnTerminal(t, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--home', home, '--api', mock.url, '--ascii']);
  const { term, exit, sees } = session;
  await sees('No tasks yet.');
  await session.skipWelcome();
  term.write('2');
  await sees('Native terminal acceptance');
  assert.ok(mock.requests.some((r) => r.path === '/jobs'));
  term.resize(70, 24);
  await sees('[1]Mine');
  term.write('\r');
  await sees('YOUR REQUEST');
  term.write('3');
  await sees('This computer');
  // The header can precede the selected row in the same render. Wait for
  // the error below the row rather than requiring a second header render.
  await sees('HTTP 404 not_found', 10000);
  term.write('m');
  await sees('Deploy official worker');
  term.write('\x1b');
  await sees('WORKERS');
  term.write('n');
  await sees('What would you like to get done?');
  term.write('A coffee website');
  await sees('A coffee website');
  assert.doesNotMatch(clean(session.output()), /Pay with/);
  term.write('\x1b');
  await sees('WORKERS');
  term.write('q');
  const result = await exit;
  assert.equal(result.exitCode, 0);
  assert.match(session.output(), /\x1b\[\?1049l/);
  assert.equal(mock.requests.some((r) => r.path.startsWith('/requests/')), false);
});

test('native PTY: an unpaid request confirms cancellation then deletes its record directly', { timeout: 20000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-cancel-pty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await saveOrder(home, {
    requestKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    api: 'http://127.0.0.1:1', action: 'job.open', status: 'challenged',
    input: { objective: 'Keyboard cancellation acceptance' }, createdAt: '2026-10-01T00:00:00Z',
  });
  const session = spawnTerminal(t, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--home', home, '--api', 'http://127.0.0.1:1', '--ascii']);
  const { term, exit, sees } = session;
  await session.skipWelcome();
  await delay(100);
  term.write('x');
  await sees('Keep request');
  term.write('\r');
  await sees('Awaiting payment');
  assert.equal((await listOrders(home))[0].cancelledAt, undefined);
  term.write('x');
  await sees('Keep request');
  term.write('\t');
  await delay(80);
  term.write('\r');
  await sees('Request cancelled.');
  assert.ok((await listOrders(home))[0].cancelledAt);
  term.write('m');
  await sees('Delete local record');
  term.write('\x1b[B');
  await sees('> Delete local record');
  term.write('\r');
  await sees('No tasks yet.');
  assert.deepEqual(await listOrders(home), []);
  term.write('q');
  assert.equal((await exit).exitCode, 0);
});

test('native PTY: worker handoff accepts input and returns to the dashboard', { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-handoff-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const session = spawnTerminal(t, [fileURLToPath(new URL('./helpers/tui-handoff.mjs', import.meta.url)), 'http://127.0.0.1:1', home]);
  const { term, exit, sees } = session;
  await sees('No tasks yet.');
  await session.skipWelcome();
  term.write('3');
  await sees('This computer');
  await sees('Network unavailable', 10000);
  term.write('m');
  await sees('Deploy official worker');
  for (const label of ['View logs', 'Run diagnostics', 'Identity', 'Deploy official worker']) {
    term.write('\x1b[B');
    await sees('> ' + label);
  }
  term.write('\r');
  await sees('Run on This computer?');
  term.write('\t');
  await delay(80);
  term.write('\r');
  await sees('NATIVE HANDOFF:');
  term.write('hello\r');
  await sees('Native answer: hello');
  await sees('Press Enter to return to Colony.');
  term.write('\r');
  await sees('Command finished.', 10000);
  await delay(100);
  term.write('4');
  await sees('Browsing does not need a wallet.');
  await delay(100);
  term.write('q');
  assert.equal((await exit).exitCode, 0);
  assert.match(session.output(), /\x1b\[\?1049l/);
});

test('native PTY: first launch creates a wallet with a hidden password; no network switch or RPC setup', { timeout: 60000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-network-pty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const args = [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--home', home, '--api', 'http://127.0.0.1:1', '--ascii'];
  const session = spawnTerminal(t, args);
  await session.sees('No tasks yet.');
  await session.sees('Welcome to Colony');
  await session.sees('> 1. Create a new wallet (empty, add funds later)');
  session.term.write('\r');
  await session.sees('Local wallet password (at least 8 characters)');
  // Ink reads one chunk as typed text, so Enter is sent separately.
  for (const _ of ['password', 'confirm']) {
    session.term.write('pty welcome password');
    await delay(100);
    session.term.write('\r');
    await delay(100);
  }
  const started = Date.now();
  await session.sees('Wallet ready: 0x', 20000);
  // The message must not wait for balances from the public nodes.
  assert.ok(Date.now() - started < 8000, 'wallet ready took ' + (Date.now() - started) + 'ms');
  assert.equal(walletInfo({ home }).configured, true);
  const screen = clean(session.output());
  assert.doesNotMatch(screen, /pty welcome password/);
  assert.doesNotMatch(screen, /[\u4e00-\u9fff]/);
  session.term.write('p');
  await delay(150);
  assert.doesNotMatch(clean(session.output()), /Payment network|COLONY_RPC_URL/);
  session.term.write('q');
  assert.equal((await session.exit).exitCode, 0);
  const again = spawnTerminal(t, args);
  // With a wallet, My tasks also asks the (unreachable) API; q works once that settles.
  await again.sees('remote paid-by failed', 10000);
  assert.doesNotMatch(clean(again.output()), /Welcome to Colony/);
  again.term.write('q');
  assert.equal((await again.exit).exitCode, 0);
});

test('native PTY: Explore refreshes on its timer without a refresh key', { timeout: 45000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-refresh-'));
  const now = Date.now();
  const first = { id: 'refresh-first', objective: 'Automatic refresh original', state: 'executing', createdAt: new Date(now - 2000).toISOString(), updatedAt: new Date(now).toISOString() };
  const second = { id: 'refresh-second', objective: 'Earlier public task', state: 'completed', createdAt: new Date(now - 3000).toISOString(), updatedAt: first.updatedAt };
  const added = { id: 'refresh-new', objective: 'Automatically added task', state: 'executing', createdAt: new Date(now + 1000).toISOString(), updatedAt: new Date(now + 1000).toISOString() };
  let changed = false;
  const mock = await startMock(({ response, record }) => {
    if (record.path === '/swarm') return sendJson(response, 200, { counts: { jobs: changed ? 3 : 2 } });
    if (record.path === '/jobs') {
      const jobs = record.query.has('since') ? [added, { ...first, state: 'completed', updatedAt: added.updatedAt }] : [first, second];
      return sendJson(response, 200, { count: jobs.length, jobs });
    }
    if (record.path === '/jobs/' + first.id) return sendJson(response, 200, { ...first, state: changed ? 'completed' : 'executing', updatedAt: changed ? added.updatedAt : first.updatedAt });
    return sendJson(response, 404, { error: 'not_found' });
  });
  t.after(async () => { await mock.close(); await rm(home, { recursive: true, force: true }); });
  const session = spawnTerminal(t, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--home', home, '--api', mock.url, '--ascii']);
  const { term, exit, sees } = session;
  await sees('No tasks yet.');
  await session.skipWelcome();
  term.write('2');
  await sees('Automatic refresh original');
  changed = true;
  await sees('Automatically added task', 38000);
  await sees('2/3');
  assert.ok(mock.requests.some((request) => request.path === '/jobs' && request.query.has('since')));
  term.write('q');
  assert.equal((await exit).exitCode, 0);
  assert.match(session.output(), /\x1b\[\?1049l/);
});
