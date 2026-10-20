import * as THREE from 'three';
import { MESH } from '../shared/manual.js';
import type { Part, Vec3 } from '../shared/types.js';

// Reading a build's own design files, so the drawing is the real thing rather than boxes.
// A URDF (what robots like arms and hands publish) lists every physical piece, its 3d file and
// exactly where it sits; each one becomes a part with its real mesh and its place in the build.
// Single 3d files (STL, OBJ, GLB, 3MF) are passed through as one part.

const MAX = 4_000_000;

/** fetches a public file, refusing anything that isn't plain http(s) to a public host */
async function download(url: string) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${url}: only http(s) links work`);
  if (process.env.VERCEL && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(parsed.hostname)) throw new Error(`${url}: not a public address`);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const text = await response.text();
  if (text.length > MAX) throw new Error(`${url}: too big to read`);
  return text;
}

export type CadPart = Part & { link?: string };

export async function readCad(url: string): Promise<{ parts: CadPart[]; summary: string }> {
  if (MESH.test(url)) {
    const name = basename(url);
    return {
      parts: [{ ...blank(slug(name), humanise(name)), mesh: { url, units: 'mm' }, source: url }],
      summary: 'One 3d file, one part. Give it a pose to place it in the build.',
    };
  }
  if (/\.urdf(\?.*)?$/i.test(url) || /\.xacro(\?.*)?$/i.test(url)) return readUrdf(url, await download(url));
  const text = await download(url);
  if (/<robot[\s>]/.test(text)) return readUrdf(url, text);
  throw new Error(`${url}: not a URDF or a 3d file this can read (.urdf, .stl, .obj, .glb, .gltf, .3mf)`);
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))?.[1];
const numbers = (value: string | undefined, fallback: Vec3): Vec3 => {
  const n = (value ?? '').trim().split(/\s+/).map(Number);
  return n.length === 3 && n.every(Number.isFinite) ? (n as Vec3) : fallback;
};

/** a urdf origin (metres, fixed-axis roll pitch yaw) as a matrix in millimetres */
function origin(block: string | undefined) {
  const tag = block?.match(/<origin\b[^>]*>/)?.[0] ?? '';
  const [x, y, z] = numbers(attr(tag, 'xyz'), [0, 0, 0]);
  const [r, p, yaw] = numbers(attr(tag, 'rpy'), [0, 0, 0]);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, yaw, 'ZYX'));
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z).multiplyScalar(1000), rotation, new THREE.Vector3(1, 1, 1));
}

function readUrdf(url: string, xml: string) {
  // comments go, except the "Part name" ones some exporters put before each piece
  const clean = xml.replace(/<!--([\s\S]*?)-->/g, (all, inner: string) => (/^\s*Part\s/.test(inner) ? all : ''));
  const colors = new Map<string, string>();
  for (const m of clean.matchAll(/<material\s+name="([^"]+)"\s*>\s*<color\s+rgba="([^"]+)"/g)) colors.set(m[1], rgba(m[2]));

  // where each link sits with every joint at zero: the robot as it's built
  const joints = [...clean.matchAll(/<joint\b[^>]*>([\s\S]*?)<\/joint>/g)].map((m) => ({
    parent: attr(m[1].match(/<parent\b[^>]*>/)?.[0] ?? '', 'link') ?? '',
    child: attr(m[1].match(/<child\b[^>]*>/)?.[0] ?? '', 'link') ?? '',
    origin: origin(m[1]),
  }));
  const links = [...clean.matchAll(/<link\s+name="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/link>)/g)].map((m) => ({ name: m[1], body: m[2] ?? '' }));
  const world = new Map<string, THREE.Matrix4>();
  const place = (name: string, seen = new Set<string>()): THREE.Matrix4 => {
    if (world.has(name)) return world.get(name)!;
    const joint = joints.find((j) => j.child === name);
    if (!joint || seen.has(name)) return world.set(name, new THREE.Matrix4()).get(name)!;
    seen.add(name);
    const matrix = place(joint.parent, seen).clone().multiply(joint.origin);
    world.set(name, matrix);
    return matrix;
  };

  const parts: CadPart[] = [];
  const used = new Map<string, number>();
  for (const link of links) {
    const linkWorld = place(link.name);
    // each visual is one physical piece; onshape exports name it in a comment just before
    for (const v of link.body.matchAll(/(?:<!--\s*Part\s+([^\s-][^>]*?)\s*-->\s*)?<visual\b[^>]*>([\s\S]*?)<\/visual>/g)) {
      const body = v[2];
      const file = attr(body.match(/<mesh\b[^>]*>/)?.[0] ?? '', 'filename');
      if (!file) continue;
      const meshUrl = resolve(url, file);
      const scale = numbers(attr(body.match(/<mesh\b[^>]*>/)?.[0] ?? '', 'scale'), [1, 1, 1]);
      const named = v[1]?.trim() || basename(file);
      let id = slug(named);
      const n = (used.get(id) ?? 0) + 1;
      used.set(id, n);
      if (n > 1) id = `${id}-${n}`;
      const matrix = linkWorld.clone().multiply(origin(body));
      const at = new THREE.Vector3();
      const q = new THREE.Quaternion();
      matrix.decompose(at, q, new THREE.Vector3());
      const turn = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      const materialName = attr(body.match(/<material\b[^>]*>/)?.[0] ?? '', 'name');
      const inline = body.match(/<color\s+rgba="([^"]+)"/)?.[1];
      parts.push({
        ...blank(id, humanise(named)),
        model: basename(file),
        kind: 'other',
        color: inline ? rgba(inline) : (colors.get(materialName ?? '') ?? '#c9c9c9'),
        // urdf meshes are in metres, unless scaled by 0.001 because the file is in millimetres
        mesh: { url: meshUrl, units: Math.abs(scale[0] - 0.001) < 1e-9 ? 'mm' : 'm' },
        pose: { at: round([at.x, at.y, at.z]), turn: round([deg(turn.x), deg(turn.y), deg(turn.z)]) },
        source: url,
        link: link.name,
      });
    }
  }
  const robot = attr(clean.match(/<robot\b[^>]*>/)?.[0] ?? '', 'name') ?? 'robot';
  return {
    parts,
    summary: `${robot}: ${parts.length} pieces across ${links.length} links, placed where they sit with every joint at zero.`,
  };
}

function blank(id: string, name: string): CadPart {
  return { id, name, model: name, kind: 'other', size: { w: 0, h: 0, t: 0 }, color: '#c9c9c9', pitch: 2.54, pins: [], features: [], estimated: false, source: '', note: '' };
}

/** package://name/path and relative paths, against the urdf's own address */
function resolve(base: string, file: string) {
  if (/^https?:\/\//.test(file)) return file;
  const path = file.replace(/^package:\/\/[^/]+\//, '').replace(/^file:\/\//, '');
  return new URL(path, base).toString();
}

const basename = (path: string) => decodeURIComponent(path.split(/[?#]/)[0].split('/').pop() ?? path).replace(/\.[a-z0-9]+$/i, '');
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'part';
const humanise = (value: string) =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\bv\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
const deg = (radians: number) => (radians * 180) / Math.PI;
const round = (v: number[]): Vec3 => v.map((n) => Math.round(n * 1000) / 1000) as Vec3;
const rgba = (value: string) => {
  const [r, g, b] = value.trim().split(/\s+/).map(Number);
  return `#${[r, g, b].map((c) => Math.round(Math.min(1, Math.max(0, c || 0)) * 255).toString(16).padStart(2, '0')).join('')}`;
};
