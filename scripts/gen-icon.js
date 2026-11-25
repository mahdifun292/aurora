'use strict';

/* Generates build/icon.png (512×512) with zero dependencies. */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const S = 512;

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function smooth(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

const W = S;
const H = S;
const data = Buffer.alloc(W * H * 4);

const violet = [167, 139, 250];
const cyan = [34, 211, 238];
const ink1 = [22, 19, 40];
const ink2 = [7, 7, 13];

for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const px = x + 0.5;
    const py = y + 0.5;
    const dx = px - W / 2;
    const dy = py - H / 2;
    const dist = Math.hypot(dx, dy);

    // rounded-square background
    const r = 118;
    const bx = Math.abs(dx) - (W / 2 - 44 - r);
    const by = Math.abs(dy) - (H / 2 - 44 - r);
    const outside = Math.hypot(Math.max(bx, 0), Math.max(by, 0)) + Math.min(Math.max(bx, by), 0) - r;
    const bgAlpha = 1 - smooth(-1.5, 1.5, outside);

    // background gradient + vignette + soft colour bloom
    const g = clamp01((px + py) / (W * 2));
    let col = mix(ink1, ink2, g);
    const bloom = Math.exp(-(Math.hypot(dx + 60, dy + 90) ** 2) / (2 * 210 ** 2));
    col = [
      Math.min(255, col[0] + 62 * bloom),
      Math.min(255, col[1] + 26 * bloom),
      Math.min(255, col[2] + 96 * bloom),
    ];
    const bloom2 = Math.exp(-(Math.hypot(dx - 150, dy - 190) ** 2) / (2 * 170 ** 2));
    col = [
      Math.min(255, col[0] + 16 * bloom2),
      Math.min(255, col[1] + 66 * bloom2),
      Math.min(255, col[2] + 80 * bloom2),
    ];

    // subtle inner border
    const border = smooth(-2, 1, Math.abs(outside + 2)) * (1 - smooth(-2, 1, outside + 5));
    col = mix(col, [255, 255, 255], border * 0.08);

    // ring
    const ringR = 152;
    const ringW = 17;
    const ringD = Math.abs(dist - ringR);
    const ringA = (1 - smooth(ringW - 2.2, ringW + 2.2, ringD)) * bgAlpha;
    const angle = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
    const ringCol = mix(violet, cyan, clamp01(0.5 + 0.5 * Math.sin(angle * Math.PI * 2 + 0.7)));
    col = mix(col, ringCol, ringA);

    // bright highlight on the top-right arc
    const dot = (dx * 0.62 + dy * -0.78) / (dist || 1);
    const arcMask = (1 - smooth(ringW - 1.4, ringW + 1.4, ringD))
      * Math.pow(Math.max(0, dot), 3.2) * 0.6;
    col = mix(col, [255, 255, 255], arcMask);

    // centre disc
    const dotA = 1 - smooth(60, 63.5, dist);
    if (dotA > 0) {
      const dotCol = mix(mix(violet, cyan, 0.35), [255, 255, 255], 0.15);
      col = mix(col, dotCol, dotA);
      const glow = Math.exp(-((dist - 64) ** 2) / (2 * 34 ** 2));
      col = [Math.min(255, col[0] + 40 * glow), Math.min(255, col[1] + 40 * glow), Math.min(255, col[2] + 60 * glow)];
    }

    // outer glow around the ring
    const glowA = Math.exp(-((dist - ringR) ** 2) / (2 * 46 ** 2)) * 0.22 * bgAlpha;
    col = [Math.min(255, col[0] + ringCol[0] * glowA), Math.min(255, col[1] + ringCol[1] * glowA), Math.min(255, col[2] + ringCol[2] * glowA)];

    // sparkles
    const sparks = [[360, 120, 9], [128, 372, 6], [388, 330, 5]];
    for (const [sx, sy, sr] of sparks) {
      const sd = Math.hypot(px - sx, py - sy);
      const sa = (1 - smooth(sr - 1.6, sr + 1.6, sd)) * 0.85;
      if (sa > 0) col = mix(col, [255, 255, 255], sa);
    }

    const alpha = Math.round(clamp01(bgAlpha) * 255);
    const i = (y * W + x) * 4;
    data[i] = Math.round(clamp01(col[0] / 255) * 255);
    data[i + 1] = Math.round(clamp01(col[1] / 255) * 255);
    data[i + 2] = Math.round(clamp01(col[2] / 255) * 255);
    data[i + 3] = alpha;
  }
}

/* --- PNG encode --- */
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
  return Buffer.concat([len, t, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 4 + 1)] = 0;
  data.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log(`icon written: ${path.join(outDir, 'icon.png')} (${png.length} bytes)`);
