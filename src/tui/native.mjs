import { createInterface } from 'node:readline/promises';
import { run } from '../program.mjs';
import { registerWorkerCommands } from '../worker/index.mjs';

// Keep native prompts and their final output in one terminal-owning process.
await run(process.argv.slice(2), { registerWorkerCommands });
process.stdout.write('\nCommand exited with code ' + (process.exitCode ?? 0) + '.\n');
const prompt = createInterface({ input: process.stdin, output: process.stdout });
try { await prompt.question('Press Enter to return to Colony.'); }
finally { prompt.close(); }
