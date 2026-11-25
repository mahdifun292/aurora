/* LRC parsing + synced / karaoke lyrics rendering. */
import { esc, clamp } from './util.js';

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const META_TAG = /^\[(ti|ar|al|by|offset|re|ve|length|au|tool|encoding):(.*)\]$/i;

function toSeconds(min, sec, frac) {
  const m = Number(min) || 0;
  const s = Number(sec) || 0;
  let f = 0;
  if (frac != null) {
    const str = String(frac);
    f = Number(str) / (str.length === 1 ? 10 : str.length === 2 ? 100 : 1000);
  }
  return m * 60 + s + f;
}

function parseWords(text, lineTime) {
  const words = [];
  let lastIndex = 0;
  let lastTime = lineTime;
  WORD_TAG.lastIndex = 0;
  let match;
  while ((match = WORD_TAG.exec(text)) !== null) {
    const chunk = text.slice(lastIndex, match.index);
    if (chunk) words.push({ time: lastTime, text: chunk });
    lastTime = toSeconds(match[1], match[2], match[3]);
    lastIndex = match.index + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail) words.push({ time: lastTime, text: tail });
  return words;
}

export function parseLyrics(raw) {
  const result = {
    synced: false,
    lines: [],
    meta: {},
    offset: 0,
  };
  if (!raw || !String(raw).trim()) return result;

  const src = String(raw).replace(/\r\n?/g, '\n');
  const timed = [];
  const plain = [];
  let offsetMs = 0;

  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = META_TAG.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      const value = meta[2].trim();
      result.meta[key] = value;
      if (key === 'offset') {
        const n = Number(value);
        if (Number.isFinite(n)) offsetMs = n;
      }
      continue;
    }

    const stamps = [];
    TIME_TAG.lastIndex = 0;
    let m;
    while ((m = TIME_TAG.exec(line)) !== null) {
      stamps.push(toSeconds(m[1], m[2], m[3]));
    }

    if (!stamps.length) {
      plain.push({ time: null, text: line, words: [] });
      continue;
    }

    let content = line.replace(TIME_TAG, '').trim();
    if (!content) continue;
    const words = parseWords(content, stamps[0]);
    content = content.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim();
    if (!content) continue;

    for (const time of stamps) {
      timed.push({
        time,
        text: content,
        words: words.length > 1 ? parseWords(line.replace(TIME_TAG, '').trim(), time) : [],
      });
    }
  }

  if (timed.length) {
    timed.sort((a, b) => a.time - b.time);
    const filtered = timed.filter((line, i) => {
      const prev = timed[i - 1];
      return !prev || prev.time !== line.time || prev.text !== line.text;
    });
    result.synced = true;
    result.lines = filtered.map((l) => ({
      time: l.time - offsetMs / 1000,
      text: l.text,
      words: l.words
        .map((w) => ({ ...w, time: w.time - offsetMs / 1000 }))
        .filter((w) => Number.isFinite(w.time)),
    }));
  } else {
    result.lines = plain.map((l) => ({ ...l, time: null }));
  }

  return result;
}

export class LyricsView {
  constructor(root, { onSeek } = {}) {
    this.root = root;
    this.viewport = root.querySelector('.lyrics-viewport');
    this.inner = root.querySelector('.lyrics-lines');
    this.badge = root.closest('.np-right')?.querySelector('.lyrics-badge')
      || document.querySelector('.lyrics-badge');
    this.onSeek = onSeek || (() => {});
    this.parsed = null;
    this.offset = 0;
    this.activeIndex = -2;
    this.lastText = '';
    this.trackId = null;

    this.inner?.addEventListener('click', (ev) => {
      const line = ev.target.closest('.lyrics-line');
      if (!line) return;
      const index = Number(line.dataset.index);
      const item = this.parsed?.lines?.[index];
      if (item && item.time != null) {
        this.onSeek(Math.max(0, item.time + this.offset));
      }
    });

    this._onResize = () => this._center(true);
    window.addEventListener('resize', this._onResize);
  }

  setEmpty(message = 'No lyrics for this track', sub = 'Lyrics from .lrc files, embedded tags or your server will appear here.') {
    this.parsed = null;
    this.activeIndex = -2;
    this.trackId = null;
    this.root.classList.remove('synced', 'plain', 'is-empty');
    if (!this.inner) return;
    this.inner.innerHTML = `
      <div class="lyrics-empty">
        <div class="lyrics-empty-art">
          <span></span><span></span><span></span><span></span><span></span>
        </div>
        <p>${esc(message)}</p>
        <small>${esc(sub)}</small>
      </div>`;
    if (this.badge) this.badge.textContent = '';
  }

  setLoading() {
    if (!this.inner) return;
    this.root.classList.remove('is-empty');
    this.inner.innerHTML = `
      <div class="lyrics-loading">
        <span></span><span></span><span></span>
      </div>`;
    if (this.badge) this.badge.textContent = '';
  }

  setText(text, trackId = null) {
    this.parsed = parseLyrics(text);
    this.trackId = trackId;
    this.activeIndex = -2;
    this.inner.style.transform = 'translateY(0px)';
    this.root.classList.toggle('is-empty', !this.parsed.lines.length);

    if (!this.parsed.lines.length) {
      this.setEmpty();
      return;
    }

    const lines = this.parsed.lines;
    this.inner.innerHTML = lines
      .map((line, i) => {
        const words = line.words?.length
          ? line.words
              .map((w) => `<span class="lyric-word" data-time="${w.time}">${esc(w.text)}</span>`)
              .join('')
          : esc(line.text);
        return `<div class="lyrics-line" data-index="${i}" data-time="${line.time ?? ''}">${words}</div>`;
      })
      .join('');

    this.root.classList.toggle('synced', this.parsed.synced);
    this.root.classList.toggle('plain', !this.parsed.synced);
    if (this.badge) {
      this.badge.textContent = this.parsed.synced ? 'Synced' : 'Plain';
      this.badge.classList.toggle('is-synced', this.parsed.synced);
    }
    this._center(true);
  }

  setOffset(seconds) {
    this.offset = Number(seconds) || 0;
    this.activeIndex = -2;
    this.setTime(this._lastTime || 0);
  }

  setTime(time) {
    this._lastTime = time;
    if (!this.parsed?.synced || !this.inner) return;
    const lines = this.parsed.lines;
    const t = time - this.offset;
    let lo = 0;
    let hi = lines.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t + 0.02) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (idx !== this.activeIndex) {
      const nodes = this.inner.children;
      if (this.activeIndex >= 0 && nodes[this.activeIndex]) {
        nodes[this.activeIndex].classList.remove('active');
        nodes[this.activeIndex].classList.add('past');
      }
      if (this.activeIndex < idx) {
        for (let i = Math.max(0, this.activeIndex); i < idx; i += 1) {
          nodes[i]?.classList.add('past');
        }
      } else {
        for (let i = idx + 1; i <= this.activeIndex; i += 1) {
          nodes[i]?.classList.remove('past');
        }
      }
      if (idx >= 0 && nodes[idx]) {
        nodes[idx].classList.remove('past');
        nodes[idx].classList.add('active');
      }
      this.activeIndex = idx;
      this._center(false);
    }

    // karaoke word-level highlighting
    const line = lines[idx];
    if (line?.words?.length) {
      const words = this.inner.children[idx]?.children;
      if (words) {
        for (let i = 0; i < words.length; i += 1) {
          const wt = Number(words[i].dataset.time);
          words[i].classList.toggle('sung', Number.isFinite(wt) && t >= wt);
        }
      }
    }
  }

  _center(force) {
    if (!this.inner || !this.viewport) return;
    if (!this.parsed?.synced) {
      this.inner.style.transform = '';
      return;
    }
    if (this.activeIndex < 0) return;
    const line = this.inner.children[this.activeIndex];
    if (!line) return;
    const viewportH = this.viewport.clientHeight;
    const target = viewportH / 2 - (line.offsetTop + line.offsetHeight / 2);
    const prev = this._lastTransform;
    if (force || Math.abs((prev || 0) - target) > 1) {
      this.inner.style.transform = `translateY(${clamp(target, -100000, 100000)}px)`;
      this._lastTransform = target;
    }
  }

  scrollToActive() {
    this._center(true);
  }
}
