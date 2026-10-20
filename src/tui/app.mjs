import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import TextInput from 'ink-text-input';
import stringWidth from 'string-width';
import { visibleItems, VIEWS } from './controller.mjs';
import { clean, detailText, lines, short, statusLabel, taskActions } from './presentation.mjs';
import { modelProgressLines } from '../planner/progress.mjs';

const ASCII_BORDER = { topLeft: '+', top: '-', topRight: '+', right: '|', bottomRight: '+', bottom: '-', bottomLeft: '+', left: '|' };
const LABELS = { tasks: 'My tasks', explore: 'Explore', workers: 'Workers', wallet: 'Wallets' };
const TIPS = [
  'Tip: Describe a task in plain English.',
  'Tip: Colony handles task settings.',
  'Tip: Your local LLM has no API fees.',
  'Tip: Review the price before paying.',
  'Tip: Resume unpaid tasks in My tasks.',
];
const statusColor = (state) => state === 'cancelled' ? 'gray' : state === 'completed' ? 'green' : ['challenged', 'blocked', 'refused', 'payment_failed', 'expired'].includes(state) ? 'yellow' : 'cyan';
const text = (value, props = {}) => h(Text, props, clean(value));

function Loading({ label }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % 4), 150);
    return () => clearInterval(timer);
  }, []);
  return text(['|', '/', '-', '\\'][frame] + ' ' + label, { color: 'cyan', wrap: 'truncate-end' });
}

function Panel({ title, width, height, ascii, active, children }) {
  return h(Box, { width, height, flexDirection: 'column', borderStyle: ascii ? ASCII_BORDER : 'single', borderColor: active ? 'cyan' : 'gray', paddingX: 1, flexShrink: 0, overflow: 'hidden' },
    text(title, { color: active ? 'cyan' : undefined, dimColor: !active }), children);
}

function actionRows(actions, width) {
  const rows = [];
  for (const action of actions) {
    const last = rows.length - 1;
    if (last >= 0 && stringWidth(rows[last] + '  ' + action) <= width) rows[last] += '  ' + action;
    else rows.push(action);
  }
  return rows;
}

function PanelActions({ rows, width, ascii }) {
  if (!rows.length) return null;
  return h(Box, { flexDirection: 'column', flexShrink: 0 },
    text((ascii ? '-' : '─').repeat(width), { dimColor: true }),
    ...rows.map((row, key) => text(row, { key, color: 'cyan', bold: true })),
  );
}

function ModelPreparation({ event, width, height, ascii }) {
  const content = modelProgressLines(event, { width: width - 4, compact: true }).slice(2);
  return h(Panel, { title: 'Preparing local LLM', width, height, ascii, active: true },
    h(Box, { flexDirection: 'column' },
      ...content.map((line, index) => line.startsWith('[>]')
        ? h(Loading, { key: index, label: line.slice(4) })
        : text(line || ' ', { key: index, color: line.startsWith('[+]') ? 'green' : 'cyan' }))),
    h(Box, { flexGrow: 1 }));
}

function ScrollText({ content, width, height, offset }) {
  const wrapped = lines(content, width);
  const start = Math.min(offset, Math.max(0, wrapped.length - height));
  return h(Box, { flexDirection: 'column', height, overflow: 'hidden' },
    ...wrapped.slice(start, start + height).map((line, i) => text(line || ' ', { key: i })),
  );
}

function List({ state, height, width, ascii }) {
  const items = visibleItems(state);
  const exploring = state.view === 'explore';
  const actions = state.view === 'tasks' ? ['[n] New task', '[/] Search', '[f] Filter', '[r] Refresh']
    : exploring ? ['[n] New task', '[/] Search', '[r] Refresh']
    : state.view === 'workers' ? ['[a] Add target', '[/] Search', '[r] Refresh'] : [];
  if (state.view !== 'wallet' && (state.error || state.refreshError)) actions.push('[e] Error details');
  const footerRows = actionRows(actions, width);
  const total = exploring ? state.total : items.length;
  const summary = exploring
    ? total === null ? items.length + ' results loaded' : total.toLocaleString('en-US') + (total === 1 ? ' task' : ' tasks')
    : items.length + (state.view === 'wallet' ? ' wallets' : state.view === 'workers' ? ' entries · Mine + Network' : ' items · ' + state.filter);
  const position = total === null ? 'Item ' + (state.selected + 1) : (state.selected + 1) + '/' + total.toLocaleString('en-US');
  const atEnd = exploring && state.selected === items.length - 1;
  let hint = 'up/down';
  if (atEnd) {
    if (state.busy) hint = 'Loading history...';
    else if (state.error && state.cursor) hint = 'l retry history';
    else hint = state.cursor ? 'down loads more' : 'End of history';
  }
  const navigation = items.length ? actionRows([position, hint, 'Enter/Tab details'], width) : [];
  const footerHeight = footerRows.length ? footerRows.length + 1 : 0;
  const count = Math.max(1, Math.floor((height - 4 - navigation.length - footerHeight) / 3));
  const start = Math.max(0, Math.min(state.selected - Math.floor(count / 2), items.length - count));
  return h(Box, { flexDirection: 'column', flexGrow: 1 },
    text(summary, { dimColor: true }),
    ...items.slice(start, start + count).map((item, i) => h(Box, { key: item.id, flexDirection: 'column' },
      text((state.selected === start + i ? '> ' : '  ') + short((item.kind === 'managed-worker' ? 'Mine · ' : '') + item.title, width - 2), { inverse: state.selected === start + i, bold: state.selected === start + i }),
      text('  ' + short(item.subtitle ?? statusLabel(item.state) ?? (item.installed ? 'Deployed · status on selection' : 'Not deployed'), width - 2), { color: statusColor(item.state) }),
      text((ascii ? '-' : '─').repeat(width), { dimColor: true }),
    )),
    items.length === 0 ? text(state.busy ? 'Loading...' : state.error ? 'Could not load items. Press r to retry.' : state.view === 'wallet' ? 'No wallets yet. Press n to create or i to import.' : state.view === 'tasks' ? 'No tasks yet. Press n to create one.' : 'No matching items.', { dimColor: true }) : null,
    h(Box, { flexGrow: 1 }),
    ...navigation.map((row, key) => text(row, { key, dimColor: true })),
    h(PanelActions, { rows: footerRows, width, ascii }),
  );
}

function WalletWorkspace({ state, width, height, ascii, narrow }) {
  const listWidth = narrow ? width : Math.floor(width * 0.43);
  const rightWidth = narrow ? width : width - listWidth - 1;
  const managementHeight = 5;
  const detailHeight = height - managementHeight;
  const actions = state.detail?.configured ? ['[m] Actions', '[r] Refresh'] : ['[r] Refresh'];
  if (state.error || state.refreshError) actions.push('[e] Error details');
  const footerRows = actionRows(actions, rightWidth - 4);
  const navigation = actionRows(['Esc/Tab list', 'PgUp/PgDn scroll'], rightWidth - 4);
  const list = h(Panel, { title: 'WALLETS', width: listWidth, height: narrow ? detailHeight : height, ascii, active: state.focus === 'list' },
    h(List, { state, height: narrow ? detailHeight : height, width: listWidth - 4, ascii }));
  const detail = h(Panel, { title: 'WALLET DETAILS · selected wallet', width: rightWidth, height: detailHeight, ascii, active: state.focus === 'detail' },
    h(ScrollText, { content: detailText(state), width: rightWidth - 4, height: detailHeight - 4 - navigation.length - footerRows.length, offset: state.scroll }),
    h(Box, { flexGrow: 1 }),
    ...navigation.map((row, key) => text(row, { key, dimColor: true })),
    h(PanelActions, { rows: footerRows, width: rightWidth - 4, ascii }));
  const management = h(Panel, { title: 'WALLET MANAGEMENT', width: rightWidth, height: managementHeight, ascii, active: false },
    text('[n] New wallet  [i] Import wallet'),
    text('[g] Manage wallets  [d] Receive funds'));
  if (narrow) return h(Box, { flexDirection: 'column', width, height }, state.focus === 'list' ? list : detail, management);
  return h(Box, { width, height, gap: 1 }, list,
    h(Box, { width: rightWidth, flexDirection: 'column' }, detail, management));
}

function InputForm({ controller, state, width, height, ascii }) {
  const form = state.form;
  const active = form.fields[form.field];
  const prior = form.fields.slice(0, form.field).map((field) => field.label + ': ' + (field.secret ? '********' : form.values[field.name]));
  return h(Panel, { title: form.title, width, height, ascii, active: true },
    h(Box, { marginTop: 1, flexDirection: 'column' },
      ...prior.map((line, i) => text(short(line, width - 6), { key: i, dimColor: true })),
      text(active.label, { bold: true }),
      h(Box, { marginTop: 1, minHeight: 2, maxHeight: Math.max(2, height - 9), overflow: 'hidden' },
        text('> ', { color: 'cyan' }),
        h(TextInput, {
          key: active.name, value: form.values[active.name], placeholder: active.placeholder ?? '',
          mask: active.secret ? '*' : undefined,
          onChange: (value) => controller.setField(value),
          onSubmit: () => form.field === form.fields.length - 1 ? void controller.submitForm() : controller.nextField(),
        }),
      ),
      text(form.error ?? '', { color: 'red' }),
      form.hint ? text(form.hint, { dimColor: true }) : null,
    ),
    h(Box, { flexGrow: 1 }),
    text('Enter ' + (form.field === form.fields.length - 1 ? form.submit : 'next') + ' · Tab switch field · Esc cancel', { color: 'cyan', wrap: 'truncate-end' }),
  );
}

function Confirmation({ state, width, height, ascii }) {
  const dialog = state.confirm;
  const payment = dialog.payment;
  const funding = payment?.funding;
  const coin = funding?.coin ?? payment?.payWith ?? 'IMD';
  const feeLine = payment ? (payment.support ? 'Total ' + payment.support.total + ' IMD (fee ' + payment.amount + ' + support ' + payment.support.amount + ')' : 'Fee ' + payment.amount + ' IMD') : null;
  const networkLine = payment ? 'Pay with ' + coin + ' on ' + payment.chainName : null;
  const debitLine = funding && coin !== 'IMD' ? 'Payment: at most ' + (funding.display?.payment ?? funding.amount) + (funding.converted ? ' (converted)' : '') : null;
  const gasValue = funding?.display?.gas ?? (payment?.networkFeeCap ? payment.networkFeeCap + ' ETH' : null);
  const gasLine = gasValue ? 'Gas (network fee): at most ' + gasValue : null;
  const warning = payment ? (payment.support ? 'Support is sent first; no refund if admission fails. Task completion is not guaranteed.' : 'Admission payment only. Completion is not guaranteed.') : null;
  let paymentAction = payment ? 'Pay ' + (payment.support?.total ?? payment.amount) + ' IMD & publish' : '';
  if (payment?.funding && payment.funding.coin !== 'IMD') paymentAction = payment.funding.converted ? 'Continue & publish' : 'Convert & publish';
  const occupied = 2 + lines(dialog.title ?? 'Review saved payment', width - 4).length
    + [feeLine, networkLine, debitLine, gasLine, warning].filter(Boolean).reduce((sum, line) => sum + lines(line, width - 4).length, 0)
    + (width < 70 ? (dialog.extraAction ? 3 : 2) : 1) + 1;
  const content = payment ? [
    'REQUEST', payment.objective, '',
    ...payment.deliverables.map((item) => '- ' + item), '',
    ...(payment.support ? ['Help us make Colony better.', 'Optional support: ' + payment.support.amount + ' IMD', 'Support recipient: ' + payment.support.recipient, 'Support and task payment are separate transactions.', ''] : []),
    ...(funding && coin !== 'IMD' ? [
      funding.converted ? 'Conversion to IMD already confirmed.'
        : 'Colony converts ' + coin + ' to IMD for you: ≈ ' + (funding.display?.estimate ?? funding.estimatedAmount ?? funding.amount) + ', at most ' + (funding.display?.payment ?? funding.amount) + '.',
      ...(coin === 'ETH' ? ['Total ETH at most: ' + (funding.display?.maximumDebit ?? funding.maximumDebit) + ' (payment + gas)'] : []),
      'IMD for this task: ' + funding.minimumImd,
      'Conversion and task payment are separate transactions.', '',
    ] : []),
    'Gas is the blockchain network fee. It is always paid in ETH and is usually below the cap shown.',
    ...(dialog.extraAction ? ['Choose ' + dialog.extraAction.label + ' to pay with another coin or network.'] : []),
    'Prices and fees are checked again when you continue.',
    ...(dialog.expanded ? ['', 'PAYMENT DETAILS', 'Quote expires: ' + payment.expiresAt, 'Network: ' + payment.network, 'Asset: ' + payment.asset, 'Pay to: ' + payment.payTo, 'Order: ' + payment.orderId, '', 'SERVER PREPARED INPUT', JSON.stringify(payment.prepared, null, 2)] : []),
  ].join('\n') : dialog.lines.join('\n');
  return h(Panel, { title: dialog.title ?? 'Review saved payment', width, height, ascii, active: true },
    feeLine ? text(feeLine, { color: 'cyan', bold: true }) : null,
    networkLine ? text(networkLine, { color: 'cyan', bold: true }) : null,
    debitLine ? text(debitLine, { color: 'cyan' }) : null,
    gasLine ? text(gasLine, { color: 'yellow' }) : null,
    h(ScrollText, { content, width: width - 4, height: Math.max(0, height - occupied), offset: state.scroll }),
    h(Box, { flexGrow: 1 }),
    warning ? text(warning, { color: 'yellow' }) : null,
    h(Box, { flexDirection: width < 70 ? 'column' : 'row', gap: width < 70 ? 0 : 3 },
      text('[ ' + (dialog.cancelLabel ?? (payment ? 'Cancel / edit' : 'Cancel')) + ' ]', { inverse: dialog.selection === 0 }),
      dialog.extraAction ? text('[ ' + dialog.extraAction.label + ' ]', { inverse: dialog.selection === 1, color: 'cyan' }) : null,
      text('[ ' + (payment ? paymentAction : dialog.acceptLabel ?? 'Confirm') + ' ]', { inverse: dialog.accepted, color: 'cyan' }),
    ),
    text('Tab choose · Enter confirm · Esc cancel · PgDn scroll' + (payment ? ' · i details' : ''), { dimColor: true, wrap: 'truncate-end' }),
  );
}

function ActionMenu({ state, width, height, ascii }) {
  const menu = state.menu;
  const intro = menu.lines ?? [];
  const introHeight = intro.reduce((sum, line) => sum + Math.max(1, lines(line, width - 4).length), 0);
  const count = Math.max(1, height - 5 - introHeight);
  const start = Math.max(0, Math.min(menu.selected - Math.floor(count / 2), menu.items.length - count));
  return h(Panel, { title: menu.title, width, height, ascii, active: true },
    ...intro.map((line, i) => text(line || ' ', { key: 'intro' + i })),
    ...menu.items.slice(start, start + count).map((item, i) => text((start + i === menu.selected ? '> ' : '  ') + item.label, { key: i, inverse: start + i === menu.selected })),
    h(Box, { flexGrow: 1 }),
    text(menu.hint ?? 'Up/down select · Enter open · Esc back', { dimColor: true }),
  );
}

const HELP = 'WORKSPACES\n1 My tasks · 2 Explore · 3 Workers · 4 Wallet\n\nTASKS\nn New task · / Search · f Filter · r Refresh\nup/down Select · Enter Details · Esc Back\nTab List/details · [ / ] Detail tab\nPgUp/PgDn Scroll details · l More public tasks\nd Result files · s Save files · c Request changes\nv View official IMD task link\no Review/pay or resume a saved order\nx Cancel an unsigned request · m Task actions\nCancelled requests: m > Delete local record\nSigned payments and published tasks cannot be cancelled through the public API.\n\nWORKERS\na Add target · m Actions · l Logs · g Diagnostics\n\nWALLET\nn Create wallet · i Import wallet\nd Receive / QR · b Encrypted backup\nm Selected wallet actions · g Management\nr Refresh balances (all networks)\n\nPAYING\nColony checks every network and picks a coin you can already pay with.\nUse Change payment in the review to pick another coin or network.\n\nq Quit · Ctrl+C Cancel and exit\nTerminal is restored when you exit.';

export function DashboardApp({ controller, ascii = false, dimensions, terminal, feedback, welcome = false }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [tip, setTip] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTip(index => (index + 1) % TIPS.length), 20_000);
    return () => clearInterval(timer);
  }, []);
  const error = state.error ?? state.refreshError;
  const windowSize = useWindowSize();
  const size = dimensions ?? windowSize;
  const width = size.columns;
  const height = Math.max(8, size.rows - 1);
  const narrow = width < 80;
  const { exit } = useApp();
  useEffect(() => {
    controller.terminal = terminal;
    void controller.refresh().then(() => {
      if (feedback) controller.update(feedback);
      else if (welcome) return controller.offerFirstWallet();
    });
    return () => controller.close();
  }, [controller, terminal, feedback, welcome]);
  useEffect(() => {
    const timer = setInterval(() => { void controller.autoRefresh(); }, 5000);
    return () => clearInterval(timer);
  }, [controller]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { controller.close(); exit(); return; }
    if (state.privateKeyView) {
      if (key.escape) controller.update({ privateKeyView: null });
      return;
    }
    if (state.taskLink) {
      if (key.escape || key.return) controller.update({ taskLink: null });
      return;
    }
    if (width < 40 || size.rows < 20) {
      if (state.receive) {
        if (key.escape) controller.closeReceive();
      } else if (input === 'q') { controller.close(); exit(); }
      return;
    }
    if (state.confirm) {
      if (key.escape) controller.respond(false);
      else if (key.tab || key.leftArrow || key.rightArrow) controller.moveConfirmation(key.leftArrow || (key.tab && key.shift) ? -1 : 1);
      else if (key.return) controller.submitConfirmation();
      else if (input === 'i') controller.update({ confirm: { ...state.confirm, expanded: !state.confirm.expanded }, scroll: 0 });
      else if (key.pageDown || key.pageUp) controller.update({ scroll: Math.max(0, state.scroll + (key.pageDown ? 5 : -5)) });
      return;
    }
    if (state.form) {
      if (key.escape) controller.dismissForm();
      else if (key.tab) controller.nextField(key.shift);
      return;
    }
    if (state.receive) {
      if (key.escape) controller.closeReceive();
      if (input === 's') controller.saveReceiveQr();
      return;
    }
    if (state.menu) {
      if (key.escape) controller.dismissMenu();
      else if (key.downArrow || key.upArrow) controller.update({ menu: { ...state.menu, selected: Math.max(0, Math.min(state.menu.items.length - 1, state.menu.selected + (key.downArrow ? 1 : -1))) } });
      else if (key.return) controller.chooseMenu();
      else if (state.menu.numbered && /^[1-9]$/.test(input) && Number(input) <= state.menu.items.length) {
        controller.update({ menu: { ...state.menu, selected: Number(input) - 1 } });
        controller.chooseMenu();
      }
      return;
    }
    if (input === 'q' && !state.busy) { controller.close(); exit(); return; }
    if (state.busy) return;
    if (input === 'e' && error) { controller.showError(); return; }
    if ('1234'.includes(input) && input.length === 1) { void controller.navigate(VIEWS[Number(input) - 1]); return; }
    if (input === '?') { controller.update({ help: !state.help, scroll: 0 }); return; }
    if (key.escape) { controller.update({ focus: 'list', help: false, scroll: 0, error: null, refreshError: null, notice: null }); return; }
    if (input === 'n') { state.view === 'wallet' ? controller.walletSetup(false) : controller.create(); return; }
    if (input === 'r') { void controller.refresh(); return; }
    if (key.pageDown || key.pageUp || (state.focus === 'detail' && (key.downArrow || key.upArrow))) {
      controller.update({ scroll: Math.max(0, state.scroll + (key.pageDown ? 5 : key.pageUp ? -5 : key.downArrow ? 1 : -1)) }); return;
    }
    if (state.view === 'wallet') {
      if (key.downArrow || key.upArrow) controller.move(key.downArrow ? 1 : -1);
      if (key.return || key.tab) controller.update({ focus: state.focus === 'list' ? 'detail' : 'list', scroll: 0 });
      if (input === 'u') void controller.useSelectedWallet();
      if (input === 'm') controller.walletMenu();
      if (input === 'g') controller.walletManagement();
      if (input === 'i') controller.walletImport();
      if (input === 'd') void controller.walletReceive();
      if (input === 'b') controller.walletBackup();
      return;
    }
    if (key.downArrow || key.upArrow) { controller.move(key.downArrow ? 1 : -1); return; }
    if (key.return || key.tab) { controller.update({ focus: state.focus === 'list' ? 'detail' : 'list', scroll: 0 }); return; }
    if (state.view === 'workers') {
      if (input === '/') controller.search();
      if (input === 'a') controller.addTarget();
      if (input === 'm') controller.workerMenu();
      if (input === 'l') void controller.workerCommand(['logs']);
      if (input === 'g') void controller.workerCommand(['doctor']);
      return;
    }
    if (input === '/') controller.search();
    if (input === 'f' && state.view === 'tasks') controller.cycleFilter();
    if (input === '[' || input === ']') void controller.changeTab(input === '[' ? -1 : 1);
    if (input === 'd') void controller.files();
    if (input === 'v') controller.showTaskLink();
    if (input === 's') controller.download();
    if (input === 'c') controller.continueTask();
    if (input === 'o') void controller.resumeOrder();
    if (input === 'x') void controller.cancelRequest();
    if (input === 'm') controller.taskMenu();
    if (input === 'l') void controller.more();
  });

  if (width < 40 || size.rows < 20) return h(Box, { width, flexDirection: 'column' }, text('COLONY', { color: 'cyan' }), text('Resize to at least 40 columns and 20 rows.'), text(state.receive || state.privateKeyView || state.taskLink ? 'Esc back' : 'q quit · commands remain available with --help'));

  if (state.taskLink) return h(Panel, { title: state.taskLink.published ? 'Task published' : 'View task on IMD', width, height, ascii, active: true },
    h(Box, { marginTop: 1, flexDirection: 'column' },
      text('View progress and results on IMD.'),
      h(Box, { marginY: 1 }, text(state.taskLink.url, { color: 'cyan', bold: true })),
      text('Open this link in your browser.', { dimColor: true })),
    h(Box, { flexGrow: 1 }),
    text('Enter / Esc back', { color: 'cyan' }),
  );

  if (state.privateKeyView) return h(Panel, { title: 'Private key', width, height, ascii, active: true },
    text('Wallet: ' + state.privateKeyView.address),
    text('Anyone with this key can spend this wallet’s funds.', { color: 'yellow' }),
    h(Box, { marginTop: 1 }, text(state.privateKeyView.privateKey)),
    h(Box, { flexGrow: 1 }),
    text('Esc hide and return', { color: 'cyan' }),
  );

  if (state.receive && !state.form) {
    const receive = state.receive;
    const qrLines = receive.qr.split('\n');
    const single = !receive.networks || receive.networks.length === 1;
    const info = [
      ...(single ? ['Accepted: ' + receive.coins.join(', ')] : receive.networks.map(network => network.chainName + ': ' + network.coins.join(', '))),
      ...(receive.targets ?? []),
    ];
    const warning = single
      ? 'Send on ' + receive.chainName + ' only. Choose ' + receive.chainName + ' in the sending wallet or exchange.'
      : 'Same address on both networks. Choose the network you will pay on; funds stay there. Include ETH for gas.';
    const wrapped = [receive.address, ...info, warning].reduce((sum, line) => sum + lines(line, width).length, 0);
    const needed = qrLines.length + wrapped + 2;
    const fits = width >= qrLines[0].length && height >= needed;
    return h(Box, { width, height, flexDirection: 'column' },
      text(single ? 'Receive on ' + receive.chainName : 'Receive funds', { bold: true, color: 'cyan' }),
      text(receive.address),
      ...info.map((line, key) => text(line, { key })),
      fits ? text(receive.qr, { color: 'black', backgroundColor: 'white' }) : text('Resize to at least ' + Math.max(40, qrLines[0].length) + ' columns and ' + (needed + 1) + ' rows, or press s to save the QR.'),
      text(warning, { color: 'yellow' }),
      text(short(state.error ?? state.notice ?? 's save QR · Esc back', width), { color: state.error ? 'red' : 'cyan' }),
    );
  }

  const modal = state.form || state.confirm || state.modelProgress;
  const bodyHeight = Math.max(6, height - (modal ? 3 : 6));
  const items = visibleItems(state);
  const selected = items[state.selected];
  let body;
  if (state.form) body = h(InputForm, { controller, state, width, height: bodyHeight, ascii });
  else if (state.confirm) body = h(Confirmation, { state, width, height: bodyHeight, ascii });
  else if (state.modelProgress) body = h(ModelPreparation, { event: state.modelProgress, width, height: bodyHeight, ascii });
  else if (state.menu) body = h(ActionMenu, { state, width, height: bodyHeight, ascii });
  else if (state.help) body = h(Panel, { title: 'Keyboard shortcuts', width, height: bodyHeight, ascii, active: true },
    h(ScrollText, { content: HELP, width: width - 4, height: bodyHeight - 4, offset: state.scroll }),
    text('PgUp/PgDn scroll · Esc back', { dimColor: true }));
  else if (state.view === 'wallet') body = h(WalletWorkspace, { state, width, height: bodyHeight, ascii, narrow });
  else {
    const showList = !narrow || state.focus === 'list';
    const showDetail = !narrow || state.focus === 'detail';
    const listWidth = narrow ? width : Math.floor(width * 0.43);
    const detailWidth = showList && !narrow ? width - listWidth - 1 : width;
    const content = detailText({ ...state, selectedId: selected?.id });
    const taskView = state.view === 'tasks' || state.view === 'explore';
    const actions = taskView ? taskActions(selected, state.view)
      : !selected ? [] : selected.kind === 'network-worker' ? ['Read only']
        : ['[m] Actions', '[l] Logs', '[g] Diagnostics'];
    if (error) actions.push('[e] Error details');
    const footerRows = actionRows(actions, detailWidth - 4);
    const footerHeight = footerRows.length ? footerRows.length + 1 : 0;
    const navigation = actionRows(['Esc/Tab list', 'PgUp/PgDn scroll', ...(taskView ? ['[ ] tabs'] : [])], detailWidth - 4);
    body = h(Box, { height: bodyHeight, width, gap: 1 },
      showList ? h(Panel, { title: (state.view === 'workers' ? 'WORKERS' : state.filter) + (state.query ? ' / ' + short(state.query, 22) : ''), width: listWidth, height: bodyHeight, ascii, active: state.focus === 'list' }, h(List, { state, height: bodyHeight, width: listWidth - 4, ascii })) : null,
      showDetail ? h(Panel, { title: short(selected?.id ?? 'DETAILS', detailWidth - 7), width: detailWidth, height: bodyHeight, ascii, active: state.focus === 'detail' },
        taskView ? text(['Overview', 'Activity', 'Files'].map((tab) => tab === state.tab ? '[' + tab + ']' : tab).join('  '), { color: 'cyan', wrap: 'truncate-end' }) : null,
        h(ScrollText, { content, width: detailWidth - 4, height: bodyHeight - 3 - Number(taskView) - footerHeight - navigation.length, offset: state.scroll }),
        h(Box, { flexGrow: 1 }),
        ...navigation.map((row, key) => text(row, { key, dimColor: true })),
        h(PanelActions, { rows: footerRows, width: detailWidth - 4, ascii }),
      ) : null,
    );
  }
  const footer = state.form || state.confirm || state.menu || state.busy ? '[Ctrl+C] Exit' : '[?] Help  [q] Quit';
  const nav = width < 75 ? VIEWS.map((view, i) => '[' + (i + 1) + ']' + ['Mine', 'Browse', 'Work', 'Wallets'][i]).join(' ') : VIEWS.map((view, i) => (view === state.view ? '> ' : '  ') + '[' + (i + 1) + '] ' + LABELS[view]).join('  ');
  return h(Box, { width, height, flexDirection: 'column' },
    h(Box, { justifyContent: 'space-between', height: modal ? 1 : 2 }, text('COLONY  get things done.', { color: 'cyan', bold: true }), width >= 75 ? text(state.address ? short(state.address, 20) : 'Wallet not configured', { dimColor: true }) : null),
    !modal ? text(nav, { color: 'cyan', wrap: 'truncate-end' }) : null,
    !modal ? (state.busy || state.refreshing) ? h(Loading, { label: state.busy ?? 'Refreshing tasks...' }) : text(state.note, { dimColor: true, wrap: 'truncate-end' }) : null,
    body,
    text(short(error ?? state.notice ?? (modal || state.menu || state.busy ? '' : TIPS[tip]), width), { color: error ? 'red' : state.notice ? 'green' : undefined, dimColor: !error && !state.notice }),
    text(footer, { dimColor: true, wrap: 'truncate-end' }),
  );
}
