'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, Menu, nativeTheme, protocol, net,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

app.setName('Aurora');

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (process.env.AURORA_USER_DATA) {
  app.setPath('userData', process.env.AURORA_USER_DATA);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aurora',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.wav',
  '.aiff', '.aif', '.wma', '.mp4', '.webm',
]);
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

const DATA_DIR = path.join(app.getPath('userData'), 'aurora-data');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');

fs.mkdirSync(COVERS_DIR, { recursive: true });

function mediaUrl(filePath) {
  if (!filePath) return null;
  return `aurora://media/?p=${encodeURIComponent(path.resolve(filePath))}`;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.m4b': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.wav': 'audio/wav',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
    '.wma': 'audio/x-ms-wma',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.html': 'text/html',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
  };
  return types[ext] || 'application/octet-stream';
}

async function serveMedia(request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('p');
  if (!raw) return new Response('Missing path', { status: 400 });
  let filePath;
  try {
    filePath = path.resolve(decodeURIComponent(raw));
  } catch {
    return new Response('Bad path', { status: 400 });
  }
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!stat.isFile()) return new Response('Not found', { status: 404 });

  const mime = mimeFor(filePath);
  const total = stat.size;
  const rangeHeader = request.headers.get('Range');
  const baseHeaders = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  };

  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (match) {
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end)) {
        start = 0;
        end = total - 1;
      }
      start = Math.max(0, Math.min(start, total - 1));
      end = Math.max(start, Math.min(end, total - 1));
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
      });
    }
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(total) },
  });
}

async function serveServer(request) {
  const url = new URL(request.url);
  const kind = url.pathname.replace(/^\//, '');
  const id = url.searchParams.get('id');
  if (!id) return new Response('Missing id', { status: 400 });
  if (!subsonicConfigured()) return new Response('Server not configured', { status: 503 });
  const endpoint = kind === 'cover' ? 'getCoverArt' : 'stream';
  const params = kind === 'cover'
    ? { id, size: url.searchParams.get('size') || 600 }
    : { id };
  const target = `${subsonicBase()}/rest/${endpoint}.view?${authParams(params).toString()}`;
  const headers = { 'User-Agent': 'Aurora/1.0' };
  const range = request.headers.get('Range');
  if (range) headers.Range = range;
  let upstream;
  try {
    upstream = await fetch(target, { headers });
  } catch {
    return new Response('Upstream error', { status: 502 });
  }
  const out = new Headers();
  for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
    const value = upstream.headers.get(header);
    if (value) out.set(header, value);
  }
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function serveApp(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname || '/');
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const filePath = path.resolve(path.join(RENDERER_DIR, pathname));
  if (!filePath.startsWith(RENDERER_DIR + path.sep) && filePath !== RENDERER_DIR) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
      status: 200,
      headers: {
        'Content-Type': mimeFor(filePath),
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const DEFAULT_SETTINGS = {
  libraryFolders: [],
  subsonic: { url: '', username: '', password: '' },
  theme: 'midnight',
  accent: 'auto',
  backgroundIntensity: 0.55,
  reduceMotion: false,
  crossfade: 0,
  volume: 0.8,
  muted: false,
  windowBounds: null,
  firstRun: true,
};

let settings = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
if (!Array.isArray(settings.libraryFolders)) settings.libraryFolders = [];

async function saveSettings() {
  await writeJson(SETTINGS_FILE, settings);
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

let mainWindow = null;

function createWindow() {
  const bounds = settings.windowBounds || {};
  const win = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 920,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#07070c',
    title: 'Aurora',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadURL('aurora://app/index.html');

  if (process.env.AURORA_LOG === '1') {
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error('[preload]', preloadPath, error);
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
    if (process.env.AURORA_SCREENSHOT) {
      setTimeout(async () => {
        try {
          if (process.env.AURORA_SHOT_JS) {
            const result = await win.webContents.executeJavaScript(process.env.AURORA_SHOT_JS, true);
            if (result !== undefined) console.log('[shot-js]', result);
            await new Promise((resolve) => setTimeout(resolve, 900));
          }
          const image = await win.webContents.capturePage();
          await fsp.writeFile(process.env.AURORA_SCREENSHOT, image.toPNG());
          console.log(`[screenshot] ${process.env.AURORA_SCREENSHOT}`);
        } catch (err) {
          console.error('[screenshot]', err);
        }
        if (process.env.AURORA_SCREENSHOT_QUIT === '1') app.quit();
      }, Number(process.env.AURORA_SCREENSHOT_DELAY || 2600));
    }
  });

  const sendMax = () => {
    if (!win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized());
  };
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);

  win.on('close', () => {
    try {
      const b = win.getNormalBounds();
      settings.windowBounds = b;
      saveSettings();
    } catch { /* ignore */ }
  });

  win.on('closed', () => { mainWindow = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'dark';

  if (process.env.AURORA_SCAN === '1') {
    try {
      const result = await scanLibrary();
      console.log(`[dev] scanned ${result.tracks.length} tracks`);
    } catch (err) {
      console.error('[dev] scan failed', err);
    }
  }

  protocol.handle('aurora', (request) => {
    const host = new URL(request.url).host;
    if (host === 'media') return serveMedia(request);
    if (host === 'srv') return serveServer(request);
    return serveApp(request);
  });

  mainWindow = createWindow();

  const forward = (channel) => () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
  };
  const shortcuts = [
    ['MediaPlayPause', 'media:playpause'],
    ['MediaNextTrack', 'media:next'],
    ['MediaPreviousTrack', 'media:previous'],
    ['MediaStop', 'media:stop'],
  ];
  for (const [accel, channel] of shortcuts) {
    try { globalShortcut.register(accel, forward(channel)); } catch { /* ignore */ }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* Library scanning                                                    */
/* ------------------------------------------------------------------ */

async function walkFolder(root, files, lrcFiles, seenDirs) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      let real;
      try { real = await fsp.realpath(full); } catch { continue; }
      if (seenDirs.has(real)) continue;
      seenDirs.add(real);
      await walkFolder(full, files, lrcFiles, seenDirs);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXT.has(ext)) {
        files.push(full);
      } else if (ext === '.lrc') {
        const base = path.basename(entry.name, ext).toLowerCase();
        lrcFiles.set(`${path.dirname(full).toLowerCase()}|${base}`, full);
      }
    }
  }
}

function folderCover(dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  let found = null;
  try {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      if (IMAGE_EXT.includes(ext)) {
        const base = path.basename(name, ext).toLowerCase();
        if (['cover', 'folder', 'front', 'album', 'artwork'].includes(base)) {
          found = path.join(dir, name);
          break;
        }
      }
    }
    if (!found) {
      for (const name of entries) {
        if (IMAGE_EXT.includes(path.extname(name).toLowerCase())) {
          found = path.join(dir, name);
          break;
        }
      }
    }
  } catch { /* ignore */ }
  cache.set(dir, found);
  return found;
}

function mimeToExt(format) {
  const map = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
    'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
  };
  return map[(format || '').toLowerCase()] || '.jpg';
}

async function saveCover(picture, key) {
  try {
    const ext = mimeToExt(picture.format);
    const filename = crypto.createHash('sha1').update(`cover:${key}`).digest('hex').slice(0, 24) + ext;
    const dest = path.join(COVERS_DIR, filename);
    if (!fs.existsSync(dest)) {
      const data = picture.data?.data || picture.data;
      await fsp.writeFile(dest, Buffer.from(data));
    }
    return mediaUrl(dest);
  } catch {
    return null;
  }
}

function lyricsFromCommon(common) {
  const raw = common?.lyrics;
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) return item;
    if (item && typeof item === 'object') {
      if (Array.isArray(item.syncText) && item.syncText.length) {
        return item.syncText
          .map((line) => {
            const ms = Number(line.timestamp) || 0;
            const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
            const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
            const cs = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
            return `[${mm}:${ss}.${cs}]${(line.text || '').replace(/\r?\n/g, ' ')}`;
          })
          .join('\n');
      }
      const text = item.text || item.lyrics || item.value;
      if (typeof text === 'string' && text.trim()) return text;
    }
  }
  return null;
}

async function scanLibrary(onProgress) {
  const folders = settings.libraryFolders;
  const files = [];
  const lrcFiles = new Map();
  const seenDirs = new Set();
  for (const folder of folders) {
    if (!folder) continue;
    try {
      const real = await fsp.realpath(folder);
      seenDirs.add(real);
    } catch { continue; }
    await walkFolder(folder, files, lrcFiles, seenDirs);
  }

  const coverCache = new Map();
  const mm = await import('music-metadata');
  const tracks = new Array(files.length);
  let cursor = 0;
  let done = 0;
  let lastProgress = 0;

  const parseOne = async (file) => {
    let meta;
    try {
      meta = await mm.parseFile(file, { duration: true, skipCovers: false });
    } catch {
      return null;
    }
    const c = meta.common || {};
    const f = meta.format || {};
    const dir = path.dirname(file);
    const fileBase = path.basename(file, path.extname(file));

    const title = (c.title || fileBase).trim();
    const artist = (c.artist || (c.artists && c.artists.join(', ')) || 'Unknown Artist').trim();
    const albumArtist = (c.albumartist || c.albumArtist || artist || 'Unknown Artist').trim();
    const album = (c.album || path.basename(dir) || 'Unknown Album').trim();

    let stat = null;
    try { stat = await fsp.stat(file); } catch { /* ignore */ }

    let coverUrl = null;
    const picture = c.picture?.[0];
    if (picture) {
      coverUrl = await saveCover(picture, `${albumArtist}|${album}`);
    }
    if (!coverUrl) {
      const fc = folderCover(dir, coverCache);
      if (fc) coverUrl = mediaUrl(fc);
    }

    const lrcKey = `${dir.toLowerCase()}|${fileBase.toLowerCase()}`;
    const lrcPath = lrcFiles.get(lrcKey) || null;

    return {
      id: crypto.createHash('sha1').update(file).digest('hex').slice(0, 16),
      source: 'local',
      title,
      artist,
      albumArtist,
      album,
      duration: Number(f.duration) || 0,
      year: Number(c.year) || null,
      trackNo: Number(c.track?.no) || 0,
      discNo: Number(c.disk?.no) || 0,
      genre: (c.genre || []).slice(0, 4),
      path: file,
      streamUrl: mediaUrl(file),
      coverUrl,
      lrcPath,
      embeddedLyrics: lyricsFromCommon(c) ? true : false,
      bitrate: Number(f.bitrate) || 0,
      sampleRate: Number(f.sampleRate) || 0,
      codec: f.codec || '',
      size: stat?.size || 0,
      addedAt: stat?.mtimeMs || Date.now(),
      hasStarred: false,
    };
  };

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      tracks[i] = await parseOne(files[i]);
      done += 1;
      const now = Date.now();
      if (onProgress && (now - lastProgress > 80 || done === files.length)) {
        lastProgress = now;
        onProgress({ done, total: files.length, current: path.basename(files[i]) });
      }
    }
  };

  await Promise.all(Array.from({ length: 4 }, worker));

  const clean = tracks.filter(Boolean);
  const payload = {
    version: 1,
    scannedAt: Date.now(),
    folders: [...folders],
    tracks: clean,
  };
  await writeJson(LIBRARY_FILE, payload);
  return payload;
}

/* ------------------------------------------------------------------ */
/* Subsonic / Navidrome                                                */
/* ------------------------------------------------------------------ */

function subsonicConfigured() {
  const s = settings.subsonic || {};
  return Boolean(s.url && s.username);
}

function subsonicBase() {
  return String(settings.subsonic.url || '').replace(/\/+$/, '');
}

function authParams(extra = {}) {
  const s = settings.subsonic || {};
  const salt = crypto.randomBytes(8).toString('hex');
  const token = crypto.createHash('md5').update(`${s.password || ''}${salt}`).digest('hex');
  return new URLSearchParams({
    u: s.username || '',
    t: token,
    s: salt,
    v: '1.16.1',
    c: 'Aurora',
    f: 'json',
    ...extra,
  });
}

function streamUrlFor(id) {
  return `aurora://srv/stream?id=${encodeURIComponent(id)}`;
}

function coverUrlFor(id, size = 600) {
  if (!id) return null;
  return `aurora://srv/cover?id=${encodeURIComponent(id)}&size=${size}`;
}

async function subsonicRequest(endpoint, params = {}) {
  if (!subsonicConfigured()) throw new Error('Server is not configured yet.');
  const url = `${subsonicBase()}/rest/${endpoint}.view?${authParams(params).toString()}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Aurora/1.0' } });
  } catch (err) {
    throw new Error(`Could not reach server: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Server responded with HTTP ${res.status}`);
  let json;
  try { json = await res.json(); } catch { throw new Error('Server did not return JSON.'); }
  const sr = json['subsonic-response'];
  if (!sr) throw new Error('Unexpected response from server.');
  if (sr.status !== 'ok') throw new Error(sr.error?.message || 'Server returned an error.');
  return sr;
}

function mapSong(song) {
  return {
    id: `srv:${song.id}`,
    source: 'server',
    trackId: song.id,
    title: song.title || 'Unknown Title',
    artist: song.artist || 'Unknown Artist',
    albumArtist: song.albumArtist || song.artist || 'Unknown Artist',
    album: song.album || 'Unknown Album',
    albumId: song.albumId ? `srv:${song.albumId}` : null,
    duration: Number(song.duration) || 0,
    year: Number(song.year) || null,
    trackNo: Number(song.track) || 0,
    discNo: Number(song.discNumber) || 0,
    genre: song.genre ? [song.genre] : [],
    streamUrl: streamUrlFor(song.id),
    coverUrl: coverUrlFor(song.coverArt || song.albumId),
    starred: Boolean(song.starred),
    path: song.path || '',
    bitrate: Number(song.bitRate) || 0,
    codec: song.suffix || '',
    size: Number(song.size) || 0,
    addedAt: song.created ? Date.parse(song.created) || Date.now() : Date.now(),
    lrcPath: null,
    embeddedLyrics: false,
  };
}

function mapAlbum(album) {
  return {
    id: `srv:${album.id}`,
    source: 'server',
    albumId: album.id,
    name: album.name || 'Unknown Album',
    artist: album.artist || 'Unknown Artist',
    year: album.year || null,
    coverUrl: coverUrlFor(album.coverArt || album.id),
    songCount: Number(album.songCount) || 0,
    created: album.created || null,
    playCount: Number(album.playCount) || 0,
  };
}

function mapArtist(artist) {
  return {
    id: `srv:${artist.id}`,
    source: 'server',
    artistId: artist.id,
    name: artist.name || 'Unknown Artist',
    albumCount: Number(artist.albumCount) || 0,
    coverUrl: coverUrlFor(artist.artistImageUrl ? null : artist.id),
    imageUrl: artist.artistImageUrl || null,
  };
}

function lrcTime(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const mm = String(Math.floor(total / 60000)).padStart(2, '0');
  const ss = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
  const cs = String(Math.floor((total % 1000) / 10)).padStart(2, '0');
  return `${mm}:${ss}.${cs}`;
}

async function serverLyrics(track) {
  if (!track?.trackId) return null;
  try {
    const sr = await subsonicRequest('getLyricsBySongId', { id: track.trackId });
    const structured = sr.lyricsList?.structuredLyrics || [];
    const chosen = structured.find((l) => l.synced) || structured[0];
    if (chosen?.line?.length) {
      const text = chosen.line
        .filter((l) => l.value !== undefined && l.value !== '')
        .map((l) => `[${lrcTime(l.start)}]${String(l.value || '').replace(/\r?\n/g, ' ')}`)
        .join('\n');
      if (text.trim()) return { text, synced: Boolean(chosen.synced), source: 'server' };
    }
  } catch { /* OpenSubsonic endpoint may not exist */ }

  try {
    const sr = await subsonicRequest('getLyrics', {
      artist: track.artist || '', title: track.title || '',
    });
    const value = sr.lyrics?.value;
    if (value && value.trim()) return { text: value, synced: false, source: 'server' };
  } catch { /* no lyrics */ }

  return null;
}

async function handleSubsonicCall(action, params = {}) {
  switch (action) {
    case 'ping': {
      const started = Date.now();
      const sr = await subsonicRequest('ping');
      return {
        ok: true,
        latency: Date.now() - started,
        version: sr.version,
        type: sr.type,
        serverVersion: sr.serverVersion,
      };
    }
    case 'getAlbumList2': {
      const sr = await subsonicRequest('getAlbumList2', {
        type: params.type || 'alphabeticalByName',
        size: params.size || 500,
        offset: params.offset || 0,
        ...(params.fromYear ? { fromYear: params.fromYear } : {}),
        ...(params.toYear ? { toYear: params.toYear } : {}),
        ...(params.genre ? { genre: params.genre } : {}),
      });
      return (sr.albumList2?.album || []).map(mapAlbum);
    }
    case 'getArtists': {
      const sr = await subsonicRequest('getArtists');
      const indexes = sr.artists?.index || [];
      const artists = [];
      for (const index of indexes) {
        for (const a of index.artist || []) artists.push(mapArtist(a));
      }
      return artists;
    }
    case 'getArtist': {
      const sr = await subsonicRequest('getArtist', { id: params.id });
      return {
        artist: { ...mapArtist(sr.artist || {}), biography: sr.artist?.biography },
        albums: (sr.artist?.album || []).map(mapAlbum),
      };
    }
    case 'getAlbum': {
      const sr = await subsonicRequest('getAlbum', { id: params.id });
      const album = mapAlbum(sr.album || {});
      album.songs = (sr.album?.song || []).map(mapSong);
      return album;
    }
    case 'getPlaylists': {
      const sr = await subsonicRequest('getPlaylists');
      return (sr.playlists?.playlist || []).map((p) => ({
        id: `srv:${p.id}`,
        playlistId: p.id,
        source: 'server',
        name: p.name,
        songCount: Number(p.songCount) || 0,
        coverUrl: coverUrlFor(p.coverArt || p.id),
        owner: p.owner,
      }));
    }
    case 'getPlaylist': {
      const sr = await subsonicRequest('getPlaylist', { id: params.id });
      return {
        id: `srv:${sr.playlist?.id}`,
        name: sr.playlist?.name || 'Playlist',
        songs: (sr.playlist?.entry || []).map(mapSong),
      };
    }
    case 'search3': {
      const sr = await subsonicRequest('search3', {
        query: params.query || '', songCount: 60, albumCount: 40, artistCount: 30,
      });
      return {
        songs: (sr.searchResult3?.song || []).map(mapSong),
        albums: (sr.searchResult3?.album || []).map(mapAlbum),
        artists: (sr.searchResult3?.artist || []).map(mapArtist),
      };
    }
    case 'getStarred2': {
      const sr = await subsonicRequest('getStarred2');
      return {
        songs: (sr.starred2?.song || []).map(mapSong),
        albums: (sr.starred2?.album || []).map(mapAlbum),
        artists: (sr.starred2?.artist || []).map(mapArtist),
      };
    }
    case 'star':
      await subsonicRequest(params.star ? 'star' : 'unstar', { id: params.id });
      return { ok: true };
    case 'scrobble':
      try { await subsonicRequest('scrobble', { id: params.id, submission: params.submission ? 'true' : 'false' }); } catch { /* non fatal */ }
      return { ok: true };
    case 'getRandomSongs': {
      const sr = await subsonicRequest('getRandomSongs', { size: params.size || 30 });
      return (sr.randomSongs?.song || []).map(mapSong);
    }
    case 'getAllSongs': {
      const size = Math.min(Math.max(Number(params.size) || 5000, 1), 10000);
      let songs = [];
      try {
        const sr = await subsonicRequest('search3', {
          query: '', songCount: size, albumCount: 0, artistCount: 0,
        });
        songs = (sr.searchResult3?.song || []).map(mapSong);
      } catch { /* some servers reject an empty search query */ }
      if (songs.length) return songs;

      /* Fallback for servers that cannot search with an empty query:
         walk the album list and collect every song. */
      const albumSr = await subsonicRequest('getAlbumList2', {
        type: 'alphabeticalByName', size: 500, offset: 0,
      });
      const albums = albumSr.albumList2?.album || [];
      const seen = new Set();
      const batchSize = 8;
      for (let i = 0; i < albums.length; i += batchSize) {
        const batch = albums.slice(i, i + batchSize);
        const results = await Promise.all(batch.map((album) => (
          subsonicRequest('getAlbum', { id: album.id }).catch(() => null)
        )));
        for (const result of results) {
          for (const song of result?.album?.song || []) {
            const mapped = mapSong(song);
            if (seen.has(mapped.id)) continue;
            seen.add(mapped.id);
            songs.push(mapped);
          }
        }
      }
      return songs;
    }
    case 'getLyricsBySongId': {
      return await serverLyrics(params.track || {});
    }
    default:
      throw new Error(`Unsupported server action: ${action}`);
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:update', async (_e, patch) => {
    settings = deepMerge(settings, patch || {});
    await saveSettings();
    return settings;
  });

  ipcMain.handle('library:get', () => {
    const lib = readJson(LIBRARY_FILE, null);
    if (!lib) return { tracks: [], scannedAt: null };
    return lib;
  });

  ipcMain.handle('library:scan', async (event) => {
    const sender = event.sender;
    const result = await scanLibrary((progress) => {
      if (!sender.isDestroyed()) sender.send('library:progress', progress);
    });
    return { tracks: result.tracks, scannedAt: result.scannedAt };
  });

  ipcMain.handle('library:add-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Add music folder',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (res.canceled) return settings.libraryFolders;
    const merged = new Set([...(settings.libraryFolders || []), ...res.filePaths]);
    settings.libraryFolders = [...merged];
    await saveSettings();
    return settings.libraryFolders;
  });

  ipcMain.handle('library:remove-folder', async (_e, folder) => {
    settings.libraryFolders = (settings.libraryFolders || []).filter((f) => f !== folder);
    await saveSettings();
    return settings.libraryFolders;
  });

  ipcMain.handle('library:reveal', (_e, filePath) => {
    if (filePath) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('playlists:get', () => readJson(PLAYLISTS_FILE, []));
  ipcMain.handle('playlists:set', async (_e, playlists) => {
    await writeJson(PLAYLISTS_FILE, Array.isArray(playlists) ? playlists : []);
    return true;
  });

  ipcMain.handle('favorites:get', () => readJson(FAVORITES_FILE, []));
  ipcMain.handle('favorites:set', async (_e, favorites) => {
    await writeJson(FAVORITES_FILE, Array.isArray(favorites) ? favorites : []);
    return true;
  });

  ipcMain.handle('lyrics:local', async (_e, track) => {
    if (!track) return null;
    if (track.lrcPath) {
      try {
        const text = await fsp.readFile(track.lrcPath, 'utf8');
        if (text.trim()) return { text, synced: /\[\d{1,2}:\d{2}/.test(text), source: 'lrc' };
      } catch { /* fall through */ }
    }
    if (track.embeddedLyrics && track.path) {
      try {
        const mm = await import('music-metadata');
        const meta = await mm.parseFile(track.path, { duration: false, skipCovers: true });
        const text = lyricsFromCommon(meta.common);
        if (text) return { text, synced: /\[\d{1,2}:\d{2}/.test(text), source: 'embedded' };
      } catch { /* ignore */ }
    }
    return null;
  });

  ipcMain.handle('lyrics:server', async (_e, track) => serverLyrics(track));

  ipcMain.handle('subsonic:test', async () => {
    try {
      return await handleSubsonicCall('ping');
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('subsonic:call', async (_e, action, params) => {
    try {
      return { ok: true, data: await handleSubsonicCall(action, params || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('win:minimize', () => mainWindow?.minimize());
  ipcMain.handle('win:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('win:close', () => mainWindow?.close());
  ipcMain.handle('win:is-maximized', () => Boolean(mainWindow?.isMaximized()));

  ipcMain.handle('app:open-external', (_e, url) => {
    if (/^https?:/i.test(url || '')) shell.openExternal(url);
  });
  ipcMain.handle('app:open-data-folder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    userData: app.getPath('userData'),
  }));
}

registerIpc();

/* track player errors so the UI can show a friendly message */
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught', err);
});
