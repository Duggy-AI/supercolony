import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cancelOrder, deleteOrder, findOrder, listOrders, orderActions, orderSummary, saveOrder } from '../src/lib/orders.mjs';
import { hashJson, publishJob, refreshOrder, submitOrder } from '../src/lib/publish.mjs';
import { createServices } from '../src/tui/services.mjs';
import { runEntry } from './helpers/cli.mjs';
import { sendJson, startMock } from './helpers/mock-api.mjs';

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN = 'private-order-token';
const input = { objective: 'Build a coffee website' };

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'colony-cancel-'));
  const mock = await startMock(({ response }) => sendJson(response, 200, { status: 'expired' }));
  t.after(async () => { await mock.close(); await rm(home, { recursive: true, force: true }); });
  const state = {
    requestKey: KEY, orderId: ORDER, requestToken: TOKEN, api: mock.url,
    action: 'job.open', input, inputHash: hashJson(input),
    createdAt: '2026-10-01T00:00:00.000Z', status: 'challenged',
    lastError: 'Aborted with Ctrl+C',
  };
  await saveOrder(home, state);
  return { home, mock, state };
}

test('cancellation is local, survives a server refresh, and blocks every recovery entry point', async (t) => {
  const { home, mock } = await fixture(t);
  const cancelled = await cancelOrder(home, ORDER);
  assert.equal(cancelled.status, 'challenged');
  assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.lastError, null);
  assert.equal(orderSummary(cancelled).status, 'cancelled');
  assert.deepEqual(orderActions(cancelled), { canCancel: false, canDelete: true, canResume: false });
  assert.equal(mock.requests.length, 0);

  const options = { home, api: mock.url, id: ORDER, input, requestKey: KEY, yes: true, keyEnv: 'COLONY_UNCONFIGURED_TEST_KEY' };
  const services = createServices(options);
  for (const replay of [
    () => publishJob(options),
    () => submitOrder(options),
    () => services.resume({ requestKey: KEY }, () => assert.fail('must not ask for payment')),
  ]) await assert.rejects(replay, /cancelled locally/);
  assert.equal(mock.requests.length, 0);

  const refreshed = await refreshOrder({ home, id: KEY });
  assert.equal(refreshed.status, 'expired');
  assert.equal(orderSummary(refreshed).status, 'cancelled');
  assert.equal(orderSummary(refreshed).remoteStatus, 'expired');
  assert.equal(orderActions(refreshed).canDelete, true);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].method, 'GET');
  assert.equal(mock.requests[0].path, '/requests/' + ORDER);

  const doc = await services.mine();
  assert.equal(doc.items[0].state, 'cancelled');
  assert.equal(doc.items[0].canResume, false);
});

test('a payment authorization, submit attempt or published job preserves its recovery record', async (t) => {
  const { home, mock, state } = await fixture(t);
  for (const evidence of [
    { paymentHeader: 'saved-payment' }, { quoteSignature: 'saved-signature' },
    { payment: { payload: {} } }, { submittedAt: '2026-10-01T00:01:00Z' },
    { status: 'signed' }, { status: 'submitted' }, { status: 'admitted' },
    { jobId: 'published-job' }, { paymentStatus: 'pending' }, { transactionHash: '0x123' },
  ]) {
    const saved = { ...state, ...evidence, revision: (await findOrder(home, KEY)).revision };
    await saveOrder(home, saved);
    assert.equal(orderActions(saved).canCancel, false);
    await assert.rejects(cancelOrder(home, KEY), /Only unsigned, unsubmitted/);
    await assert.rejects(deleteOrder(home, KEY), /recovery records must be kept/);
    assert.deepEqual(await findOrder(home, KEY), saved);
  }
  assert.equal(mock.requests.length, 0);
});

test('a stale writer cannot overwrite cancellation or recreate a deleted task', async t => {
  const { home } = await fixture(t);
  const stale = await findOrder(home, KEY);
  await cancelOrder(home, KEY);
  stale.status = 'signed';
  stale.paymentHeader = 'must-not-be-submitted';
  await assert.rejects(saveOrder(home, stale), { code: 'order_cancelled' });
  assert.ok((await findOrder(home, KEY)).cancelledAt);
  await deleteOrder(home, KEY);
  await assert.rejects(saveOrder(home, stale), { code: 'order_changed' });
  assert.deepEqual(await listOrders(home), []);
});

test('concurrent order writers keep exactly one complete update', async t => {
  const { home } = await fixture(t);
  const first = await findOrder(home, KEY);
  const second = structuredClone(first);
  first.lastError = 'first';
  second.lastError = 'second';
  const results = await Promise.allSettled([saveOrder(home, first), saveOrder(home, second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'order_changed');
  const winner = results.find(result => result.status === 'fulfilled').value;
  assert.deepEqual(await findOrder(home, KEY), winner);
});

test('CLI cancellation and deletion require explicit confirmation and never expose private order data', async (t) => {
  const { home, mock } = await fixture(t);
  const args = ['--home', home, '--api', mock.url, '--json', 'order'];
  const missingConfirmation = await runEntry([...args, 'cancel', ORDER]);
  assert.equal(missingConfirmation.status, 1);
  assert.match(missingConfirmation.stderr, /confirmation required/);
  assert.equal((await findOrder(home, KEY)).cancelledAt, undefined);

  const tooEarly = await runEntry([...args, '--yes', 'delete', ORDER]);
  assert.equal(tooEarly.status, 1);
  assert.match(tooEarly.stderr, /Cancel this unsigned request first/);

  const cancelled = await runEntry([...args, '--yes', 'cancel', ORDER]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, 'cancelled');
  assert.doesNotMatch(cancelled.stdout, new RegExp(TOKEN));
  assert.doesNotMatch(cancelled.stdout, /requestToken|paymentHeader|quoteSignature/);

  const mine = await runEntry(['--home', home, '--api', mock.url, 'task', 'mine', '--local']);
  assert.equal(mine.status, 0, mine.stderr);
  assert.match(mine.stdout, /order=cancelled/);
  const keep = await runEntry([...args, 'delete', ORDER]);
  assert.equal(keep.status, 1);
  assert.equal((await listOrders(home)).length, 1);
  const removed = await runEntry([...args, '--yes', 'delete', ORDER]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).deleted, true);
  assert.deepEqual(await listOrders(home), []);
  assert.equal(mock.requests.length, 0);
});
