import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashJson } from '../src/lib/publish.mjs';
import { saveOrder } from '../src/lib/orders.mjs';
import { startPreparedPaymentMock as startMock } from "./helpers/prepared-payment-api.mjs";
import { sendJson } from './helpers/mock-api.mjs';
import { runCli, TEST_ADDRESS, TEST_KEY } from './helpers/cli.mjs';
import { withSubmissionAttribution } from '../src/lib/submission-attribution.mjs';

const PARENT_ID = '55555555-5555-4555-8555-555555555555';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_HASH = 'ab'.repeat(32);
const INPUT_HASH = 'cd'.repeat(32);
const RESOURCE_HASH = '11'.repeat(32);
const TX_HASH = `0x${'33'.repeat(32)}`;
const OTHER_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const TEST_KEY2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

function quote(action = 'job.continue') {
  return {
    v: 1,
    id: ORDER_ID,
    action,
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

function challenge(api, input, quoteValue = quote()) {
  const resourceUrl = `${api}/requests/${ORDER_ID}/submit`;
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: 'job.continue', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:1',
      asset: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
      amount: '500000000000000000',
      payTo: '0x4e0fa57bde726079356537e2f34d671e9f41adbc',
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: 'permit2' },
    }],
    quote: quoteValue,
    requesterScopeHash: RESOURCE_HASH,
    resourceUrl,
    input,
  };
}

function parentJob() {
  return {
    id: PARENT_ID,
    state: 'completed',
    template: 'skill:research-report',
    objective: 'Write the first report',
    paidBy: TEST_ADDRESS,
    parentJobId: null,
    project: {
      id: 'project-1',
      head: PARENT_ID,
      running: null,
      versions: [{
        jobId: PARENT_ID,
        workflowId: null,
        objective: 'Write the first report',
        state: 'completed',
        createdAt: '2026-10-17T10:00:00.000Z',
      }],
    },
  };
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'colony-continue-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('task continue --dry-run needs no wallet and does not guess an inherited skill', async () => {
  await withHome(async (home) => {
    let quoteCalls = 0;
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/jobs/${PARENT_ID}`) {
        sendJson(response, 200, parentJob());
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, {
          action: 'job.continue',
          blockers: [],
          plan: [],
          owner: TEST_ADDRESS,
          project: { summary: 'The first report project', next: [] },
        });
        return;
      }
      if (record.path === '/requests/quote') quoteCalls += 1;
      sendJson(response, 404, { error: 'not_found' });
    });

    try {
      const file = join(home, 'continue.json');
      await writeFile(file, JSON.stringify({ parentJobId: PARENT_ID, objective: 'Add a claim page' }));
      const first = await runCli(
        ['task', 'continue', PARENT_ID, '--file', file, '--dry-run', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stderr, '');
      const firstOutput = JSON.parse(first.stdout);
      assert.equal(firstOutput.action, 'job.continue');
      assert.deepEqual(firstOutput.input, {
        parentJobId: PARENT_ID,
        objective: 'Add a claim page',
      });
      assert.equal(firstOutput.parent.id, PARENT_ID);
      assert.equal(firstOutput.parent.project.id, 'project-1');
      assert.equal(firstOutput.check.project.summary, 'The first report project');
      assert.equal(quoteCalls, 0);

      const checkRequest = mock.requests.find((entry) => entry.path === '/requests/check');
      assert.equal(checkRequest.body.action, 'job.continue');
      assert.equal(checkRequest.body.input.parentJobId, PARENT_ID);
      assert.equal('skill' in checkRequest.body.input, false);

      const second = await runCli(
        ['task', 'continue', PARENT_ID, 'Add a claim page', '--skill', 'build-website', '--path', 'src', '--dry-run', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(second.status, 0, second.stderr);
      const secondOutput = JSON.parse(second.stdout);
      assert.deepEqual(secondOutput.input, {
        parentJobId: PARENT_ID,
        objective: 'Add a claim page',
        skill: 'build-website',
        paths: ['src'],
      });
      assert.deepEqual(await readdir(home).catch(() => []), ['continue.json']);
    } finally {
      await mock.close();
    }
  });
});

test('task continue rejects an empty objective without --file before the API', async () => {
  const result = await runCli(
    ['task', 'continue', PARENT_ID, '--dry-run', '--json'],
    { COLONY_API_URL: 'http://127.0.0.1:1' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires an objective or --file/);
});

test('task check detects parentJobId as job.continue', async () => {
  await withHome(async (home) => {
    const file = join(home, 'continue.json');
    await writeFile(file, JSON.stringify({ parentJobId: PARENT_ID, objective: 'Add a page' }));
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.continue', blockers: [], plan: [] });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(['task', 'check', '--file', file, '--json'], { COLONY_API_URL: mock.url });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(mock.requests[0].body.action, 'job.continue');
    } finally {
      await mock.close();
    }
  });
});

test('task continue checks, quotes and submits with action job.continue', async () => {
  await withHome(async (home) => {
    const input = { parentJobId: PARENT_ID, objective: 'Add a claim page', skill: 'build-website' };
    const submissionInput = withSubmissionAttribution(input);
    const quoteValue = quote('job.continue');
    let quotedInput;
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/jobs/${PARENT_ID}`) {
        sendJson(response, 200, parentJob());
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, {
          action: 'job.continue',
          blockers: [],
          plan: [],
          owner: TEST_ADDRESS,
          project: { summary: 'The first report project', next: [] },
        });
        return;
      }
      if (record.path === '/requests/quote') {
        quotedInput = record.body.input;
        sendJson(response, 201, { created: true, order: { id: ORDER_ID, status: 'quoted', quote: quoteValue } });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}/submit` && record.method === 'POST') {
        if (!record.headers['payment-signature']) {
          sendJson(response, 402, challenge(mock.url, quotedInput, quoteValue));
          return;
        }
        sendJson(response, 202, { status: 'payment_pending' });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}` && record.method === 'GET') {
        sendJson(response, 200, {
          status: 'admitted',
          payment: { status: 'confirmed', transactionHash: TX_HASH },
          admission: {
            action: 'job.continue',
            result: {
              kind: 'job',
              jobId: JOB_ID,
              continues: PARENT_ID,
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
      const result = await runCli(
        ['task', 'continue', PARENT_ID, 'Add a claim page', '--skill', 'build-website', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'admitted');
      assert.equal(output.action, 'job.continue');
      assert.equal(output.parentJobId, PARENT_ID);
      assert.equal(output.parent.id, PARENT_ID);
      assert.equal(output.payer, TEST_ADDRESS);

      const check = mock.requests.find((entry) => entry.path === '/requests/check');
      const quoteRequest = mock.requests.find((entry) => entry.path === '/requests/quote');
      assert.equal(check.body.action, 'job.continue');
      assert.equal(quoteRequest.body.action, 'job.continue');
      assert.deepEqual(quoteRequest.body.input, submissionInput);
      assert.deepEqual(check.body.input, quoteRequest.body.input);

      const [file] = await readdir(join(home, 'orders'));
      const state = JSON.parse(await readFile(join(home, 'orders', file), 'utf8'));
      assert.equal(state.action, 'job.continue');
      assert.equal(state.status, 'admitted');
      assert.equal(state.payer, TEST_ADDRESS);
      assert.equal(state.owner, TEST_ADDRESS);
      assert.deepEqual(state.input, input);
      assert.equal(state.inputHash, hashJson(input));
      assert.deepEqual(state.submissionInput, submissionInput);
      assert.deepEqual(state.challenge.input, submissionInput);
    } finally {
      await mock.close();
    }
  });
});

test('task continue stops on owner mismatch before quote or signature', async () => {
  await withHome(async (home) => {
    let quoteCalls = 0;
    let submitCalls = 0;
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/jobs/${PARENT_ID}`) {
        sendJson(response, 200, parentJob());
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, {
          action: 'job.continue',
          blockers: [],
          plan: [],
          owner: OTHER_ADDRESS,
          project: { summary: 'The first report project' },
        });
        return;
      }
      if (record.path === '/requests/quote') {
        quoteCalls += 1;
        sendJson(response, 201, {});
        return;
      }
      if (record.path === `/requests/${ORDER_ID}/submit`) submitCalls += 1;
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(
        ['task', 'continue', PARENT_ID, 'Add a claim page', '--skill', 'build-website', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not the project owner/);
      assert.equal(quoteCalls, 0);
      assert.equal(submitCalls, 0);
      const files = await readdir(join(home, 'orders'));
      const state = JSON.parse(await readFile(join(home, 'orders', files[0]), 'utf8'));
      assert.equal(state.paymentHeader, undefined);
      assert.equal(state.payer, undefined);
    } finally {
      await mock.close();
    }
  });
});

test('a quoted continuation resumed with another wallet is refused without signing', async () => {
  await withHome(async (home) => {
    const requestKey = '33333333-3333-4333-8333-333333333333';
    const input = { parentJobId: PARENT_ID, objective: 'Add a claim page', skill: 'build-website' };
    const quoteValue = quote('job.continue');
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/jobs/${PARENT_ID}`) {
        sendJson(response, 200, parentJob());
        return;
      }
      if (record.path === `/requests/${ORDER_ID}/submit`) {
        sendJson(response, 500, { error: 'must not submit' });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      await saveOrder(home, {
        version: 1,
        requestKey,
        requestToken: 'aa'.repeat(32),
        api: mock.url,
        action: 'job.continue',
        input,
        inputHash: hashJson(input),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'quoted',
        orderId: ORDER_ID,
        quote: quoteValue,
        challenge: challenge(mock.url, input, quoteValue),
        owner: TEST_ADDRESS,
        check: { owner: TEST_ADDRESS },
      });

      const result = await runCli(
        ['task', 'continue', PARENT_ID, 'Add a claim page', '--skill', 'build-website', '--request-key', requestKey, '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY2 },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not the project owner/);
      assert.equal(
        mock.requests.some((entry) => entry.path.includes('/submit')),
        false,
      );
      const state = JSON.parse(await readFile(join(home, 'orders', `${requestKey}.json`), 'utf8'));
      assert.equal(state.paymentHeader, undefined);
      assert.equal(state.quoteSignature, undefined);
      assert.equal(state.payer, undefined);
    } finally {
      await mock.close();
    }
  });
});

test('a request key from another action is rejected before check or quote', async () => {
  await withHome(async (home) => {
    const requestKey = '44444444-4444-4444-8444-444444444444';
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/jobs/${PARENT_ID}`) {
        sendJson(response, 200, parentJob());
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      await saveOrder(home, {
        version: 1,
        requestKey,
        requestToken: 'bb'.repeat(32),
        api: mock.url,
        action: 'job.open',
        input: { objective: 'original' },
        inputHash: hashJson({ objective: 'original' }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'created',
      });

      const result = await runCli(
        ['task', 'continue', PARENT_ID, 'Add a claim page', '--request-key', requestKey, '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /created for action job\.open, not job\.continue/);
      assert.equal(
        mock.requests.some((entry) => entry.path === '/requests/check' || entry.path === '/requests/quote'),
        false,
      );
    } finally {
      await mock.close();
    }
  });
});

test('task continue --dry-run exits 1 on blockers and still prints the full check', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/jobs/${PARENT_ID}`) {
        sendJson(response, 200, parentJob());
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, {
          action: 'job.continue',
          blockers: [{ code: 'invalid_parent', detail: 'the project is still running' }],
          plan: [],
          project: { summary: 'The first report project' },
        });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const file = join(home, 'continue.json');
      await writeFile(file, JSON.stringify({ parentJobId: PARENT_ID, objective: 'Add a claim page' }));
      const result = await runCli(
        ['task', 'continue', PARENT_ID, '--file', file, '--dry-run', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.input.parentJobId, PARENT_ID);
      assert.equal(output.input.objective, 'Add a claim page');
      assert.equal(output.check.blockers[0].code, 'invalid_parent');
      assert.equal(output.check.project.summary, 'The first report project');
    } finally {
      await mock.close();
    }
  });
});

test('task continue resumes a lost quote with the hint and no objective arguments', async () => {
  await withHome(async (home) => {
    let quoteCalls = 0;
    let dropFirst = true;
    const expectedInput = {
      parentJobId: PARENT_ID,
      objective: 'Add a claim page',
      skill: 'build-website',
    };
    const submissionInput = withSubmissionAttribution(expectedInput);
    const quoteValue = quote('job.continue');
    let quotedInput;
    const mock = await startMock(({ request, response, record }) => {
      if (record.path === `/jobs/${PARENT_ID}`) {
        sendJson(response, 200, parentJob());
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, {
          action: 'job.continue',
          blockers: [],
          plan: [],
          owner: TEST_ADDRESS,
          project: { summary: 'The first report project' },
        });
        return;
      }
      if (record.path === '/requests/quote') {
        quoteCalls += 1;
        if (dropFirst) {
          dropFirst = false;
          request.socket.destroy();
          return;
        }
        quotedInput = record.body.input;
        sendJson(response, 201, { created: true, order: { id: ORDER_ID, status: 'quoted', quote: quoteValue } });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}/submit` && record.method === 'POST') {
        if (!record.headers['payment-signature']) {
          sendJson(response, 402, challenge(mock.url, quotedInput, quoteValue));
          return;
        }
        sendJson(response, 202, { status: 'payment_pending' });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}` && record.method === 'GET') {
        sendJson(response, 200, {
          status: 'admitted',
          payment: { status: 'confirmed', transactionHash: TX_HASH },
          admission: {
            action: 'job.continue',
            result: {
              kind: 'job',
              jobId: JOB_ID,
              continues: PARENT_ID,
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
        ['task', 'continue', PARENT_ID, 'Add a claim page', '--skill', 'build-website', '--yes', '--json'],
        env,
      );
      assert.equal(first.status, 1);
      const hint = first.stderr.match(new RegExp(`task continue ${PARENT_ID} --request-key ([0-9a-f-]{36})`));
      assert.ok(hint, first.stderr);
      assert.equal(quoteCalls, 1);

      const resumed = await runCli(
        ['task', 'continue', PARENT_ID, '--request-key', hint[1], '--yes', '--json'],
        env,
      );
      assert.equal(resumed.status, 0, resumed.stderr);
      const output = JSON.parse(resumed.stdout);
      assert.equal(output.status, 'admitted');
      assert.equal(output.action, 'job.continue');
      assert.equal(quoteCalls, 2);
      const quotes = mock.requests.filter((entry) => entry.path === '/requests/quote');
      const checks = mock.requests.filter((entry) => entry.path === '/requests/check');
      assert.equal(quotes[0].body.requestKey, hint[1]);
      assert.equal(quotes[1].body.requestKey, hint[1]);
      assert.equal(quotes[0].headers.authorization, quotes[1].headers.authorization);
      assert.deepEqual(quotes[0].body.input, submissionInput);
      assert.deepEqual(quotes[1].body.input, submissionInput);
      assert.equal(checks.length, 2);
      for (const entry of checks) assert.deepEqual(entry.body.input, submissionInput);
      assert.equal((quotes[1].body.input.objective.match(/via supercolony/g) ?? []).length, 1);
    } finally {
      await mock.close();
    }
  });
});

test('a continuation quote or challenge with the wrong action is never signed', async () => {
  await withHome(async (home) => {
    const expectedInput = {
      parentJobId: PARENT_ID,
      objective: 'Add a claim page',
      skill: 'build-website',
    };
    const wrongQuote = quote('job.open');
    let quoteCalls = 0;
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/jobs/${PARENT_ID}`) {
        sendJson(response, 200, parentJob());
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, {
          action: 'job.continue',
          blockers: [],
          plan: [],
          owner: TEST_ADDRESS,
          project: { summary: 'The first report project' },
        });
        return;
      }
      if (record.path === '/requests/quote') {
        quoteCalls += 1;
        sendJson(response, 201, { created: true, order: { id: ORDER_ID, status: 'quoted', quote: wrongQuote } });
        return;
      }
      if (record.path === `/requests/${ORDER_ID}/submit` && record.method === 'POST') {
        sendJson(response, 402, challenge(mock.url, expectedInput, wrongQuote));
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });

    try {
      const result = await runCli(
        ['task', 'continue', PARENT_ID, 'Add a claim page', '--skill', 'build-website', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /saved quote action job\.open does not match job\.continue/);
      assert.equal(quoteCalls, 1);
      assert.equal(
        mock.requests.some((entry) => entry.path === `/requests/${ORDER_ID}/submit` && entry.headers['payment-signature']),
        false,
      );
      const [file] = await readdir(join(home, 'orders'));
      const state = JSON.parse(await readFile(join(home, 'orders', file), 'utf8'));
      assert.equal(state.action, 'job.continue');
      assert.equal(state.quote.action, 'job.open');
      assert.equal(state.paymentHeader, undefined);
      assert.equal(state.quoteSignature, undefined);
    } finally {
      await mock.close();
    }
  });
});
