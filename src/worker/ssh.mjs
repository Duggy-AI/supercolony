/**
 * SSH is intentionally the system OpenSSH client.  We never build a remote
 * command by concatenating unquoted user input: every remote argv element is
 * POSIX single-quoted, and the host is validated before it reaches ssh.
 */

const CONTROL = /[\u0000-\u001f\u007f]/;

export function validateSshHost(host) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error('--ssh requires a non-empty host');
  }
  if (host.startsWith('-')) {
    throw new Error(`invalid --ssh host: ${JSON.stringify(host)} (must not start with "-")`);
  }
  if (CONTROL.test(host) || /\s/.test(host)) {
    throw new Error(`invalid --ssh host: ${JSON.stringify(host)} (whitespace/control characters are not allowed)`);
  }
  return host;
}

export function validatePort(port) {
  if (port === undefined || port === null || port === '') return undefined;
  const text = String(port);
  if (!/^[1-9][0-9]{0,4}$/.test(text)) {
    throw new Error(`invalid --port: ${JSON.stringify(port)}`);
  }
  const value = Number(text);
  if (value > 65535) throw new Error(`invalid --port: ${port}`);
  return value;
}

/** Quote one argv element for a POSIX shell. */
export function quotePosix(value) {
  const text = String(value);
  if (text.includes('\u0000')) {
    throw new Error('cannot pass a NUL byte to a remote shell');
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Build the command string that the remote login shell will parse. */
export function buildRemoteCommand(command, args = []) {
  return [command, ...args].map(quotePosix).join(' ');
}

/**
 * Build local ssh argv.  `--` stops option parsing even if a bug lets a
 * hostname start with a dash (validateSshHost rejects that first).
 */
export function buildSshArgs(target, remoteCommand, { tty = false } = {}) {
  const host = validateSshHost(target.host);
  const args = [];
  if (target.identity) args.push('-i', target.identity);
  const port = validatePort(target.port);
  if (port !== undefined) args.push('-p', String(port));
  if (tty) args.push('-t');
  args.push('--', host, remoteCommand);
  return args;
}
