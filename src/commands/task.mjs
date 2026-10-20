import { writeDiagnostic } from '../lib/terminal-text.mjs';
import { paymentProgressReporter } from '../lib/payment-progress.mjs';
import { request, print } from '../shared.mjs';
import { checkJob, publishJob, readJobFile } from '../lib/publish.mjs';
import { loadOrder, orderActions } from '../lib/orders.mjs';
import {
  buildContinueInput,
  buildCreateInput,
  parentSummary,
  resolveAction,
  saveInputFile,
} from '../lib/task-input.mjs';
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  downloadTaskFiles,
  waitForResult,
} from '../lib/task-result.mjs';
import { askQuestions, loadLocalPlanner, planTask } from '../planner/flow.mjs';
import { registerMyTaskCommands } from './my-tasks.mjs';
import { orderPayment } from '../lib/payments.mjs';
import { checkTaskWallet } from '../lib/task-wallet.mjs';
import { imdTaskUrl } from '../lib/task-link.mjs';

async function chosenPayment(opts, action) {
  let prefer;
  if (opts.requestKey) {
    const order = await loadOrder(opts.home, opts.requestKey);
    // Signed orders must finish on their original network and coin.
    if (order && !orderActions(order).canCancel) return null;
    if (order) prefer = { paymentChain: order.paymentChain ?? 'ethereum', payWith: order.payWith ?? 'IMD' };
  }
  const payment = await checkTaskWallet({ ...opts, action, prefer });
  if (!opts.json) writeDiagnostic(`Paying with ${payment.payWith} on ${payment.chainName} (enough balance found).\n`);
  return payment;
}

function jobsPath(options) {
  const params = new URLSearchParams();
  if (options.q !== undefined) params.set('q', options.q);
  if (options.before !== undefined) params.set('before', options.before);
  if (options.since !== undefined) params.set('since', options.since);
  if (options.limit !== undefined) {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('--limit must be an integer from 1 to 500');
    }
    params.set('limit', String(limit));
  }
  if (options.excludeOracle) params.set('exclude', 'oracle');
  const query = params.toString();
  return query ? `/jobs?${query}` : '/jobs';
}

function oneLine(value, max = 90) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function listText(data) {
  if (!Array.isArray(data?.jobs)) throw new Error('jobs response is missing jobs');
  const lines = [`${data.count} job(s)`];
  for (const job of data.jobs) {
    lines.push(
      `${job.id}  ${job.state.padEnd(10)}  ${String(job.template ?? '').padEnd(22)}  ${job.updatedAt ?? ''}  ${oneLine(job.objective)}`,
    );
  }
  return lines.join('\n');
}

function jobText(job) {
  if (!job?.id) throw new Error('job response is missing id');
  const lines = [
    `job:       ${job.id}`,
    `IMD:       ${imdTaskUrl(job.id)}`,
    `state:     ${job.state}`,
    `template:  ${job.template ?? ''}`,
    `objective: ${oneLine(job.objective, 500)}`,
    `created:   ${job.createdAt ?? ''}`,
    `updated:   ${job.updatedAt ?? ''}`,
    `paid by:   ${job.paidBy ?? ''}`,
    `project:   ${job.project ? `${job.project.id} (${job.project.versions?.length ?? 0} version(s))` : 'none'}`,
    `delivery:  ${job.delivery ? JSON.stringify(job.delivery) : 'none'}`,
    `launch:    ${job.launch ? JSON.stringify(job.launch) : 'none'}`,
  ];
  if (Array.isArray(job.nodes)) {
    lines.push(`nodes:     ${job.nodes.length}`);
    for (const node of job.nodes) {
      lines.push(`  - ${node.key}: ${node.state} attempt=${node.attempt} verdict=${node.verdict?.status ?? 'none'}`);
    }
  }
  if (Array.isArray(job.reviews)) lines.push(`reviews:   ${job.reviews.length}`);
  if (job.workflow?.id) lines.push(`workflow:  ${job.workflow.id} ${job.workflow.status ?? ''}`.trim());
  return lines.join('\n');
}

function resultText(result) {
  if (!result?.jobId) throw new Error('result response is missing jobId');
  const lines = [
    `job:       ${result.jobId}`,
    `state:     ${result.state}`,
    `complete:  ${result.complete}`,
  ];
  const files = Array.isArray(result.files) ? result.files : [];
  lines.push(`files:     ${files.length}`);
  for (const file of files) {
    lines.push(`  - ${file.path} (${file.bytes} bytes, ${file.mediaType})`);
    lines.push(`    hash: ${file.hash}`);
    lines.push(`    url:  ${file.url}`);
  }
  const source = Array.isArray(result.source) ? result.source : [];
  lines.push(`source:    ${source.length}`);
  for (const item of source) {
    lines.push(`  - ${item.node ?? item.submissionHash}: ${item.url}`);
  }
  if (result.delivery) lines.push(`delivery:  ${JSON.stringify(result.delivery)}`);
  if (result.launch) lines.push(`launch:    ${JSON.stringify(result.launch)}`);
  return lines.join('\n');
}

function downloadText(data) {
  const lines = [
    `job:       ${data.jobId}`,
    `state:     ${data.state}`,
    `files:     ${data.files.length}`,
  ];
  for (const file of data.files) {
    lines.push(`  - ${file.path} -> ${file.file} (${file.bytes} bytes)`);
    lines.push(`    hash: ${file.hash}`);
  }
  return lines.join('\n');
}

function checkText(check) {
  const lines = [`blockers: ${check.blockers.length}`];
  for (const blocker of check.blockers) {
    lines.push(`  - ${blocker.code}: ${blocker.detail}`);
  }
  const plan = Array.isArray(check.plan) ? check.plan : [];
  lines.push(`plan: ${plan.length}`);
  for (const step of plan) {
    lines.push(`  - ${step.title ?? step.short ?? step.skill}${step.skill ? ` (${step.skill})` : ''}`);
  }
  return lines.join('\n');
}

function publishResult(state) {
  const payment = state.quote ? orderPayment(state) : null;
  return {
    status: state.status,
    action: state.action,
    requestKey: state.requestKey,
    orderId: state.orderId,
    jobId: state.jobId ?? null,
    taskUrl: imdTaskUrl(state.jobId),
    statusUrl: state.statusUrl ?? null,
    resultUrl: state.resultUrl ?? null,
    transactionHash: state.transactionHash ?? null,
    problems: state.refusalProblems ?? null,
    parentJobId: state.input?.parentJobId ?? null,
    parent: state.parent ?? null,
    project: state.check?.project ?? null,
    payer: state.payer ?? null,
    paymentChain: state.paymentChain ?? 'ethereum',
    payWith: state.payWith ?? 'IMD',
    prepared: state.challenge?.input ?? null,
    quote: state.quote
      ? {
        amount: payment.amount,
        asset: payment.asset,
        payTo: payment.payTo,
        expiresAt: state.quote.expiresAt,
      }
      : null,
  };
}

function publishText(state) {
  const lines = [
    `status:    ${state.status}`,
    `action:    ${state.action}`,
    `order:     ${state.orderId}`,
    `job:       ${state.jobId ?? ''}`,
  ];
  if (state.jobId) lines.push(`IMD:       ${imdTaskUrl(state.jobId)}`);
  if (state.statusUrl) lines.push(`statusUrl: ${state.statusUrl}`);
  if (state.resultUrl) lines.push(`resultUrl: ${state.resultUrl}`);
  if (state.transactionHash) lines.push(`tx:        ${state.transactionHash}`);
  if (state.parent) {
    lines.push(`parent:    ${state.parent.id} (${state.parent.state ?? 'unknown'})`);
    if (state.parent.project) {
      lines.push(`project:   ${state.parent.project.id} head=${state.parent.project.head ?? ''}`);
    }
  }
  if (state.check?.project) {
    const project = state.check.project;
    lines.push(`check:     ${project.summary ?? project.id ?? 'project ready'}`);
  }
  if (!state.plan && state.action === 'job.continue' && state.challenge?.input) {
    lines.push('prepared input:');
    lines.push(JSON.stringify(state.challenge.input, null, 2));
  }
  return lines.join('\n');
}

function handlePublishOutcome(result, opts) {
  if (result.status === 'blocked') {
    if (opts.json) {
      print({
        status: 'blocked',
        action: result.state.action,
        requestKey: result.state.requestKey,
        parent: result.state.parent ?? null,
        check: result.check,
      }, opts);
    } else {
      if (result.state.parent) writeDiagnostic(`${parentText(result.state.parent)}\n`);
      writeDiagnostic(`${checkText(result.check)}\nnot paid: blockers must be resolved first\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (result.status === 'refused') {
    const refused = publishResult(result.state);
    if (opts.json) {
      print({ ...refused, status: 'refused' }, opts);
    } else {
      const lines = [
        `order ${result.state.orderId} was admitted, but IMD refused the job.`,
        `payment: ${result.state.paymentStatus ?? 'unknown'}${result.state.transactionHash ? ` tx ${result.state.transactionHash}` : ''}`,
      ];
      for (const problem of result.state.refusalProblems ?? []) {
        lines.push(`  - ${problem.code ?? 'refused'}: ${problem.detail ?? JSON.stringify(problem)}`);
      }
      lines.push(`inspect: colony order show ${result.state.orderId} --refresh`);
      writeDiagnostic(`${lines.join('\n')}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (['expired', 'payment_failed', 'transaction_pending', 'payment_reconciling'].includes(result.status)) {
    const state = result.state;
    if (opts.json) {
      print({ ...publishResult(state), status: result.status }, opts);
    } else {
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
      writeDiagnostic(`${lines.join('\n')}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (result.status !== 'admitted') {
    throw new Error(`order ended with status: ${result.status}; inspect it with colony order show ${result.state.orderId} --refresh`);
  }

  print(opts.json ? publishResult(result.state) : publishText(result.state), opts);
}

function parentText(parent) {
  const summary = parentSummary(parent);
  const lines = [
    `parent:    ${summary.id}`,
    `state:     ${summary.state ?? ''}`,
    `template:  ${summary.template ?? ''}`,
    `objective: ${oneLine(summary.objective, 500)}`,
    `paid by:   ${summary.paidBy ?? ''}`,
  ];
  if (summary.project) {
    lines.push(
      `project:   ${summary.project.id} head=${summary.project.head ?? ''} versions=${summary.project.versions.length}`,
    );
  }
  return lines.join('\n');
}

function checkProjectText(project) {
  if (!project) return null;
  if (project.summary) return `project:   ${oneLine(project.summary, 500)}`;
  if (project.id) return `project:   ${project.id}`;
  return null;
}

function dryRunText(action, input, check, parent) {
  const lines = [];
  if (parent) lines.push(parentText(parent));
  lines.push(`action:    ${action}`);
  lines.push('input:');
  lines.push(JSON.stringify(input, null, 2));
  lines.push(checkText(check));
  const project = checkProjectText(check.project);
  if (project) lines.push(project);
  return lines.join('\n');
}

function hasExplicitCreate(opts) {
  return opts.file !== undefined
    || opts.preset !== undefined
    || opts.skill !== undefined
    || opts.template !== undefined
    || (Array.isArray(opts.path) && opts.path.length > 0);
}

function hasExplicitContinue(opts) {
  return opts.file !== undefined
    || opts.skill !== undefined
    || opts.template !== undefined
    || (Array.isArray(opts.path) && opts.path.length > 0);
}

function isNaturalCreate(objective, opts) {
  return typeof objective === 'string'
    && objective.trim() !== ''
    && !hasExplicitCreate(opts);
}

function isNaturalContinue(objective, opts) {
  return typeof objective === 'string'
    && objective.trim() !== ''
    && !hasExplicitContinue(opts);
}

function planText(plan) {
  const lines = [`summary: ${plan.summary}`, 'deliverables:'];
  if (plan.deliverables.length === 0) lines.push('  - none');
  for (const item of plan.deliverables) lines.push(`  - ${item}`);
  return lines.join('\n');
}

function naturalDryRunText(plan, check) {
  const lines = [planText(plan), `check: ${check.blockers.length} blocker(s)`];
  for (const blocker of check.blockers) {
    lines.push(`  - ${blocker.code}: ${blocker.detail}`);
  }
  return lines.join('\n');
}

function finishPlanQuestions(plan, action, opts) {
  if (opts.json) {
    print({
      action,
      summary: plan.summary,
      deliverables: plan.deliverables,
      questions: plan.questions,
      input: null,
    }, opts);
  } else {
    const questions = plan.questions.map((question) => `  - ${question}`).join('\n');
    print(`${planText(plan)}\nquestions:\n${questions}`, opts);
  }
  process.exitCode = 1;
}

function sourceFromOptions(opts) {
  if (opts.repo === undefined && opts.commit === undefined) return null;
  return { repoUrl: opts.repo, baseCommit: opts.commit };
}

async function planNaturalInput({
  api,
  home,
  objective,
  answers,
  parent = null,
  source = null,
  github = false,
  opts,
  loadPlanner,
}) {
  return planTask({
    api, home, loadPlanner, objective, answers, parent, source, github,
    ask: !opts.json && process.stdin.isTTY ? askQuestions : null,
  });
}

function assertSavedOrder(state, requestKey, { api, action }) {
  if (!state) throw new Error(`unknown request key: ${requestKey}`);
  if (state.api !== api) {
    throw new Error(`order ${state.requestKey} belongs to ${state.api}; rerun with --api ${state.api}`);
  }
  if (state.action !== action) {
    throw new Error(`request key ${state.requestKey} was created for action ${state.action}, not ${action}`);
  }
  if (!state.input || typeof state.input !== 'object' || Array.isArray(state.input)) {
    throw new Error(`request key ${state.requestKey} has no saved input`);
  }
  return state.input;
}

function retryCreate(state, opts) {
  return `colony --api ${state.api} --home ${opts.home} task create --request-key ${state.requestKey}`;
}

function retryContinue(state, opts) {
  return `colony --api ${state.api} --home ${opts.home} task continue ${state.input.parentJobId} --request-key ${state.requestKey}`;
}

export function registerTaskCommands(program, { loadPlanner = loadLocalPlanner } = {}) {
  const task = program.command('task').description('browse and publish IMD tasks');
  registerMyTaskCommands(task);

  task
    .command('list')
    .description('list jobs')
    .option('--q <text>', 'objective or job id prefix')
    .option('--before <time>', 'creation-time cursor (exclusive)')
    .option('--since <time>', 'jobs that moved after this time')
    .option('--limit <n>', 'page size (1-500)')
    .option('--exclude-oracle', 'exclude oracle panel jobs')
    .action(async (options, command) => {
      const opts = command.optsWithGlobals();
      const response = await request(opts.api, jobsPath(opts));
      print(opts.json ? response.data : listText(response.data), opts);
    });

  task
    .command('show <id>')
    .description('show one job')
    .action(async (id, options, command) => {
      const opts = command.optsWithGlobals();
      const response = await request(opts.api, `/jobs/${encodeURIComponent(id)}`);
      print(opts.json ? response.data : jobText(response.data), opts);
    });

  task
    .command('result <id>')
    .description('show a job result and artifact URLs')
    .action(async (id, options, command) => {
      const opts = command.optsWithGlobals();
      const response = await request(opts.api, `/jobs/${encodeURIComponent(id)}/result`);
      print(opts.json ? response.data : resultText(response.data), opts);
    });

  task
    .command('wait <id>')
    .description('poll a job result until it completes, fails or times out')
    .option('--interval <seconds>', 'poll interval in seconds', String(DEFAULT_INTERVAL_SECONDS))
    .option('--timeout <seconds>', 'total timeout in seconds', String(DEFAULT_TIMEOUT_SECONDS))
    .action(async (id, options, command) => {
      const opts = command.optsWithGlobals();
      const waited = await waitForResult({
        api: opts.api,
        id,
        interval: opts.interval,
        timeout: opts.timeout,
        onProgress: (event) => {
          if (event.type === 'poll') {
            writeDiagnostic(
              `wait: ${event.state} complete=${event.complete} (poll ${event.attempt}, ${(event.elapsedMs / 1000).toFixed(1)}s)\n`,
            );
          } else if (event.type === 'retry') {
            writeDiagnostic(
              `wait: ${event.status ? 'HTTP ' + event.status : 'Network error'}; retrying in ${(event.delayMs / 1000).toFixed(1)}s (retry ${event.retries})\n`,
            );
          }
        },
      });

      if (waited.outcome === 'interrupted') {
        writeDiagnostic('wait: interrupted\n');
        process.exitCode = 130;
        return;
      }
      if (waited.result) {
        print(opts.json ? waited.result : resultText(waited.result), opts);
      }
      if (waited.outcome !== 'completed') {
        writeDiagnostic(`wait: ${waited.message}\n`);
        process.exitCode = 1;
      }
    });

  task
    .command('download <id>')
    .description('download a completed job\'s files under --out')
    .requiredOption('--out <dir>', 'destination directory')
    .action(async (id, options, command) => {
      const opts = command.optsWithGlobals();
      const data = await downloadTaskFiles({
        api: opts.api,
        id,
        out: opts.out,
        onProgress: (event) => {
          if (event.type === 'saved') {
            writeDiagnostic(`download: ${event.path} -> ${event.file}\n`);
          }
        },
      });
      print(opts.json ? data : downloadText(data), opts);
    });

  task
    .command('check')
    .description('validate a job body without creating an order')
    .requiredOption('--file <path>', 'job body JSON file')
    .option('--action <action>', 'action to check (defaults from parentJobId)')
    .action(async (options, command) => {
      const opts = command.optsWithGlobals();
      const input = await readJobFile(opts.file);
      const action = opts.action ?? resolveAction(input);
      const check = await checkJob(opts.api, input, action);
      print(opts.json ? check : checkText(check), opts);
    });

  task
    .command('publish')
    .description('check, quote, sign and submit a job file')
    .requiredOption('--file <path>', 'job body JSON file')
    .option('--request-key <uuid>', 'reuse a saved order request key')
    .action(async (options, command) => {
      const opts = command.optsWithGlobals();
      const payment = await chosenPayment(opts, 'job.open');
      const result = await publishJob({
        api: opts.api,
        home: opts.home,
        file: opts.file,
        action: 'job.open',
        requestKey: opts.requestKey,
        yes: opts.yes,
        keyEnv: opts.keyEnv,
        rpc: opts.rpc,
        paymentChain: opts.paymentChain ?? payment?.paymentChain,
        payWith: opts.payWith ?? payment?.payWith,
        onProgress: paymentProgressReporter(opts),
      });
      handlePublishOutcome(result, opts);
    });

  task
    .command('create [objective]')
    .description('create a job from a clear objective or a JSON file')
    .option('--file <path>', 'complete job body JSON file')
    .option('--preset <name>', 'named input preset (report)')
    .option('--skill <id>', 'runnable skill id')
    .option('--template <name>', 'job template')
    .option('--path <path>', 'repository path the job may write (repeatable)', (value, previous) => [...previous, value], [])
    .option('--repo <url>', 'public GitHub repository URL')
    .option('--commit <sha>', 'base commit for --repo')
    .option('--github', 'publish the result to GitHub')
    .option('--answer <text>', 'answer a business clarification (repeatable)', (value, previous) => [...previous, value], [])
    .option('--dry-run', 'only run the free check and print the input')
    .option('--save <path>', 'save the input JSON without overwriting')
    .option('--request-key <uuid>', 'reuse a saved order request key')
    .action(async (objective, options, command) => {
      const opts = command.optsWithGlobals();
      const payment = opts.dryRun ? null : await chosenPayment(opts, 'job.open');
      const natural = isNaturalCreate(objective, opts);
      let input;
      let plan = null;
      if (opts.requestKey && !hasExplicitCreate(opts) && (objective === undefined || natural)) {
        const saved = await loadOrder(opts.home, opts.requestKey);
        input = assertSavedOrder(saved, opts.requestKey, { api: opts.api, action: 'job.open' });
        if (objective !== undefined && objective !== input.objective) {
          throw new Error(`request key ${opts.requestKey} was created for a different objective; omit the new objective to resume it`);
        }
      } else if (natural) {
        plan = await planNaturalInput({
          api: opts.api,
          home: opts.home,
          objective,
          answers: opts.answer,
          source: sourceFromOptions(opts),
          github: opts.github === true,
          opts,
          loadPlanner,
        });
        if (plan.input === null) {
          finishPlanQuestions(plan, 'job.open', opts);
          return;
        }
        input = plan.input;
      } else {
        const fileInput = opts.file ? await readJobFile(opts.file) : undefined;
        input = await buildCreateInput({
          fileInput,
          objective,
          preset: opts.preset,
          skill: opts.skill,
          template: opts.template,
          paths: opts.path,
          repo: opts.repo,
          commit: opts.commit,
          github: opts.github,
        });
      }

      if (opts.save) {
        await saveInputFile(opts.save, input);
        if (!opts.json) writeDiagnostic(`saved input: ${opts.save}\n`);
      }

      if (opts.dryRun) {
        const check = await checkJob(opts.api, input, 'job.open');
        if (opts.json) {
          print({
            action: 'job.open',
            ...(plan ? { summary: plan.summary, deliverables: plan.deliverables } : {}),
            input,
            check,
          }, opts);
        } else {
          print(plan ? naturalDryRunText(plan, check) : dryRunText('job.open', input, check), opts);
        }
        if (check.blockers.length > 0) process.exitCode = 1;
        return;
      }

      if (plan && !opts.json) writeDiagnostic(`${planText(plan)}\n`);
      const result = await publishJob({
        api: opts.api,
        home: opts.home,
        input,
        action: 'job.open',
        requestKey: opts.requestKey,
        plan: plan ? { summary: plan.summary, deliverables: plan.deliverables } : undefined,
        yes: opts.yes,
        keyEnv: opts.keyEnv,
        rpc: opts.rpc,
        paymentChain: opts.paymentChain ?? payment?.paymentChain,
        payWith: opts.payWith ?? payment?.payWith,
        onProgress: paymentProgressReporter(opts),
        retryCommand: (state) => retryCreate(state, opts),
      });
      handlePublishOutcome(result, opts);
    });

  task
    .command('continue <id> [objective]')
    .description('continue the project of a job you paid for')
    .option('--file <path>', 'complete continuation body JSON file')
    .option('--skill <id>', 'runnable skill id')
    .option('--template <name>', 'job template')
    .option('--path <path>', 'repository path the job may write (repeatable)', (value, previous) => [...previous, value], [])
    .option('--answer <text>', 'answer a business clarification (repeatable)', (value, previous) => [...previous, value], [])
    .option('--dry-run', 'only run the free check and print the input')
    .option('--save <path>', 'save the input JSON without overwriting')
    .option('--request-key <uuid>', 'reuse a saved order request key')
    .action(async (id, objective, options, command) => {
      const opts = command.optsWithGlobals();
      const payment = opts.dryRun ? null : await chosenPayment(opts, 'job.continue');
      const natural = isNaturalContinue(objective, opts);
      let input;
      let parent;
      let plan = null;
      if (opts.requestKey && !hasExplicitContinue(opts) && (objective === undefined || natural)) {
        const saved = await loadOrder(opts.home, opts.requestKey);
        input = assertSavedOrder(saved, opts.requestKey, { api: opts.api, action: 'job.continue' });
        if (input.parentJobId !== id) {
          throw new Error(
            `request key ${opts.requestKey} belongs to parent job ${input.parentJobId ?? '<none>'}, not ${id}`,
          );
        }
        if (objective !== undefined && objective !== input.objective) {
          throw new Error(`request key ${opts.requestKey} was created for a different objective; omit the new objective to resume it`);
        }
        parent = (await request(opts.api, `/jobs/${encodeURIComponent(id)}`)).data;
      } else if (natural) {
        parent = (await request(opts.api, `/jobs/${encodeURIComponent(id)}`)).data;
        plan = await planNaturalInput({
          api: opts.api,
          home: opts.home,
          objective,
          answers: opts.answer,
          parent,
          opts,
          loadPlanner,
        });
        if (plan.input === null) {
          finishPlanQuestions(plan, 'job.continue', opts);
          return;
        }
        input = plan.input;
        if (input.parentJobId !== id) input = { ...input, parentJobId: id };
      } else {
        const fileInput = opts.file ? await readJobFile(opts.file) : undefined;
        input = await buildContinueInput({
          id,
          fileInput,
          objective,
          skill: opts.skill,
          template: opts.template,
          paths: opts.path,
        });
        parent = (await request(opts.api, `/jobs/${encodeURIComponent(id)}`)).data;
      }

      if (opts.save) {
        await saveInputFile(opts.save, input);
        if (!opts.json) writeDiagnostic(`saved input: ${opts.save}\n`);
      }

      if (opts.dryRun) {
        const check = await checkJob(opts.api, input, 'job.continue');
        if (opts.json) {
          print({
            action: 'job.continue',
            ...(plan ? { summary: plan.summary, deliverables: plan.deliverables } : {}),
            parent: parentSummary(parent),
            input,
            check,
          }, opts);
        } else {
          print(
            plan ? naturalDryRunText(plan, check) : dryRunText('job.continue', input, check, parent),
            opts,
          );
        }
        if (check.blockers.length > 0) process.exitCode = 1;
        return;
      }

      if (plan && !opts.json) writeDiagnostic(`${planText(plan)}\n`);
      const result = await publishJob({
        api: opts.api,
        home: opts.home,
        input,
        action: 'job.continue',
        requestKey: opts.requestKey,
        plan: plan ? { summary: plan.summary, deliverables: plan.deliverables } : undefined,
        yes: opts.yes,
        keyEnv: opts.keyEnv,
        rpc: opts.rpc,
        paymentChain: opts.paymentChain ?? payment?.paymentChain,
        payWith: opts.payWith ?? payment?.payWith,
        onProgress: paymentProgressReporter(opts),
        retryCommand: (state) => retryContinue(state, opts),
      });
      if (result.state) result.state.parent = parentSummary(parent);
      handlePublishOutcome(result, opts);
    });
}
