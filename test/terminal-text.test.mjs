import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalFilter, terminalText } from '../src/lib/terminal-text.mjs';

test('terminalText removes complete escape sequences and non-printing controls', () => {
  const input = [
    'plain',
    '\u001b[31mred\u001b[0m',
    '\u001b]52;c;Y2xpcGJvYXJk\u0007',
    '\u001b]0;title\u001b\\',
    '\u009b2J',
    '\u009dosc\u009c',
    '\u001bPdcs\u001b\\',
    '\u001b_apc\u001b\\',
    '\u0000\u0007\u0008\u000b\u000c\u000d\u007f\u0085',
    '\ttab\nline',
    'héllo😀',
  ].join('');
  assert.equal(terminalText(input), 'plainred\ttab\nlinehéllo😀');
});

test('createTerminalFilter keeps parser state across arbitrary chunk splits', () => {
  const full = [
    'A',
    '\u001b[31mB',
    '\u001b]52;c;Y2xpcGJvYXJk\u0007C',
    '\u009b2JD',
    '\u001bPdcs\u001b\\E',
    '\u001b_apc\u009cF',
    '\u001b(BG',
  ].join('');
  const pieces = [
    'A\u001b',
    '[31mB\u001b]52',
    ';c;Y2xpcGJv',
    'YXJk\u0007C\u009b',
    '2JD\u001bPdcs\u001b',
    '\\E\u001b_apc',
    '\u009cF\u001b(',
    'BG',
  ];

  const chunks = [];
  const filter = createTerminalFilter((text) => chunks.push(text));
  for (const piece of pieces) filter.write(piece);
  filter.end();

  assert.equal(chunks.join(''), 'ABCDEFG');
  assert.equal(chunks.join(''), terminalText(full));
});

test('each write emits at most once after collecting the whole chunk', () => {
  let calls = 0;
  let output = '';
  const filter = createTerminalFilter((text) => {
    calls += 1;
    output += text;
  });
  filter.write(`${'x'.repeat(1000)}\u001b[31m${'y'.repeat(1000)}\u001b[0m`);
  assert.equal(calls, 1);
  assert.equal(output, `${'x'.repeat(1000)}${'y'.repeat(1000)}`);
});

test('unterminated escape state at end does not leak its prefix', () => {
  assert.equal(terminalText('ok\u001b[31'), 'ok');
  assert.equal(terminalText('ok\u001b]52;c;secret'), 'ok');
  const filter = createTerminalFilter(() => {});
  filter.write('ok\u001bPdcs');
  filter.end();
});
