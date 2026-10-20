import type { Context } from 'hono';
import sharp from 'sharp';
import { check, keepPhotos, type Draft } from '../shared/manual.js';
import type { Connection, End, Guide } from '../shared/types.js';
import { library } from '../shared/library.js';
import { readCad, type CadPart } from './cad.js';
import * as manuals from './manuals.js';

// What coding agents use to make manuals: a remote MCP server (streamable HTTP, stateless,
// plain JSON replies) at /mcp, and the same three things as a plain HTTP api for agents
// without MCP. The agent already knows the parts and the build, so it writes the manual;
// this checks it, stores it and hands back the link.

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const verifiedParts = library.map((k) => k.part.model).join(', ');

const INSTRUCTIONS = `Assembly turns any hardware build into a step-by-step 3D assembly manual, like the one in a LEGO box: electronics, wiring, 3D-printed parts, robots, enclosures, anything. When the user is about to physically wire or assemble hardware, make them a manual with create_manual and give them the link.
The drawing should look like what's on their desk, so the less they have to translate, the fewer mistakes: use the project's real design files where they exist (read_cad on a URDF, or STL/OBJ/GLB/3MF files per part), and look every part up on the web; never fill in sizes or pinouts from memory.
When the user says they took a photo on the manual page, or asks if something is right, use get_manual to find it, get_photo to look at it, and answer_photo to answer: the page then shows your answer and highlights the part and pins you mean.`;

/** what the agent passes on to the user with the link */
const PHOTO_TIP = `Tell the user about photo checks, in your own words: if they get stuck, they can take a photo of the part or their wiring on the page ("Check with a photo"). It's optional. If they connect a key there (sign in with OpenRouter, or paste an OpenRouter, Anthropic or OpenAI key), the page answers by itself: it reads the labels, says which part it is and highlights exactly which pins and wires that step means. Without a key, the photo is saved and they can just tell you "check my photo".`;

// ---------- the manual format, as the agent sees it ----------

const side = {
  type: 'string',
  enum: ['top', 'bottom', 'left', 'right'],
  description: 'Board edge, looking down at the board with its printed labels readable: top = far edge, bottom = near edge.',
};

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const end = {
  type: 'object',
  required: ['part'],
  properties: {
    part: { type: 'string' },
    pin: {
      type: 'string',
      description:
        'A pin id or printed label. A socket pin gets a multi-pin plug housing, a header pin a jumper end. Leave empty for the part itself: a motor\'s cable, an adapter\'s USB end going into a computer.',
    },
  },
};

const manualSchema = {
  type: 'object',
  required: ['title', 'steps'],
  properties: {
    title: { type: 'string', description: 'What is being built, a few words. E.g. "SO-101 follower arm", "Radar sensors to a Mac".' },
    summary: { type: 'string', description: 'One sentence about the build.' },
    cad: {
      type: 'array',
      description:
        "The project's own design files, read into parts with their real 3D shapes and positions (see read_cad): a URDF (robots), or single STL/OBJ/GLB/3MF files. Public raw links, e.g. raw.githubusercontent.com. Use only to keep some of the pieces.",
      items: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' }, only: { type: 'array', items: { type: 'string' }, description: 'Part ids to keep from this file.' } },
      },
    },
    parts: {
      type: 'array',
      description:
        'Every physical item: boards, modules, motors, printed parts, cases, batteries, the computer or power supply things plug into (kind "computer", with its ports as socket pins on its sides). Two identical items are two parts. Not jumper wires or cables between pins (those are connections), screws (steps.fasteners) or tools. Pieces from cad come in by themselves; list one here only to name it better, add a note or sources.',
      items: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string', description: 'Short lowercase id used in steps, e.g. "ld2450", "usb1", "servo-shoulder".' },
          name: { type: 'string', description: 'Everyday name, e.g. "USB adapter 1", "Shoulder servo".' },
          model: { type: 'string', description: 'Exact model as printed or sold, e.g. "HLK-LD2450", "Feetech STS3215".' },
          kind: { type: 'string', enum: ['board', 'adapter', 'sensor', 'cable', 'computer', 'other'] },
          mesh: {
            type: 'object',
            required: ['url'],
            description:
              "The part's real 3D model (STL, OBJ, GLB/GLTF, 3MF): the project's files, the maker's CAD download, or a model of the exact board. Drawn instead of a generated box, so use one whenever it exists.",
            properties: { url: { type: 'string' }, units: { type: 'string', enum: ['mm', 'cm', 'm', 'in'], description: 'Default mm.' } },
          },
          pose: {
            type: 'object',
            required: ['at'],
            description:
              'Where it sits in the finished build, like in CAD: mm, z up, x to the right, y away from the viewer; turn = degrees about x, then y, then z. Parts without a pose lie on the table beside the build (fine for boards that are only wired).',
            properties: { at: vec3, turn: vec3 },
          },
          color: { type: 'string', description: 'Its real colour as hex, e.g. "#1f5fbf" for a blue board, or the filament colour.' },
          finish: { type: 'string', enum: ['matte', 'gloss', 'metal'] },
          size: {
            type: 'object',
            description: 'Without a mesh: the board in mm, lying flat with its labels readable: w across, h front to back, t thickness (default 1.6).',
            properties: { w: { type: 'number' }, h: { type: 'number' }, t: { type: 'number' } },
          },
          pitch: { type: 'number', description: 'Spacing between neighbouring pins in mm (default 2.54).' },
          pins: {
            type: 'array',
            description: 'Without a mesh: only pins a person connects to, in the order they physically sit along each edge.',
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
            description: 'Without a mesh: USB plugs, sockets, the main chip, antennas, so the board is recognisable.',
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
            description: 'The pages the shape and pinout came from (datasheet, maker or seller page, the project repo).',
            items: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, title: { type: 'string' } } },
          },
          estimated: { type: 'boolean', description: 'true if the size or pins are a guess; it is drawn with a dashed outline.' },
          note: { type: 'string', description: 'Anything to know about this part, e.g. "labels are on the back", "print in PLA, 20% infill".' },
        },
      },
    },
    steps: {
      type: 'array',
      description:
        "One physical action per step, in a safe order, like a LEGO manual: put one part in, fasten it, plug one cable, or make the wires between one pair of parts. Use the project's own assembly guide for the order where there is one. Leave nothing out that the hands do: every cable and connector being plugged (even at one end only), every adapter or dongle, jumpers or switches to set, headers to solder, batteries, cards, antennas, and plugging into the computer or power at the end. Each of these must be drawn by the step (connections, place or fasteners), not only described: the person follows the picture.",
      items: {
        type: 'object',
        required: ['title', 'instruction'],
        properties: {
          title: { type: 'string', description: 'A few words, e.g. "Seat the shoulder servo".' },
          instruction: { type: 'string', description: 'One or two plain sentences for a first-timer. Say which way round, which side, wire colours.' },
          place: {
            type: 'array',
            description: 'Parts that go in during this step; each slides into its pose from a direction, the way the hand moves it.',
            items: {
              type: 'object',
              required: ['part'],
              properties: {
                part: { type: 'string' },
                from: {
                  description: 'Where it comes in from: above, below, front, back, left, right, or a direction [x, y, z]. Default above.',
                  anyOf: [{ type: 'string', enum: ['above', 'below', 'front', 'back', 'left', 'right'] }, vec3],
                },
                distance: { type: 'number', description: 'How far it travels, mm (default: about its own size).' },
              },
            },
          },
          fasteners: {
            type: 'array',
            description: 'Screws, nuts and the like for this step, shown in a parts box with their sizes and counts.',
            items: {
              type: 'object',
              required: ['size', 'count'],
              properties: {
                kind: { type: 'string', enum: ['screw', 'bolt', 'nut', 'washer', 'insert', 'standoff', 'zip tie', 'other'] },
                size: { type: 'string', description: 'As sold, e.g. "M2x6", "M3x12 countersunk".' },
                count: { type: 'integer' },
                into: { type: 'string', description: 'The part they go into.' },
                note: { type: 'string' },
              },
            },
          },
          connections: {
            type: 'array',
            description: 'Wires or cables made in this step, end to end.',
            items: {
              type: 'object',
              required: ['from', 'to'],
              properties: {
                from: end,
                to: end,
                wire: { type: 'string', description: 'The real wire colour if known, e.g. "black".' },
                temporary: { type: 'boolean', description: 'true if it is unplugged again after this step (e.g. a cable only used to set up or test one part).' },
                loose: {
                  type: 'boolean',
                  description:
                    'true if only the from end gets plugged in this step (a cable pushed into a socket, its other ends still free). Leave to out. A later step that plugs the other end uses the same from pin, and the cable continues to it.',
                },
                via: {
                  type: 'array',
                  description: 'How the cable is routed: points [x, y, z] in mm (like a pose) or part ids it runs past, in order.',
                  items: { anyOf: [{ type: 'string' }, vec3] },
                },
                note: { type: 'string' },
              },
            },
          },
          show: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Part ids that appear from this step on without sliding in. A part with a pose that appears (shown, wired, set up) before the step that places it waits loose on the table in front of the build, then travels into place at its place step.',
          },
          focus: { type: 'array', items: { type: 'string' }, description: 'Part ids, or "partid.pinid", to draw the eye to.' },
          view: {
            type: 'string',
            enum: ['iso', 'iso-back', 'front', 'back', 'left', 'right', 'top', 'bottom'],
            description: 'Turn the view for this step, e.g. "bottom" to show screws going in from underneath.',
          },
          times: { type: 'integer', description: 'Do this step this many times, e.g. 4 for one per finger.' },
          caution: { type: 'string', description: 'Anything that can damage a part or hurt: power, polarity, 5V vs 3.3V, overtightening, a servo set to the wrong id.' },
          check: { type: 'string', description: 'What to verify before moving on. Before anything is powered for the first time: photograph it with the check button on the page.' },
        },
      },
    },
  },
};

const tools = [
  {
    name: 'create_manual',
    title: 'Make an assembly manual',
    description: `Make a step-by-step 3D assembly manual for hardware the user is physically putting together, and get its link: electronics, wiring, 3D-printed parts, robots, enclosures, anything. Each step slides its parts into place, lists its screws, and draws its wires in, pin to pin.

Make it look like what the user really has, so there's less to translate and fewer mistakes:
- If the project publishes design files (a URDF, STL/STEP-derived meshes, a GitHub repo of printed parts), read them with read_cad and pass them in cad: every piece then has its real shape and its real place in the build.
- Give other parts a mesh too when the maker publishes one; otherwise look them up on the web (datasheet, maker or seller page) for size in mm and pinout as printed. Never fill in sizes or pin orders from memory: put the pages in sources, or set estimated: true where you had to guess.
- Follow the project's own assembly guide for the order, screw sizes and cautions where there is one. What the user confirmed on their real hardware (photos, labels, tests) beats documentation.
- Leave nothing out. Every cable, connector, adapter, dongle, the computer or power supply it all plugs into: each is a part, and every time the hands plug, insert, screw or solder something, a step draws it. The person follows the pictures, so anything only written in text gets missed.

Verified parts, drawn from measurements of real boards whenever the model matches: ${verifiedParts}.

Returns the link (give it to the user), the manual's id, and an edit token for update_manual. On the page the user can photograph a part or their wiring when they're stuck: with a key connected there the page checks it itself, otherwise you do (get_photo, answer_photo).`,
    inputSchema: manualSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'read_cad',
    title: 'Read a design file',
    description:
      "Read a build's design file and list its physical pieces with ids, 3D files and positions: a URDF (what robots publish; every printed part and motor comes out placed where it sits) or a single STL/OBJ/GLB/3MF. Use a raw link (raw.githubusercontent.com, not a github.com page). Then pass the same url in create_manual's cad list and refer to the pieces by these ids in steps.",
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
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
  {
    name: 'get_photo',
    title: 'Look at a photo the user took',
    description:
      'Get a photo the user took on the manual page, as an image, with the step they were on. Photos waiting for an answer are listed by get_manual. Zoom in on the printed labels to tell which part it is and where each wire goes, then answer with answer_photo.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The manual id.' },
        photo: { type: 'string', description: 'The photo id from get_manual; the newest photo if left out.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'answer_photo',
    title: 'Answer a photo on the page',
    description:
      "Answer a photo the user took: the page shows your answer next to it and highlights what you point at on the drawing (the part, its pins, the wires to make), jumping to the step if needed. Also answer them in chat.",
    inputSchema: {
      type: 'object',
      required: ['id', 'photo', 'verdict', 'explanation'],
      properties: {
        id: { type: 'string' },
        photo: { type: 'string', description: 'The photo id.' },
        verdict: {
          type: 'string',
          enum: ['ok', 'wrong', 'unsure', 'retake'],
          description: 'ok = right part or right wiring for the step; wrong = say what to move where; unsure = can’t tell; retake = too blurry or far to read.',
        },
        explanation: { type: 'string', description: 'One to three plain sentences. Name the part you see; if something is wrong, say exactly what to move where.' },
        focus: { type: 'array', items: { type: 'string' }, description: 'Part ids or "partid.pinid" to highlight.' },
        connections: {
          type: 'array',
          description: 'Wires to draw, pin to pin, using manual ids.',
          items: {
            type: 'object',
            required: ['from', 'to'],
            properties: {
              from: { type: 'object', required: ['part', 'pin'], properties: { part: { type: 'string' }, pin: { type: 'string' } } },
              to: { type: 'object', required: ['part', 'pin'], properties: { part: { type: 'string' }, pin: { type: 'string' } } },
              wire: { type: 'string' },
            },
          },
        },
        step: { type: 'integer', description: 'Step to jump to, counting from 0; leave out to stay.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Text you read off the boards, e.g. "+5V GND RXD TXD 3V3 on the left header".' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

// ---------- what the tools do (also the plain HTTP api) ----------

type Result = { ok: true; text: string; data: Record<string, unknown> } | { ok: false; text: string; status: number };

const link = (origin: string, id: string) => `${origin}/m/${id}`;

const warned = (warnings: string[]) => (warnings.length ? `\n\nWorth fixing (update_manual):\n${warnings.map((w) => `- ${w}`).join('\n')}` : '');

/** the design files a manual names, read into parts the agent's own entries refine */
async function expand(draft: Draft & { cad?: unknown }): Promise<{ draft: Draft; errors: string[] }> {
  const sources = Array.isArray(draft.cad) ? draft.cad.slice(0, 10) : [];
  if (!sources.length) return { draft, errors: [] };
  const errors: string[] = [];
  const imported: CadPart[] = [];
  for (const [i, source] of sources.entries()) {
    const entry = (typeof source === 'string' ? { url: source } : source) as { url?: string; only?: string[] };
    try {
      const { parts } = await readCad(String(entry.url ?? ''));
      imported.push(...parts.filter((p) => !entry.only?.length || entry.only.includes(p.id)));
    } catch (error) {
      errors.push(`cad[${i}]: ${(error as Error).message}`);
    }
  }
  const given = (Array.isArray(draft.parts) ? draft.parts : []) as Record<string, unknown>[];
  // the agent's entry for an imported piece only has to say what it adds: a name, a note, sources
  const parts = given.map((p) => {
    const base = imported.find((c) => c.id === p.id);
    if (!base) return p;
    const { link: _, ...rest } = base;
    return { ...rest, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null)) };
  });
  for (const c of imported) {
    if (given.some((p) => p.id === c.id)) continue;
    const { link: _, ...rest } = c;
    parts.push(rest);
  }
  return { draft: { ...draft, parts }, errors };
}

export async function createManual(raw: Draft, origin: string, who = 'local'): Promise<Result> {
  if (!(await manuals.allow('create', who, 40, 3600))) return { ok: false, status: 429, text: 'Too many manuals from here in the last hour. Try again later.' };
  const expanded = await expand(raw);
  const checked = check(expanded.draft);
  const { guide, warnings } = checked;
  const errors = [...expanded.errors, ...checked.errors];
  if (errors.length) return { ok: false, status: 422, text: `The manual wasn't made. Fix these and try again:\n${errors.map((e) => `- ${e}`).join('\n')}` };
  const { manual, token } = await manuals.create(guide);
  const url = link(origin, manual.id);
  return {
    ok: true,
    data: { id: manual.id, url, edit_token: token, warnings },
    text:
      `Manual ready: ${url}\n` +
      `Give the user this link. It opens on a computer or a phone (the page has a QR code), and every device stays on the same step.\n\n` +
      `${PHOTO_TIP}\n\n` +
      `id: ${manual.id}\nedit_token: ${token} (keep it to change this manual with update_manual)` +
      warned(warnings),
  };
}

export async function updateManual(id: string, token: string, raw: Draft): Promise<Result> {
  const manual = await manuals.get(id);
  if (!manual) return { ok: false, status: 404, text: `No manual "${id}".` };
  if (!token || !manuals.mayEdit(manual, token)) return { ok: false, status: 403, text: 'That edit token is not the one this manual was made with.' };
  const expanded = await expand(raw);
  const checked = check(expanded.draft);
  const { guide, warnings } = checked;
  const errors = [...expanded.errors, ...checked.errors];
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
    photo_id: p.id,
    needs_your_answer: p.status === 'waiting',
    answered_by: p.answeredBy,
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
  const waiting = checks.filter((c) => c.needs_your_answer).map((c) => c.photo_id);
  const tip = waiting.length ? `Waiting for your answer: photo ${waiting.join(', ')}. Look with get_photo, answer with answer_photo.\n\n` : '';
  return { ok: true, data, text: tip + JSON.stringify(data, null, 1) };
}

export async function inspectCad(url: string): Promise<Result> {
  try {
    const { parts, summary } = await readCad(url);
    const listed = parts.map((p) => ({ id: p.id, name: p.name, file: p.mesh?.url, link: p.link, color: p.color, at_mm: p.pose?.at }));
    return {
      ok: true,
      data: { summary, parts: listed },
      text:
        `${summary}\n\nTo use them, put {"url": "${url}"} in the manual's cad list: every piece below comes in with its real 3d file and its place in the build. ` +
        `Refer to them by id in steps. Add an entry with the same id in parts only to give it a better name, a note or sources; use cad[].only to keep just some.\n\n` +
        JSON.stringify(listed, null, 1),
    };
  } catch (error) {
    return { ok: false, status: 400, text: (error as Error).message };
  }
}

export async function photoOf(id: string, photoId?: string) {
  const manual = await manuals.get(id);
  if (!manual) return { ok: false as const, text: `No manual "${id}".` };
  const photo = photoId ? manual.photos.find((p) => p.id === photoId) : manual.photos.at(-1);
  if (!photo) return { ok: false as const, text: photoId ? `No photo "${photoId}" on this manual.` : 'No photos on this manual yet.' };
  const full = await manuals.getFile(photo.file);
  const jpeg = await sharp(full).resize({ width: 1800, height: 1800, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  const step = manual.guide.steps[photo.step];
  return {
    ok: true as const,
    jpeg,
    text: `Photo ${photo.id}, taken on step ${photo.step} (from 0): "${step?.title ?? ''}". ${photo.status === 'waiting' ? 'Waiting for your answer.' : `Status: ${photo.status}.`} Answer it with answer_photo.`,
  };
}

/** the agent's answer to a photo, shown on the page with what it points at */
// like taking the photo, answering it only needs the link: a new chat without the edit token can still point at pins
export async function answerPhoto(id: string, args: Record<string, unknown>): Promise<Result> {
  const manual = await manuals.get(id);
  if (!manual) return { ok: false, status: 404, text: `No manual "${id}".` };
  const photo = manual.photos.find((p) => p.id === args.photo);
  if (!photo) return { ok: false, status: 404, text: `No photo "${String(args.photo)}" on this manual.` };
  type Verdict = 'ok' | 'wrong' | 'unsure' | 'retake';
  const verdict: Verdict = ['ok', 'wrong', 'unsure', 'retake'].includes(String(args.verdict)) ? (String(args.verdict) as Verdict) : 'unsure';
  const explanation = String(args.explanation ?? '').slice(0, 1000);
  const { focus, connections, problems } = pointAt(manual.guide, args.focus, args.connections);
  const step = Number.isInteger(args.step) && Number(args.step) >= 0 && Number(args.step) < manual.guide.steps.length ? Number(args.step) : null;
  photo.analysis = {
    quality: verdict === 'retake' ? 'retake' : 'good',
    retake: verdict === 'retake' ? explanation : '',
    seen: '',
    labels: (Array.isArray(args.labels) ? args.labels : []).slice(0, 12).map((t) => ({ where: '', text: String(t).slice(0, 200) })),
    parts: [...new Set(focus.map((f) => f.split('.')[0]))],
    verdict: verdict === 'retake' ? 'unsure' : verdict,
    explanation,
    visual: { focus, connections, step },
  };
  photo.status = verdict === 'retake' ? 'retake' : 'done';
  photo.answeredBy = 'agent';
  photo.error = '';
  manuals.changed(manual);
  await manuals.flush();
  return {
    ok: true,
    data: { photo: photo.id, problems },
    text: `The page shows your answer now${focus.length || connections.length ? ', with what you pointed at highlighted' : ''}.${problems.length ? `\nNot drawn (no such part or pin): ${problems.join('; ')}` : ''}`,
  };
}

/** keeps only what exists on the drawing, matching pins by id or printed label */
function pointAt(guide: Guide, rawFocus: unknown, rawConnections: unknown) {
  const problems: string[] = [];
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9+]/g, '').replace(/^\+/, '');
  const pin = (partId: string, ref: string) => {
    const part = guide.parts.find((p) => p.id === partId);
    if (!part) return null;
    return part.pins.find((p) => p.id === ref) ?? part.pins.find((p) => norm(p.id) === norm(ref) || norm(p.label) === norm(ref)) ?? null;
  };
  const focus = (Array.isArray(rawFocus) ? rawFocus : []).slice(0, 20).flatMap((value) => {
    const [partId, ...rest] = String(value).split('.');
    if (!guide.parts.some((p) => p.id === partId)) return problems.push(String(value)), [];
    if (!rest.length) return [partId];
    const found = pin(partId, rest.join('.'));
    return found ? [`${partId}.${found.id}`] : (problems.push(String(value)), []);
  });
  const connections: Connection[] = (Array.isArray(rawConnections) ? rawConnections : []).slice(0, 20).flatMap((raw) => {
    const c = raw as { from?: End; to?: End; wire?: string };
    const a = c.from && pin(String(c.from.part), String(c.from.pin));
    const b = c.to && pin(String(c.to.part), String(c.to.pin));
    if (!a || !b) return problems.push(`${c.from?.part}.${c.from?.pin} -> ${c.to?.part}.${c.to?.pin}`), [];
    return [{ from: { part: String(c.from!.part), pin: a.id }, to: { part: String(c.to!.part), pin: b.id }, wire: String(c.wire ?? '').slice(0, 30), note: '' }];
  });
  return { focus, connections, problems };
}

// ---------- json-rpc over http ----------

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const reply = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const failure = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function call(name: string, args: Record<string, unknown>, origin: string, who: string): Promise<Result> {
  // reading a design file stores nothing, so it works without storage
  if (name === 'read_cad') return inspectCad(String(args.url ?? ''));
  if (!manuals.ready) return { ok: false, status: 503, text: manuals.NOT_READY };
  if (name === 'create_manual') return createManual(args, origin, who);
  if (name === 'update_manual') return updateManual(String(args.id ?? ''), String(args.edit_token ?? ''), args);
  if (name === 'get_manual') return describeManual(String(args.id ?? ''), origin);
  if (name === 'answer_photo') return answerPhoto(String(args.id ?? ''), args);
  return { ok: false, status: 404, text: `No tool "${name}".` };
}

async function handle(message: Rpc, origin: string, who: string) {
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
        if (name === 'get_photo') {
          if (!manuals.ready) return reply(id, { content: [{ type: 'text', text: manuals.NOT_READY }], isError: true });
          const photo = await photoOf(String(args.id ?? ''), args.photo ? String(args.photo) : undefined);
          return reply(id, {
            content: photo.ok
              ? [
                  { type: 'image', data: photo.jpeg.toString('base64'), mimeType: 'image/jpeg' },
                  { type: 'text', text: photo.text },
                ]
              : [{ type: 'text', text: photo.text }],
            ...(photo.ok ? {} : { isError: true }),
          });
        }
        const result = await call(name, args, origin, who);
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
  const who = c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  const replies = (await Promise.all((Array.isArray(body) ? body : [body]).slice(0, 20).map((m) => handle(m, originOf(c), who)))).filter(Boolean);
  if (!replies.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? replies : replies[0]);
}
