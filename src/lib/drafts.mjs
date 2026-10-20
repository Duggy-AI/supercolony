import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadOrder } from './orders.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function pathFor(home, id) {
  if (!UUID.test(id)) throw new Error('Invalid draft ID.');
  return join(home, 'drafts', id + '.json');
}

export async function saveDraft(home, draft) {
  const path = pathFor(home, draft.id);
  const now = new Date().toISOString();
  const saved = { id: draft.id, api: draft.api, objective: draft.objective,
    parent: draft.parent ?? null, ...(draft.plan ? { plan: draft.plan } : {}),
    createdAt: draft.createdAt ?? now, updatedAt: now };
  await mkdir(join(home, 'drafts'), { recursive: true, mode: 0o700 });
  const temporary = join(home, 'drafts', '.' + draft.id + '.' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  return saved;
}

export async function loadDraft(home, id) {
  return JSON.parse(await readFile(pathFor(home, id), 'utf8'));
}

export async function deleteDraft(home, id) {
  await rm(pathFor(home, id), { force: true });
  return { id };
}

export async function listDrafts(home) {
  let files;
  try { files = await readdir(join(home, 'drafts')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const drafts = await Promise.all(files.filter(file => file.endsWith('.json') && UUID.test(file.slice(0, -5)))
    .map(async file => {
      const id = file.slice(0, -5);
      // The order is durable before its draft is removed. If the app exits
      // between those writes, the order owns the same ID and takes precedence.
      if (await loadOrder(home, id)) return null;
      return loadDraft(home, id);
    }));
  return drafts.filter(Boolean);
}
