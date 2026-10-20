import { clearScreenDown, cursorTo, moveCursor } from 'node:readline';
import { compactModelDescriptionLines, modelDescriptionLines } from './model-info.mjs';

const STEPS = ['Download local LLM', 'Verify download', 'Load local LLM'];
const FRAMES = ['|', '/', '-', '\\'];
const megabytes = bytes => (bytes / 1e6).toFixed(1);

export function modelProgressLines(event, { load = true, width = 80, frame = '>', compact = false } = {}) {
  const steps = load ? STEPS : STEPS.slice(0, 2);
  const complete = event.stage === 'loaded' || (!load && event.stage === 'ready');
  const current = { checking: 0, downloading: 0, verifying: 1, ready: 2, loading: 2, loaded: 3 }[event.stage];
  const description = compact ? compactModelDescriptionLines(event.totalSize) : modelDescriptionLines(event.totalSize);
  const lines = ['Preparing local LLM', '', ...description];
  for (const [index, label] of steps.entries()) {
    const active = index === current && event.stage !== 'ready';
    const marker = complete || index < current ? '+' : active ? event.failed ? 'x' : frame : ' ';
    lines.push(`[${marker}] ${index + 1}/${steps.length} ${label}`);
    if (index === 0 && event.stage === 'checking') lines.push('    Checking local files...');
    if (index === 0 && event.stage === 'downloading') {
      const ratio = Math.min(1, event.downloadedSize / event.totalSize);
      const size = Math.max(8, Math.min(24, width - 15));
      const filled = Math.floor(ratio * size);
      lines.push(`    [${'#'.repeat(filled)}${'-'.repeat(size - filled)}] ${Math.floor(ratio * 100)}%`);
      lines.push(`    ${megabytes(event.downloadedSize)} / ${megabytes(event.totalSize)} MB`);
      if (event.speed > 0) lines.push(`    ${megabytes(event.speed)} MB/s`);
      lines.push('    From: ' + event.sourceWebsite);
    }
  }
  if (complete) lines.push('', 'Local LLM is ready.');
  if (event.failed) lines.push('', 'Preparation failed. Please try again.');
  return lines;
}

// All progress stays on stderr, leaving --json stdout as one JSON document.
// Redirected output receives plain milestones, never cursor-control sequences.
export function createModelProgress({ stream = process.stderr, load = true } = {}) {
  const interactive = stream.isTTY === true;
  const color = interactive && !process.env.NO_COLOR && stream.hasColors?.();
  let current;
  let rows = 0;
  let frame = 0;
  let timer;
  let lastStage;
  let lastBucket = -1;
  let showedModelInfo = false;
  let lastWebsite;

  function draw() {
    if (!current) return;
    const width = Math.max(10, (stream.columns ?? 80) - 1);
    const lines = modelProgressLines(current, { load, width, frame: FRAMES[frame++ % FRAMES.length] });
    if (rows) { moveCursor(stream, 0, -rows); cursorTo(stream, 0); clearScreenDown(stream); }
    const output = lines.map(line => {
      const visible = line.slice(0, width);
      if (!color) return visible;
      const code = visible.startsWith('[+]') ? 32 : visible.startsWith('[x]') ? 31 : 36;
      return `\x1b[${code}m${visible}\x1b[0m`;
    });
    stream.write(output.join('\n') + '\n');
    rows = lines.length;
  }

  function close() { clearInterval(timer); timer = undefined; }

  function update(event) {
    current = event;
    const sourceChanged = event.stage === 'downloading' && event.sourceWebsite !== lastWebsite;
    if (interactive) {
      if (!timer) { draw(); timer = setInterval(draw, 120); timer.unref(); }
      else if (event.stage !== lastStage || sourceChanged || event.stage === 'downloading' && event.downloadedSize === event.totalSize) draw();
    } else if (event.stage === 'downloading') {
      if (!showedModelInfo) {
        stream.write(modelDescriptionLines(event.totalSize).join('\n') + '\n');
        showedModelInfo = true;
      }
      const bucket = Math.floor(event.downloadedSize / event.totalSize * 10);
      if (sourceChanged) stream.write('Download source: ' + event.sourceWebsite + '\n');
      if (event.stage !== lastStage || bucket !== lastBucket || sourceChanged) {
        stream.write(`Download local LLM: ${Math.floor(event.downloadedSize / event.totalSize * 100)}% (${megabytes(event.downloadedSize)} / ${megabytes(event.totalSize)} MB)\n`);
        lastBucket = bucket;
      }
    } else if (event.stage !== lastStage) {
      const labels = { checking: 'Checking local files...', verifying: 'Verifying local LLM...', loading: 'Loading local LLM...',
        ready: load ? 'Local LLM verified.' : 'Local LLM is ready.', loaded: 'Local LLM is ready.' };
      stream.write(labels[event.stage] + '\n');
    }
    lastStage = event.stage;
    if (event.stage === 'downloading') lastWebsite = event.sourceWebsite;
    if (event.stage === 'loaded' || !load && event.stage === 'ready') close();
  }

  function fail() {
    if (interactive && current) { current = { ...current, failed: true }; draw(); }
    close();
  }
  return { update, fail, close };
}
