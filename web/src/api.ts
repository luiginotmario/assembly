import type { Session } from '../../shared/types';

export type Info = { model: string; hasKey: boolean; lan: string[] };

async function post(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${response.status}`);
  return response.json();
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
    form.append('photo', file);
    form.append('question', question);
    const response = await fetch(`/api/sessions/${id}/photos`, { method: 'POST', body: form });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'upload failed');
  },
  /** the whole session now and after every change, from any device */
  follow: (id: string, onSession: (session: Session) => void, onLink: (up: boolean) => void) => {
    const source = new EventSource(`/api/sessions/${id}/events`);
    source.addEventListener('session', (event) => onSession(JSON.parse((event as MessageEvent).data)));
    source.onopen = () => onLink(true);
    source.onerror = () => onLink(false);
    return () => source.close();
  },
};
