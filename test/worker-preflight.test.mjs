import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePreflight, formatPreflight } from '../src/worker/preflight.mjs';

const baseProbe = {
  node: { ok: true, version: '22.23.3' },
  npm: { ok: true, version: '10.9.9' },
  git: { ok: true, version: 'git version 2.39.5' },
  curl: { ok: true, version: 'curl 7.88.1' },
  forge: { ok: false, version: null },
  claude: { ok: false, version: null },
  codex: { ok: false, version: null },
  platform: 'linux',
  arch: 'x64',
};

test('deploy preflight blocks only Node/npm, not run-capability warnings', () => {
  const result = evaluatePreflight(baseProbe);
  assert.equal(result.ok, true);
  const text = formatPreflight(result);
  assert.match(text, /^ok   node:/m);
  assert.match(text, /^ok   npm:/m);
  assert.match(text, /^warn forge:/m);
  assert.match(text, /^warn runtime:/m);
  assert.doesNotMatch(text, /FAIL (forge|runtime|git|curl)/);
});

test('missing Node or npm is a real preflight failure', () => {
  const result = evaluatePreflight({
    ...baseProbe,
    node: { ok: true, version: '18.20.0' },
    npm: { ok: false, version: null },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['Node.js 22+ is required', 'npm is required']);
  const text = formatPreflight(result);
  assert.match(text, /^FAIL node:/m);
  assert.match(text, /^FAIL npm:/m);
});
