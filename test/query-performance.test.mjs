import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mapConcurrent } from '../src/lib/concurrent.mjs';
import { walletStatus } from '../src/lib/wallet-status.mjs';
import { DashboardController } from '../src/tui/controller.mjs';
import { sendJson, startMock } from './helpers/mock-api.mjs';

test('query pool immediately reuses a free slot, preserves result order and never exceeds its limit', async () => {
  const started = [];
  const release = [];
  let active = 0;
  let peak = 0;
  const pending = mapConcurrent([0, 1, 2, 3, 4], 2, async value => {
    started.push(value);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => { release[value] = resolve; });
    active--;
    return value * 2;
  });
  assert.deepEqual(started, [0, 1]);
  release[1]();
  await delay(0);
  assert.deepEqual(started, [0, 1, 2]);
  release[2]();
  await delay(0);
  release[3]();
  await delay(0);
  release[4]();
  release[0]();
  assert.deepEqual(await pending, [0, 2, 4, 6, 8]);
  assert.equal(peak, 2);
});

test('query pool stops scheduling new work after a failure', async () => {
  const seen = [];
  await assert.rejects(mapConcurrent([0, 1, 2], 1, async value => {
    seen.push(value);
    throw new Error('query failed');
  }), /query failed/);
  assert.deepEqual(seen, [0]);
});

test('wallet starts chain and balance queries before the capabilities response arrives', async t => {
  let capabilities;
  let balanceStarted = false;
  const release = () => {
    if (capabilities && balanceStarted) sendJson(capabilities, 200, { actions: [{ action: 'job.open', payment: {
      network: 'eip155:1', asset: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
      amount: '500000000000000000', decimals: 18,
    } }] });
  };
  const mock = await startMock(({ response, record }) => {
    if (record.path === '/requests/capabilities') { capabilities = response; release(); return; }
    const { method, id } = record.body;
    if (method === 'eth_getBalance') { balanceStarted = true; release(); }
    sendJson(response, 200, { jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x1' : '0x' + '0'.repeat(62) + '64' });
  });
  t.after(() => mock.close());
  const { networks: [status] } = await walletStatus({ api: mock.url, rpc: mock.url + '/rpc', paymentChain: 'ethereum', signal: AbortSignal.timeout(3000) },
    { configured: true, address: '0x1111111111111111111111111111111111111111' });
  assert.equal(status.coins.length, 4);
  assert.equal(status.balanceAtomic, '100');
  assert.equal(status.allowanceAtomic, '100');
});

test('rapid list navigation only queries the final selection; hitting the boundary does not query again', async t => {
  const requests = [];
  const controller = new DashboardController({ detail: async item => { requests.push(item.id); return { state: 'completed' }; } });
  t.after(() => controller.close());
  controller.update({ items: [0, 1, 2, 3].map(id => ({ id, title: String(id), state: 'completed' })) });
  controller.move(1);
  controller.move(1);
  controller.move(1);
  assert.deepEqual(requests, []);
  await delay(180);
  assert.deepEqual(requests, [3]);
  controller.move(1);
  await delay(180);
  assert.deepEqual(requests, [3]);
});

test('wallet metadata stays usable while balances load, and leaving ignores the late response', async t => {
  const address = '0x1111111111111111111111111111111111111111';
  let finish;
  let signal;
  const controller = new DashboardController({
    wallets: () => [{ address, active: true }],
    wallet: async (requestSignal, selected, { balances = true } = {}) => {
      const info = { configured: true, address: selected ?? address, chainName: 'Ethereum' };
      if (!balances) return info;
      signal = requestSignal;
      return new Promise(resolve => { finish = () => resolve({ ...info, coins: [] }); });
    },
    mine: async () => ({ items: [] }),
  });
  t.after(() => controller.close());
  const opening = controller.navigate('wallet');
  await delay(0);
  assert.equal(controller.state.busy, null);
  assert.equal(controller.state.detailLoading, true);
  assert.equal(controller.state.detail.address, address);
  assert.equal(controller.state.items.length, 1);
  await controller.navigate('tasks');
  assert.equal(signal.aborted, true);
  finish();
  await opening;
  assert.equal(controller.state.view, 'tasks');
  assert.equal(controller.state.detail, null);
});

test('refreshing a previewed wallet queries that wallet only and preserves the active payment address', async t => {
  const current = '0x' + '1'.repeat(40);
  const preview = '0x' + '2'.repeat(40);
  const queried = [];
  const wallets = [{ address: current, active: true }, { address: preview, active: false }];
  const controller = new DashboardController({
    wallets: () => wallets,
    wallet: async (signal, address, { balances = true } = {}) => {
      if (balances) queried.push(address);
      return { configured: true, address, currentAddress: current, coins: [] };
    },
  });
  t.after(() => controller.close());
  controller.update({ view: 'wallet', address: current, items: wallets.map(w => ({ ...w, id: w.address, title: w.address })), selected: 1 });
  await controller.refresh();
  assert.deepEqual(queried, [preview]);
  assert.equal(controller.state.address, current);
  assert.equal(controller.state.detail.address, preview);
});
