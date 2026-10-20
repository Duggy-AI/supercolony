import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runEntry } from './helpers/cli.mjs';
import { sendJson, startMock } from './helpers/mock-api.mjs';

const JOB_ID = '55555555-5555-4555-8555-555555555555';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sendBinary(response, status, bytes) {
  response.writeHead(status, {
    'content-type': 'application/octet-stream',
    'content-length': bytes.length,
  });
  response.end(bytes);
}

function resultFor(files = [], { state = 'completed', complete = state === 'completed', source = [] } = {}) {
  return {
    jobId: JOB_ID,
    projectId: JOB_ID,
    state,
    complete,
    source,
    files,
    delivery: { requested: false, mode: 'repository', repoUrl: null, commit: null },
  };
}

async function makeWorkspace() {
  return mkdtemp(join(tmpdir(), 'colony-task-result-'));
}

async function filesUnder(dir) {
  const found = [];
  async function walk(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  }
  await walk(dir);
  return found.sort();
}

test('task wait polls until the result is complete and prints one clean JSON document', async () => {
  let polls = 0;
  const mock = await startMock(({ response, record }) => {
    if (record.path !== `/jobs/${JOB_ID}/result`) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    polls += 1;
    sendJson(response, 200, polls < 3
      ? resultFor([], { state: 'executing', complete: false })
      : resultFor([{
        path: 'artifacts/report.md',
        hash: 'ab'.repeat(32),
        bytes: 10,
        mediaType: 'text/markdown',
        url: 'https://example.test/report.md',
      }]));
  });

  try {
    const run = await runEntry([
      'task', 'wait', JOB_ID,
      '--interval', '0.05',
      '--timeout', '2',
      '--json',
    ], { COLONY_API_URL: mock.url });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(polls, 3);
    const output = JSON.parse(run.stdout);
    assert.equal(output.jobId, JOB_ID);
    assert.equal(output.state, 'completed');
    assert.equal(output.complete, true);
    assert.match(run.stderr, /wait: executing complete=false/);
    assert.doesNotMatch(run.stdout, /wait:/);
  } finally {
    await mock.close();
  }
});

test('task wait fails on blocked and cancelled results', async () => {
  for (const state of ['blocked', 'cancelled']) {
    const mock = await startMock(({ response }) => {
      sendJson(response, 200, resultFor([], { state, complete: false }));
    });
    try {
      const run = await runEntry([
        'task', 'wait', JOB_ID, '--interval', '0.05', '--timeout', '1', '--json',
      ], { COLONY_API_URL: mock.url });
      assert.equal(run.status, 1, `${state}: ${run.stderr}`);
      const output = JSON.parse(run.stdout);
      assert.equal(output.state, state);
      assert.match(run.stderr, new RegExp(`ended in state ${state}`));
    } finally {
      await mock.close();
    }
  }
});

test('task wait keeps polling unknown states, including failed, and reports the last state on timeout', async () => {
  for (const state of ['executing', 'failed']) {
    let polls = 0;
    const mock = await startMock(({ response }) => {
      polls += 1;
      sendJson(response, 200, resultFor([], { state, complete: false }));
    });
    try {
      const run = await runEntry([
        'task', 'wait', JOB_ID, '--interval', '0.03', '--timeout', '0.2', '--json',
      ], { COLONY_API_URL: mock.url });
      assert.equal(run.status, 1, `${state}: ${run.stderr}`);
      assert.ok(polls > 1, `${state}: expected several polls, got ${polls}`);
      const output = JSON.parse(run.stdout);
      assert.equal(output.state, state);
      assert.match(run.stderr, new RegExp(`timed out after 0\\.2s; last state: ${state}`));
    } finally {
      await mock.close();
    }
  }
});

test('task wait honors Retry-After on 429 and then completes', async () => {
  let attempts = 0;
  let firstAt = 0;
  let secondAt = 0;
  const mock = await startMock(({ response }) => {
    attempts += 1;
    if (attempts === 1) {
      firstAt = Date.now();
      sendJson(response, 429, { error: 'request_limit' }, { 'retry-after': '1' });
      return;
    }
    secondAt = Date.now();
    sendJson(response, 200, resultFor([{ path: 'a', hash: 'ab'.repeat(32), bytes: 1, url: 'https://example.test/a' }]));
  });
  try {
    const run = await runEntry([
      'task', 'wait', JOB_ID, '--interval', '0.05', '--timeout', '3', '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(attempts, 2);
    assert.ok(secondAt - firstAt >= 900, `retried after ${secondAt - firstAt}ms`);
    assert.match(run.stderr, /HTTP 429; retrying in 1\.0s/);
  } finally {
    await mock.close();
  }
});

test('task wait stops after three consecutive rate-limit responses without nested retries', async () => {
  let attempts = 0;
  const mock = await startMock(({ response }) => {
    attempts++;
    sendJson(response, 429, { error: 'request_limit' }, { 'retry-after': '0' });
  });
  try {
    const run = await runEntry(['task', 'wait', JOB_ID, '--timeout', '3', '--json'], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(attempts, 3);
  } finally { await mock.close(); }
});

test('task wait rejects non-positive or non-numeric interval and timeout', async () => {
  for (const [option, value, message] of [
    ['--interval', '0', /--interval must be a positive number/],
    ['--timeout', '-1', /--timeout must be a positive number/],
    ['--interval', 'nope', /--interval must be a positive number/],
  ]) {
    const run = await runEntry([
      'task', 'wait', JOB_ID, option, value, '--json',
    ], { COLONY_API_URL: 'http://127.0.0.1:1' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, message);
  }
});

test('task download writes binary and nested files and reports hash, bytes and jobId', async () => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const binary = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < binary.length; index += 1) binary[index] = index % 251;
  const text = Buffer.from('# Report\n');
  let mock;
  mock = await startMock(({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, resultFor([
        {
          name: 'data',
          path: 'artifacts/nested/data.bin',
          hash: sha256(binary),
          bytes: binary.length,
          mediaType: 'application/octet-stream',
          url: `${mock.url}/artifacts/data`,
        },
        {
          name: 'report',
          path: 'reports/report.md',
          hash: sha256(text),
          bytes: text.length,
          mediaType: 'text/markdown',
          url: `${mock.url}/artifacts/report`,
        },
      ], { source: [{ node: 'x', url: `${mock.url}/bundles/not-downloaded` }] }));
      return;
    }
    if (record.path === '/artifacts/data') {
      sendBinary(response, 200, binary);
      return;
    }
    if (record.path === '/artifacts/report') {
      sendBinary(response, 200, text);
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.jobId, JOB_ID);
    assert.equal(output.state, 'completed');
    assert.deepEqual(output.files.map((file) => file.path), [
      'artifacts/nested/data.bin',
      'reports/report.md',
    ]);
    assert.equal(output.files[0].hash, sha256(binary));
    assert.equal(output.files[0].bytes, binary.length);
    assert.deepEqual(await readFile(output.files[0].file), binary);
    assert.deepEqual(await readFile(output.files[1].file), text);
    assert.equal((await stat(output.files[0].file)).size, binary.length);
    assert.equal(mock.requests.filter((request) => request.path.startsWith('/bundles/')).length, 0);
    assert.equal(mock.requests.filter((request) => request.path.startsWith('/artifacts/')).length, 2);
    assert.match(run.stderr, /download: artifacts\/nested\/data\.bin/);
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download rejects a hash mismatch and leaves no file behind', async () => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const data = Buffer.from('artifact bytes');
  const target = join(out, 'artifacts/data.bin');
  let mock;
  mock = await startMock(({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, resultFor([{
        path: 'artifacts/data.bin',
        hash: sha256(Buffer.from('different')),
        bytes: data.length,
        url: `${mock.url}/artifact`,
      }]));
      return;
    }
    sendBinary(response, 200, data);
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /hash mismatch for artifacts\/data\.bin/);
    await assert.rejects(access(target));
    assert.deepEqual(await filesUnder(out), []);
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download rejects a bytes mismatch and leaves no file behind', async () => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const data = Buffer.from('artifact bytes');
  const target = join(out, 'artifacts/data.bin');
  let mock;
  mock = await startMock(({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, resultFor([{
        path: 'artifacts/data.bin',
        hash: sha256(data),
        bytes: data.length + 1,
        url: `${mock.url}/artifact`,
      }]));
      return;
    }
    sendBinary(response, 200, data);
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /bytes mismatch for artifacts\/data\.bin/);
    await assert.rejects(access(target));
    assert.deepEqual(await filesUnder(out), []);
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download stops immediately when the stream exceeds the declared bytes', async () => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const data = Buffer.alloc(256 * 1024, 7);
  const target = join(out, 'artifacts/big.bin');
  let mock;
  mock = await startMock(({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, resultFor([{
        path: 'artifacts/big.bin',
        hash: sha256(data),
        bytes: 1000,
        url: `${mock.url}/artifact`,
      }]));
      return;
    }
    sendBinary(response, 200, data);
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /bytes mismatch for artifacts\/big\.bin: expected 1000, got more/);
    await assert.rejects(access(target));
    assert.deepEqual(await filesUnder(out), []);
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download keeps files saved before a later failure and lists them in the error', async () => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const first = Buffer.from('first payload');
  const second = Buffer.from('second payload');
  const firstTarget = join(out, 'artifacts/first.bin');
  const secondTarget = join(out, 'artifacts/second.bin');
  let mock;
  mock = await startMock(({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, resultFor([
        {
          path: 'artifacts/first.bin',
          hash: sha256(first),
          bytes: first.length,
          url: `${mock.url}/first`,
        },
        {
          path: 'artifacts/second.bin',
          hash: sha256(Buffer.from('wrong')),
          bytes: second.length,
          url: `${mock.url}/second`,
        },
      ]));
      return;
    }
    sendBinary(response, 200, record.path === '/first' ? first : second);
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /hash mismatch for artifacts\/second\.bin/);
    assert.match(run.stderr, /already saved: .*first\.bin/);
    assert.deepEqual(await readFile(firstTarget), first);
    await assert.rejects(access(secondTarget));
    assert.deepEqual(await filesUnder(out), [firstTarget]);
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download refuses a target that appears while its bytes are downloading', async () => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const data = Buffer.from('payload');
  const target = join(out, 'artifacts/raced.bin');
  let mock;
  mock = await startMock(async ({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, resultFor([{
        path: 'artifacts/raced.bin',
        hash: sha256(data),
        bytes: data.length,
        url: `${mock.url}/artifact`,
      }]));
      return;
    }
    await mkdir(join(out, 'artifacts'), { recursive: true });
    await writeFile(target, 'appeared during download');
    sendBinary(response, 200, data);
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /refusing to overwrite existing file/);
    assert.equal(await readFile(target, 'utf8'), 'appeared during download');
    assert.deepEqual(await filesUnder(out), [target]);
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download refuses to overwrite an existing file before downloading', async () => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const target = join(out, 'artifacts/report.md');
  const data = Buffer.from('new bytes');
  await mkdir(join(out, 'artifacts'), { recursive: true });
  await writeFile(target, 'existing');

  let mock;
  mock = await startMock(({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, resultFor([{
        path: 'artifacts/report.md',
        hash: sha256(data),
        bytes: data.length,
        url: `${mock.url}/artifact`,
      }]));
      return;
    }
    sendBinary(response, 200, data);
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /refusing to overwrite existing file/);
    assert.equal(await readFile(target, 'utf8'), 'existing');
    assert.equal(mock.requests.filter((request) => request.path === '/artifact').length, 0);
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download rejects absolute, parent, Windows drive, ADS and escaping paths', async () => {
  const workspace = await makeWorkspace();
  const data = Buffer.from('payload');
  const unsafe = [
    '../escape.txt',
    '/absolute.txt',
    'C:\\evil.txt',
    'artifacts/file.txt:stream',
    'artifacts\\..\\escape.txt',
    'artifacts/CON',
    'artifacts/NUL.txt',
    'artifacts/COM1',
    'artifacts/LPT9.log',
    'artifacts/trailing.',
    'artifacts/trailing ',
  ];

  try {
    for (const [index, path] of unsafe.entries()) {
      const out = join(workspace, `out-${index}`);
      let mock;
      mock = await startMock(({ response, record }) => {
        if (record.path === `/jobs/${JOB_ID}/result`) {
          sendJson(response, 200, resultFor([{
            path,
            hash: sha256(data),
            bytes: data.length,
            url: `${mock.url}/artifact`,
          }]));
          return;
        }
        sendBinary(response, 200, data);
      });
      try {
        const run = await runEntry([
          'task', 'download', JOB_ID, '--out', out, '--json',
        ], { COLONY_API_URL: mock.url });
        assert.equal(run.status, 1, `${path}: ${run.stderr}`);
        assert.equal(run.stdout, '', path);
        assert.match(run.stderr, /unsafe artifact path/, path);
        assert.equal(mock.requests.filter((request) => request.path === '/artifact').length, 0, path);
      } finally {
        await mock.close();
      }
    }
    await assert.rejects(access(join(workspace, 'escape.txt')));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download rejects a symlinked parent directory', async (t) => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const outside = join(workspace, 'outside');
  const data = Buffer.from('payload');
  await mkdir(out);
  await mkdir(outside);
  try {
    await symlink(outside, join(out, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symlinks unavailable: ${error.code}`);
      await rm(workspace, { recursive: true, force: true });
      return;
    }
    throw error;
  }

  let mock;
  mock = await startMock(({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, resultFor([{
        path: 'link/pwn.txt',
        hash: sha256(data),
        bytes: data.length,
        url: `${mock.url}/artifact`,
      }]));
      return;
    }
    sendBinary(response, 200, data);
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /symlink parent/);
    assert.equal(mock.requests.filter((request) => request.path === '/artifact').length, 0);
    await assert.rejects(access(join(outside, 'pwn.txt')));
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download fails on artifact HTTP errors and removes its temporary file', async () => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const data = Buffer.from('payload');
  const target = join(out, 'artifacts/data.bin');
  let mock;
  mock = await startMock(({ response, record }) => {
    if (record.path === `/jobs/${JOB_ID}/result`) {
      sendJson(response, 200, resultFor([{
        path: 'artifacts/data.bin',
        hash: sha256(data),
        bytes: data.length,
        url: `${mock.url}/artifact`,
      }]));
      return;
    }
    sendJson(response, 503, { error: 'unavailable' });
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /HTTP 503 downloading artifacts\/data\.bin/);
    await assert.rejects(access(target));
    assert.deepEqual(await filesUnder(out), []);
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download fails when the job result is not completed', async () => {
  const workspace = await makeWorkspace();
  const out = join(workspace, 'out');
  const mock = await startMock(({ response }) => {
    sendJson(response, 200, resultFor([], { state: 'executing', complete: false }));
  });

  try {
    const run = await runEntry([
      'task', 'download', JOB_ID, '--out', out, '--json',
    ], { COLONY_API_URL: mock.url });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /is not complete \(state: executing/);
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task download requires --out', async () => {
  const run = await runEntry(['task', 'download', JOB_ID], {
    COLONY_API_URL: 'http://127.0.0.1:1',
  });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /--out/);
});
