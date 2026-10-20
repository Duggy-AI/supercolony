import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, parseTransaction, toHex } from 'viem';
import { IMD_TOKENS } from '../../src/lib/payment-coins.mjs';
import { SWAP_ABI, QUOTER_ABI, UNISWAP } from '../../src/lib/swaps.mjs';
import { sendJson, startMock } from './mock-api.mjs';
import { TEST_ADDRESS } from './cli.mjs';

export const ORDER = '11111111-1111-4111-8111-111111111111';
export const JOB = '22222222-2222-4222-8222-222222222222';
export const PARENT = '33333333-3333-4333-8333-333333333333';
export const INTAKE = '0xa43e6f75ee006411f79ac1c84120606c2330de82';
export const RH_ASSET = '0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127';
const BLOCK = '0x' + '12'.repeat(32);
const amount = '500000000000000000';

export async function paymentApi(home) {
  const control = {
    chainId: 4663, allowance: 5n * 10n ** 18n, broadcasts: [], known: new Map(),
    dropBroadcast: false, acceptBroadcast: true, confirmed: false, reverted: false,
    action: 'job.open', includeTerms: true, persisted: [], pendingReceipt: false,
    funding: false, balances: new Map(), allowances: new Map(), applied: new Set(), paymentConfirmed: false,
    nativeBalance: 10n ** 20n, gasEstimate: 100_000n,
    mined: new Set(),
  };
  const quote = {
    id: ORDER, action: control.action, quoteHash: 'ab'.repeat(32),
    issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 600,
    payment: { network: 'eip155:1', asset: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
      amount, decimals: 18, scheme: 'exact', payTo: '0x4e0fa57bde726079356537e2f34d671e9f41adbc' },
  };
  const terms = { chainId: 4663, intake: INTAKE, asset: RH_ASSET, amount,
    expiresAt: quote.expiresAt, quoteHash: '0x' + quote.quoteHash, signature: '0x' + '56'.repeat(65) };
  let quotedInput;
  const mock = await startMock(async ({ response, record }) => {
    if (record.path === '/rpc') {
      const { id, method, params } = record.body;
      const reply = (result) => sendJson(response, 200, { jsonrpc: '2.0', id, result });
      if (method === 'eth_chainId') return reply(toHex(control.chainId));
      if (method === 'eth_call') {
        const call = params[0];
        if (call.data.startsWith('0x4fe02b44')) return reply(toHex(control.nonceBitmap ?? 0n, { size: 32 }));
        if (!control.funding) return reply(toHex(call.data.startsWith('0xdd62ed3e') ? control.allowance : 10n ** 20n, { size: 32 }));
        const network = control.chainId === 1 ? 'ethereum' : 'robinhood';
        if (call.to.toLowerCase() === UNISWAP[network].quoter) {
          if (control.noRoute) return sendJson(response, 200, { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } });
          const { args: [path, target] } = decodeFunctionData({ abi: QUOTER_ABI, data: call.data });
          const source = '0x' + path.slice(-40);
          const output = path.slice(0, 42);
          const input = output === UNISWAP[network].weth ? (target * 2500n + 10n ** 12n - 1n) / 10n ** 12n
            : source === UNISWAP[network].weth ? (target + 499n) / 500n : (target + 199_999_999_999n) / 200_000_000_000n;
          return reply(encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'quoteExactOutput', result: [input * (control.rateMultiplier ?? 1n), [], [], 100000n] }));
        }
        const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: call.data });
        const token = call.to.toLowerCase();
        const value = functionName === 'allowance' ? control.allowances.get(token + ':' + args[1].toLowerCase()) ?? 0n
          : control.balances.get(token) ?? (Object.values(IMD_TOKENS).includes(token) ? 0n : 100_000_000n);
        return reply(toHex(value, { size: 32 }));
      }
      if (method === 'eth_getBalance') return reply(toHex(control.nativeBalance));
      if (method === 'eth_getTransactionCount') {
        const error = await control.beforeNonce?.();
        if (error) return sendJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32000, message: error } });
        const transactions = [...control.known].filter(([hash]) => params[1] === 'pending' || control.mined.has(hash));
        return reply(toHex(transactions.reduce((nonce, [, tx]) => Math.max(nonce, tx.nonce + 1), 0)));
      }
      if (method === 'eth_estimateGas') {
        await control.beforeEstimate?.();
        return reply(toHex(control.gasEstimate));
      }
      if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') return reply(toHex(control.priorityFee ?? 1000000000n));
      if (method === 'eth_feeHistory') return reply({ oldestBlock: '0x1',
        baseFeePerGas: Array(6).fill(toHex(control.baseFee ?? 1000000000n)), gasUsedRatio: Array(5).fill(0.5),
        reward: Array(5).fill([toHex(control.minedTip ?? 1000000000n)]) });
      if (method === 'eth_getBlockByNumber') return reply({ number: '0x1', hash: BLOCK, baseFeePerGas: toHex(control.baseFee ?? 1000000000n), gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: toHex(control.blockTimestamp ?? 1610612736n), transactions: [] });
      if (method === 'eth_blockNumber') return reply('0x2');
      if (method === 'eth_sendRawTransaction') {
        const raw = params[0];
        const hash = keccak256(raw);
        control.broadcasts.push(raw);
        if (home) {
          const files = readdirSync(join(home, 'orders'));
          control.persisted.push(JSON.parse(readFileSync(join(home, 'orders', files[0]), 'utf8')));
        }
        if (control.acceptBroadcast) control.known.set(hash, parseTransaction(raw));
        if (control.broadcasts.length === control.dropAt) control.dropBroadcast = true;
        if (control.dropBroadcast) return sendJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32000, message: 'Simulated lost broadcast response' } });
        return reply(hash);
      }
      if (method === 'eth_getTransactionByHash') {
        const transaction = control.known.get(params[0]);
        if (!transaction) return reply(null);
        return reply({ hash: params[0], type: '0x2', from: TEST_ADDRESS, to: transaction.to,
          blockHash: control.confirmed ? BLOCK : null, blockNumber: control.confirmed ? '0x1' : null,
          transactionIndex: control.confirmed ? '0x0' : null,
          nonce: toHex(transaction.nonce), gas: toHex(transaction.gas), value: toHex(transaction.value ?? 0n),
          input: transaction.data, chainId: toHex(transaction.chainId),
          maxFeePerGas: toHex(transaction.maxFeePerGas), maxPriorityFeePerGas: toHex(transaction.maxPriorityFeePerGas),
          gasPrice: '0x3b9aca00', v: '0x0', r: transaction.r, s: transaction.s, yParity: toHex(transaction.yParity) });
      }
      if (method === 'eth_getTransactionReceipt') {
        const transaction = control.known.get(params[0]);
        await control.beforeReceipt?.(params[0]);
        if (!transaction || control.dropBroadcast || control.pendingReceipt || control.pendingHashes?.has(params[0])) return reply(null);
        control.confirmed = true;
        control.mined.add(params[0]);
        if (control.funding && !control.reverted && !control.applied.has(params[0])) {
          control.applied.add(params[0]);
          const to = transaction.to.toLowerCase();
          if (Object.values(UNISWAP).some(config => to === config.router)) {
            const decoded = decodeFunctionData({ abi: SWAP_ABI, data: transaction.data });
            const { args: [swap] } = decodeFunctionData({ abi: SWAP_ABI, data: decoded.args[1][0] });
            const token = swap.path.slice(0, 42).toLowerCase();
            control.balances.set(token, (control.balances.get(token) ?? 0n) + swap.amountOut);
          } else if (to === INTAKE) control.paymentConfirmed = true;
          else {
            const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: transaction.data });
            if (functionName === 'transfer') control.balances.set(to, (control.balances.get(to) ?? 0n) - args[1]);
            else control.allowances.set(to + ':' + args[0].toLowerCase(), args[1]);
          }
        }
        return reply({ transactionHash: params[0], transactionIndex: '0x0', blockHash: BLOCK,
          blockNumber: '0x1', from: TEST_ADDRESS, to: transaction.to, contractAddress: null,
          cumulativeGasUsed: '0x186a0', gasUsed: '0x186a0', effectiveGasPrice: '0x3b9aca00',
          logs: [], logsBloom: '0x' + '00'.repeat(256), type: '0x2', status: control.reverted ? '0x0' : '0x1' });
      }
      return sendJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unexpected mock RPC: ' + method } });
    }
    if (record.path === '/requests/capabilities') return sendJson(response, 200, {
      actions: [{ action: control.action, payment: quote.payment }],
      onchain: { chains: [{ chainId: 4663, network: 'eip155:4663', intake: INTAKE,
        asset: RH_ASSET, decimals: 18, payTo: quote.payment.payTo, actions: [{ action: control.action, amount }] }] },
    });
    if (record.path === '/requests/check') return sendJson(response, 200, { blockers: [], plan: [], owner: TEST_ADDRESS });
    if (record.path === '/jobs/' + PARENT) return sendJson(response, 200, { id: PARENT, state: 'completed', paidBy: TEST_ADDRESS, objective: 'Coffee site' });
    if (record.path === '/requests/quote') {
      await control.onQuote?.(record, quote, terms);
      quote.action = record.body.action;
      quotedInput = record.body.input;
      return sendJson(response, 201, { order: { id: quote.id, status: 'quoted', quote }, onchain: control.includeTerms ? [terms] : [] });
    }
    if (record.path === '/requests/' + quote.id + '/submit') {
      if (control.funding && record.headers['payment-signature']) {
        const result = await control.onSubmit?.(record);
        if (result) return sendJson(response, result.httpStatus ?? 202, result.body);
        if (control.rejectPayment) return sendJson(response, 402, { reason: 'Insufficient IMD' });
        control.paymentConfirmed = true;
        return sendJson(response, 202, { status: 'submitted' });
      }
      const resourceUrl = mock.url + record.path;
      return sendJson(response, 402, { x402Version: 2, resource: { url: resourceUrl },
        resourceUrl, requesterScopeHash: '11'.repeat(32), quote, input: quotedInput,
        accepts: [{ ...quote.payment, maxTimeoutSeconds: 600, extra: { assetTransferMethod: 'permit2' } }] });
    }
    if (record.path === '/requests/' + quote.id) return sendJson(response, 200, control.orderStatus ? { status: control.orderStatus } : (control.funding ? control.paymentConfirmed : control.confirmed) && !control.reverted
      ? { status: 'admitted', admission: { result: { kind: 'job', jobId: JOB } } }
      : { status: 'quoted' });
    return sendJson(response, 404, { error: 'not_found' });
  });
  return { ...mock, control, quote, terms };
}
