import { runImd } from './context.mjs';
import { print } from '../shared.mjs';

const SKILL_ACTIONS = ['list', 'add', 'remove'];
const TOOL_ACTIONS = ['list', 'add', 'key', 'forget', 'remove'];
const RPC_ACTIONS = ['list', 'add', 'remove'];

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} contains control characters`);
  if (text.startsWith('-')) throw new Error(`${label} must not start with "-": ${text}`);
  return text;
}

function requireChainId(value) {
  const text = requireText(value, 'chain id');
  if (!/^[1-9][0-9]{0,15}$/.test(text)) throw new Error(`invalid chain id: ${value}`);
  return text;
}

function appendRepeated(args, flag, values) {
  for (const value of values ?? []) {
    const text = String(value);
    // The official parser is Node's parseArgs: a separate value that starts
    // with "-" is ambiguous, so the official equals form is required.
    if (text.startsWith('-')) args.push(`${flag}=${text}`);
    else args.push(flag, text);
  }
}

function requireEnvName(value) {
  const text = String(value ?? '');
  if (!/^[A-Z][A-Z0-9_]*$/.test(text)) {
    throw new Error(
      'tools add --env takes a variable NAME only, not NAME=value; ' +
        'store its value with "colony worker tools key NAME" (hidden input)',
    );
  }
  return text;
}

export function buildWhoamiArgs() {
  return ['whoami'];
}

export function buildUnlinkArgs() {
  return ['unlink'];
}

/**
 * `imd skills` lists, `imd skills add <id>` opts in and
 * `imd skills remove <id>` opts out.  These map one-to-one.
 */
export function buildSkillsArgs(action = 'list', id) {
  if (!SKILL_ACTIONS.includes(action)) throw new Error(`unknown skills action: ${action}`);
  if (action === 'list') return ['skills', 'list'];
  return ['skills', action, requireText(id, 'skill id')];
}

/**
 * `imd tools add <id> --command <path> [--arg X ...] [--env NAME ...]
 * [--probe X ...] [--enable method ...]` is the official non-interactive
 * form.  With no id, the official wizard asks the questions itself.
 */
export function buildToolsArgs(action = 'list', options = {}) {
  if (!TOOL_ACTIONS.includes(action)) throw new Error(`unknown tools action: ${action}`);
  if (action === 'list') return ['tools', 'list'];

  const id = options.id === undefined ? undefined : requireText(options.id, 'tool id');
  if (action === 'add') {
    const hasFlags = Boolean(options.command)
      || (options.args?.length ?? 0) > 0
      || (options.env?.length ?? 0) > 0
      || (options.probe?.length ?? 0) > 0
      || (options.enable?.length ?? 0) > 0;
    if (!id) {
      if (hasFlags) throw new Error('tools add options require a tool id');
      return ['tools', 'add'];
    }
    if (!options.command) {
      throw new Error('tools add requires --command, the absolute path of an installed stdio MCP server');
    }
    if (!options.enable || options.enable.length === 0) {
      throw new Error('tools add requires at least one --enable <method>');
    }
    const env = (options.env ?? []).map(requireEnvName);
    const args = ['tools', 'add', id, '--command', String(options.command)];
    appendRepeated(args, '--arg', options.args);
    appendRepeated(args, '--env', env);
    appendRepeated(args, '--probe', options.probe);
    appendRepeated(args, '--enable', options.enable);
    return args;
  }

  if (!id) throw new Error(`tools ${action} requires a name or id`);
  return ['tools', action, id];
}

/** `imd rpc add <chain-id>` asks for the URL without echo; it is never an argv value. */
export function buildRpcArgs(action = 'list', chainId) {
  if (!RPC_ACTIONS.includes(action)) throw new Error(`unknown rpc action: ${action}`);
  if (action === 'list') return ['rpc', 'list'];
  return ['rpc', action, requireChainId(chainId)];
}

export function assertInteractiveAllowed({
  json,
  stdinTTY = process.stdin.isTTY,
  stdoutTTY = process.stdout.isTTY,
  label = 'this command',
} = {}) {
  if (json) {
    throw new Error(`${label} prompts for hidden input; --json is not supported`);
  }
  if (!stdinTTY || !stdoutTTY) {
    throw new Error(`${label} needs an interactive terminal; run it directly on a TTY (never pass secrets as arguments)`);
  }
}

/**
 * Run one official management command.  Interactive commands keep the
 * official hidden-input prompts by inheriting stdio; SSH gets a remote TTY.
 * Non-interactive --json captures official output and keeps stdout pure JSON.
 */
export async function runManagement(ctx, args, options = {}, { run = runImd, interactive = false } = {}) {
  if (interactive) {
    assertInteractiveAllowed({ json: options.json, label: `worker ${args.slice(0, 2).join(' ')}` });
    return run(ctx, args, { stdio: 'inherit', tty: ctx.kind === 'ssh' });
  }

  if (options.json) {
    const result = await run(ctx, args, { stdio: 'pipe' });
    print(
      {
        exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      },
      options,
    );
    return result;
  }

  return run(ctx, args, { stdio: 'inherit', terminal: true });
}
