import { resolveNpmInvocation } from './install.mjs';
import { runNodeEval } from './context.mjs';
import { runProcess, spawnErrorMessage } from './process.mjs';

const PROBE = `
const { execFileSync } = require('node:child_process');
function probe(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
      shell: false,
    }).trim().split(/\\r?\\n/)[0];
    return { ok: true, version: out || null };
  } catch {
    return { ok: false, version: null };
  }
}
process.stdout.write(JSON.stringify({
  node: { ok: true, version: process.versions.node },
  npm: probe('npm', ['--version']),
  git: probe('git', ['--version']),
  curl: probe('curl', ['--version']),
  forge: probe('forge', ['--version']),
  claude: probe('claude', ['--version']),
  codex: probe('codex', ['--version']),
  platform: process.platform,
  arch: process.arch,
}) + '\\n');
`;

async function probeCommand(command, args, run) {
  try {
    const result = await run({ command, args });
    if (result.exitCode !== 0) return { ok: false, version: null };
    return { ok: true, version: (result.stdout || '').trim().split(/\r?\n/)[0] || null };
  } catch (error) {
    return { ok: false, version: null, error: spawnErrorMessage(command, error) };
  }
}

export async function probeLocal({ run = runProcess } = {}) {
  const npm = resolveNpmInvocation();
  return {
    node: { ok: true, version: process.versions.node },
    npm: await probeCommand(npm.command, [...npm.args, '--version'], run),
    git: await probeCommand('git', ['--version'], run),
    curl: await probeCommand('curl', ['--version'], run),
    forge: await probeCommand('forge', ['--version'], run),
    claude: await probeCommand('claude', ['--version'], run),
    codex: await probeCommand('codex', ['--version'], run),
    platform: process.platform,
    arch: process.arch,
  };
}

export async function probeRemote(ctx, { runNode = runNodeEval } = {}) {
  const result = await runNode(ctx, PROBE, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `cannot check prerequisites on ${ctx.host}: Node.js 22+ is required there first (${(result.stderr || result.stdout).trim() || 'node probe failed'})`,
    );
  }
  const line = result.stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .reverse()
    .find((candidate) => candidate.startsWith('{'));
  if (!line) throw new Error(`prerequisite probe on ${ctx.host} returned no data`);
  return JSON.parse(line);
}

export function evaluatePreflight(probe, { remote = false } = {}) {
  const checks = [];
  const errors = [];
  const warnings = [];

  const nodeMajor = Number(String(probe.node?.version ?? '0').split('.')[0]);
  const nodeOk = probe.node?.ok === true && Number.isFinite(nodeMajor) && nodeMajor >= 22;
  checks.push({
    name: 'node',
    required: true,
    ok: nodeOk,
    detail: probe.node?.version ?? 'not found',
    fix: nodeOk ? null : 'install Node.js 22 or newer (24 recommended); colony does not install system packages',
  });
  if (!nodeOk) errors.push('Node.js 22+ is required');

  checks.push({
    name: 'npm',
    required: true,
    ok: probe.npm?.ok === true,
    detail: probe.npm?.version ?? 'not found',
    fix: probe.npm?.ok ? null : 'install npm with Node.js; colony does not install system packages',
  });
  if (!probe.npm?.ok) errors.push('npm is required');

  for (const [name, fix] of [
    ['git', 'install git; the worker needs it to prepare task repositories'],
    ['curl', 'install curl; the official worker docs list it as a prerequisite'],
  ]) {
    const ok = probe[name]?.ok === true;
    checks.push({ name, ok, detail: probe[name]?.version ?? 'not found', fix: ok ? null : fix });
    if (!ok) warnings.push(`${name} is missing`);
  }

  const forgeOk = probe.forge?.ok === true;
  checks.push({
    name: 'forge',
    ok: forgeOk,
    detail: probe.forge?.version ?? 'not found',
    fix: forgeOk ? null : 'Foundry v1.8.3 is required for contract work; install it separately',
  });
  if (!forgeOk) warnings.push('Foundry/forge is missing: contract work will be unavailable');

  const runtimeOk = probe.claude?.ok === true || probe.codex?.ok === true;
  checks.push({
    name: 'runtime',
    ok: runtimeOk,
    detail: [probe.claude?.ok ? `claude ${probe.claude.version ?? ''}`.trim() : null, probe.codex?.ok ? `codex ${probe.codex.version ?? ''}`.trim() : null]
      .filter(Boolean)
      .join(', ') || 'neither claude nor codex found',
    fix: runtimeOk ? null : 'install and sign in to Claude Code or Codex before pairing/starting',
  });
  if (!runtimeOk) warnings.push('no Claude Code or Codex runtime found: the worker cannot take tasks');

  if (remote && probe.platform !== 'linux') {
    errors.push(`remote worker must be Linux (probe reported ${probe.platform})`);
    checks.push({ name: 'platform', required: true, ok: false, detail: probe.platform, fix: 'use a Linux VPS/WSL worker' });
  } else {
    checks.push({ name: 'platform', ok: true, detail: `${probe.platform}/${probe.arch}` });
  }
  if (!remote && probe.platform === 'win32') {
    warnings.push('Windows worker limits runtime read-jail; use Linux/WSL for full contract work');
  }

  return { ok: errors.length === 0, checks, errors, warnings };
}

export async function preflight(ctx, { run = runProcess, runNode = runNodeEval } = {}) {
  const probe = ctx.kind === 'ssh' ? await probeRemote(ctx, { runNode }) : await probeLocal({ run });
  return { probe, ...evaluatePreflight(probe, { remote: ctx.kind === 'ssh' }) };
}

export function formatPreflight(result) {
  const lines = [];
  for (const check of result.checks) {
    // Missing forge/runtime/git/curl is reported but does not block an install;
    // doctor is the run-capability check.  Only `required` checks say FAIL.
    const level = check.ok ? 'ok  ' : check.required ? 'FAIL' : 'warn';
    lines.push(`${level} ${check.name}: ${check.detail}`);
    if (!check.ok && check.fix) lines.push(`     ${check.fix}`);
  }
  for (const warning of result.warnings) lines.push(`warn ${warning}`);
  return lines.join('\n');
}
