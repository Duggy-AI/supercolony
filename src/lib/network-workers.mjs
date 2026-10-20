import { request } from '../shared.mjs';

const LABELS = ['Available', 'Busy', 'Paused', 'Connection unconfirmed'];

export function networkWorker(worker) {
  const free = Math.max(0, worker.maxConcurrency - worker.working);
  const rank = !worker.connectedHere ? 3 : worker.paused ? 2 : free > 0 ? 0 : 1;
  const name = worker.seat?.tokenId ? 'Worker #' + worker.seat.tokenId : worker.deviceKey.slice(0, 12);
  return {
    id: 'network:' + worker.deviceKey, kind: 'network-worker',
    title: 'Network · ' + name, state: LABELS[rank], rank, free,
    subtitle: LABELS[rank] + ' · ' + worker.working + '/' + worker.maxConcurrency + ' busy',
    searchText: [worker.deviceKey, worker.seat?.agentId, ...worker.runtimes.map(runtime => runtime.id), ...worker.skills].join(' '),
    worker,
  };
}

export async function networkWorkers(api, signal) {
  const { data } = await request(api, '/workers', { signal });
  return data.workers.map(networkWorker).sort((a, b) => a.rank - b.rank || b.free - a.free || a.id.localeCompare(b.id));
}

export function networkWorkerText(item) {
  const w = item.worker;
  return [
    item.title, 'Tasks are assigned automatically by IMD.', '', 'Status: ' + item.state,
    'Running tasks: ' + w.working + ' / ' + w.maxConcurrency,
    'Free slots: ' + (item.rank === 0 ? item.free : 0),
    'Last heartbeat: ' + (w.lastHeartbeatAt ?? 'Not reported'),
    'Worker version: ' + (w.daemonVersion ?? 'Not reported'),
    'Platform: ' + (w.platform ? w.platform.os + ' / ' + w.platform.arch : 'Not reported'),
    'Token ID: ' + (w.seat?.tokenId ?? 'Not reported'),
    'Agent ID: ' + (w.seat?.agentId ?? 'Not registered'),
    '', 'RUNTIMES', ...w.runtimes.map(runtime => runtime.id + (runtime.premiumModel ? ' · ' + runtime.premiumModel.model : '')),
    '', 'SKILLS', w.skills.join(', ') || 'None reported',
    '', 'DEVICE KEY', w.deviceKey,
    '', 'Public information · read only',
    'Availability is reported by IMD; it is not a quality ranking.',
    'r refresh · / search',
  ].join('\n');
}
