import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { networkInterfaces } from 'node:os';
import sharp from 'sharp';
import type { KeyInfo, Photo, Provider } from '../shared/types.js';
import { exchange, openCookie, pkce, providerOf, seal, sealCookie, unseal, works } from './keys.js';
import { serverKey, type ApiKey } from './llm.js';
import * as manuals from './manuals.js';
import { createManual, describeManual, mcp, originOf, updateManual } from './mcp.js';
import { readPhoto } from './photos.js';

// The api, the same locally (server/index.ts) and on Vercel (api/[...route].ts).

export const app = new Hono();

/** long work (reading a photo) carries on after the response; on Vercel the function is kept
 * alive until it's done and everything it changed is stored */
function background(work: () => Promise<unknown>) {
  const job = work()
    .catch((error) => console.error(error))
    .then(() => manuals.flush());
  if (process.env.VERCEL) {
    void import('@vercel/functions').then(({ waitUntil }) => waitUntil(job));
  }
}

app.get('/api/info', (c) => c.json({ ready: manuals.ready, lan: manuals.cloud ? [] : lanAddresses() }));

// ---------- for agents ----------

app.post('/mcp', mcp);
app.post('/api/mcp', mcp);
// no server-sent stream and no sessions to end: every reply comes back on the POST
app.on(['GET', 'DELETE'], ['/mcp', '/api/mcp'], (c) => c.body(null, 405, { allow: 'POST' }));

app.use('/api/manuals/*', async (c, next) => (manuals.ready ? next() : c.json({ error: manuals.NOT_READY }, 503)));
app.use('/api/manuals', async (c, next) => (manuals.ready ? next() : c.json({ error: manuals.NOT_READY }, 503)));

const bearer = (c: Context) => c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';

// the same as the tools, for agents that can run curl but don't speak mcp
app.post('/api/manuals', async (c) => {
  const draft = await c.req.json().catch(() => null);
  if (!draft) return c.json({ error: 'send the manual as JSON' }, 400);
  const result = await createManual(draft, originOf(c));
  return result.ok ? c.json(result.data, 201) : c.json({ error: result.text }, result.status as 422);
});

app.put('/api/manuals/:id', async (c) => {
  const draft = await c.req.json().catch(() => null);
  if (!draft) return c.json({ error: 'send the manual as JSON' }, 400);
  const result = await updateManual(c.req.param('id'), bearer(c), draft);
  return result.ok ? c.json(result.data) : c.json({ error: result.text }, result.status as 422);
});

app.get('/api/manuals/:id/checks', async (c) => {
  const result = await describeManual(c.req.param('id'), originOf(c));
  return result.ok ? c.json(result.data) : c.json({ error: result.text }, result.status as 404);
});

// ---------- for the page ----------

app.get('/api/manuals/:id', async (c) => {
  const manual = await manuals.get(c.req.param('id'));
  return manual ? c.json(manuals.shown(manual)) : c.json({ error: 'There’s no manual at this link. It may have expired.' }, 404);
});

// open pages check this every second or two, and fetch the manual when it moves
app.get('/api/manuals/:id/version', async (c) => c.json({ version: await manuals.version(c.req.param('id')) }));

app.post('/api/manuals/:id/step', async (c) => {
  const manual = await manuals.get(c.req.param('id'));
  if (!manual) return c.json({ error: 'no such manual' }, 404);
  const { step } = (await c.req.json().catch(() => ({}))) as { step?: number };
  manual.step = Math.max(0, Math.min(manual.guide.steps.length - 1, Math.round(Number(step) || 0)));
  manuals.changed(manual);
  await manuals.flush();
  return c.json({ ok: true });
});

/** the key a manual's photos are checked with */
function keyFor(manual: manuals.Stored): ApiKey | null {
  const key = manual.key && unseal(manual.sealed, manual.id);
  return key && manual.key ? { provider: manual.key.provider, key } : serverKey();
}

app.post('/api/manuals/:id/photos', async (c) => {
  const manual = await manuals.get(c.req.param('id'));
  if (!manual) return c.json({ error: 'no such manual' }, 404);
  const key = keyFor(manual);
  if (!key) return c.json({ error: 'Connect a key to check photos.', needsKey: true }, 409);
  if (manual.photos.filter((p) => p.status === 'reading').length >= 3) return c.json({ error: 'A few photos are still being read. Give it a moment.' }, 429);
  if (manual.photos.length >= 200) return c.json({ error: 'This manual has had a lot of photos checked already.' }, 429);

  const body = await c.req.parseBody();
  const file = body.photo;
  if (!(file instanceof File)) return c.json({ error: 'no photo' }, 400);
  const asked = Number(body.step);
  const photo: Photo = {
    id: manuals.id(8),
    file: '',
    createdAt: Date.now(),
    step: Number.isInteger(asked) && asked >= 0 && asked < manual.guide.steps.length ? asked : manual.step,
    status: 'reading',
    crops: [],
    analysis: null,
    captured: [],
    error: '',
  };
  try {
    // turn it the right way up (phones store rotation separately) and keep it full size for zooming
    const jpeg = await sharp(Buffer.from(await file.arrayBuffer())).rotate().jpeg({ quality: 90 }).toBuffer();
    photo.file = await manuals.putFile(manual.id, `${photo.id}.jpg`, jpeg);
  } catch {
    return c.json({ error: 'That doesn’t look like a photo.' }, 400);
  }
  manual.photos.push(photo);
  manuals.changed(manual);
  background(() => readPhoto(manual, photo, key));
  return c.json({ ok: true, photo: photo.id }, 202);
});

// ---------- keys ----------

const SAVED = 'assembly_key';
type Saved = KeyInfo & { key: string };

/** this browser remembers a key it connected (sealed; it can't read it), to reuse on its next manual */
function remember(c: Context, saved: Saved) {
  setCookie(c, SAVED, sealCookie(saved), {
    path: '/api',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 90,
  });
}

async function connect(manual: manuals.Stored, provider: Provider, key: string) {
  const info: KeyInfo = { provider, last4: key.slice(-4), connectedAt: Date.now() };
  manual.key = info;
  manual.sealed = seal(key, manual.id);
  manuals.changed(manual);
  await manuals.flush();
  return info;
}

app.get('/api/saved-key', (c) => {
  const saved = openCookie<Saved>(getCookie(c, SAVED));
  return c.json({ saved: saved ? { provider: saved.provider, last4: saved.last4, connectedAt: saved.connectedAt } : null });
});

/** a pasted key, or the one this browser connected before */
app.post('/api/manuals/:id/key', async (c) => {
  const manual = await manuals.get(c.req.param('id'));
  if (!manual) return c.json({ error: 'no such manual' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; saved?: boolean };
  if (body.saved) {
    const saved = openCookie<Saved>(getCookie(c, SAVED));
    if (!saved) return c.json({ error: 'This browser has no saved key any more.' }, 400);
    return c.json({ key: await connect(manual, saved.provider, saved.key) });
  }
  const key = String(body.key ?? '').trim();
  const provider = providerOf(key);
  if (!provider) return c.json({ error: 'That doesn’t look like an OpenRouter (sk-or-…), Anthropic (sk-ant-…) or OpenAI (sk-…) key.' }, 400);
  if (!(await works(provider, key))) return c.json({ error: 'That key didn’t work. Check it’s active and copied whole.' }, 400);
  const info = await connect(manual, provider, key);
  remember(c, { ...info, key });
  return c.json({ key: info });
});

app.delete('/api/manuals/:id/key', async (c) => {
  const manual = await manuals.get(c.req.param('id'));
  if (!manual) return c.json({ error: 'no such manual' }, 404);
  manual.key = null;
  manual.sealed = '';
  manuals.changed(manual);
  await manuals.flush();
  deleteCookie(c, SAVED, { path: '/api' });
  return c.json({ ok: true });
});

// signing in with openrouter: their key, made for this, without copying anything
const SIGN_IN = 'assembly_signin';
type SignIn = { verifier: string; state: string; manual: string; at: number };

app.get('/api/connect/openrouter', async (c) => {
  const manualId = c.req.query('manual') ?? '';
  if (!manuals.valid(manualId)) return c.text('no such manual', 404);
  const { verifier, challenge } = pkce();
  const state = manuals.id(24);
  setCookie(c, SIGN_IN, sealCookie({ verifier, state, manual: manualId, at: Date.now() } satisfies SignIn), {
    path: '/api/connect',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: 15 * 60,
  });
  const auth = new URL('https://openrouter.ai/auth');
  auth.searchParams.set('callback_url', `${originOf(c)}/api/connect/openrouter/callback`);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);
  return c.redirect(auth.toString());
});

app.get('/api/connect/openrouter/callback', async (c) => {
  const signIn = openCookie<SignIn>(getCookie(c, SIGN_IN));
  deleteCookie(c, SIGN_IN, { path: '/api/connect' });
  const back = signIn ? `/m/${signIn.manual}` : '/';
  const code = c.req.query('code');
  if (!signIn || Date.now() - signIn.at > 15 * 60_000) return c.html(closing(back, 'That took too long. Try connecting again.'));
  if (!code) return c.html(closing(back, 'Not connected.'));
  if (c.req.query('state') !== signIn.state) return c.html(closing(back, 'That sign-in didn’t start here. Try again.'));
  const manual = await manuals.get(signIn.manual);
  if (!manual) return c.html(closing('/', 'That manual is gone.'));
  try {
    const key = await exchange(code, signIn.verifier);
    const info = await connect(manual, 'openrouter', key);
    remember(c, { ...info, key });
    return c.html(closing(back, ''));
  } catch (error) {
    return c.html(closing(back, (error as Error).message));
  }
});

/** the sign-in window closes itself (the manual sees the key arrive); opened in the same tab, it goes back */
function closing(back: string, problem: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${problem ? 'Not connected' : 'Connected'}</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100svh;background:#f5f5f7;color:#1d1d1f;font:15px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}a{color:#0071e3}</style></head>
<body><p>${problem ? `${problem.replace(/[<>&]/g, '')}<br><a href="${back}">Back to the manual</a>` : 'Connected. Taking you back…'}</p>
<script>${problem ? '' : `if (window.opener) { window.opener.postMessage('assembly:connected', location.origin); window.close(); } setTimeout(() => location.replace(${JSON.stringify(back)}), 400);`}</script></body></html>`;
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
}
