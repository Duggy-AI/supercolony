import { startDashboard } from '../../src/tui/index.mjs';
import { createServices } from '../../src/tui/services.mjs';
import { runProcess } from '../../src/worker/process.mjs';

// A harmless native prompt exercises the same inherited terminal used by
// official-worker commands, without deploying or registering a worker.
const options = { api: process.argv[2], home: process.argv[3], keyEnv: 'COLONY_PRIVATE_KEY', ascii: true };
const services = createServices(options);
services.interactive = () => runProcess({
  command: process.execPath,
  args: ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline/promises';
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question('NATIVE HANDOFF: ');
    console.log('Native answer: ' + answer);
    await prompt.question('Press Enter to return to Colony.');
    prompt.close();
  `],
  stdio: 'inherit',
});
await startDashboard(options, { services });
