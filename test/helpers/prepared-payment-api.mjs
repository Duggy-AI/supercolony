import { sendJson, startMock } from './mock-api.mjs';

// These publication fixtures exercise admission and recovery with an already
// funded, already authorized wallet. Transaction tests use paymentApi instead.
export function startPreparedPaymentMock(handler) {
  return startMock(context => {
    const { record, response } = context;
    if (record.path === '/requests/capabilities') {
      const payment = { network: 'eip155:1', asset: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
        amount: '500000000000000000', decimals: 18, payTo: '0x4e0fa57bde726079356537e2f34d671e9f41adbc' };
      return sendJson(response, 200, { actions: ['job.open', 'job.continue'].map(action => ({ action, payment })) });
    }
    if (record.path === '/rpc') {
      const { id, method } = record.body;
      const responses = {
        eth_chainId: '0x1',
        eth_call: '0x' + (10n ** 20n).toString(16).padStart(64, '0'),
        eth_getBalance: '0x56bc75e2d63100000',
        eth_gasPrice: '0x3b9aca00', eth_maxPriorityFeePerGas: '0x3b9aca00',
        eth_feeHistory: { oldestBlock: '0x1', baseFeePerGas: Array(6).fill('0x3b9aca00'),
          gasUsedRatio: Array(5).fill(0.5), reward: Array(5).fill(['0x3b9aca00']) },
        eth_getBlockByNumber: { number: '0x1', baseFeePerGas: '0x3b9aca00', transactions: [] },
      };
      return sendJson(response, 200, method in responses
        ? { jsonrpc: '2.0', id, result: responses[method] }
        : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unexpected RPC in read-only payment fixture: ' + method } });
    }
    return handler(context);
  });
}
