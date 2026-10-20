import assert from 'node:assert/strict';
import test from 'node:test';
import { startMock, sendJson } from './helpers/mock-api.mjs';
import { runCli } from './helpers/cli.mjs';

// Capture subprocess output; never send these sequences to a real terminal.
const clipboard = '\x1b]52;c;YXR0YWNrZXI=\x07';
const erase = '\x1b[2J\x1b[H';

test('remote task text cannot issue terminal commands; JSON preserves the original data', async () => {
  const objective = `Read this ${clipboard}${erase}task`;
  const mock = await startMock(({ response }) => sendJson(response, 200, {
    count: 1, jobs: [{ id: 'public-job', state: 'completed', objective }],
  }));
  try {
    const env = { COLONY_API_URL: mock.url };
    const plain = await runCli(['task', 'list'], env);
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /[\x1b\x07]/);
    assert.match(plain.stdout, /Read this task/);
    const json = await runCli(['task', 'list', '--json'], env);
    assert.equal(JSON.parse(json.stdout).jobs[0].objective, objective);
  } finally { await mock.close(); }
});

test('remote error messages cannot issue terminal commands', async () => {
  const mock = await startMock(({ response }) => sendJson(response, 400, {
    error: 'bad_request', detail: `${clipboard}${erase}Untrusted error`,
  }));
  try {
    const result = await runCli(['task', 'list'], { COLONY_API_URL: mock.url });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /[\x1b\x07]/);
    assert.match(result.stderr, /Untrusted error/);
  } finally { await mock.close(); }
});

test('JSON output escapes C1 terminal controls without losing data', async () => {
  const objective = 'Task\u009d52;c;YXR0YWNrZXI=\u009c';
  const mock = await startMock(({ response }) => sendJson(response, 200, {
    count: 1, jobs: [{ id: 'public-job', state: 'completed', objective }],
  }));
  try {
    const result = await runCli(['task', 'list', '--json'], { COLONY_API_URL: mock.url });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /[\u007f-\u009f]/);
    assert.equal(JSON.parse(result.stdout).jobs[0].objective, objective);
  } finally { await mock.close(); }
});
