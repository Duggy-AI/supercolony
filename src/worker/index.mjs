import * as shared from '../shared.mjs';
import { terminalText, writeDiagnostic } from '../lib/terminal-text.mjs';
import { resolveContext, runImd } from './context.mjs';
import { buildDeployPlan, deployTarget } from './deploy.mjs';
import { runPair } from './pair.mjs';
import { runRegister } from './register.mjs';
import {
  assertInteractiveAllowed,
  buildRpcArgs,
  buildSkillsArgs,
  buildToolsArgs,
  buildUnlinkArgs,
  buildWhoamiArgs,
  runManagement,
} from './manage.mjs';
import { resolveRelease } from './release.mjs';
import { preflight, formatPreflight } from './preflight.mjs';
import {
  assembleStatus,
  buildServiceArgs,
  exitCodeOf,
  runDoctor,
  runForeground,
} from './service.mjs';

const stderr = (line) => writeDiagnostic(`${line}\n`);

function action(run) {
  return async (...args) => {
    // Commander passes (...positionalArgs, options, command) to an action.
    // The last value is always the Command instance; using it gives us
    // optsWithGlobals() plus the parsed positionals on command.args.
    const command = args.at(-1);
    try {
      await run(command);
    } catch (error) {
      stderr(error?.message ?? String(error));
      process.exitCode = 1;
    }
  };
}

function mergedOptions(command) {
  return { ...command.optsWithGlobals(), ...command.opts() };
}

function collect(value, previous = []) {
  return [...previous, value];
}

async function runManagementCommand(command, { args, interactive = false }) {
  const opts = mergedOptions(command);
  if (interactive) {
    assertInteractiveAllowed({
      json: opts.json,
      label: `worker ${args.slice(0, 2).join(' ')}`,
    });
  }
  const ctx = await resolveContext(opts);
  const result = await runManagement(ctx, args, opts, { interactive });
  process.exitCode = exitCodeOf(result);
}

function withTargetOptions(command) {
  return command
    .option('--ssh <host>', 'run on a remote Linux worker over system ssh')
    .option('--identity <path>', 'ssh identity file (with --ssh)')
    .option('--port <port>', 'ssh port (with --ssh)')
    .option('--worker-home <dir>', 'set IDENTITYMD_HOME to isolate this worker profile')
    .option('--prefix <dir>', 'colony-managed npm install prefix for the worker');
}

async function printPreflight(ctx) {
  const result = await preflight(ctx);
  stderr(formatPreflight(result));
  if (!result.ok) {
    throw new Error('prerequisites are missing; colony does not install system packages');
  }
  return result;
}

async function deployOrUpdate(command, { update = false } = {}) {
  const opts = mergedOptions(command);
  const ctx = await resolveContext(opts, { needImd: update });
  if (update && !opts.prefix && !ctx.saved.prefix) {
    throw new Error(
      'no colony-managed worker install is recorded for this target; run "colony worker deploy" first or pass --prefix',
    );
  }

  const release = await resolveRelease({ version: opts.version });
  const plan = buildDeployPlan({ ctx, release });
  if (opts.dryRun) {
    shared.print(plan, opts);
    return;
  }

  await printPreflight(ctx);
  const result = await deployTarget({
    ctx,
    release,
    log: (line) => stderr(line),
  });
  if (update) stderr('update installed; restart the service or foreground worker to run the new build');
  shared.print(
    {
      ok: true,
      target: plan.target,
      release: { tag: release.tag, version: release.version },
      install: { prefix: result.prefix, imdPath: result.imdPath, sha256: result.sha256 },
      next: update ? 'restart the service to run the new build' : 'pair, register, then install the service',
    },
    opts,
  );
}

function servicePassthrough(actionName) {
  return action(async (command) => {
    const opts = mergedOptions(command);
    const ctx = await resolveContext(opts);
    const args = buildServiceArgs(actionName, opts);
    const result = await runImd(ctx, args, {
      stdio: opts.json ? 'pipe' : 'inherit',
      terminal: !opts.json,
    });
    if (opts.json) {
      shared.print(
        { command: `${ctx.imdPath} ${args.join(' ')}`, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
        opts,
      );
    }
    process.exitCode = exitCodeOf(result);
  });
}

export function registerWorkerCommands(program) {
  const worker = program
    .command('worker')
    .description('deploy, pair, register and operate an official IdentityMD worker')
    .addHelpText(
      'after',
      [
        '',
        'Target: local by default, or a remote Linux host with --ssh <host>.',
        'start/stop/restart are official `imd service ...` commands.',
        'run is the foreground official `imd start` command.',
        'deploy installs a verified release only; it never pairs, registers or starts the worker.',
        '--auto-update (service install/run) updates in place inside the colony-managed prefix.',
      ].join('\n'),
    );

  withTargetOptions(
    worker
      .command('deploy')
      .description('install the latest (or --version) verified official worker release; does not pair or start')
      .option('--version <tag>', 'GitHub release tag or version to install')
      .option('--dry-run', 'print the exact install plan without downloading or running npm'),
  ).action(action((command) => deployOrUpdate(command)));

  withTargetOptions(
    worker
      .command('update')
      .description('reinstall the official worker through the same SHA-256 verified path and prefix')
      .option('--version <tag>', 'release tag or version to install (default: latest)')
      .option('--dry-run', 'print the exact update plan without downloading or running npm'),
  ).action(action((command) => deployOrUpdate(command, { update: true })));

  withTargetOptions(
    worker
      .command('pair')
      .description('pair this worker with an NFT owner wallet using local EIP-712 signing')
      .option('--token-id <id>', 'token id to pair when the wallet holds more than one'),
  ).action(
    action(async (command) => {
      const opts = mergedOptions(command);
      const ctx = await resolveContext(opts);
      const result = await runPair({ ctx, options: opts, shared, log: stderr });
      shared.print(
        {
          ok: true,
          wallet: result.wallet,
          tokenId: result.tokenId,
          deviceKey: result.deviceKey,
          agentId: result.agentId,
          registered: result.registered,
          expiresAt: result.expiresAt,
          config: result.config,
        },
        opts,
      );
      if (!result.registered) stderr(`token ${result.tokenId} is not registered yet; run: colony worker register --token-id ${result.tokenId}`);
    }),
  );

  withTargetOptions(
    worker
      .command('register')
      .description('register the paired token as an ERC-8004 agent (explicit on-chain transaction)')
      .option('--token-id <id>', 'token id to register (defaults to the worker config tokenId)')
      .option('--tx-hash <hash>', 'resume polling an already-sent registration transaction'),
  ).action(
    action(async (command) => {
      const opts = mergedOptions(command);
      const ctx = await resolveContext(opts, { needImd: false });
      const result = await runRegister({ ctx, options: opts, shared, log: stderr });
      shared.print({ ok: true, ...result, plan: result.plan ?? null }, opts);
    }),
  );

  withTargetOptions(
    worker
      .command('run')
      .description('run the official `imd start` in the foreground; Ctrl+C stops it')
      .option('--runtime <runtime>', 'claude or codex')
      .option('--concurrency <n>', '1-4')
      .option('--auto-update', 'let the official worker update itself in place')
      .option('--server <url>', 'official worker server URL'),
  ).action(
    action(async (command) => {
      const opts = mergedOptions(command);
      const ctx = await resolveContext(opts);
      if (opts.json) stderr('run streams the foreground worker; --json has no effect');
      const result = await runForeground(ctx, opts);
      process.exitCode = exitCodeOf(result);
    }),
  );

  withTargetOptions(worker.command('start').description('start the installed official worker service'))
    .action(servicePassthrough('start'));

  withTargetOptions(worker.command('stop').description('stop the installed official worker service'))
    .action(servicePassthrough('stop'));

  withTargetOptions(
    worker
      .command('restart')
      .description('restart the installed official worker service')
      .option('--runtime <runtime>', 'change runtime while restarting (claude or codex)'),
  ).action(servicePassthrough('restart'));

  withTargetOptions(
    worker
      .command('status')
      .description('raw official service status plus public worker standing'),
  ).action(
    action(async (command) => {
      const opts = mergedOptions(command);
      const ctx = await resolveContext(opts);
      const status = await assembleStatus({
        ctx,
        api: opts.api ?? 'https://api.imd.fun',
        request: shared.request,
      });
      process.exitCode = exitCodeOf({ exitCode: status.service.exitCode });
      if (opts.json) {
        shared.print(status, opts);
        return;
      }
      process.stdout.write(terminalText(status.service.stdout));
      writeDiagnostic(status.service.stderr);
      if (status.standing) shared.print(status.standing, { json: true });
      else if (status.standingError) stderr(`standing unavailable: ${status.standingError}`);
    }),
  );

  withTargetOptions(
    worker
      .command('logs')
      .description('read official worker service logs; --follow streams filtered output')
      .option('-f, --follow', 'stream logs (terminal controls filtered, never JSON)'),
  ).action(
    action(async (command) => {
      const opts = mergedOptions(command);
      const ctx = await resolveContext(opts);
      const args = buildServiceArgs('logs', opts);
      if (opts.follow) {
        if (opts.json) stderr('logs --follow streams logs; --json has no effect');
        const result = await runImd(ctx, args, { stdio: 'inherit', terminal: true });
        process.exitCode = exitCodeOf(result);
        return;
      }
      const result = await runImd(ctx, args, { stdio: 'pipe' });
      if (opts.json) {
        shared.print({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, opts);
      } else {
        process.stdout.write(terminalText(result.stdout));
        writeDiagnostic(result.stderr);
      }
      process.exitCode = exitCodeOf(result);
    }),
  );

  withTargetOptions(
    worker
      .command('whoami')
      .description("print this machine's official worker device key"),
  ).action(action((command) => runManagementCommand(command, { args: buildWhoamiArgs() })));

  withTargetOptions(
    worker
      .command('unlink')
      .description("revoke this machine's enrollment so its NFT can be paired elsewhere")
      .addHelpText(
        'after',
        [
          '',
          'Revokes server enrollment and clears local wallet/token binding.',
          'Keeps the device key; the NFT can then be paired elsewhere.',
        ].join('\n'),
      ),
  ).action(action((command) => runManagementCommand(command, { args: buildUnlinkArgs() })));

  const skills = worker
    .command('skills')
    .description('list the skills the network offers, or turn one off/on for this machine');

  withTargetOptions(skills.command('list').description('list offered skills and what is on here')).action(
    action((command) => runManagementCommand(command, { args: buildSkillsArgs('list') })),
  );
  withTargetOptions(
    skills
      .command('add')
      .description('turn a skill back on (official `imd skills add <id>`)')
      .argument('<id>', 'skill id'),
  ).action(
    action((command) =>
      runManagementCommand(command, { args: buildSkillsArgs('add', command.args[0]) }),
    ),
  );
  withTargetOptions(
    skills
      .command('remove')
      .description('turn a skill off on this machine (official `imd skills remove <id>`)')
      .argument('<id>', 'skill id'),
  ).action(
    action((command) =>
      runManagementCommand(command, { args: buildSkillsArgs('remove', command.args[0]) }),
    ),
  );

  const tools = worker
    .command('tools')
    .description('list configured tools, or add/remove one and store/forget its keys');

  withTargetOptions(tools.command('list').description('list configured tools and whether each is ready')).action(
    action((command) => runManagementCommand(command, { args: buildToolsArgs('list') })),
  );
  withTargetOptions(
    tools
      .command('add')
      .description('declare an installed stdio MCP server; no id starts the official wizard')
      .argument('[id]', 'tool id')
      .option('--command <path>', 'absolute path of the installed stdio MCP server')
      .option('--arg <value>', 'server argument, never a secret (repeatable)', collect, [])
      .option('--env <NAME>', 'environment variable NAME only, never NAME=value (repeatable)', collect, [])
      .option('--probe <value>', 'version-probe argument (repeatable; official default --version)', collect, [])
      .option('--enable <method>', 'MCP method an assignment may call (repeatable)', collect, [])
      .addHelpText(
        'after',
        [
          '',
          '--env takes names only, e.g. OPENAI_API_KEY; the official worker stores names, not values.',
          'Store a value without echo: colony worker tools key OPENAI_API_KEY',
          'Do not put secrets in --arg or any other argv value.',
        ].join('\n'),
      ),
  ).action(
    action((command) => {
      const opts = mergedOptions(command);
      const id = command.args[0];
      return runManagementCommand(command, {
        args: buildToolsArgs('add', {
          id,
          command: opts.command,
          args: opts.arg,
          env: opts.env,
          probe: opts.probe,
          enable: opts.enable,
        }),
        interactive: !id,
      });
    }),
  );
  withTargetOptions(
    tools
      .command('key')
      .description("store a key's value without echo (official `imd tools key <NAME>`)")
      .argument('<NAME>', 'environment variable name'),
  ).action(
    action((command) =>
      runManagementCommand(command, { args: buildToolsArgs('key', { id: command.args[0] }), interactive: true }),
    ),
  );
  withTargetOptions(
    tools
      .command('forget')
      .description('remove a stored key value (official `imd tools forget <NAME>`)')
      .argument('<NAME>', 'environment variable name'),
  ).action(
    action((command) =>
      runManagementCommand(command, { args: buildToolsArgs('forget', { id: command.args[0] }) }),
    ),
  );
  withTargetOptions(
    tools
      .command('remove')
      .description('remove a configured tool (official `imd tools remove <id>`)')
      .argument('<id>', 'tool id'),
  ).action(
    action((command) =>
      runManagementCommand(command, { args: buildToolsArgs('remove', { id: command.args[0] }) }),
    ),
  );

  const rpc = worker
    .command('rpc')
    .description('list your own RPC endpoints, or add/remove one per chain');

  withTargetOptions(rpc.command('list').description('list own RPC endpoints; host only')).action(
    action((command) => runManagementCommand(command, { args: buildRpcArgs('list') })),
  );
  withTargetOptions(
    rpc
      .command('add')
      .description('add or replace a chain endpoint; the official prompt types the URL without echo')
      .argument('<chain-id>', 'EVM chain id'),
  ).action(
    action((command) =>
      runManagementCommand(command, { args: buildRpcArgs('add', command.args[0]), interactive: true }),
    ),
  );
  withTargetOptions(
    rpc
      .command('remove')
      .description('remove your own endpoint for a chain')
      .argument('<chain-id>', 'EVM chain id'),
  ).action(
    action((command) => runManagementCommand(command, { args: buildRpcArgs('remove', command.args[0]) })),
  );

  withTargetOptions(
    worker
      .command('doctor')
      .description('run the official `imd doctor` check')
      .option('--runtime <runtime>', 'claude or codex'),
  ).action(
    action(async (command) => {
      const opts = mergedOptions(command);
      const ctx = await resolveContext(opts);
      const result = await runDoctor(ctx, opts, { stdio: opts.json ? 'pipe' : 'inherit', terminal: !opts.json });
      if (opts.json) {
        shared.print(
          { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
          opts,
        );
      }
      process.exitCode = exitCodeOf(result);
    }),
  );

  const service = worker
    .command('service')
    .description('official imd service commands: install/start/stop/restart/status/logs/uninstall');

  withTargetOptions(
    service
      .command('install')
      .description('install the official system service (requires pairing, registration and a runtime)')
      .option('--boot', 'Linux: enable lingering for logout/reboot')
      .option('--auto-update', 'official worker updates itself in place inside this prefix')
      .option('--runtime <runtime>', 'claude or codex')
      .option('--concurrency <n>', '1-4'),
  ).action(servicePassthrough('install'));

  withTargetOptions(service.command('start').description('start the official service'))
    .action(servicePassthrough('start'));
  withTargetOptions(service.command('stop').description('stop the official service'))
    .action(servicePassthrough('stop'));
  withTargetOptions(
    service
      .command('restart')
      .description('restart the official service')
      .option('--runtime <runtime>', 'change runtime while restarting'),
  ).action(servicePassthrough('restart'));

  withTargetOptions(service.command('status').description('raw official service status')).action(
    servicePassthrough('status'),
  );

  withTargetOptions(
    service
      .command('logs')
      .description('official service logs')
      .option('-f, --follow', 'stream logs (terminal controls filtered)'),
  ).action(
    action(async (command) => {
      const opts = mergedOptions(command);
      const ctx = await resolveContext(opts);
      const args = buildServiceArgs('logs', opts);
      if (opts.follow) {
        if (opts.json) stderr('service logs --follow streams logs; --json has no effect');
        const result = await runImd(ctx, args, { stdio: 'inherit', terminal: true });
        process.exitCode = exitCodeOf(result);
        return;
      }
      const result = await runImd(ctx, args, {
        stdio: opts.json ? 'pipe' : 'inherit',
        terminal: !opts.json,
      });
      if (opts.json) {
        shared.print({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, opts);
      }
      process.exitCode = exitCodeOf(result);
    }),
  );

  withTargetOptions(service.command('uninstall').description('remove official service autostart (keeps pairing/logs/work)'))
    .action(servicePassthrough('uninstall'));

  return worker;
}
