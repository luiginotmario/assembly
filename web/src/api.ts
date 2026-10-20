import type { KeyInfo, Manual } from '../../shared/types';

export type Info = { ready: boolean; lan: string[] };

/** the server said this manual has no key to check photos with yet */
export class NeedsKey extends Error {}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as { error?: string; needsKey?: boolean };
  if (response.status === 409 && body.needsKey) throw new NeedsKey(body.error);
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body as T;
}

const post = <T>(url: string, body?: unknown) =>
  request<T>(url, {
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
  info: () => request<Info>('/api/info'),
  manual: (id: string) => request<Manual>(`/api/manuals/${id}`),
  step: (id: string, step: number) => post(`/api/manuals/${id}/step`, { step }),
  photo: async (id: string, file: File, step: number) => {
    const form = new FormData();
    form.append('photo', await shrink(file));
    form.append('step', String(step));
    await request(`/api/manuals/${id}/photos`, { method: 'POST', body: form });
  },
  savedKey: () => request<{ saved: KeyInfo | null }>('/api/saved-key'),
  useSavedKey: (id: string) => post<{ key: KeyInfo }>(`/api/manuals/${id}/key`, { saved: true }),
  pasteKey: (id: string, key: string) => post<{ key: KeyInfo }>(`/api/manuals/${id}/key`, { key }),
  forgetKey: (id: string) => request(`/api/manuals/${id}/key`, { method: 'DELETE' }),
  /**
   * the manual now and after every change, on every device: the page checks its version
   * every second and a half (only while it's on screen) and fetches it when it moves
   */
  follow: (id: string, onManual: (manual: Manual) => void, onLink: (up: boolean) => void, onMissing: (why: string) => void) => {
    let seen = -1;
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible' || seen < 0) {
        try {
          const { version } = await request<{ version: number }>(`/api/manuals/${id}/version`);
          if (version !== seen) {
            seen = version;
            onManual(await api.manual(id));
          }
          onLink(true);
        } catch (error) {
          if (seen < 0) return onMissing((error as Error).message);
          onLink(false);
        }
      }
      setTimeout(check, 1500);
    };
    void check();
    // coming back to the tab (from the openrouter sign-in, say) checks straight away
    const now = () => document.visibilityState === 'visible' && void refresh();
    const refresh = async () => {
      try {
        const { version } = await request<{ version: number }>(`/api/manuals/${id}/version`);
        if (version !== seen) {
          seen = version;
          onManual(await api.manual(id));
        }
      } catch {
        // the regular check will say so
      }
    };
    document.addEventListener('visibilitychange', now);
    addEventListener('message', (event) => event.origin === location.origin && event.data === 'assembly:connected' && void refresh());
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', now);
    };
  },
};
