import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalPlanner, MODEL } from '../src/planner/local.mjs';
import { planIntent } from '../src/planner/intent.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = resolve(process.argv[2] ?? `${root}/.local/model-validation`);
const output = resolve(process.argv[3] ?? `${root}/.local/planner-evaluation-${process.platform}-${process.arch}.json`);
const catalog = JSON.parse(await readFile(new URL('../test/fixtures/planner-catalog.json', import.meta.url), 'utf8'));
const cases = [
  ['en-report', 'Compare three project management tools for a five-person design studio and write a report with sources.', 'report'],
  ['en-site', 'Build a landing page for my bakery with a menu and contact section.', 'website'],
  ['en-image', 'Draw a minimalist orange fox logo on a white background.', 'image'],
  ['en-audio', 'Record a warm spoken welcome message for my coffee shop.', 'audio'],
  ['en-video', 'Make a short promotional video for a handmade candle brand.', 'video'],
  ['en-contract', 'Write a Solidity escrow contract with tests. Do not deploy it.', 'code'],
  ['en-research', 'I need a sourced comparison of electric bicycles for daily commuting.', 'report'],
  ['en-portfolio', 'I am a photographer. Make me a portfolio website with a gallery.', 'website'],
  ['en-music', 'Compose a relaxing instrumental background music track.', 'audio'],
  ['en-illustration', 'Create an illustration of a mountain village at sunrise.', 'image'],
  ['en-deploy', 'Deploy a token on Ethereum mainnet and launch trading now.', 'unsupported'],
  ['en-trade', 'Buy 10 ETH for me using my wallet now.', 'unsupported'],
  ['zh-report', '帮我写一份新能源汽车市场研究报告，附上资料来源。', 'report'],
  ['zh-site', '给我的咖啡店做一个展示菜单和地址的网站。', 'website'],
  ['zh-image', '画一张水彩风格的猫咪头像。', 'image'],
  ['mixed-site', 'Build a website for 我的花店 with an English homepage.', 'website'],
  ['mixed-report', 'Compare React and Vue，写一份有来源的英文报告。', 'report'],
  ['holdout-web-topic', 'Write a report comparing website builders for a small charity.', 'report'],
  ['holdout-research-site', 'Build a website to showcase our market research agency.', 'website'],
  ['holdout-video-topic', 'Research the environmental effects of video streaming and produce a sourced report.', 'report'],
  ['holdout-podcast', 'Generate a spoken introduction for a weekly science podcast.', 'audio'],
  ['holdout-poster', 'Design a poster advertising a neighborhood book fair.', 'image'],
  ['holdout-video', 'Animate our coffee beans falling into a cup for a ten-second clip.', 'video'],
  ['holdout-contract', 'Create a tested Solidity vesting contract for team allocations, source code only.', 'code'],
  ['holdout-zh-report', '研究各种网站建设工具的优缺点，给我一份分析报告。', 'report'],
  ['en-continue', 'Change the background to pale blue and make the logo bigger.', 'same', { parent: { id: 'existing-site', template: 'skill:build-website', objective: 'A bakery website.' } }],
  ['zh-continue', '把标题改成中文，其他内容保留。', 'same', { parent: { id: 'existing-site', template: 'skill:build-website', objective: 'A bakery website.' } }],
];

const started = performance.now();
const runtime = await createLocalPlanner({ home });
const loadMs = Math.round(performance.now() - started);
const results = [];
try {
  for (const [id, objective, expected, extra = {}] of cases) {
    const start = performance.now();
    try {
      const plan = await planIntent({ objective, catalog, decide: runtime.decide, ...extra });
      const matchesDeliverable = plan.route === expected
        || (expected === 'same' && plan.input?.skill === 'build-website');
      const passed = matchesDeliverable
        && (expected === 'unsupported' ? plan.input === null : plan.input?.objective === objective)
        && (!extra.parent || plan.input?.parentJobId === extra.parent.id);
      results.push({ id, objective, expected, actual: plan.route, passed, elapsedMs: Math.round(performance.now() - start), plan });
    } catch (error) {
      results.push({ id, objective, expected, passed: false, elapsedMs: Math.round(performance.now() - start), error: error.message });
    }
    const last = results.at(-1);
    process.stderr.write(`${last.passed ? 'PASS' : 'FAIL'} ${id}: ${last.actual ?? last.error} (${last.elapsedMs} ms)\n`);
  }
} finally {
  await runtime.close();
}
const report = {
  platform: process.platform, arch: process.arch, node: process.version,
  model: MODEL.name, sha256: MODEL.sha256, backend: runtime.backend, loadMs,
  passed: results.filter((item) => item.passed).length, total: results.length, results,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, results: undefined, report: output }, null, 2));
if (report.passed !== report.total) process.exitCode = 1;
