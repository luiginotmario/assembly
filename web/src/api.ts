import type { Session } from '../../shared/types';

export type Info = { model: string; hasKey: boolean; lan: string[]; locked: boolean };

// the access code, if the site has one: remembered on this device, and picked up from a
// link (the qr code to open it on a phone carries it)
const fromLink = new URLSearchParams(location.search).get('code');
if (fromLink) {
  localStorage.setItem('access-code', fromLink);
  history.replaceState(null, '', location.pathname);
}
export const accessCode = () => localStorage.getItem('access-code') ?? '';
export const setAccessCode = (code: string) => localStorage.setItem('access-code', code.trim());

/** asks for the code when the server says it's needed, then the page starts over */
export class Locked extends Error {}

async function request(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, headers: { ...init.headers, 'x-access-code': accessCode() } });
  if (response.status === 401) throw new Locked('This needs the access code.');
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${response.status}`);
  return response.json();
}

const post = (url: string, body?: unknown) =>
  request(url, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** phone photos can be huge: scale to at most 2800 px on the long side, plenty to read labels */
async function shrink(file: File) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, 2800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.9));
  return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
}

export const api = {
  info: () => fetch('/api/info').then((r) => r.json() as Promise<Info>),
  create: () => post('/api/sessions') as Promise<{ id: string }>,
  plan: (id: string, plan: string) => post(`/api/sessions/${id}/plan`, { plan }),
  example: (id: string) => post(`/api/sessions/${id}/example`),
  step: (id: string, step: number) => post(`/api/sessions/${id}/step`, { step }),
  ask: (id: string, text: string) => post(`/api/sessions/${id}/ask`, { text }),
  photo: async (id: string, file: File, question: string) => {
    const form = new FormData();
    form.append('photo', await shrink(file));
    form.append('question', question);
    await request(`/api/sessions/${id}/photos`, { method: 'POST', body: form });
  },
  /**
   * the whole session now and after every change, on every device: the page checks the
   * session's version every second and a half (only while it's on screen) and fetches it
   * when it moves
   */
  follow: (id: string, onSession: (session: Session) => void, onLink: (up: boolean) => void, onLocked: () => void) => {
    let seen = -1;
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible' || seen < 0) {
        try {
          const { version } = (await request(`/api/sessions/${id}/version`)) as { version: number };
          if (version !== seen) {
            seen = version;
            onSession((await request(`/api/sessions/${id}`)) as Session);
          }
          onLink(true);
        } catch (error) {
          if (error instanceof Locked) return onLocked();
          onLink(false);
        }
      }
      setTimeout(check, 1500);
    };
    void check();
    return () => (stopped = true);
  },
};
