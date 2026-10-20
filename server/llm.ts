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

type Call = { name: string; system: string; user: Content; schema: object };

export async function json<T>(call: Call): Promise<T> {
  return (await ask<T>(call, false)).value;
}

/** the same, with live web search switched on; returns the pages it found too */
export async function searched<T>(call: Call) {
  try {
    return await ask<T>(call, true);
  } catch (error) {
    // not every model takes search and a strict format together: ask for plain json instead
    if (!String(error).includes('OpenRouter said 4')) throw error;
    return ask<T>({ ...call, system: `${call.system}\n\nAnswer with only a JSON object matching this schema, nothing else:\n${JSON.stringify(call.schema)}` }, true, false);
  }
}

async function ask<T>(call: Call, web: boolean, strict = true): Promise<{ value: T; sources: { url: string; title: string }[] }> {
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
      ...(strict ? { response_format: { type: 'json_schema', json_schema: { name: call.name, strict: true, schema: call.schema } } } : {}),
      ...(web ? { plugins: [{ id: 'web', max_results: 8 }] } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter said ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  type Annotation = { type: string; url_citation?: { url: string; title?: string } };
  const body = (await response.json()) as {
    choices?: { message?: { content?: string; annotations?: Annotation[] } }[];
    error?: { message: string };
  };
  if (body.error) throw new Error(`OpenRouter: ${body.error.message}`);
  const message = body.choices?.[0]?.message;
  const content = message?.content ?? '';
  // some models wrap json in a code fence or add a sentence around it
  const raw = content.replace(/^[\s\S]*?```(?:json)?\s*|\s*```[\s\S]*$/g, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const sources = (message?.annotations ?? [])
    .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
    .map((a) => ({ url: a.url_citation!.url, title: a.url_citation!.title ?? a.url_citation!.url }));
  try {
    return { value: JSON.parse(raw.slice(start, end + 1)) as T, sources };
  } catch {
    throw new Error(`The model didn't answer in the expected format: ${raw.slice(0, 200)}`);
  }
}
