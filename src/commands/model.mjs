import { print } from '../shared.mjs';
import { ensureLocalModel, modelInfo } from '../planner/local.mjs';

function modelText(info) {
  return [
    'Local LLM',
    `Status: ${info.status === 'ready' ? 'Ready' : info.status === 'missing' ? 'Not downloaded' : 'Needs download'}`,
    `Download size: ${(info.size / 1e6).toFixed(1)} MB`,
    info.status === 'ready' ? 'Saved on this computer for future tasks.' : 'Run colony model setup to prepare it.',
  ].join('\n');
}

export function registerModelCommands(program) {
  const model = program.command('model').description('manage the local LLM');

  model
    .command('setup')
    .description('download and verify the local LLM')
    .action(async (_options, command) => {
      const opts = command.optsWithGlobals();
      const info = await ensureLocalModel({ home: opts.home });
      print(opts.json ? info : modelText(info), opts);
    });

  model
    .command('status')
    .description('show local LLM cache status')
    .action(async (_options, command) => {
      const opts = command.optsWithGlobals();
      const info = await modelInfo({ home: opts.home });
      print(opts.json ? info : modelText(info), opts);
    });
}
