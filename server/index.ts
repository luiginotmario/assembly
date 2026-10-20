try {
  process.loadEnvFile();
} catch {
  // no .env: fine, the guide agent just stays off until there's a key
}

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import sharp from 'sharp';
import { example } from '../shared/example';
import type { Photo } from '../shared/types';
import { ask, buildGuide, readPhoto, say } from './agent';
import { MODEL, hasKey } from './llm';
import * as sessions from './sessions';

const PORT = Number(process.env.PORT ?? 8787);
const app = new Hono();

app.get('/api/info', (c) => c.json({ model: MODEL, hasKey: hasKey(), lan: lanAddresses() }));

app.post('/api/sessions', async (c) => c.json({ id: (await sessions.create()).id }));

app.get('/api/sessions/:id', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  return session ? c.json(session) : c.json({ error: 'no such session' }, 404);
});

// every open device listens here and gets the whole session whenever anything changes
app.get('/api/sessions/:id/events', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  return streamSSE(c, async (stream) => {
    let open = true;
    const send = (s: typeof session) => {
      if (open) void stream.writeSSE({ event: 'session', data: JSON.stringify(s) });
    };
    const stop = sessions.subscribe(session.id, send);
    stream.onAbort(() => {
      open = false;
      stop();
    });
    send(session);
    while (open) {
      await stream.sleep(20_000);
      if (open) await stream.writeSSE({ event: 'ping', data: '' });
    }
  });
});

// the plan: pasted on the page, or sent straight from a coding agent with curl
app.post('/api/sessions/:id/plan', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  const type = c.req.header('content-type') ?? '';
  const plan = type.includes('json') ? String(((await c.req.json()) as { plan?: string }).plan ?? '') : await c.req.text();
  if (!plan.trim()) return c.json({ error: 'the plan is empty' }, 400);
  session.plan = plan.trim();
  void buildGuide(session);
  return c.json({ ok: true, url: `/s/${session.id}` }, 202);
});

app.post('/api/sessions/:id/example', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  session.plan = 'Example: the radar sensors build.';
  session.guide = structuredClone(example);
  session.step = 0;
  session.buildError = '';
  sessions.changed(session);
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/step', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  const { step } = (await c.req.json()) as { step: number };
  const last = (session.guide?.steps.length ?? 1) - 1;
  session.step = Math.max(0, Math.min(last, Math.round(Number(step) || 0)));
  sessions.changed(session);
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/ask', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  const { text } = (await c.req.json()) as { text: string };
  if (!text?.trim()) return c.json({ error: 'empty question' }, 400);
  say(session, text.trim(), null, null, 'you');
  void ask(session, text.trim(), null);
  return c.json({ ok: true }, 202);
});

// a photo, optionally with a question about it
app.post('/api/sessions/:id/photos', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  const body = await c.req.parseBody();
  const file = body.photo;
  if (!(file instanceof File)) return c.json({ error: 'no photo' }, 400);
  const question = typeof body.question === 'string' ? body.question.trim() : '';

  const photo: Photo = {
    id: sessions.id(8),
    file: '',
    createdAt: Date.now(),
    status: 'analyzing',
    crops: [],
    analysis: null,
    error: '',
  };
  photo.file = `${photo.id}.jpg`;
  try {
    // turn it the right way up (phones store rotation separately) and keep it full size for zooming
    const jpeg = await sharp(Buffer.from(await file.arrayBuffer())).rotate().jpeg({ quality: 90 }).toBuffer();
    await writeFile(path.join(sessions.folder(session.id), photo.file), jpeg);
  } catch {
    return c.json({ error: "couldn't read that image" }, 400);
  }
  session.photos.push(photo);
  say(session, question || 'Here’s a photo.', photo.id, null, 'you');
  void readPhoto(session, photo, question).then(() => {
    if (question && photo.status === 'done') return ask(session, question, photo);
  });
  return c.json({ ok: true, photo: photo.id }, 202);
});

app.get('/files/:id/:name', async (c) => {
  const { id, name } = c.req.param();
  if (!/^[A-Za-z0-9]{8,32}$/.test(id) || !/^[A-Za-z0-9-]+\.jpg$/.test(name)) return c.notFound();
  try {
    const data = await readFile(path.join(sessions.folder(id), name));
    return c.body(data, 200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000, immutable' });
  } catch {
    return c.notFound();
  }
});

// the built site (pnpm build); during development vite serves it instead
app.use('/assets/*', serveStatic({ root: './web/dist' }));
app.get('*', serveStatic({ root: './web/dist', path: 'index.html' }));

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
}

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`hardware-guide is up on http://localhost:${PORT}`);
  for (const address of lanAddresses()) console.log(`  on your phone (same wifi): http://${address}:${PORT}`);
  if (!hasKey()) console.log('  no OPENROUTER_API_KEY yet: the example works, the guide agent is off');
});
