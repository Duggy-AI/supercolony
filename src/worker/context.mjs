import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from './process.mjs';
import { buildRemoteCommand, buildSshArgs, quotePosix, validatePort, validateSshHost } from './ssh.mjs';

export function colonyHome(options = {}) {
  return path.resolve(expandHome(options.home ?? '~/.super-colony', os.homedir()));
}

export function statePath(home) {
  return path.join(home, 'worker-state.json');
}

export function targetKey(target) {
  if (target.kind === 'local') return 'local';
  return `ssh:${target.host}:${target.port ?? 22}`;
}

export function emptyState() {
  return { targets: {}, registrations: {} };
}

export function readState(home) {
  const file = statePath(home);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`worker state is not valid JSON: ${file}`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.targets ||
    typeof parsed.targets !== 'object' ||
    !parsed.registrations ||
    typeof parsed.registrations !== 'object'
  ) {
    throw new Error(`worker state has an unexpected shape: ${file}`);
  }
  return parsed;
}

export function writeState(home, state) {
  fs.mkdirSync(home, { recursive: true });
  const file = statePath(home);
  const tmp = `${file}.colony-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

export function updateTargetState(home, key, patch) {
  const state = readState(home);
  state.targets[key] = { ...(state.targets[key] ?? {}), ...patch };
  writeState(home, state);
  return state.targets[key];
}

export function expandHome(value, homeDir) {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

export function validateRemotePath(value, remoteHome, label) {
  const expanded = expandTildePosix(String(value), remoteHome);
  if (!expanded.startsWith('/')) {
    throw new Error(`${label} must be an absolute path on the remote host: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(expanded)) {
    throw new Error(`${label} contains control characters`);
  }
  return expanded.length > 1 ? expanded.replace(/\/+$/, '') : expanded;
}

export function normalizeLocalPath(value) {
  const resolved = path.resolve(value);
  if (/[\u0000]/.test(resolved)) throw new Error('path contains a NUL byte');
  return resolved;
}

export function expandTildePosix(value, homeDir) {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return posixJoin(homeDir, value.slice(2));
  return value;
}

export function posixJoin(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part, index) => (index === 0 ? String(part).replace(/\/+$/, '') : String(part).replace(/^\/+|\/+$/g, '')))
    .filter((part, index) => index === 0 || part !== '')
    .join('/');
}

export function buildImdInvocation({ kind, prefix }) {
  if (kind === 'local' && process.platform === 'win32') {
    return {
      command: process.execPath,
      args: [path.join(prefix, 'node_modules', '@identitymd', 'worker', 'dist', 'cli.js')],
      display: path.join(prefix, 'node_modules', '@identitymd', 'worker', 'dist', 'cli.js'),
    };
  }
  return {
    command: posixJoin(prefix, 'bin', 'imd'),
    args: [],
    display: posixJoin(prefix, 'bin', 'imd'),
  };
}

export function makeTarget(options) {
  if (!options.ssh) {
    return { kind: 'local', host: null, identity: null, port: null };
  }
  return {
    kind: 'ssh',
    host: validateSshHost(options.ssh),
    identity: options.identity ? validateLocalIdentity(options.identity) : null,
    port: validatePort(options.port),
  };
}

function validateLocalIdentity(identity) {
  const expanded = expandHome(String(identity), os.homedir());
  if (/[\u0000]/.test(expanded)) throw new Error('--identity contains a NUL byte');
  return expanded;
}

export async function resolveRemoteHome(target) {
  const result = await runProcess({
    command: 'ssh',
    args: buildSshArgs(target, buildRemoteCommand('sh', ['-c', 'printf "%s" "$HOME"'])),
    timeoutMs: 20_000,
  });
  const home = result.stdout.trim();
  if (result.exitCode !== 0 || !home.startsWith('/')) {
    throw new Error(
      `could not determine the home directory on ${target.host}: ${result.stderr.trim() || result.stdout.trim() || 'ssh failed'}`,
    );
  }
  return home.replace(/\/+$/, '');
}

/**
 * Resolve the local/remote target, install prefix, optional IDENTITYMD_HOME,
 * and the explicit imd invocation.  Prefix and worker home are persisted by
 * deploy so update/pair/service never silently drift to another install.
 */
export async function resolveContext(options = {}, { needImd = true } = {}) {
  const home = colonyHome(options);
  const target = makeTarget(options);
  const key = targetKey(target);
  const state = readState(home);
  const saved = state.targets[key] ?? {};
  if (target.kind === 'ssh' && options.identity === undefined && saved.identity) target.identity = validateLocalIdentity(saved.identity);

  const remoteHome =
    target.kind === 'ssh' ? saved.remoteHome ?? (await resolveRemoteHome(target)) : os.homedir();

  const defaultPrefix =
    target.kind === 'ssh'
      ? posixJoin(remoteHome, '.super-colony', 'worker', 'prefix')
      : path.join(home, 'worker', 'prefix');

  const prefixRaw = options.prefix ?? saved.prefix ?? defaultPrefix;
  const prefix =
    target.kind === 'ssh'
      ? validateRemotePath(prefixRaw, remoteHome, '--prefix')
      : normalizeLocalPath(expandHome(String(prefixRaw), os.homedir()));

  const workerHomeRaw = options.workerHome ?? saved.workerHome ?? null;
  let workerHome = null;
  if (workerHomeRaw) {
    workerHome =
      target.kind === 'ssh'
        ? validateRemotePath(workerHomeRaw, remoteHome, '--worker-home')
        : normalizeLocalPath(expandHome(String(workerHomeRaw), os.homedir()));
  }

  const imd = buildImdInvocation({ kind: target.kind, prefix });
  const ctx = {
    ...target,
    key,
    home,
    remoteHome,
    prefix,
    workerHome,
    configPath:
      target.kind === 'ssh'
        ? posixJoin(workerHome ?? posixJoin(remoteHome, '.identitymd'), 'config.json')
        : path.join(workerHome ?? path.join(os.homedir(), '.identitymd'), 'config.json'),
    imd,
    imdPath: imd.display,
    env: workerHome ? { IDENTITYMD_HOME: workerHome } : {},
    state,
    saved,
  };

  if (needImd) await assertImd(ctx);
  return ctx;
}

export async function assertImd(ctx) {
  if (ctx.kind === 'local') {
    const target =
      process.platform === 'win32' ? ctx.imd.display : ctx.imd.command;
    const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
    try {
      fs.accessSync(target, mode);
      return;
    } catch {
      throw new Error(
        `imd not found at ${ctx.imdPath}; run "colony worker deploy" (or pass --prefix) first`,
      );
    }
  }
  const script = `test -x ${quotePosix(ctx.imd.command)}`;
  const result = await runProcess({
    command: 'ssh',
    args: buildSshArgs(ctx, buildRemoteCommand('sh', ['-c', script])),
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `imd not found at ${ctx.imdPath} on ${ctx.host}; run "colony worker deploy --ssh ${ctx.host}" first`,
    );
  }
}

export async function runImd(ctx, args, { stdio = 'pipe', input, timeoutMs, tty = false, terminal = false } = {}) {
  if (ctx.kind === 'local') {
    return runProcess({
      command: ctx.imd.command,
      args: [...ctx.imd.args, ...args],
      env: { ...process.env, ...ctx.env },
      stdio,
      input,
      timeoutMs,
      terminal,
    });
  }

  const envArgs = Object.entries(ctx.env).map(([name, value]) => `${name}=${value}`);
  const remoteArgs = [...ctx.imd.args, ...args];
  const remote =
    envArgs.length > 0
      ? buildRemoteCommand('env', [...envArgs, ctx.imd.command, ...remoteArgs])
      : buildRemoteCommand(ctx.imd.command, remoteArgs);
  return runProcess({
    command: 'ssh',
    args: buildSshArgs(ctx, remote, { tty }),
    env: process.env,
    stdio,
    input,
    timeoutMs,
    terminal,
  });
}

/** Execute a Node script on the worker host, with the script on stdin. */
export async function runNodeStdin(ctx, source, args = [], { stdio = 'pipe', timeoutMs } = {}) {
  if (ctx.kind === 'local') {
    return runProcess({
      command: process.execPath,
      args: ['--input-type=commonjs', '-', ...args],
      env: process.env,
      stdio,
      input: source,
      timeoutMs,
    });
  }
  const remote = buildRemoteCommand('node', ['--input-type=commonjs', '-', ...args]);
  return runProcess({
    command: 'ssh',
    args: buildSshArgs(ctx, remote),
    env: process.env,
    stdio,
    input: source,
    timeoutMs,
  });
}

/** Execute a Node script on the worker host, with JSON supplied on stdin. */
export async function runNodeEval(ctx, source, { input, args = [], timeoutMs = 60_000 } = {}) {
  if (ctx.kind === 'local') {
    return runProcess({
      command: process.execPath,
      args: ['--input-type=commonjs', '-e', source, ...args],
      env: process.env,
      input,
      timeoutMs,
    });
  }
  const remote = buildRemoteCommand('node', ['--input-type=commonjs', '-e', source, ...args]);
  return runProcess({
    command: 'ssh',
    args: buildSshArgs(ctx, remote),
    env: process.env,
    input,
    timeoutMs,
  });
}
