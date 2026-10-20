import * as THREE from 'three';

// the drawing's palette: dark lines on white, system red for "do this now", real wire colours

export const ink = '#1d1d1f';
export const paper = '#ffffff';
export const red = '#ff3b30';

const wireColors: Record<string, string> = {
  black: '#1b1b1b',
  red: '#d2392b',
  white: '#f4f4f0',
  yellow: '#e8c22a',
  orange: '#e8862a',
  green: '#3f9a4f',
  blue: '#3a63c9',
  purple: '#7d4fc0',
  brown: '#7a4d2b',
  grey: '#8b8b86',
  gray: '#8b8b86',
};

export const wireColor = (name: string) => wireColors[name.trim().toLowerCase()] ?? '#9a9a94';

/** a board's colour, mostly washed out to paper so the drawing stays ink-first */
export function tint(hex: string, amount = 0.14) {
  const base = new THREE.Color(paper);
  try {
    return base.lerp(new THREE.Color(hex), amount);
  } catch {
    return base;
  }
}

export const fill = (color: THREE.ColorRepresentation) =>
  new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

export const lines = (color: THREE.ColorRepresentation = ink) =>
  new THREE.LineBasicMaterial({ color, transparent: true });

/** a solid with its outline drawn, like a technical drawing */
export function outlined(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, edge: THREE.ColorRepresentation = ink) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(geometry, fill(color));
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), lines(edge));
  outline.userData.outline = true;
  group.add(body, outline);
  return group;
}

/** flat text lying on a surface, like the printing on a circuit board */
export function silkscreen(text: string, height: number, color = ink, align: CanvasTextAlign = 'center') {
  const scale = 64;
  const font = `600 ${scale}px ui-monospace, "SF Mono", Menlo, monospace`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const width = Math.ceil(measure.measureText(text).width) + 8;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = scale + 16;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, 4, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  const w = (height * canvas.width) / canvas.height;
  const geometry = new THREE.PlaneGeometry(w, height).rotateX(-Math.PI / 2);
  if (align === 'left') geometry.translate(w / 2, 0, 0);
  if (align === 'right') geometry.translate(-w / 2, 0, 0);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
}

export const easeGlide = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 5);
export const easeExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * Math.max(0, t)));
export const easeInOut = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
