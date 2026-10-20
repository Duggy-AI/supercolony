import { terminalText } from '../lib/terminal-text.mjs';
import { planIntent } from './intent.mjs';
import { request } from '../shared.mjs';

export async function loadLocalPlanner({ home, onProgress }) {
  const module = await import('./local.mjs');
  if (typeof module.createLocalPlanner !== 'function') {
    throw new Error('src/planner/local.mjs must export createLocalPlanner');
  }
  return module.createLocalPlanner({ home, onProgress });
}

export async function planTask({ api, home, loadPlanner = loadLocalPlanner, onProgress, signal, ...intent }) {
  const catalog = (await request(api, '/skills', { signal })).data;
  const planner = await loadPlanner({ home, onProgress: onProgress && ((event) => {
    signal?.throwIfAborted();
    onProgress(event);
  }) });
  try {
    signal?.throwIfAborted();
    return await planNatural({ ...intent, catalog, decide: (payload) => planner.decide(payload) });
  } finally {
    if (typeof planner.close === 'function') await planner.close();
  }
}

export async function planNatural({
  objective,
  answers = [],
  catalog,
  parent = null,
  source = null,
  github = false,
  decide,
  ask = null,
}) {
  const first = await planIntent({
    objective,
    answers,
    catalog,
    parent,
    source,
    github,
    decide,
  });
  if (first.input || first.questions.length === 0 || typeof ask !== 'function') {
    return first;
  }

  const next = await ask(first.questions);
  if (!Array.isArray(next) || next.length === 0) return first;
  const collected = answers.concat(
    next.filter((answer) => typeof answer === 'string' && answer.trim() !== ''),
  );
  if (collected.length === answers.length) return first;

  return planIntent({
    objective,
    answers: collected,
    catalog,
    parent,
    source,
    github,
    decide,
  });
}

export async function askQuestions(questions) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answers = [];
  try {
    for (const question of questions) {
      const answer = await rl.question(`${terminalText(question)}\n> `);
      if (answer.trim() !== '') answers.push(answer.trim());
    }
  } finally {
    rl.close();
  }
  return answers;
}
