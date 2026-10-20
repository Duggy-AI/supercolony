import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashJson } from '../src/lib/publish.mjs';
import { saveOrder } from '../src/lib/orders.mjs';
import { sendJson, startMock } from './helpers/mock-api.mjs';
import { runCli, TEST_ADDRESS } from './helpers/cli.mjs';

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'colony-natural-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('natural paid create requires a wallet before fetching the catalog or loading the model', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response }) => {
      sendJson(response, 404, { error: 'catalog unavailable' });
    });
    try {
      const result = await runCli(
        ['task', 'create', 'Build a landing page for my bakery', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Create or import a wallet/);
      assert.equal(result.stdout, '');
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });
});

test('natural paid continue requires a wallet before querying the parent', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response }) => {
      sendJson(response, 404, { error: 'parent unavailable' });
    });
    try {
      const result = await runCli(
        ['task', 'continue', '55555555-5555-4555-8555-555555555555', 'Add a claim page', '--yes', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Create or import a wallet/);
      assert.equal(result.stdout, '');
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });
});

test('explicit preset dry-run never fetches skills or loads the local model', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [] });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(
        ['task', 'create', 'Write a report', '--preset', 'report', '--dry-run', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(mock.requests.some((entry) => entry.path === '/skills'), false);
      assert.equal(mock.requests[0].path, '/requests/check');
    } finally {
      await mock.close();
    }
  });
});

test('a saved request key resumes its input without a catalog or model call', async () => {
  await withHome(async (home) => {
    const requestKey = '33333333-3333-4333-8333-333333333333';
    const input = {
      objective: 'The original saved objective',
      skill: 'research-report',
      outputs: [{ name: 'report', path: 'artifacts/report.md', mediaType: 'text/markdown' }],
      github: false,
    };
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [] });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    await saveOrder(home, {
      version: 1,
      requestKey,
      requestToken: 'aa'.repeat(32),
      api: mock.url,
      action: 'job.open',
      input,
      inputHash: hashJson(input),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'quoted',
      payer: TEST_ADDRESS,
    });
    try {
      const result = await runCli(
        ['task', 'create', 'The original saved objective', '--request-key', requestKey, '--dry-run', '--json'],
        { COLONY_HOME: home, COLONY_API_URL: mock.url, COLONY_PRIVATE_KEY: '' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(mock.requests.some((entry) => entry.path === '/skills'), false);
      const check = mock.requests.find((entry) => entry.path === '/requests/check');
      assert.deepEqual(check.body.input, input);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.input, input);
    } finally {
      await mock.close();
    }
  });
});

const SKILLS = {
  skills: [
    { id: 'research-report', role: 'implement', kind: 'code', tier: 2, requires: ['network'] },
    { id: 'build-website', role: 'implement', kind: 'code', tier: 2, requires: ['network'] },
    { id: 'create-image', role: 'implement', kind: 'code', tier: 2, requires: ['tool:image'] },
    { id: 'create-audio', role: 'implement', kind: 'code', tier: 2, requires: ['tool:audio'] },
    { id: 'create-video', role: 'implement', kind: 'code', tier: 2, requires: ['tool:video'] },
    { id: 'build-contract-project', role: 'implement', kind: 'code', tier: 1, requires: [] },
  ],
};

test('natural create assembles a public website and shows the plan on dry-run', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/skills') {
        sendJson(response, 200, SKILLS);
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [] });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(
        ['task', 'create', 'Build a landing page for my bakery', '--dry-run', '--json'],
        {
          COLONY_HOME: home,
          COLONY_API_URL: mock.url,
          COLONY_PRIVATE_KEY: '',
          COLONY_TEST_PLANNER_CHOICE: 'website',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.input, {
        objective: 'Build a landing page for my bakery',
        skill: 'build-website',
        ipfs: true,
        github: false,
      });
      assert.match(output.summary, /publicly usable/);
      assert.deepEqual(output.deliverables, [
        'A responsive website.',
        'A publicly hosted version of the site.',
      ]);
      const check = mock.requests.find((entry) => entry.path === '/requests/check');
      assert.deepEqual(check.body.input, output.input);
      assert.equal(mock.requests.some((entry) => entry.path === '/requests/quote'), false);
    } finally {
      await mock.close();
    }
  });
});

test('natural continue binds the parent and reuses its website skill', async () => {
  await withHome(async (home) => {
    const parentId = '55555555-5555-4555-8555-555555555555';
    const mock = await startMock(({ response, record }) => {
      if (record.path === `/jobs/${parentId}`) {
        sendJson(response, 200, {
          id: parentId,
          state: 'completed',
          template: 'skill:build-website',
          objective: 'Build the first version of the site.',
          project: { id: 'project-1', head: parentId },
        });
        return;
      }
      if (record.path === '/skills') {
        sendJson(response, 200, SKILLS);
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.continue', blockers: [], plan: [] });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(
        ['task', 'continue', parentId, 'Add a claim page', '--dry-run', '--json'],
        {
          COLONY_HOME: home,
          COLONY_API_URL: mock.url,
          COLONY_PRIVATE_KEY: '',
          COLONY_TEST_PLANNER_CHOICE: 'same',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.input, {
        parentJobId: parentId,
        objective: 'Add a claim page',
        skill: 'build-website',
        ipfs: true,
      });
      assert.equal(output.parent.id, parentId);
      const check = mock.requests.find((entry) => entry.path === '/requests/check');
      assert.deepEqual(check.body.input, output.input);
      assert.equal(check.body.action, 'job.continue');
    } finally {
      await mock.close();
    }
  });
});

test('a saved request key rejects a different new objective without inference', async () => {
  await withHome(async (home) => {
    const requestKey = '44444444-4444-4444-8444-444444444444';
    const input = {
      objective: 'The original saved objective',
      skill: 'research-report',
      outputs: [{ name: 'report', path: 'artifacts/report.md', mediaType: 'text/markdown' }],
      github: false,
    };
    const mock = await startMock(({ response }) => {
      sendJson(response, 500, { error: 'should not be called' });
    });
    await saveOrder(home, {
      version: 1,
      requestKey,
      requestToken: 'bb'.repeat(32),
      api: mock.url,
      action: 'job.open',
      input,
      inputHash: hashJson(input),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'quoted',
      payer: TEST_ADDRESS,
    });
    try {
      const result = await runCli(
        ['task', 'create', 'A different new objective', '--request-key', requestKey, '--dry-run', '--json'],
        {
          COLONY_HOME: home,
          COLONY_API_URL: mock.url,
          COLONY_PRIVATE_KEY: '',
          COLONY_TEST_PLANNER_CHOICE: 'website',
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /created for a different objective/);
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });
});

test('natural dry-run plain output is concise and omits the raw job body', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/skills') {
        sendJson(response, 200, SKILLS);
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, {
          action: 'job.open',
          blockers: [{ code: 'needs_detail', detail: 'say more' }],
          plan: [{ title: 'Build site', skill: 'build-website' }],
        });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(
        ['task', 'create', 'Build a landing page for my bakery', '--dry-run'],
        {
          COLONY_HOME: home,
          COLONY_API_URL: mock.url,
          COLONY_PRIVATE_KEY: '',
          COLONY_TEST_PLANNER_CHOICE: 'website',
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stdout, /summary: Build a responsive website/, result.stderr);
      assert.match(result.stdout, /A responsive website/);
      assert.match(result.stdout, /check: 1 blocker/);
      assert.match(result.stdout, /needs_detail: say more/);
      assert.doesNotMatch(result.stdout, /"skill"|input:/);
    } finally {
      await mock.close();
    }
  });
});

test('natural answers are passed through to the IMD input after the original objective', async () => {
  await withHome(async (home) => {
    const mock = await startMock(({ response, record }) => {
      if (record.path === '/skills') {
        sendJson(response, 200, SKILLS);
        return;
      }
      if (record.path === '/requests/check') {
        sendJson(response, 200, { action: 'job.open', blockers: [], plan: [] });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    });
    try {
      const result = await runCli(
        [
          'task',
          'create',
          'Build a landing page',
          '--answer',
          'It is for a bakery in Lisbon.',
          '--dry-run',
          '--json',
        ],
        {
          COLONY_HOME: home,
          COLONY_API_URL: mock.url,
          COLONY_PRIVATE_KEY: '',
          COLONY_TEST_PLANNER_CHOICE: 'website',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.input.objective.startsWith('Build a landing page'), true);
      assert.match(output.input.objective, /Clarifications:/);
      assert.match(output.input.objective, /bakery in Lisbon/);
      const check = mock.requests.find((entry) => entry.path === '/requests/check');
      assert.equal(check.body.input.objective, output.input.objective);
    } finally {
      await mock.close();
    }
  });
});
