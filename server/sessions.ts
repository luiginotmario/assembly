import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../shared/types';

// Sessions live in memory and on disk (data/sessions/<id>/), with no accounts: whoever
// has the link (the qr code on the computer) is in the session. Every change is pushed
// to all open devices, so the phone and the computer always show the same thing.

export const DATA = path.resolve(process.env.DATA_DIR ?? 'data');

const cache = new Map<string, Session>();
const listeners = new Map<string, Set<(session: Session) => void>>();
const pendingSaves = new Map<string, NodeJS.Timeout>();

export const id = (length = 12) => randomBytes(24).toString('base64url').replace(/[-_]/g, '').slice(0, length);

const valid = (sessionId: string) => /^[A-Za-z0-9]{8,32}$/.test(sessionId);

export const folder = (sessionId: string) => path.join(DATA, 'sessions', sessionId);

export async function create(): Promise<Session> {
  const session: Session = {
    id: id(),
    createdAt: Date.now(),
    plan: '',
    guide: null,
    building: false,
    buildError: '',
    step: 0,
    photos: [],
    messages: [],
    thinking: false,
  };
  await mkdir(folder(session.id), { recursive: true });
  cache.set(session.id, session);
  await save(session);
  return session;
}

export async function get(sessionId: string): Promise<Session | null> {
  if (!valid(sessionId)) return null;
  const cached = cache.get(sessionId);
  if (cached) return cached;
  try {
    const session = JSON.parse(await readFile(path.join(folder(sessionId), 'session.json'), 'utf8')) as Session;
    // anything that was in flight when the server stopped won't finish now
    session.building = false;
    session.thinking = false;
    for (const photo of session.photos) if (photo.status === 'analyzing') photo.status = 'error';
    cache.set(sessionId, session);
    return session;
  } catch {
    return null;
  }
}

/** tell every open device, and save shortly after */
export function changed(session: Session) {
  for (const listener of listeners.get(session.id) ?? []) listener(session);
  clearTimeout(pendingSaves.get(session.id));
  pendingSaves.set(
    session.id,
    setTimeout(() => void save(session), 300),
  );
}

export function subscribe(sessionId: string, listener: (session: Session) => void) {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => set.delete(listener);
}

async function save(session: Session) {
  await mkdir(folder(session.id), { recursive: true });
  await writeFile(path.join(folder(session.id), 'session.json'), JSON.stringify(session, null, 2));
}
