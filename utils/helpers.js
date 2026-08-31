'use strict';

/** SQLite tidak punya boolean; normalisasi apa pun yang datang dari form/DB. */
function toBool(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === null || value === undefined) return false;
  const s = String(value).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === 'ya';
}

function toInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Ubah input tags (string dipisah koma / baris baru, atau array) jadi array bersih. */
function parseTags(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[\n,]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const tag = String(item).trim().replace(/^#/, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * YouTube membatasi total karakter tags (termasuk pemisah) sampai 500.
 * Potong dari belakang supaya tag prioritas di depan tetap terkirim.
 */
function limitTags(tags, maxChars = 480) {
  const out = [];
  let total = 0;
  for (const tag of tags) {
    const cost = tag.length + (out.length ? 1 : 0) + (tag.includes(' ') ? 2 : 0);
    if (total + cost > maxChars) break;
    out.push(tag);
    total += cost;
  }
  return out;
}

function safeJsonParse(str, fallback) {
  if (str === null || str === undefined || str === '') return fallback;
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Uptime yang enak dibaca manusia: "2h 14m", "3d 5h". */
function humanUptime(fromIso) {
  if (!fromIso) return '-';
  const ms = Date.now() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}h ${h}j`;
  if (h) return `${h}j ${m}m`;
  if (m) return `${m}m`;
  return `${s}d`;
}

/**
 * Ubah nilai <input type="datetime-local"> (waktu lokal browser, tanpa zona)
 * jadi ISO UTC. Mengembalikan null untuk input kosong/tidak valid.
 */
function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Kebalikan localInputToIso, untuk mengisi kembali form. */
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sembunyikan stream key di UI: hanya 4 karakter terakhir yang terlihat. */
function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 4) return '••••';
  return '••••••••' + s.slice(-4);
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

/** Pilih indeks acak berbobot. Mengembalikan -1 bila daftar kosong. */
function weightedPick(items) {
  if (!items.length) return -1;
  const total = items.reduce((sum, it) => sum + Math.max(1, Number(it.weight) || 1), 0);
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= Math.max(1, Number(items[i].weight) || 1);
    if (roll <= 0) return i;
  }
  return items.length - 1;
}

/** Fisher-Yates. */
function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  toBool,
  toInt,
  clamp,
  parseTags,
  limitTags,
  safeJsonParse,
  formatBytes,
  formatDuration,
  humanUptime,
  localInputToIso,
  isoToLocalInput,
  maskKey,
  slugify,
  weightedPick,
  shuffle,
};
