import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { stdout } = await exec(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json'], { cwd: root });
const [pkg] = JSON.parse(stdout);
const paths = pkg.files.map(file => file.path);
assert.ok(paths.includes('dist/cli.mjs'));
for (const path of paths) {
  assert.ok(path.startsWith('dist/') || /^(package\.json|README\.md|LICENSE(?:\..*)?)$/i.test(path), `Unexpected published file: ${path}`);
  assert.ok(!path.endsWith('.map'), `Source map in package: ${path}`);
}
for (const path of ['dist/tui/session.mjs', 'dist/tui/native.mjs',
  'dist/worker/remote/install.cjs', 'dist/worker/remote/config-patch.cjs', 'dist/worker/remote/config-summary.cjs']) {
  assert.ok(paths.includes(path), `Missing runtime entry: ${path}`);
}

const home = await mkdtemp(join(tmpdir(), 'colony-package-'));
try {
  const entry = resolve(root, 'dist/cli.mjs');
  const env = { ...process.env, COLONY_HOME: home, COLONY_PRIVATE_KEY: '' };
  for (const args of [['--version'], ['--help'], ['worker', '--help'], ['wallet', 'list', '--json'], ['model', 'status', '--json']]) {
    const result = await exec(process.execPath, [entry, ...args], { cwd: home, env });
    assert.ok(result.stdout.trim(), `No output from ${args.join(' ')}`);
    if (args.includes('--json')) assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
  const configPath = join(home, 'worker.json');
  const remote = execFileSync(process.execPath, [resolve(root, 'dist/worker/remote/config-summary.cjs')],
    { env, input: JSON.stringify({ path: configPath }), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(remote), { exists: false, path: configPath });
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log(`Package checked: ${paths.length} files, ${(pkg.size / 1024).toFixed(1)} KiB packed; only dist/ and npm metadata.`);
