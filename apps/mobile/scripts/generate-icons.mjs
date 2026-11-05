#!/usr/bin/env node
/**
 * Generates the launcher/splash artwork from code, so the brand mark can be regenerated at any
 * resolution without design files or an image dependency (`sharp`, `canvas`).
 *
 * Output (committed, referenced by app.json and public/manifest.json):
 *   assets/icon.png           1024²  opaque — Android legacy icon, iOS icon, store listing
 *   assets/adaptive-icon.png  1024²  transparent — Android adaptive foreground (safe zone)
 *   assets/splash-icon.png    1024²  transparent — splash mark on the brand background
 *   assets/favicon.png          64²  opaque   — web/PWA favicon
 *   public/icon-192.png        192²  opaque   — PWA / apple-touch-icon
 *   public/icon-512.png        512²  opaque   — PWA
 *   public/icon-maskable-512.png 512² opaque  — PWA maskable (extra padding for the safe zone)
 *
 * Usage: node scripts/generate-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const BRAND = [15, 92, 77];      // #0F5C4D — primaryStrong, the brand green
const INK = [255, 255, 255];
const ACCENT = [45, 212, 191];   // #2DD4BF — sidebarIndicator

// ---------------------------------------------------------------- PNG encoding
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour + alpha
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace
  // One filter byte (0 = none) per scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- vector artwork
// Everything is expressed in a 0..1 box so one description renders at any pixel size.
// Back to front: later shapes are painted over earlier ones (the loop below walks this list in reverse).
const SHAPES = [
  // Handle first: the bag body overlaps its base, which is how a real bag looks.
  { kind: "ring", cx: 0.5, cy: 0.375, rOuter: 0.155, rInner: 0.113, clipAboveY: 0.37, color: INK },
  { kind: "roundRect", x0: 0.295, y0: 0.365, x1: 0.705, y1: 0.81, r: 0.075, color: INK },
  // A single accent bar inside the bag: reads as a receipt line and carries the brand teal.
  { kind: "roundRect", x0: 0.375, y0: 0.55, x1: 0.625, y1: 0.61, r: 0.03, color: ACCENT },
];

function insideRoundRect(x, y, s) {
  const { x0, y0, x1, y1, r } = s;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.min(x - x0, x1 - x);
  const dy = Math.min(y - y0, y1 - y);
  if (dx >= r || dy >= r) return true;
  const cx = dx < r && x < x0 + r ? x0 + r : x1 - r;
  const cy = dy < r && y < y0 + r ? y0 + r : y1 - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inside(x, y) {
  for (let i = SHAPES.length - 1; i >= 0; i--) {
    const s = SHAPES[i];
    if (s.kind === "roundRect" && insideRoundRect(x, y, s)) return s.color;
    if (s.kind === "ring") {
      if (s.clipAboveY !== undefined && y > s.clipAboveY) continue;
      const d = Math.hypot(x - s.cx, y - s.cy);
      if (d <= s.rOuter && d >= s.rInner) return s.color;
    }
  }
  return null;
}

/**
 * @param size      pixel dimension (square)
 * @param background opaque background colour, or null for transparency
 * @param glyph     scale of the mark inside the frame (Android adaptive art must stay in the safe zone)
 */
function render(size, background, glyph) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;                       // 4×4 supersampling: smooth edges at every size
  const offset = (1 - glyph) / 2;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;
          const gu = (u - offset) / glyph;
          const gv = (v - offset) / glyph;
          const stroke = gu >= 0 && gu <= 1 && gv >= 0 && gv <= 1 ? inside(gu, gv) : null;
          const base = background ?? [0, 0, 0];
          const col = stroke ?? base;
          const alpha = stroke ? 1 : background ? 1 : 0;
          // Source-over onto an accumulating average.
          r += col[0] * alpha; g += col[1] * alpha; b += col[2] * alpha; a += alpha;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      if (alpha > 0) {
        // Un-premultiply so semi-transparent edges keep the mark's colour, not a darkened one.
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------- write files
const root = path.resolve(import.meta.dirname, "..");
const dirs = { assets: path.join(root, "assets"), public: path.join(root, "public") };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

const outputs = [
  // Opaque: Android legacy launchers and the iOS App Store reject transparency in the icon.
  { dir: "assets", file: "icon.png", size: 1024, background: BRAND, glyph: 0.78 },
  // Adaptive foreground must keep the mark inside the 66% safe circle that any launcher mask shows.
  { dir: "assets", file: "adaptive-icon.png", size: 1024, background: null, glyph: 0.6 },
  { dir: "assets", file: "splash-icon.png", size: 1024, background: null, glyph: 0.52 },
  { dir: "assets", file: "favicon.png", size: 64, background: BRAND, glyph: 0.78 },
  { dir: "public", file: "icon-192.png", size: 192, background: BRAND, glyph: 0.78 },
  { dir: "public", file: "icon-512.png", size: 512, background: BRAND, glyph: 0.78 },
  // Maskable art is cropped by the platform, so the mark is drawn smaller to survive a circle/squircle mask.
  { dir: "public", file: "icon-maskable-512.png", size: 512, background: BRAND, glyph: 0.55 },
];

for (const o of outputs) {
  const png = encodePng(o.size, o.size, render(o.size, o.background, o.glyph));
  fs.writeFileSync(path.join(dirs[o.dir], o.file), png);
  console.log(`${(o.dir + "/" + o.file).padEnd(30)} ${o.size}×${o.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
