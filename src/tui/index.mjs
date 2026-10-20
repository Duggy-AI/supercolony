import { fork } from 'node:child_process';
import { createServices } from './services.mjs';

function session(options, restore) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./session.mjs', import.meta.url), [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
    });
    let handoff;
    child.on('message', (message) => { handoff = message.handoff; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== 0) reject(new Error('Dashboard exited with ' + (signal ?? 'code ' + code) + '.'));
      else resolve(handoff);
    });
    child.send({ options, restore });
  });
}

export async function startDashboard(options, dependencies = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || options.json) {
    throw new Error('The dashboard needs an interactive terminal. Use colony --help or a task command with --json.');
  }
  const services = dependencies.services ?? createServices(options, dependencies);
  let restore;
  for (;;) {
    const handoff = await session(options, restore);
    if (!handoff) return;
    restore = handoff.restore;
    try {
      await services.interactive(handoff.args, handoff.target);
      restore.notice = 'Command finished. Press r to refresh.';
    } catch (error) { restore.error = error.message; }
  }
}
