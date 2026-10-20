import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement as h } from 'react';
import { render } from 'ink-testing-library';
import { DashboardApp } from '../src/tui/app.mjs';
import { DashboardController } from '../src/tui/controller.mjs';
import { createServices } from '../src/tui/services.mjs';
import { saveDraft, listDrafts, loadDraft } from '../src/lib/drafts.mjs';
import { saveOrder } from '../src/lib/orders.mjs';
import { hashJson } from '../src/lib/publish.mjs';
import { fundingRequired } from '../src/lib/funding-error.mjs';
import { receiveQrText } from '../src/lib/wallet-receive.mjs';

const API = 'http://127.0.0.1:1';
const ADDRESS = '0x' + '12'.repeat(20);
const JOB = '22222222-2222-4222-8222-222222222222';
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for draft UI');
    await delay(10);
  }
}
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'colony-draft-ui-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, options: { home, api: API, keyEnv: 'COLONY_DRAFT_UI_NO_KEY', payWith: 'USDC' } };
}
function mount(t, services, width = 100, height = 36) {
  const controller = new DashboardController(services);
  const ui = render(h(DashboardApp, { controller, dimensions: { columns: width, rows: height }, ascii: true, terminal: async () => {} }));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  return { ...ui, controller };
}
function servicesFor(options, counts) {
  const services = createServices(options);
  const detail = services.detail;
  services.detail = (item, signal) => item.jobId ? Promise.resolve({ id: item.jobId, objective: 'Saved task', state: 'queued' }) : detail(item, signal);
  services.plan = async ({ objective }) => {
    counts.plans++;
    return { input: { objective }, summary: objective, deliverables: [] };
  };
  services.publish = async input => {
    counts.publishes++;
    const state = { version: 1, requestKey: input.requestKey, requestToken: 'mock-only', api: options.api,
      action: input.action, input: input.input, inputHash: hashJson(input.input), plan: input.plan,
      status: 'admitted', jobId: JOB, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await saveOrder(options.home, state);
    await input.onSaved(state);
    return { state, status: state.status };
  };
  return services;
}

test('a request without a wallet persists as Draft, survives restart and becomes one task after resuming', async t => {
  const { home, options } = await fixture(t);
  const counts = { plans: 0, publishes: 0 };
  const first = mount(t, servicesFor(options, counts));
  await until(() => !first.controller.state.busy);
  first.controller.create();
  const objective = 'Build a bilingual coffee shop website';
  first.controller.setField(objective);
  const creation = first.controller.submitForm();
  await until(() => first.controller.state.confirm?.title === 'Draft saved');
  assert.deepEqual(counts, { plans: 0, publishes: 0 });
  const [saved] = await listDrafts(home);
  assert.equal(saved.objective, objective);
  assert.equal('payWith' in saved, false, 'the payment coin is chosen when paying, not when writing the request');
  await assert.rejects(readdir(join(home, 'orders')), { code: 'ENOENT' });
  first.controller.respond(false);
  await creation;
  assert.equal(first.controller.state.items[0].state, 'draft');
  assert.equal(first.controller.state.detail.objective, objective);
  assert.match(first.lastFrame(), /Draft/);
  first.unmount();

  const services = servicesFor(options, counts);
  const second = mount(t, services);
  await until(() => second.controller.state.items[0]?.draftId === saved.id);
  assert.equal(second.controller.state.items.length, 1);
  services.checkTaskWallet = async () => ({ address: ADDRESS });
  await second.controller.resumeOrder();
  assert.equal(second.controller.state.form.values.objective, objective);
  assert.equal(second.controller.state.form.payWith, undefined);
  await second.controller.submitForm();
  assert.deepEqual(counts, { plans: 1, publishes: 1 });
  assert.equal(second.controller.state.items.length, 1);
  assert.equal(second.controller.state.items[0].jobId, JOB);
  assert.deepEqual(await listDrafts(home), []);
  const [orderFile] = await readdir(join(home, 'orders'));
  assert.equal(orderFile, saved.id + '.json');
});

test('Open Wallets keeps the request saved while showing create and import actions', async t => {
  const { home, options } = await fixture(t);
  const counts = { plans: 0, publishes: 0 };
  const ui = mount(t, servicesFor(options, counts));
  await until(() => !ui.controller.state.busy);
  ui.controller.create();
  ui.controller.setField('Write a report');
  const creation = ui.controller.submitForm();
  await until(() => ui.controller.state.confirm?.title === 'Draft saved');
  ui.controller.respond(true);
  await creation;
  assert.equal(ui.controller.state.view, 'wallet');
  assert.ok(ui.controller.state.menu.items.some(item => item.label === 'Create a new local wallet'));
  assert.ok(ui.controller.state.menu.items.some(item => item.label === 'Import wallet'));
  assert.equal((await listDrafts(home))[0].objective, 'Write a report');
  assert.deepEqual(counts, { plans: 0, publishes: 0 });
});

test('Add funds opens the quoted network QR, can save it, returns to the same prompt and checks again', async t => {
  const { home, options } = await fixture(t);
  const counts = { plans: 0, publishes: 0 };
  const services = servicesFor({ ...options, paymentChain: 'robinhood' }, counts);
  let funded = false;
  let checks = 0;
  services.checkTaskWallet = async () => {
    checks++;
    if (!funded) throw fundingRequired(ADDRESS, 'ethereum', [{ coin: 'IMD', balance: '0', required: '500000000000000000' }]);
    return { address: ADDRESS };
  };
  const ui = mount(t, services, 110, 45);
  await until(() => !ui.controller.state.busy);
  ui.controller.create();
  ui.controller.setField('Build my website');
  const creation = ui.controller.submitForm();
  await until(() => ui.lastFrame().includes('[ Add funds ]'));
  assert.equal(ui.controller.state.confirm.accepted, false);
  ui.stdin.write('\t');
  await until(() => ui.controller.state.confirm.selection === 1);
  ui.stdin.write('\r');
  await until(() => Boolean(ui.controller.state.receive));
  assert.equal(ui.controller.state.receive.address, ADDRESS);
  assert.equal(ui.controller.state.receive.chainName, 'Ethereum');
  assert.equal(ui.controller.state.receive.qr, await receiveQrText(ADDRESS));
  assert.deepEqual(counts, { plans: 0, publishes: 0 });
  ui.stdin.write('q');
  await delay(25);
  assert.equal(ui.controller.closed, false);
  ui.stdin.write('s');
  await until(() => Boolean(ui.controller.state.form));
  const qrFile = join(home, 'add-funds.svg');
  ui.controller.setField(qrFile);
  await ui.controller.submitForm();
  assert.match(await readFile(qrFile, 'utf8'), /<svg/);
  assert.ok(ui.controller.state.receive);
  ui.stdin.write('\x1b');
  await until(() => ui.controller.state.confirm?.title === 'Add funds to continue');
  assert.equal(ui.controller.state.receive, null);
  assert.equal(ui.controller.state.confirm.selection, 1);
  assert.equal(ui.controller.state.confirm.accepted, false);
  assert.equal(checks, 1, 'QR navigation must not retry or publish');
  funded = true;
  ui.stdin.write('\t');
  await until(() => ui.controller.state.confirm.accepted);
  ui.stdin.write('\r');
  await creation;
  assert.equal(checks, 2);
  assert.deepEqual(counts, { plans: 1, publishes: 1 });
  assert.deepEqual(await listDrafts(home), []);
});

test('Back from insufficient funds retains the raw draft', async t => {
  const { home, options } = await fixture(t);
  const services = servicesFor(options, { plans: 0, publishes: 0 });
  services.checkTaskWallet = async () => { throw fundingRequired(ADDRESS, 'ethereum', [{ coin: 'ETH', balance: '0', required: '1' }]); };
  const ui = mount(t, services, 40, 20);
  await until(() => !ui.controller.state.busy);
  ui.controller.create();
  ui.controller.setField('Keep this unfinished request');
  const creation = ui.controller.submitForm();
  await until(() => ui.controller.state.confirm?.extraAction?.label === 'Add funds');
  ui.controller.respond(false);
  await creation;
  assert.equal(ui.controller.state.form.values.objective, 'Keep this unfinished request');
  const [saved] = await listDrafts(home);
  assert.equal(saved.objective, 'Keep this unfinished request');
});

test('a durable order takes precedence over its draft if the app exits during the handoff', async t => {
  const { home, options } = await fixture(t);
  const id = randomUUID();
  const draft = await saveDraft(home, { id, api: API, objective: 'Saved continuation', parent: JOB, payWith: 'ETH' });
  await saveDraft(home, { ...draft, objective: 'Edited continuation' });
  assert.equal((await readdir(join(home, 'drafts'))).length, 1);
  assert.equal((await loadDraft(home, id)).parent, JOB);
  assert.equal((await loadDraft(home, id)).objective, 'Edited continuation');
  await saveOrder(home, { version: 1, requestKey: id, api: API, action: 'job.continue',
    input: { objective: 'Edited continuation', parentJobId: JOB }, status: 'created', createdAt: draft.createdAt });
  assert.deepEqual(await listDrafts(home), []);
  const result = await createServices(options).mine();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].requestKey, id);
  assert.equal(result.items[0].kind, 'order');
});
