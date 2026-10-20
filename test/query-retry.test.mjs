import assert from 'node:assert/strict';
import test from 'node:test';
import { retryQuery } from '../src/lib/query-retry.mjs';
import { request, getPublicRpcClient } from '../src/shared.mjs';
import { startMock, sendJson } from './helpers/mock-api.mjs';

test('query retry stops at three attempts and preserves the last error', async () => {
  let calls = 0;
  const error = Object.assign(new Error('unavailable'), { status: 503 });
  await assert.rejects(retryQuery(async () => { calls++; throw error; }, { delayMs: 1 }), e => e === error);
  assert.equal(calls, 3);
  calls = 0;
  assert.equal(await retryQuery(async () => {
    if (++calls < 3) throw new TypeError('fetch failed');
    return 'ready';
  }, { delayMs: 1 }), 'ready');
  assert.equal(calls, 3);
});

test('cancellation interrupts the retry delay without another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = retryQuery(async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    throw new TypeError('fetch failed');
  }, { signal: controller.signal });
  await assert.rejects(pending, /abort/i);
  assert.equal(calls, 1);
});

test('HTTP queries retry transient responses; missing resources and mutations are not repeated', async t => {
  const counts = {};
  const mock = await startMock(({ response, record }) => {
    counts[record.path] = (counts[record.path] ?? 0) + 1;
    if (record.path === '/read' && counts[record.path] === 3) return sendJson(response, 200, { ok: true });
    sendJson(response, record.path === '/missing' ? 404 : 503, { error: 'unavailable' });
  });
  t.after(() => mock.close());
  assert.equal((await request(mock.url, '/read')).data.ok, true);
  await assert.rejects(request(mock.url, '/missing'), /404/);
  await assert.rejects(request(mock.url, '/pay', { method: 'POST' }), /503/);
  assert.deepEqual(counts, { '/read': 3, '/missing': 1, '/pay': 1 });
});

test('RPC queries stop at three attempts; transaction broadcasts remain single-attempt', async t => {
  let reads = 0;
  let broadcasts = 0;
  const mock = await startMock(({ response, record }) => {
    if (record.body.method === 'eth_chainId') return sendJson(response, 200, { jsonrpc: '2.0', id: record.body.id, result: '0x1' });
    if (record.body.method === 'eth_sendRawTransaction') broadcasts++; else reads++;
    sendJson(response, 503, { error: 'unavailable' });
  });
  t.after(() => mock.close());
  const client = await getPublicRpcClient({ rpc: mock.url }, 1);
  await assert.rejects(client.getBalance({ address: '0x' + '11'.repeat(20) }));
  assert.equal(reads, 3);
  await assert.rejects(client.sendRawTransaction({ serializedTransaction: '0x01' }));
  assert.equal(broadcasts, 1);
});
