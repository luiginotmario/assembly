import sharp from 'sharp';
import type { Part, Photo, PhotoAnalysis, Pin, Side } from '../shared/types.js';
import { image, json, text, type ApiKey, type Content } from './llm.js';
import { changed, getFile, putFile, type Stored } from './manuals.js';
import * as schemas from './schemas.js';
import { around, straighten, type Point } from './warp.js';

// Checking a photo against the manual. Someone following it takes a picture because something
// is confusing ("is this the part you mean?", "is this wired right?"). The model looks at the
// whole photo, zooms into the small printed labels and reads them, then answers against the
// step they're on. Every board of the manual that's fully in the photo is cut out, straightened
// and laid onto its 3d part, with its pins measured where they really are.

const FIRST_LOOK = `You're looking at a photo someone took while assembling electronics from a step-by-step manual. Decide:
- quality: "retake" only if it's too blurry, dark or far away to tell what the parts are. Then say in retake exactly how to take it better (closer to what, more light, hold still, straight on).
- seen: what's in the photo, in one or two plain sentences.
- zoom: up to 4 regions with small printed text worth reading closely (pin labels, chip markings, part numbers, wire colours at a connector), as boxes in 0..1 image coordinates (x0, y0 top-left; x1, y1 bottom-right). Leave room around the text.`;

const CLOSE_LOOK = `You're helping someone assemble electronics from a step-by-step manual. They took a photo because something on the current step is confusing: usually "is this the part you mean?" or "did I wire this right?". You get their photo, close-ups of the small text in it, and the manual.
- labels: every piece of text you can read, with where it is ("next to the white socket, top to bottom").
- parts: ids from the manual you can see in the photo.
- verdict: "ok" if what you see is right for the current step (the right part, or wires on the right pins), "wrong" if not, "unsure" when you can't tell, "none" if the photo isn't about the manual.
- explanation: one to three plain sentences, like a friend who knows electronics. Name the part you see. If something's wrong, say exactly what to move where.
- visual: what to show on the drawing to explain it: focus (part ids or "partid.pinid"), connections to animate (manual ids), step to jump to or null.
- If even the close-ups aren't readable, set quality "retake" and say how to take it better.
Be precise about colours and positions. Real boards often differ from datasheets, and what's printed on the board wins.`;

const BOARDS = `You see a photo of electronics parts, plus zoomed crops. Find each circuit board from the PARTS list that's fully visible from above or below.
For each, give its id and its four corners in 0..1 image coordinates, in the part's own order:
  1. where its TOP and LEFT edges meet, 2. TOP and RIGHT, 3. BOTTOM and RIGHT, 4. BOTTOM and LEFT,
where top, left and so on are the edges as described for that part (use where its pins and connectors are to tell which physical edge is which), not as they appear in the photo.
whole is false if any of the board is cut off or covered. Leave out boards that aren't in the list.`;

const CORNERS = `Each image is a close-up around one corner of a circuit board, in order. Give the exact position of the board's corner in each image, in 0..1 coordinates of that image. found is false if the corner isn't in the image.`;

const PINS = `This is a circuit board seen straight on, cut out of a photo: the image edges are the board's edges (top of the image = the board's top edge).
For each pin, pad or socket contact a person connects to, give where it is: u from 0 (left edge) to 1 (right edge), v from 0 (top edge) to 1 (bottom edge), the edge it's nearest (side), and its label exactly as printed next to it. Use the expected ids where they match; real boards sometimes differ from datasheets, and what's printed on this board wins.`;

type Box = { x0: number; y0: number; x1: number; y1: number };
type FirstLook = { quality: 'good' | 'retake'; retake: string; seen: string; zoom: { box: Box; why: string }[] };

export async function readPhoto(manual: Stored, photo: Photo, key: ApiKey) {
  photo.status = 'reading';
  photo.crops = [];
  photo.error = '';
  changed(manual);
  try {
    const full = await getFile(photo.file);
    const overview = await sharp(full).resize({ width: 1600, height: 1600, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();

    const first = await json<FirstLook>(key, { name: 'first_look', system: FIRST_LOOK, user: [image(overview)], schema: schemas.firstLook });

    const crops: Buffer[] = [];
    for (const [i, region] of first.zoom.slice(0, 4).entries()) {
      const crop = await zoomInto(full, region.box);
      if (!crop) continue;
      photo.crops.push(await putFile(manual.id, `${photo.id}-zoom${i}.jpg`, crop));
      crops.push(crop);
    }
    changed(manual);

    const step = manual.guide.steps[photo.step];
    const content: Content = [
      text(`MANUAL\n${JSON.stringify(withoutPhotos(manual))}\n\nThey are on step ${photo.step} (counting from 0): ${step?.title ?? ''}`),
      image(overview),
      ...crops.flatMap((crop, i) => [text(`Close-up ${i + 1}: ${first.zoom[i]?.why ?? ''}`), image(crop)]),
    ];
    const close = await json<PhotoAnalysis>(key, { name: 'close_look', system: CLOSE_LOOK, user: content, schema: schemas.closeLook });
    photo.analysis = close;
    photo.answeredBy = 'page';
    if (close.quality === 'retake') {
      photo.status = 'retake';
    } else {
      photo.captured = await capture(manual, photo, full, overview, crops, key);
      // only done once the boards are on the drawing too
      photo.status = 'done';
    }
  } catch (error) {
    photo.status = 'error';
    photo.error = (error as Error).message;
  }
  changed(manual);
}

/** crops a region from the full-resolution photo, with a margin, scaled up so small text is legible */
async function zoomInto(full: Buffer, box: Box): Promise<Buffer | null> {
  const { width = 0, height = 0 } = await sharp(full).metadata();
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const pad = 0.12;
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const left = Math.round(clamp(box.x0 - w * pad) * width);
  const top = Math.round(clamp(box.y0 - h * pad) * height);
  const right = Math.round(clamp(box.x1 + w * pad) * width);
  const bottom = Math.round(clamp(box.y1 + h * pad) * height);
  if (right - left < 16 || bottom - top < 16) return null;
  return sharp(full)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** the manual without photo urls, which mean nothing to the model */
function withoutPhotos(manual: Stored) {
  return { ...manual.guide, parts: manual.guide.parts.map(({ texture: _, sources: __, ...part }) => part) };
}

/** finds the manual's boards in a photo and lays each one onto its part; returns their names */
async function capture(manual: Stored, photo: Photo, full: Buffer, overview: Buffer, crops: Buffer[], key: ApiKey) {
  const boards = manual.guide.parts.filter((p) => p.kind !== 'cable' && p.kind !== 'computer');
  if (!boards.length) return [];
  const described = boards.map((p) => `- ${p.id}: ${p.name} (${p.model}), ${p.size.w}x${p.size.h} mm. ${describePins(p)}`).join('\n');
  const found = await json<{ boards: { part: string; whole: boolean; corners: Point[] }[] }>(key, {
    name: 'boards',
    system: BOARDS,
    user: [text(`PARTS\n${described}`), image(overview), ...crops.map((c) => image(c))],
    schema: schemas.boards,
  });

  const captured: string[] = [];
  for (const board of found.boards) {
    const part = boards.find((p) => p.id === board.part);
    if (!part || !board.whole || board.corners.length !== 4) continue;
    try {
      await layPhoto(manual, photo, full, part, board.corners, key);
      captured.push(part.name);
    } catch (error) {
      console.warn(`couldn't lay the photo onto ${part.id}:`, (error as Error).message);
    }
  }
  changed(manual);
  return captured;
}

async function layPhoto(manual: Stored, photo: Photo, full: Buffer, part: Part, rough: Point[], key: ApiKey) {
  // place each corner exactly by looking closely at it
  const zooms = await Promise.all(rough.map((c) => around(full, c)));
  const exact = await json<{ corners: { found: boolean; at: Point }[] }>(key, {
    name: 'corners',
    system: CORNERS,
    user: zooms.flatMap((z, i) => [text(`Corner ${i + 1}`), image(z.image)]),
    schema: schemas.corners,
  });
  const corners = rough.map((c, i) => (exact.corners[i]?.found ? zooms[i].back(exact.corners[i].at) : c));

  // straighten it with the board's real proportions (or what the photo shows, if those were a guess)
  const { width = 1, height = 1 } = await sharp(full).metadata();
  const span = (a: Point, b: Point) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const seen = (span(corners[0], corners[1]) + span(corners[3], corners[2])) / (span(corners[0], corners[3]) + span(corners[1], corners[2]));
  const listed = part.size.w / part.size.h;
  const aspect = part.estimated ? seen : listed;
  const flat = await straighten(full, corners, aspect);
  const texture = await putFile(manual.id, `${photo.id}-${part.id}.jpg`, flat);

  // measure the pins on the straightened board
  const measured = await json<{ pins: { id: string; label: string; u: number; v: number; side: Side }[] }>(key, {
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

  part.texture = texture;
  // the measured pins replace the listed ones only if every pin the steps use is still there
  const used = new Set(manual.guide.steps.flatMap((s) => s.connections.flatMap((c) => [c.from, c.to]).filter((e) => e.part === part.id).map((e) => e.pin)));
  if (pins.length && [...used].every((id) => pins.some((p) => p.id === id))) part.pins = pins;
  if (part.estimated && aspect !== listed) {
    const area = part.size.w * part.size.h;
    part.size = { ...part.size, w: Math.sqrt(area * aspect), h: Math.sqrt(area / aspect) };
  }
}

function describePins(part: Part) {
  const sides = (['top', 'right', 'bottom', 'left'] as Side[])
    .map((side) => {
      const on = part.pins.filter((p) => p.side === side).sort((a, b) => a.index - b.index);
      return on.length ? `${side} edge: ${on.map((p) => `${p.id}${p.label !== p.id ? ` (${p.label})` : ''}`).join(', ')}` : '';
    })
    .filter(Boolean);
  const features = part.features.map((f) => `${f.kind} on the ${f.side} edge`);
  return [...sides, ...features].join('; ') || 'no pins listed';
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
