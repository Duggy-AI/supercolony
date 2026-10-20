#!/usr/bin/env node
import { run } from '../../src/program.mjs';

const choice = process.env.COLONY_TEST_PLANNER_CHOICE;
const loadPlanner = choice
  ? async () => ({
    decide: async () => ({ choice, confidence: 1, probabilities: { [choice]: 1 } }),
    close: async () => {},
  })
  : undefined;

await run(process.argv.slice(2), { registerWorkerCommands: () => {}, loadPlanner });
