import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, sha256, stringToBytes } from 'viem';
import {
  buildPayment,
  canonicalJson,
  hashJson,
  paymentSummary,
  publishJob,
  quoteApprovalTypedData,
  readJobFile,
} from '../src/lib/publish.mjs';
import { saveOrder } from '../src/lib/orders.mjs';
import { startPreparedPaymentMock as startMock } from "./helpers/prepared-payment-api.mjs";
import { sendJson } from './helpers/mock-api.mjs';
import { runCli, TEST_ADDRESS, TEST_KEY } from './helpers/cli.mjs';
import { withSubmissionAttribution } from '../src/lib/submission-attribution.mjs';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_HASH = 'ab'.repeat(32);
const INPUT_HASH = 'cd'.repeat(32);
const RESOURCE_HASH = '11'.repeat(32);
const TX_HASH = `0x${'33'.repeat(32)}`;

function quote() {
  return {
    v: 1,
    id: ORDER_ID,
    action: 'job.open',
    policyVersion: 'test-1',
    inputHash: INPUT_HASH,
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
    quoteHash: QUOTE_HASH,
  };
}

const TEST_QUOTE = quote();

test('a quote cannot change the supported IMD decimals', () => withHome(async home => {
  // This would display 0.0005 IMD but sign 0.5 IMD with the real token decimals.
  const misleadingQuote = { ...TEST_QUOTE, payment: { ...TEST_QUOTE.payment, decimals: 21 } };
  const mock = await startMock(({ response, record }) => {
    if (record.path === '/requests/check') return sendJson(response, 200, { blockers: [] });
    if (record.path === '/requests/quote') return sendJson(response, 201, {
      order: { id: ORDER_ID, quote: misleadingQuote },
    });
    if (record.path.endsWith('/submit')) {
      return record.headers['payment-signature']
        ? sendJson(response, 202, { status: 'payment_pending' })
        : sendJson(response, 402, { ...challenge(mock.url), quote: misleadingQuote });
    }
    if (record.path === `/requests/${ORDER_ID}`) return sendJson(response, 200, { status: 'admitted' });
    sendJson(response, 404, {});
  });
  try {
    const result = await runCli(['task', 'publish', '--file', 'examples/research-job.json', '--yes'], {
      COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY,
    });
    assert.equal(result.status, 1, 'must not sign a price with incorrect token decimals\n' + result.stderr);
    assert.match(result.stderr, /quote currency/);
    assert.equal(mock.requests.some(r => r.path.endsWith('/submit') || r.body?.method === 'eth_sendRawTransaction'), false);
  } finally { await mock.close(); }
}));

test('quote approval payment terms must match the saved price before any funding or signature', async (t) => {
  const changes = {
    amount: '500000000000000000000',
    asset: '0x' + '44'.repeat(20),
    payTo: '0x' + '55'.repeat(20),
    network: 'eip155:4663',
  };
  for (const [field, value] of Object.entries(changes)) {
    await t.test(field, () => withHome(async home => {
      const mock = await startMock(({ response, record }) => {
        if (record.path === '/requests/check') return sendJson(response, 200, { blockers: [] });
        if (record.path === '/requests/quote') return sendJson(response, 201, {
          order: { id: ORDER_ID, quote: TEST_QUOTE },
        });
        if (record.path.endsWith('/submit')) {
          if (record.headers['payment-signature']) return sendJson(response, 202, { status: 'payment_pending' });
          const data = challenge(mock.url);
          data.quote = { ...TEST_QUOTE, payment: { ...TEST_QUOTE.payment, [field]: value } };
          return sendJson(response, 402, data);
        }
        if (record.path === `/requests/${ORDER_ID}`) return sendJson(response, 200, { status: 'admitted' });
        sendJson(response, 404, {});
      });
      try {
        const result = await runCli(['task', 'publish', '--file', 'examples/research-job.json', '--yes'], {
          COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY,
        });
        assert.equal(result.status, 1, 'must reject a changed QuoteApproval before signing\n' + result.stderr);
        assert.match(result.stderr, /quote approval .* does not match the saved quote/);
        assert.equal(mock.requests.some(r => r.headers['payment-signature'] || r.body?.method === 'eth_sendRawTransaction'), false);
        const [file] = await readdir(join(home, 'orders'));
        const state = JSON.parse(await readFile(join(home, 'orders', file), 'utf8'));
        assert.equal(state.paymentHeader, undefined);
        assert.equal(state.quoteSignature, undefined);
        assert.equal(state.funding, undefined);
      } finally { await mock.close(); }
    }));
  }
});

function challenge(api, input = JSON.parse(JSON.stringify({ objective: 'x' }))) {
  const resourceUrl = `${api}/requests/${ORDER_ID}/submit`;
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: 'job.open', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:1',
      asset: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
      amount: '500000000000000000',
      payTo: '0x4e0fa57bde726079356537e2f34d671e9f41adbc',
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: 'permit2' },
    }],
    quote: TEST_QUOTE,
    requesterScopeHash: RESOURCE_HASH,
    resourceUrl,
    input,
  };
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'colony-test-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('publish checks, quotes, signs twice, submits and persists recoverable state', async () => {
  await withHome(async (home) => {
    let checkCalls = 0;
    let quoteCalls = 0;
    let challengeResponse;
    let quotedInput;
    const mock = await startMock(({ response, record, requests }) => {
      if (record.path === '/requests/check') {
        checkCalls += 1;
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [], facts: [], judged: true });
        return;
      }
      if (record.path === '/requests/quote') {
        quoteCalls += 1;
        quotedInput = record.body.input;
        sendJson(response, 201, { created: true, order: { id: ORDER_ID, status: 'quoted', quote: TEST_QUOTE } });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}/submit` && record.method === 'POST') {
        if (!record.headers['payment-signature']) {
          challengeResponse = challenge(mock.url, quotedInput);
          sendJson(response, 402, challengeResponse);
          return;
        }
        sendJson(response, 202, { status: 'payment_pending' });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}` && record.method === 'GET') {
        sendJson(response, 200, {
          status: 'admitted',
          order: { id: ORDER_ID, status: 'paid', quote: TEST_QUOTE },
          payment: { status: 'confirmed', paid: true, transactionHash: TX_HASH },
          admission: {
            action: 'job.open',
            result: {
              kind: 'job',
              jobId: JOB_ID,
              launch: false,
              statusUrl: `/jobs/${JOB_ID}`,
              resultUrl: `/jobs/${JOB_ID}/result`,
            },
          },
        });
        return;
      }
      sendJson(response, 404, { error: 'not_found', path: record.path, requests: requests.length });
    });

    try {
      const result = await runCli(
        ['task', 'publish', '--file', 'examples/research-job.json', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'admitted');
      assert.equal(output.orderId, ORDER_ID);
      assert.equal(output.jobId, JOB_ID);
      assert.equal(output.transactionHash, TX_HASH);

      assert.equal(checkCalls, 1);
      assert.equal(quoteCalls, 1);
      const files = await readdir(join(home, 'orders'));
      assert.equal(files.length, 1);
      const state = JSON.parse(await readFile(join(home, 'orders', files[0]), 'utf8'));
      assert.match(state.requestToken, /^[0-9a-f]{64}$/);
      assert.match(state.requestKey, /^[0-9a-f-]{36}$/);
      assert.equal(state.status, 'admitted');
      assert.equal(state.jobId, JOB_ID);
      assert.equal(state.quote.payment.amount, '500000000000000000');

      if (process.platform !== 'win32') {
        assert.equal((await stat(join(home, 'orders', files[0]))).mode & 0o777, 0o600);
      }

      const payment = JSON.parse(Buffer.from(state.paymentHeader, 'base64').toString('utf8'));
      assert.equal(payment.x402Version, 2);
      assert.equal('extensions' in payment, false);
      assert.deepEqual(payment.accepted, challengeResponse.accepts[0]);
      assert.equal(
        state.paymentHash,
        sha256(stringToBytes(canonicalJson(payment))),
      );

      const typed = quoteApprovalTypedData(challengeResponse, state.paymentHash);
      const recovered = await recoverTypedDataAddress({
        ...typed,
        signature: state.quoteSignature,
      });
      assert.equal(recovered, TEST_ADDRESS);

      const signedSubmit = mock.requests.filter(
        (entry) => entry.path === `/requests/${ORDER_ID}/submit` && entry.headers['payment-signature'],
      );
      assert.equal(signedSubmit.length, 1);
      assert.equal(signedSubmit[0].headers['payment-signature'], state.paymentHeader);
      assert.equal(signedSubmit[0].body.quoteSignature, state.quoteSignature);
      const quoteRequest = mock.requests.find((entry) => entry.path === '/requests/quote');
      const checkRequest = mock.requests.find((entry) => entry.path === '/requests/check');
      const fileInput = await readJobFile('examples/research-job.json');
      const submissionInput = withSubmissionAttribution(fileInput);
      assert.equal(quoteRequest.headers.authorization, `Bearer ${state.requestToken}`);
      assert.deepEqual(quoteRequest.body.input, submissionInput);
      assert.deepEqual(checkRequest.body.input, quoteRequest.body.input);
      assert.deepEqual(state.input, fileInput);
      assert.equal(state.inputHash, hashJson(fileInput));
      assert.deepEqual(state.submissionInput, submissionInput);
      assert.deepEqual(state.challenge.input, submissionInput);
      assert.equal((quoteRequest.body.input.objective.match(/via supercolony/g) ?? []).length, 1);
    } finally {
      await mock.close();
    }
  });
});

test('publish refuses blockers without quoting', async () => {
  await withHome(async (home) => {
    let quoteCalls = 0;
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, {
          action: 'job.open',
          blockers: [{ code: 'missing_plan', detail: 'say what to build' }],
          plan: [],
        });
        return;
      }
      if (record.path === '/requests/quote') {
        quoteCalls += 1;
        sendJson(response, 201, {});
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });

    try {
      const result = await runCli(
        ['task', 'publish', '--file', 'examples/research-job.json', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'blocked');
      assert.equal(output.check.blockers[0].code, 'missing_plan');
      assert.equal(quoteCalls, 0);
      const files = await readdir(join(home, 'orders'));
      const state = JSON.parse(await readFile(join(home, 'orders', files[0]), 'utf8'));
      assert.equal(state.status, 'blocked');
    } finally {
      await mock.close();
    }
  });
});

test('lost payment response resumes with the same bytes and never re-quotes', async () => {
  await withHome(async (home) => {
    let quoteCalls = 0;
    let signedSubmits = 0;
    let dropFirst = true;
    const mock = await startMock(({ request, response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [], facts: [], judged: true });
        return;
      }
      if (record.path === '/requests/quote') {
        quoteCalls += 1;
        sendJson(response, 201, { created: true, order: { id: ORDER_ID, status: 'quoted', quote: TEST_QUOTE } });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}/submit` && record.method === 'POST') {
        if (!record.headers['payment-signature']) {
          sendJson(response, 402, challenge(mock.url));
          return;
        }
        signedSubmits += 1;
        if (dropFirst) {
          dropFirst = false;
          request.socket.destroy();
          return;
        }
        sendJson(response, 202, { status: 'payment_pending' });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}` && record.method === 'GET') {
        sendJson(response, 200, {
          status: 'admitted',
          order: { id: ORDER_ID, status: 'paid', quote: TEST_QUOTE },
          payment: { status: 'confirmed', paid: true, transactionHash: TX_HASH },
          admission: {
            action: 'job.open',
            result: {
              kind: 'job',
              jobId: JOB_ID,
              statusUrl: `/jobs/${JOB_ID}`,
              resultUrl: `/jobs/${JOB_ID}/result`,
            },
          },
        });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });

    try {
      const env = { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY };
      const first = await runCli(
        ['task', 'publish', '--file', 'examples/research-job.json', '--yes', '--json'],
        env,
      );
      assert.notEqual(first.status, 0);
      assert.match(first.stderr, /resume with: colony .*order submit/);

      const files = await readdir(join(home, 'orders'));
      const stateBefore = JSON.parse(await readFile(join(home, 'orders', files[0]), 'utf8'));
      assert.equal(stateBefore.status, 'submitted');
      assert.equal(quoteCalls, 1);
      assert.equal(signedSubmits, 1);

      const resumed = await runCli(['order', 'submit', ORDER_ID, '--yes', '--json'], env);
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(resumed.stderr, '');
      const output = JSON.parse(resumed.stdout);
      assert.equal(output.status, 'admitted');
      assert.equal(output.jobId, JOB_ID);

      assert.equal(quoteCalls, 1);
      assert.equal(signedSubmits, 2);
      const signed = mock.requests.filter(
        (entry) => entry.path === `/requests/${ORDER_ID}/submit` && entry.headers['payment-signature'],
      );
      assert.equal(signed[0].headers['payment-signature'], signed[1].headers['payment-signature']);
      assert.equal(signed[0].body.quoteSignature, signed[1].body.quoteSignature);
      assert.equal(signed[1].headers['payment-signature'], stateBefore.paymentHeader);

      const stateAfter = JSON.parse(await readFile(join(home, 'orders', files[0]), 'utf8'));
      assert.equal(stateAfter.status, 'admitted');
      assert.equal(stateAfter.paymentHeader, stateBefore.paymentHeader);
      assert.equal(stateAfter.quoteSignature, stateBefore.quoteSignature);
    } finally {
      await mock.close();
    }
  });
});

test('buildPayment keeps the Permit2 deadline strictly before quote expiry', async () => {
  const account = privateKeyToAccount(TEST_KEY);
  const expiresAt = Math.floor(Date.now() / 1000) + 30;
  const paymentChallenge = {
    ...challenge('https://api.imd.test'),
    quote: { ...TEST_QUOTE, expiresAt },
  };
  const built = await buildPayment(account, paymentChallenge);
  const deadline = Number(built.payment.payload.permit2Authorization.deadline);
  assert.ok(deadline < expiresAt, `${deadline} must be before ${expiresAt}`);
  assert.equal(built.payment.accepted.maxTimeoutSeconds, paymentChallenge.accepts[0].maxTimeoutSeconds);
});

test('buildPayment stops when the quote is too close to expiry', async () => {
  const account = privateKeyToAccount(TEST_KEY);
  const paymentChallenge = {
    ...challenge('https://api.imd.test'),
    quote: { ...TEST_QUOTE, expiresAt: Math.floor(Date.now() / 1000) + 1 },
  };
  await assert.rejects(
    () => buildPayment(account, paymentChallenge),
    (error) => error.code === 'quote_expired' && /expires too soon/.test(error.message),
  );
});

test('payment summary shows network and the server-prepared input', () => {
  const prepared = { objective: 'prepared objective', skill: 'research-report', minCitations: 5 };
  const state = {
    orderId: ORDER_ID,
    quote: TEST_QUOTE,
    input: { objective: 'requested objective' },
    challenge: { ...challenge('https://api.imd.test'), input: prepared },
  };
  const text = paymentSummary(state);
  assert.match(text, /Network: eip155:1/);
  assert.match(text, /Requested objective: requested objective/);
  assert.match(text, /"objective": "prepared objective"/);
  assert.match(text, /"skill": "research-report"/);
});

test('an expired cached challenge is never signed when the fresh quote request fails', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') return sendJson(response, 200, { blockers: [] });
      return sendJson(response, 503, { error: 'quote_service_unavailable' });
    });
    try {
      const input = await readJobFile('examples/research-job.json');
      const requestKey = '33333333-3333-4333-8333-333333333333';
      const expiredQuote = { ...TEST_QUOTE, expiresAt: Math.floor(Date.now() / 1000) - 1 };
      const state = {
        version: 1,
        requestKey,
        requestToken: 'aa'.repeat(32),
        api: mock.url,
        action: 'job.open',
        input,
        inputHash: hashJson(input),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'challenged',
        orderId: ORDER_ID,
        quote: expiredQuote,
        challenge: { ...challenge(mock.url), quote: expiredQuote },
      };
      await saveOrder(home, state);

      await assert.rejects(
        () => publishJob({
          api: mock.url,
          home,
          file: 'examples/research-job.json',
          requestKey,
          yes: true,
          keyEnv: 'COLONY_PRIVATE_KEY',
        }),
        (error) => error.status === 503,
      );

      assert.equal(mock.requests.length, 2);
      const saved = JSON.parse(await readFile(join(home, 'orders', `${requestKey}.json`), 'utf8'));
      assert.equal(saved.paymentHeader, undefined);
      assert.equal(saved.challenge, undefined);
      assert.equal(saved.requestKey, requestKey);
      assert.notEqual(saved.serverRequestKey, requestKey);
      assert.equal(saved.quoteHistory[0].quote.expiresAt, expiredQuote.expiresAt);
    } finally {
      await mock.close();
    }
  });
});

test('lost quote response resumes with the same request key and token', async () => {
  await withHome(async (home) => {
    let quoteCalls = 0;
    let dropFirstQuote = true;
    let quotedInput;
    const mock = await startMock(({ request, response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [], facts: [], judged: true });
        return;
      }
      if (record.path === '/requests/quote') {
        quoteCalls += 1;
        if (dropFirstQuote) {
          dropFirstQuote = false;
          request.socket.destroy();
          return;
        }
        quotedInput = record.body.input;
        sendJson(response, 201, { created: true, order: { id: ORDER_ID, status: 'quoted', quote: TEST_QUOTE } });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}/submit` && record.method === 'POST') {
        if (!record.headers['payment-signature']) {
          sendJson(response, 402, challenge(mock.url, quotedInput));
          return;
        }
        sendJson(response, 202, { status: 'payment_pending' });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}` && record.method === 'GET') {
        sendJson(response, 200, {
          status: 'admitted',
          order: { id: ORDER_ID, status: 'paid', quote: TEST_QUOTE },
          payment: { status: 'confirmed', transactionHash: TX_HASH },
          admission: {
            action: 'job.open',
            result: {
              kind: 'job',
              jobId: JOB_ID,
              statusUrl: `/jobs/${JOB_ID}`,
              resultUrl: `/jobs/${JOB_ID}/result`,
            },
          },
        });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });

    try {
      const env = { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY };
      const first = await runCli(
        ['task', 'publish', '--file', 'examples/research-job.json', '--yes', '--json'],
        env,
      );
      assert.notEqual(first.status, 0);
      assert.match(first.stderr, /retry the same order/);
      assert.doesNotMatch(first.stderr, /without --request-key/);

      const files = await readdir(join(home, 'orders'));
      assert.equal(files.length, 1);
      const state = JSON.parse(await readFile(join(home, 'orders', files[0]), 'utf8'));
      assert.match(first.stderr, new RegExp(state.requestKey));
      assert.ok(first.stderr.includes(mock.url));

      const resumed = await runCli(
        ['task', 'publish', '--file', 'examples/research-job.json', '--request-key', state.requestKey, '--yes', '--json'],
        env,
      );
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).status, 'admitted');
      assert.equal(quoteCalls, 2);
      const quotes = mock.requests.filter((entry) => entry.path === '/requests/quote');
      const checks = mock.requests.filter((entry) => entry.path === '/requests/check');
      const submissionInput = withSubmissionAttribution(await readJobFile('examples/research-job.json'));
      assert.equal(quotes[0].headers.authorization, `Bearer ${state.requestToken}`);
      assert.equal(quotes[1].headers.authorization, `Bearer ${state.requestToken}`);
      assert.equal(quotes[0].body.requestKey, state.requestKey);
      assert.equal(quotes[1].body.requestKey, state.requestKey);
      assert.deepEqual(quotes[0].body.input, submissionInput);
      assert.deepEqual(quotes[1].body.input, submissionInput);
      assert.equal(checks.length, 2);
      for (const entry of checks) assert.deepEqual(entry.body.input, submissionInput);
      assert.equal((quotes[1].body.input.objective.match(/via supercolony/g) ?? []).length, 1);
      assert.equal((await readdir(join(home, 'orders'))).length, 1);
    } finally {
      await mock.close();
    }
  });
});
