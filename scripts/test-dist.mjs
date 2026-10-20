import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(resolve(root, '.local'), { recursive: true });
const stage = await mkdtemp(resolve(root, '.local/dist-tests-'));
try {
  // Existing tests import ../src: supply built code there in an isolated stage.
  // Ancestor node_modules resolves the development-only test dependencies.
  await cp(resolve(root, 'dist'), join(stage, 'src'), { recursive: true });
  for (const path of ['test', 'examples', 'package.json']) {
    await cp(resolve(root, path), join(stage, path), { recursive: true });
  }
  const selected = process.argv.slice(2);
  const names = selected.length ? selected : (await readdir(join(stage, 'test'))).filter(name => name.endsWith('.test.mjs'));
  process.exitCode = await new Promise((resolve, reject) => {
    // CLI suites each spawn Node processes and some load native addons. Bound
    // file concurrency instead of multiplying it by the host CPU count.
    const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...names.map(name => join(stage, 'test', name))], {
      cwd: stage, stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`Built-code tests interrupted by ${signal}`));
      else resolve(code);
    });
  });
} finally {
  await rm(stage, { recursive: true, force: true });
}
