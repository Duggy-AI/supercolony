import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startPreparedPaymentMock as startMock } from "./helpers/prepared-payment-api.mjs";
import { sendJson } from './helpers/mock-api.mjs';
import { runCli, TEST_ADDRESS, TEST_KEY } from './helpers/cli.mjs';
import { withSubmissionAttribution } from '../src/lib/submission-attribution.mjs';
import { hashJson } from '../src/lib/publish.mjs';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_HASH = 'ab'.repeat(32);
const INPUT_HASH = 'cd'.repeat(32);
const RESOURCE_HASH = '11'.repeat(32);
const TX_HASH = `0x${'33'.repeat(32)}`;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function quote(action = 'job.open') {
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

function challenge(api, input) {
  const resourceUrl = `${api}/requests/${ORDER_ID}/submit`;
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: 'job', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:1',
      asset: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
      amount: '500000000000000000',
      payTo: '0x4e0fa57bde726079356537e2f34d671e9f41adbc',
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: 'permit2' },
    }],
    quote: quote('job.open'),
    requesterScopeHash: RESOURCE_HASH,
    resourceUrl,
    input: input ?? { objective: 'prepared' },
  };
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'colony-create-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('task create --preset report --dry-run checks free and needs no wallet', async () => {
  await withHome(async (home) => {
    let quoteCalls = 0;
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [], facts: [], judged: true });
        return;
      }
      if (record.path === '/requests/quote') quoteCalls += 1;
      sendJson(response, 404, { error: 'not_found' });
    });

    try {
      const result = await runCli(
        ['task', 'create', 'Write a sourced report', '--preset', 'report', '--dry-run', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.equal(output.action, 'job.open');
      assert.deepEqual(output.input, {
        objective: 'Write a sourced report',
        skill: 'research-report',
        outputs: [{ name: 'report', path: 'artifacts/report.md', mediaType: 'text/markdown' }],
        github: false,
      });
      assert.deepEqual(output.check.blockers, []);
      assert.equal(quoteCalls, 0);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].body.action, 'job.open');
      assert.deepEqual(mock.requests[0].body.input, output.input);
      assert.deepEqual(await readdir(home).catch(() => []), []);
    } finally {
      await mock.close();
    }
  });
});

test('task create maps explicit skill, paths, repository pair and github', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [] });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli([
        'task', 'create', 'Build a site',
        '--skill', 'build-website',
        '--path', 'src', '--path', 'test',
        '--repo', 'https://github.com/owner/repo',
        '--commit', COMMIT,
        '--github',
        '--dry-run',
        '--json',
      ], { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.input, {
        objective: 'Build a site',
        skill: 'build-website',
        paths: ['src', 'test'],
        repoUrl: 'https://github.com/owner/repo',
        baseCommit: COMMIT,
        github: true,
      });
    } finally {
      await mock.close();
    }
  });
});

test('task create rejects bad selectors before the API', async () => {
  const base = ['task', 'create', 'Build something', '--dry-run', '--json'];
  for (const [args, pattern] of [
    [['--skill', 'build-website', '--repo', 'https://github.com/owner/repo'], /--repo and --commit must be given together/],
    [['--skill', 'build-website', '--template', 'research'], /choose one of --preset, --skill or --template/],
    [['--skill', 'build-website', '--preset', 'report'], /choose one of --preset, --skill or --template/],
    [['--preset', 'unknown'], /unknown preset: unknown/],
  ]) {
    const result = await runCli([...base, ...args], { COLONY_API_URL: 'http://127.0.0.1:1' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, pattern);
  }
});

test('task create --file rejects parentJobId and points at task continue', async () => {
  await withHome(async (home) => {
    const file = join(home, 'continue.json');
    await writeFile(file, JSON.stringify({ parentJobId: 'parent-1', objective: 'more' }));
    const result = await runCli(
      ['task', 'create', '--file', file, '--dry-run', '--json'],
      { COLONY_API_URL: 'http://127.0.0.1:1' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /parentJobId.*task continue/);
  });
});

test('task create --save never overwrites while dry-run still saves the prepared input', async () => {
  await withHome(async (home) => {
    const save = join(home, 'job.json');
    let checkCalls = 0;
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        checkCalls += 1;
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [] });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const args = ['task', 'create', 'Write a report', '--preset', 'report', '--dry-run', '--save', save, '--json'];
      const first = await runCli(args, { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' });
      assert.equal(first.status, 0, first.stderr);
      assert.equal(checkCalls, 1);
      const saved = JSON.parse(await readFile(save, 'utf8'));
      assert.equal(saved.skill, 'research-report');
      assert.equal(saved.github, false);

      const second = await runCli(args, { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' });
      assert.equal(second.status, 1);
      assert.match(second.stderr, /refusing to overwrite existing file/);
      assert.equal(checkCalls, 1);
    } finally {
      await mock.close();
    }
  });
});

test('task create checks, quotes and submits with action job.open', async () => {
  await withHome(async (home) => {
    let quotedInput;
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [], facts: [], judged: true });
        return;
      }
      if (record.path === '/requests/quote') {
        quotedInput = record.body.input;
        sendJson(response, 201, { created: true, order: { id: ORDER_ID, status: 'quoted', quote: quote('job.open') } });
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
      const result = await runCli(
        ['task', 'create', 'Write a sourced report', '--preset', 'report', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'admitted');
      assert.equal(output.action, 'job.open');
      assert.equal(output.jobId, JOB_ID);
      assert.equal(output.taskUrl, 'https://explorer.imd.fun/jobs/' + JOB_ID);
      assert.equal(output.payer, TEST_ADDRESS);

      const check = mock.requests.find((entry) => entry.path === '/requests/check');
      const quoteRequest = mock.requests.find((entry) => entry.path === '/requests/quote');
      assert.equal(check.body.action, 'job.open');
      assert.equal(quoteRequest.body.action, 'job.open');
      assert.equal(quoteRequest.body.input.skill, 'research-report');
      assert.equal(quoteRequest.body.input.objective, 'Write a sourced report\nvia supercolony');
      assert.deepEqual(check.body.input, quoteRequest.body.input);

      const [file] = await readdir(join(home, 'orders'));
      const state = JSON.parse(await readFile(join(home, 'orders', file), 'utf8'));
      assert.equal(state.action, 'job.open');
      assert.equal(state.status, 'admitted');
      assert.equal(state.payer, TEST_ADDRESS);
      assert.equal(state.input.objective, 'Write a sourced report');
      assert.equal(state.inputHash, hashJson(state.input));
      assert.deepEqual(state.submissionInput, quoteRequest.body.input);
      assert.deepEqual(state.challenge.input, quoteRequest.body.input);
    } finally {
      await mock.close();
    }
  });
});

test('task create reports check blockers without quoting', async () => {
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
      if (record.path === '/requests/quote') quoteCalls += 1;
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(
        ['task', 'create', 'Write a report', '--preset', 'report', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: TEST_KEY },
      );
      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'blocked');
      assert.equal(output.action, 'job.open');
      assert.equal(output.check.blockers[0].code, 'missing_plan');
      assert.equal(quoteCalls, 0);
    } finally {
      await mock.close();
    }
  });
});

test('task create --dry-run exits 1 on blockers and still prints the full check', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, {
          action: 'job.open',
          blockers: [{ code: 'missing_plan', detail: 'say what to build' }],
          plan: [{ title: 'Research', skill: 'research-report' }],
        });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(
        ['task', 'create', 'Write a report', '--preset', 'report', '--dry-run', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.input.skill, 'research-report');
      assert.equal(output.check.blockers[0].code, 'missing_plan');
      assert.equal(output.check.plan[0].skill, 'research-report');
    } finally {
      await mock.close();
    }
  });
});

test('task create resumes a lost quote with the hint and no input file', async () => {
  await withHome(async (home) => {
    let quoteCalls = 0;
    let dropFirst = true;
    const expectedInput = {
      objective: 'Write a sourced report',
      skill: 'research-report',
      outputs: [{ name: 'report', path: 'artifacts/report.md', mediaType: 'text/markdown' }],
      github: false,
    };
    const submittedInput = withSubmissionAttribution(expectedInput);
    let quotedInput;
    const mock = await startMock(({ request, response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [] });
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
        sendJson(response, 201, { created: true, order: { id: ORDER_ID, status: 'quoted', quote: quote('job.open') } });
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
        ['task', 'create', 'Write a sourced report', '--preset', 'report', '--yes', '--json'],
        env,
      );
      assert.equal(first.status, 1);
      const hint = first.stderr.match(/task create --request-key ([0-9a-f-]{36})/);
      assert.ok(hint, first.stderr);
      assert.doesNotMatch(first.stderr, /saved-input\.json/);
      assert.equal(quoteCalls, 1);

      const resumed = await runCli(['task', 'create', '--request-key', hint[1], '--yes', '--json'], env);
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).status, 'admitted');
      assert.equal(quoteCalls, 2);
      const quotes = mock.requests.filter((entry) => entry.path === '/requests/quote');
      const checks = mock.requests.filter((entry) => entry.path === '/requests/check');
      assert.equal(quotes[0].body.requestKey, hint[1]);
      assert.equal(quotes[1].body.requestKey, hint[1]);
      assert.equal(quotes[0].headers.authorization, quotes[1].headers.authorization);
      assert.deepEqual(quotes[0].body.input, submittedInput);
      assert.deepEqual(quotes[1].body.input, submittedInput);
      assert.equal(checks.length, 2);
      for (const entry of checks) assert.deepEqual(entry.body.input, submittedInput);
      assert.equal((quotes[1].body.input.objective.match(/via supercolony/g) ?? []).length, 1);
    } finally {
      await mock.close();
    }
  });
});
