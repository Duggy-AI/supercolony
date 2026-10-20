import { writeDiagnostic } from './lib/terminal-text.mjs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerTaskCommands } from './commands/task.mjs';
import { registerOrderCommands } from './commands/order.mjs';
import { registerWalletCommands } from './commands/wallet.mjs';
import { registerModelCommands } from './commands/model.mjs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export function createProgram(registerWorkerCommands, { loadPlanner, startUI } = {}) {
  if (typeof registerWorkerCommands !== 'function') {
    throw new Error('createProgram requires registerWorkerCommands');
  }

  const program = new Command();
  program
    .name('colony')
    .configureHelp({
      showGlobalOptions: true,
      // Groups already own the shared flags so they can parse either position.
      visibleGlobalOptions: (command) => !command.parent || command.parent === program ? []
        : program.options.filter((option) => !option.hidden && option.name() !== 'version'),
    })
    .description('publish and browse IMD tasks, and operate IMD workers')
    .enablePositionalOptions()
    .version(pkg.version)
    .option('--api <url>', 'IMD API base URL', process.env.COLONY_API_URL ?? 'https://api.imd.fun')
    .option('--home <dir>', 'local state directory', process.env.COLONY_HOME ?? join(homedir(), '.super-colony'))
    .option('--rpc <url>', 'optional custom RPC URL (payment networks have built-in public nodes)', process.env.COLONY_RPC_URL)
    .option('--payment-chain <network>', 'only pay on this network: ethereum or robinhood (default: chosen automatically from your balances)')
    .option('--pay-with <coin>', 'only pay with this coin: IMD, ETH, USDT, USDC or USDG (default: chosen automatically)')
    .option('--key-env <name>', 'environment variable holding the wallet private key', 'COLONY_PRIVATE_KEY')
    .option('--json', 'print one JSON document to stdout', false)
    .option('--yes', 'skip interactive confirmation', false);

  program.option('--ascii', 'use ASCII borders in the interactive dashboard', false);
  const openDashboard = startUI ?? (async (options) => {
    const { startDashboard } = await import('./tui/index.mjs');
    await startDashboard(options, { loadPlanner });
  });
  program.action(async (options) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      if (options.json) throw new Error('Choose a command for JSON output: colony task mine --json');
      program.outputHelp();
      return;
    }
    await openDashboard(options);
  });
  program.command('ui').description('open the interactive task and worker dashboard')
    .action(async (_options, command) => openDashboard(command.optsWithGlobals()));

  registerTaskCommands(program, { loadPlanner });
  registerOrderCommands(program);
  registerWalletCommands(program);
  registerModelCommands(program);
  registerWorkerCommands(program);

  // Keep CLI version local to the root. Command groups parse the shared
  // flags after their name, leaving worker deploy/update --version alone.
  for (const group of program.commands) {
    group.enablePositionalOptions(false);
    for (const option of program.options.filter((item) => item.name() !== 'version')) {
      group.addOption(option);
      group.on(`option:${option.name()}`, () => {
        const key = option.attributeName();
        program.setOptionValueWithSource(key, group.getOptionValue(key), 'cli');
      });
    }
  }

  return program;
}

export async function run(argv, { registerWorkerCommands, loadPlanner }) {
  const program = createProgram(registerWorkerCommands, { loadPlanner });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    process.exitCode = 1;
    writeDiagnostic(`error: ${error.message}\n`);
  }
}
