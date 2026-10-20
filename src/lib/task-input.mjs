import { writeFile } from 'node:fs/promises';

const REPORT_OUTPUT = Object.freeze({
  name: 'report',
  path: 'artifacts/report.md',
  mediaType: 'text/markdown',
});

export const PRESETS = Object.freeze({
  report: Object.freeze({
    skill: 'research-report',
    outputs: Object.freeze([REPORT_OUTPUT]),
    github: false,
  }),
});

export function resolveAction(input) {
  return input && typeof input === 'object' && input.parentJobId ? 'job.continue' : 'job.open';
}

export function hasDirectCreateFields(options) {
  return options.objective !== undefined
    || options.preset !== undefined
    || options.skill !== undefined
    || options.template !== undefined
    || (Array.isArray(options.paths) && options.paths.length > 0)
    || options.repo !== undefined
    || options.commit !== undefined
    || options.github === true;
}

function assertNoCreateFileConflict(fileInput, options) {
  if (fileInput !== undefined && hasDirectCreateFields(options)) {
    throw new Error(
      '--file cannot be combined with objective, --preset, --skill, --template, --path, --repo, --commit or --github',
    );
  }
}

function addRepository(input, repo, commit) {
  if ((repo === undefined) !== (commit === undefined)) {
    throw new Error('--repo and --commit must be given together');
  }
  if (repo !== undefined) {
    input.repoUrl = repo;
    input.baseCommit = commit;
  }
  return input;
}

function addPaths(input, paths) {
  if (Array.isArray(paths) && paths.length > 0) {
    input.paths = [...paths];
  }
  return input;
}

function addGithub(input, github) {
  if (github === true) input.github = true;
  return input;
}

export async function buildCreateInput(options) {
  const {
    fileInput,
    objective,
    preset,
    skill,
    template,
    paths,
    repo,
    commit,
    github,
  } = options;

  assertNoCreateFileConflict(fileInput, options);
  if (fileInput !== undefined) {
    if (fileInput.parentJobId !== undefined) {
      throw new Error('--file contains parentJobId; use task continue <id> --file <path> instead');
    }
    return fileInput;
  }

  if (typeof objective !== 'string' || objective.trim() === '') {
    throw new Error('task create requires an objective or --file');
  }

  const choices = [preset, skill, template].filter((value) => value !== undefined);
  if (choices.length === 0) {
    throw new Error(
      'say what to build: pass --preset report, --skill <id>, --template <name>, or use --file',
    );
  }
  if (choices.length > 1) {
    throw new Error('choose one of --preset, --skill or --template');
  }

  let input;
  if (preset !== undefined) {
    const selected = PRESETS[preset];
    if (!selected) {
      throw new Error(`unknown preset: ${preset}; supported presets: ${Object.keys(PRESETS).join(', ')}`);
    }
    input = {
      objective,
      skill: selected.skill,
      outputs: selected.outputs.map((item) => ({ ...item })),
      github: selected.github,
    };
  } else if (skill !== undefined) {
    input = { objective, skill };
  } else {
    input = { objective, template };
  }

  addPaths(input, paths);
  addRepository(input, repo, commit);
  addGithub(input, github);
  return input;
}

export async function buildContinueInput(options) {
  const {
    id,
    fileInput,
    objective,
    skill,
    template,
    paths,
  } = options;

  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('task continue requires a parent job id');
  }
  if (fileInput !== undefined) {
    const direct = objective !== undefined
      || skill !== undefined
      || template !== undefined
      || (Array.isArray(paths) && paths.length > 0);
    if (direct) {
      throw new Error('--file cannot be combined with objective, --skill, --template or --path');
    }
    if (fileInput.parentJobId !== undefined && fileInput.parentJobId !== id) {
      throw new Error(`--file parentJobId ${fileInput.parentJobId} does not match ${id}`);
    }
    return { ...fileInput, parentJobId: id };
  }

  if (typeof objective !== 'string' || objective.trim() === '') {
    throw new Error('task continue requires an objective or --file');
  }
  if (skill !== undefined && template !== undefined) {
    throw new Error('choose one of --skill or --template');
  }

  const input = { parentJobId: id, objective };
  if (skill !== undefined) input.skill = skill;
  else if (template !== undefined) input.template = template;
  addPaths(input, paths);
  return input;
}

export function parentSummary(parent) {
  if (!parent?.id) throw new Error('parent job response is missing id');
  return {
    id: parent.id,
    state: parent.state ?? null,
    template: parent.template ?? null,
    objective: parent.objective ?? '',
    paidBy: parent.paidBy ?? null,
    parentJobId: parent.parentJobId ?? null,
    project: parent.project
      ? {
        id: parent.project.id,
        head: parent.project.head ?? null,
        running: parent.project.running ?? null,
        versions: (parent.project.versions ?? []).map((version) => ({
          jobId: version.jobId,
          state: version.state,
          objective: version.objective,
          createdAt: version.createdAt,
        })),
      }
      : null,
  };
}

export async function saveInputFile(file, input) {
  const text = `${JSON.stringify(input, null, 2)}\n`;
  try {
    await writeFile(file, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing file: ${file}`);
    }
    throw error;
  }
  return file;
}
