// Draws the icons of the app (the manifest, the home screen, the notifications) from one drawing: a bar of gold on the dark
// background of the app. No image library and no browser: a few polygons, rasterised with 4 x 4 samples per pixel and written
// as PNG. The files it makes are in the repository (apps/web/public); run it again only to change the drawing:
//   node apps/web/scripts/make-icons.mjs
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

const BACKGROUND = [0x0b, 0x0f, 0x14];
const GOLD = [0xd9, 0xa4, 0x41];
const GOLD_LIGHT = [0xf1, 0xcf, 0x86];
const WHITE = [0xff, 0xff, 0xff];

// The drawing on a square of 100 x 100: a bar of gold seen from above and in front, in the middle.
const FRONT = [
  [22, 65],
  [78, 65],
  [70, 47],
  [30, 47],
];
const TOP = [
  [30, 47],
  [70, 47],
  [63, 35],
  [37, 35],
];

function inside(polygon, x, y) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

function insideRounded(x, y, radius) {
  if (x < 0 || x > 100 || y < 0 || y > 100) return false;
  if (radius === 0) return true;
  const cx = Math.min(Math.max(x, radius), 100 - radius);
  const cy = Math.min(Math.max(y, radius), 100 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** The pixels of one icon: `radius` rounds the corners of the background, `scale` shrinks the drawing, `mono` is a white drawing on nothing. */
function draw(size, { radius = 0, scale = 1, mono = false }) {
  const samples = 4;
  const data = Buffer.alloc(size * size * 4);
  const place = (value) => (value - 50) / scale + 50;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = ((px + (sx + 0.5) / samples) / size) * 100;
          const y = ((py + (sy + 0.5) / samples) / size) * 100;
          const u = place(x);
          const v = place(y);
          let colour = null;
          if (mono) {
            if (inside(FRONT, u, v) || inside(TOP, u, v)) colour = WHITE;
          } else if (inside(TOP, u, v)) colour = GOLD_LIGHT;
          else if (inside(FRONT, u, v)) colour = GOLD;
          else if (insideRounded(x, y, radius)) colour = BACKGROUND;
          if (colour !== null) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 1;
          }
        }
      }
      const at = (py * size + px) * 4;
      if (a > 0) {
        data[at] = Math.round(r / a);
        data[at + 1] = Math.round(g / a);
        data[at + 2] = Math.round(b / a);
      }
      data[at + 3] = Math.round((a / (samples * samples)) * 255);
    }
  }
  return data;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = ([r, g, b]) =>
  `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
const points = (polygon) => polygon.map(([x, y]) => `${x},${y}`).join(' ');

const icons = [
  // `any`: the rounded square. `maskable`: the whole square, with the drawing inside the safe zone. Apple draws its own corners.
  ['icons/icon-192.png', 192, { radius: 22 }],
  ['icons/icon-512.png', 512, { radius: 22 }],
  ['icons/icon-maskable-512.png', 512, { scale: 0.8 }],
  ['icons/apple-touch-icon.png', 180, {}],
  // the badge of a notification on Android: a white drawing on nothing, which the system colours
  ['icons/badge-96.png', 96, { mono: true }],
];

mkdirSync(join(PUBLIC, 'icons'), { recursive: true });
for (const [name, size, options] of icons) {
  writeFileSync(join(PUBLIC, name), png(size, draw(size, options)));
}

writeFileSync(
  join(PUBLIC, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="${hex(BACKGROUND)}"/>
  <polygon points="${points(FRONT)}" fill="${hex(GOLD)}"/>
  <polygon points="${points(TOP)}" fill="${hex(GOLD_LIGHT)}"/>
</svg>
`,
);
process.stdout.write(`wrote ${String(icons.length)} icons and favicon.svg to ${PUBLIC}\n`);
