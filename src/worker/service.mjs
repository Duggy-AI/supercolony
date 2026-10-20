import { runImd } from './context.mjs';

export const RUNTIMES = ['claude', 'codex'];
export const SERVICE_ACTIONS = ['install', 'start', 'stop', 'restart', 'status', 'logs', 'uninstall'];

export function validateRuntime(runtime) {
  if (runtime === undefined || runtime === null) return undefined;
  const text = String(runtime);
  if (!RUNTIMES.includes(text)) throw new Error(`--runtime must be ${RUNTIMES.join(' or ')}`);
  return text;
}

export function validateConcurrency(concurrency) {
  if (concurrency === undefined || concurrency === null) return undefined;
  const text = String(concurrency);
  if (!/^[1-4]$/.test(text)) throw new Error('--concurrency must be between 1 and 4');
  return text;
}

/**
 * Map colony's service surface onto the official `imd service ...` commands.
 * The daemon itself is always the official worker; colony only invokes it.
 */
export function buildServiceArgs(action, options = {}) {
  if (!SERVICE_ACTIONS.includes(action)) {
    throw new Error(`unknown service action: ${action}`);
  }
  const runtime = validateRuntime(options.runtime);
  const concurrency = validateConcurrency(options.concurrency);

  if (action === 'install') {
    const args = ['service', 'install'];
    if (options.boot) args.push('--boot');
    if (options.autoUpdate) args.push('--auto-update');
    if (runtime) args.push('--runtime', runtime);
    if (concurrency) args.push('--concurrency', concurrency);
    return args;
  }
  if (action === 'restart') {
    const args = ['service', 'restart'];
    if (runtime) args.push('--runtime', runtime);
    return args;
  }
  if (action === 'logs') {
    const args = ['service', 'logs'];
    if (options.follow) args.push('--follow');
    return args;
  }
  return ['service', action];
}

export function buildRunArgs(options = {}) {
  const runtime = validateRuntime(options.runtime);
  const concurrency = validateConcurrency(options.concurrency);
  const args = ['start'];
  if (options.server) args.push('--server', String(options.server));
  if (runtime) args.push('--runtime', runtime);
  if (concurrency) args.push('--concurrency', concurrency);
  if (options.autoUpdate) args.push('--auto-update');
  return args;
}

export function buildDoctorArgs(options = {}) {
  const runtime = validateRuntime(options.runtime);
  return runtime ? ['doctor', '--runtime', runtime] : ['doctor'];
}

export function exitCodeOf(result) {
  return Number.isInteger(result?.exitCode) ? result.exitCode : 1;
}

export async function runService(ctx, action, options = {}, { run = runImd, stdio } = {}) {
  const args = buildServiceArgs(action, options);
  return run(ctx, args, stdio ? { stdio } : undefined);
}

export async function runForeground(ctx, options = {}) {
  return runImd(ctx, buildRunArgs(options), { stdio: 'inherit', terminal: true });
}

export async function runDoctor(ctx, options = {}, { run = runImd, stdio = 'inherit', terminal = false } = {}) {
  return run(ctx, buildDoctorArgs(options), { stdio, terminal });
}

export function extractDeviceKey(text) {
  const matches = String(text ?? '').match(/[0-9a-fA-F]{64}/g) ?? [];
  const unique = [...new Set(matches.map((value) => value.toLowerCase()))];
  if (unique.length !== 1) {
    throw new Error(`could not read a single device key from imd whoami${unique.length > 1 ? ' (multiple keys)' : ''}`);
  }
  return unique[0];
}

export async function assembleStatus({
  ctx,
  api,
  request,
  run = runImd,
  serviceResult,
  whoamiResult,
} = {}) {
  const service =
    serviceResult ?? (await run(ctx, buildServiceArgs('status'), { timeoutMs: 30_000 }));
  const serviceInfo = {
    command: `${ctx.imdPath} service status`,
    exitCode: Number.isInteger(service.exitCode) ? service.exitCode : null,
    stdout: service.stdout ?? '',
    stderr: service.stderr ?? '',
  };

  let deviceKey = null;
  let standing = null;
  let standingError = null;
  try {
    const who = whoamiResult ?? (await run(ctx, ['whoami'], { timeoutMs: 20_000 }));
    if (who.exitCode !== 0) {
      throw new Error((who.stderr || who.stdout || 'imd whoami failed').trim());
    }
    deviceKey = extractDeviceKey(who.stdout);
    const response = await request(api, `/workers/${deviceKey}/standing`, {
      allowStatuses: [404],
    });
    if (response.status === 404) {
      standingError = 'HTTP 404: standing not found for this device key';
    } else {
      standing = response.data;
    }
  } catch (error) {
    standingError = error.message;
  }

  return {
    target: { kind: ctx.kind, host: ctx.host ?? null, port: ctx.port ?? null },
    service: serviceInfo,
    deviceKey,
    standing,
    standingError,
  };
}
