import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createElement as h } from 'react';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { DashboardApp } from '../src/tui/app.mjs';
import { DashboardController, visibleItems } from '../src/tui/controller.mjs';
import { commandArguments, createServices, paymentView, workerTargets } from '../src/tui/services.mjs';
import { clean, outputText } from '../src/tui/presentation.mjs';
import { cancelOrder, listOrders, saveOrder } from '../src/lib/orders.mjs';
import { networkWorker } from '../src/lib/network-workers.mjs';
import { supportChoices } from '../src/lib/support.mjs';
import { fundingRequired, fundingRequiredOptions } from '../src/lib/funding-error.mjs';
import { updateTargetState } from '../src/worker/context.mjs';
import { withSubmissionAttribution } from '../src/lib/submission-attribution.mjs';

test('40x20 task preparation shows model download progress, real phases and clears on failure', async t => {
  const services = fakeServices();
  let progress;
  let finish;
  services.plan = async ({ onProgress }) => {
    progress = onProgress;
    await new Promise(resolve => { finish = resolve; });
    throw new Error('Local LLM verification failed');
  };
  t.after(() => finish?.());
  const ui = mount(t, services, 40, 20, true);
  await until(() => !ui.controller.state.busy);
  const publishing = createDraft(ui.controller);
  await until(() => Boolean(progress));
  progress({ stage: 'downloading', downloadedSize: 266258560, totalSize: 532517120, speed: 5000000, source: 'primary', sourceWebsite: 'huggingface.co' });
  await until(() => ui.lastFrame().includes('50%'));
  const frame = clean(ui.lastFrame());
  assert.match(frame, /Preparing local LLM/);
  assert.match(frame, /266\.3 \/ 532\.5 MB/);
  assert.match(frame, /5\.0 MB\/s/);
  assert.match(frame, /3\/3 Load local LLM/);
  assert.match(frame, /Qwen · 533 MB/);
  assert.doesNotMatch(frame, /Qwen3|0\.8B|Q4_K_M/);
  assert.match(frame, /From: huggingface\.co/);
  assert.match(frame, /Understands your request locally/);
  assert.match(frame, /IMD workers do the work/);
  assert.doesNotMatch(frame, /is ready/i);
  assert.ok(frame.split('\n').length <= 20, frame);
  assert.ok(frame.split('\n').every(line => stringWidth(line) <= 40), frame);
  progress({ stage: 'downloading', downloadedSize: 0, totalSize: 532517120, speed: 0, source: 'backup', sourceWebsite: 'hf-mirror.com' });
  await until(() => ui.lastFrame().includes('From: hf-mirror.com'));
  assert.doesNotMatch(ui.lastFrame(), /huggingface\.co/);
  progress({ stage: 'verifying' });
  await until(() => ui.lastFrame().includes('[+] 1/3 Download'));
  assert.doesNotMatch(ui.lastFrame(), /Local LLM is ready/);
  finish();
  await publishing;
  assert.equal(ui.controller.state.modelProgress, null);
  assert.match(ui.controller.state.error, /verification failed/);
});

test('support menu defaults to support, allows original price, and Escape cancels', async t => {
  const ui = mount(t, fakeServices(), 80, 24, true);
  await until(() => !ui.controller.state.busy);
  const choices = supportChoices({ quote: { payment: { amount: '500000000000000000', decimals: 18 } } });
  const first = ui.controller.chooseSupport(choices);
  await until(() => ui.lastFrame().includes('Help us make Colony better.'));
  assert.equal(ui.controller.state.menu.selected, 0);
  ui.stdin.write('\r');
  assert.equal(await first, 0);
  const original = ui.controller.chooseSupport(choices);
  await delay(30);
  ui.stdin.write('\x1b[B');
  await until(() => ui.controller.state.menu.selected === 1);
  ui.stdin.write('\r');
  assert.equal(await original, 1);
  const cancelled = assert.rejects(ui.controller.chooseSupport(choices), error => error.code === 'cancelled');
  await delay(30);
  ui.stdin.write('\x1b');
  await cancelled;
  assert.equal(ui.controller.state.menu, null);
});

test('40x20 support review shows total, fee, support and non-refundable transfer notice', async t => {
  const ui = mount(t, fakeServices(), 40, 20, true);
  await until(() => !ui.controller.state.busy);
  const pending = ui.controller.confirm({ payment: {
    amount: '0.5', objective: 'Coffee site', deliverables: [], chainName: 'Ethereum', expiresAt: '',
    networkFeeCap: '0.00044', support: { amount: '0.05', total: '0.55', recipient: '0x123' },
    funding: { coin: 'IMD', maximumDebit: '0.55 IMD' },
  } });
  await until(() => ui.lastFrame().includes('Total 0.55'));
  const frame = clean(ui.lastFrame()).replaceAll('|', ' ');
  assert.match(frame.replace(/\s+/g, ' '), /fee 0.5 \+ support 0.05/);
  assert.match(frame, /no refund/);
  assert.match(frame, /Pay 0.55 IMD/);
  assert.ok(frame.split('\n').length <= 20, frame);
  ui.controller.respond(false);
  assert.equal(await pending, false);
});

test('Workers displays Mine and Network entries with public read-only details and search', async t => {
  const services = fakeServices();
  services.networkWorkers = async () => [networkWorker({
    deviceKey: 'a'.repeat(64), seat: { tokenId: '42', agentId: '17' },
    connectedHere: true, paused: null, working: 1, maxConcurrency: 2,
    runtimes: [{ id: 'claude' }], skills: ['research-report'],
  })];
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  ui.stdin.write('3');
  await until(() => ui.lastFrame().includes('Network · Worker #42') && !ui.controller.state.busy);
  assert.match(ui.lastFrame(), /Mine · This computer/);
  ui.stdin.write('\x1b[B');
  await until(() => ui.lastFrame().includes('Read only'));
  assert.match(ui.lastFrame(), /Status: Available/);
  assert.doesNotMatch(ui.lastFrame(), /\[m\] Actions|\[l\] Logs/);
  const workerFrame = ui.lastFrame().split('\n');
  assert.ok(workerFrame.some(line => line.slice(0, 47).includes('[/] Search')));
  assert.ok(workerFrame.some(line => line.slice(0, 47).includes('[a] Add target')));
  assert.ok(workerFrame.some(line => line.slice(48).includes('Read only')));
  ui.stdin.write('m');
  await delay(35);
  assert.equal(ui.controller.state.menu, null);
  ui.stdin.write('/');
  await until(() => ui.lastFrame().includes('Search workers'));
  ui.controller.setField('research-report');
  await ui.controller.submitForm();
  assert.equal(ui.controller.selected().id, 'network:' + 'a'.repeat(64));
  await until(() => ui.lastFrame().includes('WORKERS / research-report'));
});
import { sendJson, startMock } from './helpers/mock-api.mjs';
import { runEntry, TEST_KEY } from './helpers/cli.mjs';
import { paymentApi } from './helpers/payment-api.mjs';
import { startPreparedPaymentMock } from './helpers/prepared-payment-api.mjs';
import { receiveQrText } from '../src/lib/wallet-receive.mjs';

test('wallet import masks private keys and both passwords, then clears the form', async t => {
  const services=fakeServices();
  let saved;
  services.createWallet=async(password,key)=>{saved={password,key};return {address:'0x123'};};
  const ui=mount(t,services);
  await until(()=>!ui.controller.state.busy);
  await ui.controller.navigate('wallet');
  ui.stdin.write('i');
  await until(() => ui.controller.state.menu?.title === 'Import wallet');
  ui.controller.chooseMenu();
  await until(()=>ui.controller.state.form?.fields[0].name==='key');
  const values=[TEST_KEY,'secret password','secret password'];
  for(const value of values){
    ui.controller.setField(value);
    await delay(35);
    assert.doesNotMatch(ui.lastFrame(),new RegExp(TEST_KEY+'|secret password'));
    if(ui.controller.state.form.field<2)ui.controller.nextField();
  }
  await ui.controller.submitForm();
  assert.equal(saved.key,TEST_KEY);
  assert.equal(saved.password,'secret password');
  assert.equal(ui.controller.state.form,null);
  assert.ok(ui.frames.every(frame=>!frame.includes(TEST_KEY)&&!frame.includes('secret password')));
});

test('additional wallets never ask to set a new password', async t => {
  const services = fakeServices();
  services.wallet = async () => ({ configured: true, source: 'local', address: '0x123', locked: false, coins: [] });
  const saved = [];
  services.createWallet = async (password, key) => { saved.push({ password, key }); return { address: '0x456' }; };
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  await ui.controller.navigate('wallet');
  await ui.controller.walletSetup(false);
  assert.equal(ui.controller.state.form, null);
  assert.deepEqual(saved, [{ password: undefined, key: undefined }]);
  ui.controller.walletSetup(true);
  assert.deepEqual(ui.controller.state.form.fields.map(field => field.name), ['key']);
  ui.controller.setField(TEST_KEY);
  await ui.controller.submitForm();
  assert.deepEqual(saved[1], { password: undefined, key: TEST_KEY });
});

test('wallet unlock can be cancelled and never echoes a password',async t=>{
  const ui=mount(t);
  await until(()=>!ui.controller.state.busy);
  const request=ui.controller.requestPassword('Wallet password');
  const rejected=assert.rejects(request,/cancelled/);
  ui.controller.setField('hidden unlock password');
  await delay(35);
  assert.doesNotMatch(ui.lastFrame(),/hidden unlock password/);
  ui.controller.dismissForm();
  await rejected;
  assert.equal(ui.controller.state.form,null);
});

test('receive view shows a whole QR or asks for more room; never crops it',async t=>{
  const ui=mount(t,fakeServices(),80,30);
  await until(()=>!ui.controller.state.busy);
  const address='0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  ui.controller.update({receive:{address,chainName:'Ethereum',coins:['IMD','ETH','USDC','USDT'],qr:await receiveQrText(address)}});
  await until(()=>ui.lastFrame().includes('Receive on Ethereum'));
  assert.match(ui.lastFrame(),/Choose Ethereum/);
  assert.match(ui.lastFrame(),/[▀▄█]/);
  assert.doesNotMatch(ui.lastFrame(),/q quit/);
  ui.stdin.write('q');
  await delay(35);
  assert.equal(ui.controller.closed,false);
  assert.ok(ui.controller.state.receive);
  ui.resize(40,20);
  await until(()=>ui.lastFrame().includes('Resize to at least'));
  assert.doesNotMatch(ui.lastFrame(),/[▀▄█]/);
  ui.resize(35,18);
  await until(()=>ui.lastFrame().includes('Esc back'));
  assert.doesNotMatch(ui.lastFrame(),/q quit/);
  ui.stdin.write('q');
  await delay(35);
  assert.equal(ui.controller.closed,false);
  ui.stdin.write('\x1b');
  await until(()=>ui.controller.state.receive===null);
});

const ORDER = '11111111-1111-4111-8111-111111111111';

test('configured Wallet always offers create, import, restore and switching', async t => {
  const first = '0x' + '11'.repeat(20), second = '0x' + '22'.repeat(20);
  let active = first;
  const services = fakeServices();
  services.wallet = async () => ({ configured: true, source: 'local', address: active, locked: true, coins: [] });
  services.wallets = () => [first, second].map(address => ({ address, active: address === active }));
  services.selectWallet = async address => { active = address; return { address }; };
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  await ui.controller.navigate('wallet');
  ui.controller.walletMenu();
  const walletLabels = ui.controller.state.menu.items.map(item => item.label);
  assert.ok(walletLabels.includes('View private key'));
  assert.ok(!walletLabels.includes('Create a new local wallet'));
  assert.ok(!walletLabels.includes('Restore an encrypted backup'));
  ui.controller.walletManagement();
  const labels = ui.controller.state.menu.items.map(item => item.label);
  assert.ok(!labels.includes('Restore an encrypted backup'));
  assert.ok(labels.includes('Create a new local wallet'));
  assert.ok(labels.includes('Import wallet'));
  assert.ok(!labels.includes('Lock wallet'));
  assert.ok(!labels.includes('View private key'));
  assert.ok(!walletLabels.includes('Authorize an exact IMD allowance'));
  ui.controller.walletImport();
  assert.deepEqual(ui.controller.state.menu.items.map(item => item.label), ['From private key', 'From encrypted backup']);
  ui.controller.update({ menu: null, selected: 1 });
  await ui.controller.useSelectedWallet();
  assert.equal(ui.controller.state.detail.address, second);
});
const JOB = '22222222-2222-4222-8222-222222222222';
for (const cancelAt of [1, 2]) {
  test(`wallet deletion defaults to keeping the selected wallet at confirmation ${cancelAt}`, async t => {
    const address = '0x' + '11'.repeat(20);
    const services = fakeServices();
    services.wallet = async () => ({ configured: true, source: 'local', address, currentAddress: address, coins: [] });
    services.wallets = () => [{ address, active: true }];
    let calls = 0;
    services.deleteWallet = async () => { calls++; };
    const ui = mount(t, services, 40, 20, true);
    await until(() => !ui.controller.state.busy);
    await ui.controller.navigate('wallet');
    ui.controller.walletMenu();
    assert.ok(ui.controller.state.menu.items.some(item => item.label === 'Delete wallet'));
    ui.controller.update({ menu: null });
    const deletion = ui.controller.walletDelete();
    await until(() => ui.lastFrame().includes('1 of 2'));
    assert.equal(ui.controller.state.confirm.accepted, false);
    assert.ok(ui.controller.state.confirm.lines.includes(address));
    if (cancelAt === 2) {
      ui.controller.respond(true);
      await until(() => ui.lastFrame().includes('2 of 2'));
      assert.equal(ui.controller.state.confirm.accepted, false);
      assert.ok(ui.controller.state.confirm.lines.includes(address));
      assert.equal(calls, 0);
    }
    ui.stdin.write('\r');
    await deletion;
    assert.equal(calls, 0);
    assert.equal(ui.controller.state.confirm, null);
    assert.equal(ui.controller.state.items.length, 1);
  });
}

test('deleting the last wallet requires both confirmations and clears the active wallet header', async t => {
  const address = '0x' + '22'.repeat(20);
  let present = true;
  let calls = 0;
  const services = fakeServices();
  services.wallet = async () => present ? { configured: true, source: 'local', address, currentAddress: address, coins: [] }
    : { configured: false, source: null, address: null, currentAddress: null };
  services.wallets = () => present ? [{ address, active: true }] : [];
  services.deleteWallet = async selected => {
    assert.equal(selected, address);
    calls++;
    present = false;
    return { deletedAddress: address, currentAddress: null };
  };
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  await ui.controller.navigate('wallet');
  const deletion = ui.controller.walletDelete();
  assert.match(ui.controller.state.confirm.title, /1 of 2/);
  ui.controller.respond(true);
  await until(() => ui.controller.state.confirm?.title.includes('2 of 2'));
  assert.equal(calls, 0);
  assert.equal(ui.controller.state.confirm.accepted, false);
  ui.controller.respond(true);
  await deletion;
  assert.equal(calls, 1);
  assert.equal(ui.controller.state.items.length, 0);
  assert.equal(ui.controller.state.address, null);
  assert.equal(ui.controller.state.detail.configured, false);
  assert.match(ui.controller.state.notice, /Wallet deleted/);
});

test('an environment wallet does not offer local deletion', async t => {
  const address = '0x' + '33'.repeat(20);
  const services = fakeServices();
  services.wallet = async () => ({ configured: true, source: 'environment', address, currentAddress: address, coins: [] });
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  await ui.controller.navigate('wallet');
  ui.controller.walletMenu();
  assert.equal(ui.controller.state.menu.items.some(item => item.label === 'Delete wallet'), false);
});

test('wallet actions delete the previewed wallet while retaining the current payment wallet', async t => {
  const active = '0x' + '11'.repeat(20), preview = '0x' + '22'.repeat(20);
  let addresses = [active, preview];
  const services = fakeServices();
  services.wallet = async (_signal, address = active) => ({ configured: true, source: 'local', address, currentAddress: active, coins: [] });
  services.wallets = () => addresses.map(address => ({ address, active: address === active }));
  let deleted;
  services.deleteWallet = async address => {
    deleted = address;
    addresses = addresses.filter(item => item !== address);
    return { deletedAddress: address, currentAddress: active };
  };
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  await ui.controller.navigate('wallet');
  ui.controller.update({ selected: 1 });
  await ui.controller.loadDetail();
  const deletion = ui.controller.walletDelete();
  assert.ok(ui.controller.state.confirm.lines.includes(preview));
  ui.controller.respond(true);
  await until(() => ui.controller.state.confirm?.title.includes('2 of 2'));
  assert.ok(ui.controller.state.confirm.lines.includes(preview));
  ui.controller.respond(true);
  await deletion;
  assert.equal(deleted, preview);
  assert.equal(ui.controller.state.address, active);
  assert.equal(ui.controller.selected().address, active);
  assert.equal(ui.controller.state.detail.address, active);
  assert.deepEqual(addresses, [active]);
});

test('private key view requires a masked password each time and clears on Escape or exit', async t => {
  const services = fakeServices();
  const address = '0x' + '11'.repeat(20);
  services.wallet = async () => ({ configured: true, source: 'local', address, coins: [] });
  services.wallets = () => [{ address, active: true }];
  let calls = 0;
  services.revealPrivateKey = async (selected, password) => {
    calls++;
    assert.equal(selected, address);
    if (password !== 'view password') throw new Error('Incorrect wallet password.');
    return { address, privateKey: TEST_KEY };
  };
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  await ui.controller.navigate('wallet');
  ui.controller.walletMenu();
  const entry = ui.controller.state.menu.items.findIndex(item => item.label === 'View private key');
  assert.ok(entry >= 0);
  ui.controller.update({ menu: { ...ui.controller.state.menu, selected: entry } });
  ui.controller.chooseMenu();
  assert.equal(ui.controller.state.form.fields[0].secret, true);
  ui.controller.setField('wrong');
  await ui.controller.submitForm();
  assert.equal(ui.controller.state.privateKeyView, null);
  assert.ok(ui.frames.every(frame => !frame.includes(TEST_KEY)));
  ui.controller.walletPrivateKey();
  ui.controller.setField('view password');
  await ui.controller.submitForm();
  await until(() => ui.lastFrame().includes(TEST_KEY));
  assert.ok(ui.frames.every(frame => !frame.includes('view password')));
  ui.stdin.write('\x1b');
  await until(() => ui.controller.state.privateKeyView === null && !ui.lastFrame().includes(TEST_KEY));
  ui.controller.walletPrivateKey();
  assert.ok(ui.controller.state.form);
  ui.controller.setField('view password');
  await ui.controller.submitForm();
  assert.equal(calls, 3);
  ui.controller.close();
  assert.equal(ui.controller.state.privateKeyView, null);
});

test('Wallets uses two panes, previews without switching, and adapts to narrow terminals', async t => {
  const first = '0x' + '11'.repeat(20), second = '0x' + '22'.repeat(20);
  let active = first;
  const services = fakeServices();
  services.wallets = () => [first, second].map(address => ({ address, active: address === active, locked: true }));
  services.wallet = async (_signal, address = active) => ({ configured: true, source: 'local', address, locked: true, networks: [{ key: 'ethereum', chainName: 'Ethereum', coins: [{ symbol: 'IMD', balance: address === first ? '1' : '2' }] }, { key: 'robinhood', chainName: 'Robinhood Chain', coins: [{ symbol: 'IMD', balance: '0' }] }] });
  services.selectWallet = async address => { active = address; return { address }; };
  const ui = mount(t, services, 120, 32);
  let backedUp, received;
  services.backupWallet = async (out, address) => { backedUp = address; return { path: out }; };
  services.receiveWallet = async address => { received = address; return { address, chainName: 'Ethereum', coins: [], qr: await receiveQrText(address) }; };
  await until(() => !ui.controller.state.busy);
  ui.stdin.write('4');
  await until(() => ui.lastFrame().includes('WALLET DETAILS') && !ui.controller.state.busy);
  assert.match(ui.lastFrame(), /\[4\] Wallets/);
  assert.ok(ui.lastFrame().split('\n').some(line => line.includes('WALLETS') && line.includes('WALLET DETAILS')));
  assert.match(ui.lastFrame(), /2 wallets/);
  assert.match(ui.lastFrame(), /WALLET MANAGEMENT/);
  const walletFrame = ui.lastFrame().split('\n');
  assert.ok(walletFrame.some(line => line.slice(52).includes('[m] Actions  [r] Refresh')));
  assert.ok(walletFrame.some(line => line.slice(52).includes('[n] New wallet')));
  assert.ok(walletFrame.some(line => line.slice(52).includes('[g] Manage wallets')));
  assert.doesNotMatch(walletFrame.slice(-2).join('\n'), /actions|management|\[ \] tabs/);
  assert.doesNotMatch(ui.lastFrame(), /Locked|Unlocked|password required to pay/);
  ui.stdin.write('\x1b[B');
  await until(() => ui.controller.state.detail?.address === second);
  assert.equal(active, first);
  assert.match(ui.lastFrame(), /SAVED WALLET/);
  assert.match(ui.lastFrame(), /IMD: 2/);
  assert.match(ui.lastFrame(), /ROBINHOOD CHAIN/);
  ui.stdin.write('b');
  await until(() => Boolean(ui.controller.state.form));
  ui.controller.setField('selected-backup.json');
  await ui.controller.submitForm();
  assert.equal(backedUp, second);
  await ui.controller.walletReceive();
  assert.equal(received, second);
  assert.equal(active, first);
  await until(() => ui.lastFrame().includes('Receive on Ethereum'));
  ui.stdin.write('\x1b');
  await until(() => ui.lastFrame().includes('WALLET MANAGEMENT'));
  ui.stdin.write('u');
  await until(() => ui.controller.state.address === second && !ui.controller.state.busy);
  assert.equal(active, second);
  assert.equal(ui.controller.selected().address, second);
  await until(() => ui.lastFrame().includes('CURRENT WALLET'));
  await ui.controller.navigate('tasks');
  await ui.controller.navigate('wallet');
  assert.equal(ui.controller.selected().address, second, 'opening Wallets selects the current wallet');
  ui.resize(80, 24);
  await until(() => ui.lastFrame().split('\n').some(line => line.includes('WALLETS') && line.includes('WALLET DETAILS')));
  assert.match(ui.lastFrame(), /\[n\] New wallet.*\[i\] Import wallet/);
  assert.match(ui.lastFrame(), /\[g\] Manage wallets.*\[d\] Receive funds/);
  assert.ok(ui.lastFrame().split('\n').every(line => stringWidth(line) <= 80));
  assert.ok(ui.lastFrame().split('\n').length <= 24);
  ui.resize(40, 24);
  await until(() => !ui.lastFrame().includes('WALLET DETAILS'));
  ui.stdin.write('\r');
  await until(() => ui.lastFrame().includes('WALLET DETAILS'));
  assert.ok(ui.lastFrame().split('\n').every(line => stringWidth(line) <= 40));
  ui.stdin.write('\x1b');
  await until(() => ui.lastFrame().includes('WALLETS') && !ui.lastFrame().includes('WALLET DETAILS'));
});

const rows = [
  { id: 'first', jobId: 'first', title: 'Coffee shop website', state: 'running' },
  { id: 'second', jobId: 'second', title: 'Research report', state: 'completed' },
];
function fakeServices() {
  return {
    saveDraft: async draft => draft,
    deleteDraft: async id => ({ id }),
    checkTaskWallet: async () => ({ address: '0x123', chainName: 'Ethereum' }),
    coins: () => ['IMD', 'ETH', 'USDC', 'USDT'],
    mine: async () => ({ items: rows, note: 'Local + wallet' }),
    explore: async () => ({ items: rows, note: 'Public tasks' }),
    detail: async (item) => ({ id: item.jobId, objective: rows.find((row) => row.id === item.jobId).title, state: item.jobId === 'first' ? 'running' : 'completed' }),
    result: async (id) => ({ jobId: id, complete: true, files: [{ path: 'artifacts/report.md', bytes: 12, mediaType: 'text/markdown', url: 'https://example.test/report' }] }),
    targets: () => [{ id: 'local', title: 'This computer', installed: false, options: {} }],
    networkWorkers: async () => [],
    wallet: async () => ({ configured: false, keyEnv: 'COLONY_PRIVATE_KEY' }),
    wallets: () => [],
  };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the UI');
    await delay(10);
  }
}
function mount(t, services = fakeServices(), columns = 110, rowCount = 32, ascii = false) {
  const controller = new DashboardController(services);
  const terminal = async () => {};
  const element = (columns, rows) => h(DashboardApp, { controller, dimensions: { columns, rows }, ascii, terminal });
  const ui = render(element(columns, rowCount));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  return { controller, ...ui, resize: (columns, rows) => ui.rerender(element(columns, rows)) };
}

test('non-interactive default prints help; explicit dashboard refuses pipes and JSON', async () => {
  const plain = await runEntry([]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Usage: colony/);
  assert.doesNotMatch(plain.stdout, /\x1b/);
  for (const args of [['ui'], ['ui', '--json']]) {
    const result = await runEntry(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /interactive terminal/);
  }
});

test('dashboard keyboard navigates real services, files, search and top-level workers', async (t) => {
  const ui = mount(t);
  await until(() => ui.lastFrame()?.includes('Coffee shop website'));
  ui.stdin.write('\x1b[B');
  await until(() => ui.controller.selected()?.id === 'second');
  ui.stdin.write('d');
  await until(() => ui.lastFrame().includes('artifacts/report.md'));
  ui.stdin.write('\x1b');
  ui.stdin.write('/');
  await until(() => Boolean(ui.controller.state.form));
  ui.stdin.write('Research');
  await until(() => ui.controller.state.form.values.query === 'Research');
  ui.stdin.write('\r');
  await until(() => ui.controller.state.form === null);
  assert.equal(ui.controller.selected().id, 'second');
  ui.stdin.write('3');
  await until(() => ui.lastFrame().includes('This computer'));
  ui.stdin.write('m');
  await until(() => ui.lastFrame().includes('Pair with wallet'));
  assert.match(ui.lastFrame(), /Worker/);
});

test('list actions stay inside their panel across sizes and invoke the advertised commands', async t => {
  const services = fakeServices();
  let reads = 0;
  for (const name of ['mine', 'explore', 'targets']) {
    const original = services[name];
    services[name] = (...args) => { reads++; return original(...args); };
  }
  const ui = mount(t, services, 110, 32, true);
  await until(() => ui.lastFrame()?.includes('Coffee shop website'));
  for (const [columns, rowCount] of [[110, 32], [100, 20], [80, 24], [80, 20], [40, 20]]) {
    ui.resize(columns, rowCount);
    for (const view of ['tasks', 'explore', 'workers']) {
      await ui.controller.navigate(view);
      const primary = view === 'workers' ? '[a] Add target' : '[n] New task';
      await until(() => !ui.controller.state.busy && ui.lastFrame().includes(primary));
      const frame = clean(ui.lastFrame());
      const rendered = frame.split('\n');
      const listWidth = columns < 80 ? columns : Math.floor(columns * 0.43);
      const left = rendered.map(line => line.slice(0, listWidth));
      const action = left.findIndex(line => line.includes(primary));
      const bottom = left.findIndex((line, i) => i > action && /^\+-+\+$/.test(line));
      assert.ok(bottom > action, frame);
      assert.match(left.slice(0, action - 1).join('\n'), /1\/[12]/);
      assert.match(left[action - 1], /^\| -+ \|$/);
      const bar = left.slice(action, bottom).join('\n');
      assert.match(bar, /\[\/\] Search/);
      assert.match(bar, /\[r\] Refresh/);
      if (view === 'tasks') assert.match(bar, /\[f\] Filter/);
      else assert.doesNotMatch(frame, /\[f\] Filter|f filter/);
      assert.doesNotMatch(rendered.slice(-2).join('\n'), /[Ss]earch|[Ff]ilter|[Nn]ew|[Rr]efresh|[Aa]dd target/);
      assert.ok(rendered.length <= rowCount, frame);
      assert.ok(rendered.every(line => stringWidth(line) <= columns), frame);
      ui.stdin.write(view === 'workers' ? 'a' : 'n');
      await until(() => Boolean(ui.controller.state.form));
      assert.equal(ui.controller.state.form.title, view === 'workers' ? 'Add a worker target' : 'Create a task');
      ui.stdin.write('\x1b');
      await until(() => !ui.controller.state.form);
      ui.stdin.write('/');
      await until(() => Boolean(ui.controller.state.form));
      assert.equal(ui.controller.state.form.title, view === 'workers' ? 'Search workers' : 'Search tasks');
      ui.stdin.write('\x1b');
      await until(() => !ui.controller.state.form);
      const before = reads;
      ui.stdin.write('r');
      await until(() => reads > before && !ui.controller.state.busy);
      if (view === 'tasks') {
        ui.stdin.write('f');
        await until(() => ui.controller.state.filter === 'Active');
        assert.equal(visibleItems(ui.controller.state).length, 1);
      }
    }
  }
  services.mine = async () => ({ items: [], note: 'Local records' });
  await ui.controller.navigate('tasks');
  await until(() => ui.lastFrame().includes('No tasks yet.'));
  assert.match(ui.lastFrame(), /\[n\] New task/);
  assert.match(ui.lastFrame(), /\[\/\] Search/);
});

test('Explore shows the actual total and loads history on down without duplicates or lost selection', async (t) => {
  const jobs = Array.from({ length: 52 }, (_, i) => ({
    id: 'history-' + i, objective: 'Public task ' + i, state: 'completed',
    createdAt: new Date(Date.UTC(2026, 9, 18) - i * 1000).toISOString(),
  }));
  let pending;
  let pageFailures = 0;
  const mock = await startMock(({ response, record }) => {
    if (record.path === '/swarm') return sendJson(response, 200, { counts: { jobs: jobs.length } });
    if (record.path === '/jobs') {
      if (record.query.get('q') === 'needle') return sendJson(response, 200, { count: 1, jobs: jobs.slice(-1) });
      if (record.query.has('before')) {
        if (pageFailures > 0) {
          pageFailures--;
          return sendJson(response, 503, { error: 'temporarily_unavailable' }, { 'retry-after': '0' });
        }
        pending = response; return;
      }
      return sendJson(response, 200, { count: 50, jobs: jobs.slice(0, 50) });
    }
    const job = jobs.find((job) => record.path === '/jobs/' + job.id);
    if (job) return sendJson(response, 200, job);
    return sendJson(response, 404, { error: 'not_found' });
  });
  t.after(() => mock.close());
  const services = createServices({ api: mock.url });
  services.mine = async () => ({ items: [], note: 'Local records' });
  const ui = mount(t, services, 70, 24);
  await until(() => ui.lastFrame()?.includes('No tasks yet.'));
  ui.stdin.write('2');
  await until(() => ui.controller.state.detail?.id === jobs[0].id && !ui.controller.state.busy);
  assert.match(ui.lastFrame(), /52 tasks/);
  assert.match(ui.lastFrame(), /1\/52/);
  assert.doesNotMatch(ui.lastFrame(), /50 items|50 per page/);
  ui.controller.update({ selected: 48 });
  ui.stdin.write('\x1b[B');
  await until(() => pending && ui.lastFrame().includes('Loading history...'));
  ui.stdin.write('\x1b[B');
  await delay(40);
  const pages = () => mock.requests.filter((request) => request.path === '/jobs' && request.query.has('before'));
  assert.equal(pages().length, 1);
  assert.equal(pages()[0].query.get('before'), jobs[49].createdAt);
  const failedPage = pending;
  pending = null;
  pageFailures = 2;
  sendJson(failedPage, 503, { error: 'temporarily_unavailable' }, { 'retry-after': '0' });
  await until(() => ui.controller.state.error?.includes('503') && !ui.controller.state.busy);
  assert.equal(ui.controller.state.items.length, 50);
  assert.equal(ui.controller.selected().id, jobs[49].id);
  assert.equal(pages().length, 3);
  ui.stdin.write('\x1b[B');
  await until(() => Boolean(pending));
  assert.equal(pages()[3].query.get('before'), jobs[49].createdAt);
  sendJson(pending, 200, { count: 3, jobs: jobs.slice(49) });
  await until(() => ui.controller.state.items.length === 52 && !ui.controller.state.busy);
  assert.equal(ui.controller.selected().id, jobs[49].id);
  assert.equal(new Set(ui.controller.state.items.map((item) => item.id)).size, 52);
  ui.stdin.write('\x1b[B');
  await until(() => ui.controller.selected().id === jobs[50].id);
  ui.stdin.write('\x1b[B');
  await until(() => ui.lastFrame().includes('End of history'));
  assert.match(ui.lastFrame(), /52\/52/);
  ui.stdin.write('l');
  await delay(40);
  assert.equal(pages().length, 4);
  assert.equal(mock.requests.filter((request) => request.path === '/swarm').length, 1);
  ui.stdin.write('/');
  await until(() => Boolean(ui.controller.state.form));
  ui.stdin.write('needle');
  await until(() => ui.controller.state.form.values.query === 'needle');
  ui.stdin.write('\r');
  await until(() => ui.controller.state.query === 'needle' && !ui.controller.state.busy && ui.lastFrame().includes('1 task'));
  assert.equal(ui.controller.state.total, 1);
  assert.equal(mock.requests.filter((request) => request.path === '/swarm').length, 1);
});

test('narrow layout opens details and Esc returns to its list', async (t) => {
  const ui = mount(t, fakeServices(), 79, 24);
  await until(() => ui.controller.state.detail?.id === 'first');
  assert.doesNotMatch(ui.lastFrame(), /YOUR REQUEST/);
  ui.stdin.write('\r');
  await until(() => ui.lastFrame().includes('YOUR REQUEST'));
  ui.stdin.write('\x1b');
  await until(() => !ui.lastFrame().includes('YOUR REQUEST'));
  assert.match(ui.lastFrame(), /Coffee shop website/);
});

test('official task links use the full terminal width and return to the same selection', async t => {
  const id = '44444444-4444-4444-8444-444444444444';
  const url = 'https://explorer.imd.fun/jobs/' + id;
  const item = { id, jobId: id, title: 'Coffee shop website', state: 'running' };
  const services = fakeServices();
  services.mine = services.explore = async () => ({ items: [item] });
  services.detail = async () => ({ id, objective: item.title, state: item.state });
  const ui = mount(t, services, 80, 24, true);
  await until(() => Boolean(ui.controller.state.detail));
  for (const [columns, rowCount] of [[80, 24], [80, 20], [40, 20], [120, 32]]) {
    ui.resize(columns, rowCount);
    for (const view of ['tasks', 'explore']) {
      await ui.controller.navigate(view);
      ui.stdin.write('\t');
      await until(() => ui.controller.state.focus === 'detail');
      await until(() => ui.lastFrame().includes('[v] IMD link'));
      ui.stdin.write('v');
      await until(() => ui.lastFrame().includes('View task on IMD'));
      assert.equal(ui.controller.state.taskLink.url, url);
      const frame = clean(ui.lastFrame());
      assert.ok(frame.split('\n').length <= rowCount, frame);
      assert.ok(frame.split('\n').every(line => stringWidth(line) <= columns), frame);
      if (columns >= 80) assert.ok(frame.split('\n').some(line => line.includes(url)), frame);
      else assert.ok(frame.replace(/[\s|]/g, '').includes(url), frame);
      ui.stdin.write('q');
      await delay(20);
      assert.equal(ui.controller.closed, false);
      assert.equal(ui.controller.state.taskLink.url, url);
      ui.stdin.write('\x1b');
      await until(() => !ui.controller.state.taskLink);
      assert.equal(ui.controller.selected().jobId, id);
    }
  }
  services.mine = async () => ({ items: [{ id: 'unpaid', title: 'Unpaid request', state: 'challenged' }] });
  await ui.controller.navigate('tasks');
  ui.stdin.write('v');
  await delay(20);
  assert.equal(ui.controller.state.taskLink, null);
  assert.doesNotMatch(ui.lastFrame(), /\[v\] IMD link/);
});

test('global footer only shows app actions while panel navigation stays with its content', async t => {
  const services = fakeServices();
  const address = '0x' + '11'.repeat(20);
  services.wallets = () => [{ address, active: true }];
  services.wallet = async () => ({ configured: true, source: 'local', address, chainName: 'Robinhood Chain', coins: [] });
  const ui = mount(t, services, 110, 32, true);
  await until(() => !ui.controller.state.busy);
  for (const [columns, rowCount] of [[110, 32], [80, 24], [80, 20], [40, 20]]) {
    ui.resize(columns, rowCount);
    for (const view of ['tasks', 'explore', 'workers', 'wallet']) {
      await ui.controller.navigate(view);
      await until(() => ui.lastFrame().includes('Enter/Tab details') && ui.lastFrame().includes('[?] Help'));
      for (const focus of ['list', 'detail']) {
        if (focus === 'detail') {
          ui.stdin.write('\t');
          await until(() => ui.controller.state.focus === 'detail' && ui.lastFrame().includes('Esc/Tab list'));
        }
        const frame = clean(ui.lastFrame());
        const rendered = frame.split('\n');
        const bottom = rendered.findLastIndex(line => /^\+-+\+/.test(line));
        assert.match(rendered.slice(bottom + 1).join('\n').trim(), /^Tip: .+\n\[\?\] Help  \[q\] Quit$/, frame);
        assert.ok(rendered.length <= rowCount, frame);
        assert.ok(rendered.every(line => stringWidth(line) <= columns), frame);
        if (focus === 'list' || columns >= 80) assert.match(rendered.slice(0, bottom).join('\n'), /Enter\/Tab details/);
        if (focus === 'detail') {
          assert.match(rendered.slice(0, bottom).join('\n'), /Esc\/Tab list/);
          assert.match(rendered.slice(0, bottom).join('\n'), /PgUp\/PgDn scroll/);
          if (view === 'tasks' || view === 'explore') assert.match(frame, /\[ \] tabs/);
          else assert.doesNotMatch(frame, /\[ \] tabs/);
          ui.stdin.write('\x1b[6~');
          await until(() => ui.controller.state.scroll === 5);
          if (view === 'tasks' || view === 'explore') {
            ui.stdin.write(']');
            await until(() => ui.controller.state.tab === 'Activity');
          }
          ui.stdin.write('\x1b');
          await until(() => ui.controller.state.focus === 'list');
        }
      }
    }
  }
  ui.stdin.write('?');
  await until(() => ui.lastFrame().includes('Keyboard shortcuts'));
  assert.match(ui.lastFrame(), /\| PgUp\/PgDn scroll · Esc back/);
  ui.stdin.write('\x1b');
  await until(() => !ui.controller.state.help);
});

test('40x20 completed task keeps all detail actions visible below the scrollable content', async t => {
  const ui = mount(t, fakeServices(), 40, 20, true);
  await until(() => ui.controller.state.detail?.id === 'first');
  ui.stdin.write('\x1b[B');
  await until(() => ui.controller.state.detail?.id === 'second');
  ui.stdin.write('\r');
  await until(() => ui.lastFrame().includes('YOUR REQUEST'));
  const frame = clean(ui.lastFrame());
  const rendered = frame.split('\n');
  const action = rendered.findIndex(line => line.includes('[d] Files'));
  assert.match(rendered[action - 1], /^\| -+ \|$/);
  assert.match(rendered[action], /\[d\] Files.*\[s\] Save.*\[c\] Changes/);
  assert.match(rendered[action + 1], /\[m\] Actions/);
  assert.match(rendered[action + 2], /^\+-+\+$/);
  assert.ok(rendered.length <= 20, frame);
  ui.stdin.write('m');
  await until(() => ui.controller.state.menu?.title === 'Task actions');
  assert.ok(ui.controller.state.menu.items.some(item => item.label === 'Request changes (new paid task)'));
});

test('long English and Chinese content fits 40/80/120 columns and short terminal heights', async (t) => {
  for (const columns of [40, 80, 120]) {
    const services = fakeServices();
    services.detail = async () => ({ objective: '中文咖啡馆网站需求 '.repeat(25) + 'https://example.test/' + 'x'.repeat(200), state: 'running' });
    const ui = mount(t, services, columns, 20, true);
    await until(() => Boolean(ui.controller.state.detail));
    ui.controller.update({ focus: 'detail' });
    await until(() => ui.lastFrame().includes('YOUR REQUEST'));
    const frame = clean(ui.lastFrame());
    assert.ok(frame.split('\n').every((line) => stringWidth(line) <= columns), frame);
    assert.ok(frame.split('\n').length <= 20, frame);
    assert.match(frame, /\+/);
  }
});

test('changing selection ignores a stale detail response', async () => {
  const services = fakeServices();
  let resolveFirst;
  services.detail = (item) => item.jobId === 'first' ? new Promise((resolve) => { resolveFirst = resolve; }) : Promise.resolve({ id: 'second', state: 'completed' });
  const controller = new DashboardController(services);
  const refreshing = controller.refresh();
  await until(() => Boolean(resolveFirst));
  controller.move(1);
  await until(() => controller.state.detail?.id === 'second');
  resolveFirst({ id: 'first' });
  await refreshing;
  assert.equal(controller.state.detail.id, 'second');
  controller.close();
});

test('worker launch uses argv and current global options; no shell interpolation', () => {
  const args = commandArguments({ api: 'http://localhost', home: 'C:/a b', keyEnv: 'WALLET_KEY', rpc: 'https://rpc.test' }, ['worker', 'logs'], { options: { ssh: 'user@host', identity: 'C:/keys/a b', port: '2222' } }, true);
  assert.ok(args.includes('C:/a b'));
  assert.ok(args.includes('C:/keys/a b'));
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('WALLET_KEY'));
  assert.equal(args.some((arg) => arg.includes(TEST_KEY)), false);
});

test('worker diagnostics retain readable reports on nonzero exit; command launch failures remain errors', async () => {
  const options = { api: 'http://unused', home: 'unused', keyEnv: 'UNUSED_TEST_KEY' };
  const report = { exitCode: 1, stdout: 'git OK\nforge missing\n', stderr: 'Pair this worker first.' };
  const services = createServices(options, { run: async () => ({ exitCode: 1, stdout: JSON.stringify(report), stderr: '' }) });
  const output = await services.command(['worker', 'doctor']);
  assert.deepEqual(output, report);
  assert.match(outputText(output), /Command failed.*1/);
  assert.match(outputText(output), /forge missing/);
  assert.doesNotMatch(outputText(output), /"stdout"|\\n/);
  const broken = createServices(options, { run: async () => ({ exitCode: 1, stdout: '', stderr: 'Worker is not installed.' }) });
  await assert.rejects(broken.command(['worker', 'doctor']), /Worker is not installed/);
});

async function paymentFixture(t, supportMenu = false) {
  const home = await mkdtemp(join(tmpdir(), 'colony-ui-'));
  const keyEnv = 'COLONY_UI_TEST_KEY';
  const previous = process.env[keyEnv];
  process.env[keyEnv] = TEST_KEY;
  const quote = {
    id: ORDER, action: 'job.open', issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 600,
    quoteHash: 'ab'.repeat(32),
    payment: { network: 'eip155:1', asset: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7', amount: '500000000000000000', payTo: '0x4e0fa57bde726079356537e2f34d671e9f41adbc', decimals: 18, scheme: 'exact' },
  };
  let quotedInput;
  const mock = await startPreparedPaymentMock(({ response, record }) => {
    if (record.path === '/requests/check') return sendJson(response, 200, { blockers: [], plan: [] });
    if (record.path === '/requests/quote') {
      quotedInput = record.body.input;
      return sendJson(response, 201, { order: { id: ORDER, status: 'quoted', quote } });
    }
    if (record.path === '/requests/' + ORDER + '/submit') {
      if (record.headers['payment-signature']) return sendJson(response, 202, { status: 'payment_pending' });
      const resourceUrl = mock.url + '/requests/' + ORDER + '/submit';
      return sendJson(response, 402, { x402Version: 2, resource: { url: resourceUrl }, accepts: [{ ...quote.payment, maxTimeoutSeconds: 600, extra: { assetTransferMethod: 'permit2' } }], quote, requesterScopeHash: '11'.repeat(32), resourceUrl, input: quotedInput });
    }
    if (record.path === '/requests/' + ORDER) return sendJson(response, 200, { status: 'admitted', payment: { status: 'confirmed' }, admission: { result: { kind: 'job', jobId: JOB } } });
    return sendJson(response, 404, { error: 'not_found' });
  });
  t.after(async () => {
    await mock.close();
    await rm(home, { recursive: true, force: true });
    if (previous === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = previous;
  });
  const services = createServices({ api: mock.url, rpc: mock.url + '/rpc', home, keyEnv, yes: true });
  const publish = services.publish;
  if (!supportMenu) services.publish = input => publish({ ...input, chooseSupport: async () => 1 });
  services.mine = fakeServices().mine;
  services.detail = fakeServices().detail;
  services.plan = async () => ({ input: { objective: 'Coffee site' }, summary: 'A coffee website', deliverables: ['A public website'] });
  return { services, mock, home };
}

async function createDraft(controller) {
  controller.create();
  controller.setField('Coffee site');
  return controller.submitForm();
}

test('40x20 preflight shows the funding address before any LLM work and continues after top-up', async t => {
  const services = fakeServices();
  const address = '0x' + '12'.repeat(20);
  let funded = false;
  let planned = 0;
  let published = 0;
  services.checkTaskWallet = async () => {
    if (!funded) throw fundingRequired(address, 'ethereum', [
      { coin: 'IMD', balance: '0', required: '500000000000000000' },
      { coin: 'ETH', balance: '0', required: '1000000000000000' },
    ]);
    return { address };
  };
  services.plan = async ({ objective }) => { planned++; return { input: { objective }, summary: 'Website', deliverables: [] }; };
  services.publish = async ({ expectedWallet }) => { published++; assert.equal(expectedWallet, address); return { status: 'admitted', state: { jobId: 'first' } }; };
  const ui = mount(t, services, 40, 20, true);
  await until(() => !ui.controller.state.busy);
  const creation = createDraft(ui.controller);
  await until(() => ui.lastFrame().includes('Your wallet'));
  assert.equal(planned, 0);
  assert.equal(published, 0);
  const frame = clean(ui.lastFrame());
  const plain = frame.split('\n').map(line => line.replace(/^\| ?| ?\|$/g, '').trim()).join('');
  assert.ok(plain.includes(address), frame);
  assert.match(frame, /Check balance & continue/);
  assert.ok(frame.split('\n').length <= 20, frame);
  assert.ok(frame.split('\n').every(line => stringWidth(line) <= 40), frame);
  funded = true;
  ui.controller.respond(true);
  await creation;
  assert.equal(planned, 1);
  assert.equal(published, 1);
});

test('top-up during payment retries the saved task without rerunning the local LLM', async t => {
  const services = fakeServices();
  let planned = 0;
  const keys = [];
  services.plan = async ({ objective }) => { planned++; return { input: { objective }, summary: 'Website', deliverables: [] }; };
  services.publish = async ({ requestKey, onSaved }) => {
    keys.push(requestKey);
    onSaved({ requestKey: 'saved-task-key' });
    if (keys.length === 1) throw fundingRequired('0x123', 'ethereum', [{ coin: 'IMD', balance: '0', required: '500000000000000000' }]);
    return { status: 'admitted', state: { jobId: 'first' } };
  };
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  const creation = createDraft(ui.controller);
  await until(() => ui.controller.state.confirm?.title === 'Add funds to continue');
  ui.controller.respond(true);
  await creation;
  assert.equal(planned, 1);
  assert.match(keys[0], /^[0-9a-f-]{36}$/);
  assert.equal(keys[1], 'saved-task-key');
});

test('after a shortage during payment, an unsigned task switches to whichever option is funded now', async t => {
  const services = fakeServices();
  let checks = 0;
  services.checkTaskWallet = async ({ prefer }) => {
    checks++;
    if (checks === 1) return { address: '0x123', paymentChain: 'ethereum', payWith: 'USDC', chainName: 'Ethereum' };
    assert.deepEqual(prefer, { paymentChain: 'ethereum', payWith: 'USDC' });
    return { address: '0x123', paymentChain: 'robinhood', payWith: 'IMD', chainName: 'Robinhood Chain' };
  };
  services.plan = async ({ objective }) => ({ input: { objective }, summary: 'Website', deliverables: [] });
  const attempts = [];
  services.publish = async ({ paymentChain, payWith, onSaved }) => {
    attempts.push(paymentChain + ':' + payWith);
    onSaved({ requestKey: 'saved-task-key' });
    if (attempts.length === 1) {
      const error = fundingRequired('0x123', 'ethereum', [{ coin: 'USDC', balance: '0', required: '2500000' }]);
      error.funding.canChangePayment = true;
      throw error;
    }
    return { status: 'admitted', state: { jobId: 'first' } };
  };
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  const creation = createDraft(ui.controller);
  await until(() => ui.controller.state.confirm?.title === 'Add funds to continue');
  ui.controller.respond(true);
  await creation;
  assert.deepEqual(attempts, ['ethereum:USDC', 'robinhood:IMD']);
  assert.equal(checks, 2);
});

function unfundedNetwork(key, chainName) {
  const gas = '1000000000000000';
  return { key, chainName, price: '500000000000000000', nativeBalance: '0', shortages: [], options: [
    { coin: 'IMD', payment: '500000000000000000', gas, balance: '0', nativeBalance: '0', funded: false,
      shortages: [{ coin: 'IMD', balance: '0', required: '500000000000000000' }, { coin: 'ETH', balance: '0', required: gas }] },
    { coin: 'ETH', payment: '200000000000000', gas, balance: '0', nativeBalance: '0', funded: false,
      shortages: [{ coin: 'ETH', balance: '0', required: '1200000000000000' }] },
  ] };
}

test('Add funds shows both networks, then asks which network before the receive screen', async t => {
  const services = fakeServices();
  const address = '0x' + '12'.repeat(20);
  let funded = false;
  let received;
  services.checkTaskWallet = async () => {
    if (!funded) throw fundingRequiredOptions(address, [unfundedNetwork('ethereum', 'Ethereum'), unfundedNetwork('robinhood', 'Robinhood Chain')]);
    return { address, paymentChain: 'robinhood', payWith: 'ETH', chainName: 'Robinhood Chain' };
  };
  services.receiveWallet = async (wallet, network) => {
    received = network;
    return { address: wallet, chainName: network === 'robinhood' ? 'Robinhood Chain' : 'Ethereum', coins: ['IMD', 'ETH'], qr: await receiveQrText(wallet) };
  };
  services.plan = async ({ objective }) => ({ input: { objective }, summary: 'Website', deliverables: [] });
  let paidWith;
  services.publish = async ({ paymentChain, payWith }) => { paidWith = paymentChain + ':' + payWith; return { status: 'admitted', state: { jobId: 'first' } }; };
  const ui = mount(t, services, 110, 24);
  await until(() => !ui.controller.state.busy);
  const creation = createDraft(ui.controller);
  await until(() => ui.controller.state.confirm?.title === 'Add funds to continue');
  const lines = ui.controller.state.confirm.lines.join('\n');
  assert.match(lines, /ETHEREUM · task price 0\.5 IMD/);
  assert.match(lines, /ROBINHOOD CHAIN · task price 0\.5 IMD/);
  assert.match(lines, /Plus gas \(network fee, always ETH\)/);
  assert.match(lines, /Simplest: send about .* ETH/);
  // Both networks fit on one 24-row screen without scrolling.
  const frame = ui.lastFrame();
  assert.ok(frame.includes('Your wallet: ' + address), frame);
  assert.equal(frame.match(/Simplest: send about/g)?.length, 2, frame);
  assert.ok(frame.split('\n').length <= 24, frame);
  ui.stdin.write('\t');
  await until(() => ui.controller.state.confirm.selection === 1);
  ui.stdin.write('\r');
  await until(() => ui.controller.state.menu?.title.includes('which network'));
  assert.match(ui.controller.state.menu.items[1].label, /Robinhood Chain · pay with IMD or ETH · gas/);
  ui.stdin.write('\x1b[B');
  await until(() => ui.controller.state.menu.selected === 1);
  ui.stdin.write('\r');
  await until(() => ui.lastFrame().includes('Receive on Robinhood Chain'));
  assert.equal(received, 'robinhood');
  assert.match(ui.lastFrame(), /Payment, any one of: 0\.5 IMD or ≈ /);
  assert.match(ui.lastFrame(), /Gas, always ETH/);
  ui.stdin.write('\x1b');
  await until(() => ui.controller.state.confirm?.title === 'Add funds to continue');
  funded = true;
  ui.controller.respond(true);
  await creation;
  assert.equal(paidWith, 'robinhood:ETH');
});

test('Change payment on the review card lists funded options and re-reviews with the chosen one', async t => {
  const services = fakeServices();
  services.checkTaskWallet = async () => ({ address: '0x123', paymentChain: 'ethereum', payWith: 'IMD', chainName: 'Ethereum' });
  services.paymentOptions = async () => ({ networks: [
    { key: 'ethereum', chainName: 'Ethereum', options: [
      { coin: 'IMD', payment: '500000000000000000', gas: '1000000000000000', funded: true },
      { coin: 'USDC', payment: '2000000', gas: '1000000000000000', funded: false },
    ] },
    { key: 'robinhood', chainName: 'Robinhood Chain', options: [
      { coin: 'USDC', payment: '2010000', gas: '20000000000000', funded: true },
    ] },
  ] });
  services.plan = async ({ objective }) => ({ input: { objective }, summary: 'Website', deliverables: [] });
  const reviewed = [];
  services.publish = async ({ paymentChain, payWith, confirm }) => {
    reviewed.push(paymentChain + ':' + payWith);
    const expiresAt = String(Math.floor(Date.now() / 1000) + 300);
    await confirm({ orderId: ORDER, input: { objective: 'Coffee site' }, paymentChain, payWith, challenge: { input: {} },
      quote: { expiresAt, quoteHash: '0x01', payment: { amount: '500000000000000000', decimals: 18, network: 'eip155:1', asset: '0xasset', payTo: '0xpay' } },
      onchainQuotes: [{ chainId: 4663, quoteHash: '0x01', expiresAt, amount: '500000000000000000', asset: '0xrobinhood' }] });
    return { status: 'admitted', state: { jobId: 'first' } };
  };
  const ui = mount(t, services, 110, 40);
  await until(() => !ui.controller.state.busy);
  const creation = createDraft(ui.controller);
  await until(() => ui.lastFrame().includes('Pay with IMD on Ethereum'));
  ui.stdin.write('\t');
  await until(() => ui.controller.state.confirm.selection === 1);
  ui.stdin.write('\r');
  await until(() => ui.controller.state.menu?.title.startsWith('Choose how to pay'));
  const labels = ui.controller.state.menu.items.map(item => item.label);
  assert.equal(labels.length, 2);
  assert.match(labels[0], /^IMD on Ethereum · 0\.5 IMD \+ gas ≈ .* ETH · current$/);
  assert.match(labels[1], /^USDC on Robinhood Chain · ≈ 2\.01 USDC \+ gas ≈ .* ETH$/);
  ui.stdin.write('\x1b[B');
  await until(() => ui.controller.state.menu.selected === 1);
  ui.stdin.write('\r');
  await until(() => ui.lastFrame().includes('Pay with USDC on Robinhood Chain'));
  ui.controller.respond(true);
  await creation;
  assert.deepEqual(reviewed, ['ethereum:IMD', 'robinhood:USDC']);
});

test('returning to an existing draft checks its remaining payment instead of the full source-coin balance', async t => {
  const services = fakeServices();
  let checks = 0;
  let planned = 0;
  let attempts = 0;
  services.checkTaskWallet = async () => { checks++; return { address: '0x123' }; };
  services.plan = async ({ objective }) => { planned++; return { input: { objective }, summary: 'Website', deliverables: [] }; };
  services.publish = async ({ requestKey, onSaved }) => {
    attempts++;
    onSaved({ requestKey: 'saved-task-key' });
    if (attempts === 1) throw Object.assign(new Error('Review cancelled'), { code: 'cancelled' });
    assert.equal(requestKey, 'saved-task-key');
    return { status: 'admitted', state: { jobId: 'first' } };
  };
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  await createDraft(ui.controller);
  assert.ok(ui.controller.state.form);
  await ui.controller.submitForm();
  assert.equal(attempts, 2);
  assert.equal(checks, 1);
  assert.equal(planned, 1);
});

test('task creation goes through the support choice before final confirmation; original price needs no support transaction', async t => {
  const { services, mock, home } = await paymentFixture(t, true);
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  const publishing = createDraft(ui.controller);
  await until(() => Boolean(ui.controller.state.menu));
  assert.equal(ui.controller.state.menu.selected, 0);
  assert.equal(ui.controller.state.confirm, null);
  ui.stdin.write('\x1b[B');
  await until(() => ui.controller.state.menu.selected === 1);
  ui.stdin.write('\r');
  await until(() => Boolean(ui.controller.state.confirm));
  assert.equal(ui.controller.state.confirm.payment.support, null);
  ui.controller.respond(true);
  await publishing;
  const [saved] = await listOrders(home);
  assert.equal(saved.support.amount, '0');
  assert.deepEqual(saved.funding.steps, []);
  assert.equal(mock.requests.filter(r => r.headers['payment-signature']).length, 1);
});

test('ordinary task creation asks only for the request and reviews the official fee', async t => {
  const { services, mock, home } = await paymentFixture(t);
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  ui.controller.create();
  assert.deepEqual(ui.controller.state.form.fields.map(field => field.name), ['objective']);
  ui.controller.setField('Coffee site');
  const publishing = ui.controller.submitForm();
  await until(() => Boolean(ui.controller.state.confirm) && ui.lastFrame().includes('Fee 0.5 IMD'));
  assert.doesNotMatch(ui.lastFrame(), /Limit|not set/);
  ui.controller.respond(true);
  await publishing;
  const [order] = await listOrders(home);
  assert.equal(order.status, 'admitted');
  assert.deepEqual(ui.controller.state.taskLink, { url: 'https://explorer.imd.fun/jobs/' + order.jobId, published: true });
  await until(() => ui.lastFrame().includes('Task published'));
  assert.ok(ui.lastFrame().includes('https://explorer.imd.fun/jobs/' + order.jobId));
  const submissionInput = withSubmissionAttribution({ objective: 'Coffee site' });
  const checks = mock.requests.filter(entry => entry.path === '/requests/check');
  const quotes = mock.requests.filter(entry => entry.path === '/requests/quote');
  assert.deepEqual(quotes[0].body.input, submissionInput);
  assert.deepEqual(checks[0].body.input, submissionInput);
  assert.equal((quotes[0].body.input.objective.match(/via supercolony/g) ?? []).length, 1);
  assert.equal(order.input.objective, 'Coffee site');
  assert.deepEqual(order.submissionInput, submissionInput);
  assert.deepEqual(order.challenge.input, submissionInput);
});

test('payment card defaults to cancel even with --yes; no signed request reaches the server', async (t) => {
  const { services, mock, home } = await paymentFixture(t);
  const ui = mount(t, services);
  await until(() => Boolean(ui.controller.state.detail));
  const publishing = createDraft(ui.controller);
  await until(() => Boolean(ui.controller.state.confirm));
  assert.equal(ui.controller.state.confirm.accepted, false);
  assert.match(ui.lastFrame(), /Fee 0.5 IMD/);
  assert.doesNotMatch(ui.lastFrame(), /Limit/);
  assert.doesNotMatch(ui.lastFrame(), /IMD IMD/);
  ui.stdin.write('\r');
  await publishing;
  assert.equal(mock.requests.filter((r) => r.headers['payment-signature']).length, 0);
  const [saved] = await listOrders(home);
  assert.equal(saved.paymentHeader, undefined);
  assert.equal(ui.controller.state.form.title, 'Create a task');
  assert.doesNotMatch(ui.frames.join(''), new RegExp(saved.requestToken));
});

test('the quote permits explicit confirmation and persists one signed payment', async (t) => {
  const { services, mock, home } = await paymentFixture(t);
  const controller = new DashboardController(services);
  const publishing = createDraft(controller);
  await until(() => Boolean(controller.state.confirm));
  const view = controller.state.confirm.payment;
  assert.equal(view.amount, '0.5');
  assert.equal('requestToken' in view, false);
  controller.respond(true);
  await publishing;
  assert.equal(mock.requests.filter((r) => r.headers['payment-signature']).length, 1);
  const [saved] = await listOrders(home);
  assert.equal(saved.jobId, JOB);
  assert.ok(saved.paymentHeader);
  controller.close();
});

test('Ctrl+C at payment confirmation cancels without signing', async (t) => {
  const { services, mock } = await paymentFixture(t);
  const ui = mount(t, services);
  await until(() => Boolean(ui.controller.state.detail));
  const publishing = createDraft(ui.controller);
  await until(() => Boolean(ui.controller.state.confirm));
  ui.stdin.write('\x03');
  await publishing;
  assert.equal(ui.controller.closed, true);
  assert.equal(mock.requests.filter((r) => r.headers['payment-signature']).length, 0);
});

test('minimum-size payment shows the fee and warning; a smaller window cannot approve', async (t) => {
  const { services, mock } = await paymentFixture(t);
  const ui = mount(t, services, 40, 20, true);
  await until(() => Boolean(ui.controller.state.detail));
  const publishing = createDraft(ui.controller);
  await until(() => Boolean(ui.controller.state.confirm));
  const frame = clean(ui.lastFrame());
  assert.match(frame, /Fee 0.5 IMD/);
  assert.doesNotMatch(frame, /Limit/);
  assert.match(frame, /\[ Pay 0.5 IMD & publish \]/);
  assert.match(frame.replace(/[|+\n]/g, ' ').replace(/\s+/g, ' '), /Completion is not guaranteed\./);
  assert.ok(frame.split('\n').every((line) => stringWidth(line) <= 40), frame);
  assert.ok(frame.split('\n').length <= 20, frame);
  assert.match(frame, /\[ Change payment \]/);
  ui.stdin.write('\t');
  await until(() => ui.controller.state.confirm.selection === 1);
  assert.equal(ui.controller.state.confirm.accepted, false);
  ui.stdin.write('\t');
  await until(() => ui.controller.state.confirm.accepted);
  ui.resize(30, 16);
  await until(() => ui.lastFrame().includes('Resize to at least'));
  ui.stdin.write('\r');
  await delay(80);
  assert.ok(ui.controller.state.confirm);
  assert.equal(mock.requests.filter((r) => r.headers['payment-signature']).length, 0);
  ui.resize(40, 20);
  await until(() => ui.lastFrame().includes('Review task & payment'));
  ui.stdin.write('\x1b');
  await publishing;
});

test('worker list reads the existing state and always offers this computer', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-targets-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(workerTargets(home).map((item) => item.id), ['local']);
  updateTargetState(home, 'ssh:user@example.com:2222', { identity: 'C:/keys/custom key', prefix: '/opt/worker', workerHome: '/home/user/profile' });
  const target = workerTargets(home).find(item => item.id.startsWith('ssh:'));
  const args = commandArguments({ home, api: 'http://unused', keyEnv: 'UNUSED' }, ['worker', 'status'], target, true);
  assert.equal(args[args.indexOf('--identity') + 1], 'C:/keys/custom key');
});

test('unpaid request actions confirm cancellation, then delete the cancelled record directly', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-request-actions-'));
  const mock = await startMock(({ response }) => sendJson(response, 500, { error: 'must not call' }));
  t.after(async () => { await mock.close(); await rm(home, { recursive: true, force: true }); });
  await saveOrder(home, {
    requestKey: ORDER, orderId: JOB, api: mock.url, action: 'job.open',
    input: { objective: 'My unpaid coffee site' }, requestToken: 'private-request-token',
    status: 'challenged', createdAt: '2026-10-01T00:00:00Z', lastError: 'Aborted with Ctrl+C',
  });
  const services = createServices({ home, api: mock.url, keyEnv: 'COLONY_UNCONFIGURED_TEST_KEY' });
  const ui = mount(t, services);
  await until(() => ui.controller.state.detail?.status === 'challenged');
  assert.match(ui.lastFrame(), /\[o\] Review & pay.*\[x\] Cancel.*\[m\] Actions/);
  assert.doesNotMatch(ui.lastFrame(), /\[d\] Files|\[s\] Save|\[c\] Changes/);
  ui.stdin.write('x');
  await until(() => Boolean(ui.controller.state.confirm));
  assert.equal(ui.controller.state.confirm.accepted, false);
  assert.match(ui.lastFrame(), /Keep request/);
  ui.stdin.write('\r');
  await until(() => !ui.controller.state.busy);
  assert.equal((await listOrders(home))[0].cancelledAt, undefined);

  ui.stdin.write('m');
  await until(() => ui.lastFrame().includes('Task actions'));
  assert.deepEqual(ui.controller.state.menu.items.map((item) => item.label), ['View details', 'Review & pay', 'Cancel request']);
  ui.stdin.write('\x1b');
  await until(() => !ui.lastFrame().includes('Task actions'));
  ui.stdin.write('x');
  await until(() => Boolean(ui.controller.state.confirm));
  ui.stdin.write('\t');
  await until(() => ui.controller.state.confirm.accepted);
  ui.stdin.write('\r');
  await until(() => ui.controller.state.detail?.status === 'cancelled' && !ui.controller.state.busy);
  assert.match(ui.lastFrame(), /Cancelled/);
  assert.doesNotMatch(ui.lastFrame(), /Awaiting payment|Aborted with Ctrl\+C|o review & pay|x cancel/);
  assert.equal(visibleItems({ ...ui.controller.state, filter: 'Active' }).length, 0);
  assert.equal(visibleItems({ ...ui.controller.state, filter: 'Attention' }).length, 0);
  assert.equal(visibleItems({ ...ui.controller.state, filter: 'Cancelled' }).length, 1);
  ui.stdin.write('m');
  await until(() => Boolean(ui.controller.state.menu));
  assert.deepEqual(ui.controller.state.menu.items.map((item) => item.label), ['View details', 'Delete local record']);
  ui.stdin.write('\x1b[B');
  await until(() => ui.controller.state.menu.selected === 1);
  ui.stdin.write('\r');
  await until(() => ui.lastFrame().includes('No tasks yet'));
  assert.equal(ui.controller.state.confirm, null);
  assert.deepEqual(await listOrders(home), []);
  assert.equal(mock.requests.length, 0);
  assert.doesNotMatch(ui.frames.join(''), /private-request-token/);
});

test('cancelling from another terminal while the payment card is open prevents signing', async (t) => {
  const { services, mock, home } = await paymentFixture(t);
  const controller = new DashboardController(services);
  t.after(() => controller.close());
  const publishing = createDraft(controller);
  await until(() => Boolean(controller.state.confirm));
  const [saved] = await listOrders(home);
  await cancelOrder(home, saved.requestKey);
  controller.respond(true);
  await publishing;
  assert.match(controller.state.error, /cancelled locally/);
  assert.equal(mock.requests.filter((request) => request.headers['payment-signature']).length, 0);
  const [cancelled] = await listOrders(home);
  assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.paymentHeader, undefined);
});

function mountWelcome(t, services, columns = 80, rows = 24) {
  const controller = new DashboardController(services);
  const ui = render(h(DashboardApp, { controller, dimensions: { columns, rows }, ascii: true, terminal: async () => {}, welcome: true }));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  return { controller, ...ui };
}

test('first launch without any wallet offers to create one by default and asks for a password twice', async t => {
  const home = await mkdtemp(join(tmpdir(), 'colony-welcome-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const services = createServices({ home, api: 'http://127.0.0.1:1', keyEnv: 'COLONY_UNCONFIGURED_TEST_KEY' });
  services.mine = async () => ({ items: [] });
  const ui = mountWelcome(t, services);
  await until(() => ui.controller.state.menu?.title === 'Welcome to Colony');
  const frame = clean(ui.lastFrame());
  assert.match(frame, /No wallet found on this computer\./);
  assert.match(frame, /> 1\. Create a new wallet \(empty, add funds later\)/);
  assert.match(frame, /2\. Not now/);
  assert.doesNotMatch(frame, /[\u4e00-\u9fff]/);
  assert.equal(ui.controller.state.menu.selected, 0);
  ui.stdin.write('\r');
  await until(() => Boolean(ui.controller.state.form));
  assert.deepEqual(ui.controller.state.form.fields.map(field => field.label),
    ['Local wallet password (at least 8 characters)', 'Confirm password']);
  ui.controller.setField('first wallet password');
  ui.controller.nextField();
  ui.controller.setField('different password');
  await ui.controller.submitForm();
  assert.match(ui.controller.state.form.error, /Passwords do not match/);
  ui.controller.setField('first wallet password');
  await ui.controller.submitForm();
  await until(() => ui.controller.state.view === 'wallet' && ui.controller.state.items.length === 1 && !ui.controller.state.busy);
  assert.match(ui.controller.state.notice, /^Wallet ready: 0x[0-9a-fA-F]{40}\. Press b to back up, then d to add funds\.$/);
  assert.equal(services.wallets().length, 1);
});

test('first launch can skip wallet creation with 2 or Esc, and is not offered when a wallet exists', async t => {
  const services = fakeServices();
  let ui = mountWelcome(t, services);
  await until(() => ui.controller.state.menu?.title === 'Welcome to Colony');
  ui.stdin.write('2');
  await until(() => ui.controller.state.menu === null);
  assert.equal(ui.controller.state.form, null);
  assert.match(ui.controller.state.notice, /Create one anytime in Wallets/);
  ui = mountWelcome(t, fakeServices());
  await until(() => ui.controller.state.menu?.title === 'Welcome to Colony');
  ui.stdin.write('\x1b');
  await until(() => ui.controller.state.menu === null);
  assert.match(ui.controller.state.notice, /No wallet created/);
  const configured = fakeServices();
  configured.wallets = () => [{ address: '0x' + '11'.repeat(20), active: true }];
  ui = mountWelcome(t, configured);
  await until(() => !ui.controller.state.busy && ui.lastFrame().includes('COLONY'));
  await delay(80);
  assert.equal(ui.controller.state.menu, null);
  const envWallet = fakeServices();
  envWallet.wallet = async () => ({ configured: true, source: 'env', address: '0x' + '22'.repeat(20) });
  ui = mountWelcome(t, envWallet);
  await until(() => !ui.controller.state.busy && ui.lastFrame().includes('COLONY'));
  await delay(80);
  assert.equal(ui.controller.state.menu, null);
});

test('wallet page has no network switch and needs no key or RPC settings', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-wallet-network-ui-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const services = createServices({ home, keyEnv: 'COLONY_UNCONFIGURED_TEST_KEY' });
  services.mine = async () => ({ items: [] });
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  ui.stdin.write('4');
  await until(() => ui.controller.state.view === 'wallet' && Boolean(ui.controller.state.detail) && !ui.controller.state.busy);
  assert.doesNotMatch(ui.lastFrame(), /COLONY_RPC_URL/);
  assert.doesNotMatch(ui.lastFrame(), /\[p\]/);
  ui.stdin.write('p');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ui.controller.state.menu, null);
});

test('minimum-size Robinhood payment shows network and gas cap and still defaults to cancel', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'colony-robinhood-ui-'));
  const mock = await paymentApi(home);
  const keyEnv = 'COLONY_ROBINHOOD_UI_TEST_KEY';
  process.env[keyEnv] = TEST_KEY;
  t.after(async () => { delete process.env[keyEnv]; await mock.close(); await rm(home, { recursive: true, force: true }); });
  const services = createServices({ home, api: mock.url, rpc: mock.url + '/rpc', keyEnv });
  const publish = services.publish;
  services.publish = input => publish({ ...input, paymentChain: 'robinhood', payWith: 'IMD', chooseSupport: async () => 1 });
  services.mine = async () => ({ items: [] });
  services.plan = async () => ({ input: { objective: 'Coffee site' }, summary: 'A website', deliverables: ['A public website'] });
  const ui = mount(t, services, 40, 20, true);
  await until(() => !ui.controller.state.busy);
  const publishing = createDraft(ui.controller);
  await until(() => Boolean(ui.controller.state.confirm));
  const frame = clean(ui.lastFrame());
  assert.match(frame, /Pay with IMD on Robinhood/);
  assert.match(frame.replaceAll('|', ' ').replace(/\s+/g, ' '), /Gas \(network fee\): at most [\d.]+ ETH/);
  assert.match(frame, /Pay 0.5 IMD & publish/);
  assert.ok(frame.split('\n').length <= 20, frame);
  assert.ok(frame.split('\n').every((line) => stringWidth(line) <= 40), frame);
  assert.equal(ui.controller.state.confirm.accepted, false);
  ui.stdin.write('\r');
  await publishing;
  assert.equal(mock.control.broadcasts.length, 0);
});

for (const coin of ['USDC', 'ETH']) {
  test(`40x20 ${coin} conversion review shows maximum debit and gas cap before confirming`, async (t) => {
    const ui = mount(t, fakeServices(), 40, 20, true);
    await until(() => !ui.controller.state.busy);
    const confirmation = ui.controller.confirm({ payment: {
      orderId: ORDER, objective: 'Coffee site', deliverables: ['A website'],
      amount: '0.5', chainName: 'Ethereum',
      expiresAt: new Date(Date.now() + 300_000).toISOString(), networkFeeCap: '0.00198',
      funding: { coin, amount: coin === 'ETH' ? '0.001005 ETH' : '2.512564 USDC',
        maximumDebit: coin === 'ETH' ? '0.002985 ETH' : '2.512564 USDC', minimumImd: '0.5 IMD' },
    } });
    await until(() => ui.lastFrame().includes('Payment: at most'));
    const frame = clean(ui.lastFrame());
    assert.match(frame, /Pay with .* on Ethereum/);
    assert.match(frame, /Payment: at most /);
    assert.match(frame.replaceAll('|', ' ').replace(/\s+/g, ' '), /Gas \(network fee\): at most 0.00198 ETH/);
    assert.match(frame, /Convert & publish/);
    assert.match(frame.replaceAll('|', ' ').replace(/\s+/g, ' '), /Completion is not guaranteed/);
    assert.match(frame, /Cancel \/ edit/);
    assert.ok(frame.split('\n').length <= 20, frame);
    assert.ok(frame.split('\n').every((line) => stringWidth(line) <= 40), frame);
    assert.equal(ui.controller.state.confirm.accepted, false);
    ui.stdin.write('\r');
    assert.equal(await confirmation, false);
  });
}
