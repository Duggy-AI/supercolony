// Render the real dashboard with illustrative data. No API, wallet or payment
// services are contacted. The resulting frames are used by render-readme.py.
process.env.FORCE_COLOR = '3';

const { createElement } = await import('react');
const { render } = await import('ink-testing-library');
const { mkdir, writeFile } = await import('node:fs/promises');
const { resolve } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { setTimeout: delay } = await import('node:timers/promises');
const { DashboardApp } = await import('../src/tui/app.mjs');
const { DashboardController } = await import('../src/tui/controller.mjs');
const { networkWorker } = await import('../src/lib/network-workers.mjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, '.local/readme-captures');
await mkdir(out, { recursive: true });
const address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const secondAddress = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const jobs = [
  { id: 'a1b2c3d4-1000-4000-8000-000000000001', objective: 'Build a website for my coffee shop with a menu and contact form.', state: 'executing', template: 'website' },
  { id: 'a1b2c3d4-1000-4000-8000-000000000002', objective: 'Research the Ethereum L2 landscape and write a comparison report.', state: 'completed', template: 'research-report' },
  { id: 'a1b2c3d4-1000-4000-8000-000000000003', objective: 'Design a landing page for our open-source project.', state: 'completed', template: 'website' },
  { id: 'a1b2c3d4-1000-4000-8000-000000000004', objective: 'Create a product illustration for our next release.', state: 'executing', template: 'image' },
];
const item = job => ({ id: job.id, jobId: job.id, title: job.objective, state: job.state });
const mine = [item(jobs[0]), item(jobs[1]),
  { id: 'saved-draft', draftId: 'saved-draft', title: 'Write the first issue of our community newsletter.', state: 'draft' },
  { id: 'saved-order', requestKey: 'saved-order', title: 'Add a booking form to the coffee shop website.', state: 'challenged', canResume: true, canCancel: true },
  item(jobs[2])];
const network = (tokenId, working, maxConcurrency, paused = false) => networkWorker({
  deviceKey: 'demo-device-' + tokenId, seat: { tokenId, agentId: tokenId },
  connectedHere: true, paused, working, maxConcurrency,
  lastHeartbeatAt: '2026-10-20T08:00:00Z', daemonVersion: 'official release',
  platform: { os: 'linux', arch: 'x64' }, runtimes: [{ id: 'claude' }],
  skills: ['website', 'research-report'],
});
const services = {
  mine: async () => ({ items: mine, note: 'Local + wallet · newest 100 orders', address }),
  explore: async () => ({ items: jobs.map(item), total: jobs.length, note: 'Public tasks · auto-refresh 30s' }),
  detail: async entry => ({ ...jobs.find(job => job.id === entry.jobId), paidBy: address }),
  targets: () => [
    { id: 'local', title: 'This computer', installed: true, subtitle: 'Deployed · managed here', options: {} },
    { id: 'ssh:worker.example.com:22', title: 'worker.example.com', installed: true, subtitle: 'Linux · SSH target', options: {} },
  ],
  networkWorkers: async () => [network(42, 0, 2), network(84, 2, 2), network(128, 0, 1, true)],
  command: async () => ({ service: 'Running as a background service', standing: 'Connected · ready for tasks' }),
  wallets: () => [{ address, active: true }, { address: secondAddress, active: false }],
  wallet: async (_signal, selected = address) => ({
    configured: true, source: 'local', address: selected, currentAddress: address,
    networks: [
      { key: 'ethereum', chainName: 'Ethereum', coins: [{ symbol: 'IMD', balance: '12.5' }, { symbol: 'ETH', balance: '0.02' }, { symbol: 'USDC', balance: '25' }, { symbol: 'USDT', balance: '0' }] },
      { key: 'robinhood', chainName: 'Robinhood Chain', coins: [{ symbol: 'IMD', balance: '0' }, { symbol: 'ETH', balance: '0.004' }, { symbol: 'USDG', balance: '5' }] },
    ],
  }),
};

async function capture(name, title, view, { rows = 32, prepare } = {}) {
  const controller = new DashboardController(services);
  const dimensions = { columns: 110, rows };
  const ui = render(createElement(DashboardApp, { controller, dimensions, terminal: async () => {} }));
  Object.defineProperty(ui.stdout, 'columns', { get: () => dimensions.columns });
  Object.defineProperty(ui.stdout, 'rows', { get: () => dimensions.rows });
  ui.stdout.emit('resize');
  try {
    while (!controller.state.detail || controller.state.busy) await delay(10);
    if (view !== 'tasks') await controller.navigate(view);
    if (prepare) await prepare(controller);
    await delay(100);
    const frame = ui.lastFrame();
    await writeFile(resolve(out, name + '.json'), JSON.stringify({ title, columns: dimensions.columns, rows, frame }, null, 2) + '\n');
    console.log('Captured ' + name);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
}

await capture('my-tasks', 'supercolony / My tasks', 'tasks');
await capture('explore', 'supercolony / Explore', 'explore');
await capture('workers', 'supercolony / Workers', 'workers');
await capture('wallets', 'supercolony / Wallets', 'wallet', { rows: 38 });
await capture('payment-review', 'supercolony / Review & publish', 'tasks', {
  rows: 30,
  prepare: async controller => controller.update({
    confirm: {
      title: 'Review task & payment', selection: 0, accepted: false, expanded: false,
      extraAction: { label: 'Change payment' },
      payment: {
        objective: jobs[0].objective,
        deliverables: ['A responsive website.', 'A publicly hosted version of the site.'],
        amount: '0.5', payWith: 'IMD', chainName: 'Ethereum', networkFeeCap: '0.00012',
      },
    },
  }),
});
