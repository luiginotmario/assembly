import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Guide, KeyInfo, Manual } from '../shared/types.js';

// Manuals, with no accounts: whoever has the link can follow it and check photos against it;
// only the agent that made it (it holds the edit token) can change the guide.
//
// A manual is stored as separate fields: the guide, the step, the key, and each photo on its
// own. Every request (and every long background job, like reading a photo) loads its own copy
// and writes back only the fields it changed, so the phone checking a photo while the computer
// moves to the next step never overwrite each other. A version number goes up with every
// write; open pages watch it to stay in sync.
//
// Locally the fields live in memory and in data/manuals/<id>/; on Vercel in Upstash Redis,
// with photos in Vercel Blob.

export const DATA = path.resolve(process.env.DATA_DIR ?? 'data');
const REDIS_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
export const cloud = Boolean(REDIS_URL && REDIS_TOKEN && process.env.BLOB_READ_WRITE_TOKEN);
/** on vercel nothing can be stored until the redis database is linked */
export const ready = cloud || !process.env.VERCEL;
export const NOT_READY = 'Storage isn’t set up on this deployment yet: link an Upstash Redis database to the Vercel project.';
const KEEP_DAYS = 90;

export const id = (length = 16) => randomBytes(32).toString('base64url').replace(/[-_]/g, '').slice(0, length);
export const valid = (manualId: string) => /^[A-Za-z0-9]{8,32}$/.test(manualId);
export const folder = (manualId: string) => path.join(DATA, 'manuals', manualId);

type Fields = Record<string, string>;

// ---------- the two places fields can live ----------

const local = {
  manuals: new Map<string, { fields: Fields; version: number }>(),
  saving: new Map<string, NodeJS.Timeout>(),
  async load(manualId: string) {
    const cached = this.manuals.get(manualId);
    if (cached) return cached;
    try {
      const stored = JSON.parse(await readFile(path.join(folder(manualId), 'fields.json'), 'utf8')) as { fields: Fields; version: number };
      this.manuals.set(manualId, stored);
      return stored;
    } catch {
      return null;
    }
  },
  async write(manualId: string, changes: Fields) {
    const stored = (await this.load(manualId)) ?? { fields: {}, version: 0 };
    Object.assign(stored.fields, changes);
    stored.version += 1;
    this.manuals.set(manualId, stored);
    clearTimeout(this.saving.get(manualId));
    this.saving.set(
      manualId,
      setTimeout(async () => {
        await mkdir(folder(manualId), { recursive: true });
        await writeFile(path.join(folder(manualId), 'fields.json'), JSON.stringify(stored));
      }, 300),
    );
  },
};

/** one round trip to upstash with several redis commands */
async function redis(commands: (string | number)[][]) {
  const response = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!response.ok) throw new Error(`storage said ${response.status}`);
  const results = (await response.json()) as { result?: unknown; error?: string }[];
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`storage: ${failed.error}`);
  return results.map((r) => r.result);
}

const key = (manualId: string) => `manual:${manualId}`;

const remote = {
  async load(manualId: string) {
    const [flat] = (await redis([['HGETALL', key(manualId)]])) as [string[]];
    if (!flat?.length) return null;
    const fields: Fields = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    const version = Number(fields.v ?? 0);
    delete fields.v;
    return { fields, version };
  },
  async write(manualId: string, changes: Fields) {
    await redis([
      ['HSET', key(manualId), ...Object.entries(changes).flat()],
      ['HINCRBY', key(manualId), 'v', 1],
      ['EXPIRE', key(manualId), KEEP_DAYS * 86400],
    ]);
  },
  async version(manualId: string) {
    const [v] = (await redis([['HGET', key(manualId), 'v']])) as [string | null];
    return Number(v ?? 0);
  },
};

const store = cloud ? remote : local;

// ---------- manuals as fields ----------

/** what's stored besides the manual itself: who may edit it, and its key, sealed */
type Private = { editHash: string; sealed: string };
type Stored = Manual & Private;

/** photos are stored with their position, so they come back in order */
function toFields(manual: Stored): Fields {
  const fields: Fields = {
    meta: JSON.stringify({ id: manual.id, createdAt: manual.createdAt, editHash: manual.editHash }),
    guide: JSON.stringify(manual.guide),
    updatedAt: JSON.stringify(manual.updatedAt),
    step: JSON.stringify(manual.step),
    key: JSON.stringify(manual.key),
    sealed: JSON.stringify(manual.sealed),
  };
  manual.photos.forEach((photo, i) => (fields[`photo:${photo.id}`] = JSON.stringify([i, photo])));
  return fields;
}

function fromFields(fields: Fields): Stored {
  const read = <T>(name: string, fallback: T): T => (fields[name] ? (JSON.parse(fields[name]) as T) : fallback);
  const meta = read('meta', { id: '', createdAt: 0, editHash: '' });
  return {
    ...meta,
    guide: read<Guide>('guide', { title: '', summary: '', parts: [], steps: [] }),
    updatedAt: read('updatedAt', meta.createdAt),
    step: read('step', 0),
    key: read<KeyInfo | null>('key', null),
    sealed: read('sealed', ''),
    photos: Object.entries(fields)
      .filter(([name]) => name.startsWith('photo:'))
      .map(([, value]) => JSON.parse(value) as [number, Manual['photos'][number]])
      .sort((a, b) => a[0] - b[0])
      .map(([, photo]) => photo),
  };
}

// what each loaded copy last read or wrote, so a save only sends what this copy changed
const synced = new WeakMap<Stored, Fields>();
const queues = new WeakMap<Stored, Promise<void>>();
const pending = new Set<Promise<void>>();

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** a new manual, and the token that lets its maker change it later */
export async function create(guide: Guide) {
  const token = randomBytes(24).toString('base64url');
  const now = Date.now();
  const manual: Stored = { id: id(), createdAt: now, updatedAt: now, guide, step: 0, photos: [], key: null, editHash: hash(token), sealed: '' };
  synced.set(manual, {});
  changed(manual);
  await flush();
  return { manual, token };
}

export async function get(manualId: string): Promise<Stored | null> {
  if (!valid(manualId)) return null;
  const stored = await store.load(manualId);
  if (!stored?.fields.meta) return null;
  const manual = fromFields(stored.fields);
  synced.set(manual, toFields(manual));
  return manual;
}

/** the manual as anyone with the link sees it */
export function shown(manual: Stored): Manual {
  const { editHash: _, sealed: __, ...visible } = manual;
  return visible;
}

export function mayEdit(manual: Stored, token: string) {
  const a = Buffer.from(hash(token));
  const b = Buffer.from(manual.editHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function version(manualId: string) {
  if (!valid(manualId)) return 0;
  if (cloud) return remote.version(manualId);
  return (await local.load(manualId))?.version ?? 0;
}

/** saves what this copy of the manual changed, in order with its earlier saves */
export function changed(manual: Stored) {
  const before = queues.get(manual) ?? Promise.resolve();
  const save = before.then(async () => {
    const now = toFields(manual);
    const last = synced.get(manual) ?? {};
    const changes = Object.fromEntries(Object.entries(now).filter(([name, value]) => last[name] !== value));
    if (!Object.keys(changes).length) return;
    synced.set(manual, now);
    await store.write(manual.id, changes);
  });
  const settled = save.catch((error) => console.error('saving the manual failed:', error));
  queues.set(manual, settled);
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
}

/** waits until everything changed so far is stored */
export async function flush() {
  while (pending.size) await Promise.all([...pending]);
}

export type { Stored };

// ---------- photos and other files ----------

/** stores an image and returns the url it can be read back from */
export async function putFile(manualId: string, name: string, data: Buffer) {
  if (cloud) {
    const { put } = await import('@vercel/blob');
    const blob = await put(`manuals/${manualId}/${name}`, data, {
      access: 'public',
      contentType: 'image/jpeg',
      addRandomSuffix: true,
    });
    return blob.url;
  }
  await mkdir(folder(manualId), { recursive: true });
  await writeFile(path.join(folder(manualId), name), data);
  return `/files/${manualId}/${name}`;
}

export async function getFile(url: string) {
  const onDisk = url.match(/^\/files\/([A-Za-z0-9]{8,32})\/([A-Za-z0-9-]+\.jpg)$/);
  if (onDisk) return readFile(path.join(folder(onDisk[1]), onDisk[2]));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`couldn't load the photo (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}
