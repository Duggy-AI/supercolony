const ROUTE_DEFINITIONS = [
  {
    id: 'report',
    skill: 'research-report',
    description: 'A written research report, analysis, comparison, or recommendation with sources.',
  },
  {
    id: 'website',
    skill: 'build-website',
    description: 'A responsive website delivered as a publicly usable site.',
  },
  {
    id: 'image',
    skill: 'create-image',
    description: 'One image file.',
  },
  {
    id: 'audio',
    skill: 'create-audio',
    description: 'One audio file, such as narration, speech or music.',
  },
  {
    id: 'video',
    skill: 'create-video',
    description: 'One video file.',
  },
  {
    id: 'code',
    skill: 'build-contract-project',
    description: 'A new smart-contract project with its tests.',
  },
  {
    id: 'tests',
    skill: 'write-foundry-tests',
    description: 'Foundry tests for an existing project.',
    requiresSource: true,
  },
  {
    id: 'audit',
    template: 'audit',
    description: 'An audit report for an existing project.',
    requiresSource: true,
  },
];

const OUTPUTS = {
  report: { name: 'report', path: 'artifacts/report.md', mediaType: 'text/markdown' },
  image: { name: 'image', path: 'artifacts/image.png', mediaType: 'image/png' },
  audio: { name: 'audio', path: 'artifacts/audio.mp3', mediaType: 'audio/mpeg' },
  video: { name: 'video', path: 'artifacts/video.mp4', mediaType: 'video/mp4' },
};

const UNSUPPORTED = {
  id: 'unsupported',
  description: 'An on-chain deployment, token launch, trading, or another unsupported action.',
};

const SAME = {
  id: 'same',
  description: 'Continue the existing project with the requested change, keeping its current kind of work.',
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRunnable(skill) {
  return skill.role !== 'reference' && skill.tier !== null && skill.tier !== undefined;
}

function normalizeCatalog(catalog) {
  const skills = Array.isArray(catalog) ? catalog : catalog?.skills;
  if (!Array.isArray(skills)) {
    throw new Error('catalog must be the GET /skills response or its skills array');
  }
  const byId = new Map();
  for (const skill of skills) {
    if (isObject(skill) && typeof skill.id === 'string' && skill.id !== '') {
      byId.set(skill.id, skill);
    }
  }
  return byId;
}

function normalizeParent(parent) {
  if (parent === null || parent === undefined) return null;
  if (!isObject(parent) || typeof parent.id !== 'string' || parent.id.trim() === '') {
    throw new Error('parent must be a job with a non-empty id');
  }
  return {
    id: parent.id,
    state: parent.state ?? null,
    template: typeof parent.template === 'string' ? parent.template : null,
    objective: typeof parent.objective === 'string' ? parent.objective : '',
  };
}

function normalizeSource(source) {
  if (source === null || source === undefined) return null;
  if (!isObject(source)) throw new Error('source must contain repoUrl and baseCommit');
  const { repoUrl, baseCommit } = source;
  if ((repoUrl === undefined) !== (baseCommit === undefined)) {
    throw new Error('--repo and --commit must be given together');
  }
  if (repoUrl === undefined) return null;
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    throw new Error('source repoUrl must be a non-empty string');
  }
  if (typeof baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(baseCommit)) {
    throw new Error('source baseCommit must be a 40-character lowercase commit hash');
  }
  return { repoUrl, baseCommit };
}

function parentSkill(parent, catalog) {
  if (!parent?.template) return null;
  const match = /^skill:([^:]+)$/.exec(parent.template);
  if (!match) return null;
  const skill = catalog.get(match[1]);
  return skill && isRunnable(skill) ? skill.id : null;
}

export function buildRoutes({ catalog, parent = null, source = null }) {
  const byId = catalog instanceof Map ? catalog : normalizeCatalog(catalog);
  const routes = ROUTE_DEFINITIONS
    .filter((route) => {
      if (route.requiresSource && !source && !parent) return false;
      if (route.skill) {
        const skill = byId.get(route.skill);
        return Boolean(skill && isRunnable(skill));
      }
      return true;
    })
    .map(({ id, description }) => ({ id, description }));

  if (parent) routes.unshift(SAME);
  routes.push(UNSUPPORTED);
  return routes;
}

function decisionDocument({ objective, answers, parent }) {
  const lines = [];
  if (parent) {
    lines.push(`Existing project: ${parent.objective || parent.id}`);
    if (parent.template) lines.push(`Existing work type: ${parent.template}`);
    lines.push(`Requested change: ${objective}`);
  } else {
    lines.push(`Request: ${objective}`);
  }
  if (answers.length > 0) {
    lines.push('Clarifications:');
    answers.forEach((answer, index) => lines.push(`${index + 1}. ${answer}`));
  }
  return lines.join('\n');
}

function decisionInstruction(parent) {
  if (parent) {
    return 'Does this request ask to continue the existing project, or for a different final deliverable? Ignore the mentioned topic or technology.';
  }
  return 'What final deliverable does this request ask for? Ignore the mentioned topic or technology.';
}

function objectiveWithAnswers(objective, answers) {
  if (answers.length === 0) return objective;
  const lines = answers.map((answer) => `- ${answer}`);
  return `${objective}\n\nClarifications:\n${lines.join('\n')}`;
}

function cloneOutput(key) {
  return { ...OUTPUTS[key] };
}

function newJobInput(route, objective, catalog, source, githubRequested) {
  if (route === 'report') {
    return {
      objective,
      skill: 'research-report',
      outputs: [cloneOutput('report')],
      github: githubRequested,
    };
  }
  if (route === 'website') {
    return {
      objective,
      skill: 'build-website',
      ipfs: true,
      github: githubRequested,
    };
  }
  if (route === 'image' || route === 'audio' || route === 'video') {
    return {
      objective,
      skill: `create-${route}`,
      outputs: [cloneOutput(route)],
      github: githubRequested,
    };
  }
  if (route === 'code') {
    return {
      objective,
      skill: 'build-contract-project',
      github: true,
    };
  }
  if (route === 'tests') {
    return {
      objective,
      ...(source ? { repoUrl: source.repoUrl, baseCommit: source.baseCommit } : {}),
      skill: 'write-foundry-tests',
      paths: ['test'],
      github: true,
    };
  }
  if (route === 'audit') {
    return {
      objective,
      template: 'audit',
      ...(source ? { repoUrl: source.repoUrl, baseCommit: source.baseCommit } : {}),
      github: githubRequested,
    };
  }
  throw new Error(`route cannot create a job: ${route}`);
}

function sameJobInput(objective, parent, catalog) {
  const input = {
    parentJobId: parent.id,
    objective,
  };
  const skill = parentSkill(parent, catalog);
  if (!skill) return input;

  input.skill = skill;
  if (skill === 'research-report') input.outputs = [cloneOutput('report')];
  if (skill === 'create-image') input.outputs = [cloneOutput('image')];
  if (skill === 'create-audio') input.outputs = [cloneOutput('audio')];
  if (skill === 'create-video') input.outputs = [cloneOutput('video')];
  if (skill === 'build-website') input.ipfs = true;
  return input;
}

function sameSummary(parent) {
  return parent.objective
    ? `Continue the existing project: ${parent.objective}`
    : 'Continue the existing project with the requested change.';
}

function routePlan(route, { objective, parent, catalog, source, githubRequested }) {
  if (route === 'same') {
    return {
      summary: sameSummary(parent),
      deliverables: ['An updated version of the existing project.'],
      questions: [],
      input: sameJobInput(objective, parent, catalog),
      route,
    };
  }

  const definitions = {
    report: {
      summary: 'Write a sourced Markdown report with references.',
      deliverables: ['A sourced report at artifacts/report.md.'],
    },
    website: {
      summary: 'Build a responsive website and publish a publicly usable version.',
      deliverables: ['A responsive website.', 'A publicly hosted version of the site.'],
    },
    image: {
      summary: 'Create the requested image as a PNG file.',
      deliverables: ['The requested image at artifacts/image.png.'],
    },
    audio: {
      summary: 'Create the requested audio as an MP3 file.',
      deliverables: ['The requested audio at artifacts/audio.mp3.'],
    },
    video: {
      summary: 'Create the requested video as an MP4 file.',
      deliverables: ['The requested video at artifacts/video.mp4.'],
    },
    code: {
      summary: 'Build and test a Foundry smart-contract project.',
      deliverables: ['A smart-contract project with tests, published to GitHub.'],
    },
    tests: {
      summary: 'Add Foundry tests to the existing project.',
      deliverables: ['Foundry tests for the existing project.'],
    },
    audit: {
      summary: 'Audit the existing project and report its findings.',
      deliverables: ['An audit report for the existing project.'],
    },
  };
  const definition = definitions[route];
  if (!definition) throw new Error(`unknown route: ${route}`);

  const built = newJobInput(route, objective, catalog, source, githubRequested);
  return {
    ...definition,
    questions: [],
    input: parent ? { parentJobId: parent.id, ...built } : built,
    route,
  };
}

function unsupportedPlan() {
  return {
    summary: 'This request is not executable by the current job flow.',
    deliverables: [],
    questions: ['This request is outside what this command can execute. Can you narrow it to an executable report, website, media file, or code project?'],
    input: null,
    route: 'unsupported',
  };
}

export async function planIntent({
  objective,
  answers = [],
  catalog,
  parent = null,
  source = null,
  github = false,
  decide,
}) {
  if (typeof objective !== 'string' || objective.trim() === '') {
    throw new Error('objective must be a non-empty string');
  }
  if (!Array.isArray(answers) || answers.some((answer) => typeof answer !== 'string')) {
    throw new Error('answers must be an array of strings');
  }
  if (typeof decide !== 'function') {
    throw new Error('decide must be a function');
  }

  const byId = normalizeCatalog(catalog);
  const normalizedParent = normalizeParent(parent);
  const normalizedSource = normalizeSource(source);
  const routes = buildRoutes({ catalog: byId, parent: normalizedParent, source: normalizedSource });
  const supported = routes.filter((route) => route.id !== 'unsupported');
  if (supported.length === 0) {
    throw new Error('catalog has no supported runnable skill for natural-language tasks');
  }

  const criteria = Object.fromEntries(routes.map((route) => [route.id, route.description]));
  const decision = await decide({
    document: decisionDocument({ objective, answers, parent: normalizedParent }),
    instruction: decisionInstruction(normalizedParent),
    criteria,
  });

  if (!isObject(decision) || typeof decision.choice !== 'string') {
    throw new Error('planner decision must contain a choice');
  }
  if (!Object.hasOwn(criteria, decision.choice)) {
    throw new Error(`planner decision choice is not available: ${decision.choice}`);
  }
  if (decision.choice === 'unsupported') return unsupportedPlan();

  return routePlan(decision.choice, {
    objective: objectiveWithAnswers(objective, answers),
    parent: normalizedParent,
    catalog: byId,
    source: normalizedSource,
    githubRequested: Boolean(github),
  });
}
