import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeFunctionData, erc20Abi } from 'viem';
import { mainnet, robinhood } from 'viem/chains';
import { getPublicRpcClient } from '../src/shared.mjs';
import { selectedPaymentNetwork } from '../src/lib/payment-networks.mjs';
import { paymentOptions } from '../src/lib/payment-options.mjs';
import { checkTaskWallet } from '../src/lib/task-wallet.mjs';
import { IMD_TOKENS } from '../src/lib/payment-coins.mjs';
import { fundingRequired } from '../src/lib/funding-error.mjs';
import { runEntry, TEST_ADDRESS, TEST_KEY } from './helpers/cli.mjs';
import { INTAKE, paymentApi, RH_ASSET } from './helpers/payment-api.mjs';

test('Ethereum and Robinhood connect to their built-in nodes; custom RPC overrides and wrong chains fail', async (t) => {
  const mock = await paymentApi();
  t.after(() => mock.close());
  const fetch = globalThis.fetch;
  const seen = [];
  const defaults = [mainnet, robinhood].map((chain) => chain.rpcUrls.default.http[0]);
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const endpoint = defaults.find((value) => new URL(value).href === new URL(url).href);
    if (endpoint) {
      seen.push(endpoint);
      return fetch(mock.url + '/rpc', init);
    }
    return fetch(url, init);
  });
  for (const chain of [mainnet, robinhood]) {
    mock.control.chainId = chain.id;
    const client = await getPublicRpcClient({}, chain.id);
    assert.equal(client.chain.id, chain.id);
  }
  assert.deepEqual(seen, defaults);
  await getPublicRpcClient({ rpc: mock.url + '/rpc' }, robinhood.id);
  assert.deepEqual(seen, defaults);
  mock.control.chainId = 1;
  await assert.rejects(getPublicRpcClient({ rpc: mock.url + '/rpc' }, 4663), /RPC chain mismatch/);
  await assert.rejects(getPublicRpcClient({}, 11155111), /No default RPC/);
  assert.ok(mock.requests.every((entry) => entry.body.method === 'eth_chainId'));
});

test('there is no saved network switch: commands default to Ethereum unless --payment-chain is given', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-networks-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const removed = await runEntry(['--home', home, 'wallet', 'network', 'robinhood']);
  assert.equal(removed.status, 1);
  assert.equal(selectedPaymentNetwork({ home }).key, 'ethereum');
  assert.equal(selectedPaymentNetwork({ home, paymentChain: 'robinhood' }).key, 'robinhood');
  assert.throws(() => selectedPaymentNetwork({ home, paymentChain: 'sepolia' }), /ethereum or robinhood/);
});

// Both payment networks answer at once: Ethereum and Robinhood each get their own mock node.
async function twoNetworks(t) {
  const ethereum = await paymentApi();
  const robinhoodChain = await paymentApi();
  ethereum.control.chainId = 1;
  robinhoodChain.control.chainId = 4663;
  for (const mock of [ethereum, robinhoodChain]) { mock.control.funding = true; mock.control.nativeBalance = 0n; }
  const home = await mkdtemp(join(tmpdir(), 'colony-two-networks-'));
  process.env.COLONY_TWO_NETWORK_KEY = TEST_KEY;
  t.after(async () => {
    delete process.env.COLONY_TWO_NETWORK_KEY;
    await Promise.all([ethereum.close(), robinhoodChain.close(), rm(home, { recursive: true, force: true })]);
  });
  const fetch = globalThis.fetch;
  const routes = new Map([[mainnet, ethereum], [robinhood, robinhoodChain]].map(([chain, mock]) => [new URL(chain.rpcUrls.default.http[0]).href, mock]));
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const mock = routes.get(new URL(url).href);
    return fetch(mock ? mock.url + '/rpc' : url, init);
  });
  return { ethereum, robinhood: robinhoodChain, options: { home, api: ethereum.url, keyEnv: 'COLONY_TWO_NETWORK_KEY' } };
}

test('payment options read both networks at once and pick the one that can already pay', async (t) => {
  const f = await twoNetworks(t);
  f.robinhood.control.balances.set(RH_ASSET, 10n ** 18n);
  f.robinhood.control.nativeBalance = 10n ** 18n;
  const result = await paymentOptions(f.options);
  assert.deepEqual(result.networks.map(network => network.key), ['ethereum', 'robinhood']);
  assert.deepEqual(result.networks[0].options.map(option => option.coin), ['IMD', 'ETH', 'USDC', 'USDT']);
  assert.deepEqual(result.networks[1].options.map(option => option.coin), ['IMD', 'ETH', 'USDG']);
  assert.ok(result.networks[0].options.every(option => !option.funded));
  assert.equal(result.best.paymentChain, 'robinhood');
  assert.equal(result.best.payWith, 'IMD');
  const choice = await checkTaskWallet(f.options);
  assert.equal(choice.paymentChain, 'robinhood');
  assert.equal(choice.payWith, 'IMD');
  assert.equal(choice.address, TEST_ADDRESS);
  await assert.rejects(checkTaskWallet({ ...f.options, paymentChain: 'ethereum' }), error => {
    assert.equal(error.code, 'funding_required');
    assert.deepEqual(error.funding.networks.map(network => network.key), ['ethereum']);
    return true;
  });
  assert.equal(f.ethereum.control.broadcasts.length + f.robinhood.control.broadcasts.length, 0);
});

test('without funds the prompt lists both networks with payment and gas separated and one concrete fix', async (t) => {
  const f = await twoNetworks(t);
  f.ethereum.control.balances.set(IMD_TOKENS.ethereum, 0n);
  await assert.rejects(checkTaskWallet(f.options), error => {
    assert.equal(error.code, 'funding_required');
    assert.deepEqual(error.funding.networks.map(network => network.chainName), ['Ethereum', 'Robinhood Chain']);
    const text = error.message;
    assert.match(text, /Your wallet: 0x/);
    assert.match(text, /ETHEREUM · task price 0\.5 IMD/);
    assert.match(text, /ROBINHOOD CHAIN · task price 0\.5 IMD/);
    assert.match(text, /Pay with any one: 0\.5 IMD or ≈ [\d.]+ USDC or .* or ≈ [\d.]+ ETH\n/);
    assert.match(text, /Plus gas \(network fee, always ETH\): ≈ [\d.]+( to [\d.]+)? ETH/);
    assert.match(text, /You have: 0 IMD · 100 USDC \(enough\) · .*0 ETH\n/);
    assert.doesNotMatch(text, /0 IMD \(enough\)/);
    // The wallet already holds USDC and USDG, so only gas is missing.
    assert.match(text, /Quickest: add about [\d.]+ ETH for gas, then pay with your USDC\./);
    assert.match(text, /Quickest: add about [\d.]+ ETH for gas, then pay with your USDG\./);
    assert.doesNotMatch(text, /\d{9,}/, 'amounts are shortened for people');
    return true;
  });
});

test('a shortage caused by optional support shows the real task price and how to pay without support', () => {
  const error = fundingRequired(TEST_ADDRESS, 'ethereum', [
    { coin: 'IMD', balance: '500000000000000000', required: '550000000000000000' },
  ], { coin: 'IMD', imd: '550000000000000000', price: '500000000000000000', support: '50000000000000000',
    payment: '550000000000000000', estimate: '550000000000000000', gas: '1000000000000000',
    balance: '500000000000000000', nativeBalance: '5000000000000000' });
  assert.match(error.message, /ETHEREUM · task price 0\.5 IMD \+ 0\.05 IMD optional support/);
  assert.match(error.message, /Choose Original price/);
  assert.match(error.message, /You have: 0\.5 IMD · 0\.005 ETH \(enough for gas\)/);
  assert.doesNotMatch(error.message, /0\.5 IMD \(enough\)/);
});

test('wallet status and exact approval use Robinhood asset and intake, rather than Ethereum Permit2', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-network-wallet-'));
  const mock = await paymentApi();
  t.after(async () => { await mock.close(); await rm(home, { recursive: true, force: true }); });
  const args = ['--home', home, '--api', mock.url, '--rpc', mock.url + '/rpc', '--payment-chain', 'robinhood', '--json', 'wallet'];
  const status = await runEntry([...args, 'status']);
  assert.equal(status.status, 0, status.stderr);
  const [info] = JSON.parse(status.stdout).networks;
  assert.equal(info.chainId, 4663);
  assert.equal(info.asset, RH_ASSET);
  assert.equal(info.spender, INTAKE);
  assert.equal(info.balance, '100');
  const unsigned = await runEntry([...args, 'approve', '--amount', '0.5']);
  assert.equal(unsigned.status, 1);
  assert.equal(mock.control.broadcasts.length, 0);
  const approve = await runEntry([...args, '--yes', 'approve', '--amount', '0.5']);
  assert.equal(approve.status, 0, approve.stderr);
  const { parseTransaction } = await import('viem');
  const transaction = parseTransaction(mock.control.broadcasts[0]);
  assert.equal(transaction.chainId, 4663);
  assert.equal(transaction.to.toLowerCase(), RH_ASSET);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.data });
  assert.equal(decoded.functionName, 'approve');
  assert.equal(decoded.args[0].toLowerCase(), INTAKE);
  assert.equal(decoded.args[1], 500000000000000000n);
});
