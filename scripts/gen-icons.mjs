// Generates the Orbitabs brand assets as dependency-free PNGs.
// Run: node scripts/gen-icons.mjs
//
// Brand concept — "Tabs → organized → preserved → orbit":
// an orbit ring carrying THREE tab-like satellite dots around a preserved
// core. The ring = the orbit (preservation), the three dots = tab groups
// (organization). Deliberately simple: reads clearly at 16px in the toolbar.
//
// Brand system (see src/index.css tokens):
//   Primary logo   = icon + wordmark ("Orbitabs", Inter 700)  — header
//   Icon-only logo = this mark (16/32/48/128)                 — toolbar, favicon
//   Wordmark       = "Orbitabs" text, never outlined          — docs, store
//   Heading font   = Inter 700; UI text = Inter 400/500/600
//   Radius         = cards 14px · controls 10px · pills full
//   Accent         = Royal Blue #a855f7 (light) / #e879f9 (dark)
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

/* ---- minimal PNG encoder (RGBA, no interlace) ---- */
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
};
const png = (S, pixel) => {
  const raw = Buffer.alloc(S * (1 + S * 4));
  let p = 0;
  for (let y = 0; y < S; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < S; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, S);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/* ------------------------------------------------------------------ *
 * Orbitabs mark
 * Rounded square, vertical gradient #a855f7 → #ec4899.
 * White orbit ring (radius .30) + white core planet + THREE small
 * white satellite dots riding the ring (tabs/groups, organized).
 * The three dots start at 48px so they never muddy the 16px toolbar
 * read — small sizes show ring + core, which is the recognizable part.
 * ------------------------------------------------------------------ */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const blend = (c, tr, tg, tb, k) => {
  if (k <= 0) return c;
  const K = clamp01(k);
  return [
    Math.round(c[0] * (1 - K) + tr * K),
    Math.round(c[1] * (1 - K) + tg * K),
    Math.round(c[2] * (1 - K) + tb * K),
    c[3],
  ];
};

const draw = (fx, fy, S) => {
  const nx = fx / S, ny = fy / S;
  const cx = nx - 0.5, cy = ny - 0.5;
  const d = Math.hypot(cx, cy);

  // rounded-rect mask (signed distance, antialiased edge)
  const r = 0.22, hx = Math.abs(cx) - (0.5 - r), hy = Math.abs(cy) - (0.5 - r);
  const dist = Math.hypot(Math.max(hx, 0), Math.max(hy, 0)) + Math.min(Math.max(hx, hy), 0) - r;
  const alpha = clamp01((0.006 - dist) / 0.006);
  if (alpha <= 0) return [0, 0, 0, 0];

  // vertical gradient #a855f7 → #ec4899 (purple → pink) — NUMBERS must match
  let color = [
    Math.round(168 + (236 - 168) * ny),
    Math.round(85 + (72 - 85) * ny),
    Math.round(247 + (153 - 247) * ny),
    255,
  ];

  // orbit ring (soft white band at radius .30)
  const ring = Math.abs(d - 0.30);
  if (ring < 0.055) color = blend(color, 255, 255, 255, clamp01((0.055 - ring) / 0.015) * 0.95);

  // preserved core
  if (d < 0.105) color = [255, 255, 255];

  // THREE satellite dots on the ring — the "organized tabs" (>= 48px only)
  if (S >= 48) {
    const dots = [
      [0.5 + 0.30 * Math.SQRT1_2, 0.5 - 0.30 * Math.SQRT1_2], // upper-right
      [0.5 - 0.30, 0.5],                                      // left
      [0.5 + 0.30 * Math.SQRT1_2, 0.5 + 0.30 * Math.SQRT1_2], // lower-right
    ];
    for (const [dx, dy] of dots) {
      const sd = Math.hypot(nx - dx, ny - dy);
      if (sd < 0.055) color = blend(color, 255, 255, 255, clamp01((0.055 - sd) / 0.015));
    }
  } else {
    // single satellite (upper-right, amber) keeps the 16/32px marks lively
    const sx = 0.5 + 0.30 * Math.SQRT1_2, sy = 0.5 - 0.30 * Math.SQRT1_2;
    const sd = Math.hypot(nx - sx, ny - sy);
    if (sd < 0.055) color = blend(color, 245, 158, 11, clamp01((0.055 - sd) / 0.015));
  }

  return [color[0], color[1], color[2], color[3]];
};

for (const S of [16, 32, 48, 128]) {
  const file = join(outDir, `icon${S}.png`);
  writeFileSync(file, png(S, draw));
  console.log(`✓ ${file}`);
}

// favicon for the dev preview page (browser tab)
copyFileSync(join(outDir, 'icon32.png'), join(root, 'public', 'favicon.png'));
console.log('✓ public/favicon.png');
