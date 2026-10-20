import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement as h } from 'react';
import { render } from 'ink-testing-library';
import { DashboardApp } from '../src/tui/app.mjs';
import { DashboardController } from '../src/tui/controller.mjs';
import { detailText } from '../src/tui/presentation.mjs';
import { paymentProgressReporter } from '../src/lib/payment-progress.mjs';

const PENDING_TX = {
  hash: '0x' + 'ab'.repeat(32),
  kind: 'payment',
  reason: 'receipt is still pending',
  explorerUrl: 'https://explorer.example/tx/0x' + 'ab'.repeat(32),
};

function fakeServices() {
  return {
    saveDraft: async draft => draft,
    deleteDraft: async id => ({ id }),
    options: { payWith: 'IMD' },
    coins: () => ['IMD'],
    checkTaskWallet: async () => ({ address: '0x123' }),
    plan: async ({ objective }) => ({ input: { objective }, summary: 'A website', deliverables: [] }),
    mine: async () => ({ items: [], note: 'Local + wallet' }),
    detail: async (item) => item.jobId
      ? { id: item.jobId, objective: item.title, state: 'running' }
      : { requestKey: item.requestKey, status: item.state, objective: item.title },
  };
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the UI');
    await delay(10);
  }
}

function mount(t, services, columns = 100, rows = 30) {
  const controller = new DashboardController(services);
  const element = (width, height) => h(DashboardApp, { controller, dimensions: { columns: width, rows: height }, ascii: true, terminal: async () => {} });
  const ui = render(element(columns, rows));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  return { controller, ...ui, resize: (width, height) => ui.rerender(element(width, height)) };
}

async function createDraft(controller) {
  controller.create();
  controller.setField('Coffee site');
  return controller.submitForm();
}

test('payment onProgress messages reach the dashboard without a stale signing label', async (t) => {
  const services = fakeServices();
  let started;
  let release;
  const start = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  services.publish = async ({ onProgress }) => {
    started();
    await blocked;
    onProgress({ phase: 'checking_payment', message: 'Checking the original payment...' });
    await delay(40);
    onProgress({ phase: 'confirming', message: 'Waiting for payment confirmation...' });
    await delay(40);
    return { status: 'admitted', state: { jobId: 'first' } };
  };
  const ui = mount(t, services, 80, 24);
  await until(() => !ui.controller.state.busy);
  const publishing = createDraft(ui.controller);
  await start;
  assert.doesNotMatch(ui.controller.state.busy ?? '', /Signing and submitting this order/);
  release();
  await until(() => ui.controller.state.busy === 'Checking the original payment...');
  assert.match(ui.lastFrame(), /Checking the original payment/);
  await until(() => ui.controller.state.busy === 'Waiting for payment confirmation...');
  await publishing;
});

test('expired and failed payment outcomes keep the saved request and explain recovery', () => {
  const controller = new DashboardController(fakeServices());
  controller.showOutcome({
    status: 'expired',
    state: { orderId: 'order-1', pendingTransaction: PENDING_TX },
  });
  assert.match(controller.state.error, /Payment needs review/);
  assert.match(controller.state.error, /request is saved/i);
  assert.match(controller.state.error, /Continue payment/i);
  assert.match(controller.state.error, /check the original payment/i);
  assert.match(controller.state.error, new RegExp(PENDING_TX.hash));
  assert.match(controller.state.error, new RegExp(PENDING_TX.explorerUrl));
  assert.doesNotMatch(controller.state.error, /Order status: expired|Do not assume|No payment was signed|not charged/i);

  const text = detailText({
    view: 'tasks', tab: 'Overview', selectedId: 'saved',
    items: [{ id: 'saved', requestKey: 'saved', title: 'Coffee site', state: 'payment_failed', canResume: true }],
    detail: { requestKey: 'saved', status: 'payment_failed', objective: 'Coffee site', pendingTransaction: PENDING_TX },
  });
  assert.match(text, /PAYMENT RECOVERY/);
  assert.match(text, /Payment needs review/);
  assert.match(text, /Continue payment/i);
  assert.doesNotMatch(text, /Do not assume|No payment was signed|not charged/i);
  controller.close();
});

test('transaction_pending keeps the saved task visible, resumable and shows its transaction', async (t) => {
  const services = fakeServices();
  let saved;
  services.publish = async ({ onSaved }) => {
    onSaved({ requestKey: 'pending-key' });
    saved = { id: 'pending-key', requestKey: 'pending-key', title: 'Coffee site', state: 'transaction_pending', canResume: true, canCancel: false };
    throw Object.assign(new Error('The payment is still pending.'), { code: 'transaction_pending', transaction: PENDING_TX });
  };
  services.mine = async () => ({ items: saved ? [saved] : [], note: 'Local + wallet' });
  services.detail = async (item) => ({
    requestKey: item.requestKey, status: item.state, objective: item.title,
    pendingTransaction: PENDING_TX, canResume: true, canCancel: false,
  });
  let resumed = false;
  services.resume = async (item, confirm, signal, chooseSupport, onProgress, confirmReplacement) => {
    assert.equal(item.requestKey, 'pending-key');
    assert.equal(typeof onProgress, 'function');
    assert.equal(typeof confirmReplacement, 'function');
    resumed = true;
    onProgress({ phase: 'checking_payment', message: 'Checking the original payment...' });
    return { status: 'admitted', state: { jobId: 'first' } };
  };
  const ui = mount(t, services);
  await until(() => !ui.controller.state.busy);
  await createDraft(ui.controller);
  assert.match(ui.controller.state.error, /still pending/i);
  assert.match(ui.controller.state.error, new RegExp(PENDING_TX.hash));
  assert.equal(ui.controller.draft.requestKey, 'pending-key');
  await ui.controller.refresh();
  assert.equal(ui.controller.state.items[0].requestKey, 'pending-key');
  assert.equal(ui.controller.state.items[0].state, 'transaction_pending');
  assert.equal(ui.controller.state.items[0].canResume, true);
  await until(() => ui.lastFrame().includes('PAYMENT RECOVERY'));
  assert.match(ui.lastFrame(), /Transaction: 0xabab/);
  assert.match(ui.lastFrame(), /receipt is still pending/);
  await ui.controller.resumeOrder();
  assert.equal(resumed, true);
});

test('CLI payment progress prints adjacent phase changes and suppresses only duplicate events', () => {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    const report = paymentProgressReporter({});
    const broadcasting = { phase: 'broadcasting', message: 'Sending token authorization...', hash: '0xone' };
    report(broadcasting);
    report({ ...broadcasting });
    report({ phase: 'broadcasting', message: 'Sending coin conversion...', hash: '0xtwo' });
    report({ phase: 'confirming', message: 'Waiting for coin conversion confirmation...', hash: '0xtwo' });
    report({ phase: 'broadcasting', message: 'Sending task payment...', hash: '0xthree' });
    report({ phase: 'confirming', message: 'Waiting for task payment confirmation...', hash: '0xthree' });
    assert.equal(chunks.length, 5);
    assert.match(chunks.join(''), /Sending coin conversion/);
    assert.match(chunks.join(''), /Sending task payment/);
    assert.match(chunks.join(''), /Waiting for task payment confirmation/);
    assert.equal(paymentProgressReporter({ json: true }), undefined);
  } finally {
    process.stderr.write = original;
  }
});

test('a replacement gas confirmation defaults to cancel and rejects with cancelled', async (t) => {
  const services = fakeServices();
  let failure;
  services.publish = async ({ confirmReplacement }) => {
    try {
      await confirmReplacement({
        message: 'A pending transaction uses a low network fee. Replace it with the same nonce?',
        hash: PENDING_TX.hash, kind: 'payment', networkFeeCap: '0.002', previousNetworkFeeCap: '0.001',
      });
    } catch (error) {
      failure = error;
      throw error;
    }
    return { status: 'admitted', state: { jobId: 'first' } };
  };
  const ui = mount(t, services, 80, 24);
  await until(() => !ui.controller.state.busy);
  const publishing = createDraft(ui.controller);
  await until(() => ui.controller.state.confirm?.title === 'Update network fee');
  assert.equal(ui.controller.state.confirm.accepted, false);
  assert.match(ui.lastFrame(), /low network fee/);
  ui.stdin.write('\r');
  await publishing;
  assert.equal(failure?.code, 'cancelled');
  assert.match(ui.controller.state.notice, /Payment cancelled/);
});
