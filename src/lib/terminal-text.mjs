const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const C1_ST = 0x9c;

const NORMAL = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI = 3;
const STRING = 4;
const STRING_ESCAPE = 5;

function isC1(code) {
  return code >= 0x80 && code <= 0x9f;
}

function isPrintable(code) {
  return code === 0x09 || code === 0x0a
    || (code >= 0x20 && code !== 0x7f && !isC1(code));
}

/**
 * Streaming equivalent of terminalText().  Escape sequences are parsed across
 * chunk boundaries so a sequence can never be completed on the far side of a
 * flush.  Only the parser state is retained; output is emitted immediately.
 */
export function createTerminalFilter(emit = () => {}) {
  let state = NORMAL;
  let stringKind = 'osc';
  let lastWriteOk = true;
  let collected = '';

  const writeText = (text) => {
    if (text) collected += text;
  };

  const feed = (char) => {
    let reprocess = true;
    while (reprocess) {
      reprocess = false;
      const code = char.codePointAt(0);

      if (state === NORMAL) {
        if (code === ESC) {
          state = ESCAPE;
        } else if (code === 0x9b) {
          state = CSI;
        } else if (code === 0x9d) {
          state = STRING;
          stringKind = 'osc';
        } else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          state = STRING;
          stringKind = 'other';
        } else if (isPrintable(code)) {
          writeText(char);
        }
        return;
      }

      if (state === ESCAPE) {
        if (char === '[') {
          state = CSI;
        } else if (char === ']') {
          state = STRING;
          stringKind = 'osc';
        } else if (char === 'P' || char === 'X' || char === '^' || char === '_') {
          state = STRING;
          stringKind = 'other';
        } else if (code >= 0x20 && code <= 0x2f) {
          state = ESCAPE_INTERMEDIATE;
        } else if (code >= 0x30 && code <= 0x7e) {
          state = NORMAL;
        } else {
          state = NORMAL;
          reprocess = true;
        }
        continue;
      }

      if (state === ESCAPE_INTERMEDIATE) {
        if (code >= 0x20 && code <= 0x2f) return;
        state = NORMAL;
        if (!(code >= 0x30 && code <= 0x7e)) reprocess = true;
        continue;
      }

      if (state === CSI) {
        if (code >= 0x20 && code <= 0x3f) return;
        if (code >= 0x40 && code <= 0x7e) {
          state = NORMAL;
          return;
        }
        state = NORMAL;
        reprocess = true;
        continue;
      }

      if (state === STRING_ESCAPE) {
        if (char === '\\') {
          state = NORMAL;
        } else if (code === ESC) {
          state = STRING_ESCAPE;
        } else if ((code === BEL && stringKind === 'osc') || code === CAN || code === SUB) {
          state = NORMAL;
        } else {
          state = STRING;
        }
        return;
      }

      // STRING: OSC/DCS/SOS/PM/APC payload, including embedded newlines.
      if (code === C1_ST || code === CAN || code === SUB || (code === BEL && stringKind === 'osc')) {
        state = NORMAL;
      } else if (code === ESC) {
        state = STRING_ESCAPE;
      }
    }
  };

  return {
    write(chunk) {
      lastWriteOk = true;
      collected = '';
      for (const char of String(chunk)) feed(char);
      if (collected && emit(collected) === false) lastWriteOk = false;
      return lastWriteOk;
    },
    end() {
      state = NORMAL;
    },
  };
}

// External text is data. Only the renderer may generate terminal controls.
export function terminalText(value) {
  let result = '';
  const filter = createTerminalFilter((text) => {
    result += text;
  });
  filter.write(String(value ?? ''));
  filter.end();
  return result;
}

export function writeDiagnostic(value) {
  process.stderr.write(terminalText(value));
}
