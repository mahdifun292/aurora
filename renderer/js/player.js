import { clamp, fmtTime, shuffleArray } from './util.js';

const STORAGE_KEY = 'aurora.player.v2';

/**
 * Playback engine: queue, shuffle/repeat, media session and persistence.
 * Emits: trackchange, queue, state, duration, time, volume, error
 */
export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.volume = 0.8;

    this.queue = [];
    this.order = [];
    this.pos = 0;
    this.shuffle = false;
    this.repeat = 'off';
    this.contextName = '';
    this.loading = false;
    this._startedFor = null;
    this._scrobbled = false;
    this._errorCount = 0;
    this._saveTimer = null;
    this._artCache = new Map();

    this._bindAudio();
    this._bindMediaSession();
  }

  /* ---------------------------------------------------------------- */
  /* Getters                                                          */
  /* ---------------------------------------------------------------- */

  get current() {
    return this.queue[this.order[this.pos]] || null;
  }

  get isPlaying() {
    return !this.audio.paused && !this.audio.ended && Boolean(this.current);
  }

  get currentTime() {
    return this.audio.currentTime || 0;
  }

  get duration() {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : (this.current?.duration || 0);
  }

  get volume() {
    return this.audio.muted ? 0 : this.audio.volume;
  }

  get orderedTracks() {
    return this.order.map((i) => this.queue[i]).filter(Boolean);
  }

  /* ---------------------------------------------------------------- */
  /* Queue                                                            */
  /* ---------------------------------------------------------------- */

  setQueue(tracks, startIndex = 0, opts = {}) {
    const clean = (tracks || []).filter(Boolean);
    if (!clean.length) return this.clear();
    this.queue = clean;
    startIndex = clamp(startIndex, 0, clean.length - 1);
    if (typeof opts.shuffle === 'boolean') this.shuffle = opts.shuffle;
    this.order = clean.map((_, i) => i);
    if (this.shuffle) {
      this.order = [startIndex, ...shuffleArray(this.order.filter((i) => i !== startIndex))];
      this.pos = 0;
    } else {
      this.pos = startIndex;
    }
    this.contextName = opts.contextName || '';
    this._errorCount = 0;
    this._emit('queue');
    this._load(this.current, opts.autoplay !== false);
  }

  playContext(tracks, startIndex = 0, contextName = '') {
    this.setQueue(tracks, startIndex, { contextName });
  }

  playSingle(track, contextName = '') {
    this.setQueue([track], 0, { contextName });
  }

  playAtOrder(orderPos) {
    if (orderPos < 0 || orderPos >= this.order.length) return;
    this.pos = orderPos;
    this._errorCount = 0;
    this._load(this.current, true);
    this._emit('queue');
  }

  playTrackById(id) {
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const orderPos = this.order.indexOf(idx);
    if (orderPos !== -1) this.playAtOrder(orderPos);
  }

  addToQueue(track, next = false) {
    if (!track) return;
    const wasEmpty = this.order.length === 0;
    this.queue.push(track);
    const idx = this.queue.length - 1;
    if (wasEmpty) {
      this.order = [idx];
      this.pos = 0;
      this._emit('queue');
      this._load(this.current, true);
      return;
    }
    if (next) this.order.splice(this.pos + 1, 0, idx);
    else this.order.push(idx);
    this._emit('queue');
    this._persist();
  }

  addManyToQueue(tracks, next = false) {
    (tracks || []).filter(Boolean).forEach((t) => {
      this.queue.push(t);
      const idx = this.queue.length - 1;
      if (next) this.order.splice(this.pos + 1, 0, idx);
      else this.order.push(idx);
    });
    this._emit('queue');
    this._persist();
  }

  removeAt(orderPos) {
    if (orderPos < 0 || orderPos >= this.order.length) return;
    const queueIdx = this.order[orderPos];
    const wasCurrent = orderPos === this.pos;
    this.order.splice(orderPos, 1);
    this.queue = this.queue.filter((_, i) => i !== queueIdx);
    this.order = this.order.map((i) => (i > queueIdx ? i - 1 : i));
    if (!this.queue.length) {
      this.clear();
      return;
    }
    if (wasCurrent) {
      this.pos = Math.min(this.pos, this.order.length - 1);
      this._load(this.current, true);
    } else if (orderPos < this.pos) {
      this.pos -= 1;
    }
    this._emit('queue');
    this._persist();
  }

  moveOrder(fromPos, toPos) {
    if (fromPos === toPos || fromPos < 0 || toPos < 0) return;
    if (fromPos >= this.order.length || toPos >= this.order.length) return;
    const currentQueueIdx = this.order[this.pos];
    const [moved] = this.order.splice(fromPos, 1);
    this.order.splice(toPos, 0, moved);
    this.pos = this.order.indexOf(currentQueueIdx);
    this._emit('queue');
    this._persist();
  }

  clear() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.queue = [];
    this.order = [];
    this.pos = 0;
    this.contextName = '';
    this._emit('trackchange', null);
    this._emit('queue');
    this._emit('state');
    this._persist();
  }

  /* ---------------------------------------------------------------- */
  /* Transport                                                        */
  /* ---------------------------------------------------------------- */

  async play() {
    if (!this.current) {
      if (this.queue.length) {
        this.pos = 0;
        this._load(this.current, true);
      }
      return;
    }
    try {
      await this.audio.play();
      this._emit('state');
    } catch {
      this._emit('state');
    }
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.play();
      return;
    }
    if (this.pos < this.order.length - 1) {
      this.pos += 1;
      this._load(this.current, true);
      this._emit('queue');
      return;
    }
    if (this.repeat === 'all') {
      this.pos = 0;
      this._load(this.current, true);
      this._emit('queue');
      return;
    }
    if (auto) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this._emit('state');
    }
  }

  previous() {
    if (!this.queue.length) return;
    if (this.currentTime > 3) {
      this.seek(0);
      return;
    }
    if (this.pos > 0) {
      this.pos -= 1;
    } else if (this.repeat === 'all') {
      this.pos = this.order.length - 1;
    } else {
      this.seek(0);
      return;
    }
    this._load(this.current, true);
    this._emit('queue');
  }

  seek(seconds) {
    const d = this.duration || 0;
    const t = clamp(Number(seconds) || 0, 0, d || Number.MAX_SAFE_INTEGER);
    try { this.audio.currentTime = t; } catch { /* ignore */ }
    this._emit('time');
  }

  seekBy(delta) {
    this.seek(this.currentTime + delta);
  }

  toggleShuffle() {
    const currentIdx = this.order[this.pos];
    this.shuffle = !this.shuffle;
    if (this.shuffle) {
      this.order = [currentIdx, ...shuffleArray(this.queue.map((_, i) => i).filter((i) => i !== currentIdx))];
      this.pos = 0;
    } else {
      this.order = this.queue.map((_, i) => i);
      this.pos = Math.max(0, currentIdx);
    }
    this._emit('queue');
    this._emit('state');
    this._persist();
    return this.shuffle;
  }

  cycleRepeat() {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
    this._emit('state');
    this._persist();
    return this.repeat;
  }

  setVolume(value) {
    const v = clamp(Number(value) || 0, 0, 1);
    this.audio.volume = v;
    this.audio.muted = v === 0;
    this._emit('volume', v);
    this._persist();
  }

  toggleMute() {
    this.audio.muted = !this.audio.muted;
    this._emit('volume', this.volume);
    this._persist();
  }

  /* ---------------------------------------------------------------- */
  /* Internal                                                         */
  /* ---------------------------------------------------------------- */

  _load(track, autoplay) {
    if (!track) return;
    this._scrobbled = false;
    this._startedFor = track.id;
    this.loading = true;
    try {
      this.audio.src = track.streamUrl;
      this.audio.load();
      if (track.duration) this.audio.currentTime = 0;
    } catch { /* ignore */ }
    this._emit('trackchange', track);
    this._emit('duration');
    this._updateMediaSession(track);
    this._persist();

    if (track.source === 'server') {
      window.api?.subsonic?.call('scrobble', { id: track.trackId, submission: false }).catch(() => {});
    }

    if (autoplay) {
      this.play();
    } else {
      this._emit('state');
    }
  }

  _bindAudio() {
    const a = this.audio;
    a.addEventListener('play', () => { this.loading = false; this._emit('state'); });
    a.addEventListener('pause', () => this._emit('state'));
    a.addEventListener('waiting', () => { this.loading = true; this._emit('state'); });
    a.addEventListener('playing', () => { this.loading = false; this._emit('state'); });
    a.addEventListener('canplay', () => { this.loading = false; this._emit('state'); });
    a.addEventListener('loadedmetadata', () => this._emit('duration'));
    a.addEventListener('durationchange', () => this._emit('duration'));
    a.addEventListener('timeupdate', () => {
      this._emit('time');
      this._maybeScrobble();
    });
    a.addEventListener('volumechange', () => this._emit('volume', this.volume));
    a.addEventListener('ended', () => {
      this._submitScrobble();
      this.next(true);
    });
    a.addEventListener('error', () => {
      this.loading = false;
      this._emit('state');
      this._emit('error', this.current);
      this._errorCount += 1;
      if (this._errorCount <= 2 && this.order.length > 1) {
        setTimeout(() => this.next(true), 900);
      }
    });
    a.addEventListener('stalled', () => { this.loading = true; this._emit('state'); });
  }

  _maybeScrobble() {
    if (this._scrobbled || !this.current) return;
    const d = this.duration;
    if (!d) return;
    if (this.currentTime >= Math.min(d / 2, 240) && this.currentTime > 4) {
      this._scrobbled = true;
      this._submitScrobble();
    }
  }

  _submitScrobble() {
    const track = this.current;
    if (!track || track.source !== 'server') return;
    window.api?.subsonic?.call('scrobble', { id: track.trackId, submission: true }).catch(() => {});
  }

  _updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    const apply = (artwork) => {
      if (this.current?.id !== track.id) return;
      try {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: track.title || 'Unknown Title',
          artist: track.artist || 'Unknown Artist',
          album: track.album || '',
          artwork: artwork || [],
        });
      } catch { /* ignore */ }
    };
    apply([]);
    this._artworkFor(track.coverUrl).then(apply).catch(() => {});
    try {
      if ('setPositionState' in navigator.mediaSession) {
        navigator.mediaSession.setPositionState({
          duration: Math.max(0, track.duration || 0),
          playbackRate: 1,
          position: 0,
        });
      }
    } catch { /* ignore */ }
  }

  async _artworkFor(url) {
    if (!url) return [];
    if (/^(https?|data|blob):/i.test(url)) {
      return [{ src: url, sizes: '512x512', type: 'image/jpeg' }];
    }
    if (this._artCache.has(url)) return this._artCache.get(url);
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const blob = await res.blob();
      const src = URL.createObjectURL(blob);
      const artwork = [{ src, sizes: '512x512', type: blob.type || 'image/png' }];
      this._artCache.set(url, artwork);
      return artwork;
    } catch {
      return [];
    }
  }

  _bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      nexttrack: () => this.next(false),
      previoustrack: () => this.previous(),
      seekbackward: (d) => this.seekBy(-(d.seekOffset || 10)),
      seekforward: (d) => this.seekBy(d.seekOffset || 10),
      seekto: (d) => this.seek(d.seekTime || 0),
      stop: () => this.pause(),
    };
    for (const [name, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* ignore */ }
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const data = {
          queue: this.queue,
          order: this.order,
          pos: this.pos,
          shuffle: this.shuffle,
          repeat: this.repeat,
          contextName: this.contextName,
          volume: this.audio.volume,
          muted: this.audio.muted,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch { /* storage full */ }
    }, 400);
  }

  restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.queue) || !data.queue.length) return false;
      this.queue = data.queue;
      this.order = Array.isArray(data.order) && data.order.length === data.queue.length
        ? data.order
        : data.queue.map((_, i) => i);
      this.pos = clamp(Number(data.pos) || 0, 0, this.order.length - 1);
      this.shuffle = Boolean(data.shuffle);
      this.repeat = ['off', 'all', 'one'].includes(data.repeat) ? data.repeat : 'off';
      this.contextName = data.contextName || '';
      if (Number.isFinite(data.volume)) this.audio.volume = clamp(data.volume, 0, 1);
      this.audio.muted = Boolean(data.muted);
      this._load(this.current, false);
      this._emit('queue');
      this._emit('state');
      return true;
    } catch {
      return false;
    }
  }

  /** Convenience for the UI. */
  static formatTime = fmtTime;
}
