import type { Context } from 'hono';
import { check, keepPhotos, type Draft } from '../shared/manual.js';
import { library } from '../shared/library.js';
import * as manuals from './manuals.js';

// What coding agents use to make manuals: a remote MCP server (streamable HTTP, stateless,
// plain JSON replies) at /mcp, and the same three things as a plain HTTP api for agents
// without MCP. The agent already knows the parts and the build, so it writes the manual;
// this checks it, stores it and hands back the link.

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const verifiedParts = library.map((k) => k.part.model).join(', ');

const INSTRUCTIONS = `Assembly turns a hardware build into a step-by-step 3D assembly manual the user follows on their computer or phone. When the user is about to physically wire or assemble hardware (boards, sensors, adapters, cables), make them a manual with create_manual and give them the link. Look every part up on the web first; never fill in sizes or pinouts from memory.`;

// ---------- the manual format, as the agent sees it ----------

const side = {
  type: 'string',
  enum: ['top', 'bottom', 'left', 'right'],
  description: 'Board edge, looking down at the board with its printed labels readable: top = far edge, bottom = near edge.',
};

const manualSchema = {
  type: 'object',
  required: ['title', 'parts', 'steps'],
  properties: {
    title: { type: 'string', description: 'What is being built, a few words. E.g. "Radar sensors to a Mac".' },
    summary: { type: 'string', description: 'One sentence about the build.' },
    parts: {
      type: 'array',
      description: 'Every physical item that gets wired or assembled, once each. Two identical boards are two parts. Not jumper wires or tools.',
      items: {
        type: 'object',
        required: ['id', 'name', 'size', 'pins'],
        properties: {
          id: { type: 'string', description: 'Short lowercase id used in steps, e.g. "ld2450", "usb1".' },
          name: { type: 'string', description: 'Everyday name, e.g. "USB adapter 1".' },
          model: { type: 'string', description: 'Exact model as printed or sold, e.g. "HLK-LD2450", "CP2102 USB to TTL".' },
          kind: { type: 'string', enum: ['board', 'adapter', 'sensor', 'cable', 'computer', 'other'] },
          size: {
            type: 'object',
            required: ['w', 'h'],
            description: 'The board in mm, lying flat with its labels readable: w across, h front to back, t thickness (default 1.6).',
            properties: { w: { type: 'number' }, h: { type: 'number' }, t: { type: 'number' } },
          },
          color: { type: 'string', description: 'The board colour as hex, e.g. "#1f5fbf".' },
          pitch: { type: 'number', description: 'Spacing between neighbouring pins in mm (default 2.54).' },
          pins: {
            type: 'array',
            description: 'Only pins a person connects to, in the order they physically sit along each edge.',
            items: {
              type: 'object',
              required: ['id', 'side'],
              properties: {
                id: { type: 'string', description: 'Used in connections; usually the printed label, e.g. "TXD", "GND", "J2-14".' },
                label: { type: 'string', description: 'Exactly as printed on the board, if different from id.' },
                side,
                index: { type: 'integer', description: 'Position along its edge: top/bottom count left to right, left/right count far to near. Defaults to the order given.' },
                style: { type: 'string', enum: ['header', 'socket', 'pad'], description: 'header = metal pin (default), socket = contacts in a small plug housing, pad = flat solder pad.' },
              },
            },
          },
          features: {
            type: 'array',
            description: 'USB plugs, sockets, the main chip, antennas: drawn so the board is recognisable.',
            items: {
              type: 'object',
              required: ['kind', 'side'],
              properties: {
                kind: { type: 'string', enum: ['usb-a', 'usb-c', 'socket', 'chip', 'antenna'] },
                side,
                at: { type: 'number', description: '0..1 along that edge.' },
                label: { type: 'string' },
              },
            },
          },
          sources: {
            type: 'array',
            description: 'The pages the size and pinout came from (datasheet, maker or seller page).',
            items: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, title: { type: 'string' } } },
          },
          estimated: { type: 'boolean', description: 'true if the size or pins are a guess; it is drawn with a dashed outline.' },
          note: { type: 'string', description: 'Anything to know about this part, e.g. "labels are on the back".' },
        },
      },
    },
    steps: {
      type: 'array',
      description: 'One physical action per step (plug one cable, or the wires between one pair of parts), in a safe order.',
      items: {
        type: 'object',
        required: ['title', 'instruction'],
        properties: {
          title: { type: 'string', description: 'A few words, e.g. "Power the LD2450".' },
          instruction: { type: 'string', description: 'One or two plain sentences for someone who has never wired electronics. Say wire colours when known.' },
          connections: {
            type: 'array',
            description: 'Wires made in this step, pin to pin.',
            items: {
              type: 'object',
              required: ['from', 'to'],
              properties: {
                from: { type: 'object', required: ['part', 'pin'], properties: { part: { type: 'string' }, pin: { type: 'string' } } },
                to: { type: 'object', required: ['part', 'pin'], properties: { part: { type: 'string' }, pin: { type: 'string' } } },
                wire: { type: 'string', description: 'The real wire colour if known, e.g. "black".' },
                note: { type: 'string' },
              },
            },
          },
          show: { type: 'array', items: { type: 'string' }, description: 'Part ids that appear from this step on (parts in connections appear anyway).' },
          focus: { type: 'array', items: { type: 'string' }, description: 'Part ids, or "partid.pinid", to draw the eye to.' },
          caution: { type: 'string', description: 'Anything that can damage a part: power, polarity, 5V vs 3.3V, pins to leave empty.' },
          check: { type: 'string', description: 'What to verify before moving on. Before anything is powered for the first time: photograph the wiring with the check button on the page.' },
        },
      },
    },
  },
};

const tools = [
  {
    name: 'create_manual',
    title: 'Make an assembly manual',
    description: `Make a step-by-step 3D assembly manual for hardware the user is physically putting together, and get its link. The drawing shows every part with its real pins and draws each step's wires in.

Before calling, look every part up on the web (datasheet, maker or seller page) for its board size in mm and its pinout with labels exactly as printed. Never fill in sizes or pin orders from memory: put the pages in sources, or set estimated: true where you had to guess. What the user confirmed on their real hardware (photos, labels, tests) beats datasheets.

Verified parts, drawn from measurements of real boards whenever the model matches: ${verifiedParts}.

Returns the link (give it to the user), the manual's id, and an edit token for update_manual. On the page the user can photograph a part or their wiring to check it against the step; the first check asks them to connect OpenRouter or paste an API key.`,
    inputSchema: manualSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_manual',
    title: 'Change a manual',
    description:
      'Replace the guide of a manual you made: same link, and pages that have it open update by themselves. Pass the id and edit_token from create_manual and the whole manual again. Photos the user took of their boards stay on the drawing.',
    inputSchema: {
      ...manualSchema,
      required: ['id', 'edit_token', ...manualSchema.required],
      properties: { id: { type: 'string' }, edit_token: { type: 'string' }, ...manualSchema.properties },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_manual',
    title: 'Read a manual and its photo checks',
    description:
      "Read a manual, the step the user is on, and their photo checks: what each photo showed, the labels read off the boards, and whether it matched the step. Use it when the user mentions a photo they took or asks about a step.",
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'The id from create_manual, or the last part of the link.' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ---------- what the tools do (also the plain HTTP api) ----------

type Result = { ok: true; text: string; data: Record<string, unknown> } | { ok: false; text: string; status: number };

const link = (origin: string, id: string) => `${origin}/m/${id}`;

const warned = (warnings: string[]) => (warnings.length ? `\n\nWorth fixing (update_manual):\n${warnings.map((w) => `- ${w}`).join('\n')}` : '');

export async function createManual(draft: Draft, origin: string): Promise<Result> {
  const { guide, errors, warnings } = check(draft);
  if (errors.length) return { ok: false, status: 422, text: `The manual wasn't made. Fix these and try again:\n${errors.map((e) => `- ${e}`).join('\n')}` };
  const { manual, token } = await manuals.create(guide);
  const url = link(origin, manual.id);
  return {
    ok: true,
    data: { id: manual.id, url, edit_token: token, warnings },
    text:
      `Manual ready: ${url}\n` +
      `Give the user this link. It opens on a computer or a phone (the page has a QR code), and every device stays on the same step.\n\n` +
      `id: ${manual.id}\nedit_token: ${token} (keep it to change this manual with update_manual)` +
      warned(warnings),
  };
}

export async function updateManual(id: string, token: string, draft: Draft): Promise<Result> {
  const manual = await manuals.get(id);
  if (!manual) return { ok: false, status: 404, text: `No manual "${id}".` };
  if (!token || !manuals.mayEdit(manual, token)) return { ok: false, status: 403, text: 'That edit token is not the one this manual was made with.' };
  const { guide, errors, warnings } = check(draft);
  if (errors.length) return { ok: false, status: 422, text: `The manual wasn't changed. Fix these and try again:\n${errors.map((e) => `- ${e}`).join('\n')}` };
  keepPhotos(guide, manual.guide);
  manual.guide = guide;
  manual.updatedAt = Date.now();
  manual.step = Math.min(manual.step, guide.steps.length - 1);
  manuals.changed(manual);
  await manuals.flush();
  return { ok: true, data: { id, warnings }, text: `Updated. Open pages show the new version now.${warned(warnings)}` };
}

export async function describeManual(id: string, origin: string): Promise<Result> {
  const manual = await manuals.get(id.replace(/^.*\/m\//, '').replace(/[/?#].*$/, ''));
  if (!manual) return { ok: false, status: 404, text: `No manual "${id}".` };
  const checks = manual.photos.map((p) => ({
    taken: new Date(p.createdAt).toISOString(),
    step: p.step,
    status: p.status,
    verdict: p.analysis?.verdict ?? null,
    explanation: p.analysis?.explanation ?? p.error,
    seen: p.analysis?.seen ?? '',
    labels: p.analysis?.labels ?? [],
    retake: p.status === 'retake' ? p.analysis?.retake : undefined,
    now_on_the_drawing: p.captured,
    photo: p.file.startsWith('/') ? `${origin}${p.file}` : p.file,
  }));
  const data = { url: link(origin, manual.id), step: manual.step, guide: manual.guide, photo_checks: checks };
  return { ok: true, data, text: JSON.stringify(data, null, 1) };
}

// ---------- json-rpc over http ----------

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const reply = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const failure = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function call(name: string, args: Record<string, unknown>, origin: string): Promise<Result> {
  if (!manuals.ready) return { ok: false, status: 503, text: manuals.NOT_READY };
  if (name === 'create_manual') return createManual(args, origin);
  if (name === 'update_manual') return updateManual(String(args.id ?? ''), String(args.edit_token ?? ''), args);
  if (name === 'get_manual') return describeManual(String(args.id ?? ''), origin);
  return { ok: false, status: 404, text: `No tool "${name}".` };
}

async function handle(message: Rpc, origin: string) {
  // notifications (no id) get no reply
  if (message.id === undefined || message.id === null) return null;
  const { id, method, params = {} } = message;
  switch (method) {
    case 'initialize': {
      const asked = String(params.protocolVersion ?? '');
      return reply(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'assembly', title: 'Assembly', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools });
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await call(name, args, origin);
        return reply(id, {
          content: [{ type: 'text', text: result.text }],
          ...(result.ok ? { structuredContent: result.data } : { isError: true }),
        });
      } catch (error) {
        console.error(error);
        return reply(id, { content: [{ type: 'text', text: `Something went wrong: ${(error as Error).message}` }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

export const originOf = (c: Context) => process.env.PUBLIC_URL?.replace(/\/$/, '') ?? new URL(c.req.url).origin;

export async function mcp(c: Context) {
  if (Number(c.req.header('content-length') ?? 0) > 2_000_000) return c.json(failure(null, -32600, 'Request too large'), 413);
  let body: Rpc | Rpc[];
  try {
    body = await c.req.json();
  } catch {
    return c.json(failure(null, -32700, 'Parse error'), 400);
  }
  const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => handle(m, originOf(c))))).filter(Boolean);
  if (!replies.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? replies : replies[0]);
}
