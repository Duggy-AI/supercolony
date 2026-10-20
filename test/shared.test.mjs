import assert from 'node:assert/strict';
import test from 'node:test';
import { getSigner, request } from '../src/shared.mjs';
import { sendJson, startMock } from './helpers/mock-api.mjs';
import { TEST_ADDRESS, TEST_KEY } from './helpers/cli.mjs';

test('request parses JSON success', async () => {
  const mock = await startMock(({ response }) => sendJson(response, 200, { ok: true }));
  try {
    const result = await request(mock.url, '/x');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { ok: true });
  } finally {
    await mock.close();
  }
});

test('request rejects invalid JSON on success', async () => {
  const mock = await startMock(({ response }) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('not json');
  });
  try {
    await assert.rejects(() => request(mock.url, '/x'), /invalid JSON response/);
  } finally {
    await mock.close();
  }
});

test('request keeps a raw error summary', async () => {
  const mock = await startMock(({ response }) => {
    response.writeHead(502, { 'content-type': 'text/html' });
    response.end('<html>upstream boom</html>');
  });
  try {
    await assert.rejects(
      () => request(mock.url, '/x'),
      (error) => error.status === 502 && /HTTP 502/.test(error.message) && /upstream boom/.test(error.message),
    );
  } finally {
    await mock.close();
  }
});

test('request returns allowed 402 JSON', async () => {
  const mock = await startMock(({ response }) => sendJson(response, 402, { accepts: [1] }));
  try {
    const result = await request(mock.url, '/x', { allowStatuses: [402] });
    assert.equal(result.status, 402);
    assert.deepEqual(result.data, { accepts: [1] });
  } finally {
    await mock.close();
  }
});

test('getSigner directs an unconfigured user to wallet setup', async () => {
  const previous = process.env.COLONY_TEST_KEY;
  delete process.env.COLONY_TEST_KEY;
  try {
    await assert.rejects(getSigner({ keyEnv: 'COLONY_TEST_KEY' }), /No wallet configured/);
  } finally {
    if (previous !== undefined) process.env.COLONY_TEST_KEY = previous;
  }
});

test('getSigner derives the expected address', async () => {
  process.env.COLONY_TEST_KEY = TEST_KEY;
  try {
    assert.equal((await getSigner({ keyEnv: 'COLONY_TEST_KEY' })).address, TEST_ADDRESS);
  } finally {
    delete process.env.COLONY_TEST_KEY;
  }
});
