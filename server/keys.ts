import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Provider } from '../shared/types.js';
import { DATA } from './manuals.js';

// The keys people check photos with. A key is sealed (AES-256-GCM) before it's stored, bound
// to the one manual it was connected to, and never sent back to a browser. The secret it's
// sealed with is KEY_SECRET on Vercel; on your own computer one is made once in data/.

let secret: Buffer | null = null;

function root() {
  if (secret) return secret;
  let value = process.env.KEY_SECRET?.trim();
  if (!value) {
    if (process.env.VERCEL) throw new Error('KEY_SECRET isn’t set on this deployment, so keys can’t be stored safely.');
    const file = path.join(DATA, 'secret');
    try {
      value = readFileSync(file, 'utf8').trim();
    } catch {
      value = randomBytes(32).toString('base64url');
      mkdirSync(DATA, { recursive: true });
      writeFileSync(file, value, { mode: 0o600 });
    }
  }
  secret = Buffer.from(value);
  return secret;
}

const derive = (purpose: string) => Buffer.from(hkdfSync('sha256', root(), 'assembly', purpose, 32));

/** base64url(iv · tag · ciphertext); `bound` ties it to one manual, so it can't be moved to another */
function sealWith(purpose: string, plain: string, bound: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(purpose), iv);
  cipher.setAAD(Buffer.from(bound));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

function openWith(purpose: string, sealed: string, bound: string) {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', derive(purpose), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(bound));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const seal = (key: string, manualId: string) => sealWith('manual-key:v1', key, manualId);
export const unseal = (sealed: string, manualId: string) => (sealed ? openWith('manual-key:v1', sealed, manualId) : null);

/** a short-lived cookie (the openrouter sign-in) or a browser's saved key, readable only here */
export const sealCookie = (value: unknown) => sealWith('cookie:v1', JSON.stringify(value), 'cookie');
export function openCookie<T>(raw: string | undefined): T | null {
  const plain = raw ? openWith('cookie:v1', raw, 'cookie') : null;
  try {
    return plain ? (JSON.parse(plain) as T) : null;
  } catch {
    return null;
  }
}

/** which service a pasted key is for */
export function providerOf(key: string): Provider | null {
  if (/^sk-or-[A-Za-z0-9_-]{20,}$/.test(key)) return 'openrouter';
  if (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return 'anthropic';
  if (/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return 'openai';
  return null;
}

/** a cheap call that only works with a live key */
export async function works(provider: Provider, key: string) {
  const check: Record<Provider, [string, Record<string, string>]> = {
    openrouter: ['https://openrouter.ai/api/v1/key', { authorization: `Bearer ${key}` }],
    anthropic: ['https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }],
    openai: ['https://api.openai.com/v1/models', { authorization: `Bearer ${key}` }],
  };
  const [url, headers] = check[provider];
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return response?.ok ?? false;
}

// ---------- signing in with openrouter (oauth with pkce) ----------

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** the code openrouter sends back, traded for a key of the person's own */
export async function exchange(code: string, verifier: string) {
  const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as { key?: string } | null;
  if (!response.ok || typeof body?.key !== 'string') throw new Error(`OpenRouter didn’t hand over a key (${response.status})`);
  return body.key;
}
