/**
 * Icon generator.
 *
 * Writes the toolbar PNGs from a vector description so the mark can be edited
 * in one place instead of in four bitmaps. Uses only node:zlib, because a
 * project that promises zero dependencies should not acquire one to draw a
 * 16-pixel funnel.
 *
 * Renders at 4x and box-downsamples, which is enough antialiasing for a mark
 * this simple.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BG = [0x14, 0x18, 0x1f];      // near-black badge, legible on light and dark toolbars
const FG = [0xf2, 0xa3, 0x3c];      // saffron
const MESH = [0x8b, 0x93, 0xa1];    // muted, for the mesh line

const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = (c >>> 8) ^ CRC[(c ^ b) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes RGBA pixels (Uint8Array, w*h*4) as a PNG buffer. */
function png(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The mark: a funnel with a mesh across its throat and one drop below.
 * Coordinates are normalised so the same description renders at any size.
 */
function sample(x, y) {
  // x, y in [0,1). Returns [r,g,b,a] or null for "background".
  const inRounded = (() => {
    const r = 0.22;
    const dx = Math.min(x, 1 - x);
    const dy = Math.min(y, 1 - y);
    if (dx >= r || dy >= r) return true;
    return (r - dx) ** 2 + (r - dy) ** 2 <= r * r;
  })();
  if (!inRounded) return null;

  // Funnel: a trapezoid from a wide mouth down to a narrow throat.
  const mouthY = 0.24, throatY = 0.60;
  const mouthHalf = 0.30, throatHalf = 0.065;
  // Rim across the mouth, so the shape reads as a vessel rather than a "V".
  if (y >= mouthY - 0.045 && y < mouthY + 0.018 && Math.abs(x - 0.5) <= mouthHalf) return FG;
  if (y >= mouthY && y <= throatY) {
    const t = (y - mouthY) / (throatY - mouthY);
    const half = mouthHalf + (throatHalf - mouthHalf) * t;
    const d = Math.abs(x - 0.5);
    const wall = 0.072 * (1 - 0.40 * t);
    if (d <= half && d >= half - wall) return FG;
    // The mesh line across the throat: this is the sieve, the part that filters.
    if (Math.abs(y - 0.375) < 0.030 && d < half - wall) {
      return Math.floor(((x - 0.5 + 0.5) * 22)) % 2 === 0 ? MESH : null;
    }
  }

  // Spout below the throat.
  if (y > throatY && y <= 0.70 && Math.abs(x - 0.5) <= throatHalf) return FG;

  // The one drop that made it through.
  const dropY = 0.83, dropR = 0.072;
  if ((x - 0.5) ** 2 + (y - dropY) ** 2 <= dropR * dropR) return FG;

  return null;
}

const SS = 4; // supersample factor
function render(size) {
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = sample(x, y);
          const bg = (() => {
            const rr = 0.22;
            const dx = Math.min(x, 1 - x), dy = Math.min(y, 1 - y);
            const inside = dx >= rr || dy >= rr
              ? true
              : (rr - dx) ** 2 + (rr - dy) ** 2 <= rr * rr;
            return inside ? BG : null;
          })();
          const px4 = c ?? bg;
          if (px4) { r += px4[0]; g += px4[1]; b += px4[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (a === 0) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; continue; }
      out[i] = Math.round(r / (a / 255));
      out[i + 1] = Math.round(g / (a / 255));
      out[i + 2] = Math.round(b / (a / 255));
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(dir, `icon-${size}.png`), png(size, size, render(size)));
}
console.log('chhanni: wrote icon-16/32/48/128.png');
