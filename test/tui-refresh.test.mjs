import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DashboardController, visibleItems } from '../src/tui/controller.mjs';
import { createServices } from '../src/tui/services.mjs';
import { sendJson, startMock } from './helpers/mock-api.mjs';

const START = Date.UTC(2026, 9, 18, 12);
const stamp = (offset) => new Date(START + offset * 1000).toISOString();
function job(index) {
  return { id: 'job-' + index, objective: 'Task ' + index, state: 'executing', createdAt: stamp(-index), updatedAt: stamp(0) };
}
const row = (job) => ({ id: job.id, jobId: job.id, title: job.objective, state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt });
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for refresh');
    await delay(10);
  }
}

test('background refresh adds new tasks and updates states without losing history, selection or scroll', async (t) => {
  const jobs = Array.from({ length: 150 }, (_, index) => job(index));
  const created = { ...job(-1), createdAt: stamp(1), updatedAt: stamp(1) };
  let pending;
  let changed = false;
  const mock = await startMock(({ response, record }) => {
    if (record.path === '/swarm') return sendJson(response, 200, { counts: { jobs: changed ? 151 : 150 } });
    if (record.path === '/jobs') {
      if (record.query.has('since')) { pending = response; return; }
      const page = record.query.has('before') ? jobs.slice(50, 100) : jobs.slice(0, 50);
      return sendJson(response, 200, { count: page.length, jobs: page });
    }
    const found = jobs.find((job) => record.path === '/jobs/' + job.id);
    if (found) return sendJson(response, 200, found);
    return sendJson(response, 404, { error: 'not_found' });
  });
  const controller = new DashboardController(createServices({ api: mock.url }));
  t.after(async () => { controller.close(); await mock.close(); });
  await controller.navigate('explore');
  await controller.more();
  controller.update({ selected: 60 });
  await controller.loadDetail();
  controller.update({ scroll: 7, focus: 'detail', tab: 'Activity' });
  const cursor = controller.state.cursor;
  controller.lastExploreRefresh = 0;
  changed = true;
  const refreshing = controller.autoRefresh();
  await until(() => Boolean(pending));
  assert.equal(controller.state.busy, null);
  assert.equal(controller.state.refreshing, true);
  // Reading can continue while the request is in flight.
  controller.update({ scroll: 11 });
  const stale = { ...jobs[80] };
  jobs[60] = { ...jobs[60], state: 'completed', updatedAt: stamp(2) };
  jobs[80] = { ...jobs[80], state: 'completed', updatedAt: stamp(2) };
  const olderUnloaded = { ...jobs[149], updatedAt: stamp(3) };
  sendJson(pending, 200, { count: 5, jobs: [created, jobs[60], jobs[80], stale, olderUnloaded] });
  await refreshing;
  assert.equal(controller.state.items.length, 101);
  assert.equal(controller.state.items[0].id, created.id);
  assert.equal(controller.state.items.some((item) => item.id === olderUnloaded.id), false);
  assert.equal(controller.state.items.find((item) => item.id === jobs[80].id).state, 'completed');
  assert.equal(controller.selected().id, jobs[60].id);
  assert.equal(controller.state.selected, 61);
  assert.equal(controller.state.detail.state, 'completed');
  assert.equal(controller.state.scroll, 11);
  assert.equal(controller.state.focus, 'detail');
  assert.equal(controller.state.tab, 'Activity');
  assert.equal(controller.state.cursor, cursor);
  assert.equal(controller.state.total, 151);
  assert.equal(controller.state.since, stamp(3));
  assert.equal(controller.state.refreshing, false);
});

test('auto-refresh waits for its interval, pauses during interaction and discards cancelled replies', async (t) => {
  let calls = 0;
  let signal;
  let finish;
  const first = job(0);
  const controller = new DashboardController({
    coins: () => ['IMD', 'ETH', 'USDC', 'USDT'],
    exploreUpdates: async (_query, _since, requestSignal) => {
      ++calls; signal = requestSignal;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  t.after(() => controller.close());
  controller.update({ view: 'explore', items: [row(first)], since: stamp(0), total: 1 });
  controller.lastExploreRefresh = Date.now();
  await controller.autoRefresh();
  assert.equal(calls, 0);
  controller.lastExploreRefresh = 0;
  for (const field of ['busy', 'detailLoading', 'form', 'confirm', 'menu', 'help']) {
    controller.update({ [field]: true });
    await controller.autoRefresh();
    controller.update({ [field]: false });
  }
  assert.equal(calls, 0);
  const refreshing = controller.autoRefresh();
  await controller.autoRefresh();
  assert.equal(calls, 1);
  controller.create();
  controller.setField('Keep this draft');
  assert.equal(signal.aborted, true);
  finish({ items: [row(job(1))], total: 2, since: stamp(1) });
  await refreshing;
  assert.equal(controller.state.items.length, 1);
  assert.equal(controller.state.items[0].id, first.id);
  assert.equal(controller.state.form.values.objective, 'Keep this draft');
  assert.equal(controller.state.refreshing, false);
  controller.dismissForm();
  controller.lastExploreRefresh = 0;
  const closing = controller.autoRefresh();
  controller.close();
  assert.equal(signal.aborted, true);
  finish({ items: [row(job(2))], total: 3, since: stamp(2) });
  await closing;
  assert.equal(controller.state.items.length, 1);
});

test('refresh failures retain the list and watermark and the next interval retries', async (t) => {
  const first = job(0);
  let calls = 0;
  const controller = new DashboardController({
    exploreUpdates: async (_query, since) => {
      assert.equal(since, stamp(0));
      if (++calls === 1) throw new Error('HTTP 503 temporarily unavailable');
      return { items: [{ ...row(first), state: 'completed', updatedAt: stamp(1) }], since: stamp(1), total: 1 };
    },
    detail: async () => ({ ...first, state: 'completed', updatedAt: stamp(1) }),
  });
  t.after(() => controller.close());
  controller.update({ view: 'explore', items: [row(first)], since: stamp(0), total: 1 });
  await controller.autoRefresh();
  assert.match(controller.state.refreshError, /Auto-refresh failed: HTTP 503/);
  assert.equal(controller.state.since, stamp(0));
  assert.equal(controller.state.items[0].state, 'executing');
  controller.lastExploreRefresh = 0;
  await controller.autoRefresh();
  assert.equal(calls, 2);
  assert.equal(controller.state.items[0].state, 'completed');
  assert.equal(controller.state.since, stamp(1));
  assert.equal(controller.state.refreshError, null);
});

test('incremental reads paginate all updates and overlap the API cache window', async (t) => {
  const jobs = Array.from({ length: 503 }, (_, index) => ({ ...job(index), updatedAt: stamp(index + 1) }));
  const mock = await startMock(({ response, record }) => {
    assert.equal(record.path, '/jobs');
    const page = record.query.has('before') ? jobs.slice(500) : jobs.slice(0, 500);
    sendJson(response, 200, { count: page.length, jobs: page });
  });
  t.after(() => mock.close());
  const services = createServices({ api: mock.url });
  const changes = await services.exploreUpdates('Task', stamp(0));
  assert.equal(changes.items.length, 503);
  assert.equal(changes.since, stamp(503));
  assert.equal(changes.total, null);
  assert.equal(mock.requests.length, 2);
  for (const request of mock.requests) {
    assert.equal(request.query.get('since'), stamp(-30));
    assert.equal(request.query.get('q'), 'Task');
    assert.equal(request.query.get('limit'), '500');
  }
  assert.equal(mock.requests[1].query.get('before'), jobs[499].createdAt);
});

test('my executing task is active and auto-refresh observes its completion', async (t) => {
  const first = job(0);
  const controller = new DashboardController({ detail: async () => ({ ...first, state: 'completed', updatedAt: stamp(1) }) });
  t.after(() => controller.close());
  controller.update({ items: [row(first)], filter: 'Active' });
  assert.equal(visibleItems(controller.state).length, 1);
  await controller.autoRefresh();
  assert.equal(controller.state.items[0].state, 'completed');
  assert.equal(visibleItems(controller.state).length, 0);
});
