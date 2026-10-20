import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { walletSigner } from './lib/local-wallet.mjs';
import { terminalText } from './lib/terminal-text.mjs';
import { mainnet, robinhood } from 'viem/chains';
import { retryQuery, QUERY_ATTEMPTS, QUERY_RETRY_DELAY_MS } from './lib/query-retry.mjs';


function apiError(status, data, headers) {
  const code = data && typeof data === 'object' ? data.error : undefined;
  const detail = typeof data === 'string'
    ? data.slice(0, 500)
    : data && typeof data === 'object'
      ? data.detail ?? data.message
      : undefined;
  const suffix = [code, detail && detail !== code ? detail : undefined].filter(Boolean).join(': ');
  const error = new Error(`HTTP ${status}${suffix ? ` ${suffix}` : ''}`);
  error.status = status;
  error.data = data;
  error.headers = headers;
  return error;
}

export async function request(apiUrl, path, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  const perform = () => requestOnce(apiUrl, path, { ...options, method });
  return method === 'GET' || options.query === true ? retryQuery(perform, { signal: options.signal, onRetry: options.onRetry }) : perform();
}

async function requestOnce(apiUrl, path, options) {
  const {
    method = 'GET',
    body,
    token,
    headers = {},
    allowStatuses = [],
    signal,
  } = options;

  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  const url = new URL(path, base);
  const requestHeaders = new Headers(headers);
  requestHeaders.set('accept', 'application/json');
  if (token) requestHeaders.set('authorization', `Bearer ${token}`);

  const init = { method, headers: requestHeaders, signal };
  if (body !== undefined) {
    if (!requestHeaders.has('content-type')) {
      requestHeaders.set('content-type', 'application/json');
    }
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw Object.assign(new Error(`invalid JSON response from ${url} (HTTP ${response.status}): ${text.slice(0, 500)}`), { retryable: true });
      }
      data = text;
    }
  }

  if (!response.ok && !allowStatuses.includes(response.status)) {
    throw apiError(response.status, data, response.headers);
  }
  if (!response.ok && typeof data === 'string') {
    throw apiError(response.status, data, response.headers);
  }

  return { status: response.status, data, headers: response.headers };
}

export const getSigner = walletSigner;

export function print(value, options = {}) {
  const text = !options.json && typeof value === 'string'
    ? terminalText(value)
    : JSON.stringify(value ?? null, null, 2)
      // JSON already escapes C0. Escape C1 too without changing parsed data.
      .replace(/[\u007f-\u009f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export async function confirmAction(message, options = {}) {
  if (options.yes) return;
  if (!process.stdin.isTTY) {
    throw new Error('confirmation required: rerun with --yes');
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${terminalText(message)} [y/N] `);
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      throw new Error('aborted by user');
    }
  } finally {
    rl.close();
  }
}

function rpcTransport(options) {
  const create = http(options.rpc, {
    retryCount: QUERY_ATTEMPTS - 1, retryDelay: QUERY_RETRY_DELAY_MS,
    fetchOptions: { signal: options.signal },
  });
  return context => {
    const transport = create(context);
    return { ...transport, request: (args, requestOptions) => transport.request(args, { ...requestOptions, signal: options.signal }) };
  };
}

export async function getPublicRpcClient(options, chainId) {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`invalid chain id: ${chainId}`);
  }
  const knownChain = [mainnet, robinhood].find((chain) => chain.id === chainId);
  if (!knownChain && !options.rpc) {
    throw new Error(`No default RPC is configured for chain ${chainId}; pass --rpc for this network.`);
  }

  const chain = knownChain ?? defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [options.rpc] } },
  });
  const transport = rpcTransport(options);
  const publicClient = createPublicClient({ chain, transport });

  const actual = await publicClient.getChainId();
  if (actual !== chainId) {
    throw new Error(`RPC chain mismatch: expected ${chainId}, got ${actual}`);
  }

  return publicClient;
}

export async function getRpcClients(options, chainId) {
  const account = await getSigner(options);
  const publicClient = await getPublicRpcClient(options, chainId);
  const walletClient = createWalletClient({ account, chain: publicClient.chain, transport: rpcTransport(options) });
  return { publicClient, walletClient, account };
}
