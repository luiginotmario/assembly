import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { mentioned } from '../shared/library';
import type { Guide, Message, Photo, PhotoAnalysis, Session, Visual } from '../shared/types';
import { image, json, text, type Content } from './llm';
import * as schemas from './schemas';
import { changed, folder, id } from './sessions';

const GUIDE = `You turn a hardware build plan into a step-by-step assembly guide for someone who has never wired electronics before. The guide is drawn as a 3D line drawing, so the geometry you give is what they'll see.

Parts
- One entry per physical item, using the exact name and model from the plan. Two identical boards are two parts with different ids.
- Ids are short, lowercase, no spaces or dots (e.g. "ld2450", "usb1").
- Sizes in millimetres, as close to the real board as you know. Lying flat on a table: w across, h front to back, t thickness.
- If a part is in the KNOWN PARTS list, copy its geometry, pins and features exactly and keep source "library".
- Otherwise use the datasheet if you know it (put its url in source), else estimate and set estimated true with source "estimate".
- pins: only the ones a person touches. label exactly as printed on the board. side is which edge of the board, seen from above; index counts along that edge (top/bottom: left to right, left/right: far to near), in the physical order they appear.
- color is the board's real colour as a hex string.

Steps
- One physical action per step: plug one cable, or connect the wires between one pair of parts.
- instruction: one or two plain sentences. Say wire colours when they're known. No jargon without a few words of explanation.
- connections: pin to pin, using part ids and pin ids. wire is the real colour if known, else "".
- show: every part id visible from this step on.
- focus: part ids or "partid.pinid" to look at.
- caution: anything that can damage a part (power, polarity, 5V vs 3.3V, the wrong pin), else "".
- check: what to verify before moving on, else "". Before anything gets powered for the first time, the check is to take a photo of the wiring.
- Things the plan says were confirmed on the real hardware beat datasheet assumptions.`;

const FIRST_LOOK = `You're looking at a photo someone took while assembling electronics. Decide:
- quality: "retake" only if it's too blurry, dark or far away to tell what the parts are. Then say in retake exactly how to take it better (closer to what, more light, hold still, straight on).
- seen: what's in the photo, in one or two plain sentences.
- zoom: up to 4 regions with small printed text worth reading closely (pin labels, chip markings, part numbers, wire colours at a connector, QR codes), as boxes in 0..1 image coordinates (x0, y0 top-left; x1, y1 bottom-right). Leave room around the text.`;

const CLOSE_LOOK = `You're helping someone assemble electronics, step by step. You get their photo, close-up crops of the small text in it, and the guide they're following.
- labels: every piece of text you can read, with where it is ("next to the white socket, top to bottom").
- parts: ids from the guide you can see in the photo.
- verdict: does what you see match the current step's connections? "ok", "wrong", "unsure" when you can't tell, "none" if the photo isn't about wiring.
- explanation: one to three plain sentences. If something's wrong, say exactly what to move where.
- visual: what to show on the drawing to explain it: focus (part ids or "partid.pinid"), connections to animate (use guide ids), step to jump to or null.
- If even the crops aren't readable, set quality "retake" and say how to take it better.
Be precise about colours and positions; real boards often differ from datasheets, and what's printed on the board wins.`;

const ASK = `You're the assistant inside a visual assembly guide for electronics. Someone is following the guide and asks a question, sometimes with a photo.
- reply: short and plain, like a friend who knows electronics. Two to four sentences.
- visual: show the answer on the 3D drawing instead of describing it: focus on the parts or pins you mention ("partid.pinid"), animate the connections that matter, or jump to a step (index from 0). Use only ids from the guide.
If the guide doesn't cover what they're asking, still answer, and use focus to point at the closest parts.`;

export async function buildGuide(session: Session) {
  session.building = true;
  session.buildError = '';
  changed(session);
  try {
    const known = mentioned(session.plan).map((k) => k.part);
    const prompt =
      `PLAN\n${session.plan}\n\n` +
      (known.length ? `KNOWN PARTS (copy exactly)\n${JSON.stringify(known, null, 1)}` : 'KNOWN PARTS\nnone');
    const guide = await json<Guide>({ name: 'guide', system: GUIDE, user: prompt, schema: schemas.guide });
    session.guide = guide;
    session.step = 0;
  } catch (error) {
    session.buildError = (error as Error).message;
  } finally {
    session.building = false;
    changed(session);
  }
}

type FirstLook = { quality: 'good' | 'retake'; retake: string; seen: string; zoom: { box: Box; why: string }[] };
type Box = { x0: number; y0: number; x1: number; y1: number };

/** a quick look at the whole photo, then zoom in on the small text and read it */
export async function readPhoto(session: Session, photo: Photo, question = '') {
  try {
    const full = await readFile(path.join(folder(session.id), photo.file));
    const overview = await sharp(full).resize({ width: 1600, height: 1600, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();

    const first = await json<FirstLook>({
      name: 'first_look',
      system: FIRST_LOOK,
      user: [text(question ? `They asked: ${question}` : 'Here is the photo.'), image(overview)],
      schema: schemas.firstLook,
    });

    const crops: Buffer[] = [];
    for (const [i, region] of first.zoom.slice(0, 4).entries()) {
      const crop = await zoomInto(full, region.box);
      if (!crop) continue;
      const name = `${photo.id}-zoom${i}.jpg`;
      await writeFile(path.join(folder(session.id), name), crop);
      photo.crops.push(name);
      crops.push(crop);
    }
    changed(session);

    const content: Content = [
      text(guideContext(session)),
      text(question ? `They asked: ${question}` : 'They took this photo.'),
      image(overview),
      ...crops.flatMap((crop, i) => [text(`Close-up ${i + 1}: ${first.zoom[i]?.why ?? ''}`), image(crop)]),
    ];
    const close = await json<PhotoAnalysis>({ name: 'close_look', system: CLOSE_LOOK, user: content, schema: schemas.closeLook });
    photo.analysis = close;
    photo.status = close.quality === 'retake' ? 'retake' : 'done';
    say(session, close.quality === 'retake' ? `Can you retake that one? ${close.retake}` : close.explanation, photo.id, close.visual);
  } catch (error) {
    photo.status = 'error';
    photo.error = (error as Error).message;
    say(session, photo.error, photo.id, null);
  }
  changed(session);
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

export async function ask(session: Session, question: string, photo: Photo | null) {
  session.thinking = true;
  changed(session);
  try {
    const recent = session.messages
      .slice(-8)
      .map((m) => `${m.role}: ${m.text}`)
      .join('\n');
    const seen = photo?.analysis
      ? `\nTheir photo: ${photo.analysis.seen} Labels read: ${photo.analysis.labels.map((l) => `${l.where}: ${l.text}`).join('; ')}`
      : '';
    const reply = await json<{ reply: string; visual: Visual }>({
      name: 'answer',
      system: ASK,
      user: `${guideContext(session)}\n\nConversation so far:\n${recent}${seen}\n\nQuestion: ${question}`,
      schema: schemas.answer,
    });
    say(session, reply.reply, null, reply.visual);
  } catch (error) {
    say(session, (error as Error).message, null, null);
  } finally {
    session.thinking = false;
    changed(session);
  }
}

function guideContext(session: Session) {
  if (!session.guide) return 'There is no guide yet; they have not described what they are building.';
  const step = session.guide.steps[session.step];
  return `GUIDE\n${JSON.stringify(session.guide)}\n\nThey are on step ${session.step}: ${step?.title ?? ''}`;
}

export function say(session: Session, message: string, photo: string | null, visual: Visual | null, role: Message['role'] = 'guide') {
  session.messages.push({ id: id(8), role, text: message, photo, visual, createdAt: Date.now() });
  changed(session);
}
