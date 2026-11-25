import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtLong(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

export function fmtCount(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(num >= 10_000 ? 0 : 1)}k`;
  return String(num);
}

export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function hashString(str) {
  let h = 2166136261;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

export function hueFor(seed) {
  return hashString(seed) % 360;
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function debounce(fn, wait = 240) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function shuffleArray(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function coverHTML(item, opts = {}) {
  const { rounded = '', lazy = true, size = 'large', className = '' } = opts;
  const url = item?.coverUrl || item?.imageUrl || '';
  const seed = item?.album || item?.name || item?.title || item?.artist || 'Aurora';
  if (url) {
    return `<div class="cover ${rounded} ${className}"><img src="${esc(url)}" alt="" ${lazy ? 'loading="lazy"' : ''} draggable="false" /></div>`;
  }
  const hue = hueFor(seed);
  const hue2 = (hue + 48) % 360;
  return `<div class="cover cover-fallback ${rounded} ${className}" style="--c1:hsl(${hue} 62% 46%);--c2:hsl(${hue2} 68% 30%)">
    <span class="cover-glyph">${icon(size === 'small' ? 'music' : 'disc')}</span>
  </div>`;
}

export function setAccentHue(hue) {
  const root = document.documentElement;
  const h = Number(hue) || 262;
  root.style.setProperty('--accent-h', String(h));
  root.style.setProperty('--accent', `hsl(${h} 78% 68%)`);
  root.style.setProperty('--accent-strong', `hsl(${h} 82% 60%)`);
  root.style.setProperty('--accent-dim', `hsl(${h} 62% 48%)`);
  root.style.setProperty('--accent-soft', `hsla(${h}, 80%, 65%, .16)`);
  root.style.setProperty('--accent-glow', `hsla(${h}, 80%, 62%, .38)`);
}

export function setAccent(seed) {
  setAccentHue(hueFor(seed));
}

export function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function isMac() {
  return window.api?.platform === 'darwin';
}
