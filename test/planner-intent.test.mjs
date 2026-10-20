import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRoutes, planIntent } from '../src/planner/intent.mjs';
import { planNatural } from '../src/planner/flow.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

const CATALOG = {
  skills: [
    { id: 'research-report', role: 'implement', kind: 'code', tier: 2, requires: ['network'] },
    { id: 'build-website', role: 'implement', kind: 'code', tier: 2, requires: ['network'] },
    { id: 'create-image', role: 'implement', kind: 'code', tier: 2, requires: ['tool:image'] },
    { id: 'create-audio', role: 'implement', kind: 'code', tier: 2, requires: ['tool:audio'] },
    { id: 'create-video', role: 'implement', kind: 'code', tier: 2, requires: ['tool:video'] },
    { id: 'build-contract-project', role: 'implement', kind: 'code', tier: 1, requires: [] },
    { id: 'write-foundry-tests', role: 'tests', kind: 'code', tier: 1, requires: [] },
    { id: 'better-interface', role: 'reference', kind: 'code', tier: null, requires: [] },
  ],
};

function decideWith(choice, calls) {
  return async (request) => {
    calls.push(request);
    return { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
  };
}

test('builds a report job with the objective unchanged and a fixed artifact path', async () => {
  const calls = [];
  const output = await planIntent({
    objective: 'Write a sourced report on deterministic EVM testing.',
    catalog: CATALOG,
    decide: decideWith('report', calls),
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].instruction, /final deliverable/);
  assert.match(calls[0].instruction, /Ignore the mentioned topic/);
  assert.match(calls[0].criteria.report, /comparison/);
  assert.equal('unsupported' in calls[0].criteria, true);
  assert.deepEqual(output.input, {
    objective: 'Write a sourced report on deterministic EVM testing.',
    skill: 'research-report',
    outputs: [{ name: 'report', path: 'artifacts/report.md', mediaType: 'text/markdown' }],
    github: false,
  });
  assert.deepEqual(output.questions, []);
});

test('builds a usable public website with no model-chosen technical parameters', async () => {
  const output = await planIntent({
    objective: 'Build a landing page for my bakery.',
    catalog: CATALOG,
    decide: decideWith('website', []),
  });

  assert.deepEqual(output.input, {
    objective: 'Build a landing page for my bakery.',
    skill: 'build-website',
    ipfs: true,
    github: false,
  });
  assert.match(output.summary, /publicly usable/);
});

test('uses code defaults for image, audio and video files', async () => {
  for (const [route, path, mediaType] of [
    ['image', 'artifacts/image.png', 'image/png'],
    ['audio', 'artifacts/audio.mp3', 'audio/mpeg'],
    ['video', 'artifacts/video.mp4', 'video/mp4'],
  ]) {
    const output = await planIntent({
      objective: `Make the requested ${route}.`,
      catalog: CATALOG,
      decide: decideWith(route, []),
    });
    assert.equal(output.input.skill, `create-${route}`);
    assert.deepEqual(output.input.outputs, [{ name: route, path, mediaType }]);
    assert.equal(output.input.github, false);
  }
});

test('builds a code project with GitHub delivery', async () => {
  const output = await planIntent({
    objective: 'Build a small escrow contract.',
    catalog: CATALOG,
    decide: decideWith('code', []),
  });

  assert.deepEqual(output.input, {
    objective: 'Build a small escrow contract.',
    skill: 'build-contract-project',
    github: true,
  });
});

test('builds tests and audits only when a source repository and commit are supplied', async () => {
  const source = { repoUrl: 'https://github.com/owner/repo', baseCommit: COMMIT };
  const routes = buildRoutes({ catalog: CATALOG, source });
  assert.match(routes.map((route) => route.id).join(','), /tests/);
  assert.match(routes.map((route) => route.id).join(','), /audit/);

  const tests = await planIntent({
    objective: 'Add tests for the vault.',
    catalog: CATALOG,
    source,
    decide: decideWith('tests', []),
  });
  assert.deepEqual(tests.input, {
    objective: 'Add tests for the vault.',
    repoUrl: source.repoUrl,
    baseCommit: COMMIT,
    skill: 'write-foundry-tests',
    paths: ['test'],
    github: true,
  });

  const audit = await planIntent({
    objective: 'Audit the vault.',
    catalog: CATALOG,
    source,
    decide: decideWith('audit', []),
  });
  assert.deepEqual(audit.input, {
    objective: 'Audit the vault.',
    template: 'audit',
    repoUrl: source.repoUrl,
    baseCommit: COMMIT,
    github: false,
  });
});

test('binds a continuation to the real parent id and reuses its skill', async () => {
  const parent = {
    id: 'job-real-123',
    state: 'completed',
    template: 'skill:build-website',
    objective: 'Build the first version of the site.',
  };
  const calls = [];
  const output = await planIntent({
    objective: 'Add a claim page.',
    catalog: CATALOG,
    parent,
    decide: decideWith('same', calls),
  });

  assert.deepEqual(output.input, {
    parentJobId: 'job-real-123',
    objective: 'Add a claim page.',
    skill: 'build-website',
    ipfs: true,
  });
  assert.match(output.summary, /first version/);
  assert.match(calls[0].document, /Existing project: Build the first version/);
  assert.match(calls[0].instruction, /continue the existing project/);
  assert.equal('same' in calls[0].criteria, true);
});

test('continuation source-dependent routes use the parent project and never add source fields', async () => {
  const parent = {
    id: 'job-real-456',
    state: 'completed',
    template: 'skill:research-report',
    objective: 'Write the first report.',
  };
  assert.match(
    buildRoutes({ catalog: CATALOG, parent }).map((route) => route.id).join(','),
    /tests/,
  );

  const tests = await planIntent({
    objective: 'Add tests for the project.',
    catalog: CATALOG,
    parent,
    decide: decideWith('tests', []),
  });
  assert.deepEqual(tests.input, {
    parentJobId: 'job-real-456',
    objective: 'Add tests for the project.',
    skill: 'write-foundry-tests',
    paths: ['test'],
    github: true,
  });
  assert.equal('repoUrl' in tests.input, false);
  assert.equal('baseCommit' in tests.input, false);

  const audit = await planIntent({
    objective: 'Audit the current project.',
    catalog: CATALOG,
    parent,
    decide: decideWith('audit', []),
  });
  assert.deepEqual(audit.input, {
    parentJobId: 'job-real-456',
    objective: 'Audit the current project.',
    template: 'audit',
    github: false,
  });
  assert.equal('repoUrl' in audit.input, false);
  assert.equal('baseCommit' in audit.input, false);
});

test('returns a confirmation question for unsupported on-chain requests', async () => {
  const output = await planIntent({
    objective: 'Deploy my token and start trading it.',
    catalog: CATALOG,
    decide: decideWith('unsupported', []),
  });

  assert.equal(output.input, null);
  assert.equal(output.questions.length, 1);
  assert.match(output.questions[0], /outside what this command can execute/);
  assert.doesNotMatch(output.questions[0], /on-chain|repository/);
  assert.doesNotMatch(output.summary, /completed in|days|hours/i);
});

test('keeps the original objective as a prefix and appends answers for the worker', async () => {
  const calls = [];
  const output = await planIntent({
    objective: 'Build a landing page.',
    answers: ['It is for a bakery in Lisbon.'],
    catalog: CATALOG,
    decide: decideWith('website', calls),
  });

  assert.match(output.input.objective, /^Build a landing page\./);
  assert.match(output.input.objective, /Clarifications:/);
  assert.match(output.input.objective, /It is for a bakery in Lisbon/);
  assert.match(calls[0].document, /It is for a bakery in Lisbon/);
});

test('rejects invalid decisions and unknown choices without retrying', async () => {
  const calls = [];
  await assert.rejects(
    () => planIntent({
      objective: 'Write a report.',
      catalog: CATALOG,
      decide: async (request) => {
        calls.push(request);
        return null;
      },
    }),
    /must contain a choice/,
  );
  assert.equal(calls.length, 1);

  await assert.rejects(
    () => planIntent({
      objective: 'Write a report.',
      catalog: CATALOG,
      decide: decideWith('deploy', calls),
    }),
    /choice is not available: deploy/,
  );
  assert.equal(calls.length, 2);
});

test('rejects routes that are not available for this request', async () => {
  const calls = [];
  await assert.rejects(
    () => planIntent({
      objective: 'Audit it.',
      catalog: CATALOG,
      decide: decideWith('audit', calls),
    }),
    /choice is not available: audit/,
  );
  assert.equal('audit' in calls[0].criteria, false);
});

test('flow returns the finite route plan from one decision', async () => {
  const calls = [];
  const output = await planNatural({
    objective: 'Build a landing page.',
    catalog: CATALOG,
    decide: decideWith('website', calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(output.input.skill, 'build-website');
  assert.deepEqual(output.questions, []);
});

test('continues an existing parent when the catalog has no runnable skill', async () => {
  const parent = {
    id: 'job-real-789',
    state: 'completed',
    template: null,
    objective: 'The original work.',
  };
  const calls = [];
  const output = await planIntent({
    objective: 'Make one small change.',
    catalog: {
      skills: [
        { id: 'research-report', role: 'reference', kind: 'code', tier: null },
      ],
    },
    parent,
    decide: decideWith('same', calls),
  });

  assert.ok(Object.hasOwn(calls[0].criteria, 'same'));
  assert.ok(Object.hasOwn(calls[0].criteria, 'unsupported'));
  assert.match(calls[0].criteria.same, /Continue the existing project/);
  assert.deepEqual(output.input, {
    parentJobId: 'job-real-789',
    objective: 'Make one small change.',
  });
  assert.equal('skill' in output.input, false);
});

test('rejects a catalog without any supported runnable route', async () => {
  await assert.rejects(
    () => planIntent({
      objective: 'Do the work.',
      catalog: {
        skills: [
          { id: 'research-report', role: 'reference', kind: 'code', tier: null },
        ],
      },
      decide: decideWith('report', []),
    }),
    /catalog has no supported runnable skill/,
  );
});
