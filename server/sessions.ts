import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../shared/types.js';

// Sessions, with no accounts: whoever has the link is in the session.
//
// A session is stored as separate fields: the plan, the guide, the step, and each photo,
// message, part and lookup on its own. Every request (and every long background job, like
// reading a photo) loads its own copy and writes back only the fields it changed, so the
// phone uploading a photo while the computer moves to the next step never overwrite each
// other. A version number goes up with every write; open pages watch it to stay in sync.
//
// Locally the fields live in memory and in data/sessions/<id>/; on Vercel in Upstash Redis,
// with photos in Vercel Blob.

export const DATA = path.resolve(process.env.DATA_DIR ?? 'data');
const REDIS_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
export const cloud = Boolean(REDIS_URL && REDIS_TOKEN && process.env.BLOB_READ_WRITE_TOKEN);
const KEEP_DAYS = 30;

export const id = (length = 12) => randomBytes(24).toString('base64url').replace(/[-_]/g, '').slice(0, length);
export const valid = (sessionId: string) => /^[A-Za-z0-9]{8,32}$/.test(sessionId);
export const folder = (sessionId: string) => path.join(DATA, 'sessions', sessionId);

type Fields = Record<string, string>;

// ---------- the two places fields can live ----------

const local = {
  sessions: new Map<string, { fields: Fields; version: number }>(),
  saving: new Map<string, NodeJS.Timeout>(),
  async load(sessionId: string) {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    try {
      const stored = JSON.parse(await readFile(path.join(folder(sessionId), 'fields.json'), 'utf8')) as { fields: Fields; version: number };
      this.sessions.set(sessionId, stored);
      return stored;
    } catch {
      // a session from before sessions were stored as fields
      try {
        const old = JSON.parse(await readFile(path.join(folder(sessionId), 'session.json'), 'utf8')) as Session;
        const stored = { fields: toFields(migrate(old)), version: 1 };
        this.sessions.set(sessionId, stored);
        return stored;
      } catch {
        return null;
      }
    }
  },
  async write(sessionId: string, changes: Fields) {
    const stored = (await this.load(sessionId)) ?? { fields: {}, version: 0 };
    Object.assign(stored.fields, changes);
    stored.version += 1;
    this.sessions.set(sessionId, stored);
    clearTimeout(this.saving.get(sessionId));
    this.saving.set(
      sessionId,
      setTimeout(async () => {
        await mkdir(folder(sessionId), { recursive: true });
        await writeFile(path.join(folder(sessionId), 'fields.json'), JSON.stringify(stored));
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
  if (!response.ok) throw new Error(`session storage said ${response.status}`);
  const results = (await response.json()) as { result?: unknown; error?: string }[];
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`session storage: ${failed.error}`);
  return results.map((r) => r.result);
}

const key = (sessionId: string) => `session:${sessionId}`;

const remote = {
  async load(sessionId: string) {
    const [flat] = (await redis([['HGETALL', key(sessionId)]])) as [string[]];
    if (!flat?.length) return null;
    const fields: Fields = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    const version = Number(fields.v ?? 0);
    delete fields.v;
    return { fields, version };
  },
  async write(sessionId: string, changes: Fields) {
    await redis([
      ['HSET', key(sessionId), ...Object.entries(changes).flat()],
      ['HINCRBY', key(sessionId), 'v', 1],
      ['EXPIRE', key(sessionId), KEEP_DAYS * 86400],
    ]);
  },
  async version(sessionId: string) {
    const [v] = (await redis([['HGET', key(sessionId), 'v']])) as [string | null];
    return Number(v ?? 0);
  },
};

const store = cloud ? remote : local;

// ---------- sessions as fields ----------

const LISTS = { photo: 'photos', message: 'messages', part: 'parts', lookup: 'lookups' } as const;

/** list items are stored with their position, so they come back in order */
function toFields(session: Session): Fields {
  const fields: Fields = {
    meta: JSON.stringify({ id: session.id, createdAt: session.createdAt }),
    plan: JSON.stringify(session.plan),
    guide: JSON.stringify(session.guide),
    step: JSON.stringify(session.step),
    building: JSON.stringify(session.building),
    buildError: JSON.stringify(session.buildError),
    thinking: JSON.stringify(session.thinking),
  };
  for (const [prefix, list] of Object.entries(LISTS)) {
    (session[list] as { id?: string; query?: string }[]).forEach((item, i) => {
      fields[`${prefix}:${item.id ?? item.query}`] = JSON.stringify([i, item]);
    });
  }
  return fields;
}

function fromFields(fields: Fields): Session {
  const meta = JSON.parse(fields.meta) as { id: string; createdAt: number };
  const read = <T>(name: string, fallback: T): T => (fields[name] ? (JSON.parse(fields[name]) as T) : fallback);
  const session = {
    ...meta,
    plan: read('plan', ''),
    guide: read('guide', null),
    step: read('step', 0),
    building: read('building', false),
    buildError: read('buildError', ''),
    thinking: read('thinking', false),
  } as Session;
  for (const [prefix, list] of Object.entries(LISTS)) {
    const items = Object.entries(fields)
      .filter(([name]) => name.startsWith(`${prefix}:`))
      .map(([, value]) => JSON.parse(value) as [number, unknown])
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item);
    (session as unknown as Record<string, unknown[]>)[list] = items;
  }
  return session;
}

/** sessions from before photos were stored by url */
function migrate(session: Session) {
  session.parts ??= [];
  session.lookups ??= [];
  for (const photo of session.photos) {
    const url = (name: string) => (name.startsWith('/') || name.startsWith('http') ? name : `/files/${session.id}/${name}`);
    photo.file = url(photo.file);
    photo.crops = photo.crops.map(url);
  }
  return session;
}

// what each loaded copy last read or wrote, so a save only sends what this copy changed
const synced = new WeakMap<Session, Fields>();
const queues = new WeakMap<Session, Promise<void>>();
const pending = new Set<Promise<void>>();

export async function create(): Promise<Session> {
  const session: Session = {
    id: id(),
    createdAt: Date.now(),
    plan: '',
    parts: [],
    lookups: [],
    guide: null,
    building: false,
    buildError: '',
    step: 0,
    photos: [],
    messages: [],
    thinking: false,
  };
  synced.set(session, {});
  changed(session);
  await flush();
  return session;
}

export async function get(sessionId: string): Promise<Session | null> {
  if (!valid(sessionId)) return null;
  const stored = await store.load(sessionId);
  if (!stored?.fields.meta) return null;
  const session = migrate(fromFields(stored.fields));
  synced.set(session, toFields(session));
  return session;
}

export async function version(sessionId: string) {
  if (!valid(sessionId)) return 0;
  if (cloud) return remote.version(sessionId);
  return (await local.load(sessionId))?.version ?? 0;
}

/** saves what this copy of the session changed, in order with its earlier saves */
export function changed(session: Session) {
  const before = queues.get(session) ?? Promise.resolve();
  const save = before.then(async () => {
    const now = toFields(session);
    const last = synced.get(session) ?? {};
    const changes = Object.fromEntries(Object.entries(now).filter(([name, value]) => last[name] !== value));
    if (!Object.keys(changes).length) return;
    synced.set(session, now);
    await store.write(session.id, changes);
  });
  const settled = save.catch((error) => console.error('saving the session failed:', error));
  queues.set(session, settled);
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
}

/** waits until everything changed so far is stored */
export async function flush() {
  while (pending.size) await Promise.all([...pending]);
}

// ---------- photos and other files ----------

/** stores an image and returns the url it can be read back from */
export async function putFile(sessionId: string, name: string, data: Buffer) {
  if (cloud) {
    const { put } = await import('@vercel/blob');
    const blob = await put(`sessions/${sessionId}/${name}`, data, {
      access: 'public',
      contentType: 'image/jpeg',
      addRandomSuffix: true,
    });
    return blob.url;
  }
  await mkdir(folder(sessionId), { recursive: true });
  await writeFile(path.join(folder(sessionId), name), data);
  return `/files/${sessionId}/${name}`;
}

export async function getFile(url: string) {
  const onDisk = url.match(/^\/files\/([A-Za-z0-9]{8,32})\/([A-Za-z0-9-]+\.jpg)$/);
  if (onDisk) return readFile(path.join(folder(onDisk[1]), onDisk[2]));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`couldn't load the photo (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}
