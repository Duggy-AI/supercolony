import { writeDiagnostic } from '../lib/terminal-text.mjs';
import { paymentProgressReporter } from '../lib/payment-progress.mjs';
import { confirmAction, print } from '../shared.mjs';
import { cancelOrder, deleteOrder, findOrder, listOrders, orderActions, orderSummary } from '../lib/orders.mjs';
import { refreshOrder, submitOrder } from '../lib/publish.mjs';
import { imdTaskUrl } from '../lib/task-link.mjs';

function recoveryText(state) {
  const pending = state.pendingTransaction ?? state.transaction;
  const lines = [
    'Payment needs review.',
    'Your request is saved. Continue payment to check the original payment before retrying.',
  ];
  if (pending?.hash) lines.push(`transaction: ${pending.hash}${pending.kind ? ` (${pending.kind})` : ''}`);
  if (pending?.reason) lines.push(`reason:      ${pending.reason}`);
  if (pending?.explorerUrl) lines.push(`explorer:    ${pending.explorerUrl}`);
  if (state.transactionHash && state.transactionHash !== pending?.hash) lines.push(`transaction: ${state.transactionHash}`);
  if (state.orderId) lines.push(`continue:    colony order submit ${state.orderId}`);
  return lines.join('\n') + '\n';
}

function listText(states) {
  if (states.length === 0) return 'no orders';
  const lines = ['ORDER                                 STATUS       JOB                                   ACTION'];
  for (const state of states) {
    lines.push(
      `${String(state.orderId ?? state.requestKey).padEnd(36)}  ${String(orderSummary(state).status).padEnd(10)}  ${String(state.jobId ?? '').padEnd(36)}  ${state.action}`,
    );
  }
  return lines.join('\n');
}

function showText(state) {
  const summary = orderSummary(state);
  const lines = [
    `request key: ${summary.requestKey}`,
    `order:       ${summary.orderId ?? ''}`,
    `status:      ${summary.status}`,
    `server:      ${summary.remoteStatus ?? ''}`,
    `action:      ${summary.action}`,
    `network:     ${summary.paymentChain}`,
    `pay with:    ${summary.payWith}`,
    `created:     ${summary.createdAt}`,
    `updated:     ${summary.updatedAt}`,
    `amount:      ${summary.amount ?? ''}`,
    `asset:       ${summary.asset ?? ''}`,
    `pay to:      ${summary.payTo ?? ''}`,
    `quote ends:  ${summary.quoteExpiresAt ? new Date(Number(summary.quoteExpiresAt) * 1000).toISOString() : ''}`,
    `signed:      ${summary.paymentSigned}`,
    `payment:     ${summary.paymentStatus ?? ''}`,
    `tx:          ${summary.transactionHash ?? ''}`,
    `job:         ${summary.jobId ?? ''}`,
    `status URL:  ${summary.statusUrl ?? ''}`,
    `result URL:  ${summary.resultUrl ?? ''}`,
  ];
  if (summary.taskUrl) lines.push(`IMD:         ${summary.taskUrl}`);
  if (summary.lastError) lines.push(`last error:  ${summary.lastError}`);
  const pending = state.pendingTransaction;
  if (pending?.hash) lines.push(`pending tx:  ${pending.hash}${pending.kind ? ` (${pending.kind})` : ''}`);
  if (pending?.reason) lines.push(`pending why: ${pending.reason}`);
  if (pending?.explorerUrl) lines.push(`explorer:    ${pending.explorerUrl}`);
  if (summary.funding) {
    lines.push('conversion:  ' + summary.funding.amount, 'max debit:   ' + summary.funding.maximumDebit);
    for (const step of summary.funding.steps) lines.push(`  ${step.kind}: ${step.status ?? 'not started'}${step.hash ? ' ' + step.hash : ''}`);
  }
  if (summary.cancelledAt) lines.push(`cancelled:   ${summary.cancelledAt} (locally; no payment signed or submitted)`);
  return lines.join('\n');
}

function submitText(state) {
  const lines = [`status: ${state.status}`, `order:  ${state.orderId}`];
  if (state.jobId) lines.push(`job:    ${state.jobId}`, `IMD:    ${imdTaskUrl(state.jobId)}`);
  if (state.statusUrl) lines.push(`status: ${state.statusUrl}`);
  if (state.resultUrl) lines.push(`result: ${state.resultUrl}`);
  if (state.transactionHash) lines.push(`tx:     ${state.transactionHash}`);
  return lines.join('\n');
}

function refusedText(state) {
  const lines = [
    `order ${state.orderId} was admitted, but IMD refused the job.`,
    `payment: ${state.paymentStatus ?? 'unknown'}${state.transactionHash ? ` tx ${state.transactionHash}` : ''}`,
  ];
  for (const problem of state.refusalProblems ?? []) {
    lines.push(`  - ${problem.code ?? 'refused'}: ${problem.detail ?? JSON.stringify(problem)}`);
  }
  lines.push(`inspect: colony order show ${state.orderId} --refresh`);
  return `${lines.join('\n')}\n`;
}

export function registerOrderCommands(program) {
  const order = program.command('order').description('inspect, recover and cancel saved orders');

  order
    .command('list')
    .description('list locally saved orders')
    .action(async (options, command) => {
      const opts = command.optsWithGlobals();
      const states = await listOrders(opts.home);
      print(opts.json ? states.map(orderSummary) : listText(states), opts);
    });

  order
    .command('show <id>')
    .description('show local order state; --refresh also reads the server')
    .option('--refresh', 'read GET /requests/:id with the saved token and update local state')
    .action(async (id, options, command) => {
      const opts = command.optsWithGlobals();
      const state = opts.refresh
        ? await refreshOrder({ home: opts.home, id })
        : await findOrder(opts.home, id);
      print(opts.json ? orderSummary(state) : showText(state), opts);
    });

  order
    .command('cancel <id>')
    .description('cancel an unsigned, unsubmitted request locally; no wallet or network needed')
    .action(async (id, options, command) => {
      const opts = command.optsWithGlobals();
      const state = await findOrder(opts.home, id);
      if (!orderActions(state).canCancel) {
        throw new Error('This request cannot be cancelled locally. Only unsigned, unsubmitted requests can be cancelled.');
      }
      await confirmAction(`Cancel this unpaid request?\n${state.input.objective}\nNo payment will be signed or submitted by this request.`, opts);
      const cancelled = await cancelOrder(opts.home, id);
      print(opts.json ? orderSummary(cancelled) : 'Request cancelled locally. No payment was signed or submitted.', opts);
    });

  order
    .command('delete <id>')
    .description('delete the local record of a cancelled unsigned request')
    .action(async (id, options, command) => {
      const opts = command.optsWithGlobals();
      const state = await findOrder(opts.home, id);
      if (!orderActions(state).canDelete) {
        throw new Error('Cancel this unsigned request first. Signed payment recovery records cannot be deleted.');
      }
      await confirmAction(`Delete this cancelled request from local history?\n${state.input.objective}\nThis removes its saved details permanently.`, opts);
      const deleted = await deleteOrder(opts.home, id);
      print(opts.json ? { deleted: true, requestKey: deleted.requestKey, orderId: deleted.orderId ?? null } : 'Local record deleted.', opts);
    });

  order
    .command('submit <id>')
    .description('continue a saved task, refreshing unpaid quotes when needed')
    .action(async (id, options, command) => {
      const opts = command.optsWithGlobals();
      let state;
      try {
        state = await submitOrder({
          ...opts,
          api: opts.api,
          home: opts.home,
          id,
          onProgress: paymentProgressReporter(opts),
        });
      } catch (error) {
        if (!['transaction_pending', 'payment_reconciling'].includes(error.code)) throw error;
        if (opts.json) print({ status: error.code, transaction: error.transaction ?? null, message: error.message }, opts);
        else writeDiagnostic(recoveryText({ orderId: id, transaction: error.transaction }, error.code));
        process.exitCode = 1;
        return;
      }
      if (state.status === 'refused') {
        if (opts.json) {
          print({ ...orderSummary(state), status: 'refused' }, opts);
        } else {
          writeDiagnostic(refusedText(state));
        }
        process.exitCode = 1;
        return;
      }
      if (['expired', 'payment_failed', 'transaction_pending', 'payment_reconciling'].includes(state.status)) {
        if (opts.json) print({ ...orderSummary(state), status: state.status }, opts);
        else writeDiagnostic(recoveryText(state));
        process.exitCode = 1;
        return;
      }
      if (state.status !== 'admitted') {
        throw new Error(`order ended with status: ${state.status}; inspect it with colony order show ${state.orderId} --refresh`);
      }
      print(opts.json ? orderSummary(state) : submitText(state), opts);
    });
}
