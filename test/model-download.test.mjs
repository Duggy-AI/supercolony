import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadModelFile } from '../src/planner/model-download.mjs';
import { ensureModel, modelInfo } from '../src/planner/local.mjs';

const BODY = randomBytes(64 * 1024);
const FILE_NAME = 'fixture-model.gguf';
const REVISION = '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0';

const FIXTURE_MODEL = Object.freeze({
  name: 'fixture',
  quantization: 'Q4_K_M',
  url: `http://huggingface.invalid/unsloth/fixture/resolve/main/${FILE_NAME}`,
  mirrorUrl: `http://hf-mirror.invalid/unsloth/fixture/resolve/main/${FILE_NAME}`,
  revision: REVISION,
  sha256: createHash('sha256').update(BODY).digest('hex'),
  size: BODY.length,
  fileName: FILE_NAME,
  contextSize: 4096,
});

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'colony-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Real loopback HTTP server. `handler` decides per request how to behave and
// `hits` records which paths were requested so tests can prove the mirror
// was never contacted.
async function serve(t, handler) {
  const hits = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    hits.push(request.url);
    handler(request, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    // Force-close kept-alive and half-read sockets so a stalled fixture can
    // never keep the test process alive after its assertion finished.
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    hits,
    sockets,
    // The pinned revision is part of the path, exactly as in production.
    officialUrl: `${base}/official/resolve/${REVISION}/${FILE_NAME}`,
    mirrorUrl: `${base}/mirror/resolve/${REVISION}/${FILE_NAME}`,
  };
}

function sendBody(response) {
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(BODY.length),
  });
  response.end(BODY);
}

function hitsOf(hits, kind) {
  return hits.filter((url) => url.startsWith(`/${kind}/`));
}

function collectSwitches() {
  const messages = [];
  return { messages, onSwitch: (message) => messages.push(message) };
}

async function leftovers(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith('.part'));
}

function waitForClose(t, sockets) {
  if (sockets.size === 0) return Promise.resolve();
  const pending = [...sockets];
  return Promise.all(pending.map((socket) => new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    // t.after() force-closes leftovers, so this can never hang the suite.
    socket.once('close', resolve);
  })));
}

test('official source succeeds and the mirror is never contacted (default timeouts)', async (t) => {
  const dir = await tempDir(t);
  const remote = await serve(t, (_request, response) => sendBody(response));
  const { messages, onSwitch } = collectSwitches();

  // No requestTimeoutMs/idleTimeoutMs: the production defaults must apply.
  const target = await downloadModelFile({
    officialUrl: remote.officialUrl,
    mirrorUrl: remote.mirrorUrl,
    directory: dir,
    fileName: FILE_NAME,
    size: BODY.length,
    onSwitch,
  });

  assert.equal(target, join(dir, FILE_NAME));
  assert.deepEqual(await readFile(target), BODY);
  assert.equal(hitsOf(remote.hits, 'mirror').length, 0);
  assert.deepEqual(messages, []);
  assert.deepEqual(await leftovers(dir), []);
});

test('a body larger than one read is written completely', async (t) => {
  const dir = await tempDir(t);
  // Wait for the client to consume the first piece before sending the rest.
  // Separate server writes alone can be coalesced into a single network read.
  let sendRemainder;
  const remote = await serve(t, (_request, response) => {
    response.writeHead(200, { 'content-length': String(BODY.length) });
    sendRemainder = () => response.end(BODY.subarray(1000));
    response.write(BODY.subarray(0, 1000));
  });

  const progress = [];
  await downloadModelFile({
    officialUrl: remote.officialUrl,
    mirrorUrl: remote.mirrorUrl,
    directory: dir,
    fileName: FILE_NAME,
    size: BODY.length,
    onSwitch: () => {},
    onProgress: (state) => {
      progress.push(state.downloadedSize);
      if (progress.length === 1) sendRemainder();
    },
  });

  assert.deepEqual(await readFile(join(dir, FILE_NAME)), BODY);
  assert.equal(progress.at(-1), BODY.length);
  assert.ok(progress.length > 1);
  assert.deepEqual(await leftovers(dir), []);
});

for (const [label, handler] of [
  ['an HTTP error', (_request, response) => {
    response.writeHead(503, { 'content-length': '0' });
    response.end();
  }],
  ['no response headers', (request) => {
    // Accept the request and never answer: the request-headers deadline must
    // fire. The socket is force-closed by t.after().
    request.resume();
  }],
  ['a stalled body', (_request, response) => {
    response.writeHead(200, { 'content-length': String(BODY.length) });
    response.write(BODY.subarray(0, 1024));
    // Never end: the client must give up on the idle timeout.
  }],
  ['a truncated body', (_request, response) => {
    response.writeHead(200, { 'content-length': String(BODY.length) });
    response.write(BODY.subarray(0, 4096));
    response.socket?.destroy();
    response.destroy();
  }],
]) {
  test(`${label} from the official source switches to the mirror`, async (t) => {
    const dir = await tempDir(t);
    const remote = await serve(t, (request, response) => {
      if (request.url.startsWith('/official/')) {
        handler(request, response);
        return;
      }
      sendBody(response);
    });
    const { messages, onSwitch } = collectSwitches();

    const target = await downloadModelFile({
      officialUrl: remote.officialUrl,
      mirrorUrl: remote.mirrorUrl,
      directory: dir,
      fileName: FILE_NAME,
      size: BODY.length,
      onSwitch,
      requestTimeoutMs: 150,
      idleTimeoutMs: 150,
    });

    assert.deepEqual(await readFile(target), BODY);
    assert.equal(hitsOf(remote.hits, 'mirror').length, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /hf-mirror\.com/);
    assert.deepEqual(await leftovers(dir), []);
  });
}

test('both sources failing lists each reason and leaves no partial file', async (t) => {
  const dir = await tempDir(t);
  const remote = await serve(t, (_request, response) => {
    response.writeHead(502, { 'content-length': '0' });
    response.end();
  });

  await assert.rejects(
    downloadModelFile({
      officialUrl: remote.officialUrl,
      mirrorUrl: remote.mirrorUrl,
      directory: dir,
      fileName: FILE_NAME,
      size: BODY.length,
      onSwitch: () => {},
    }),
    (error) => {
      assert.match(error.message, /huggingface: HTTP 502/);
      assert.match(error.message, /hf-mirror: HTTP 502/);
      return true;
    },
  );
  assert.equal(hitsOf(remote.hits, 'official').length, 1);
  assert.equal(hitsOf(remote.hits, 'mirror').length, 1);
  assert.deepEqual(await readdir(dir), []);
});

test('a checksum or size mismatch does not switch to the mirror', async (t) => {
  for (const [label, adapt, body, expected] of [
    [
      'checksum',
      (model) => model,
      () => Buffer.concat([BODY.subarray(1), Buffer.from([0])]),
      /failed verification: corrupt/,
    ],
    [
      'size',
      (model) => ({ ...model, size: BODY.length + 1 }),
      () => BODY,
      /content length \d+ does not match expected \d+/,
    ],
  ]) {
    const home = await tempDir(t);
    const remote = await serve(t, (_request, response) => {
      response.writeHead(200, { 'content-length': String(body().length) });
      response.end(body());
    });
    const model = adapt({
      ...FIXTURE_MODEL,
      url: remote.officialUrl,
      mirrorUrl: remote.mirrorUrl,
    });

    const events = [];
    await assert.rejects(ensureModel({ home, model, onProgress: event => events.push(event) }), expected);
    assert.ok(events.every(event => event.stage !== 'ready'), `${label}: must not report a verified model`);
    assert.equal(hitsOf(remote.hits, 'mirror').length, 0, `${label}: mirror must not be contacted`);
    assert.deepEqual(await leftovers(join(home, 'models')), []);
  }
});

test('a content-length mismatch fails without trying the mirror', async (t) => {
  const dir = await tempDir(t);
  const remote = await serve(t, (_request, response) => {
    response.writeHead(200, { 'content-length': String(BODY.length + 10) });
    response.end(Buffer.concat([BODY, Buffer.alloc(10)]));
  });

  await assert.rejects(
    downloadModelFile({
      officialUrl: remote.officialUrl,
      mirrorUrl: remote.mirrorUrl,
      directory: dir,
      fileName: FILE_NAME,
      size: BODY.length,
      onSwitch: () => {},
    }),
    /content length \d+ does not match expected \d+/,
  );
  assert.equal(hitsOf(remote.hits, 'mirror').length, 0);
  assert.deepEqual(await readdir(dir), []);
});

test('a disk failure while the body is streaming never touches the mirror', async (t) => {
  const dir = await tempDir(t);
  let bodyStarted = false;
  const remote = await serve(t, (_request, response) => {
    bodyStarted = true;
    sendBody(response);
  });
  const { messages, onSwitch } = collectSwitches();

  // The parent directory does not exist, so `open(temp, 'wx')` fails with
  // ENOENT after the headers and a matching content-length were accepted.
  await assert.rejects(
    downloadModelFile({
      officialUrl: remote.officialUrl,
      mirrorUrl: remote.mirrorUrl,
      directory: join(dir, 'missing-parent'),
      fileName: FILE_NAME,
      size: BODY.length,
      onSwitch,
    }),
    /cannot create temporary file: ENOENT/,
  );

  assert.equal(bodyStarted, true);
  assert.equal(hitsOf(remote.hits, 'official').length, 1);
  assert.equal(hitsOf(remote.hits, 'mirror').length, 0, 'disk error must not switch sources');
  assert.deepEqual(messages, []);
  // The finally block aborts the controller, so the official connection closes.
  await waitForClose(t, remote.sockets);
});

test('a ready cached model is used without any network access', async (t) => {
  const home = await tempDir(t);
  const remote = await serve(t, (_request, response) => sendBody(response));
  const model = {
    ...FIXTURE_MODEL,
    url: remote.officialUrl,
    mirrorUrl: remote.mirrorUrl,
  };

  const events = [];
  const first = await ensureModel({ home, model, onProgress: event => events.push(event) });
  assert.equal(first.status, 'ready');
  assert.equal(events[0].stage, 'checking');
  assert.equal(events.at(-1).stage, 'ready');
  const completed = events.findIndex(event => event.stage === 'downloading' && event.downloadedSize === BODY.length);
  const verifying = events.findIndex(event => event.stage === 'verifying');
  assert.ok(completed > 0 && verifying > completed);
  // The pinned revision, not `main`, was requested.
  assert.deepEqual(remote.hits, [`/official/resolve/${REVISION}/${FILE_NAME}`]);

  remote.hits.length = 0;
  events.length = 0;
  const second = await ensureModel({ home, model, onProgress: event => events.push(event) });
  assert.equal(second.status, 'ready');
  assert.equal(second.downloaded, true);
  assert.deepEqual(await readFile(second.path), BODY);
  assert.deepEqual(remote.hits, [], 'ready cache must not open a connection');
  assert.deepEqual(events.map(event => event.stage), ['checking', 'ready']);
  assert.deepEqual(await leftovers(join(home, 'models')), []);
});

test('model progress restarts at zero on the backup source and finishes only after verification', async t => {
  const home = await tempDir(t);
  const remote = await serve(t, (request, response) => {
    if (request.url.startsWith('/official/')) {
      response.writeHead(502);
      response.end();
    } else sendBody(response);
  });
  const events = [];
  await ensureModel({ home, model: { ...FIXTURE_MODEL, url: remote.officialUrl, mirrorUrl: remote.mirrorUrl },
    onProgress: event => events.push(event) });
  const restart = events.find(event => event.stage === 'downloading' && event.source === 'backup');
  assert.equal(restart.downloadedSize, 0);
  assert.equal(restart.speed, 0);
  assert.equal(restart.sourceWebsite, new URL(remote.mirrorUrl).hostname);
  assert.equal(events.find(event => event.source === 'primary').sourceWebsite, new URL(remote.officialUrl).hostname);
  assert.ok(events.some(event => event.source === 'backup' && event.downloadedSize === BODY.length));
  assert.deepEqual(events.slice(-2).map(event => event.stage), ['verifying', 'ready']);
  assert.equal(hitsOf(remote.hits, 'official').length, 1);
  assert.equal(hitsOf(remote.hits, 'mirror').length, 1);
});

test('a corrupt cached file is replaced via the pinned revision path', async (t) => {
  const home = await tempDir(t);
  const remote = await serve(t, (_request, response) => sendBody(response));
  const model = {
    ...FIXTURE_MODEL,
    url: remote.officialUrl,
    mirrorUrl: remote.mirrorUrl,
  };
  await mkdir(join(home, 'models'), { recursive: true });

  assert.equal((await modelInfo({ home, model })).status, 'missing');
  const info = await ensureModel({ home, model, onProgress: () => {} });
  assert.equal(info.status, 'ready');
  assert.equal(remote.hits[0], `/official/resolve/${REVISION}/${FILE_NAME}`);
});
