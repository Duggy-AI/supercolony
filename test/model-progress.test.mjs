import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelProgress, modelProgressLines } from '../src/planner/progress.mjs';

const download = { stage: 'downloading', downloadedSize: 266258560, totalSize: 532517120, speed: 5000000, source: 'primary', sourceWebsite: 'huggingface.co' };
const backup = { ...download, source: 'backup', sourceWebsite: 'hf-mirror.com' };

test('model download explains the model and its purpose at narrow widths', () => {
  const lines = modelProgressLines(download, { width: 36 });
  const output = lines.join('\n');
  assert.match(output, /Model: Qwen\n/);
  assert.doesNotMatch(output, /Qwen3|0\.8B|Q4_K_M/);
  assert.match(output, /From: huggingface\.co/);
  assert.match(output, /Size: 532\.5 MB, downloaded once\./);
  assert.match(output, /Use: understands natural language,/);
  assert.match(output, /picks task settings\./);
  assert.match(output, /IMD workers execute the tasks\./);
  assert.match(output, /Kept on this computer for reuse\./);
  assert.match(output, /No external AI API key needed\./);
  assert.doesNotMatch(output, /wallet|no network|offline|model (runs|executes) (the )?tasks/i);
  assert.ok(lines.every(line => line.length <= 36));
});

test('compact model description fits five 36-column lines and computes the rounded size', () => {
  const lines = modelProgressLines(download, { width: 36, compact: true });
  const description = lines.slice(2, 7);
  assert.deepEqual(description, [
    'Qwen · 533 MB',
    'Understands your request locally',
    'and chooses task settings.',
    'IMD workers do the work.',
    'Downloaded once; no AI API key.',
  ]);
  assert.ok(lines.every(line => line.length <= 36));
  assert.match(lines.join('\n'), /\[#+-+\] 50%/);
});

test('model download shows a bounded bar, percentage, transferred size and speed at narrow widths', () => {
  const lines = modelProgressLines(download, { width: 36 });
  const output = lines.join('\n');
  assert.match(output, /\[#+-+\] 50%/);
  assert.match(output, /266\.3 \/ 532\.5 MB/);
  assert.match(output, /5\.0 MB\/s/);
  assert.match(output, /1\/3 Download local LLM/);
  assert.match(output, /2\/3 Verify download/);
  assert.match(output, /3\/3 Load local LLM/);
});

test('40x20 TUI panel content stays within the available height', () => {
  const panel = modelProgressLines(backup, { width: 36 }).slice(2);
  assert.ok(panel.length <= 15, `panel has ${panel.length} lines`);
  assert.ok(panel.every(line => line.length <= 36));
  const compact = modelProgressLines(backup, { width: 36, compact: true }).slice(2);
  assert.ok(compact.includes('    From: hf-mirror.com'));
  assert.ok(compact.length <= 12, `compact panel has ${compact.length} lines`);
  assert.ok(compact.every(line => line.length <= 36));
});

test('100% downloaded is not marked ready before verification and loading finish', () => {
  const full = modelProgressLines({ ...download, downloadedSize: download.totalSize }).join('\n');
  assert.match(full, /100%/);
  assert.doesNotMatch(full, /Local LLM is ready/);
  const verifying = modelProgressLines({ stage: 'verifying', totalSize: download.totalSize }).join('\n');
  assert.match(verifying, /\[\+\] 1\/3 Download/);
  assert.match(verifying, /\[>\] 2\/3 Verify/);
  assert.doesNotMatch(verifying, /Local LLM is ready/);
  const ready = modelProgressLines({ stage: 'ready', totalSize: download.totalSize }).join('\n');
  assert.match(ready, /\[ \] 3\/3 Load/);
  assert.doesNotMatch(ready, /Local LLM is ready/);
  assert.match(modelProgressLines({ stage: 'loaded' }).join('\n'), /Local LLM is ready/);
  assert.match(modelProgressLines({ stage: 'ready' }, { load: false }).join('\n'), /Local LLM is ready/);
});

test('redirected progress explains the model once and visibly resets for the backup source', () => {
  let output = '';
  const progress = createModelProgress({ stream: { write: value => { output += value; } } });
  progress.update({ stage: 'checking' });
  progress.update(download);
  progress.update({ ...download, downloadedSize: 270000000 });
  progress.update({ ...backup, downloadedSize: 0, speed: 0 });
  progress.update({ stage: 'verifying' });
  progress.update({ stage: 'loading' });
  progress.update({ stage: 'loaded' });
  assert.match(output, /Model: Qwen\n/);
  assert.match(output, /IMD workers execute the tasks/);
  assert.match(output, /No external AI API key needed/);
  assert.equal(output.match(/Model: Qwen\n/g).length, 1);
  assert.equal(output.match(/Download source: huggingface\.co/g).length, 1);
  assert.equal(output.match(/Download source: hf-mirror\.com/g).length, 1);
  assert.doesNotMatch(output, /Qwen3|0\.8B|Q4_K_M/);
  assert.match(output, /Download local LLM: 0%/);
  assert.match(output, /Verifying local LLM/);
  assert.match(output, /Loading local LLM/);
  assert.match(output, /Local LLM is ready/);
  assert.doesNotMatch(output, /\x1b|\r|undefined|NaN/);
  assert.equal(output.match(/Download local LLM: 50%/g).length, 1);
});

test('interactive failure ends the animation and leaves the failed step visible', async () => {
  const chunks = [];
  const progress = createModelProgress({ stream: { isTTY: true, columns: 40, write: value => { chunks.push(value); } } });
  progress.update({ stage: 'checking', totalSize: download.totalSize });
  progress.update(download);
  progress.update({ stage: 'verifying', totalSize: download.totalSize });
  progress.fail();
  assert.match(chunks.join(''), /\[x\] 2\/3 Verify download/);
  assert.match(chunks.join(''), /Preparation failed/);
  const count = chunks.length;
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(chunks.length, count);
});
