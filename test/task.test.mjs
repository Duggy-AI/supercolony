import assert from 'node:assert/strict';
import test from 'node:test';
import { sendJson, startMock } from './helpers/mock-api.mjs';
import { runCli } from './helpers/cli.mjs';

const JOB_ID = '44444444-4444-4444-8444-444444444444';

const JOB = {
  id: JOB_ID,
  state: 'completed',
  template: 'skill:research-report',
  objective: 'Write a report',
  blockedReason: null,
  delivery: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:05:00.000Z',
  project: null,
};

test('task list forwards filters, reads anonymously and prints JSON', async () => {
  const mock = await startMock(({ response, record }) => {
    if (record.path === '/jobs') {
      sendJson(response, 200, { count: 1, jobs: [JOB] });
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });

  try {
    const result = await runCli([
      'task', 'list',
      '--q', 'report',
      '--before', '2026-10-17T10:00:00Z',
      '--limit', '2',
      '--since', '2026-10-16T00:00:00Z',
      '--exclude-oracle',
      '--json',
    ], { COLONY_API_URL: mock.url });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.count, 1);
    assert.equal(output.jobs[0].id, JOB_ID);

    const request = mock.requests[0];
    assert.equal(request.path, '/jobs');
    assert.equal(request.query.get('q'), 'report');
    assert.equal(request.query.get('before'), '2026-10-17T10:00:00Z');
    assert.equal(request.query.get('limit'), '2');
    assert.equal(request.query.get('since'), '2026-10-16T00:00:00Z');
    assert.equal(request.query.get('exclude'), 'oracle');
    assert.equal(request.headers.authorization, undefined);
  } finally {
    await mock.close();
  }
});

test('task list prints readable text without JSON', async () => {
  const mock = await startMock(({ response }) => sendJson(response, 200, { count: 1, jobs: [JOB] }));
  try {
    const result = await runCli(['task', 'list', '--limit', '1'], { COLONY_API_URL: mock.url });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, new RegExp(JOB_ID));
    assert.match(result.stdout, /completed/);
  } finally {
    await mock.close();
  }
});

test('task show and result use the job endpoints', async () => {
  const mock = await startMock(({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}`) {
      sendJson(response, 200, { ...JOB, nodes: [], reviews: [] });
      return;
    }
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, {
        jobId: JOB_ID,
        state: 'completed',
        complete: true,
        source: [],
        files: [{
          path: 'artifacts/report.md',
          bytes: 10,
          mediaType: 'text/markdown',
          hash: 'ab'.repeat(32),
          url: 'https://api.imd.fun/artifacts/ab',
        }],
        delivery: { requested: false },
      });
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });

  try {
    const show = await runCli(['task', 'show', JOB_ID, '--json'], { COLONY_API_URL: mock.url });
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).id, JOB_ID);

    const result = await runCli(['task', 'result', JOB_ID], { COLONY_API_URL: mock.url });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /artifacts\/report\.md/);
    assert.match(result.stdout, /complete:  true/);
  } finally {
    await mock.close();
  }
});

test('task list rejects an invalid limit before calling the API', async () => {
  const result = await runCli(['task', 'list', '--limit', '0', '--json'], { COLONY_API_URL: 'http://127.0.0.1:1' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--limit must be an integer from 1 to 500/);
});

test('task list reports HTTP errors on stderr with a non-zero exit', async () => {
  const mock = await startMock(({ response }) => sendJson(response, 503, { error: 'unavailable', detail: 'try later' }));
  try {
    const result = await runCli(['task', 'list', '--json'], { COLONY_API_URL: mock.url });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /HTTP 503 unavailable: try later/);
  } finally {
    await mock.close();
  }
});
