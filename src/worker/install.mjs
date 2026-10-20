import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runNodeStdin } from './context.mjs';
import { runProcess } from './process.mjs';
import { selectSum, WORKER_ASSET } from './release.mjs';

export class InstallChecksumError extends Error {
  constructor(expected, actual, filename) {
    super(`SHA-256 mismatch for ${filename}: expected ${expected}, got ${actual}; refusing to run npm`);
    this.name = 'InstallChecksumError';
    this.code = 'CHECKSUM_MISMATCH';
    this.expected = expected;
    this.actual = actual;
  }
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function installedCliPath(prefix, platform = process.platform) {
  return platform === 'win32'
    ? path.join(prefix, 'node_modules', '@identitymd', 'worker', 'dist', 'cli.js')
    : path.join(prefix, 'lib', 'node_modules', '@identitymd', 'worker', 'dist', 'cli.js');
}

export function installedImdPath(prefix, platform = process.platform) {
  return platform === 'win32' ? path.join(prefix, 'imd.cmd') : path.join(prefix, 'bin', 'imd');
}

export function assertInstalled(prefix, platform = process.platform) {
  const cli = installedCliPath(prefix, platform);
  if (!fs.existsSync(cli)) {
    throw new Error(`npm finished but ${cli} is missing; the install did not land in ${prefix}`);
  }
  return installedImdPath(prefix, platform);
}

async function fetchBuffer(fetchImpl, url, label) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`${label} download failed: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export function resolveNpmInvocation(env = process.env, platform = process.platform) {
  const execPath = env.npm_execpath;
  if (execPath && fs.existsSync(execPath)) {
    return { command: process.execPath, args: [execPath] };
  }
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundled)) {
    return { command: process.execPath, args: [bundled] };
  }
  if (platform === 'win32') {
    throw new Error('cannot locate npm-cli.js; run colony through npm or set npm_execpath');
  }
  return { command: 'npm', args: [] };
}

export async function defaultRunNpm(spec) {
  const result = await runProcess({ ...spec, stdio: 'pipe' });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

/**
 * Download, verify SHA-256, and only then run npm.  A checksum failure exits
 * before npm is even resolved, which is the property the tests pin down.
 */
export async function installReleaseLocal({
  release,
  prefix,
  fetchImpl = fetch,
  runNpm = defaultRunNpm,
  log = () => {},
  tempRoot = os.tmpdir(),
}) {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'colony-worker-'));
  try {
    log(`download ${release.sumsUrl}`);
    const sumsText = (await fetchBuffer(fetchImpl, release.sumsUrl, 'SHA256SUMS')).toString('utf8');
    const expected = selectSum(sumsText, WORKER_ASSET);
    if (release.assetDigest && release.assetDigest !== expected) {
      throw new InstallChecksumError(expected, release.assetDigest, `${WORKER_ASSET} (release metadata digest)`);
    }

    log(`download ${release.tgzUrl}`);
    const bytes = await fetchBuffer(fetchImpl, release.tgzUrl, WORKER_ASSET);
    const actual = sha256(bytes);
    if (actual !== expected) {
      throw new InstallChecksumError(expected, actual, WORKER_ASSET);
    }

    const tgz = path.join(dir, WORKER_ASSET);
    fs.writeFileSync(tgz, bytes, { mode: 0o600 });
    fs.mkdirSync(prefix, { recursive: true });

    const npm = resolveNpmInvocation();
    log(`npm install --global --prefix ${prefix} ${tgz}`);
    const result = await runNpm({
      command: npm.command,
      args: [...npm.args, 'install', '--global', '--prefix', prefix, tgz],
      cwd: dir,
    });
    if (result.exitCode !== 0) {
      throw new Error(`npm install failed with exit code ${result.exitCode ?? 'unknown'}`);
    }
    const imdPath = assertInstalled(prefix);
    return {
      ok: true,
      prefix,
      imdPath,
      cliPath: installedCliPath(prefix),
      tag: release.tag,
      sha256: actual,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const REMOTE_INSTALL = fs.readFileSync(new URL('./remote/install.cjs', import.meta.url), 'utf8');
const RESULT_PREFIX = 'COLONY_INSTALL_RESULT=';

export async function installReleaseRemote({ ctx, release, prefix, log = () => {} }) {
  log(`remote install ${release.tag} on ${ctx.host} into ${prefix}`);
  const result = await runNodeStdin(
    ctx,
    REMOTE_INSTALL,
    [prefix, release.tgzUrl, release.sumsUrl, release.tag, release.assetDigest ?? ''],
    { timeoutMs: 15 * 60_000 },
  );

  if (result.exitCode === 2) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-1)[0];
    throw new InstallChecksumError('SHA256SUMS', detail || 'unknown', WORKER_ASSET);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `remote install failed with exit code ${result.exitCode ?? 'unknown'}: ${(result.stderr || result.stdout).trim().slice(-800)}`,
    );
  }

  const line = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (!line) {
    throw new Error('remote install did not report a result; the install state was left unchanged');
  }
  const parsed = JSON.parse(line.slice(RESULT_PREFIX.length));
  if (!parsed.ok) throw new Error('remote install reported failure');
  return {
    ...parsed,
    prefix,
    tag: release.tag,
    output: result.stdout,
    stderr: result.stderr,
  };
}

export async function installRelease({ ctx, release, prefix, fetchImpl = fetch, runNpm, log }) {
  if (ctx.kind === 'ssh') {
    return installReleaseRemote({ ctx, release, prefix, log });
  }
  return installReleaseLocal({ release, prefix, fetchImpl, runNpm, log });
}
