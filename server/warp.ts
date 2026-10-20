import sharp from 'sharp';

// Straightening a board out of a photo: given where its four corners are, every pixel of
// a flat, top-down rectangle is looked up in the photo through a homography (the maths
// for undoing camera perspective), so a board shot at an angle comes out square-on.

export type Point = { x: number; y: number };

/** solves the 3x3 homography that maps `from` points onto `to` points (4 pairs) */
function homography(from: Point[], to: Point[]) {
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // gaussian elimination with partial pivoting on the 8x9 augmented matrix
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const p = rows[col][col];
    if (Math.abs(p) < 1e-12) throw new Error('those corners do not make a board shape');
    for (let c = col; c < 9; c++) rows[col][c] /= p;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = rows[r][col];
      for (let c = col; c < 9; c++) rows[r][c] -= f * rows[col][c];
    }
  }
  const h = rows.map((r) => r[8]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Cuts the board out of the photo and returns it square-on, as a jpeg.
 * corners: in 0..1 image coordinates, in the board's own order: far-left, far-right,
 * near-right, near-left (so the image's top edge is the board's far edge).
 * aspect: the board's width divided by its depth.
 */
export async function straighten(photo: Buffer, corners: Point[], aspect: number) {
  const { data, info } = await sharp(photo)
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  const long = 1400;
  const outW = Math.round(aspect >= 1 ? long : long * aspect);
  const outH = Math.round(aspect >= 1 ? long / aspect : long);
  const source = corners.map((c) => ({ x: c.x * W, y: c.y * H }));
  const target = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  // map each output pixel back into the photo
  const m = homography(target, source);
  const out = Buffer.alloc(outW * outH * 3);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w = m[6] * px + m[7] * py + m[8];
      const sx = (m[0] * px + m[1] * py + m[2]) / w - 0.5;
      const sy = (m[3] * px + m[4] * py + m[5]) / w - 0.5;
      // bilinear sample
      const x0 = Math.max(0, Math.min(W - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(H - 1, Math.floor(sy)));
      const x1 = Math.min(W - 1, x0 + 1);
      const y1 = Math.min(H - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - y0));
      const o = (y * outW + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const a = data[(y0 * W + x0) * 3 + ch];
        const b = data[(y0 * W + x1) * 3 + ch];
        const c = data[(y1 * W + x0) * 3 + ch];
        const d = data[(y1 * W + x1) * 3 + ch];
        out[o + ch] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
  }
  return sharp(out, { raw: { width: outW, height: outH, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

/** a square crop around a point, scaled up, for placing a corner exactly */
export async function around(photo: Buffer, at: Point, size = 0.16) {
  const { width = 0, height = 0 } = await sharp(photo).metadata();
  const side = Math.round(Math.min(width, height) * size);
  const left = Math.round(Math.min(Math.max(0, at.x * width - side / 2), width - side));
  const top = Math.round(Math.min(Math.max(0, at.y * height - side / 2), height - side));
  const image = await sharp(photo).extract({ left, top, width: side, height: side }).resize(640, 640).jpeg({ quality: 90 }).toBuffer();
  /** a point in this crop (0..1) back in the whole photo (0..1) */
  const back = (p: Point): Point => ({ x: (left + p.x * side) / width, y: (top + p.y * side) / height });
  return { image, back };
}
