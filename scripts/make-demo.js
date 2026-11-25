'use strict';

/* Creates a small demo library for local testing. */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = process.argv[2] || '/tmp/aurora-music';
const userData = process.argv[3] || '/tmp/aurora-userdata';

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

function infoChunk(tags) {
  const fields = {
    INAM: tags.title,
    IART: tags.artist,
    IPRD: tags.album,
    ICRD: tags.year,
    ITRK: tags.track,
    IGNR: tags.genre,
  };
  const parts = [];
  for (const [id, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    const text = Buffer.from(String(value), 'utf8');
    const size = text.length + 1;
    const padded = size % 2 === 0 ? size : size + 1;
    const body = Buffer.alloc(padded);
    text.copy(body, 0);
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(size, 4);
    parts.push(head, body);
  }
  if (!parts.length) return Buffer.alloc(0);
  const body = Buffer.concat([Buffer.from('INFO', 'ascii'), ...parts]);
  const head = Buffer.alloc(8);
  head.write('LIST', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function wav(file, seconds, freqs, tags = {}) {
  const rate = 44100;
  const channels = 2;
  const frames = Math.floor(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    let v = 0;
    for (let f = 0; f < freqs.length; f += 1) {
      v += Math.sin(2 * Math.PI * freqs[f] * t + f) / (f + 2);
    }
    v *= 0.22;
    const attack = Math.min(1, t / 0.08);
    const release = Math.min(1, (seconds - t) / 0.4);
    const env = attack * Math.max(0, release);
    const sample = Math.round(Math.max(-1, Math.min(1, v * env)) * 32000);
    for (let c = 0; c < channels; c += 1) {
      data.writeInt16LE(sample + (c === 1 ? Math.round(sample * 0.15) : 0), (i * channels + c) * 2);
    }
  }
  const info = infoChunk(tags);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * 2, 16);
  fmt.writeUInt16LE(channels * 2, 20);
  fmt.writeUInt16LE(16, 22);

  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0);
  dataHead.writeUInt32LE(data.length, 4);

  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(4 + fmt.length + info.length + 8 + data.length, 4);
  riff.write('WAVE', 8);

  fs.writeFileSync(file, Buffer.concat([riff, fmt, info, dataHead, data]));
}

function lrc(file, lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  fs.writeFileSync(file, text, 'utf8');
}

/* --- tiny PNG encoder + abstract album art --- */

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

function pngChunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
  return Buffer.concat([len, t, body, crc]);
}

function savePng(file, size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, out);
}

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function cover(file, palette, { disc, hue }) {
  const size = 512;
  const data = Buffer.alloc(size * size * 4);
  const { top, bottom, glow, accent } = palette;
  const [gx, gy] = glow.at;
  const [dx, dy] = disc.at;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let col = mix(top, bottom, clamp01(v * 0.75 + u * 0.35));
      const bloom = Math.exp(-(((u - gx) ** 2 + (v - gy) ** 2) * 7));
      col = mix(col, glow.color, bloom * glow.strength);
      const band = Math.sin((u * 2.4 + v * 1.6) * Math.PI + hue) * 0.5 + 0.5;
      col = mix(col, accent, band * 0.12);
      const d = Math.hypot((u - dx) * 1.05, v - dy);
      const discMask = 1 - clamp01((d - 0.19) / 0.012);
      if (discMask > 0) col = mix(col, disc.color, discMask * 0.92);
      const halo = Math.exp(-((d - 0.225) ** 2) / 0.0009);
      col = mix(col, disc.color, halo * 0.18);
      const ring = Math.exp(-((d - 0.33) ** 2) / 0.00012) * 0.16;
      col = mix(col, [255, 255, 255], ring);
      const vignette = 1 - clamp01((Math.hypot(u - 0.5, v - 0.5) - 0.42) / 0.42) * 0.55;
      col = [col[0] * vignette, col[1] * vignette, col[2] * vignette];
      const grain = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
      const i = (y * size + x) * 4;
      const shade = (channel) => Math.max(0, Math.min(255, Math.round(clamp01(channel / 255) * 255 + (grain - 0.5) * 4)));
      data[i] = shade(col[0]);
      data[i + 1] = shade(col[1]);
      data[i + 2] = shade(col[2]);
      data[i + 3] = 255;
    }
  }
  savePng(file, size, data);
}

fs.mkdirSync(path.join(root, 'Afterglow'), { recursive: true });
fs.mkdirSync(path.join(root, 'Paper Moons'), { recursive: true });

wav(path.join(root, 'Afterglow', '01 - First Light.wav'), 26, [220, 277.18, 329.63], {
  title: 'First Light', artist: 'Aurora Ensemble', album: 'Afterglow', year: '2026', track: '1', genre: 'Dream Pop',
});
wav(path.join(root, 'Afterglow', '02 - Silver Lining.wav'), 21, [196, 246.94, 293.66], {
  title: 'Silver Lining', artist: 'Aurora Ensemble', album: 'Afterglow', year: '2026', track: '2', genre: 'Dream Pop',
});
wav(path.join(root, 'Afterglow', '03 - Midnight Drive.wav'), 32, [146.83, 174.61, 220], {
  title: 'Midnight Drive', artist: 'Aurora Ensemble', album: 'Afterglow', year: '2026', track: '3', genre: 'Dream Pop',
});
wav(path.join(root, 'Paper Moons', '01 - Paper Moons.wav'), 24, [261.63, 329.63, 392], {
  title: 'Paper Moons', artist: 'Lena Vale', album: 'Paper Moons', year: '2024', track: '1', genre: 'Indie Folk',
});
wav(path.join(root, 'Paper Moons', '02 - Slow Motion.wav'), 28, [174.61, 220, 261.63], {
  title: 'Slow Motion', artist: 'Lena Vale', album: 'Paper Moons', year: '2024', track: '2', genre: 'Indie Folk',
});

lrc(path.join(root, 'Afterglow', '01 - First Light.lrc'), [
  '[ti:First Light]',
  '[ar:Aurora Ensemble]',
  '[al:Afterglow]',
  '[offset:0]',
  '',
  '[00:01.00]Morning breaks in slow motion',
  '[00:05.20]Colours spill across the room',
  '[00:09.60]Every quiet little moment',
  '[00:14.10]Sounds a little more like you',
  '[00:18.40]And the light keeps on rising',
  '[00:22.30]Like a song we always knew',
].join('\n'));

lrc(path.join(root, 'Paper Moons', '01 - Paper Moons.lrc'), [
  '[ti:Paper Moons]',
  '[ar:Lena Vale]',
  '[al:Paper Moons]',
  '[00:02.00]We folded paper moons',
  '[00:07.50]And hung them from the ceiling',
  '[00:13.00]Every shadow danced',
  '[00:18.20]Like it was worth believing',
].join('\n'));

cover(path.join(root, 'Afterglow', 'cover.png'), {
  top: [42, 18, 44],
  bottom: [12, 9, 24],
  glow: { at: [0.72, 0.24], color: [255, 168, 96], strength: 0.45 },
  accent: [244, 114, 182],
}, { disc: { at: [0.66, 0.37], color: [255, 214, 170] }, hue: 0.6 });

cover(path.join(root, 'Paper Moons', 'cover.png'), {
  top: [12, 22, 46],
  bottom: [6, 9, 20],
  glow: { at: [0.28, 0.3], color: [86, 214, 236], strength: 0.4 },
  accent: [129, 140, 248],
}, { disc: { at: [0.36, 0.4], color: [226, 237, 255] }, hue: 2.1 });

fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(path.join(userData, 'aurora-data', 'covers'), { recursive: true });
fs.writeFileSync(
  path.join(userData, 'aurora-data', 'settings.json'),
  JSON.stringify({
    libraryFolders: [root],
    subsonic: { url: '', username: '', password: '' },
    theme: 'midnight',
    accent: 'auto',
    backgroundIntensity: 0.6,
    reduceMotion: false,
    volume: 0.75,
    muted: false,
    firstRun: false,
  }, null, 2),
);

console.log(`demo library: ${root}`);
console.log(`demo user data: ${userData}`);
