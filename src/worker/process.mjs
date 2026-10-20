import { spawn } from 'node:child_process';
import { createTerminalFilter } from '../lib/terminal-text.mjs';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalStdio(stdio) {
  let stdin = 'pipe';
  if (Array.isArray(stdio)) stdin = stdio[0] ?? 'pipe';
  else if (stdio === 'inherit' || stdio === 'ignore') stdin = stdio;
  return [stdin, 'pipe', 'pipe'];
}

function streamSanitized(source, target) {
  const filter = createTerminalFilter((text) => target.write(text));
  source.setEncoding('utf8');
  let paused = false;
  source.on('data', (chunk) => {
    if (filter.write(chunk) === false && !paused) {
      paused = true;
      source.pause();
      target.once('drain', () => {
        paused = false;
        source.resume();
      });
    }
  });
  source.on('end', () => filter.end());
}

/**
 * Run one process without a shell.  Remote commands are passed to ssh as a
 * single pre-quoted argv element; the local side never interprets them.
 *
 * `terminal: true` keeps stdin's original meaning but pipes stdout/stderr
 * through the streaming terminal filter instead of accumulating them.  Use it
 * for non-interactive commands whose output comes from a worker/server; real
 * TTY prompts must keep `stdio: 'inherit'` without this flag.
 */
export function runProcess({
  command,
  args = [],
  env,
  cwd,
  stdio = 'pipe',
  input,
  timeoutMs,
  signal,
  terminal = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const spawnStdio = terminal ? terminalStdio(stdio) : stdio;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: spawnStdio,
        shell: false,
        windowsHide: true,
        signal,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      timer.unref?.();
    }

    if (terminal) {
      if (child.stdout) streamSanitized(child.stdout, process.stdout);
      if (child.stderr) streamSanitized(child.stderr, process.stderr);
    } else if (stdio === 'pipe' || (Array.isArray(stdio) && stdio[0] === 'pipe')) {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    if (child.stdin) {
      if (input !== undefined) child.stdin.end(input);
      else if (spawnStdio === 'pipe' || (Array.isArray(spawnStdio) && spawnStdio[0] === 'pipe')) {
        child.stdin.end();
      }
    }

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

export function spawnErrorMessage(command, error) {
  if (error && error.code === 'ENOENT') {
    return `command not found: ${command}`;
  }
  return error?.message ?? String(error);
}
