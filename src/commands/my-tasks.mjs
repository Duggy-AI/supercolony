import { print } from '../shared.mjs';
import {
  collectMyTasks,
  formatMyTasksText,
} from '../lib/my-tasks.mjs';

export function registerMyTaskCommands(task) {
  if (!task || typeof task.command !== 'function') {
    throw new Error('registerMyTaskCommands requires the task command');
  }

  task
    .command('mine')
    .description('unify local orders and wallet paid-by tasks')
    .option('--address <address>', 'public payer address to read from GET /requests/paid-by')
    .option('--local', 'read local orders only; do not use the wallet or network', false)
    .option('--limit <n>', 'maximum items to show (1-100)', '20')
    .action(async (options, command) => {
      const opts = command.optsWithGlobals();
      const doc = await collectMyTasks({
        api: opts.api,
        home: opts.home,
        address: opts.address,
        local: Boolean(opts.local),
        limit: opts.limit,
        keyEnv: opts.keyEnv,
      });
      print(opts.json ? doc : formatMyTasksText(doc), opts);
    });
}
