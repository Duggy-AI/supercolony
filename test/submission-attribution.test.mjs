import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashJson, publishJob } from '../src/lib/publish.mjs';
import { saveOrder } from '../src/lib/orders.mjs';
import { SUBMISSION_ATTRIBUTION, withSubmissionAttribution } from '../src/lib/submission-attribution.mjs';
import { startPreparedPaymentMock as startMock } from './helpers/prepared-payment-api.mjs';
import { sendJson } from './helpers/mock-api.mjs';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_KEY = '33333333-3333-4333-8333-333333333333';

function quote() {
  return {
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
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'colony-attribution-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function quoteThenFail(home, options) {
  let checkInput;
  let quoteInput;
  const mock = await startMock(({ response, record }) => {
    if (record.path === '/requests/check') {
      checkInput = record.body.input;
      return sendJson(response, 200, { action: 'job.open', blockers: [], plan: [] });
    }
    if (record.path === '/requests/quote') {
      quoteInput = record.body.input;
      return sendJson(response, 201, { order: { id: ORDER_ID, status: 'quoted', quote: quote() } });
    }
    if (record.path === `/requests/${ORDER_ID}/submit`) {
      return sendJson(response, 503, { error: 'quote_service_unavailable' });
    }
    return sendJson(response, 404, { error: 'not_found' });
  });
  try {
    await assert.rejects(
      () => publishJob({ api: mock.url, home, ...options, yes: true }),
      (error) => error.status === 503,
    );
    return { checkInput, quoteInput };
  } finally {
    await mock.close();
  }
}

test('submission attribution appends once without mutating the original input', () => {
  const input = { objective: 'Write a report\n', skill: 'research-report' };
  const submitted = withSubmissionAttribution(input);
  assert.notEqual(submitted, input);
  assert.equal(input.objective, 'Write a report\n');
  assert.equal(submitted.objective, 'Write a report\nvia supercolony');
  assert.equal(withSubmissionAttribution(submitted), submitted);
  assert.deepEqual(withSubmissionAttribution(submitted), submitted);
  const twice = withSubmissionAttribution(withSubmissionAttribution(input));
  assert.equal((twice.objective.match(/via supercolony/g) ?? []).length, 1);

  const already = { objective: `Write a report\n${SUBMISSION_ATTRIBUTION}` };
  assert.equal(withSubmissionAttribution(already), already);

  for (const objective of [undefined, null, 42, '', '   ']) {
    const malformed = { objective };
    assert.equal(withSubmissionAttribution(malformed), malformed);
  }
});

test('an objective that already has the attribution is submitted unchanged instead of duplicated', async () => {
  await withHome(async (home) => {
    const input = { objective: `Write a report\n${SUBMISSION_ATTRIBUTION}`, skill: 'research-report' };
    const { checkInput, quoteInput } = await quoteThenFail(home, { input, action: 'job.open' });

    assert.deepEqual(checkInput, input);
    assert.deepEqual(quoteInput, input);
    assert.equal((quoteInput.objective.match(/via supercolony/g) ?? []).length, 1);

    const [file] = await readdir(join(home, 'orders'));
    const state = JSON.parse(await readFile(join(home, 'orders', file), 'utf8'));
    assert.deepEqual(state.input, input);
    assert.deepEqual(state.submissionInput, input);
    assert.equal(state.inputHash, hashJson(input));
  });
});

test('a legacy saved order without submissionInput keeps its original input and adds no footer', async () => {
  await withHome(async (home) => {
    const input = { objective: 'Legacy objective', skill: 'research-report' };
    const legacy = {
      version: 1,
      requestKey: REQUEST_KEY,
      requestToken: 'aa'.repeat(32),
      api: null,
      action: 'job.open',
      input,
      inputHash: hashJson(input),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'created',
      paymentChain: 'ethereum',
      payWith: 'IMD',
    };
    // The legacy state predates submissionInput and is resumed by request key.
    const mockHome = home;
    let checkInput;
    let quoteInput;
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        checkInput = record.body.input;
        return sendJson(response, 200, { action: 'job.open', blockers: [], plan: [] });
      }
      if (record.path === '/requests/quote') {
        quoteInput = record.body.input;
        return sendJson(response, 201, { order: { id: ORDER_ID, status: 'quoted', quote: quote() } });
      }
      if (record.path === `/requests/${ORDER_ID}/submit`) {
        return sendJson(response, 503, { error: 'quote_service_unavailable' });
      }
      return sendJson(response, 404, { error: 'not_found' });
    });
    try {
      legacy.api = mock.url;
      await saveOrder(mockHome, legacy);
      await assert.rejects(
        () => publishJob({ api: mock.url, home: mockHome, requestKey: REQUEST_KEY, input, action: 'job.open', yes: true }),
        (error) => error.status === 503,
      );
      assert.deepEqual(checkInput, input);
      assert.deepEqual(quoteInput, input);
      assert.equal(quoteInput.objective.includes(SUBMISSION_ATTRIBUTION), false);

      const state = JSON.parse(await readFile(join(mockHome, 'orders', `${REQUEST_KEY}.json`), 'utf8'));
      assert.deepEqual(state.input, input);
      assert.equal(state.inputHash, hashJson(input));
      assert.equal(state.submissionInput, undefined);
    } finally {
      await mock.close();
    }
  });
});
