import { writeDiagnostic } from './terminal-text.mjs';

// Payment progress is diagnostic output only. Newlines are flattened so a
// multi-line core message cannot break the surrounding CLI output.
export function paymentProgressReporter(options = {}) {
  if (typeof options === 'boolean' ? options : options.json) return undefined;
  let previous;
  return (event) => {
    if (!event || typeof event.message !== 'string' || !event.message.trim()) return;
    const message = event.message.replace(/\s+/g, ' ').trim();
    const key = [event.phase ?? '', message, event.hash ?? ''].join('\0');
    // Only collapse the immediately repeated event. Different phases still
    // print even when their message/hash is otherwise identical.
    if (key === previous) return;
    previous = key;
    writeDiagnostic(`payment: ${message}${event.hash ? ` (${event.hash})` : ''}\n`);
  };
}
