import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Command } from 'commander';
import { registerModelCommands } from '../src/commands/model.mjs';
import {
  MODEL,
  MODEL_URL,
  createLocalPlanner,
  modelInfo,
  platformRuntime,
} from '../src/planner/local.mjs';

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'colony-model-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('model metadata pins the selected Qwen3.5 Q4_K_M file', () => {
  assert.equal(MODEL_URL, 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf');
  assert.equal(MODEL.url, MODEL_URL);
  assert.equal(MODEL.fileName, 'Qwen3.5-0.8B-Q4_K_M.gguf');
  assert.equal(MODEL.size, 532517120);
  assert.equal(MODEL.sha256, 'bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517');
  assert.equal(MODEL.contextSize, 4096);
  assert.match(MODEL.revision, /^[0-9a-f]{40}$/);
});

test('platform selection uses CPU except Apple Silicon Metal', () => {
  assert.deepEqual(platformRuntime({ platform: 'win32', arch: 'x64' }), {
    backend: 'CPU', gpu: false, gpuLayers: 0,
  });
  assert.deepEqual(platformRuntime({ platform: 'linux', arch: 'arm64' }), {
    backend: 'CPU', gpu: false, gpuLayers: 0,
  });
  assert.deepEqual(platformRuntime({ platform: 'darwin', arch: 'x64' }), {
    backend: 'CPU', gpu: false, gpuLayers: 0,
  });
  assert.deepEqual(platformRuntime({ platform: 'darwin', arch: 'arm64' }), {
    backend: 'Metal', gpu: 'metal', gpuLayers: 'auto',
  });
});

test('modelInfo reports a missing model without creating the cache', async (t) => {
  const home = await tempHome(t);
  const info = await modelInfo({ home });
  assert.equal(info.status, 'missing');
  assert.equal(info.downloaded, false);
  assert.equal(info.bytesOnDisk, 0);
  assert.equal(info.backend, platformRuntime().backend);
  assert.equal(info.path, join(home, 'models', MODEL.fileName));
  assert.equal(existsSync(join(home, 'models')), false);
});

test('modelInfo reports an incomplete cached file', async (t) => {
  const home = await tempHome(t);
  const models = join(home, 'models');
  await mkdir(models, { recursive: true });
  await writeFile(join(models, MODEL.fileName), 'partial');
  const info = await modelInfo({ home });
  assert.equal(info.status, 'incomplete');
  assert.equal(info.downloaded, false);
  assert.equal(info.bytesOnDisk, 7);
});

test('model status --json writes one JSON document', async (t) => {
  const home = await tempHome(t);
  const program = new Command();
  program.option('--home <dir>').option('--json', '', false);
  registerModelCommands(program);

  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await program.parseAsync(['--home', home, '--json', 'model', 'status'], { from: 'user' });
  } finally {
    process.stdout.write = write;
  }

  assert.equal(chunks.length, 1);
  const status = JSON.parse(chunks[0]);
  assert.equal(status.status, 'missing');
  assert.equal(status.backend, platformRuntime().backend);
  assert.equal(status.path, join(home, 'models', MODEL.fileName));
});

test('human model status uses Local LLM without model names or technical file details', async (t) => {
  const home = await tempHome(t);
  const program = new Command();
  program.option('--home <dir>');
  registerModelCommands(program);
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true; };
  try {
    await program.parseAsync(['--home', home, 'model', 'status'], { from: 'user' });
  } finally { process.stdout.write = write; }
  const output = chunks.join('');
  assert.match(output, /Local LLM/);
  assert.match(output, /Not downloaded/);
  assert.match(output, /532\.5 MB/);
  assert.doesNotMatch(output, /Qwen|gguf|sha256|huggingface/i);
});

const validationHome = process.env.COLONY_LOCAL_MODEL_HOME;
const cachedModel = validationHome ? join(validationHome, 'models', MODEL.fileName) : null;
const skipInference = !cachedModel || !existsSync(cachedModel);

const ROUTE_CRITERIA = {
  report: 'A written research report with sources.',
  website: 'A responsive website delivered as a publicly usable site.',
  image: 'One image file.',
  audio: 'One audio file, such as narration, speech or music.',
  video: 'One video file.',
  code: 'A new smart-contract project with its tests.',
  unsupported: 'An on-chain deployment, token launch, trading, or another unsupported action.',
};

test('explicit local planner makes English and Chinese deliverable decisions', { skip: skipInference }, async () => {
  assert.equal(typeof validationHome, 'string');
  const planner = await createLocalPlanner({ home: validationHome });
  try {
    assert.equal(planner.backend, platformRuntime().backend);
    const cases = [
      {
        objective: 'Build a landing page for my bakery with a menu and contact section.',
        expected: 'website',
      },
      {
        objective: '给我的咖啡店做一个展示菜单和地址的网站。',
        expected: 'website',
      },
      {
        objective: 'Compare three project management tools for a five-person design studio and write a report with sources.',
        expected: 'report',
      },
      {
        objective: '画一张水彩风格的猫咪头像。',
        expected: 'image',
      },
    ];

    for (const item of cases) {
      const answer = await planner.decide({
        document: item.objective,
        instruction: 'What deliverable does this request ask for?',
        criteria: ROUTE_CRITERIA,
      });
      assert.equal(answer.choice, item.expected);
      assert.ok(answer.confidence > 0 && answer.confidence <= 1);
      assert.deepEqual(Object.keys(answer.probabilities).sort(), Object.keys(ROUTE_CRITERIA).sort());
    }
  } finally {
    await planner.close();
  }
});
