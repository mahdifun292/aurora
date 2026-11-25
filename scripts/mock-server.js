'use strict';

/*
 * Tiny Subsonic-compatible mock server used for development testing.
 * Usage: node scripts/mock-server.js [port] [musicDir]
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.argv[2]) || 4599;
const musicDir = process.argv[3] || '/tmp/aurora-music';

const imageFor = (albumId) => path.join(musicDir, albumId === 'al2' ? 'Paper Moons' : 'Afterglow', 'cover.png');
const audioFor = (trackId) => {
  const map = {
    s1: 'Afterglow/01 - First Light.wav',
    s2: 'Afterglow/02 - Silver Lining.wav',
    s3: 'Afterglow/03 - Midnight Drive.wav',
    s4: 'Paper Moons/01 - Paper Moons.wav',
    s5: 'Paper Moons/02 - Slow Motion.wav',
  };
  return path.join(musicDir, map[trackId] || map.s1);
};

const albums = [
  {
    id: 'al1', name: 'Afterglow', artist: 'Aurora Ensemble', artistId: 'ar1',
    year: 2026, coverArt: 'al1', songCount: 3, created: '2026-01-12T10:00:00Z',
  },
  {
    id: 'al2', name: 'Paper Moons', artist: 'Lena Vale', artistId: 'ar2',
    year: 2024, coverArt: 'al2', songCount: 2, created: '2024-07-03T10:00:00Z',
  },
];

const songs = [
  { id: 's1', title: 'First Light', artist: 'Aurora Ensemble', album: 'Afterglow', albumId: 'al1', duration: 26, track: 1, coverArt: 'al1' },
  { id: 's2', title: 'Silver Lining', artist: 'Aurora Ensemble', album: 'Afterglow', albumId: 'al1', duration: 21, track: 2, coverArt: 'al1' },
  { id: 's3', title: 'Midnight Drive', artist: 'Aurora Ensemble', album: 'Afterglow', albumId: 'al1', duration: 32, track: 3, coverArt: 'al1' },
  { id: 's4', title: 'Paper Moons', artist: 'Lena Vale', album: 'Paper Moons', albumId: 'al2', duration: 24, track: 1, coverArt: 'al2' },
  { id: 's5', title: 'Slow Motion', artist: 'Lena Vale', album: 'Paper Moons', albumId: 'al2', duration: 28, track: 2, coverArt: 'al2' },
].map((s) => ({
  ...s,
  albumArtist: s.artist,
  discNumber: 1,
  suffix: 'wav',
  contentType: 'audio/wav',
  bitRate: 1411,
  size: 4000000,
  path: `music/${s.album}/${s.title}.wav`,
  created: '2024-01-01T00:00:00Z',
  starred: s.id === 's1' ? '2025-05-01T00:00:00Z' : undefined,
}));

const artists = [
  { id: 'ar1', name: 'Aurora Ensemble', albumCount: 1 },
  { id: 'ar2', name: 'Lena Vale', albumCount: 1 },
];

const playlists = [{ id: 'sp1', name: 'Server Mix', songCount: 2, owner: 'demo', coverArt: 'al1' }];

function json(res, payload) {
  const body = JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.54.0', ...payload } });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function streamFile(req, res, file, type) {
  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404); res.end(); return; }
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const endpoint = url.pathname.replace(/^\/rest\//, '').replace(/\.view$/, '');
  const q = url.searchParams;
  if (process.env.MOCK_LOG === '1') console.log(`[mock] ${endpoint}`, Object.fromEntries(q));

  switch (endpoint) {
    case 'ping':
      return json(res, {});
    case 'getAlbumList2': {
      let list = [...albums];
      if (q.get('type') === 'newest') list.sort((a, b) => new Date(b.created) - new Date(a.created));
      else if (q.get('type') === 'random') list.sort(() => Math.random() - 0.5);
      else list.sort((a, b) => a.name.localeCompare(b.name));
      const size = Number(q.get('size')) || 500;
      const offset = Number(q.get('offset')) || 0;
      return json(res, { albumList2: { album: list.slice(offset, offset + size) } });
    }
    case 'getArtists': {
      const groups = new Map();
      for (const artist of artists) {
        const letter = artist.name[0].toUpperCase();
        if (!groups.has(letter)) groups.set(letter, []);
        groups.get(letter).push(artist);
      }
      return json(res, { artists: { index: [...groups].map(([name, list]) => ({ name, artist: list })) } });
    }
    case 'getArtist': {
      const artist = artists.find((a) => a.id === q.get('id'));
      if (!artist) return json(res, { error: { code: 70, message: 'Artist not found' } });
      return json(res, { artist: { ...artist, album: albums.filter((a) => a.artistId === artist.id) } });
    }
    case 'getAlbum': {
      const album = albums.find((a) => a.id === q.get('id'));
      if (!album) return json(res, { error: { code: 70, message: 'Album not found' } });
      return json(res, { album: { ...album, song: songs.filter((s) => s.albumId === album.id) } });
    }
    case 'getPlaylists':
      return json(res, { playlists: { playlist: playlists } });
    case 'getPlaylist':
      return json(res, { playlist: { ...playlists[0], entry: songs.filter((s) => ['s1', 's4'].includes(s.id)) } });
    case 'search3': {
      const query = (q.get('query') || '').toLowerCase();
      const matchSong = songs.filter((s) => `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(query));
      const matchAlbums = albums.filter((a) => `${a.name} ${a.artist}`.toLowerCase().includes(query));
      const matchArtists = artists.filter((a) => a.name.toLowerCase().includes(query));
      return json(res, { searchResult3: { song: matchSong, album: matchAlbums, artist: matchArtists } });
    }
    case 'getStarred2':
      return json(res, { starred2: { song: songs.filter((s) => s.starred), album: [albums[1]], artist: [artists[0]] } });
    case 'star':
    case 'unstar':
    case 'scrobble':
      return json(res, {});
    case 'getRandomSongs':
      return json(res, { randomSongs: { song: [...songs].sort(() => Math.random() - 0.5) } });
    case 'getLyricsBySongId':
      return json(res, {
        lyricsList: {
          structuredLyrics: [{
            synced: true,
            line: [
              { start: 1000, value: 'Streaming from your server' },
              { start: 5000, value: 'Every colour in the room' },
              { start: 9500, value: 'Lyrics arrive with the sound' },
              { start: 14000, value: 'And the night keeps turning' },
              { start: 19000, value: 'Like a song we always knew' },
            ],
          }],
        },
      });
    case 'getLyrics':
      return json(res, { lyrics: { artist: q.get('artist') || '', title: q.get('title') || '', value: 'Plain server lyrics\nSecond line\nThird line' } });
    case 'getCoverArt':
      return streamFile(req, res, imageFor(q.get('id')), 'image/png');
    case 'stream':
      return streamFile(req, res, audioFor(q.get('id')), 'audio/wav');
    default:
      return json(res, { error: { code: 0, message: `Unknown endpoint: ${endpoint}` } });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock] Subsonic server on http://127.0.0.1:${port}`);
});
