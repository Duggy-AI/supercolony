import assert from 'node:assert/strict';
import test from 'node:test';
import { assertQuotePayment } from '../src/lib/payments.mjs';
import { IMD_TOKENS } from '../src/lib/payment-coins.mjs';

test('payment validation checks the supported currency and atomic amount without a price ceiling', () => {
  for (const [network, asset] of [['eip155:1', IMD_TOKENS.ethereum], ['eip155:4663', IMD_TOKENS.robinhood]]) {
    const payment = { network, asset, decimals: 18, amount: '500000000000000000' };
    assert.doesNotThrow(() => assertQuotePayment(payment));
    assert.doesNotThrow(() => assertQuotePayment({ ...payment, amount: '1000000000000000000000000' }));
    for (const change of [{ decimals: 21 }, { asset: '0xother' }, { network: 'eip155:8453' }]) {
      assert.throws(() => assertQuotePayment({ ...payment, ...change }), /quote currency/);
    }
    for (const amount of ['-1', '1.5', '1e18', 'NaN', '']) {
      assert.throws(() => assertQuotePayment({ ...payment, amount }), /Invalid quote amount/);
    }
  }
});
