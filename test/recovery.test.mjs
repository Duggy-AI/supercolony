import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveOrder } from '../src/lib/orders.mjs';
import { startPreparedPaymentMock as startMock } from "./helpers/prepared-payment-api.mjs";
import { sendJson } from './helpers/mock-api.mjs';
import { runCli, TEST_KEY } from './helpers/cli.mjs';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const TX_HASH = `0x${'33'.repeat(32)}`;
const RESOURCE_HASH = '11'.repeat(32);

const QUOTE = {
  v: 1,
  id: ORDER_ID,
  action: 'job.open',
  policyVersion: 'test-1',
  inputHash: 'cd'.repeat(32),
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  payment: {
    network: 'eip155:1',
    asset: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
    amount: '500000000000000000',
    payTo: '0x4e0fa57bde726079356537e2f34d671e9f41adbc',
    decimals: 18,
    scheme: 'exact',
  },
  terms: { purchase: 'action-admission', resultGuaranteed: false },
  quoteHash: 'ab'.repeat(32),
};

function challenge(api) {
  const resourceUrl = `${api}/requests/${ORDER_ID}/submit`;
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: 'job.open', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:1',
      asset: QUOTE.payment.asset,
      amount: QUOTE.payment.amount,
      payTo: QUOTE.payment.payTo,
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: 'permit2' },
    }],
    quote: QUOTE,
    requesterScopeHash: RESOURCE_HASH,
    resourceUrl,
    input: { objective: 'prepared' },
  };
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'colony-recovery-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function baseHandler({ submitStatus = 202, statusBody, onQuote } = {}) {
  return ({ request, response, record }) => {
    if (record.path === '/requests/check') {
      sendJson(response, 200, { action: 'job.open', blockers: [], plan: [], facts: [], judged: true });
      return;
    }
    if (record.path === '/requests/quote') {
      if (onQuote) onQuote(record);
      sendJson(response, 201, { created: true, order: { id: ORDER_ID, status: 'quoted', quote: QUOTE } });
      return;
    }
    if (record.path === `/requests/${ORDER_ID}/submit` && record.method === 'POST') {
      if (!record.headers['payment-signature']) {
        sendJson(response, 402, challenge('http://127.0.0.1'));
        return;
      }
      sendJson(response, submitStatus, { status: 'payment_pending' });
      return;
    }
    if (record.path === `/requests/${ORDER_ID}` && record.method === 'GET') {
      sendJson(response, 200, statusBody);
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  };
}

test('a signed order that returns 410 refreshes the original order instead of re-quoting', async () => {
  await withHome(async (home) => {
    let quoteCalls = 0;
    let statusCalls = 0;
    const handler = baseHandler({
      submitStatus: 410,
      onQuote: () => { quoteCalls += 1; },
      statusBody: {
        status: 'admitted',
        order: { id: ORDER_ID, status: 'paid', quote: QUOTE },
        payment: { status: 'confirmed', transactionHash: TX_HASH },
        admission: {
          action: 'job.open',
          result: { kind: 'job', jobId: JOB_ID, statusUrl: `/jobs/${JOB_ID}`, resultUrl: `/jobs/${JOB_ID}/result` },
        },
      },
    });
    const mock = await startMock(({ request, response, record }) => {
      if (record.path === `/requests/${ORDER_ID}` && record.method === 'GET') statusCalls += 1;
      handler({ request, response, record });
    });

    try {
      const result = await runCli(
        ['task', 'publish', '--file', 'examples/research-job.json', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'admitted');
      assert.equal(output.jobId, JOB_ID);
      assert.equal(quoteCalls, 1);
      assert.equal(statusCalls, 1);
      const files = await readdir(join(home, 'orders'));
      const state = JSON.parse(await readFile(join(home, 'orders', files[0]), 'utf8'));
      assert.equal(state.status, 'admitted');
      assert.equal(state.lastStatus, 'admitted');
    } finally {
      await mock.close();
    }
  });
});

test('a signed 410 with a pending order never suggests a new payment', async () => {
  await withHome(async (home) => {
    const mock = await startMock(baseHandler({
      submitStatus: 410,
      statusBody: { status: 'admission_pending', order: { id: ORDER_ID, status: 'paid', quote: QUOTE } },
    }));

    try {
      const result = await runCli(
        ['task', 'publish', '--file', 'examples/research-job.json', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /payment is already signed/);
      assert.match(result.stderr, /Do not start a new order/);
      assert.match(result.stderr, /order show .* --refresh/);
      assert.doesNotMatch(result.stderr, /No payment was signed/);
      assert.doesNotMatch(result.stderr, /Start a new publish/);
      const files = await readdir(join(home, 'orders'));
      const state = JSON.parse(await readFile(join(home, 'orders', files[0]), 'utf8'));
      assert.equal(state.status, 'submitted');
      assert.ok(state.paymentHeader);
      assert.ok(state.quoteSignature);
    } finally {
      await mock.close();
    }
  });
});

test('admitted but refused admission is reported as a failure, not a published job', async () => {
  await withHome(async (home) => {
    const mock = await startMock(baseHandler({
      statusBody: {
        status: 'admitted',
        order: { id: ORDER_ID, status: 'paid', quote: QUOTE },
        payment: { status: 'confirmed', transactionHash: TX_HASH },
        admission: {
          action: 'job.open',
          result: { kind: 'refused', problems: [{ code: 'policy', detail: 'refused after payment' }] },
        },
      },
    }));

    try {
      const result = await runCli(
        ['task', 'publish', '--file', 'examples/research-job.json', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'refused');
      assert.equal(output.orderId, ORDER_ID);
      assert.equal(output.transactionHash, TX_HASH);
      assert.deepEqual(output.problems, [{ code: 'policy', detail: 'refused after payment' }]);

      const files = await readdir(join(home, 'orders'));
      const state = JSON.parse(await readFile(join(home, 'orders', files[0]), 'utf8'));
      assert.equal(state.status, 'refused');
      assert.equal(state.admission.result.kind, 'refused');
      assert.equal(state.transactionHash, TX_HASH);
    } finally {
      await mock.close();
    }
  });
});

test('order show is local by default and --refresh reads the server', async () => {
  await withHome(async (home) => {
    let statusCalls = 0;
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/requests/${ORDER_ID}`) {
        statusCalls += 1;
        sendJson(response, 200, {
          status: 'admitted',
          order: { id: ORDER_ID, status: 'paid', quote: QUOTE },
          payment: { status: 'confirmed', transactionHash: TX_HASH },
          admission: {
            action: 'job.open',
            result: { kind: 'refused', problems: [{ code: 'policy', detail: 'no' }] },
          },
        });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });

    try {
      const requestKey = '55555555-5555-4555-8555-555555555555';
      await saveOrder(home, {
        version: 1,
        requestKey,
        requestToken: 'bb'.repeat(32),
        api: mock.url,
        action: 'job.open',
        input: { objective: 'x' },
        inputHash: 'ee'.repeat(32),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'submitted',
        orderId: ORDER_ID,
        quote: QUOTE,
      });

      const local = await runCli(['order', 'show', ORDER_ID, '--json'], { COLONY_HOME: home });
      assert.equal(local.status, 0, local.stderr);
      assert.equal(statusCalls, 0);
      assert.equal(JSON.parse(local.stdout).status, 'submitted');

      const refreshed = await runCli(['order', 'show', ORDER_ID, '--refresh', '--json'], { COLONY_HOME: home });
      assert.equal(refreshed.status, 0, refreshed.stderr);
      assert.equal(statusCalls, 1);
      const output = JSON.parse(refreshed.stdout);
      assert.equal(output.status, 'refused');
      assert.equal(output.remoteStatus, 'admitted');
      assert.equal(output.transactionHash, TX_HASH);
      assert.deepEqual(output.refusalProblems, [{ code: 'policy', detail: 'no' }]);

      const state = JSON.parse(await readFile(join(home, 'orders', `${requestKey}.json`), 'utf8'));
      assert.equal(state.status, 'refused');
    } finally {
      await mock.close();
    }
  });
});
