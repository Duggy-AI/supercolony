import { emitKeypressEvents } from 'node:readline';

// Read secrets only from the terminal; never from argv, history or stdout.
export function readPassword(label, { signal } = {}) {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY) throw new Error('Open an interactive terminal to unlock or configure your wallet.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;
    const wasFlowing = input.readableFlowing === true;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write(label + ': ');
    function finish(error) {
      input.off('keypress', onKey);
      signal?.removeEventListener('abort', onAbort);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    }
    function onAbort() { finish(new Error('Wallet operation cancelled.')); }
    function onKey(text, key) {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') return onAbort();
      if (key.name === 'return') return finish();
      if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text) value += text.replace(/[\x00-\x1f\x7f]/g, '');
    }
    input.on('keypress', onKey);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
