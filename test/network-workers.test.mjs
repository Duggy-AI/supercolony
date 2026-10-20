import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { networkWorkers, networkWorkerText } from '../src/lib/network-workers.mjs';
import { createServices } from '../src/tui/services.mjs';
import { DashboardController, visibleItems } from '../src/tui/controller.mjs';
import { sendJson, startMock } from './helpers/mock-api.mjs';

function worker(id, extra = {}) {
  return { deviceKey: id.repeat(64), seat: { tokenId: id, agentId: id },
    connectedHere: true, paused: null, working: 0, maxConcurrency: 1,
    runtimes: [{ id: 'claude' }], skills: ['build-website'], ...extra };
}

test('network workers sort by availability then free slots then stable device ID', async t => {
  const workers = [worker('f', { connectedHere: false }), worker('e', { paused: { byOwner: true } }),
    worker('d', { working: 1 }), worker('c'), worker('b', { maxConcurrency: 4 }), worker('a', { maxConcurrency: 4 })];
  const mock = await startMock(({ response }) => sendJson(response, 200, { count: workers.length, workers }));
  t.after(() => mock.close());
  const items = await networkWorkers(mock.url);
  assert.deepEqual(items.map(item => item.worker.deviceKey[0]), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(items.map(item => item.state), ['Available', 'Available', 'Available', 'Busy', 'Paused', 'Connection unconfirmed']);
  assert.match(networkWorkerText(items[0]), /Free slots: 4/);
  assert.match(networkWorkerText(items[0]), /read only/);
  assert.equal(mock.requests[0].path, '/workers');
});

test('managed targets stay first; public workers support search and refresh but no management', async t => {
  const home = await mkdtemp(join(tmpdir(), 'colony-network-workers-'));
  let working = 0;
  const mock = await startMock(({ response }) => sendJson(response, 200, { count: 1, workers: [worker('a', { working })] }));
  t.after(async () => { await mock.close(); await rm(home, { recursive: true, force: true }); });
  const services = createServices({ home, api: mock.url }, { run: () => { throw new Error('Must not launch worker management'); } });
  const controller = new DashboardController(services);
  t.after(() => controller.close());
  await controller.navigate('workers');
  assert.equal(controller.state.items[0].id, 'local');
  assert.equal(controller.state.items[0].kind, 'managed-worker');
  controller.update({ selected: 1 });
  await controller.loadDetail();
  assert.match(controller.state.detail.title, /Network/);
  controller.workerMenu();
  assert.equal(controller.state.menu, null);
  await controller.workerCommand(['service', 'stop']);
  assert.equal(controller.state.error, null);
  working = 1;
  await controller.refresh();
  assert.equal(controller.selected().id, 'network:' + 'a'.repeat(64));
  assert.equal(controller.state.detail.state, 'Busy');
  controller.update({ query: 'build-website', selected: 0 });
  assert.equal(visibleItems(controller.state).length, 1);
  controller.update({ query: 'no matching worker' });
  assert.equal(visibleItems(controller.state).length, 0);
});

test('public directory errors remain visible without removing local management targets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'colony-network-error-'));
  const mock = await startMock(({ response }) => sendJson(response, 503, { error: 'directory unavailable' }));
  t.after(async () => { await mock.close(); await rm(home, { recursive: true, force: true }); });
  const controller = new DashboardController(createServices({ home, api: mock.url }));
  t.after(() => controller.close());
  await controller.navigate('workers');
  assert.equal(controller.selected().id, 'local');
  assert.match(controller.state.note, /Network unavailable/);
  assert.ok(controller.state.error);
  controller.workerMenu();
  assert.ok(controller.state.menu.items.length);
});
