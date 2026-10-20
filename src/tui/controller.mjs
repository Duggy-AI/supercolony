import { friendlyAmount } from '../lib/payment-coins.mjs';
import { createWorkerTarget, paymentView } from './services.mjs';
import { lockWallet } from '../lib/local-wallet.mjs';
import { fundingInstructions, fundingNetworks, networkChoiceLabel, networkTargets } from '../lib/funding-error.mjs';
import { DEFAULT_SUPPORT_CHOICE } from '../lib/support.mjs';
import { randomUUID } from 'node:crypto';
import { imdTaskUrl } from '../lib/task-link.mjs';

export const VIEWS = ['tasks', 'explore', 'workers', 'wallet'];
export const FILTERS = ['All', 'Active', 'Completed', 'Attention', 'Cancelled'];
export const TABS = ['Overview', 'Activity', 'Files'];
const ACTIVE = new Set(['draft', 'created', 'quoted', 'challenged', 'funding', 'signed', 'submitted', 'queued', 'running', 'executing', 'pending', 'admitting']);
const PAYMENT_RECOVERY_STATUSES = new Set(['expired', 'payment_failed', 'transaction_pending', 'payment_reconciling']);
const PAYMENT_RECOVERY_CODES = new Set(['transaction_pending', 'payment_reconciling']);
const EXPLORE_REFRESH_MS = 30_000;

export function visibleItems(state) {
  return state.items.filter((item) => {
    const matches = !['tasks', 'workers'].includes(state.view) || [item.title, item.id, item.searchText ?? ''].some((value) => value.toLowerCase().includes(state.query.toLowerCase()));
    if (!matches) return false;
    if (state.filter === 'All' || state.view !== 'tasks') return true;
    if (state.filter === 'Completed') return item.state === 'completed';
    if (state.filter === 'Cancelled') return item.state === 'cancelled';
    if (state.filter === 'Active') return ACTIVE.has(item.state);
    return !['completed', 'cancelled'].includes(item.state) && !ACTIVE.has(item.state);
  });
}

function cancelled() {
  return Object.assign(new Error('Payment cancelled. No new payment was signed.'), { code: 'cancelled' });
}

function changePayment() {
  return Object.assign(new Error('Choose another way to pay. No payment was signed.'), { code: 'change_payment' });
}

function paymentChoiceLabel(choice, current) {
  const { option } = choice;
  const pay = (choice.payWith === 'IMD' ? '' : '≈ ') + friendlyAmount(option.payment, choice.payWith, { up: true });
  const same = current && current.paymentChain === choice.paymentChain && current.payWith === choice.payWith;
  return choice.payWith + ' on ' + choice.chainName + ' · ' + pay + ' + gas ≈ ' + friendlyAmount(option.gas, 'ETH', { up: true }) + (same ? ' · current' : '');
}

function transactionDetails(transaction) {
  if (!transaction) return [];
  const lines = [];
  if (transaction.hash) lines.push('Transaction: ' + transaction.hash + (transaction.kind ? ' (' + transaction.kind + ')' : ''));
  if (transaction.reason) lines.push('Reason: ' + transaction.reason);
  if (transaction.explorerUrl) lines.push('Explorer: ' + transaction.explorerUrl);
  return lines;
}

function paymentRecoveryMessage(error) {
  const lines = [error.message || 'The payment result is not final yet.'];
  lines.push(...transactionDetails(error.transaction));
  lines.push('Your request is saved in My tasks. Continue payment there to check the original payment before sending another payment.');
  return lines.join('\n');
}

export class DashboardController {
  constructor(services) {
    this.services = services;
    this.listeners = new Set();
    this.state = {
      view: 'tasks', items: [], selected: 0, detail: null, result: null,
      tab: 'Overview', filter: 'All', query: '', note: '', focus: 'list', scroll: 0,
      busy: null, error: null, notice: null, form: null, menu: null, confirm: null, modelProgress: null,
      help: false, detailLoading: false, address: null, cursor: null, total: null,
      since: null, refreshing: false, refreshError: null, receive: null, privateKeyView: null, taskLink: null,
    };
    this.detailVersion = 0;
    this.extraTargets = [];
    this.closed = false;
    this.lastExploreRefresh = 0;
  }
  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.state;
  update(patch) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  selected() { return visibleItems(this.state)[this.state.selected]; }
  showTaskLink(jobId = this.selected()?.jobId, published = false) {
    const url = imdTaskUrl(jobId);
    if (url) this.update({ taskLink: { url, published }, menu: null });
  }
  showError() {
    ++this.detailVersion;
    this.update({ detail: { output: this.state.error ?? this.state.refreshError }, detailLoading: false, focus: 'detail', scroll: 0, tab: 'Overview' });
  }
  cancelAutoRefresh() {
    this.refreshRequest?.abort();
    this.refreshRequest = null;
    this.update({ refreshing: false });
  }
  async run(label, operation) {
    if (this.state.busy) return;
    this.cancelAutoRefresh();
    this.operation = new AbortController();
    this.update({ busy: label, error: null, refreshError: null, notice: null });
    try { return await operation(this.operation.signal); }
    catch (error) {
      if (error.code === 'cancelled') {
        this.update({ notice: error.message });
        this.editDraft();
      } else if (PAYMENT_RECOVERY_CODES.has(error.code)) {
        this.update({ error: paymentRecoveryMessage(error) });
      } else this.update({ error: error.message });
    } finally { this.update({ busy: null, modelProgress: null }); }
  }
  async navigate(view) {
    if (this.state.busy) return;
    clearTimeout(this.detailTimer);
    this.detailRequest?.abort();
    ++this.detailVersion;
    this.update({ view, items: [], detail: null, result: null, selected: 0, query: '', filter: 'All', tab: 'Overview', scroll: 0, focus: 'list', form: null, menu: null, taskLink: null, cursor: null, total: null, since: null });
    await this.refresh();
  }
  async refresh({ notice } = {}) {
    const selectedId = this.selected()?.id ?? this.restoreSelectedId;
    this.restoreSelectedId = undefined;
    await this.run('Loading ' + this.state.view + '...', async (signal) => {
      let doc;
      if (this.state.view === 'tasks') doc = await this.services.mine(signal);
      else if (this.state.view === 'explore') doc = await this.services.explore(this.state.query, undefined, signal);
      else if (this.state.view === 'workers') {
        const targets = this.services.targets();
        const ids = new Set(targets.map((item) => item.id));
        const own = targets.concat(this.extraTargets.filter((item) => !ids.has(item.id)))
          .map(item => ({ ...item, kind: 'managed-worker' }));
        // Local management remains visible while the public directory loads.
        this.update({ items: own, selected: 0, note: 'Loading network workers...' });
        let network;
        try { network = await this.services.networkWorkers(signal); }
        catch (error) {
          this.update({ note: own.length + ' managed targets · Network unavailable · r retry' });
          throw error;
        }
        doc = { items: own.concat(network), note: own.length + ' managed targets · ' + network.length + ' network workers · availability, free slots, ID · r refresh' };
      } else {
        const detail = await this.services.wallet(signal, selectedId, { balances: false });
        const wallets = this.services.wallets();
        if (!wallets.length && detail.configured) wallets.push({ address: detail.address, active: true, locked: detail.locked });
        doc = { items: wallets.map(wallet => ({ ...wallet, id: wallet.address, title: wallet.address.slice(0, 10) + '...' + wallet.address.slice(-8),
          subtitle: wallet.active ? 'Current' : 'Saved wallet' })),
          note: 'One local password · u use selected wallet', address: detail.currentAddress ?? detail.address ?? null };
        this.update({ detail, scroll: 0 });
      }
      const targetId = selectedId ?? (this.state.view === 'wallet' ? doc.address : undefined);
      const selected = Math.max(0, visibleItems({ ...this.state, items: doc.items }).findIndex((item) => item.id === targetId));
      this.update({ items: doc.items, note: doc.note, cursor: doc.cursor, total: doc.total ?? (doc.cursor ? null : doc.items.length), since: doc.since ?? null, selected, address: Object.hasOwn(doc, 'address') ? doc.address : this.state.address });
      if (this.state.view === 'explore') this.lastExploreRefresh = Date.now();
    });
    // Shown before balances load, which can take several seconds.
    if (notice) this.update({ notice });
    if (!this.closed) await this.loadDetail(this.state.view === 'wallet');
  }
  async autoRefresh() {
    const state = this.state;
    if (this.closed || state.busy || state.refreshing || state.detailLoading || state.form || state.confirm || state.menu || state.help || state.privateKeyView || state.taskLink) return;
    if (state.view === 'explore' && state.since !== null && Date.now() - this.lastExploreRefresh >= EXPLORE_REFRESH_MS) {
      await this.refreshExplore();
    } else if (state.view === 'tasks' && !state.error && ['running', 'executing', 'queued', 'pending'].includes(this.selected()?.state)) {
      await this.loadDetail(true);
    }
  }
  async refreshExplore() {
    const request = new AbortController();
    this.refreshRequest = request;
    this.lastExploreRefresh = Date.now();
    this.update({ refreshing: true });
    try {
      const doc = await this.services.exploreUpdates(this.state.query, this.state.since, request.signal);
      if (this.refreshRequest !== request || this.closed) return;
      const selectedId = this.selected()?.id;
      const oldest = this.state.items.at(-1)?.createdAt;
      const jobs = new Map(this.state.items.map((item) => [item.id, item]));
      for (const item of doc.items) {
        const saved = jobs.get(item.id);
        if (saved && item.updatedAt < saved.updatedAt) continue;
        if (jobs.has(item.id) || !oldest || item.createdAt >= oldest) jobs.set(item.id, item);
      }
      const items = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const selected = Math.max(0, items.findIndex((item) => item.id === selectedId));
      this.update({ items, selected, since: doc.since, total: doc.total ?? (this.state.cursor ? null : items.length), refreshError: null });
      await this.loadDetail(true);
    } catch (error) {
      if (this.refreshRequest === request && !this.closed) this.update({ refreshError: 'Auto-refresh failed: ' + error.message });
    } finally {
      if (this.refreshRequest === request) {
        this.refreshRequest = null;
        this.update({ refreshing: false });
      }
    }
  }
  async more() {
    if (this.state.view !== 'explore' || !this.state.cursor) return;
    await this.run('Loading older tasks...', async (signal) => {
      const doc = await this.services.explore(this.state.query, this.state.cursor, signal);
      const ids = new Set(this.state.items.map((item) => item.id));
      const items = this.state.items.concat(doc.items.filter((item) => !ids.has(item.id)));
      this.update({ items, cursor: doc.cursor, total: this.state.total ?? (doc.cursor ? null : items.length) });
    });
  }
  async loadDetail(quiet = false) {
    clearTimeout(this.detailTimer);
    this.detailTimer = null;
    const item = this.selected();
    if (this.state.view === 'wallet' && !item) return;
    const version = ++this.detailVersion;
    this.detailRequest?.abort();
    this.detailRequest = new AbortController();
    this.update({ detail: quiet ? this.state.detail : null, result: quiet ? this.state.result : null, detailLoading: Boolean(item), scroll: quiet ? this.state.scroll : 0 });
    if (!item) return;
    try {
      const detail = this.state.view === 'wallet' ? await this.services.wallet(this.detailRequest.signal, item.address)
        : this.state.view === 'workers'
        ? (item.kind === 'network-worker' ? item : item.installed ? await this.services.command(['worker', 'status'], item, this.detailRequest.signal) : { notInstalled: true })
        : await this.services.detail(item, this.detailRequest.signal);
      if (version === this.detailVersion) {
        const status = detail.state ?? (!item.jobId ? detail.status : undefined);
        const items = this.state.items.map((entry) => entry.id === item.id && status
          ? { ...entry, state: status, ...(detail.updatedAt ? { updatedAt: detail.updatedAt } : {}),
            ...('canCancel' in detail ? { canCancel: detail.canCancel, canDelete: detail.canDelete, canResume: detail.canResume } : {}) }
          : entry);
        const selected = visibleItems({ ...this.state, items }).findIndex((entry) => entry.id === item.id);
        this.update({ detail: selected < 0 ? null : detail, detailLoading: false, items, selected: Math.max(0, selected) });
        if (selected < 0) void this.loadDetail();
      }
    } catch (error) {
      if (version === this.detailVersion) this.update({ detailLoading: false, error: error.message });
    }
  }
  move(amount) {
    const count = visibleItems(this.state).length;
    const selected = Math.max(0, Math.min(count - 1, this.state.selected + amount));
    if (selected !== this.state.selected) {
      clearTimeout(this.detailTimer);
      ++this.detailVersion;
      this.detailRequest?.abort();
      this.update({ selected, error: null, notice: null, detail: null, result: null, detailLoading: true, scroll: 0 });
      if (this.state.view === 'workers') void this.loadDetail();
      else this.detailTimer = setTimeout(() => { void this.loadDetail(); }, 120);
    }
    if (amount > 0 && selected === count - 1) void this.more();
  }
  cycleFilter() {
    this.update({ filter: FILTERS[(FILTERS.indexOf(this.state.filter) + 1) % FILTERS.length], selected: 0 });
    void this.loadDetail();
  }
  async changeTab(delta) {
    const tab = TABS[(TABS.indexOf(this.state.tab) + delta + TABS.length) % TABS.length];
    this.update({ tab, scroll: 0 });
    if (tab === 'Files') await this.files();
  }
  async files() {
    const item = this.selected();
    if (!item?.jobId) return;
    if (this.detailTimer) void this.loadDetail(true);
    this.update({ tab: 'Files', focus: 'detail', scroll: 0 });
    await this.run('Loading files...', async (signal) => {
      this.update({ result: await this.services.result(item.jobId, signal) });
    });
  }
  showForm(title, fields, onSubmit, { onCancel, submit = 'Continue' } = {}) {
    this.cancelAutoRefresh();
    this.formSubmit = onSubmit;
    this.formCancel = onCancel;
    this.update({ form: { title, fields, values: Object.fromEntries(fields.map((f) => [f.name, f.value ?? ''])), field: 0, submit, error: null }, menu: null });
  }
  setField(value) {
    const form = this.state.form;
    const name = form.fields[form.field].name;
    this.update({ form: { ...form, values: { ...form.values, [name]: value }, error: null } });
  }
  nextField(back = false) {
    const form = this.state.form;
    this.update({ form: { ...form, field: (form.field + (back ? -1 : 1) + form.fields.length) % form.fields.length } });
  }
  async submitForm() {
    const { values } = this.state.form;
    try { await this.formSubmit(values); }
    catch (error) { this.update({ form: { ...this.state.form, error: error.message } }); }
  }
  dismissForm() {
    const cancel = this.formCancel;
    this.update({ form: null });
    if (cancel) cancel();
  }
  search() {
    const workers = this.state.view === 'workers';
    this.showForm(workers ? 'Search workers' : 'Search tasks', [{ name: 'query', label: workers ? 'Worker ID, runtime or skill' : 'Keyword or task ID', value: this.state.query }], async ({ query }) => {
      this.update({ query, selected: 0, form: null });
      if (this.state.view === 'explore') await this.refresh();
      else await this.loadDetail();
    }, { submit: 'Search' });
  }
  create(parent = null) {
    this.draft = { id: randomUUID(), objective: '', parent };
    this.editDraft();
  }
  continueTask() {
    const item = this.selected();
    if (this.state.view !== 'tasks' || !item?.jobId) return;
    this.create(item.jobId);
  }
  editDraft() {
    if (!this.draft) return;
    this.showForm(this.draft.parent ? 'Request changes' : 'Create a task', [
      { name: 'objective', label: this.draft.parent ? 'What would you like to change?' : 'What would you like to get done?', value: this.draft.objective, placeholder: 'Build a website for my coffee shop' },
    ], async ({ objective }) => {
      if (!objective.trim()) throw new Error('Describe what you would like to get done.');
      const changed = objective.trim() !== this.draft.objective;
      this.draft = { ...this.draft, objective: objective.trim(),
        ...(changed && this.draft.requestKey ? { id: randomUUID(), createdAt: undefined } : {}),
        ...(changed ? { requestKey: undefined, plan: undefined } : {}) };
      this.update({ form: null });
      await this.publishDraft();
    }, { submit: 'Review task' });
    this.update({ form: { ...this.state.form, hint: 'Colony picks how to pay from your balances. You review the price first.' } });
  }
  ask(questions) {
    return new Promise((resolve) => {
      this.askResolve = resolve;
      this.showForm('A little more information', questions.map((label, i) => ({ name: String(i), label })), (values) => {
        this.update({ form: null }); this.askResolve = null;
        resolve(Object.values(values));
      }, { onCancel: () => { this.askResolve = null; resolve([]); } });
    });
  }
  confirm(data) {
    return new Promise((resolve) => {
      this.confirmResolve = resolve;
      const lines = data.lines ?? (data.message !== undefined ? [String(data.message)] : []);
      this.update({ confirm: { ...data, lines, selection: 0, accepted: false, expanded: false }, scroll: 0 });
    });
  }
  moveConfirmation(delta) {
    const dialog = this.state.confirm;
    const count = dialog.extraAction ? 3 : 2;
    const selection = (dialog.selection + delta + count) % count;
    this.update({ confirm: { ...dialog, selection, accepted: selection === count - 1 } });
  }
  submitConfirmation() {
    const dialog = this.state.confirm;
    if (dialog.extraAction && dialog.selection === 1) void dialog.extraAction.run();
    else this.respond(dialog.accepted);
  }
  async confirmReplacement(review) {
    const accepted = await this.confirm({ title: 'Update network fee', message: review?.message ?? '' });
    if (!accepted) throw cancelled();
  }
  respond(accepted) {
    const resolve = this.confirmResolve;
    this.confirmResolve = null;
    this.update({ confirm: null });
    resolve(accepted);
  }
  reviewPayment(extra = {}) {
    return async (state) => {
      const answer = await this.confirm({ title: 'Review task & payment', payment: paymentView(state),
        extraAction: { label: 'Change payment', run: () => this.respond('change') }, ...extra });
      if (answer === 'change') throw changePayment();
      if (!answer) throw cancelled();
    };
  }
  async autoPayment({ action, signal, prefer }) {
    const choice = await this.withFundingRetry(() => this.services.checkTaskWallet({ action, signal, prefer }));
    return { choice, payment: { paymentChain: choice.paymentChain, payWith: choice.payWith } };
  }
  async pickPayment({ action, signal, current }) {
    this.update({ busy: 'Checking balances on all networks...' });
    const { networks } = await this.services.paymentOptions({ action, signal });
    const ready = networks.flatMap(network => (network.options ?? []).filter(option => option.funded)
      .map(option => ({ paymentChain: network.key, payWith: option.coin, chainName: network.chainName, option })));
    return new Promise((resolve) => {
      const items = ready.map(choice => ({ label: paymentChoiceLabel(choice, current),
        run: () => resolve({ paymentChain: choice.paymentChain, payWith: choice.payWith }) }));
      if (!items.length) items.push({ label: 'Back · no coin has enough funds right now', run: () => resolve(current) });
      this.showMenu(ready.length > 1 ? 'Choose how to pay · gas is always paid in ETH' : 'Only this option has enough funds right now',
        items, { onCancel: () => resolve(current) });
    });
  }
  async publishDraft() {
    const outcome = await this.run('Checking balances on all networks...', async (signal) => {
      const draft = this.draft;
      if (!draft.requestKey) Object.assign(draft, await this.services.saveDraft(draft));
      const action = draft.parent ? 'job.continue' : 'job.open';
      let wallet;
      try {
        if (!draft.requestKey) {
          const checked = await this.autoPayment({ action, signal, prefer: draft.payment });
          wallet = checked.choice;
          draft.payment = checked.payment;
        }
      } catch (error) {
        if (error.code !== 'wallet_required') throw error;
        const setupWallet = await this.confirm({ title: 'Draft saved',
          lines: ['Your request is saved in My tasks.', 'Create or import a wallet to continue.'],
          acceptLabel: 'Open Wallets', cancelLabel: 'Back to My tasks' });
        return { status: 'draft', setupWallet, draftId: draft.id };
      }
      this.update({ busy: 'Understanding your request...' });
      const parent = draft.parent ? await this.services.detail({ jobId: draft.parent }, signal) : null;
      const plan = draft.plan ?? await this.services.plan({
        objective: draft.objective, parent, signal, ask: (questions) => this.ask(questions),
        onProgress: (event) => {
          this.update(event.stage === 'loaded'
            ? { busy: 'Understanding your request...', modelProgress: null }
            : { busy: 'Preparing local LLM...', modelProgress: event });
        },
      });
      signal.throwIfAborted();
      if (!plan.input) throw new Error(plan.questions.join('\n') || 'This request is not supported.');
      draft.plan = plan;
      if (!draft.requestKey) Object.assign(draft, await this.services.saveDraft(draft));
      this.update({ busy: 'Checking the task and requesting an IMD quote...' });
      let repick = false;
      const publish = async (input) => {
        // After a top-up the funded network or coin may differ from the one
        // that came up short; unsigned orders follow the new balances.
        if (repick) {
          const checked = await this.autoPayment({ action, signal, prefer: draft.payment });
          wallet = checked.choice;
          draft.payment = checked.payment;
          input = { ...input, paymentChain: draft.payment.paymentChain, payWith: draft.payment.payWith, expectedWallet: wallet.address };
          repick = false;
        }
        try { return await this.services.publish(input); }
        catch (error) {
          if (error.code === 'funding_required' && error.funding?.canChangePayment) repick = true;
          throw error;
        }
      };
      for (;;) {
        try {
          const result = await this.withFundingRetry(() => publish({
            input: plan.input, action, paymentChain: draft.payment?.paymentChain, payWith: draft.payment?.payWith,
            expectedWallet: wallet?.address,
            requestKey: draft.requestKey ?? draft.id,
            onSaved: async state => {
              draft.requestKey = state.requestKey;
              await this.services.deleteDraft(draft.id);
            },
            plan: { summary: plan.summary, deliverables: plan.deliverables }, signal,
            chooseSupport: choices => this.chooseSupport(choices),
            onProgress: event => this.showPaymentProgress(event),
            confirmReplacement: review => this.confirmReplacement(review),
            confirm: this.reviewPayment(),
          }));
          this.showOutcome(result);
          return result;
        } catch (error) {
          if (error.code !== 'change_payment') throw error;
          draft.payment = await this.pickPayment({ action, signal, current: draft.payment });
          this.update({ busy: 'Preparing the payment review...' });
        }
      }
    });
    if (!this.closed && outcome?.status === 'draft') {
      await this.navigate(outcome.setupWallet ? 'wallet' : 'tasks');
      this.update({ notice: 'Draft saved. Continue it from My tasks after setting up a wallet.' });
      if (outcome.setupWallet) this.walletManagement();
    } else if (!this.closed && outcome?.status === 'admitted' && outcome.state.jobId) {
      await this.navigate('tasks');
      const index = this.state.items.findIndex((item) => item.jobId === outcome.state.jobId);
      if (index >= 0) { this.update({ selected: index }); await this.loadDetail(); }
      this.update({ notice: 'Task published: ' + outcome.state.jobId });
      this.showTaskLink(outcome.state.jobId, true);
    }
  }
  showPaymentProgress(event) {
    const message = typeof event?.message === 'string' ? event.message.trim() : '';
    if (message) this.update({ busy: message });
  }
  async withFundingRetry(operation) {
    for (;;) {
      try { return await operation(); }
      catch (error) {
        if (error.code !== 'funding_required') throw error;
        const accepted = await this.confirm({
          title: 'Add funds to continue', lines: fundingInstructions(error.funding),
          acceptLabel: 'Check balance & continue', cancelLabel: 'Back',
          extraAction: { label: 'Add funds', run: () => this.addFunds(error.funding) },
        });
        if (!accepted) throw cancelled();
        this.update({ busy: 'Checking balances and refreshing prices...' });
      }
    }
  }
  showOutcome({ state, status, check }) {
    if (status === 'admitted' && state.jobId) {
      this.draft = null;
      this.update({ notice: 'Task published: ' + state.jobId + '. Press r to refresh My tasks.' });
      this.showTaskLink(state.jobId, true);
    } else if (status === 'blocked') {
      this.update({ error: 'Not paid. ' + check.blockers.map((b) => b.detail ?? b.code).join('\n') });
    } else if (status === 'refused') {
      this.update({ error: 'Paid, but the task was refused.\n' + (state.refusalProblems ?? []).map((p) => p.detail ?? p.code).join('\n') + '\nOrder: ' + state.orderId });
    } else if (PAYMENT_RECOVERY_STATUSES.has(status)) {
      const lines = [
        'Payment needs review.',
        'Your request is saved in My tasks.',
        'Continue payment there to check the original payment before retrying.',
      ];
      const transaction = state?.pendingTransaction ?? state?.transaction;
      if (transaction?.hash) lines.push('Transaction: ' + transaction.hash);
      if (transaction?.explorerUrl) lines.push('Explorer: ' + transaction.explorerUrl);
      this.update({ error: lines.join('\n') });
    } else this.update({ error: 'Order status: ' + status + '. Inspect it in My tasks before trying another payment.' });
  }
  async resumeOrder() {
    const item = this.selected();
    if (this.state.view === 'tasks' && item?.draftId) {
      const draft = await this.run('Opening draft...', () => this.services.loadDraft(item.draftId));
      if (draft) { this.draft = draft; this.editDraft(); }
      return;
    }
    if (this.state.view !== 'tasks' || !item?.requestKey || item.jobId || !item.canResume) return;
    this.draft = null;
    await this.run('Checking the saved order...', async (signal) => {
      // Unsigned orders may switch to whichever network and coin is funded now.
      // Anything already signed resumes on its original terms.
      let payment;
      let review;
      let action;
      if (item.canCancel) {
        const order = await this.services.detail(item, signal);
        action = order.action ?? 'job.open';
        this.update({ busy: 'Checking balances on all networks...' });
        payment = (await this.autoPayment({ action, signal,
          prefer: { paymentChain: order.paymentChain ?? 'ethereum', payWith: order.payWith ?? 'IMD' } })).payment;
        review = this.reviewPayment({ title: 'Review saved payment' });
      }
      let repick = false;
      const resume = async () => {
        if (repick) {
          payment = (await this.autoPayment({ action, signal, prefer: payment })).payment;
          repick = false;
        }
        try {
          return await this.services.resume(item, (data) => this.confirm(data), signal,
            choices => this.chooseSupport(choices), event => this.showPaymentProgress(event), next => this.confirmReplacement(next),
            { payment, review });
        } catch (error) {
          if (item.canCancel && error.code === 'funding_required' && error.funding?.canChangePayment) repick = true;
          throw error;
        }
      };
      for (;;) {
        try {
          this.showOutcome(await this.withFundingRetry(resume));
          return;
        } catch (error) {
          if (error.code !== 'change_payment') throw error;
          payment = await this.pickPayment({ action, signal, current: payment });
          this.update({ busy: 'Preparing the payment review...' });
        }
      }
    });
  }
  taskMenu() {
    const item = this.selected();
    if (this.state.view !== 'tasks' || !item) return;
    const actions = [{ label: 'View details', run: () => this.update({ focus: 'detail', tab: 'Overview', scroll: 0 }) }];
    if (item.draftId) {
      actions.push({ label: 'Continue draft', run: () => this.resumeOrder() },
        { label: 'Delete draft', run: () => this.deleteTaskDraft() });
    } else if (item.jobId) {
      actions.push(
        { label: 'View result files', run: () => this.files() },
        { label: 'Download files', run: () => this.download() },
        { label: 'View task on IMD', run: () => this.showTaskLink() },
      );
      if (item.state === 'completed') actions.push({ label: 'Request changes (new paid task)', run: () => this.continueTask() });
    } else if (item.requestKey) {
      if (item.canResume) actions.push({ label: item.canCancel ? 'Review & pay' : 'Inspect / resume saved order', run: () => this.resumeOrder() });
      if (item.canCancel) actions.push({ label: 'Cancel request', run: () => this.cancelRequest() });
      if (item.canDelete) actions.push({ label: 'Delete local record', run: () => this.deleteRequest() });
    }
    this.showMenu('Task actions', actions);
  }
  async deleteTaskDraft() {
    const item = this.selected();
    if (!item?.draftId) return;
    if (!await this.confirm({ title: 'Delete draft?', lines: [item.title], acceptLabel: 'Delete draft', cancelLabel: 'Keep draft' })) return;
    const result = await this.run('Deleting draft...', () => this.services.deleteDraft(item.draftId));
    if (result) {
      if (this.draft?.id === item.draftId) this.draft = null;
      await this.refresh();
    }
  }
  async cancelRequest() {
    const item = this.selected();
    if (this.state.view !== 'tasks' || !item?.canCancel) return;
    let changed = false;
    await this.run('Cancelling request...', async () => {
      if (!await this.confirm({
        title: 'Cancel this request?',
        lines: [item.title, '', 'No payment has been signed or submitted.', 'This request will no longer be payable from Colony.', 'You can create a new task whenever you want.'],
        acceptLabel: 'Cancel request', cancelLabel: 'Keep request',
      })) return;
      await this.services.cancel(item);
      changed = true;
    });
    if (changed && !this.closed) {
      await this.refresh();
      this.update({ notice: 'Request cancelled. No payment was signed or submitted.' });
    }
  }
  async deleteRequest() {
    const item = this.selected();
    if (this.state.view !== 'tasks' || !item?.canDelete) return;
    let changed = false;
    await this.run('Deleting local record...', async () => {
      await this.services.delete(item);
      changed = true;
    });
    if (changed && !this.closed) {
      await this.refresh();
      this.update({ notice: 'Local record deleted.' });
    }
  }
  download() {
    const item = this.selected();
    if (!item?.jobId) return;
    this.showForm('Download task files', [{ name: 'out', label: 'Save under this directory', value: './output/' + item.jobId }], async ({ out }) => {
      if (!out.trim()) throw new Error('Choose an output directory.');
      this.update({ form: null });
      await this.run('Downloading verified files...', async (signal) => {
        const result = await this.services.download({ id: item.jobId, out, signal, onProgress: (event) => this.update({ busy: 'Saved ' + event.path }) });
        this.update({ notice: 'Saved ' + result.files.length + ' verified files to ' + out });
      });
    }, { submit: 'Download' });
  }
  addTarget() {
    this.showForm('Add a worker target', [
      { name: 'host', label: 'SSH user@host (empty = this computer)' },
      { name: 'port', label: 'SSH port', value: '22' },
      { name: 'identity', label: 'SSH identity file (optional)' },
    ], async (values) => {
      const target = createWorkerTarget(values);
      if (!this.extraTargets.some((t) => t.id === target.id)) this.extraTargets.push(target);
      this.update({ form: null });
      await this.refresh();
      this.update({ selected: this.state.items.findIndex((t) => t.id === target.id) });
      await this.loadDetail();
    }, { submit: 'Add target' });
  }
  showMenu(title, items, { onCancel, selected = 0, lines, hint, numbered = false } = {}) {
    this.cancelAutoRefresh();
    this.menuCancel = onCancel ?? null;
    this.update({ menu: { title, items, selected, lines, hint, numbered }, form: null });
  }
  chooseSupport(choices) {
    return new Promise((resolve, reject) => {
      this.showMenu('Choose payment · support is optional', choices.map((choice, index) => ({
        label: choice.label,
        run: () => resolve(index),
      })), { onCancel: () => reject(cancelled()), selected: DEFAULT_SUPPORT_CHOICE });
    });
  }
  dismissMenu() {
    const cancel = this.menuCancel;
    this.menuCancel = null;
    this.update({ menu: null });
    cancel?.();
  }
  chooseMenu() {
    const item = this.state.menu.items[this.state.menu.selected];
    this.menuCancel = null;
    this.update({ menu: null });
    item.run();
  }
  workerMenu() {
    const target = this.selected();
    if (!target || target.kind === 'network-worker') return;
    const command = (args, interactive = false) => () => this.workerCommand(args, interactive);
    const named = (title, args, name, label, interactive = false) => () => this.showForm(title, [{ name, label }], (values) => {
      if (!values[name].trim()) throw new Error(label + ' is required.');
      this.update({ form: null });
      return this.workerCommand(args.concat(values[name].trim()), interactive);
    });
    this.showMenu('Worker · ' + target.title, [
      { label: 'Status', run: command(['status']) },
      { label: 'View logs', run: command(['logs']) },
      { label: 'Run diagnostics', run: command(['doctor']) },
      { label: 'Identity', run: command(['whoami']) },
      { label: 'Deploy official worker', run: command(['deploy'], true) },
      { label: 'Pair with wallet', run: command(['pair'], true) },
      { label: 'Register on chain', run: command(['register'], true) },
      { label: 'Install background service', run: () => this.serviceInstall() },
      ...['start', 'stop', 'restart', 'update'].map((name) => ({ label: name[0].toUpperCase() + name.slice(1), run: command([name], true) })),
      { label: 'Skills', run: () => this.showMenu('Worker skills', [
        { label: 'List skills', run: command(['skills', 'list']) },
        { label: 'Add skill', run: named('Add skill', ['skills', 'add'], 'id', 'Skill ID') },
        { label: 'Remove skill', run: named('Remove skill', ['skills', 'remove'], 'id', 'Skill ID') },
      ]) },
      { label: 'Tools & credentials', run: () => this.showMenu('Worker tools', [
        { label: 'List tools', run: command(['tools', 'list']) },
        { label: 'Add tool', run: command(['tools', 'add'], true) },
        { label: 'Set tool credential (hidden input)', run: named('Tool credential', ['tools', 'key'], 'name', 'Credential name', true) },
        { label: 'Forget credential', run: named('Forget credential', ['tools', 'forget'], 'name', 'Credential name', true) },
        { label: 'Remove tool', run: named('Remove tool', ['tools', 'remove'], 'id', 'Tool ID') },
      ]) },
      { label: 'RPC endpoints', run: () => this.showMenu('Worker RPC endpoints', [
        { label: 'List RPC endpoints', run: command(['rpc', 'list']) },
        { label: 'Add RPC endpoint (hidden input)', run: named('Add RPC', ['rpc', 'add'], 'chain', 'Chain ID', true) },
        { label: 'Remove RPC endpoint', run: named('Remove RPC', ['rpc', 'remove'], 'chain', 'Chain ID') },
      ]) },
      { label: 'Unlink worker', run: command(['unlink'], true) },
    ]);
  }
  serviceInstall() {
    this.showForm('Install background service', [
      { name: 'runtime', label: 'Runtime (claude or codex)', value: 'claude' },
      { name: 'concurrency', label: 'Concurrent tasks (1–4)', value: '1' },
      { name: 'boot', label: 'Linux start at boot (yes/no)', value: 'no' },
    ], async ({ runtime, concurrency, boot }) => {
      if (!['claude', 'codex'].includes(runtime)) throw new Error('Choose claude or codex.');
      if (!/^[1-4]$/.test(concurrency)) throw new Error('Concurrency must be 1–4.');
      if (!['yes', 'no'].includes(boot)) throw new Error('Enter yes or no.');
      const args = ['service', 'install', '--runtime', runtime, '--concurrency', concurrency];
      if (boot === 'yes') args.push('--boot');
      this.update({ form: null });
      await this.workerCommand(args, true);
    });
  }
  async workerCommand(args, interactive = false) {
    const target = this.selected();
    if (!target || target.kind === 'network-worker') return;
    await this.run('Worker: ' + args.join(' ') + '...', async (signal) => {
      if (interactive) {
        if (!await this.confirm({ title: 'Run on ' + target.title + '?', lines: ['colony worker ' + args.join(' '), 'The command will open in your terminal, then return here.'] })) return;
        await this.terminal(['worker', ...args], target);
        this.update({ notice: 'Command finished. Press r to refresh worker status.' });
      } else {
        const output = await this.services.command(['worker', ...args], target, signal);
        this.update({ detail: { output }, focus: 'detail', scroll: 0 });
      }
    });
  }
  requestPassword(label) {
    return new Promise((resolve, reject) => {
      this.passwordReject = reject;
      this.showForm('Confirm wallet password', [{ name: 'password', label, secret: true }], ({ password }) => {
        this.update({ form: null });
        this.passwordReject = null;
        resolve(password);
      }, { submit: 'Continue', onCancel: () => {
        this.passwordReject = null;
        reject(new Error('Wallet unlock cancelled. No payment was signed.'));
      } });
    });
  }
  walletMenu() {
    const local = this.state.detail?.source === 'local';
    if (!this.state.detail?.configured) return;
    this.showMenu('Selected wallet actions', [
      ...(!this.walletIsCurrent() && this.selected() ? [{ label: 'Use this wallet', run: () => this.useSelectedWallet() }] : []),
      ...(local ? [
        { label: 'View private key', run: () => this.walletPrivateKey() },
        { label: 'Back up encrypted wallet', run: () => this.walletBackup() },
        { label: 'Delete wallet', run: () => this.walletDelete() },
      ] : []),
      ...(this.state.detail?.configured ? [
        { label: 'Receive funds / QR code', run: () => this.walletReceive() },
      ] : []),
    ]);
  }
  // Offered once per launch while this computer has no wallet at all.
  async offerFirstWallet() {
    if (this.closed || this.state.busy || this.state.form || this.state.menu || this.state.confirm) return;
    if (this.services.wallets().length) return;
    let wallet;
    try { wallet = await this.services.wallet(undefined, undefined, { balances: false }); }
    catch { return; }
    if (wallet.configured || this.closed || this.state.busy || this.state.form || this.state.menu || this.state.confirm) return;
    const later = () => this.update({ notice: 'No wallet created. Create one anytime in Wallets (press 4, then n).' });
    this.showMenu('Welcome to Colony', [
      { label: '1. Create a new wallet (empty, add funds later)', run: () => this.walletSetup(false, { firstRun: true }) },
      { label: '2. Not now (browse without a wallet)', run: later },
    ], {
      onCancel: later, numbered: true,
      lines: ['No wallet found on this computer.', 'You need a wallet to pay for tasks. Browsing works without one.',
        'The wallet key is encrypted with your password and stays on this computer.', ''],
      hint: '1 / 2 or Up/down · Enter choose · Esc not now',
    });
  }
  walletManagement() {
    this.showMenu('Wallet management · all wallets', [
      { label: 'Create a new local wallet', run: () => this.walletSetup(false) },
      { label: 'Import wallet', run: () => this.walletImport() },
    ]);
  }
  walletImport() {
    this.showMenu('Import wallet', [
      { label: 'From private key', run: () => this.walletSetup(true) },
      { label: 'From encrypted backup', run: () => this.walletRestore() },
    ]);
  }
  walletIsCurrent() { return !this.selected() || this.selected().address === this.state.address; }
  async walletDelete() {
    const address = this.selected()?.address ?? this.state.detail?.address;
    if (this.state.detail?.source !== 'local' || !address) return;
    if (!await this.confirm({
      title: 'Delete wallet · 1 of 2',
      lines: [address, 'Remove this wallet from Colony?', 'On-chain funds stay at this address.'],
      acceptLabel: 'Continue', cancelLabel: 'Keep wallet',
    })) return;
    if (!await this.confirm({
      title: 'Delete wallet · 2 of 2',
      lines: [address, 'The local encrypted private key will be deleted.', 'Keep a private key or encrypted backup to access this wallet again.'],
      acceptLabel: 'Delete wallet', cancelLabel: 'Keep wallet',
    })) return;
    const result = await this.run('Deleting local wallet...', () => this.services.deleteWallet(address));
    if (result) {
      await this.refreshWalletSelection(result.currentAddress);
      this.update({ notice: 'Wallet deleted: ' + address });
    }
  }
  walletPrivateKey() {
    const address = this.selected()?.address ?? this.state.detail?.address;
    if (this.state.detail?.source !== 'local' || !address) return;
    this.showForm('View private key · confirm password', [
      { name: 'password', label: 'Local wallet password', secret: true },
    ], async ({ password }) => {
      this.update({ form: null });
      const revealed = await this.run('Checking wallet password...', signal => this.services.revealPrivateKey(address, password, signal));
      if (revealed) this.update({ privateKeyView: revealed });
    }, { submit: 'View private key' });
  }
  async refreshWalletSelection(address, notice) {
    this.update({ selected: -1 });
    this.restoreSelectedId = address;
    await this.refresh({ notice });
  }
  async useSelectedWallet() {
    const item = this.selected();
    if (!item || this.walletIsCurrent()) return;
    const selected = await this.run('Switching wallet...', () => this.services.selectWallet(item.address));
    if (selected) {
      await this.refresh();
      this.update({ notice: 'Current wallet: ' + selected.address });
    }
  }
  walletSetup(importing, { firstRun = false } = {}) {
    const existing = this.services.wallets().length > 0 || this.state.detail?.source === 'local';
    const save = async ({ key, password, repeat }) => {
      if (!existing) {
        if (password !== repeat) throw new Error('Passwords do not match.');
        if (password.length < 8) throw new Error('Use at least 8 characters.');
      }
      this.update({ form: null });
      const result = await this.run('Encrypting wallet locally...', signal => this.services.createWallet(password, key, signal));
      if (result) {
        if (firstRun && this.state.view !== 'wallet') {
          clearTimeout(this.detailTimer);
          this.detailRequest?.abort();
          ++this.detailVersion;
          this.update({ view: 'wallet', items: [], detail: null, result: null, query: '', filter: 'All', tab: 'Overview', focus: 'list', menu: null, cursor: null, total: null, since: null });
        }
        await this.refreshWalletSelection(result.address, firstRun ? 'Wallet ready: ' + result.address + '. Press b to back up, then d to add funds.'
          : 'Wallet ready. Press b to back up before depositing funds.');
      }
    };
    if (existing && !importing) return save({});
    this.showForm(importing ? 'Import private key · encrypted locally' : 'Set local wallet password', [
      ...(importing ? [{ name: 'key', label: 'Private key (hidden)', secret: true }] : []),
      ...(!existing ? [
        { name: 'password', label: 'Local wallet password (at least 8 characters)', secret: true },
        { name: 'repeat', label: 'Confirm password', secret: true },
      ] : []),
    ], save, { submit: importing ? 'Import wallet' : 'Create wallet',
      ...(firstRun ? { onCancel: () => this.update({ notice: 'No wallet created. Create one anytime in Wallets (press 4, then n).' }) } : {}) });
  }
  walletRestore() {
    this.showForm('Restore encrypted wallet', [
      { name: 'file', label: 'Backup file path' },
      { name: 'password', label: 'Backup password', secret: true },
    ], async ({ file, password }) => {
      this.update({ form: null });
      const result = await this.run('Restoring wallet...', signal => this.services.restoreWallet(file, password, signal));
      if (result) await this.refreshWalletSelection(result.address);
    }, { submit: 'Restore wallet' });
  }
  walletBackup() {
    const address = this.selected()?.address ?? this.state.detail?.address;
    if (!address) return;
    this.showForm('Back up encrypted wallet', [{ name: 'out', label: 'Save encrypted backup to (new file)' }], async ({ out }) => {
      this.update({ form: null });
      const result = await this.run('Saving encrypted backup...', () => this.services.backupWallet(out, address));
      if (result) this.update({ notice: 'Backup saved: ' + result.path + '. Keep your password separately.' });
    }, { submit: 'Save backup' });
  }
  async walletReceive() {
    const address = this.selected()?.address ?? this.state.detail?.address;
    if (!address) return;
    await this.run('Preparing receive address...', async () => {
      this.update({ receive: await this.services.receiveWallet(address) });
    });
  }
  addFunds(funding) {
    const networks = fundingNetworks(funding).filter(network => !network.error);
    if (networks.length <= 1) return this.fundingReceive(funding, networks[0] ?? fundingNetworks(funding)[0]);
    const saved = { dialog: this.state.confirm, scroll: this.state.scroll };
    this.update({ confirm: null });
    this.showMenu('Add funds · which network will you send on?', networks.map(network => ({
      label: networkChoiceLabel(network),
      run: () => this.fundingReceive(funding, network, saved),
    })), { onCancel: () => this.update({ confirm: saved.dialog, scroll: saved.scroll }) });
  }
  async fundingReceive(funding, network, saved) {
    const dialog = saved?.dialog ?? this.state.confirm;
    const scroll = saved?.scroll ?? this.state.scroll;
    try {
      const receive = await this.services.receiveWallet(funding.address, network.key);
      this.fundingDialog = { dialog, scroll };
      this.update({ confirm: null, receive: { ...receive, targets: networkTargets(network) }, scroll: 0, error: null, notice: null });
    } catch (error) { this.update({ error: error.message, ...(saved ? { confirm: dialog, scroll } : {}) }); }
  }
  closeReceive() {
    const funding = this.fundingDialog;
    this.fundingDialog = null;
    this.update({ receive: null, ...(funding ? { confirm: funding.dialog, scroll: funding.scroll } : {}) });
  }
  saveReceiveQr() {
    const address = this.state.receive.address;
    this.showForm('Save recharge QR code', [{ name: 'out', label: 'New SVG file path', placeholder: 'colony-receive.svg' }], async ({ out }) => {
      const result = await this.services.saveQr(address, out);
      this.update({ form: null, notice: 'QR saved: ' + result.path });
    }, { submit: 'Save QR' });
  }
  close() {
    clearTimeout(this.detailTimer);
    this.menuCancel?.();
    this.menuCancel = null;
    this.passwordReject?.(new Error('Wallet unlock cancelled.'));
    this.passwordReject = null;
    lockWallet();
    this.update({ form: null, privateKeyView: null, taskLink: null });
    this.closed = true;
    this.operation?.abort();
    this.refreshRequest?.abort();
    this.detailRequest?.abort();
    this.confirmResolve?.(false);
    this.fundingDialog = null;
    this.askResolve?.([]);
    ++this.detailVersion;
    this.listeners.clear();
  }
}
