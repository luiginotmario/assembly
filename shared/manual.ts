import { library } from './library.js';
import type { Approach, Connection, End, Fastener, Feature, Guide, Mesh, Part, Pin, Placement, Pose, Side, Source, Step, Vec3, View } from './types.js';

// What an agent sends to make a manual, checked and filled in. Optional fields get sensible
// defaults; anything that would draw wrong (a wire to a pin that doesn't exist, a part with
// no size) comes back as an error that says exactly what to fix. Parts we've verified on real
// boards replace whatever geometry was sent for them.

export type Draft = {
  title?: unknown;
  summary?: unknown;
  parts?: unknown;
  steps?: unknown;
};

export type Checked = { guide: Guide; errors: string[]; warnings: string[] };

const SIDES: Side[] = ['top', 'bottom', 'left', 'right'];
const KINDS: Part['kind'][] = ['board', 'adapter', 'sensor', 'cable', 'computer', 'other'];
const STYLES: Pin['style'][] = ['header', 'socket', 'pad'];
const FEATURES: Feature['kind'][] = ['usb-a', 'usb-c', 'socket', 'chip', 'antenna'];
const APPROACHES: Approach[] = ['above', 'below', 'front', 'back', 'left', 'right'];
const VIEWS: View[] = ['iso', 'iso-back', 'front', 'back', 'left', 'right', 'top', 'bottom'];
const FASTENERS: Fastener['kind'][] = ['screw', 'bolt', 'nut', 'washer', 'insert', 'standoff', 'zip tie', 'other'];
const UNITS: Mesh['units'][] = ['mm', 'cm', 'm', 'in'];
const FINISHES = ['matte', 'gloss', 'metal'] as const;
/** 3d files the drawing can load */
export const MESH = /\.(stl|obj|glb|gltf|3mf)(\?.*)?$/i;
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** pins can be referred to by id or by their printed label, in any case or punctuation */
const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9+]/g, '');
const loose = (value: string) => key(value).replace(/^\+/, '');

const sameModel = (a: string, b: string) => {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))));
};

/** the verified part this one is, if any, by its model number (generic names like "usb to ttl" don't count) */
export const verified = (model: string) =>
  library.find((k) => k.aliases.some((a) => /\d/.test(a) && sameModel(a, model)));

export function check(draft: Draft): Checked {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = (value: unknown, path: string, max: number, required = false) => {
    if (value === undefined || value === null || value === '') {
      if (required) errors.push(`${path} is required`);
      return '';
    }
    if (typeof value !== 'string') {
      errors.push(`${path} must be a string`);
      return '';
    }
    if (value.length > max) errors.push(`${path} is longer than ${max} characters`);
    return value.trim();
  };
  const number = (value: unknown, path: string, fallback?: number) => {
    if (value === undefined || value === null) {
      if (fallback === undefined) errors.push(`${path} is required`);
      return fallback ?? 0;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${path} must be a number`);
      return fallback ?? 0;
    }
    return value;
  };
  const list = (value: unknown, path: string, max: number): unknown[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      errors.push(`${path} must be a list`);
      return [];
    }
    if (value.length > max) errors.push(`${path} has more than ${max} items`);
    return value.slice(0, max);
  };
  const object = (value: unknown, path: string): Record<string, unknown> => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    errors.push(`${path} must be an object`);
    return {};
  };
  const vec = (value: unknown, path: string, fallback?: Vec3): Vec3 => {
    if ((value === undefined || value === null) && fallback) return fallback;
    if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100000)) {
      return value as Vec3;
    }
    errors.push(`${path} must be three numbers [x, y, z]`);
    return fallback ?? [0, 0, 0];
  };
  const oneOf = <T extends string>(value: unknown, path: string, options: T[], fallback?: T): T => {
    if ((value === undefined || value === null || value === '') && fallback) return fallback;
    if (typeof value === 'string' && options.includes(value as T)) return value as T;
    errors.push(`${path} must be one of ${options.join(', ')}`);
    return fallback ?? options[0];
  };

  // ---------- parts ----------

  const rawParts = list(draft.parts, 'parts', 200);
  if (!rawParts.length) errors.push('parts: a manual needs at least one part');
  const parts: Part[] = [];
  // the pins as they were sent, for parts replaced by their verified geometry
  const sent = new Map<string, Pin[]>();
  for (const [i, raw] of rawParts.entries()) {
    const at = `parts[${i}]`;
    const p = object(raw, at);
    const id = text(p.id, `${at}.id`, 48, true);
    if (id && !ID.test(id)) errors.push(`${at}.id "${id}" must be short, lowercase letters, digits, - or _ (e.g. "usb1")`);
    if (parts.some((q) => q.id === id)) errors.push(`${at}.id "${id}" is used twice; two identical boards need different ids`);
    const name = text(p.name, `${at}.name`, 80, true);
    const size = object(p.size ?? {}, `${at}.size`);

    const pins: Pin[] = [];
    for (const [j, rawPin] of list(p.pins, `${at}.pins`, 120).entries()) {
      const pat = `${at}.pins[${j}]`;
      const q = object(rawPin, pat);
      const pinId = text(q.id ?? q.label, `${pat}.id`, 24, true);
      if (pins.some((x) => x.id === pinId)) errors.push(`${pat}.id "${pinId}" is used twice on ${id}`);
      const side = oneOf(q.side, `${pat}.side`, SIDES);
      const pin: Pin = {
        id: pinId,
        label: text(q.label, `${pat}.label`, 24) || pinId,
        side,
        index: Math.round(number(q.index, `${pat}.index`, pins.filter((x) => x.side === side).length)),
        style: oneOf(q.style, `${pat}.style`, STYLES, 'header'),
      };
      if (q.at !== undefined) {
        const spot = object(q.at, `${pat}.at`);
        pin.at = { u: clamp(number(spot.u, `${pat}.at.u`)), v: clamp(number(spot.v, `${pat}.at.v`)) };
      }
      pins.push(pin);
    }

    const features: Feature[] = list(p.features, `${at}.features`, 20).map((rawFeature, j) => {
      const f = object(rawFeature, `${at}.features[${j}]`);
      return {
        kind: oneOf(f.kind, `${at}.features[${j}].kind`, FEATURES),
        side: oneOf(f.side, `${at}.features[${j}].side`, SIDES),
        at: clamp(number(f.at, `${at}.features[${j}].at`, 0.5)),
        label: text(f.label, `${at}.features[${j}].label`, 40),
      };
    });

    const sources: Source[] = list(p.sources, `${at}.sources`, 10).flatMap((rawSource, j) => {
      const s = object(rawSource, `${at}.sources[${j}]`);
      const url = text(s.url, `${at}.sources[${j}].url`, 500, true);
      if (url && !/^https?:\/\//.test(url)) {
        errors.push(`${at}.sources[${j}].url must start with http:// or https://`);
        return [];
      }
      return url ? [{ url, title: text(s.title, `${at}.sources[${j}].title`, 200) || url }] : [];
    });

    let mesh: Mesh | undefined;
    if (p.mesh !== undefined && p.mesh !== null) {
      const m = object(p.mesh, `${at}.mesh`);
      const url = text(m.url, `${at}.mesh.url`, 1000, true);
      if (url && !/^https?:\/\//.test(url)) errors.push(`${at}.mesh.url must be a public http(s) link to the file`);
      else if (url && !MESH.test(url)) errors.push(`${at}.mesh.url must be an .stl, .obj, .glb, .gltf or .3mf file`);
      mesh = { url, units: oneOf(m.units, `${at}.mesh.units`, UNITS, 'mm') };
    }
    let pose: Pose | undefined;
    if (p.pose !== undefined && p.pose !== null) {
      const q = object(p.pose, `${at}.pose`);
      pose = { at: vec(q.at, `${at}.pose.at`), turn: vec(q.turn, `${at}.pose.turn`, [0, 0, 0]) };
    }

    const estimated = p.estimated === true;
    const part: Part = {
      id,
      name,
      model: text(p.model, `${at}.model`, 80) || name,
      kind: oneOf(p.kind, `${at}.kind`, KINDS, 'board'),
      // a 3d model knows its own size
      size: {
        w: number(size.w, `${at}.size.w`, mesh ? 0 : undefined),
        h: number(size.h, `${at}.size.h`, mesh ? 0 : undefined),
        t: number(size.t, `${at}.size.t`, mesh ? 0 : 1.6),
      },
      // without a colour: a green board, an aluminium computer, a dark cable, grey plastic
      color:
        text(p.color, `${at}.color`, 9) ||
        ({ computer: '#c8cacd', cable: '#2a2a2a', other: '#b9b9bd' } as Record<string, string>)[String(p.kind)] ||
        (mesh ? '#c9c9c9' : '#2a6f3a'),
      pitch: number(p.pitch, `${at}.pitch`, 2.54),
      pins,
      features,
      estimated,
      source: sources[0]?.url ?? (estimated ? 'estimate' : 'given'),
      note: text(p.note, `${at}.note`, 400),
      sources,
      ...(mesh ? { mesh } : {}),
      ...(pose ? { pose } : {}),
      ...(p.finish ? { finish: oneOf(p.finish, `${at}.finish`, [...FINISHES]) } : {}),
    };
    if (!/^#[0-9a-fA-F]{3,8}$/.test(part.color)) errors.push(`${at}.color must be a hex colour like "#1f5fbf"`);
    for (const dim of ['w', 'h', 't'] as const) {
      const ok = part.size[dim] > 0 || (mesh && part.size[dim] === 0);
      if (!ok || part.size[dim] >= 5000) errors.push(`${at}.size.${dim} must be between 0 and 5000 mm${mesh ? '' : ' (or give the part a mesh)'}`);
    }
    if (!(part.pitch > 0 && part.pitch < 50)) errors.push(`${at}.pitch must be between 0 and 50 mm`);

    // a board we've measured ourselves: our geometry wins, references to its pins still work
    const known = mesh ? undefined : verified(part.model);
    if (known) {
      Object.assign(part, structuredClone({ ...known.part, id: part.id, name: part.name }), { sources: [] });
      sent.set(part.id, pins);
    } else if (!estimated && !sources.length && !mesh) {
      warnings.push(`${at} (${id}): no sources. Look its datasheet or listing up and pass the pages in sources, or set estimated: true if the size and pins are a guess.`);
    }
    parts.push(part);
  }

  // ---------- steps ----------

  const byId = new Map(parts.map((p) => [p.id, p]));
  const pinOf = (part: Part, ref: string): Pin | undefined => {
    const exact = part.pins.find((p) => p.id === ref);
    if (exact) return exact;
    // by id or printed label, then loosely ("5V" is the pin printed "+5V")
    for (const norm of [key, loose]) {
      const k = norm(ref);
      const named = part.pins.find((p) => norm(p.id) === k || norm(p.label) === k);
      if (named) return named;
      // a pin named as it was sent, for a part replaced by its verified geometry
      const before = sent.get(part.id)?.find((p) => norm(p.id) === k || norm(p.label) === k);
      const mapped = before && part.pins.find((p) => norm(p.label) === norm(before.label) || norm(p.id) === norm(before.id));
      if (mapped) return mapped;
    }
    return undefined;
  };
  const end = (value: unknown, path: string): End => {
    const e = object(value, path);
    const partId = text(e.part, `${path}.part`, 32, true);
    const pin = text(e.pin, `${path}.pin`, 24);
    const part = byId.get(partId);
    if (!part) {
      if (partId) errors.push(`${path}.part: no part "${partId}" (parts: ${[...byId.keys()].join(', ')})`);
      return { part: partId, pin };
    }
    // no pin: the part itself (a motor's cable, an adapter's USB end)
    if (!pin) return { part: partId, pin: '' };
    const found = pinOf(part, pin);
    if (!found) {
      errors.push(`${path}.pin: no pin "${pin}" on ${partId} (its pins: ${part.pins.map((p) => p.id).join(', ') || 'none; add them to the part, or leave pin empty'})`);
      return { part: partId, pin };
    }
    return { part: partId, pin: found.id };
  };

  const partRef = (value: unknown, path: string) => {
    const id = text(value, path, 48, true);
    if (id && !byId.has(id)) errors.push(`${path}: no part "${id}"`);
    return id;
  };

  const rawSteps = list(draft.steps, 'steps', 120);
  if (!rawSteps.length) errors.push('steps: a manual needs at least one step');
  const steps: Step[] = rawSteps.map((raw, i) => {
    const at = `steps[${i}]`;
    const s = object(raw, at);
    const connections: Connection[] = list(s.connections, `${at}.connections`, 40).map((rawConnection, j) => {
      const c = object(rawConnection, `${at}.connections[${j}]`);
      const loose = c.loose === true;
      return {
        from: end(c.from, `${at}.connections[${j}].from`),
        // a cable plugged in at one end only has nothing at the other yet
        to: loose && !c.to ? { part: '', pin: '' } : end(c.to, `${at}.connections[${j}].to`),
        ...(loose ? { loose: true } : {}),
        wire: text(c.wire, `${at}.connections[${j}].wire`, 30),
        note: text(c.note, `${at}.connections[${j}].note`, 200),
        ...(c.temporary === true ? { temporary: true } : {}),
        ...(c.via ? { via: list(c.via, `${at}.connections[${j}].via`, 16).map((v, k) => (typeof v === 'string' ? partRef(v, `${at}.connections[${j}].via[${k}]`) : vec(v, `${at}.connections[${j}].via[${k}]`))) } : {}),
      };
    });
    const place: Placement[] = list(s.place, `${at}.place`, 40).map((rawPlace, j) => {
      const q = object(rawPlace, `${at}.place[${j}]`);
      const from = typeof q.from === 'string' || q.from === undefined ? oneOf(q.from, `${at}.place[${j}].from`, APPROACHES, 'above') : vec(q.from, `${at}.place[${j}].from`);
      return { part: partRef(q.part, `${at}.place[${j}].part`), from, distance: Math.max(0, number(q.distance, `${at}.place[${j}].distance`, 0)) };
    });
    const fasteners: Fastener[] = list(s.fasteners, `${at}.fasteners`, 20).map((rawFastener, j) => {
      const f = object(rawFastener, `${at}.fasteners[${j}]`);
      const count = Math.round(number(f.count, `${at}.fasteners[${j}].count`, 1));
      if (count < 1 || count > 999) errors.push(`${at}.fasteners[${j}].count must be 1 to 999`);
      return {
        kind: oneOf(f.kind, `${at}.fasteners[${j}].kind`, FASTENERS, 'screw'),
        size: text(f.size, `${at}.fasteners[${j}].size`, 40, true),
        count,
        into: f.into ? partRef(f.into, `${at}.fasteners[${j}].into`) : '',
        note: text(f.note, `${at}.fasteners[${j}].note`, 200),
      };
    });
    const times = Math.round(number(s.times, `${at}.times`, 1));
    if (times < 1 || times > 100) errors.push(`${at}.times must be 1 to 100`);
    const show = list(s.show, `${at}.show`, 60).map((v, j) => partRef(v, `${at}.show[${j}]`));
    const focus = list(s.focus, `${at}.focus`, 40).map((v, j) => {
      const target = text(v, `${at}.focus[${j}]`, 60, true);
      const [partId, ...rest] = target.split('.');
      const part = byId.get(partId);
      if (!part) {
        if (target) errors.push(`${at}.focus[${j}]: no part "${partId}"`);
        return target;
      }
      if (!rest.length) return partId;
      const pin = pinOf(part, rest.join('.'));
      if (!pin) errors.push(`${at}.focus[${j}]: no pin "${rest.join('.')}" on ${partId} (its pins: ${part.pins.map((p) => p.id).join(', ')})`);
      return pin ? `${partId}.${pin.id}` : target;
    });
    return {
      title: text(s.title, `${at}.title`, 120, true),
      instruction: text(s.instruction, `${at}.instruction`, 1000, true),
      show,
      connections,
      focus,
      caution: text(s.caution, `${at}.caution`, 600),
      check: text(s.check, `${at}.check`, 600),
      place,
      fasteners,
      view: s.view ? oneOf(s.view, `${at}.view`, VIEWS) : null,
      times,
    };
  });

  // nothing your hands do should go undrawn: a step that says it plugs, screws or solders
  // something must show it, and every part should turn up in some step
  const ACTION = /\b(plug|insert|push|connect|attach|screw|bolt|solder|mount|slide|seat|fit|clip|press|wire|route|fasten|tighten)\w*/i;
  steps.forEach((step, i) => {
    const drawn = step.connections.length + (step.place?.length ?? 0) + (step.fasteners?.length ?? 0);
    const verb = step.instruction.match(ACTION)?.[0];
    if (verb && !drawn) {
      warnings.push(`steps[${i}] ("${step.title}") says "${verb}" but draws nothing being done: add the connections (loose: true for a cable plugged in at one end only), place or fasteners so the drawing shows it.`);
    }
  });
  const used = new Set(steps.flatMap((s) => [...s.show, ...(s.place ?? []).map((p) => p.part), ...s.connections.flatMap((c) => [c.from.part, c.to.part]), ...s.focus.map((f) => f.split('.')[0])]));
  const unused = parts.filter((p) => !used.has(p.id)).map((p) => p.id);
  if (unused.length) warnings.push(`parts never used in a step: ${unused.join(', ')}. Every part should go in somewhere, or leave it out.`);

  const guide: Guide = {
    title: text(draft.title, 'title', 120, true),
    summary: text(draft.summary, 'summary', 600),
    parts,
    steps,
  };
  return { guide, errors, warnings };
}

/** parts the user photographed keep their photo when the agent updates the manual */
export function keepPhotos(next: Guide, before: Guide) {
  for (const part of next.parts) {
    const old = before.parts.find((p) => p.id === part.id && sameModel(p.model, part.model));
    if (old?.texture) {
      part.texture = old.texture;
      part.pins = old.pins;
      part.size = old.size;
    }
  }
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
