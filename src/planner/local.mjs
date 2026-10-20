import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadModelFile } from './model-download.mjs';
import { createModelProgress } from './progress.mjs';
import { MODEL_NAME, MODEL_QUANTIZATION, MODEL_SIZE } from './model-info.mjs';

export const MODEL_URL = 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf';
export const MODEL_MIRROR_URL = 'https://hf-mirror.com/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf';

export const MODEL = Object.freeze({
  name: `${MODEL_NAME}-${MODEL_QUANTIZATION}`,
  quantization: MODEL_QUANTIZATION,
  url: MODEL_URL,
  mirrorUrl: MODEL_MIRROR_URL,
  revision: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
  sha256: 'bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517',
  size: MODEL_SIZE,
  fileName: 'Qwen3.5-0.8B-Q4_K_M.gguf',
  contextSize: 4096,
});

export function platformRuntime({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin' && arch === 'arm64') {
    return { backend: 'Metal', gpu: 'metal', gpuLayers: 'auto' };
  }
  return { backend: 'CPU', gpu: false, gpuLayers: 0 };
}

function pinnedUrl(url, revision) {
  return url.replace('/resolve/main/', `/resolve/${revision}/`);
}

function modelDirectory(home) {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new Error('home must be a non-empty directory');
  }
  return join(home, 'models');
}

function modelPath(home, model) {
  return join(modelDirectory(home), model.fileName);
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function inspectModel(home, model) {
  const path = modelPath(home, model);
  let file;
  try {
    file = await stat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { path, bytesOnDisk: 0, status: 'missing' };
  }

  if (!file.isFile() || file.size !== model.size) {
    return { path, bytesOnDisk: file.size, status: 'incomplete' };
  }

  const digest = await hashFile(path);
  if (digest !== model.sha256) {
    return { path, bytesOnDisk: file.size, status: 'corrupt' };
  }

  return { path, bytesOnDisk: file.size, status: 'ready' };
}

function modelInfoFromState(model, state) {
  return {
    name: model.name,
    quantization: model.quantization,
    url: model.url,
    mirrorUrl: model.mirrorUrl,
    revision: model.revision,
    sha256: model.sha256,
    size: model.size,
    contextSize: model.contextSize,
    backend: platformRuntime().backend,
    path: state.path,
    bytesOnDisk: state.bytesOnDisk,
    downloaded: state.status === 'ready',
    status: state.status,
  };
}

export async function modelInfo({ home, model = MODEL } = {}) {
  return modelInfoFromState(model, await inspectModel(home, model));
}

export async function ensureModel({ home, model, onProgress } = {}) {
  if (model === undefined) throw new Error('model is required');
  const display = onProgress ? null : createModelProgress({ load: false });
  const report = onProgress ?? display.update;
  try {
    report({ stage: 'checking', totalSize: model.size });
    const before = await inspectModel(home, model);
    // A verified cache is authoritative: no network access at all.
    if (before.status === 'ready') {
      report({ stage: 'ready', cached: true, totalSize: model.size });
      return modelInfoFromState(model, before);
    }

    await mkdir(modelDirectory(home), { recursive: true });
    if (before.status !== 'missing') await rm(before.path, { force: true });
    let source = 'primary';
    let sourceWebsite = new URL(model.url).hostname;
    let started = Date.now();
    let lastReport = 0;
    const startDownload = () => report({ stage: 'downloading', downloadedSize: 0, totalSize: model.size, speed: 0, source, sourceWebsite });
    startDownload();
    await downloadModelFile({
      officialUrl: pinnedUrl(model.url, model.revision),
      mirrorUrl: pinnedUrl(model.mirrorUrl, model.revision),
      directory: modelDirectory(home), fileName: model.fileName, size: model.size,
      onSwitch: () => { source = 'backup'; sourceWebsite = new URL(model.mirrorUrl).hostname; started = Date.now(); lastReport = 0; startDownload(); },
      onProgress: ({ downloadedSize, totalSize }) => {
        const now = Date.now();
        if (downloadedSize < totalSize && now - lastReport < 100) return;
        lastReport = now;
        report({ stage: 'downloading', downloadedSize, totalSize, source, sourceWebsite,
          speed: downloadedSize * 1000 / Math.max(1, now - started) });
      },
    });
    report({ stage: 'verifying', totalSize: model.size });
    const after = await inspectModel(home, model);
    if (after.status !== 'ready') {
      await rm(after.path, { force: true });
      throw new Error(`downloaded model failed verification: ${after.status}`);
    }
    report({ stage: 'ready', cached: false, totalSize: model.size });
    return modelInfoFromState(model, after);
  } catch (error) {
    display?.fail();
    throw error;
  } finally {
    display?.close();
  }
}

export async function ensureLocalModel({ home, onProgress } = {}) {
  return ensureModel({ home, model: MODEL, onProgress });
}

function choiceQuestion({ document, instruction, criteria }) {
  if (typeof document !== 'string' || document.trim() === '') {
    throw new Error('document must be a non-empty string');
  }
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new Error('instruction must be a non-empty string');
  }
  if (criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) {
    throw new Error('criteria must be an object');
  }
  const entries = Object.entries(criteria);
  if (entries.length < 2) {
    throw new Error('criteria must contain at least two choices');
  }
  for (const [choice, description] of entries) {
    if (choice === '') throw new Error('criteria choice names must be non-empty');
    if (description !== null && typeof description !== 'string') {
      throw new Error(`criteria.${choice} must be a string or null`);
    }
  }
  return {
    route: {
      type: 'choice',
      instruction,
      criteria,
    },
  };
}

async function disposeResources(resources) {
  let failure;
  for (const resource of resources) {
    if (!resource) continue;
    try {
      await resource.dispose();
    } catch (error) {
      failure ??= error;
    }
  }
  return failure;
}

export async function createLocalPlanner({ home, onProgress } = {}) {
  const display = onProgress ? null : createModelProgress();
  const report = onProgress ?? display.update;
  const selected = platformRuntime();

  let llama;
  let loadedModel;
  let decision;
  try {
    const info = await ensureLocalModel({ home, onProgress: report });
    report({ stage: 'loading', totalSize: MODEL.size });
    const { getLlama } = await import('node-llama-cpp');
    llama = await getLlama({ gpu: selected.gpu, build: 'never', logLevel: 'error' });
    loadedModel = await llama.loadModel({
      modelPath: info.path,
      gpuLayers: selected.gpuLayers,
    });
    decision = await loadedModel.createDecisionContext({
      contextSize: MODEL.contextSize,
      threads: 4,
      parallelQuestions: 1,
    });
    report({ stage: 'loaded', totalSize: MODEL.size });
  } catch (error) {
    display?.fail();
    await disposeResources([decision, loadedModel, llama]);
    throw error;
  } finally {
    display?.close();
  }

  let closed = false;
  return {
    backend: selected.backend,

    async decide({ document, instruction, criteria } = {}) {
      if (closed) throw new Error('local planner is closed');
      const questions = choiceQuestion({ document, instruction, criteria });
      const response = await decision.decideWithMeta(document, questions);
      const answer = response.answers.route;
      return {
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      const failure = await disposeResources([decision, loadedModel, llama]);
      if (failure) throw failure;
    },
  };
}
