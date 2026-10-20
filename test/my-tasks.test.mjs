import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveOrder } from '../src/lib/orders.mjs';
import { sendJson, startMock } from './helpers/mock-api.mjs';
import { TEST_ADDRESS, TEST_KEY } from './helpers/cli.mjs';
import { runCli } from './helpers/cli.mjs';
import { createServices } from '../src/tui/services.mjs';

test('dashboard interleaves unpaid requests and published tasks by recency', async () => {
  await withHome(async home => {
    const api = 'http://unused.local';
    await saveOrder(home, localState({ api, jobId: LOCAL_JOB, createdAt: '2099-01-01T00:00:00.000Z' }));
    await saveOrder(home, localState({ api, requestKey: PENDING_ORDER, status: 'challenged', createdAt: '2099-02-01T00:00:00.000Z' }));
    const doc = await createServices({ home, api, local: true }).mine();
    assert.deepEqual(doc.items.map(item => item.id), [PENDING_ORDER, LOCAL_JOB]);
  });
});

const OTHER_ADDRESS = '0x1111111111111111111111111111111111111111';
const SECRET_TOKEN = 'aa'.repeat(32);
const SECRET_PAYMENT_HEADER = 'secret-payment-header-value';
const SECRET_QUOTE_SIGNATURE = '0xsecret-quote-signature';
const SECRET_PAYMENT_FROM_OLD_STATE = 'bb'.repeat(32);

const LOCAL_JOB = '10000000-0000-4000-8000-000000000001';
const REMOTE_JOB = '20000000-0000-4000-8000-000000000002';
const OTHER_JOB = '30000000-0000-4000-8000-000000000003';
const OLD_JOB = '40000000-0000-4000-8000-000000000004';
const LIMIT_JOB_1 = '50000000-0000-4000-8000-000000000005';
const LIMIT_JOB_2 = '60000000-0000-4000-8000-000000000006';
const LIMIT_JOB_3 = '70000000-0000-4000-8000-000000000007';

const LOCAL_ORDER = '11111111-1111-4111-8111-111111111111';
const PENDING_ORDER = '22222222-2222-4222-8222-222222222222';
const REFUSED_ORDER = '33333333-3333-4333-8333-333333333333';
const REMOTE_ORDER = '44444444-4444-4444-8444-444444444444';
const REFUSED_REMOTE_ORDER = '55555555-5555-4555-8555-555555555555';
const OLD_ORDER = '66666666-6666-4666-8666-666666666666';
const SAME_JOB_ORDER = '77777777-7777-4777-8777-777777777777';

function localState(overrides = {}) {
  return {
    version: 1,
    requestKey: overrides.requestKey ?? '99999999-9999-4999-8999-999999999999',
    requestToken: SECRET_TOKEN,
    api: overrides.api,
    action: 'job.open',
    input: { objective: overrides.objective ?? 'local objective' },
    inputHash: 'cd'.repeat(32),
    createdAt: overrides.createdAt ?? '2026-10-17T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-10-17T10:01:00.000Z',
    status: overrides.status ?? 'admitted',
    ...overrides,
  };
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'colony-mine-test-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function remoteOrder(orderId, jobId, extra = {}) {
  return {
    orderId,
    action: 'job.open',
    status: extra.status ?? 'admitted',
    createdAt: extra.createdAt ?? '2026-10-17T12:00:00.000Z',
    paidAt: extra.paidAt ?? '2026-10-17T12:01:00.000Z',
    payment: extra.payment ?? {
      status: 'confirmed',
      transactionHash: `0x${'12'.repeat(32)}`,
      reason: null,
    },
    result: extra.result ?? (jobId
      ? {
        kind: 'job',
        jobId,
        launch: false,
        statusUrl: `/jobs/${jobId}`,
        resultUrl: `/jobs/${jobId}/result`,
      }
      : {
        kind: 'refused',
        problems: [{ code: 'policy', detail: 'refused after payment' }],
      }),
  };
}

function job(jobId, extra = {}) {
  return {
    id: jobId,
    state: extra.state ?? 'executing',
    template: 'skill:research-report',
    objective: extra.objective ?? `objective for ${jobId}`,
    project: extra.project ?? { id: 'project-1', version: 2, of: 2 },
    updatedAt: extra.updatedAt ?? '2026-10-17T12:02:00.000Z',
  };
}

function assertNoSecrets(text) {
  assert.doesNotMatch(text, new RegExp(SECRET_TOKEN));
  assert.doesNotMatch(text, new RegExp(SECRET_PAYMENT_HEADER));
  assert.doesNotMatch(text, new RegExp(SECRET_QUOTE_SIGNATURE));
  assert.doesNotMatch(text, /paymentHeader/);
  assert.doesNotMatch(text, /requestToken/);
  assert.doesNotMatch(text, /quoteSignature/);
}

test('task mine --local reads only local state and separates tasks from unpaid orders', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response }) => sendJson(response, 500, { error: 'must not call' }));
    try {
      await saveOrder(home, localState({
        requestKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        api: mock.url,
        orderId: LOCAL_ORDER,
        jobId: LOCAL_JOB,
        status: 'admitted',
        lastStatus: 'admitted',
        paymentStatus: 'confirmed',
        transactionHash: `0x${'34'.repeat(32)}`,
        paymentHeader: SECRET_PAYMENT_HEADER,
        quoteSignature: SECRET_QUOTE_SIGNATURE,
        payer: TEST_ADDRESS,
        objective: 'local completed objective',
      }));
      await saveOrder(home, localState({
        requestKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        api: mock.url,
        orderId: PENDING_ORDER,
        status: 'quoted',
        lastStatus: 'quoted',
        objective: 'new order waiting for payment',
      }));
      await saveOrder(home, localState({
        requestKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        api: mock.url,
        orderId: REFUSED_ORDER,
        status: 'refused',
        lastStatus: 'admitted',
        paymentStatus: 'confirmed',
        objective: 'refused objective',
        refusalProblems: [{ code: 'policy', detail: 'no' }],
      }));
      await saveOrder(home, localState({
        requestKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        api: 'https://other.example',
        orderId: '12121212-1212-4212-8212-121212121212',
        jobId: OTHER_JOB,
        objective: 'other api objective',
      }));

      const result = await runCli(
        ['task', 'mine', '--local', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(mock.requests.length, 0);
      assertNoSecrets(result.stdout);

      const doc = JSON.parse(result.stdout);
      assert.equal(doc.mode, 'local');
      assert.equal(doc.remote.queried, false);
      assert.equal(doc.local.excludedApi, 1);
      assert.equal(doc.tasks.length, 1);
      assert.equal(doc.tasks[0].jobId, LOCAL_JOB);
      assert.equal(doc.tasks[0].executionState, null);
      assert.equal(doc.tasks[0].objective, 'local completed objective');
      assert.equal(doc.tasks[0].orderStatus, 'admitted');
      assert.equal(doc.tasks[0].paymentStatus, 'confirmed');
      assert.equal(doc.tasks[0].source, 'local');
      assert.equal(doc.tasks[0].ownership, 'known');

      const pending = doc.orders.find((order) => order.orderId === PENDING_ORDER);
      const refused = doc.orders.find((order) => order.orderId === REFUSED_ORDER);
      assert.ok(pending);
      assert.equal('jobId' in pending, false);
      assert.equal(pending.objective, 'new order waiting for payment');
      assert.equal(pending.orderStatus, 'quoted');
      assert.ok(refused);
      assert.equal('jobId' in refused, false);
      assert.equal(refused.orderStatus, 'admitted');
      assert.deepEqual(refused.refusalProblems, [{ code: 'policy', detail: 'no' }]);
      assert.equal(doc.orders.some((order) => order.jobId === OTHER_JOB), false);
    } finally {
      await mock.close();
    }
  });
});

test('default mine with a key keeps unknown-payer local orders visible but unclaimed', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/requests/paid-by/${TEST_ADDRESS}`) {
        sendJson(response, 200, {
          payer: TEST_ADDRESS,
          count: 1,
          orders: [remoteOrder(REMOTE_ORDER, REMOTE_JOB)],
        });
        return;
      }
      if (record.path === `/jobs/${REMOTE_JOB}`) {
        sendJson(response, 200, job(REMOTE_JOB, { state: 'completed' }));
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      await saveOrder(home, localState({
        requestKey: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        api: mock.url,
        orderId: PENDING_ORDER,
        status: 'created',
        objective: 'just created, no payer yet',
      }));

      const result = await runCli(
        ['task', 'mine', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assertNoSecrets(result.stdout);

      const doc = JSON.parse(result.stdout);
      assert.equal(doc.mode, 'wallet');
      assert.equal(doc.remote.queried, true);
      assert.equal(doc.wallet.address, TEST_ADDRESS);
      assert.equal(doc.tasks.length, 1);
      assert.equal(doc.tasks[0].jobId, REMOTE_JOB);
      assert.equal(doc.tasks[0].source, 'remote');

      const pending = doc.orders.find((order) => order.orderId === PENDING_ORDER);
      assert.ok(pending, 'unknown-payer local pending order must stay visible');
      assert.equal(pending.source, 'local');
      assert.equal(pending.payer, null);
      assert.equal(pending.ownership, 'unknown');
      assert.equal(doc.local.included, 1);
    } finally {
      await mock.close();
    }
  });
});

test('explicit --address is a strict view and merges only proven local orders', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/requests/paid-by/${TEST_ADDRESS}`) {
        sendJson(response, 200, {
          payer: TEST_ADDRESS,
          count: 3,
          orders: [
            remoteOrder(LOCAL_ORDER, LOCAL_JOB, {
              paidAt: '2026-10-17T12:01:00.000Z',
            }),
            remoteOrder(REMOTE_ORDER, REMOTE_JOB, {
              paidAt: '2026-10-17T12:00:00.000Z',
            }),
            remoteOrder(PENDING_ORDER, null, {
              status: 'payment_failed',
              paidAt: null,
              payment: { status: 'failed', transactionHash: null, reason: 'expired' },
              result: null,
            }),
          ],
        });
        return;
      }
      if (record.path === `/jobs/${LOCAL_JOB}`) {
        sendJson(response, 200, job(LOCAL_JOB, { objective: 'merged local+remote objective' }));
        return;
      }
      if (record.path === `/jobs/${REMOTE_JOB}`) {
        sendJson(response, 200, job(REMOTE_JOB));
        return;
      }
      if (record.path === `/jobs/${OLD_JOB}`) {
        sendJson(response, 200, job(OLD_JOB));
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      await saveOrder(home, localState({
        requestKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        api: mock.url,
        orderId: LOCAL_ORDER,
        jobId: LOCAL_JOB,
        payer: TEST_ADDRESS,
        objective: 'local objective',
      }));
      await saveOrder(home, localState({
        requestKey: 'abababab-abab-4bab-8bab-abababababab',
        api: mock.url,
        orderId: PENDING_ORDER,
        status: 'quoted',
        objective: 'unknown owner pending',
      }));
      await saveOrder(home, localState({
        requestKey: 'acacacac-acac-4cac-8cac-acacacacacac',
        api: mock.url,
        orderId: REFUSED_ORDER,
        status: 'quoted',
        payer: OTHER_ADDRESS,
        objective: 'someone else order',
      }));
      await saveOrder(home, localState({
        requestKey: 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0',
        api: mock.url,
        orderId: '13131313-1313-4313-8313-131313131313',
        status: 'quoted',
        objective: 'unknown owner without remote proof',
      }));
      await saveOrder(home, localState({
        requestKey: 'adadadad-adad-4dad-8dad-adadadadadad',
        api: mock.url,
        orderId: OLD_ORDER,
        jobId: OLD_JOB,
        // No state.payer. The signed Permit2 payload from an older publish is
        // evidence of the payer; it is read, never migrated.
        payment: { payload: { permit2Authorization: { from: TEST_ADDRESS } } },
        paymentHeader: SECRET_PAYMENT_HEADER,
        objective: 'old state payment evidence',
      }));

      const result = await runCli(
        ['task', 'mine', '--address', TEST_ADDRESS, '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 0, result.stderr);
      assertNoSecrets(result.stdout);

      const doc = JSON.parse(result.stdout);
      assert.equal(doc.wallet.source, 'option');
      const jobs = doc.tasks.map((task) => task.jobId).sort();
      assert.deepEqual(jobs, [LOCAL_JOB, OLD_JOB, REMOTE_JOB].sort());
      assert.equal(doc.orders.length, 1);
      assert.equal(doc.local.excludedPayer, 2);

      const recovered = doc.orders.find((order) => order.orderId === PENDING_ORDER);
      assert.ok(recovered, 'unknown local payer is recovered when remote proves the order id');
      assert.equal(recovered.source, 'both');
      assert.equal(recovered.requestKey, 'abababab-abab-4bab-8bab-abababababab');
      assert.equal(recovered.payer, TEST_ADDRESS);
      assert.equal(recovered.objective, 'unknown owner pending');

      const merged = doc.tasks.find((task) => task.jobId === LOCAL_JOB);
      assert.equal(merged.source, 'both');
      assert.equal(merged.orderId, LOCAL_ORDER);
      assert.equal(merged.objective, 'merged local+remote objective');
      assert.equal(merged.payer, TEST_ADDRESS);

      const old = doc.tasks.find((task) => task.jobId === OLD_JOB);
      assert.equal(old.source, 'local');
      assert.equal(old.payer, TEST_ADDRESS);
      assert.equal(old.ownership, 'known');
    } finally {
      await mock.close();
    }
  });
});

test('deduplicates order ids and job ids and reports the remote 100-order cap', async () => {
  await withHome(async (home) => {
    let localJobFetches = 0;
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/requests/paid-by/${TEST_ADDRESS}`) {
        sendJson(response, 200, {
          payer: TEST_ADDRESS,
          count: 5,
          orders: [
            remoteOrder(LOCAL_ORDER, LOCAL_JOB),
            remoteOrder(LOCAL_ORDER, LOCAL_JOB),
            remoteOrder(SAME_JOB_ORDER, LOCAL_JOB, {
              paidAt: '2026-10-17T11:59:00.000Z',
            }),
            remoteOrder(REMOTE_ORDER, REMOTE_JOB),
            remoteOrder(REFUSED_REMOTE_ORDER, null, {
              status: 'payment_failed',
              paidAt: null,
              payment: { status: 'failed', transactionHash: null, reason: 'insufficient_funds' },
              result: null,
            }),
          ],
        });
        return;
      }
      if (record.path === `/jobs/${LOCAL_JOB}`) {
        localJobFetches += 1;
        sendJson(response, 200, job(LOCAL_JOB));
        return;
      }
      if (record.path === `/jobs/${REMOTE_JOB}`) {
        sendJson(response, 200, job(REMOTE_JOB));
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      await saveOrder(home, localState({
        requestKey: 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae',
        api: mock.url,
        orderId: LOCAL_ORDER,
        jobId: LOCAL_JOB,
        payer: TEST_ADDRESS,
        objective: 'local copy',
      }));

      const result = await runCli(
        ['task', 'mine', '--address', TEST_ADDRESS, '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 0, result.stderr);
      assertNoSecrets(result.stdout);

      const doc = JSON.parse(result.stdout);
      assert.equal(doc.remote.queried, true);
      assert.equal(doc.remote.returned, 5);
      assert.equal(doc.remote.cap, 100);
      assert.match(doc.remote.note, /newest 100/);
      assert.match(doc.remote.note, /no pagination/);

      assert.equal(doc.tasks.length, 2);
      assert.equal(localJobFetches, 1);
      const merged = doc.tasks.find((task) => task.jobId === LOCAL_JOB);
      assert.ok(merged);
      assert.equal(merged.source, 'both');
      assert.ok([LOCAL_ORDER, SAME_JOB_ORDER].includes(merged.orderId));

      assert.equal(doc.orders.length, 1);
      assert.equal(doc.orders[0].orderId, REFUSED_REMOTE_ORDER);
      assert.equal('jobId' in doc.orders[0], false);
      assert.equal(doc.orders[0].orderStatus, 'payment_failed');
      assert.equal(doc.orders[0].paymentStatus, 'failed');
      assert.equal(doc.orders[0].objective, null);
    } finally {
      await mock.close();
    }
  });
});

test('--limit truncates before fetching job details and validates the range', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/requests/paid-by/${TEST_ADDRESS}`) {
        sendJson(response, 200, {
          payer: TEST_ADDRESS,
          count: 3,
          orders: [
            remoteOrder('81111111-1111-4111-8111-111111111111', LIMIT_JOB_1, {
              paidAt: '2026-10-17T12:03:00.000Z',
            }),
            remoteOrder('82222222-2222-4222-8222-222222222222', LIMIT_JOB_2, {
              paidAt: '2026-10-17T12:02:00.000Z',
            }),
            remoteOrder('83333333-3333-4333-8333-333333333333', LIMIT_JOB_3, {
              paidAt: '2026-10-17T12:01:00.000Z',
            }),
          ],
        });
        return;
      }
      if (record.path.startsWith('/jobs/')) {
        sendJson(response, 200, job(record.path.slice('/jobs/'.length)));
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(
        ['task', 'mine', '--address', TEST_ADDRESS, '--limit', '2', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 0, result.stderr);
      const doc = JSON.parse(result.stdout);
      assert.equal(doc.tasks.length, 2);
      assert.equal(doc.truncated, true);
      assert.equal(doc.totals.candidates, 3);
      const fetched = mock.requests.filter((request) => request.path.startsWith('/jobs/'));
      assert.equal(fetched.length, 2);

      for (const bad of ['0', '101', '1.5']) {
        const invalid = await runCli(
          ['task', 'mine', '--local', '--limit', bad, '--json'],
          { COLONY_HOME: home, COLONY_API_URL: 'http://127.0.0.1:1', COLONY_PRIVATE_KEY: '' },
        );
        assert.equal(invalid.status, 1);
        assert.equal(invalid.stdout, '');
        assert.match(invalid.stderr, /--limit must be an integer from 1 to 100/);
      }
    } finally {
      await mock.close();
    }
  });
});

test('remote failures are explicit, suggest --local, and never fall back silently', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response }) => {
      sendJson(response, 503, { error: 'paid_request_unavailable', detail: 'try later' });
    });
    try {
      const result = await runCli(
        ['task', 'mine', '--address', TEST_ADDRESS, '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /HTTP 503 paid_request_unavailable: try later/);
      assert.match(result.stderr, /--local/);
      assert.match(result.stderr, /no automatic fallback/);

      const before = mock.requests.length;
      const local = await runCli(
        ['task', 'mine', '--local', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(local.status, 0, local.stderr);
      assert.equal(mock.requests.length, before);
      assert.equal(JSON.parse(local.stdout).remote.queried, false);
    } finally {
      await mock.close();
    }
  });
});

test('job lookup failures are visible without leaking local secrets', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/requests/paid-by/${TEST_ADDRESS}`) {
        sendJson(response, 200, {
          payer: TEST_ADDRESS,
          count: 1,
          orders: [remoteOrder(REMOTE_ORDER, REMOTE_JOB)],
        });
        return;
      }
      if (record.path === `/jobs/${REMOTE_JOB}`) {
        sendJson(response, 503, { error: 'job_unavailable', detail: 'later' });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      await saveOrder(home, localState({
        requestKey: 'afafafaf-afaf-4faf-8faf-afafafafafaf',
        api: mock.url,
        orderId: PENDING_ORDER,
        status: 'quoted',
        requestToken: SECRET_TOKEN,
        paymentHeader: SECRET_PAYMENT_HEADER,
        quoteSignature: SECRET_QUOTE_SIGNATURE,
      }));

      const result = await runCli(
        ['task', 'mine', '--address', TEST_ADDRESS, '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /error: job .*HTTP 503 job_unavailable: later/);
      assertNoSecrets(result.stderr);
    } finally {
      await mock.close();
    }
  });
});

test('no wallet and no --local lists local state only without touching the network', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response }) => sendJson(response, 500, { error: 'must not call' }));
    try {
      await saveOrder(home, localState({
        requestKey: 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0',
        api: mock.url,
        orderId: PENDING_ORDER,
        status: 'created',
        objective: 'no wallet pending',
      }));

      const result = await runCli(
        ['task', 'mine', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(mock.requests.length, 0);
      const doc = JSON.parse(result.stdout);
      assert.equal(doc.mode, 'local');
      assert.equal(doc.wallet.address, null);
      assert.equal(doc.remote.queried, false);
      assert.equal(doc.orders.length, 1);
      assert.equal(doc.orders[0].objective, 'no wallet pending');
    } finally {
      await mock.close();
    }
  });
});

test('text output separates status fields and suggests show, wait and continue', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/requests/paid-by/${TEST_ADDRESS}`) {
        sendJson(response, 200, {
          payer: TEST_ADDRESS,
          count: 2,
          orders: [
            remoteOrder(REMOTE_ORDER, REMOTE_JOB),
            remoteOrder(REFUSED_REMOTE_ORDER, null, { result: null, status: 'payment_failed' }),
          ],
        });
        return;
      }
      if (record.path === `/jobs/${REMOTE_JOB}`) {
        sendJson(response, 200, job(REMOTE_JOB, {
          state: 'completed',
          objective: 'a readable task objective',
        }));
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      await saveOrder(home, localState({
        requestKey: 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
        api: mock.url,
        orderId: PENDING_ORDER,
        status: 'created',
        objective: 'pending local order',
      }));

      const result = await runCli(
        ['task', 'mine', '--address', TEST_ADDRESS],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /tasks \(1\)/);
      assert.match(result.stdout, /orders without a job \(1\)/);
      assert.match(result.stdout, /a readable task objective/);
      assert.match(result.stdout, /order=admitted/);
      assert.match(result.stdout, /payment=confirmed/);
      assert.match(result.stdout, /source=remote/);
      assert.match(result.stdout, /colony task show/);
      assert.match(result.stdout, /colony task wait/);
      assert.match(result.stdout, /colony task continue/);
      assert.match(result.stdout, /newest 100 cap/);
      assertNoSecrets(result.stdout);
    } finally {
      await mock.close();
    }
  });
});
