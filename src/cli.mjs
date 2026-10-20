#!/usr/bin/env node
import { registerWorkerCommands } from './worker/index.mjs';
import { run } from './program.mjs';

await run(process.argv.slice(2), { registerWorkerCommands });
