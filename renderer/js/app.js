import { icon } from './icons.js';
import {
  $, $$, esc, fmtTime, clamp, debounce, setAccent, setAccentHue, isMac, coverHTML,
} from './util.js';
import { Player } from './player.js';
import { LyricsView } from './lyrics.js';
import * as views from './views.js';

const api = window.api;
const player = new Player();
const UI_KEY = 'aurora.ui.v1';

let lyrics = null;
let rafId = 0;
let scanToast = null;
let volumeSaveTimer = null;

const state = {
  settings: {},
  appInfo: {},
  tracks: [],
  trackById: new Map(),
  localAlbums: [],
  localArtists: [],
  playlists: [],
  favorites: [],
  favIds: new Set(),
  mixTracks: [],

  source: 'local',
  serverConnected: false,
  serverStatus: null,
  serverLoading: false,
  serverAlbums: [],
  serverArtists: [],
  serverPlaylists: [],
  serverNewest: [],
  serverRandom: [],
  serverStarred: { songs: [], albums: [], artists: [] },
  serverStarredLoaded: false,
  serverTrackById: new Map(),
  albumCache: new Map(),
  artistCache: new Map(),

  route: { name: 'home', params: {} },
  history: [],
  historyIndex: -1,
  contexts: new Map(),
  currentId: null,
  lastRecordedId: null,

  albumSort: 'name',
  albumMode: 'grid',
  recentAlbumIds: [],
  recentTracks: [],
  plays: {},
  albumsById: new Map(),

  scanning: false,
  scanProgress: null,
  libraryScannedAt: null,

  lyricsOffset: 0,
  lyricsLoadedId: null,

  queueOpen: false,
  npOpen: false,

  searchQuery: '',
  searchResults: null,
  searchSeq: 0,

  songSort: 'title',
  songFilter: '',
  selectionMode: false,
  selectedSongIds: new Set(),
  serverSongs: [],
  serverSongsLoaded: false,
  serverSongsError: null,
  dragPlaylistRow: null,

  addSongPlaylistId: null,
  addSongSelected: new Set(),
  addSongQuery: '',
  pendingTracks: [],

  pendingTrack: null,
  pendingAlbum: null,
  pendingPlaylist: null,
  dragPos: null,
};

/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */

boot().catch((err) => {
  console.error(err);
  const view = document.getElementById('view');
  if (view) {
    view.innerHTML = `<div class="empty-state"><div class="empty-art">${icon('info')}</div>
      <h2>Something went wrong</h2><p>${esc(err?.message || String(err))}</p></div>`;
  }
});

async function boot() {
  fillStaticIcons();

  state.settings = await api.settings.get();
  state.appInfo = await api.app.info().catch(() => ({}));
  loadUiState();
  applySettingsToDOM();

  await loadLocalData();
  buildCollections();
  buildMix();

  lyrics = new LyricsView($('#np-lyrics'), { onSeek: (t) => player.seek(t) });
  lyrics.setOffset(state.lyricsOffset);
  updateOffsetLabel();

  bindStaticUi();
  bindPlayerEvents();
  bindPlayerBar();

  const restored = player.restore();
  if (restored) {
    state.currentId = player.current?.id || null;
    updateNowPlayingUI(player.current);
  } else {
    player.setVolume(Number(state.settings.volume ?? 0.8));
    player.audio.muted = Boolean(state.settings.muted);
    syncVolumeUI();
    updateNowPlayingUI(null);
  }
  if (restored) {
    player.audio.volume = clamp(Number(state.settings.volume ?? player.audio.volume), 0, 1);
    player.audio.muted = Boolean(state.settings.muted);
    syncVolumeUI();
  }

  renderSidebar();
  renderTopActions();
  await navigate('home', {}, false);
  if (!state.history.length) {
    state.history = [{ name: 'home', params: {} }];
    state.historyIndex = 0;
    updateHistoryButtons();
  }
  updateTransport();
  updateServerStatusUI();
  startRaf();

  if (serverConfigured()) {
    testServer({ quiet: true }).then(async (ok) => {
      if (!ok) return;
      if (state.source === 'server') {
        await loadServerLibrary({ quiet: true });
        if (['home', 'albums', 'artists', 'playlists'].includes(state.route.name)) {
          await navigate(state.route.name, state.route.params, false);
        }
      }
      renderSidebar();
    });
  } else if (state.source === 'server') {
    state.source = 'local';
    saveUiState();
  }

  if (state.route.name === 'home' && player.current && state.npOpen === false) {
    // nothing — lyrics are loaded lazily when the overlay opens
  }
}

function fillStaticIcons() {
  $$('[data-ico]').forEach((el) => {
    el.innerHTML = icon(el.dataset.ico);
  });
}

/* ================================================================== */
/* Persistence & theme                                                 */
/* ================================================================== */

function loadUiState() {
  let ui = {};
  try { ui = JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch { ui = {}; }
  state.source = ui.source === 'server' ? 'server' : 'local';
  state.albumSort = ['name', 'artist', 'year', 'recent'].includes(ui.albumSort) ? ui.albumSort : 'name';
  state.albumMode = ui.albumMode === 'list' ? 'list' : 'grid';
  state.songSort = ['title', 'artist', 'album', 'recent', 'duration'].includes(ui.songSort) ? ui.songSort : 'title';
  state.lyricsOffset = clamp(Number(ui.lyricsOffset) || 0, -30, 30);
  state.recentAlbumIds = Array.isArray(ui.recentAlbumIds) ? ui.recentAlbumIds.slice(0, 20) : [];
  state.recentTracks = Array.isArray(ui.recentTracks) ? ui.recentTracks.slice(0, 50) : [];
  state.plays = ui.plays && typeof ui.plays === 'object' ? ui.plays : {};
}

const saveUiState = debounce(() => {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({
      source: state.source,
      albumSort: state.albumSort,
      albumMode: state.albumMode,
      songSort: state.songSort,
      lyricsOffset: state.lyricsOffset,
      recentAlbumIds: state.recentAlbumIds,
      recentTracks: state.recentTracks,
      plays: state.plays,
    }));
  } catch { /* ignore */ }
}, 350);

function applySettingsToDOM() {
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme || 'midnight';
  document.documentElement.classList.toggle('reduce-motion', Boolean(s.reduceMotion));
  document.documentElement.style.setProperty('--bg-intensity', String(s.backgroundIntensity ?? 0.55));
  applyAccent();
  const kbd = $('#search-kbd');
  if (kbd) kbd.textContent = isMac() ? '⌘ K' : 'Ctrl K';
}

function applyAccent(seed) {
  const accent = state.settings.accent;
  if (accent && accent !== 'auto') {
    setAccentHue(Number(accent) || 262);
    return;
  }
  const track = player.current;
  setAccent(seed || track?.album || track?.artist || 'Aurora');
}

async function updateSettings(patch, { rerender = false } = {}) {
  try {
    state.settings = await api.settings.update(patch);
  } catch (err) {
    toast(`Could not save settings: ${err.message}`, 'error');
  }
  if (rerender) await renderCurrentView();
}

/* ================================================================== */
/* Local library                                                       */
/* ================================================================== */

async function loadLocalData() {
  const lib = await api.library.get().catch(() => ({ tracks: [], scannedAt: null }));
  state.tracks = Array.isArray(lib.tracks) ? lib.tracks : [];
  state.libraryScannedAt = lib.scannedAt || null;
  buildCollections();

  const [playlists, favorites] = await Promise.all([
    api.playlists.get().catch(() => []),
    api.favorites.get().catch(() => []),
  ]);
  state.playlists = Array.isArray(playlists) ? playlists : [];
  state.favorites = Array.isArray(favorites) ? favorites : [];
  state.favIds = new Set(state.favorites.map((f) => f.id));
  buildMix();
  buildLocalIndexes();
}

function buildLocalIndexes() {
  state.trackById = new Map(state.tracks.map((t) => [t.id, t]));
  state.albumsById = new Map(state.localAlbums.map((a) => [a.id, a]));
}

function buildCollections() {
  state.trackById = new Map(state.tracks.map((t) => [t.id, t]));

  const albums = new Map();
  for (const track of state.tracks) {
    const albumArtist = track.albumArtist || track.artist || 'Unknown Artist';
    const key = `${albumArtist}|${track.album || 'Unknown Album'}`;
    if (!albums.has(key)) {
      albums.set(key, {
        id: `local:${key}`,
        source: 'local',
        name: track.album || 'Unknown Album',
        artist: albumArtist,
        artistId: `local:artist:${albumArtist}`,
        year: track.year || null,
        coverUrl: track.coverUrl || null,
        tracks: [],
        duration: 0,
        addedAt: 0,
        songCount: 0,
      });
    }
    const album = albums.get(key);
    album.tracks.push(track);
    if (!album.coverUrl && track.coverUrl) album.coverUrl = track.coverUrl;
    if (!album.year && track.year) album.year = track.year;
    album.addedAt = Math.max(album.addedAt, Number(track.addedAt) || 0);
    album.duration += Number(track.duration) || 0;
  }

  for (const album of albums.values()) {
    album.tracks.sort((a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0) || a.title.localeCompare(b.title));
    album.songCount = album.tracks.length;
  }
  state.localAlbums = [...albums.values()].sort((a, b) => a.name.localeCompare(b.name));
  state.albumsById = new Map(state.localAlbums.map((a) => [a.id, a]));

  const artists = new Map();
  for (const album of state.localAlbums) {
    const name = album.artist || 'Unknown Artist';
    if (!artists.has(name)) {
      artists.set(name, {
        id: `local:artist:${name}`,
        source: 'local',
        name,
        coverUrl: album.coverUrl,
        albumCount: 0,
        albums: [],
      });
    }
    const artist = artists.get(name);
    artist.albumCount += 1;
    artist.albums.push(album);
    if (!artist.coverUrl && album.coverUrl) artist.coverUrl = album.coverUrl;
  }
  state.localArtists = [...artists.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildMix() {
  const day = new Date().toDateString();
  state.mixTracks = [...state.tracks]
    .map((t) => ({ t, h: hash(`${day}:${t.id}`) }))
    .sort((a, b) => a.h - b.h)
    .slice(0, 8)
    .map((x) => x.t);
}

function hash(value) {
  let h = 2166136261;
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function localAlbumIdFor(track) {
  const artist = track.albumArtist || track.artist || 'Unknown Artist';
  return `local:${artist}|${track.album || 'Unknown Album'}`;
}

function snapshot(track) {
  return { ...track };
}

function resolveFavorites() {
  return state.favorites
    .map((f) => state.trackById.get(f.id) || f)
    .filter(Boolean);
}

/* ================================================================== */
/* Server                                                              */
/* ================================================================== */

function serverConfigured() {
  const s = state.settings.subsonic || {};
  return Boolean(s.url && s.username);
}

function stripSrv(id) {
  return String(id || '').replace(/^srv:/, '');
}

function serverHost() {
  try { return new URL(state.settings.subsonic.url).host; } catch { return 'Server'; }
}

async function testServer({ quiet = false } = {}) {
  if (!serverConfigured()) {
    state.serverConnected = false;
    state.serverStatus = null;
    updateServerStatusUI();
    return false;
  }
  const res = await api.subsonic.test();
  state.serverStatus = res.ok
    ? { ok: true, latency: res.latency, version: res.version, type: res.type }
    : { ok: false, error: res.error };
  state.serverConnected = Boolean(res.ok);
  updateServerStatusUI();
  if (!quiet) {
    if (res.ok) toast(`Connected to ${serverHost()} · ${res.latency} ms`, 'success');
    else toast(res.error || 'Could not connect to the server', 'error');
  }
  return Boolean(res.ok);
}

async function loadServerLibrary({ quiet = false } = {}) {
  if (!serverConfigured()) return false;
  if (state.serverLoading) return false;
  state.serverLoading = true;
  try {
    const [albumsRes, artistsRes, playlistsRes, newestRes, randomRes] = await Promise.all([
      api.subsonic.call('getAlbumList2', { type: 'alphabeticalByName', size: 500 }),
      api.subsonic.call('getArtists'),
      api.subsonic.call('getPlaylists'),
      api.subsonic.call('getAlbumList2', { type: 'newest', size: 30 }),
      api.subsonic.call('getRandomSongs', { size: 10 }),
    ]);
    if (!albumsRes.ok) throw new Error(albumsRes.error || 'Could not load albums');
    state.serverAlbums = albumsRes.data || [];
    state.serverArtists = artistsRes.ok ? artistsRes.data || [] : [];
    state.serverPlaylists = playlistsRes.ok ? playlistsRes.data || [] : [];
    state.serverNewest = newestRes.ok ? newestRes.data || [] : [];
    state.serverRandom = randomRes.ok ? randomRes.data || [] : [];
    for (const t of state.serverRandom) state.serverTrackById.set(t.id, t);
    state.serverConnected = true;
    state.serverStatus = { ok: true, latency: state.serverStatus?.latency };
    state.albumCache.clear();
    state.artistCache.clear();
    state.serverStarredLoaded = false;
    state.serverSongs = [];
    state.serverSongsLoaded = false;
    state.serverSongsError = null;
    if (!quiet) toast(`Loaded ${state.serverAlbums.length} albums from ${serverHost()}`, 'success');
    updateServerStatusUI();
    return true;
  } catch (err) {
    state.serverConnected = false;
    state.serverStatus = { ok: false, error: err.message };
    updateServerStatusUI();
    if (!quiet) toast(err.message, 'error');
    return false;
  } finally {
    state.serverLoading = false;
  }
}

async function loadServerSongs() {
  if (!serverConfigured()) return false;
  const res = await api.subsonic.call('getAllSongs', { size: 5000 });
  if (!res.ok) {
    state.serverSongs = [];
    state.serverSongsError = res.error || 'Could not load songs from the server.';
    toast(state.serverSongsError, 'error');
    return false;
  }
  state.serverSongs = Array.isArray(res.data) ? res.data : [];
  state.serverSongsLoaded = true;
  state.serverSongsError = null;
  for (const track of state.serverSongs) state.serverTrackById.set(track.id, track);
  return true;
}

async function getServerAlbum(id) {
  const key = id?.startsWith('srv:') ? id : `srv:${id}`;
  if (state.albumCache.has(key)) return state.albumCache.get(key);  const res = await api.subsonic.call('getAlbum', { id: stripSrv(id) });
  if (!res.ok) {
    toast(res.error || 'Could not load album', 'error');
    return null;
  }
  const album = res.data;
  album.tracks = (album.songs || []).filter(Boolean);
  album.songCount = album.tracks.length;
  album.addedAt = album.created ? Date.parse(album.created) || Date.now() : Date.now();
  for (const track of album.tracks) state.serverTrackById.set(track.id, track);
  const artist = state.serverArtists.find((a) => a.name === album.artist);
  if (artist) album.artistId = artist.id;
  state.albumCache.set(key, album);
  return album;
}

async function getServerArtist(id) {
  const key = id?.startsWith('srv:') ? id : `srv:${id}`;
  if (state.artistCache.has(key)) return state.artistCache.get(key);
  const res = await api.subsonic.call('getArtist', { id: stripSrv(id) });
  if (!res.ok) {
    toast(res.error || 'Could not load artist', 'error');
    return null;
  }
  const data = res.data;
  const artist = { ...data.artist, source: 'server', albums: data.albums || [], songs: [] };
  if (artist.albums[0]) {
    const album = await getServerAlbum(artist.albums[0].id);
    if (album?.tracks) artist.songs = album.tracks.slice(0, 10);
  }
  if (!artist.coverUrl && artist.albums[0]?.coverUrl) artist.coverUrl = artist.albums[0].coverUrl;
  state.artistCache.set(key, artist);
  return artist;
}

async function ensureServerStarred(force = false) {
  if (state.serverStarredLoaded && !force) return state.serverStarred;
  const res = await api.subsonic.call('getStarred2');
  if (res.ok) {
    state.serverStarred = res.data;
    state.serverStarredLoaded = true;
    for (const t of res.data.songs || []) state.serverTrackById.set(t.id, t);
  }
  return state.serverStarred;
}

function resolveAlbum(id, source) {
  if (String(id).startsWith('srv:') || source === 'server') return getServerAlbum(id);
  return Promise.resolve(state.localAlbums.find((a) => a.id === id) || null);
}

function resolveArtist(id, source) {
  if (String(id).startsWith('srv:') || source === 'server') return getServerArtist(id);
  const name = String(id).replace(/^local:artist:/, '');
  const albums = state.localAlbums.filter((a) => a.artist === name);
  const seen = new Set();
  const songs = state.tracks
    .filter((t) => (t.albumArtist || t.artist) === name || t.artist === name)
    .sort((a, b) => (state.plays[b.id] || 0) - (state.plays[a.id] || 0))
    .filter((t) => (seen.has(t.id) ? false : seen.add(t.id)))
    .slice(0, 10);
  if (!albums.length && !songs.length) return Promise.resolve(null);
  return Promise.resolve({
    id,
    source: 'local',
    name,
    albums,
    songs,
    coverUrl: albums[0]?.coverUrl || songs[0]?.coverUrl,
    albumCount: albums.length,
  });
}

async function resolvePlaylist(id, source) {
  if (String(id).startsWith('srv:') || source === 'server') {
    const res = await api.subsonic.call('getPlaylist', { id: stripSrv(id) });
    if (!res.ok) {
      toast(res.error || 'Could not load playlist', 'error');
      return null;
    }
    const meta = state.serverPlaylists.find((p) => p.id === id);
    return {
      id,
      source: 'server',
      name: res.data.name || meta?.name || 'Playlist',
      tracks: res.data.songs || [],
    };
  }
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return null;
  return {
    ...pl,
    source: 'local',
    tracks: (pl.tracks || []).map((snap) => state.trackById.get(snap.id) || snap).filter(Boolean),
  };
}

/* ================================================================== */
/* Navigation                                                          */
/* ================================================================== */

async function navigate(name, params = {}, push = true, opts = {}) {
  if (push) pushHistory({ name, params });
  state.route = { name, params };
  state.contexts = new Map();
  if (name !== 'songs') resetSongSelection(true);
  renderTopActions();
  updateNavActive();
  updateHistoryButtons();
  if (!opts.keepScroll) $('#view').scrollTop = 0;

  const needsData = ['album', 'artist', 'playlist'].includes(name)
    || (name === 'songs' && state.source === 'server' && !state.serverSongsLoaded);
  if (needsData) setView(skeletonView(), { animate: false });

  let html = '';
  try {
    switch (name) {
      case 'home':
        html = views.home(state);
        break;
      case 'songs':
        if (state.source === 'server' && !state.serverSongsLoaded) {
          await loadServerSongs();
        }
        html = views.songs(state);
        break;
      case 'albums':
        html = views.albums(state);
        break;
      case 'artists':
        html = views.artists(state);
        break;
      case 'playlists':
        html = views.playlists(state);
        break;
      case 'favorites': {
        let tracks = [];
        let note = '';
        if (state.source === 'server') {
          await ensureServerStarred();
          tracks = state.serverStarred.songs || [];
          note = 'starred on your server';
        } else {
          tracks = resolveFavorites();
        }
        html = views.favorites(state, tracks, note);
        break;
      }
      case 'search':
        html = views.search(state, state.searchResults, state.searchQuery);
        break;
      case 'settings':
        html = views.settings(state);
        break;
      case 'album': {
        const album = await resolveAlbum(params.id, params.source);
        html = album ? views.album(state, album) : notFound('Album not found');
        break;
      }
      case 'artist': {
        const artist = await resolveArtist(params.id, params.source);
        html = artist ? views.artist(state, artist) : notFound('Artist not found');
        break;
      }
      case 'playlist': {
        const playlist = await resolvePlaylist(params.id, params.source);
        html = playlist ? views.playlist(state, playlist, playlist.tracks) : notFound('Playlist not found');
        break;
      }
      default:
        html = notFound('Page not found');
    }
  } catch (err) {
    console.error(err);
    html = `<div class="empty-state"><div class="empty-art">${icon('info')}</div>
      <h2>Could not load this page</h2><p>${esc(err.message)}</p>
      <button class="btn btn-soft" data-action="reload-page">${icon('refresh')} Try again</button></div>`;
  }

  setView(html);
  updateCurrentRows();
  updateNavActive();
  updateHistoryButtons();
  if (name === 'songs') {
    updateBulkBar();
    applySongFilter();
  }
  if (name === 'search') {
    const input = $('#search');
    if (input && input.value.trim() !== state.searchQuery) input.value = state.searchQuery;
    toggleSearchClear();
  }
}

function setView(html, { animate = true } = {}) {
  const view = $('#view');
  view.innerHTML = html;
  if (animate) {
    view.classList.remove('view-enter');
    void view.offsetWidth;
    view.classList.add('view-enter');
  }
}

function skeletonView() {
  return `<div style="padding:18px 2px">
    <div class="skeleton-block" style="width:120px;height:10px;margin-bottom:16px"></div>
    <div class="skeleton-block" style="width:55%;height:38px;margin-bottom:34px"></div>
    <div style="display:flex;gap:30px;align-items:flex-end">
      <div class="skeleton-block" style="width:210px;height:210px;border-radius:20px;flex:none"></div>
      <div style="flex:1;padding-bottom:10px">
        <div class="skeleton-block" style="width:70%;height:30px;margin-bottom:12px"></div>
        <div class="skeleton-block" style="width:40%;height:12px;margin-bottom:24px"></div>
        <div class="skeleton-block" style="width:180px;height:40px;border-radius:12px"></div>
      </div>
    </div>
    <div style="margin-top:40px">${Array.from({ length: 6 }, () => '<div class="skeleton-block" style="height:48px;margin-bottom:8px"></div>').join('')}</div>
  </div>`;
}

function notFound(message) {
  return `<div class="empty-state">
    <div class="empty-art">${icon('search')}</div>
    <h2>${esc(message)}</h2>
    <p>The item may have been removed or is not available right now.</p>
    <button class="btn btn-primary" data-route="home">${icon('home')} Back home</button>
  </div>`;
}

function pushHistory(route) {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(route);
  if (state.history.length > 80) state.history.shift();
  state.historyIndex = state.history.length - 1;
}

function goHistory(delta) {
  const next = state.historyIndex + delta;
  if (next < 0 || next >= state.history.length) return;
  state.historyIndex = next;
  const route = state.history[next];
  navigate(route.name, route.params, false);
}

function updateHistoryButtons() {
  $('#nav-back')?.classList.toggle('disabled', state.historyIndex <= 0);
  $('#nav-forward')?.classList.toggle('disabled', state.historyIndex >= state.history.length - 1);
}

function updateNavActive() {
  const map = {
    home: 'home', songs: 'songs',
    albums: 'albums', album: 'albums',
    artists: 'artists', artist: 'artists',
    playlists: 'playlists', playlist: 'playlists',
    favorites: 'favorites', settings: 'settings',
  };
  const active = map[state.route.name] || '';
  $$('#nav .nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === active);
  });
  $$('#playlist-nav .playlist-link').forEach((el) => {
    el.classList.toggle('active', state.route.name === 'playlist' && el.dataset.playlistId === state.route.params.id);
  });
}

async function renderCurrentView(options = {}) {
  await navigate(state.route.name, state.route.params, false, options);
}

/* ================================================================== */
/* Sidebar & top actions                                               */
/* ================================================================== */

function renderSidebar() {
  renderSourceSwitch();
  renderPlaylistsNav();
  updateServerStatusUI();
  updateNavActive();
}

function renderSourceSwitch() {
  const el = $('#source-switch');
  if (!el) return;
  const hasServer = serverConfigured();
  el.innerHTML = `
    <button data-action="switch-source" data-source="local" class="${state.source === 'local' ? 'active' : ''}" title="Local library">
      ${icon('folder')}<span>Local</span>
    </button>
    <button data-action="switch-source" data-source="server" class="${state.source === 'server' ? 'active' : ''}" title="${hasServer ? esc(serverHost()) : 'Connect a server'}">
      ${icon('server')}<span>${hasServer ? 'Server' : 'Connect'}</span>
      ${hasServer && state.serverConnected ? '<span class="dot"></span>' : ''}
    </button>`;
}

function renderPlaylistsNav() {
  const el = $('#playlist-nav');
  if (!el) return;
  const list = state.source === 'server' ? state.serverPlaylists : state.playlists;
  $('#new-playlist-btn').style.display = state.source === 'server' ? 'none' : '';
  if (!list.length) {
    el.innerHTML = `<div class="playlist-empty">${state.source === 'server' ? 'No playlists on the server yet.' : 'No playlists yet. Create one to collect tracks you love.'}</div>`;
    return;
  }
  el.innerHTML = list.slice(0, 16).map((p) => `
    <button class="playlist-link ${state.route.name === 'playlist' && state.route.params.id === p.id ? 'active' : ''}"
      data-action="open-playlist" data-playlist-id="${esc(p.id)}" data-source="${esc(p.source || state.source)}">
      ${icon('listMusic')}<span>${esc(p.name)}</span>
    </button>`).join('');
}

function updateServerStatusUI() {
  const el = $('#server-status');
  if (!el) return;
  if (!serverConfigured()) {
    el.className = 'server-status';
    el.innerHTML = '<span class="dot"></span> Local library only';
    return;
  }
  if (state.serverStatus?.ok) {
    el.className = 'server-status online';
    el.innerHTML = `<span class="dot"></span> ${esc(serverHost())} · connected`;
  } else if (state.serverStatus) {
    el.className = 'server-status offline';
    el.innerHTML = '<span class="dot"></span> Server unreachable';
  } else {
    el.className = 'server-status';
    el.innerHTML = '<span class="dot"></span> Server configured';
  }
}

function renderTopActions() {
  const el = $('#top-actions');
  if (!el) return;
  const mode = state.albumMode;
  switch (state.route.name) {
    case 'albums':
      el.innerHTML = `
        <button class="ghost-btn" data-action="sort-menu" title="Sort albums">${icon('sort')} ${esc(views.sortLabel(state.albumSort))} ${icon('chevronDown')}</button>
        <button class="iconbtn" data-action="toggle-album-mode" title="${mode === 'grid' ? 'List view' : 'Grid view'}">${icon(mode === 'grid' ? 'rows' : 'grid')}</button>
        <button class="iconbtn" data-action="shuffle-all" title="Shuffle everything">${icon('shuffle')}</button>`;
      break;
    case 'home':
      el.innerHTML = `<button class="iconbtn" data-action="${state.source === 'server' ? 'reload-server' : 'scan-library'}" title="${state.source === 'server' ? 'Reload server' : 'Rescan library'}">${icon('refresh')}</button>`;
      break;
    case 'songs':
      el.innerHTML = `<button class="ghost-btn" data-action="song-sort-menu" title="Sort songs">${icon('sort')} ${esc(views.songSortLabel(state.songSort))} ${icon('chevronDown')}</button>
        <button class="iconbtn" data-action="${state.source === 'server' ? 'reload-server' : 'scan-library'}" title="${state.source === 'server' ? 'Reload server' : 'Rescan library'}">${icon('refresh')}</button>`;
      break;
    case 'playlists':
      el.innerHTML = state.source === 'local'
        ? `<button class="ghost-btn" data-action="new-playlist">${icon('plus')} New playlist</button>`
        : `<button class="ghost-btn" data-action="reload-server">${icon('refresh')} Refresh</button>`;
      break;
    case 'favorites':
      el.innerHTML = `<button class="iconbtn" data-action="shuffle-favorites" title="Shuffle favorites">${icon('shuffle')}</button>`;
      break;
    case 'settings':
      el.innerHTML = '';
      break;
    case 'search':
      el.innerHTML = `<button class="ghost-btn" data-action="clear-search">${icon('x')} Clear</button>`;
      break;
    default:
      el.innerHTML = '';
  }
}

/* ================================================================== */
/* Playback helpers                                                    */
/* ================================================================== */

function contextLabel(key) {
  if (!key) return '';
  const [kind, ...rest] = key.split(':');
  if (kind === 'album') {
    const id = rest.join(':');
    const album = state.albumsById.get(id) || state.albumCache.get(id);
    return album ? `Album · ${album.name}` : 'Album';
  }
  if (kind === 'playlist') {
    const id = rest.join(':');
    const pl = state.playlists.find((p) => p.id === id) || state.serverPlaylists.find((p) => p.id === id);
    return pl ? `Playlist · ${pl.name}` : 'Playlist';
  }
  if (kind === 'artist') return 'Artist';
  if (key === 'favorites') return 'Favorites';
  if (key === 'home:mix') return 'Made for you';
  if (key.startsWith('search')) return 'Search results';
  return player.contextName || '';
}

function startPlayback(tracks, label = '', options = {}) {
  const list = (tracks || []).filter(Boolean);
  if (!list.length) {
    toast('There are no playable tracks here', 'error');
    return;
  }
  player.setQueue(list, options.start || 0, {
    contextName: label,
    shuffle: Boolean(options.shuffle),
  });
  if (state.npOpen) loadLyrics(player.current);
}

function playFromContext(ctxKey, index) {
  const tracks = state.contexts.get(ctxKey);
  if (!tracks || !tracks.length) return;
  player.setQueue(tracks, clamp(index, 0, tracks.length - 1), {
    contextName: contextLabel(ctxKey),
  });
}

function findTrackById(id) {
  return state.trackById.get(id) || state.serverTrackById.get(id) || (state.searchResults?.songs || []).find((t) => t.id === id) || null;
}

/* All songs — sorting, filtering and selection ---------------------- */

function currentSongs() {
  const list = state.source === 'server' ? state.serverSongs : state.tracks;
  return views.sortSongs(list || [], state.songSort);
}

function selectedSongTracks() {
  const pool = new Map();
  for (const track of [...(state.tracks || []), ...(state.serverSongs || [])]) pool.set(track.id, track);
  return [...state.selectedSongIds].map((id) => pool.get(id) || findTrackById(id)).filter(Boolean);
}

function resetSongSelection(clearMode = true) {
  state.selectedSongIds = new Set();
  if (clearMode) state.selectionMode = false;
  updateBulkBar();
}

function toggleSongSelection(id) {
  if (!id) return;
  if (state.selectedSongIds.has(id)) state.selectedSongIds.delete(id);
  else state.selectedSongIds.add(id);
  syncSelectionUI();
}

function syncSelectionUI() {
  $$('#songs-list .tr-check').forEach((btn) => {
    const on = state.selectedSongIds.has(btn.dataset.trackId);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.closest('.track-row')?.classList.toggle('selected', on);
  });
  updateBulkBar();
}

function visibleSongIds() {
  return $$('#songs-list .track-row').filter((row) => !row.hidden).map((row) => row.dataset.trackId);
}

function updateBulkBar() {
  const bar = $('#bulk-bar');
  if (!bar) return;
  const show = state.route.name === 'songs' && state.selectionMode;
  bar.hidden = !show;
  bar.classList.toggle('show', show);
  const count = state.selectedSongIds.size;
  const countEl = $('#bulk-count');
  if (countEl) countEl.textContent = String(count);
  const addBtn = bar.querySelector('[data-action="bulk-add-playlist"]');
  if (addBtn) addBtn.disabled = count === 0;
  const newBtn = bar.querySelector('[data-action="bulk-new-playlist"]');
  if (newBtn) newBtn.disabled = count === 0;
  const allBtn = bar.querySelector('[data-action="bulk-select-all"]');
  if (allBtn) allBtn.disabled = visibleSongIds().length === 0;
}

function applySongFilter() {
  const q = (state.songFilter || '').trim().toLowerCase();
  const rows = $$('#songs-list .track-row');
  let shown = 0;
  for (const row of rows) {
    const track = findTrackById(row.dataset.trackId);
    const haystack = track
      ? `${track.title || ''} ${track.artist || ''} ${track.album || ''} ${track.albumArtist || ''}`.toLowerCase()
      : '';
    const visible = !q || haystack.includes(q);
    row.hidden = !visible;
    if (visible) shown += 1;
  }
  const noMatch = $('#songs-no-match');
  if (noMatch) noMatch.hidden = !(rows.length && !shown);
  updateBulkBar();
}

function isFav(track) {
  if (!track) return false;
  return Boolean(track.starred) || state.favIds.has(track.id);
}

async function toggleFavorite(track) {
  if (!track) return;
  if (track.source === 'server') {
    const want = !track.starred;
    const res = await api.subsonic.call(want ? 'star' : 'unstar', { id: track.trackId });
    if (!res.ok) {
      toast(res.error || 'Could not update favorite', 'error');
      return;
    }
    track.starred = want;
    for (const t of state.serverStarred.songs || []) {
      if (t.id === track.id) t.starred = want;
    }
    state.serverStarredLoaded = false;
    toast(want ? 'Added to favorites' : 'Removed from favorites', want ? 'success' : 'default');
  } else {
    if (state.favIds.has(track.id)) {
      state.favIds.delete(track.id);
      state.favorites = state.favorites.filter((f) => f.id !== track.id);
      toast('Removed from favorites');
    } else {
      state.favIds.add(track.id);
      state.favorites = [snapshot(track), ...state.favorites.filter((f) => f.id !== track.id)];
      toast('Added to favorites', 'success');
    }
    await api.favorites.set(state.favorites).catch(() => {});
  }

  updateFavUI();
  updateRowHeart(track);
  if (state.route.name === 'favorites') await renderCurrentView();
}

function updateRowHeart(track) {
  const rows = $$(`.track-row[data-track-id="${cssEscape(track.id)}"] .tr-title`);
  const title = track.title;
  const heart = `<span class="tr-fav" style="display:inline-flex;vertical-align:-3px;margin-left:6px">${icon('heart')}</span>`;
  rows.forEach((el) => {
    const existing = el.querySelector('.tr-fav');
    if (isFav(track) && !existing) el.insertAdjacentHTML('beforeend', heart);
    if (!isFav(track) && existing) existing.remove();
    if (!el.textContent.trim()) el.textContent = title;
  });
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function updateFavUI() {
  const fav = isFav(player.current);
  $('#pb-fav')?.classList.toggle('liked', fav);
  $('#np-fav')?.classList.toggle('liked', fav);
}

function recordListen(track) {
  if (!track) return;
  state.recentTracks = [track.id, ...state.recentTracks.filter((id) => id !== track.id)].slice(0, 40);
  const albumId = track.source === 'server' ? (track.albumId || null) : localAlbumIdFor(track);
  if (albumId) {
    state.recentAlbumIds = [albumId, ...state.recentAlbumIds.filter((id) => id !== albumId)].slice(0, 16);
  }
  state.plays[track.id] = (state.plays[track.id] || 0) + 1;
  saveUiState();
}

/* ================================================================== */
/* Player UI                                                           */
/* ================================================================== */

function bindPlayerEvents() {
  player.addEventListener('trackchange', (event) => {
    const track = event.detail;
    state.currentId = track?.id || null;
    state.lyricsLoadedId = null;
    updateNowPlayingUI(track);
    updateCurrentRows();
    updateQueueCurrent();
    if (state.npOpen && track) loadLyrics(track);
    if (!track) lyrics?.setEmpty('Nothing playing', 'Pick a track and the lyrics will follow.');
    updateTransport();
  });

  player.addEventListener('queue', () => {
    if (state.queueOpen) renderQueue();
    updateQueueCurrent();
  });

  player.addEventListener('state', () => {
    updateTransport();
  });

  player.addEventListener('duration', () => {
    updateDurationUI();
  });

  player.addEventListener('time', () => {
    if (state.npOpen) updateProgressBars();
  });

  player.addEventListener('volume', () => {
    syncVolumeUI();
    clearTimeout(volumeSaveTimer);
    volumeSaveTimer = setTimeout(() => {
      api.settings.update({ volume: player.audio.volume, muted: player.audio.muted }).catch(() => {});
    }, 400);
  });

  player.addEventListener('error', (event) => {
    const track = event.detail;
    toast(track ? `Could not play “${track.title}”` : 'Playback error', 'error');
  });

  window.api.media?.onCommand((cmd) => {
    if (cmd === 'playpause') player.toggle();
    else if (cmd === 'next') player.next(false);
    else if (cmd === 'previous') player.previous();
    else if (cmd === 'stop') player.pause();
  });
}

function updateNowPlayingUI(track) {
  const fallback = `<div class="cover cover-fallback" style="--c1:hsl(${state.settings.accent === 'auto' ? 262 : Number(state.settings.accent) || 262} 62% 46%);--c2:#0b0b14"><span class="cover-glyph">${icon('music')}</span></div>`;
  const art = track ? `<div class="cover">${track.coverUrl ? `<img src="${esc(track.coverUrl)}" alt="" />` : `<div class="cover-fallback cover" style="--c1:hsl(262 62% 46%);--c2:#0b0b14"><span class="cover-glyph">${icon('disc')}</span></div>`}</div>` : fallback;

  const pbCover = $('#pb-cover');
  if (pbCover) pbCover.innerHTML = art;
  const npArt = $('#np-art');
  if (npArt) npArt.innerHTML = art;

  $('#pb-title').textContent = track?.title || 'Nothing playing';
  $('#pb-artist').textContent = track?.artist || 'Pick something beautiful';
  $('#np-title').textContent = track?.title || 'Nothing playing';
  $('#np-artist').textContent = track?.artist || 'Pick something beautiful';
  $('#np-album').textContent = track?.album || '—';
  $('#np-context').textContent = player.contextName || track?.album || '';

  const backdrop = track?.coverUrl ? `url("${track.coverUrl}")` : 'none';
  $('#np-backdrop').style.backgroundImage = backdrop;
  $('#np-art-glow').style.backgroundImage = backdrop;

  const albumId = track?.source === 'server' ? track.albumId : track ? localAlbumIdFor(track) : null;
  const goto = $('#np-goto');
  if (goto) goto.classList.toggle('disabled', !albumId);

  if (track) applyAccent(track.album || track.artist);
  updateFavUI();
  updateTransport();
}

function updateTransport() {
  const playing = player.isPlaying;
  document.body.classList.toggle('is-playing', playing);

  if (playing && player.current && state.lastRecordedId !== player.current.id) {
    state.lastRecordedId = player.current.id;
    recordListen(player.current);
  }

  $('#pb-shuffle')?.classList.toggle('active', player.shuffle);
  $('#np-shuffle')?.classList.toggle('active', player.shuffle);
  $('#pb-repeat')?.classList.toggle('active', player.repeat !== 'off');
  $('#np-repeat')?.classList.toggle('active', player.repeat !== 'off');

  const repeatIcon = player.repeat === 'one' ? 'repeat1' : 'repeat';
  const repeatTitle = player.repeat === 'one' ? 'Repeat one' : player.repeat === 'all' ? 'Repeat all' : 'Repeat off';
  if ($('#pb-repeat')) { $('#pb-repeat').innerHTML = icon(repeatIcon); $('#pb-repeat').title = repeatTitle; }
  if ($('#np-repeat')) { $('#np-repeat').innerHTML = icon(repeatIcon); $('#np-repeat').title = repeatTitle; }

  $('#pb-toggle')?.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#np-toggle')?.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (navigator.mediaSession) {
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch { /* ignore */ }
  }
  const track = player.current;
  document.title = track ? `${track.title} · ${track.artist} — Aurora` : 'Aurora';
}

function updateDurationUI() {
  const d = player.duration;
  const current = player.currentTime;
  $('#pb-total').textContent = fmtTime(d);
  $('#np-total').textContent = fmtTime(d);
  $('#pb-current').textContent = fmtTime(current);
  $('#np-current').textContent = fmtTime(current);
}

function updateProgressBars() {
  const d = player.duration || 0;
  const t = player.currentTime || 0;
  const ratio = d > 0 ? clamp(t / d, 0, 1) : 0;
  paintProgress($('#pb-progress'), ratio);
  paintProgress($('#np-progress'), ratio);
  setText($('#pb-current'), fmtTime(t));
  setText($('#pb-total'), fmtTime(d));
  setText($('#np-current'), fmtTime(t));
  setText($('#np-total'), fmtTime(d));
  if (state.npOpen) lyrics?.setTime(t);
}

function paintProgress(el, ratio) {
  if (!el) return;
  const fill = el.querySelector('.progress-fill');
  if (fill) {
    const value = `${(clamp(ratio, 0, 1) * 100).toFixed(2)}%`;
    if (fill.style.width !== value) fill.style.width = value;
  }
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function syncVolumeUI() {
  const vol = player.volume;
  const fill = $('#volume-fill');
  if (fill) fill.style.width = `${clamp(vol, 0, 1) * 100}%`;
  const muted = player.audio.muted || vol === 0;
  const name = muted ? 'volumeMute' : vol < 0.45 ? 'volumeLow' : 'volume';
  const btn = $('#pb-mute');
  if (btn) {
    btn.innerHTML = icon(name);
    btn.title = muted ? 'Unmute' : 'Mute';
  }
}

function startRaf() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    updateProgressBars();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

/* ================================================================== */
/* Lyrics                                                              */
/* ================================================================== */

async function loadLyrics(track) {
  if (!track || !lyrics) return;
  if (state.lyricsLoadedId === track.id) return;
  state.lyricsLoadedId = track.id;
  lyrics.setLoading();

  let result = null;
  try {
    result = track.source === 'server'
      ? await api.lyrics.server(track)
      : await api.lyrics.local(track);
  } catch {
    result = null;
  }
  if (state.lyricsLoadedId !== track.id) return;
  if (result?.text) {
    lyrics.setText(result.text, track.id);
    lyrics.setOffset(state.lyricsOffset);
    lyrics.setTime(player.currentTime);
  } else {
    lyrics.setEmpty(
      'No lyrics for this track',
      'Add a .lrc file next to the song, embed lyrics in the audio tags, or use a server with OpenSubsonic lyrics.',
    );
  }
}

function setLyricsOffset(value) {
  state.lyricsOffset = clamp(Math.round(Number(value) * 100) / 100, -30, 30);
  lyrics?.setOffset(state.lyricsOffset);
  lyrics?.setTime(player.currentTime);
  updateOffsetLabel();
  saveUiState();
}

function updateOffsetLabel() {
  const el = $('#lyrics-offset');
  if (!el) return;
  const v = state.lyricsOffset;
  el.textContent = `${v > 0 ? '+' : ''}${v.toFixed(2).replace(/0$/, '')}s`;
}

/* ================================================================== */
/* Queue                                                               */
/* ================================================================== */

function toggleQueue(force) {
  state.queueOpen = typeof force === 'boolean' ? force : !state.queueOpen;
  $('#queue-panel').classList.toggle('open', state.queueOpen);
  $('#pb-queue')?.classList.toggle('active', state.queueOpen);
  if (state.queueOpen) renderQueue();
}

function renderQueue() {
  const list = $('#queue-list');
  const context = $('#queue-context');
  if (!list) return;
  const tracks = player.orderedTracks;
  context.textContent = tracks.length
    ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}${player.contextName ? ` · ${player.contextName}` : ''}`
    : 'Nothing queued';

  if (!tracks.length) {
    list.innerHTML = `<div class="qp-empty">${icon('queue')}<div>Your queue is empty.</div><div style="margin-top:4px;font-size:11px;opacity:.7">Play an album or add a song to get started.</div></div>`;
    return;
  }

  const current = player.current;
  list.innerHTML = tracks.map((track, pos) => `
    <div class="qp-row ${current?.id === track.id ? 'current' : ''}" data-pos="${pos}" data-track-id="${esc(track.id)}" draggable="true">
      <span class="qp-drag">${icon('rows')}</span>
      <div class="qp-art">${coverHTML(track)}</div>
      <div class="qp-info">
        <div class="qp-title">${esc(track.title)}</div>
        <div class="qp-sub">${esc(track.artist || '')}</div>
      </div>
      <button class="qp-remove" data-action="remove-queue" data-pos="${pos}" title="Remove from queue">${icon('x')}</button>
    </div>`).join('');
}

function updateQueueCurrent() {
  const current = player.current;
  $$('#queue-list .qp-row').forEach((row) => {
    row.classList.toggle('current', current?.id === row.dataset.trackId);
  });
}

/* ================================================================== */
/* Now playing                                                         */
/* ================================================================== */

function openNowPlaying() {
  if (!player.current) {
    toast('Nothing is playing yet — pick a track first');
    return;
  }
  state.npOpen = true;
  const np = $('#np');
  np.hidden = false;
  np.classList.remove('hidden');
  document.body.classList.add('np-open');
  updateNowPlayingUI(player.current);
  loadLyrics(player.current);
  requestAnimationFrame(() => {
    lyrics?.scrollToActive();
    $('#np')?.focus?.();
  });
}

function closeNowPlaying() {
  state.npOpen = false;
  $('#np').hidden = true;
  document.body.classList.remove('np-open');
}

/* ================================================================== */
/* Views refresh                                                       */
/* ================================================================== */

function updateCurrentRows() {
  const currentId = state.currentId;
  $$('.track-row').forEach((row) => {
    row.classList.toggle('current', row.dataset.trackId === currentId);
  });
  $$('.qp-row').forEach((row) => {
    row.classList.toggle('current', row.dataset.trackId === currentId);
  });
}

/* ================================================================== */
/* Modals                                                              */
/* ================================================================== */

function openModal(html, { wide = false } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-scrim" data-modal-scrim><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  const input = root.querySelector('.modal input');
  if (input) {
    setTimeout(() => { input.focus(); input.select?.(); }, 60);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        root.querySelector('.modal .btn-primary')?.click();
      }
    });
  }
}

function closeModal() {
  $('#modal-root').innerHTML = '';
}

function openTrackMenu(track) {
  if (!track) return;
  state.pendingTrack = track;
  const liked = isFav(track);
  const inLocalPlaylist = state.route.name === 'playlist'
    && state.playlists.some((p) => p.id === state.route.params.id);
  openModal(`
    <button class="iconbtn modal-close" data-action="close-modal" title="Close">${icon('x')}</button>
    <div class="row" style="gap:14px;margin-bottom:20px;padding-right:30px">
      <div style="width:56px;height:56px;border-radius:11px;overflow:hidden;flex:none">${coverHTML(track)}</div>
      <div style="min-width:0">
        <div style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(track.title)}</div>
        <div class="muted" style="font-size:11.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(track.artist || '')}</div>
      </div>
    </div>
    <div class="modal-list">
      <button class="modal-list-item" data-action="m-play-next">${icon('play')}<span class="grow">Play next</span></button>
      <button class="modal-list-item" data-action="m-queue">${icon('queue')}<span class="grow">Add to queue</span></button>
      <button class="modal-list-item" data-action="m-playlist">${icon('listMusic')}<span class="grow">Add to playlist</span></button>
      <button class="modal-list-item" data-action="m-fav">${icon('heart')}<span class="grow">${liked ? 'Remove from favorites' : 'Add to favorites'}</span></button>
      <button class="modal-list-item" data-action="m-album">${icon('disc')}<span class="grow">Go to album</span></button>
      ${inLocalPlaylist ? `<button class="modal-list-item" data-action="m-remove-playlist">${icon('trash')}<span class="grow">Remove from this playlist</span></button>` : ''}
      ${track.source === 'local' ? `<button class="modal-list-item" data-action="m-reveal">${icon('folder')}<span class="grow">Show in folder</span></button>` : ''}
    </div>`);
}

function openAlbumMenu(album) {
  if (!album) return;
  state.pendingAlbum = album;
  openModal(`
    <button class="iconbtn modal-close" data-action="close-modal" title="Close">${icon('x')}</button>
    <div class="row" style="gap:14px;margin-bottom:20px;padding-right:30px">
      <div style="width:64px;height:64px;border-radius:12px;overflow:hidden;flex:none">${coverHTML(album)}</div>
      <div style="min-width:0">
        <div style="font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(album.name)}</div>
        <div class="muted" style="font-size:11.5px;margin-top:2px">${esc(album.artist || '')}</div>
      </div>
    </div>
    <div class="modal-list">
      <button class="modal-list-item" data-action="m-album-play">${icon('play')}<span class="grow">Play album</span></button>
      <button class="modal-list-item" data-action="m-album-shuffle">${icon('shuffle')}<span class="grow">Shuffle album</span></button>
      <button class="modal-list-item" data-action="m-album-queue">${icon('queue')}<span class="grow">Add album to queue</span></button>
      <button class="modal-list-item" data-action="m-album-playlist">${icon('plus')}<span class="grow">Add album to playlist</span></button>
      <button class="modal-list-item" data-action="m-album-artist">${icon('mic')}<span class="grow">Go to artist</span></button>
    </div>`);
}

function openPlaylistModal({ mode = 'create', playlist = null, tracks = [] } = {}) {
  openModal(`
    <button class="iconbtn modal-close" data-action="close-modal" title="Close">${icon('x')}</button>
    <h2>${mode === 'create' ? 'New playlist' : 'Rename playlist'}</h2>
    <p class="modal-sub">${mode === 'create' ? `${tracks.length ? `${tracks.length} track${tracks.length === 1 ? '' : 's'} will be added. ` : ''}Give your collection a name.` : 'Choose a new name for this playlist.'}</p>
    <div class="field">
      <label for="playlist-name">Playlist name</label>
      <input class="input" id="playlist-name" maxlength="70" placeholder="Late night drive" value="${esc(playlist?.name || '')}" />
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="close-modal">Cancel</button>
      <button class="btn btn-primary" data-action="confirm-playlist" data-mode="${mode}" data-playlist-id="${esc(playlist?.id || '')}">${mode === 'create' ? 'Create playlist' : 'Save name'}</button>
    </div>
  `);
  state.pendingPlaylist = { mode, playlist, tracks };
}

function openAddToPlaylist(input) {
  const tracks = (Array.isArray(input) ? input : [input]).filter(Boolean);
  if (!tracks.length) return;
  state.pendingTracks = tracks;
  state.pendingTrack = tracks[0];
  const single = tracks.length === 1;
  const playlists = state.playlists;
  openModal(`
    <button class="iconbtn modal-close" data-action="close-modal" title="Close">${icon('x')}</button>
    <h2>Add to playlist</h2>
    <p class="modal-sub">${single ? esc(tracks[0].title) : `${tracks.length} songs`}</p>
    ${playlists.length ? `<div class="modal-list">
      ${playlists.map((p) => {
        const existing = new Set((p.tracks || []).map((t) => t.id));
        const already = tracks.filter((t) => existing.has(t.id)).length;
        return `
        <button class="modal-list-item" data-action="m-pick-playlist" data-playlist-id="${esc(p.id)}">
          ${playlistArtSmall(p)}
          <div class="grow"><div class="ml-name">${esc(p.name)}</div><div class="ml-sub">${p.tracks?.length || 0} songs${already ? ` · ${already} already added` : ''}</div></div>
          ${single && already ? `<span class="check">${icon('check')}</span>` : ''}
        </button>`;
      }).join('')}
    </div>` : `<p class="muted" style="font-size:12.5px;margin:14px 0">You have no local playlists yet.</p>`}
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="close-modal">Cancel</button>
      <button class="btn btn-soft" data-action="m-new-playlist">${icon('plus')} New playlist</button>
    </div>`);
}

/* Add-songs picker used on a playlist page ------------------------- */

async function openAddSongsModal(playlistId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  if (state.source === 'server' && !state.serverSongsLoaded) await loadServerSongs();
  state.addSongPlaylistId = playlistId;
  state.addSongSelected = new Set();
  state.addSongQuery = '';
  const candidates = currentSongs();
  const existing = new Set((pl.tracks || []).map((t) => t.id));
  openModal(`
    <button class="iconbtn modal-close" data-action="close-modal" title="Close">${icon('x')}</button>
    <h2>Add songs</h2>
    <p class="modal-sub"><strong id="add-song-count">0</strong> selected · adding to “${esc(pl.name)}”</p>
    <label class="filter-field add-song-filter" for="add-song-search">
      ${icon('search')}
      <input id="add-song-search" type="text" placeholder="Search your library…" autocomplete="off" spellcheck="false" />
    </label>
    <div class="add-song-list" id="add-song-list">
      ${candidates.map((t) => {
        const added = existing.has(t.id);
        return `
        <button class="add-song-row ${added ? 'is-added' : ''}" data-action="pick-add-song" data-track-id="${esc(t.id)}" data-added="${added ? '1' : '0'}">
          <span class="tr-check">${icon('check')}</span>
          <div class="as-art">${coverHTML(t)}</div>
          <div class="as-main">
            <div class="as-title">${esc(t.title)}</div>
            <div class="as-sub">${esc(t.artist || 'Unknown Artist')}${t.album ? ` · ${esc(t.album)}` : ''}</div>
          </div>
          ${added ? '<span class="as-added">Added</span>' : `<span class="as-dur">${fmtTime(t.duration)}</span>`}
        </button>`;
      }).join('')}
    </div>
    <div id="add-song-none" class="add-song-none" hidden>${icon('search')} No songs match your search.</div>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-sm" data-action="add-song-select-all">Select all shown</button>
      <span class="grow"></span>
      <button class="btn btn-ghost" data-action="close-modal">Cancel</button>
      <button class="btn btn-primary" data-action="confirm-add-songs" disabled>Add songs</button>
    </div>`, { wide: true });
}

function updateAddSongModal() {
  const count = state.addSongSelected.size;
  const countEl = $('#add-song-count');
  if (countEl) countEl.textContent = String(count);
  const confirm = $('[data-action="confirm-add-songs"]');
  if (confirm) {
    confirm.disabled = count === 0;
    confirm.textContent = count ? `Add ${count} song${count === 1 ? '' : 's'}` : 'Add songs';
  }
  $$('#add-song-list .add-song-row').forEach((row) => {
    const on = state.addSongSelected.has(row.dataset.trackId);
    row.classList.toggle('selected', on);
    row.querySelector('.tr-check')?.classList.toggle('on', on);
  });
}

function applyAddSongFilter() {
  const q = (state.addSongQuery || '').trim().toLowerCase();
  const rows = $$('#add-song-list .add-song-row');
  let shown = 0;
  for (const row of rows) {
    const track = findTrackById(row.dataset.trackId);
    const haystack = track
      ? `${track.title || ''} ${track.artist || ''} ${track.album || ''} ${track.albumArtist || ''}`.toLowerCase()
      : '';
    const visible = !q || haystack.includes(q);
    row.hidden = !visible;
    if (visible) shown += 1;
  }
  const none = $('#add-song-none');
  if (none) none.hidden = !(rows.length && !shown);
}

function visibleAddSongIds() {
  return $$('#add-song-list .add-song-row')
    .filter((row) => !row.hidden && row.dataset.added !== '1')
    .map((row) => row.dataset.trackId);
}

async function reorderPlaylistTrack(playlistId, from, to) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl || from === to) return;
  const tracks = [...(pl.tracks || [])];
  if (!Number.isFinite(from) || from < 0 || from >= tracks.length) return;
  const [moved] = tracks.splice(from, 1);
  tracks.splice(clamp(to, 0, tracks.length), 0, moved);
  pl.tracks = tracks;
  await api.playlists.set(state.playlists).catch(() => {});
  await renderCurrentView({ keepScroll: true });
}

function playlistArtSmall(playlist) {
  const track = (playlist.tracks || []).find((t) => t.coverUrl);
  return `<div class="ml-art">${coverHTML(track || { name: playlist.name })}</div>`;
}

function openDeletePlaylist(playlist) {
  state.pendingPlaylist = { playlist };
  openModal(`
    <button class="iconbtn modal-close" data-action="close-modal" title="Close">${icon('x')}</button>
    <h2>Delete playlist?</h2>
    <p class="modal-sub">“${esc(playlist.name)}” will be removed. Your music files stay untouched.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="close-modal">Cancel</button>
      <button class="btn btn-danger" data-action="confirm-delete-playlist">${icon('trash')} Delete</button>
    </div>`);
}

/* ================================================================== */
/* Actions                                                             */
/* ================================================================== */

async function handleAction(action, el, event) {
  switch (action) {
    /* ---- navigation ---- */
    case 'open-album': {
      const id = el.dataset.albumId;
      const source = el.dataset.source || (id?.startsWith('srv:') ? 'server' : 'local');
      await navigate('album', { id, source });
      break;
    }
    case 'open-artist': {
      const id = el.dataset.artistId;
      const source = el.dataset.source || (id?.startsWith('srv:') ? 'server' : 'local');
      await navigate('artist', { id, source });
      break;
    }
    case 'open-playlist': {
      const id = el.dataset.playlistId;
      const source = el.dataset.source || (id?.startsWith('srv:') ? 'server' : 'local');
      await navigate('playlist', { id, source });
      break;
    }

    /* ---- playback ---- */
    case 'play-album': {
      const album = await resolveAlbum(el.dataset.albumId, el.dataset.source);
      if (!album) break;
      const tracks = album.tracks || [];
      startPlayback(tracks, `Album · ${album.name}`);
      break;
    }
    case 'shuffle-album': {
      const album = await resolveAlbum(el.dataset.albumId, el.dataset.source);
      if (!album) break;
      startPlayback(album.tracks || [], `Album · ${album.name}`, { shuffle: true });
      break;
    }
    case 'queue-album': {
      const album = await resolveAlbum(el.dataset.albumId, el.dataset.source);
      if (!album) break;
      player.addManyToQueue(album.tracks || []);
      toast(`Added “${album.name}” to the queue`, 'success');
      if (state.queueOpen) renderQueue();
      break;
    }
    case 'play-artist': {
      const artist = await resolveArtist(el.dataset.artistId, el.dataset.source);
      if (!artist) break;
      startPlayback(artist.songs || [], `Artist · ${artist.name}`);
      break;
    }
    case 'play-playlist': {
      const pl = await resolvePlaylist(el.dataset.playlistId, el.dataset.source || state.source);
      if (!pl) break;
      startPlayback(pl.tracks || [], `Playlist · ${pl.name}`);
      break;
    }
    case 'shuffle-playlist': {
      const pl = await resolvePlaylist(el.dataset.playlistId, el.dataset.source || state.source);
      if (!pl) break;
      startPlayback(pl.tracks || [], `Playlist · ${pl.name}`, { shuffle: true });
      break;
    }
    case 'play-favorites': {
      const tracks = state.source === 'server' ? (await ensureServerStarred()).songs : resolveFavorites();
      startPlayback(tracks || [], 'Favorites');
      break;
    }
    case 'shuffle-favorites': {
      const tracks = state.source === 'server' ? (await ensureServerStarred()).songs : resolveFavorites();
      startPlayback(tracks || [], 'Favorites', { shuffle: true });
      break;
    }
    case 'play-mix':
      startPlayback(state.source === 'server' ? state.serverRandom : state.mixTracks, 'Made for you');
      break;
    case 'play-search-top': {
      const track = findTrackById(el.dataset.trackId);
      if (track) player.playSingle(track, 'Search');
      break;
    }
    case 'shuffle-all': {
      if (state.source === 'server') {
        const res = await api.subsonic.call('getRandomSongs', { size: 100 });
        if (!res.ok) return toast(res.error || 'Could not load songs', 'error');
        startPlayback(res.data || [], 'Shuffle', { shuffle: true });
      } else {
        startPlayback(state.tracks, 'Shuffle', { shuffle: true });
      }
      break;
    }

    /* ---- all songs ---- */
    case 'play-all-songs':
      startPlayback(currentSongs(), 'Songs');
      break;
    case 'shuffle-all-songs':
      startPlayback(currentSongs(), 'Songs', { shuffle: true });
      break;
    case 'toggle-select-mode':
      state.selectionMode = !state.selectionMode;
      if (!state.selectionMode) state.selectedSongIds.clear();
      await renderCurrentView();
      break;
    case 'exit-select-mode':
      state.selectionMode = false;
      state.selectedSongIds.clear();
      await renderCurrentView();
      break;
    case 'select-track':
      toggleSongSelection(el.dataset.trackId);
      break;
    case 'bulk-select-all': {
      const ids = visibleSongIds();
      if (!ids.length) break;
      const allSelected = ids.every((id) => state.selectedSongIds.has(id));
      for (const id of ids) {
        if (allSelected) state.selectedSongIds.delete(id);
        else state.selectedSongIds.add(id);
      }
      syncSelectionUI();
      break;
    }
    case 'bulk-add-playlist': {
      const tracks = selectedSongTracks();
      if (!tracks.length) return toast('Select some songs first');
      openAddToPlaylist(tracks);
      break;
    }
    case 'bulk-new-playlist': {
      const tracks = selectedSongTracks();
      if (!tracks.length) return toast('Select some songs first');
      openPlaylistModal({ mode: 'create', tracks });
      break;
    }
    case 'song-sort-menu': {
      const options = [
        ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'],
        ['recent', 'Recently added'], ['duration', 'Duration'],
      ];
      openModal(`
        <button class="iconbtn modal-close" data-action="close-modal" title="Close">${icon('x')}</button>
        <h2>Sort songs</h2>
        <p class="modal-sub">Choose how the song list is ordered.</p>
        <div class="modal-list">
          ${options.map(([key, label]) => `<button class="modal-list-item" data-action="set-song-sort" data-sort="${key}">
            <span class="grow">${label}</span>${state.songSort === key ? `<span class="check">${icon('check')}</span>` : ''}
          </button>`).join('')}
        </div>`);
      break;
    }
    case 'set-song-sort':
      state.songSort = el.dataset.sort;
      saveUiState();
      closeModal();
      renderTopActions();
      await renderCurrentView();
      break;
    case 'queue-album-menu':
      break;

    /* ---- current track ---- */
    case 'fav-current':
      await toggleFavorite(player.current);
      break;
    case 'add-current-to-playlist':
      openAddToPlaylist(player.current);
      break;
    case 'go-to-album': {
      const track = player.current;
      if (!track) break;
      let id = track.source === 'server' ? track.albumId : localAlbumIdFor(track);
      if (!id && track.source === 'server') {
        const album = state.serverAlbums.find((a) => a.name === track.album && a.artist === track.albumArtist);
        id = album?.id;
      }
      const album = await resolveAlbum(id, track.source);
      if (!album) return toast('Could not find this album', 'error');
      if (state.npOpen) closeNowPlaying();
      await navigate('album', { id: album.id, source: album.source });
      break;
    }

    /* ---- track menu ---- */
    case 'track-menu': {
      const tracks = state.contexts.get(el.dataset.ctx);
      const track = tracks?.[Number(el.dataset.idx)];
      openTrackMenu(track);
      break;
    }
    case 'm-play-next':
      player.addToQueue(state.pendingTrack, true);
      toast('Playing next', 'success');
      closeModal();
      break;
    case 'm-queue':
      player.addToQueue(state.pendingTrack, false);
      toast('Added to queue', 'success');
      closeModal();
      break;
    case 'm-playlist':
      openAddToPlaylist(state.pendingTrack);
      break;
    case 'm-fav':
      await toggleFavorite(state.pendingTrack);
      closeModal();
      break;
    case 'm-album': {
      const track = state.pendingTrack;
      closeModal();
      if (!track) break;
      const id = track.source === 'server' ? track.albumId : localAlbumIdFor(track);
      const album = await resolveAlbum(id, track.source);
      if (album) await navigate('album', { id: album.id, source: album.source });
      else toast('Could not find this album', 'error');
      break;
    }
    case 'm-reveal':
      if (state.pendingTrack?.path) api.library.reveal(state.pendingTrack.path);
      closeModal();
      break;
    case 'm-remove-playlist': {
      const track = state.pendingTrack;
      const playlistId = state.route.name === 'playlist' ? state.route.params.id : null;
      const pl = state.playlists.find((p) => p.id === playlistId);
      if (track && pl) {
        const before = (pl.tracks || []).length;
        pl.tracks = (pl.tracks || []).filter((t) => t.id !== track.id);
        if (pl.tracks.length !== before) {
          await api.playlists.set(state.playlists).catch(() => {});
          toast(`Removed from “${pl.name}”`);
          renderSidebar();
          await renderCurrentView();
        }
      }
      closeModal();
      break;
    }

    /* ---- album menu ---- */
    case 'album-menu': {
      const album = await resolveAlbum(el.dataset.albumId, el.dataset.source);
      openAlbumMenu(album);
      break;
    }
    case 'm-album-play':
      closeModal();
      if (state.pendingAlbum) startPlayback(state.pendingAlbum.tracks || [], `Album · ${state.pendingAlbum.name}`);
      break;
    case 'm-album-shuffle':
      closeModal();
      if (state.pendingAlbum) startPlayback(state.pendingAlbum.tracks || [], `Album · ${state.pendingAlbum.name}`, { shuffle: true });
      break;
    case 'm-album-queue':
      if (state.pendingAlbum) {
        player.addManyToQueue(state.pendingAlbum.tracks || []);
        toast('Album added to queue', 'success');
      }
      closeModal();
      break;
    case 'm-album-playlist':
      if (state.pendingAlbum?.tracks?.length) {
        openPlaylistModal({ mode: 'create', tracks: state.pendingAlbum.tracks });
      }
      break;
    case 'm-album-artist': {
      const album = state.pendingAlbum;
      closeModal();
      if (album) await navigate('artist', { id: album.artistId || `local:artist:${album.artist}`, source: album.source });
      break;
    }

    /* ---- queue ---- */
    case 'toggle-queue':
      toggleQueue();
      break;
    case 'close-queue':
      toggleQueue(false);
      break;
    case 'clear-queue':
      player.clear();
      closeModal();
      break;
    case 'remove-queue':
      player.removeAt(Number(el.dataset.pos));
      break;
    case 'queue-to-playlist':
      if (!player.queue.length) return toast('The queue is empty');
      openPlaylistModal({ mode: 'create', tracks: player.orderedTracks });
      break;

    /* ---- playlists ---- */
    case 'new-playlist':
      openPlaylistModal({ mode: 'create' });
      break;
    case 'confirm-playlist': {
      const input = $('#playlist-name');
      const name = input?.value.trim();
      if (!name) return toast('Please enter a name', 'error');
      const mode = el.dataset.mode;
      if (mode === 'create') {
        const tracks = (state.pendingPlaylist?.tracks || []).map(snapshot);
        const pl = { id: `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, createdAt: Date.now(), tracks };
        state.playlists = [pl, ...state.playlists];
        await api.playlists.set(state.playlists).catch(() => {});
        toast(`Playlist “${name}” created`, 'success');
        if (state.route.name === 'songs') {
          state.selectionMode = false;
          state.selectedSongIds.clear();
        }
      } else {
        const id = el.dataset.playlistId;
        state.playlists = state.playlists.map((p) => (p.id === id ? { ...p, name } : p));
        await api.playlists.set(state.playlists).catch(() => {});
        toast('Playlist renamed', 'success');
      }
      closeModal();
      renderSidebar();
      await renderCurrentView();
      break;
    }
    case 'rename-playlist': {
      const pl = state.playlists.find((p) => p.id === el.dataset.playlistId);
      if (pl) openPlaylistModal({ mode: 'rename', playlist: pl });
      break;
    }
    case 'delete-playlist': {
      const pl = state.playlists.find((p) => p.id === el.dataset.playlistId);
      if (pl) openDeletePlaylist(pl);
      break;
    }
    case 'confirm-delete-playlist': {
      const pl = state.pendingPlaylist?.playlist;
      if (pl) {
        state.playlists = state.playlists.filter((p) => p.id !== pl.id);
        await api.playlists.set(state.playlists).catch(() => {});
        toast('Playlist deleted');
      }
      closeModal();
      renderSidebar();
      await navigate('playlists', {}, true);
      break;
    }
    case 'm-pick-playlist': {
      const tracks = (state.pendingTracks?.length ? state.pendingTracks : [state.pendingTrack]).filter(Boolean);
      const pl = state.playlists.find((p) => p.id === el.dataset.playlistId);
      if (tracks.length && pl) {
        const existing = new Set((pl.tracks || []).map((t) => t.id));
        const fresh = tracks.filter((t) => !existing.has(t.id)).map(snapshot);
        if (!fresh.length) {
          toast('Already in this playlist');
        } else {
          pl.tracks = [...(pl.tracks || []), ...fresh];
          await api.playlists.set(state.playlists).catch(() => {});
          toast(fresh.length === 1
            ? `Added to “${pl.name}”`
            : `Added ${fresh.length} songs to “${pl.name}”`, 'success');
        }
      }
      closeModal();
      if (state.route.name === 'songs' && state.selectionMode) {
        state.selectionMode = false;
        state.selectedSongIds.clear();
      }
      renderSidebar();
      await renderCurrentView();
      break;
    }
    case 'm-new-playlist': {
      const tracks = (state.pendingTracks?.length ? state.pendingTracks : [state.pendingTrack]).filter(Boolean);
      openPlaylistModal({ mode: 'create', tracks });
      break;
    }
    case 'playlist-add-songs':
      await openAddSongsModal(el.dataset.playlistId);
      break;
    case 'pick-add-song': {
      const id = el.dataset.trackId;
      if (!id) break;
      if (el.dataset.added === '1') {
        toast('Already in this playlist');
        break;
      }
      if (state.addSongSelected.has(id)) state.addSongSelected.delete(id);
      else state.addSongSelected.add(id);
      updateAddSongModal();
      break;
    }
    case 'add-song-select-all': {
      const ids = visibleAddSongIds();
      if (!ids.length) break;
      const allSelected = ids.every((id) => state.addSongSelected.has(id));
      for (const id of ids) {
        if (allSelected) state.addSongSelected.delete(id);
        else state.addSongSelected.add(id);
      }
      updateAddSongModal();
      break;
    }
    case 'confirm-add-songs': {
      const pl = state.playlists.find((p) => p.id === state.addSongPlaylistId);
      if (!pl || !state.addSongSelected.size) {
        toast('Choose at least one song');
        break;
      }
      const existing = new Set((pl.tracks || []).map((t) => t.id));
      const chosen = currentSongs()
        .filter((t) => state.addSongSelected.has(t.id) && !existing.has(t.id))
        .map(snapshot);
      if (!chosen.length) {
        toast('Those songs are already in this playlist');
        break;
      }
      pl.tracks = [...(pl.tracks || []), ...chosen];
      await api.playlists.set(state.playlists).catch(() => {});
      toast(chosen.length === 1 ? `Added 1 song to “${pl.name}”` : `Added ${chosen.length} songs to “${pl.name}”`, 'success');
      state.addSongPlaylistId = null;
      state.addSongSelected = new Set();
      state.addSongQuery = '';
      closeModal();
      renderSidebar();
      await renderCurrentView({ keepScroll: true });
      break;
    }

    /* ---- settings / appearance ---- */
    case 'set-theme':
      await updateSettings({ theme: el.dataset.theme });
      applySettingsToDOM();
      await renderCurrentView();
      break;
    case 'set-accent':
      await updateSettings({ accent: el.dataset.accent });
      applyAccent();
      await renderCurrentView();
      break;
    case 'toggle-motion':
      await updateSettings({ reduceMotion: !state.settings.reduceMotion });
      applySettingsToDOM();
      await renderCurrentView();
      break;
    case 'sort-menu': {
      const options = [['name', 'Name'], ['artist', 'Artist'], ['year', 'Year'], ['recent', 'Recently added']];
      openModal(`
        <button class="iconbtn modal-close" data-action="close-modal" title="Close">${icon('x')}</button>
        <h2>Sort albums</h2>
        <p class="modal-sub">How your collection is arranged.</p>
        <div class="modal-list">
          ${options.map(([key, label]) => `<button class="modal-list-item" data-action="set-sort" data-sort="${key}">
            <span class="grow">${label}</span>${state.albumSort === key ? `<span class="check">${icon('check')}</span>` : ''}
          </button>`).join('')}
        </div>`);
      break;
    }
    case 'set-sort':
      state.albumSort = el.dataset.sort;
      saveUiState();
      closeModal();
      renderTopActions();
      await renderCurrentView();
      break;
    case 'toggle-album-mode':
      state.albumMode = state.albumMode === 'grid' ? 'list' : 'grid';
      saveUiState();
      renderTopActions();
      await renderCurrentView();
      break;

    /* ---- library ---- */
    case 'add-folder': {
      const before = state.settings.libraryFolders.length;
      const folders = await api.library.addFolder();
      state.settings.libraryFolders = folders || [];
      if (state.route.name === 'settings') await renderCurrentView();
      if (!state.settings.libraryFolders.length) return;
      if (state.settings.libraryFolders.length === before) return;
      await doScan();
      break;
    }
    case 'remove-folder': {
      const folders = await api.library.removeFolder(el.dataset.folder);
      state.settings.libraryFolders = folders || [];
      toast('Folder removed — rescan to update your library');
      if (state.route.name === 'settings') await renderCurrentView();
      break;
    }
    case 'scan-library':
      await doScan();
      break;
    case 'reload-server':
      await loadServerLibrary();
      renderSidebar();
      await renderCurrentView();
      break;
    case 'connect-server':
      await navigate('settings', {}, true);
      break;
    case 'switch-source': {
      const target = el.dataset.source;
      if (target === 'server' && !serverConfigured()) {
        toast('Add your server details first');
        await navigate('settings', {}, true);
        return;
      }
      if (target === state.source) return;
      state.source = target;
      state.songFilter = '';
      saveUiState();
      if (target === 'server' && !state.serverAlbums.length) {
        const ok = await loadServerLibrary();
        if (!ok && !state.serverAlbums.length) {
          renderSidebar();
          await navigate('home', {}, true);
          return;
        }
      }
      renderSidebar();
      await navigate('home', {}, true);
      break;
    }

    /* ---- server settings ---- */
    case 'test-server':
      await saveServerFields();
      await testServer();
      if (state.route.name === 'settings') await renderCurrentView();
      break;
    case 'save-server': {
      await saveServerFields();
      const ok = await testServer();
      if (ok) {
        state.serverConnected = true;
        await loadServerLibrary({ quiet: true });
        state.source = 'server';
        saveUiState();
        renderSidebar();
        toast(`Your server is ready · ${serverHost()}`, 'success');
        await navigate('home', {}, true);
      }
      break;
    }

    /* ---- lyrics offset ---- */
    case 'lyrics-offset-up':
      setLyricsOffset(state.lyricsOffset + 0.25);
      break;
    case 'lyrics-offset-down':
      setLyricsOffset(state.lyricsOffset - 0.25);
      break;
    case 'lyrics-offset-reset':
      setLyricsOffset(0);
      break;

    /* ---- window / modal ---- */
    case 'close-np':
      closeNowPlaying();
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'open-data-folder':
      api.app.openDataFolder?.();
      break;
    case 'reload-page':
      await renderCurrentView();
      break;
    case 'clear-search':
      clearSearch(true);
      break;

    default:
      break;
  }
}

async function saveServerFields() {
  const url = $('#srv-url')?.value.trim() || '';
  const username = $('#srv-user')?.value.trim() || '';
  const password = $('#srv-pass')?.value || '';
  state.settings = await api.settings.update({ subsonic: { url, username, password } });
}

async function doScan() {
  if (state.scanning) return;
  if (!(state.settings.libraryFolders || []).length) {
    const folders = await api.library.addFolder();
    state.settings.libraryFolders = folders || [];
    if (!state.settings.libraryFolders.length) return;
  }
  state.scanning = true;
  renderTopActions();
  scanToast = toast('Scanning your library…', 'default', 0);
  try {
    const res = await api.library.scan();
    state.tracks = res.tracks || [];
    state.libraryScannedAt = res.scannedAt;
    buildCollections();
    buildMix();
    state.source = 'local';
    saveUiState();
    renderSidebar();
    toast(`Library ready · ${state.tracks.length} tracks`, 'success');
    if (['home', 'songs', 'albums', 'artists', 'playlists', 'favorites', 'settings'].includes(state.route.name)) {
      await renderCurrentView();
    }
  } catch (err) {
    toast(`Scan failed: ${err.message}`, 'error');
  } finally {
    state.scanning = false;
    if (scanToast) { scanToast.remove(); scanToast = null; }
    renderTopActions();
  }
}

/* ================================================================== */
/* Search                                                              */
/* ================================================================== */

function localSearch(query) {
  const q = query.toLowerCase();
  const songs = state.tracks
    .filter((t) => `${t.title} ${t.artist} ${t.album} ${t.albumArtist}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const at = a.title.toLowerCase().startsWith(q) ? 0 : 1;
      const bt = b.title.toLowerCase().startsWith(q) ? 0 : 1;
      return at - bt || a.title.localeCompare(b.title);
    })
    .slice(0, 50);
  const albums = state.localAlbums
    .filter((a) => `${a.name} ${a.artist}`.toLowerCase().includes(q))
    .slice(0, 16);
  const artists = state.localArtists
    .filter((a) => a.name.toLowerCase().includes(q))
    .slice(0, 12);
  let top = null;
  if (albums.length) top = { type: 'album', item: albums[0] };
  else if (songs.length) top = { type: 'song', item: songs[0] };
  else if (artists.length) top = { type: 'artist', item: artists[0] };
  return { songs, albums, artists, top };
}

const runSearch = debounce(async (query, seq) => {
  if (!query.trim()) return;
  if (state.source === 'local') {
    state.searchResults = localSearch(query);
    if (state.route.name === 'search') renderSearchResults();
    return;
  }
  const res = await api.subsonic.call('search3', { query });
  if (seq !== state.searchSeq) return;
  if (!res.ok) {
    state.searchResults = { songs: [], albums: [], artists: [], top: null };
  } else {
    const data = res.data;
    for (const t of data.songs || []) state.serverTrackById.set(t.id, t);
    let top = null;
    if (data.albums?.length) top = { type: 'album', item: data.albums[0] };
    else if (data.songs?.length) top = { type: 'song', item: data.songs[0] };
    else if (data.artists?.length) top = { type: 'artist', item: data.artists[0] };
    state.searchResults = { ...data, top };
  }
  if (state.route.name === 'search') renderSearchResults();
}, 260);

function scheduleSearch(query) {
  const seq = ++state.searchSeq;
  if (state.source === 'local') {
    state.searchResults = query.trim() ? localSearch(query) : null;
    if (state.route.name === 'search') renderSearchResults();
    return;
  }
  runSearch(query, seq);
}

function renderSearchResults() {
  if (state.route.name !== 'search') return;
  state.contexts = new Map();
  setView(views.search(state, state.searchResults, state.searchQuery), { animate: false });
  updateCurrentRows();
}

function clearSearch(navigateHome = false) {
  state.searchQuery = '';
  state.searchResults = null;
  state.searchSeq += 1;
  const input = $('#search');
  if (input) input.value = '';
  toggleSearchClear();
  if (navigateHome && state.route.name === 'search') navigate('home', {}, true);
}

function toggleSearchClear() {
  const btn = $('#search-clear') || $('.search-clear');
  if (btn) btn.hidden = !$('#search')?.value;
}

/* ================================================================== */
/* Static event binding                                                */
/* ================================================================== */

function bindStaticUi() {
  /* window controls */
  $$('[data-win]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.win;
      if (action === 'minimize') api.win.minimize();
      else if (action === 'maximize') api.win.maximize();
      else if (action === 'close') api.win.close();
    });
  });
  api.win.onMaximized?.((maxed) => {
    const btn = $('#win-max');
    if (!btn) return;
    btn.innerHTML = maxed
      ? '<svg viewBox="0 0 12 12"><rect x="3" y="1.6" width="6.8" height="6.8" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M2.2 4.5v5.2a1.1 1.1 0 0 0 1.1 1.1h5.2" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>'
      : '<svg viewBox="0 0 12 12"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  });
  $('#titlebar')?.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('.winbtn')) return;
    api.win.maximize();
  });

  /* main click delegation */
  document.addEventListener('click', async (ev) => {
    try {
      if (ev.target.closest('[data-modal-scrim]') && !ev.target.closest('.modal')) {
        closeModal();
        return;
      }
      const routeEl = ev.target.closest('[data-route]');
      const navEl = ev.target.closest('[data-nav]');
      const winEl = ev.target.closest('[data-win]');
      const actionEl = ev.target.closest('[data-action]');
      const playerEl = ev.target.closest('[data-player]');

      if (winEl) return;
      if (actionEl) {
        await handleAction(actionEl.dataset.action, actionEl, ev);
        return;
      }
      if (playerEl) {
        handlePlayerCommand(playerEl.dataset.player);
        return;
      }
      if (navEl) {
        goHistory(navEl.dataset.nav === 'back' ? -1 : 1);
        return;
      }
      if (routeEl) {
        clearSearch(false);
        $('#search').value = '';
        toggleSearchClear();
        await navigate(routeEl.dataset.route, {}, true);
        return;
      }

      const row = ev.target.closest('.track-row');
      if (row) {
        if (ev.target.closest('button')) return;
        if (state.route.name === 'songs' && state.selectionMode) {
          toggleSongSelection(row.dataset.trackId);
          return;
        }
        playFromContext(row.dataset.ctx, Number(row.dataset.idx));
        return;
      }
      const qpRow = ev.target.closest('.qp-row');
      if (qpRow && !ev.target.closest('button')) {
        player.playAtOrder(Number(qpRow.dataset.pos));
        return;
      }
    } catch (err) {
      console.error(err);
      toast(err.message || 'Something went wrong', 'error');
    }
  });

  /* right click track rows */
  document.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.track-row');
    if (!row) return;
    const tracks = state.contexts.get(row.dataset.ctx);
    const track = tracks?.[Number(row.dataset.idx)];
    if (!track) return;
    ev.preventDefault();
    openTrackMenu(track);
  });

  /* settings inputs */
  document.addEventListener('change', async (ev) => {
    const field = ev.target.closest('[data-setting]');
    if (field) {
      const path = field.dataset.setting.split('.');
      const patch = path.reduceRight((acc, key) => ({ [key]: acc }), field.value);
      await updateSettings(patch);
      if (path[0] === 'subsonic') {
        state.serverConnected = false;
        state.serverStatus = null;
        updateServerStatusUI();
        renderSourceSwitch();
      }
      return;
    }
    const range = ev.target.closest('[data-setting-range]');
    if (range) {
      await updateSettings({ [range.dataset.settingRange]: Number(range.value) });
    }
  });

  document.addEventListener('input', (ev) => {
    const range = ev.target.closest('[data-setting-range]');
    if (range) document.documentElement.style.setProperty('--bg-intensity', range.value);
    if (ev.target.id === 'songs-filter') {
      state.songFilter = ev.target.value;
      applySongFilter();
    }
    if (ev.target.id === 'add-song-search') {
      state.addSongQuery = ev.target.value;
      applyAddSongFilter();
    }
  });

  /* search */
  const input = $('#search');
  input?.addEventListener('input', async () => {
    const q = input.value.trim();
    state.searchQuery = q;
    toggleSearchClear();
    if (!q) {
      state.searchResults = null;
      if (state.route.name === 'search') await navigate('home', {}, true);
      return;
    }
    if (state.route.name !== 'search') {
      await navigate('search', { q }, true);
    }
    scheduleSearch(q);
  });
  input?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      clearSearch(true);
      input.blur();
    }
  });

  /* keyboard shortcuts */
  document.addEventListener('keydown', onKeydown);

  /* queue & playlist drag & drop */
  document.addEventListener('dragstart', (ev) => {
    const plRow = ev.target.closest('.track-row[data-reorder="playlist"]');
    if (plRow) {
      const ctxKey = plRow.dataset.ctx || '';
      const playlistId = ctxKey.startsWith('playlist:') ? ctxKey.slice('playlist:'.length) : null;
      state.dragPlaylistRow = { playlistId, from: Number(plRow.dataset.idx) };
      ev.dataTransfer?.setData('text/plain', 'playlist-row');
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      plRow.classList.add('dragging');
      return;
    }
    const row = ev.target.closest('.qp-row');
    if (!row) return;
    state.dragPos = Number(row.dataset.pos);
    row.classList.add('dragging');
    try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(state.dragPos)); } catch { /* ignore */ }
  });
  document.addEventListener('dragend', () => {
    state.dragPos = null;
    state.dragPlaylistRow = null;
    $$('.qp-row').forEach((r) => r.classList.remove('dragging', 'drag-over'));
    $$('.track-row').forEach((r) => r.classList.remove('dragging', 'drag-over'));
  });
  document.addEventListener('dragover', (ev) => {
    if (state.dragPlaylistRow) {
      const row = ev.target.closest('.track-row[data-reorder="playlist"]');
      if (!row || row.dataset.ctx !== `playlist:${state.dragPlaylistRow.playlistId}`) return;
      ev.preventDefault();
      $$('.track-row').forEach((r) => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
      return;
    }
    const row = ev.target.closest('.qp-row');
    if (!row || state.dragPos == null) return;
    ev.preventDefault();
    $$('.qp-row').forEach((r) => r.classList.remove('drag-over'));
    row.classList.add('drag-over');
  });
  document.addEventListener('drop', async (ev) => {
    if (state.dragPlaylistRow) {
      const row = ev.target.closest('.track-row[data-reorder="playlist"]');
      if (!row) return;
      ev.preventDefault();
      const { playlistId, from } = state.dragPlaylistRow;
      const to = Number(row.dataset.idx);
      state.dragPlaylistRow = null;
      if (playlistId && Number.isFinite(from) && Number.isFinite(to)) {
        await reorderPlaylistTrack(playlistId, from, to);
      }
      return;
    }
    const row = ev.target.closest('.qp-row');
    if (!row || state.dragPos == null) return;
    ev.preventDefault();
    const from = state.dragPos;
    const to = Number(row.dataset.pos);
    state.dragPos = null;
    if (Number.isFinite(from) && Number.isFinite(to)) player.moveOrder(from, to);
    renderQueue();
  });

  /* library scan progress */
  api.library.onProgress?.((progress) => {
    state.scanProgress = progress;
    if (scanToast) {
      scanToast.textContent = `Scanning ${progress.done} / ${progress.total} · ${progress.current || ''}`;
    }
  });
}

function handlePlayerCommand(command) {
  switch (command) {
    case 'toggle': player.toggle(); break;
    case 'next': player.next(false); break;
    case 'prev': player.previous(); break;
    case 'shuffle':
      player.toggleShuffle();
      toast(player.shuffle ? 'Shuffle on' : 'Shuffle off');
      updateTransport();
      break;
    case 'repeat':
      player.cycleRepeat();
      toast(player.repeat === 'off' ? 'Repeat off' : player.repeat === 'all' ? 'Repeat all' : 'Repeat one');
      updateTransport();
      break;
    case 'mute':
      player.toggleMute();
      break;
    case 'expand':
      openNowPlaying();
      break;
    case 'open-lyrics':
      openNowPlaying();
      break;
    default:
      break;
  }
}

function bindPlayerBar() {
  bindProgress($('#pb-progress'));
  bindProgress($('#np-progress'));
  bindVolume($('#volume-track'));
}

function bindProgress(el) {
  if (!el) return;
  let dragging = false;
  const ratioFor = (ev) => {
    const rect = el.getBoundingClientRect();
    return clamp((ev.clientX - rect.left) / rect.width, 0, 1);
  };
  const seekTo = (ratio) => {
    const duration = player.duration || 0;
    if (duration) player.seek(ratio * duration);
    paintProgress(el, ratio);
  };
  el.addEventListener('pointerdown', (ev) => {
    if (!player.current) return;
    dragging = true;
    el.setPointerCapture?.(ev.pointerId);
    el.classList.add('dragging');
    seekTo(ratioFor(ev));
    ev.preventDefault();
  });
  el.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    seekTo(ratioFor(ev));
  });
  const stop = (ev) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    try { el.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); ev.stopPropagation(); player.seekBy(-5); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); ev.stopPropagation(); player.seekBy(5); }
  });
}

function bindVolume(el) {
  if (!el) return;
  let dragging = false;
  const ratioFor = (ev) => {
    const rect = el.getBoundingClientRect();
    return clamp((ev.clientX - rect.left) / rect.width, 0, 1);
  };
  el.addEventListener('pointerdown', (ev) => {
    dragging = true;
    el.setPointerCapture?.(ev.pointerId);
    player.setVolume(ratioFor(ev));
    ev.preventDefault();
  });
  el.addEventListener('pointermove', (ev) => {
    if (dragging) player.setVolume(ratioFor(ev));
  });
  el.addEventListener('pointerup', () => { dragging = false; });
  el.addEventListener('pointercancel', () => { dragging = false; });
}

function onKeydown(ev) {
  const tag = ev.target?.tagName?.toLowerCase();
  const isField = tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable;

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    $('#search')?.focus();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
    ev.preventDefault();
    $('#search')?.focus();
    return;
  }
  if (ev.key === 'Escape') {
    if ($('#modal-root').children.length) { closeModal(); return; }
    if (state.npOpen) { closeNowPlaying(); return; }
    if (state.queueOpen) { toggleQueue(false); return; }
    if (document.activeElement === $('#search')) $('#search').blur();
    return;
  }
  if (isField) return;

  switch (ev.key) {
    case ' ':
      ev.preventDefault();
      player.toggle();
      break;
    case 'ArrowRight':
      ev.preventDefault();
      if (ev.shiftKey) player.next(false);
      else player.seekBy(5);
      break;
    case 'ArrowLeft':
      ev.preventDefault();
      if (ev.shiftKey) player.previous();
      else player.seekBy(-5);
      break;
    case 'ArrowUp':
      ev.preventDefault();
      player.setVolume(clamp(player.volume + 0.05, 0, 1));
      break;
    case 'ArrowDown':
      ev.preventDefault();
      player.setVolume(clamp(player.volume - 0.05, 0, 1));
      break;
    default:
      if (/^[0-9]$/.test(ev.key) && player.duration) {
        player.seek((Number(ev.key) / 10) * player.duration);
        return;
      }
      switch (ev.key.toLowerCase()) {
        case 'n': player.next(false); break;
        case 'p': player.previous(); break;
        case 's':
          player.toggleShuffle();
          toast(player.shuffle ? 'Shuffle on' : 'Shuffle off');
          break;
        case 'r':
          player.cycleRepeat();
          toast(player.repeat === 'off' ? 'Repeat off' : player.repeat === 'all' ? 'Repeat all' : 'Repeat one');
          break;
        case 'f': toggleFavorite(player.current); break;
        case 'l': openNowPlaying(); break;
        case 'q': toggleQueue(); break;
        case 'm': player.toggleMute(); break;
        default: break;
      }
  }
}

/* ================================================================== */
/* Toasts                                                              */
/* ================================================================== */

function toast(message, type = 'default', timeout = 3400) {
  const root = $('#toasts');
  if (!root) return null;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'info' : type === 'success' ? 'check' : 'sparkles')}<span class="grow">${esc(message)}</span>`;
  root.appendChild(el);
  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add('hide');
    setTimeout(() => el.remove(), 320);
  };
  if (timeout > 0) setTimeout(remove, timeout);
  el._remove = remove;
  return el;
}
