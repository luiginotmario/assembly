import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { networkInterfaces } from 'node:os';
import sharp from 'sharp';
import { example } from '../shared/example.js';
import type { Photo } from '../shared/types.js';
import { ask, buildGuide, readPhoto, say } from './agent.js';
import { MODEL, hasKey } from './llm.js';
import * as sessions from './sessions.js';

// The api, the same locally (server/index.ts) and on Vercel (api/[...route].ts).

export const app = new Hono();
const CODE = process.env.ACCESS_CODE ?? '';

/** long work (drawing a guide, reading a photo) carries on after the response; on Vercel the
 * function is kept alive until it's done and everything it changed is stored */
function background(work: () => Promise<unknown>) {
  const job = work()
    .catch((error) => console.error(error))
    .then(() => sessions.flush());
  if (process.env.VERCEL) {
    void import('@vercel/functions').then(({ waitUntil }) => waitUntil(job));
  }
}

app.get('/api/info', (c) =>
  c.json({ model: MODEL, hasKey: hasKey(), lan: sessions.cloud ? [] : lanAddresses(), locked: Boolean(CODE) }),
);

// with an access code set, only people who have it can use the api (and spend the key)
app.use('/api/*', async (c, next) => {
  if (!CODE || c.req.path === '/api/info') return next();
  const given = c.req.header('x-access-code') ?? c.req.query('code') ?? getCookie(c, 'access_code');
  if (given !== CODE) return c.json({ error: 'This needs the access code.', locked: true }, 401);
  return next();
});

// on vercel, sessions need the redis database; say so plainly instead of failing oddly
app.use('/api/sessions/*', async (c, next) => {
  if (process.env.VERCEL && !sessions.cloud) {
    return c.json({ error: 'Session storage isn’t set up yet: link an Upstash Redis database to this Vercel project.' }, 503);
  }
  return next();
});
app.use('/api/sessions', async (c, next) => {
  if (process.env.VERCEL && !sessions.cloud) {
    return c.json({ error: 'Session storage isn’t set up yet: link an Upstash Redis database to this Vercel project.' }, 503);
  }
  return next();
});

app.post('/api/sessions', async (c) => c.json({ id: (await sessions.create()).id }));

app.get('/api/sessions/:id', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  return session ? c.json(session) : c.json({ error: 'no such session' }, 404);
});

// open pages check this every second or two, and fetch the session when it moves
app.get('/api/sessions/:id/version', async (c) => c.json({ version: await sessions.version(c.req.param('id')) }));

// the plan: pasted on the page, or sent straight from a coding agent with curl
app.post('/api/sessions/:id/plan', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  const type = c.req.header('content-type') ?? '';
  const plan = type.includes('json') ? String(((await c.req.json()) as { plan?: string }).plan ?? '') : await c.req.text();
  if (!plan.trim()) return c.json({ error: 'the plan is empty' }, 400);
  session.plan = plan.trim();
  sessions.changed(session);
  background(() => buildGuide(session));
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
  await sessions.flush();
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/step', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  const { step } = (await c.req.json()) as { step: number };
  const last = (session.guide?.steps.length ?? 1) - 1;
  session.step = Math.max(0, Math.min(last, Math.round(Number(step) || 0)));
  sessions.changed(session);
  await sessions.flush();
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/ask', async (c) => {
  const session = await sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  const { text } = (await c.req.json()) as { text: string };
  if (!text?.trim()) return c.json({ error: 'empty question' }, 400);
  say(session, text.trim(), null, null, 'you');
  background(() => ask(session, text.trim(), null));
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

  const photo: Photo = { id: sessions.id(8), file: '', createdAt: Date.now(), status: 'analyzing', crops: [], analysis: null, error: '' };
  try {
    // turn it the right way up (phones store rotation separately) and keep it full size for zooming
    const jpeg = await sharp(Buffer.from(await file.arrayBuffer())).rotate().jpeg({ quality: 90 }).toBuffer();
    photo.file = await sessions.putFile(session.id, `${photo.id}.jpg`, jpeg);
  } catch {
    return c.json({ error: "couldn't read that image" }, 400);
  }
  session.photos.push(photo);
  say(session, question || 'Here’s a photo.', photo.id, null, 'you');
  background(async () => {
    await readPhoto(session, photo, question);
    if (question && photo.status === 'done') await ask(session, question, photo);
  });
  return c.json({ ok: true, photo: photo.id }, 202);
});

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
}
