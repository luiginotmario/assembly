import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { library } from '../shared/library';
import type { Lookup, Part, Photo, Pin, Session, Side, Source } from '../shared/types';
import { image, json, searched, text } from './llm';
import * as schemas from './schemas';
import { changed, folder } from './sessions';
import { around, straighten, type Point } from './warp';

// The real hardware. Parts are looked up on the web, never filled in from what a model
// remembers, and every board that shows up in a photo is cut out, straightened and laid
// onto its 3d part, with its pins measured where they really are.

const RESEARCH = `You look up one electronics part on the web and report its physical details, using only what the pages you find actually say.
- Never fill in a value from memory. If the pages don't state something, put its name in "missing" and leave it 0 (numbers), "" (text) or [] (lists).
- Prefer the manufacturer's datasheet, then the seller's listing.
- size: the board itself in millimetres. Lying flat with its printed labels readable: w across, h front to back, t thickness.
- model: the part as the user named it. Don't swap it for one specific vendor's product unless the query names that vendor; generic modules (like an SSD1306 OLED breakout) are sold by many makers.
- pins: every pin, pad or socket contact a person connects to, with the label exactly as printed, which edge it's on ("top" = far edge, "bottom" = near edge, "left", "right") and its order along that edge (top/bottom: left to right, left/right: far to near). pitch is the spacing between them.
  If the pages give the labels and their order but not the edge, still list them, in order, on the "top" edge, and add "pin edge" to missing. Never drop pins whose labels are known.
- features: usb plugs, sockets, the main chip, antennas, with which edge they're on and where along it (0..1).
- color: the board colour as hex if a page shows or states it.
- sources: every page you used.
- found: false if you can't identify this part at all.`;

const PARTS_IN_PLAN = `List every physical part this build plan uses, once per kind: its everyday name, its exact model as written (or the closest thing to a model the plan gives), and how many. Only boards, modules, sensors and components that get wired or assembled: not jumper wires, cables, tools or the computer.`;

const BOARDS = `You see a photo of electronics parts, plus zoomed crops. Find each circuit board that's fully visible from above or below.
For each board that matches a KNOWN PART, give its id and its four corners in 0..1 image coordinates, in the part's own order:
  1. where its TOP and LEFT edges meet, 2. TOP and RIGHT, 3. BOTTOM and RIGHT, 4. BOTTOM and LEFT,
where top, left and so on are the edges as described for that part (use where its pins and connectors are to tell which physical edge is which), not as they appear in the photo.
whole is false if any of the board is cut off or covered.
Boards that match no known part go in "unknown" with every marking you can read on them (model numbers, chip names, brand) and a short description.`;

const CORNERS = `Each image is a close-up around one corner of a circuit board, in order. Give the exact position of the board's corner in each image, in 0..1 coordinates of that image. found is false if the corner isn't in the image.`;

const PINS = `This is a circuit board seen straight on, cut out of a photo: the image edges are the board's edges (top of the image = the board's top edge).
For each pin, pad or socket contact a person connects to, give where it is: u from 0 (left edge) to 1 (right edge), v from 0 (top edge) to 1 (bottom edge), the edge it's nearest (side), and its label exactly as printed next to it. Use the expected ids where they match; real boards sometimes differ from datasheets, and what's printed on this board wins.`;

const known = (session: Session) => [...session.parts, ...(session.guide?.parts ?? [])];

const sameModel = (a: string, b: string) => {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'part';

/** the specs for a part: a board already photographed or looked up, the verified library, or the web */
export async function lookUp(session: Session, query: string): Promise<Part | null> {
  const have = session.parts.find((p) => sameModel(p.model, query) || sameModel(p.name, query));
  if (have) return have;
  const verified = library.find((k) => k.aliases.some((a) => sameModel(a, query)));
  if (verified) {
    const part: Part = { ...structuredClone(verified.part), id: slug(verified.part.model) };
    session.parts.push(part);
    changed(session);
    return part;
  }

  const lookup: Lookup = { query, status: 'searching', sources: [], missing: [], error: '' };
  session.lookups.push(lookup);
  changed(session);
  try {
    type Found = Omit<Part, 'id' | 'estimated' | 'source' | 'texture'> & { found: boolean; missing: string[]; sources: Source[] };
    const first = await searched<Found>({ name: 'research', system: RESEARCH, user: `Part: ${query}`, schema: schemas.research });
    let value = first.value;
    let cited = first.sources;
    // the first search often misses the board's size or its full pinout: search again for just those
    const gaps = [value.size.w > 0 ? '' : 'board dimensions in mm', value.pins.length ? '' : 'pinout with pin labels'].filter(Boolean);
    if (value.found && gaps.length) {
      const again = await searched<Found>({
        name: 'research',
        system: RESEARCH,
        user: `Part: ${query}\nAlready found: ${JSON.stringify(value)}\nSearch specifically for its ${gaps.join(' and ')}, and return the whole part with those filled in where the pages state them.`,
        schema: schemas.research,
      });
      const more = again.value;
      value = {
        ...value,
        size: more.size.w > 0 ? more.size : value.size,
        pins: more.pins.length ? more.pins : value.pins,
        pitch: value.pitch || more.pitch,
        features: value.features.length ? value.features : more.features,
        color: value.color || more.color,
        sources: [...value.sources, ...more.sources],
        missing: more.missing,
      };
      cited = [...cited, ...again.sources];
    }
    const sources = dedupe([...value.sources, ...cited]);
    lookup.sources = sources;
    lookup.missing = value.missing;
    if (!value.found) {
      lookup.status = 'not-found';
      return null;
    }
    lookup.status = 'found';
    const sized = value.size.w > 0 && value.size.h > 0;
    const pitch = value.pitch || 2.54;
    const pins = splitHeaders(value.pins, value.missing);
    // without a size from the sources, the placeholder at least fits the pins it has
    const perEdge = Math.max(0, ...(['top', 'bottom', 'left', 'right'] as Side[]).map((s) => pins.filter((p) => p.side === s).length));
    const twoEdges = pins.some((p) => p.side === 'top') && pins.some((p) => p.side === 'bottom');
    const part: Part = {
      id: slug(value.model || value.name),
      name: value.name,
      model: value.model || query,
      kind: value.kind,
      // without a size from the sources it's drawn at a placeholder size and marked as a guess
      size: sized
        ? { w: value.size.w, h: value.size.h, t: value.size.t || 1.6 }
        : { w: Math.max(30, perEdge * pitch + 6), h: twoEdges ? 26 : 20, t: 1.6 },
      color: value.color || '#2a6f3a',
      pitch,
      pins,
      features: value.features,
      estimated: !sized || value.pins.length === 0,
      source: sources[0]?.url ?? 'web search',
      note: [value.note, value.missing.length ? `Not in the sources: ${value.missing.join(', ')}.` : ''].filter(Boolean).join(' '),
      sources,
    };
    session.parts.push(part);
    return part;
  } catch (error) {
    lookup.status = 'error';
    lookup.error = (error as Error).message;
    return null;
  } finally {
    changed(session);
  }
}

/** every part a plan mentions, looked up */
export async function partsOf(session: Session) {
  const { parts } = await json<{ parts: { name: string; model: string; count: number }[] }>({
    name: 'parts_in_plan',
    system: PARTS_IN_PLAN,
    user: session.plan,
    schema: schemas.partsInPlan,
  });
  const found = await Promise.all(parts.map((p) => lookUp(session, p.model || p.name)));
  return {
    found: found.filter((p): p is Part => !!p),
    missing: parts.filter((_, i) => !found[i]).map((p) => p.model || p.name),
  };
}

/** every guide part takes the real geometry, pins and photo of the hardware it matches */
export function matchGuide(session: Session) {
  const guide = session.guide;
  if (!guide) return;
  for (const part of guide.parts) {
    const real = session.parts.find((p) => p.id === part.id || sameModel(p.model, part.model));
    if (!real) continue;
    const before = part.pins;
    // ids and names stay the guide's (two identical adapters are "usb1" and "usb2"); a lookup
    // that found no pins keeps the ones the plan named
    Object.assign(part, structuredClone({ ...real, id: part.id, name: part.name, pins: real.pins.length ? real.pins : before }));
    // wires and focus point at the real pins, matched by id or printed label
    const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9+]/g, '');
    const rename = new Map<string, string>();
    for (const old of before) {
      const match = part.pins.find((p) => key(p.id) === key(old.id) || key(p.label) === key(old.label) || key(p.label) === key(old.id));
      if (match) rename.set(old.id, match.id);
    }
    for (const step of guide.steps) {
      for (const c of step.connections) {
        for (const end of [c.from, c.to]) if (end.part === part.id && rename.has(end.pin)) end.pin = rename.get(end.pin)!;
      }
      step.focus = step.focus.map((f) => {
        const [id, pin] = f.split('.');
        return id === part.id && pin && rename.has(pin) ? `${id}.${rename.get(pin)}` : f;
      });
    }
  }
}

type Boards = {
  boards: { part: string; whole: boolean; corners: Point[] }[];
  unknown: { markings: string; description: string }[];
};

/** finds the boards in a photo, looks up any it doesn't know, and lays each photo onto its part */
export async function capture(session: Session, photo: Photo, full: Buffer, overview: Buffer, crops: Buffer[]) {
  const parts = known(session);
  const described = parts.map((p) => `- ${p.id}: ${p.name} (${p.model}), ${p.size.w}x${p.size.h} mm. ${describePins(p)}`).join('\n');
  const found = await json<Boards>({
    name: 'boards',
    system: BOARDS,
    user: [text(`KNOWN PARTS\n${described || 'none yet'}`), image(overview), ...crops.map((c) => image(c))],
    schema: schemas.boards,
  });

  const added: string[] = [];
  for (const item of found.unknown) {
    if (!item.markings.trim()) continue;
    const part = await lookUp(session, item.markings);
    if (part) added.push(part.name);
  }
  // newly looked-up parts need their corners found too, now that they're known
  const again = added.length
    ? await json<Boards>({
        name: 'boards',
        system: BOARDS,
        user: [
          text(`KNOWN PARTS\n${known(session).map((p) => `- ${p.id}: ${p.name} (${p.model}). ${describePins(p)}`).join('\n')}`),
          image(overview),
        ],
        schema: schemas.boards,
      })
    : found;

  const captured: string[] = [];
  for (const board of again.boards) {
    const part = known(session).find((p) => p.id === board.part);
    if (!part || !board.whole || board.corners.length !== 4) continue;
    try {
      await layPhoto(session, photo, full, part, board.corners);
      captured.push(part.name);
    } catch (error) {
      console.warn(`couldn't lay the photo onto ${part.id}:`, (error as Error).message);
    }
  }
  matchGuide(session);
  changed(session);
  return { added, captured };
}

async function layPhoto(session: Session, photo: Photo, full: Buffer, part: Part, rough: Point[]) {
  // place each corner exactly by looking closely at it
  const zooms = await Promise.all(rough.map((c) => around(full, c)));
  const exact = await json<{ corners: { found: boolean; at: Point }[] }>({
    name: 'corners',
    system: CORNERS,
    user: zooms.flatMap((z, i) => [text(`Corner ${i + 1}`), image(z.image)]),
    schema: schemas.corners,
  });
  const corners = rough.map((c, i) => (exact.corners[i]?.found ? zooms[i].back(exact.corners[i].at) : c));

  // straighten it with the board's real proportions (turned if the photo shows it the other way)
  const { width = 1, height = 1 } = await sharp(full).metadata();
  const span = (a: Point, b: Point) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const seen = (span(corners[0], corners[1]) + span(corners[3], corners[2])) / (span(corners[0], corners[3]) + span(corners[1], corners[2]));
  const listed = part.size.w / part.size.h;
  const aspect = part.estimated ? seen : listed;
  const flat = await straighten(full, corners, aspect);
  const file = `${photo.id}-${part.id}.jpg`;
  await writeFile(path.join(folder(session.id), file), flat);

  // measure the pins on the straightened board
  const measured = await json<{ pins: { id: string; label: string; u: number; v: number; side: Side }[] }>({
    name: 'pins_on_board',
    system: PINS,
    user: [text(`Expected pins: ${describePins(part)}`), image(flat)],
    schema: schemas.pinsOnBoard,
  });
  const pins: Pin[] = measured.pins.map((m) => {
    const expected = part.pins.find((p) => p.id === m.id || p.label === m.label);
    return {
      id: expected?.id ?? m.label ?? m.id,
      label: m.label || expected?.label || m.id,
      side: m.side,
      index: 0,
      style: expected?.style ?? 'header',
      at: { u: clamp(m.u), v: clamp(m.v) },
    };
  });
  // order along each edge from the measured positions
  for (const side of ['top', 'bottom', 'left', 'right'] as Side[]) {
    const along = pins.filter((p) => p.side === side).sort((a, b) => (side === 'left' || side === 'right' ? a.at!.v - b.at!.v : a.at!.u - b.at!.u));
    along.forEach((p, i) => (p.index = i));
  }

  part.texture = `/files/${session.id}/${file}`;
  if (pins.length) part.pins = pins;
  if (part.estimated && aspect !== listed) part.size = { ...part.size, w: Math.sqrt(part.size.w * part.size.h * aspect), h: Math.sqrt((part.size.w * part.size.h) / aspect) };
  // the inventory copy of this part gets it too
  const real = session.parts.find((p) => sameModel(p.model, part.model));
  if (real && real !== part) Object.assign(real, { texture: part.texture, pins: structuredClone(part.pins), size: part.size });
}

/**
 * When the sources give a pinout but not which edge each pin is on, pins all arrive on one
 * edge. Boards with two headers name them (J2-1, J3-1, ...), so each header gets its own
 * long edge, the way such boards are built. It stays marked approximate until a photo.
 */
function splitHeaders(pins: Pin[], missing: string[]) {
  const unsure = missing.some((m) => /edge/i.test(m));
  if (!unsure || new Set(pins.map((p) => p.side)).size > 1) return pins;
  const header = (p: Pin) => p.id.match(/^([A-Za-z]+\d+)[-_.]/)?.[1];
  const groups = [...new Set(pins.map(header))];
  if (groups.length !== 2 || groups.includes(undefined)) return pins;
  return pins.map((p) => {
    const side: Side = header(p) === groups[0] ? 'top' : 'bottom';
    return { ...p, side, index: pins.filter((q) => header(q) === header(p)).indexOf(p) };
  });
}

function describePins(part: Part) {
  const sides = (['top', 'right', 'bottom', 'left'] as Side[])
    .map((side) => {
      const on = part.pins.filter((p) => p.side === side).sort((a, b) => a.index - b.index);
      return on.length ? `${side} edge: ${on.map((p) => `${p.id}${p.label !== p.id ? ` (${p.label})` : ''}`).join(', ')}` : '';
    })
    .filter(Boolean);
  const features = part.features.map((f) => `${f.kind} on the ${f.side} edge`);
  return [...sides, ...features].join('; ') || 'no pins known yet';
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

function dedupe(sources: Source[]) {
  const seen = new Set<string>();
  return sources.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url));
}
