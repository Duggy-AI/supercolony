import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const harness = join(root, 'test', 'helpers', 'run-cli.mjs');
const entry = join(root, 'src', 'cli.mjs');

export const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const TEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function runScript(script, args, env, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: {
        ...process.env,
        COLONY_PRIVATE_KEY: TEST_KEY,
        ...(env.COLONY_API_URL ? { COLONY_RPC_URL: env.COLONY_API_URL + '/rpc' } : {}),
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, options.timeoutMs ?? 30_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr, signal });
    });
  });
}

export function runCli(args, env = {}, options = {}) {
  return runScript(harness, args, env, options);
}

export function runEntry(args, env = {}, options = {}) {
  return runScript(entry, args, env, options);
}
