import Anthropic from '@anthropic-ai/sdk';
import type { Provider } from '../shared/types.js';

// The model that reads photos, through whichever key the manual was connected with:
// OpenRouter (signed in, or a pasted key), Anthropic or OpenAI. Every call asks for JSON
// that matches a schema.

export type ApiKey = { provider: Provider; key: string };

export const MODELS: Record<Provider, string> = {
  openrouter: process.env.MODEL ?? 'anthropic/claude-sonnet-5.5',
  anthropic: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
  openai: process.env.OPENAI_MODEL ?? 'gpt-5',
};

/** on your own computer, the key in .env works for every manual; never on the hosted site */
export function serverKey(): ApiKey | null {
  if (process.env.VERCEL) return null;
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key ? { provider: 'openrouter', key } : null;
}

type Block = { type: 'text'; text: string } | { type: 'image'; jpeg: Buffer };
export type Content = Block[];

export const text = (value: string): Block => ({ type: 'text', text: value });
export const image = (jpeg: Buffer): Block => ({ type: 'image', jpeg });

type Call = { name: string; system: string; user: string | Block[]; schema: object };

export async function json<T>(key: ApiKey, call: Call): Promise<T> {
  const blocks = typeof call.user === 'string' ? [text(call.user)] : call.user;
  const raw = key.provider === 'anthropic' ? await viaAnthropic(key.key, call, blocks) : await viaChat(key, call, blocks);
  // some models wrap json in a code fence or add a sentence around it
  const body = raw.replace(/^[\s\S]*?```(?:json)?\s*|\s*```[\s\S]*$/g, '');
  try {
    return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as T;
  } catch {
    throw new Error(`The model didn't answer in the expected format: ${body.slice(0, 200)}`);
  }
}

async function viaAnthropic(apiKey: string, call: Call, blocks: Block[]) {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: MODELS.anthropic,
    max_tokens: 16000,
    system: call.system,
    messages: [
      {
        role: 'user',
        content: blocks.map((b) =>
          b.type === 'text'
            ? { type: 'text' as const, text: b.text }
            : { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: b.jpeg.toString('base64') } },
        ),
      },
    ],
    output_config: { format: { type: 'json_schema', schema: call.schema as Record<string, unknown> } },
    // if a safety check declines (a photo of wiring shouldn't), the request reruns on another model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined to look at this photo.');
  return response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
}

/** openrouter and openai speak the same chat completions api */
async function viaChat(key: ApiKey, call: Call, blocks: Block[]) {
  const base = key.provider === 'openai' ? 'https://api.openai.com/v1' : (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key.key}`,
      'content-type': 'application/json',
      ...(key.provider === 'openrouter' ? { 'x-title': 'Assembly', 'http-referer': 'https://assemblyguide.vercel.app' } : {}),
    },
    body: JSON.stringify({
      model: MODELS[key.provider],
      messages: [
        { role: 'system', content: call.system },
        {
          role: 'user',
          content: blocks.map((b) =>
            b.type === 'text' ? b : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b.jpeg.toString('base64')}` } },
          ),
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: call.name, strict: true, schema: call.schema } },
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const name = key.provider === 'openai' ? 'OpenAI' : 'OpenRouter';
  if (!response.ok) throw new Error(`${name} said ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[]; error?: { message: string } };
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  return body.choices?.[0]?.message?.content ?? '';
}
