// Every model call goes through OpenRouter, asking for JSON that matches a schema.

const BASE = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
export const MODEL = process.env.MODEL ?? 'anthropic/claude-sonnet-5.5';

export const hasKey = () => Boolean(process.env.OPENROUTER_API_KEY);

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type Content = string | Part[];

export const text = (value: string): Part => ({ type: 'text', text: value });
export const image = (jpeg: Buffer): Part => ({
  type: 'image_url',
  image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
});

export async function json<T>(call: { name: string; system: string; user: Content; schema: object }): Promise<T> {
  if (!hasKey()) throw new Error('Add OPENROUTER_API_KEY to the .env file to use the guide agent.');
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
      'x-title': 'hardware-guide',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: call.name, strict: true, schema: call.schema } },
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter said ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[]; error?: { message: string } };
  if (body.error) throw new Error(`OpenRouter: ${body.error.message}`);
  const content = body.choices?.[0]?.message?.content ?? '';
  // some models wrap json in a code fence even when asked not to
  const raw = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`The model didn't answer in the expected format: ${raw.slice(0, 200)}`);
  }
}
