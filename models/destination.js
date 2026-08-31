'use strict';

const { db, now } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');

/** Preset RTMP tiap platform, dipakai untuk mengisi form otomatis. */
const PLATFORMS = {
  youtube: {
    label: 'YouTube Live',
    rtmp: 'rtmp://a.rtmp.youtube.com/live2',
    color: '#ff0033',
    supportsRotation: true,
    note: 'Rotasi judul, deskripsi, tags, dan thumbnail didukung penuh lewat YouTube Data API.',
  },
  facebook: {
    label: 'Facebook Live',
    rtmp: 'rtmps://live-api-s.facebook.com:443/rtmp',
    color: '#0866ff',
    supportsRotation: 'partial',
    note: 'Facebook hanya mengizinkan perubahan judul dan deskripsi saat siaran berlangsung.',
  },
  tiktok: {
    label: 'TikTok Live',
    rtmp: 'rtmp://push-rtmp-l1-va01.tiktokcdn.com/live',
    color: '#00f2ea',
    supportsRotation: false,
    note: 'TikTok tidak menyediakan API publik untuk mengubah metadata siaran berjalan.',
  },
  twitch: {
    label: 'Twitch',
    rtmp: 'rtmp://live.twitch.tv/app',
    color: '#9146ff',
    supportsRotation: false,
    note: 'Judul Twitch bisa diubah lewat Helix API, belum diaktifkan di versi ini.',
  },
  shopee: {
    label: 'Shopee Live',
    rtmp: '',
    color: '#ee4d2d',
    supportsRotation: false,
    note: 'Ambil URL RTMP dari Shopee Live Streaming Studio.',
  },
  custom: {
    label: 'RTMP Kustom',
    rtmp: '',
    color: '#64748b',
    supportsRotation: false,
    note: 'Server RTMP/RTMPS apa pun.',
  },
};

function hydrate(row) {
  if (!row) return null;
  return { ...row, stream_key: decrypt(row.stream_key) ?? '' };
}

function listByUser(userId, { onlyActive = false } = {}) {
  const sql = onlyActive
    ? 'SELECT * FROM destinations WHERE user_id = ? AND active = 1 ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM destinations WHERE user_id = ? ORDER BY name COLLATE NOCASE';
  return db.prepare(sql).all(userId).map(hydrate);
}

function findById(id, userId = null) {
  const row = db.prepare('SELECT * FROM destinations WHERE id = ?').get(id);
  if (!row) return null;
  if (userId !== null && row.user_id !== userId) return null;
  return hydrate(row);
}

function listForStream(streamId) {
  return db
    .prepare(
      `SELECT d.* FROM destinations d
       JOIN stream_destinations sd ON sd.destination_id = d.id
       WHERE sd.stream_id = ? ORDER BY d.name COLLATE NOCASE`
    )
    .all(streamId)
    .map(hydrate);
}

function create({ user_id, name, platform, rtmp_url, stream_key, account_id = null, active = 1 }) {
  const info = db
    .prepare(
      `INSERT INTO destinations (user_id, name, platform, rtmp_url, stream_key, account_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(user_id, name, platform, rtmp_url.trim(), encrypt(stream_key.trim()), account_id, active ? 1 : 0, now(), now());
  return findById(info.lastInsertRowid);
}

function update(id, userId, { name, platform, rtmp_url, stream_key, account_id = null, active = 1 }) {
  const existing = findById(id, userId);
  if (!existing) return null;
  // Field key dibiarkan kosong di form berarti "jangan ubah".
  const key = stream_key && stream_key.trim() ? encrypt(stream_key.trim()) : encrypt(existing.stream_key);
  db.prepare(
    `UPDATE destinations SET name = ?, platform = ?, rtmp_url = ?, stream_key = ?,
      account_id = ?, active = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(name, platform, rtmp_url.trim(), key, account_id, active ? 1 : 0, now(), id, userId);
  return findById(id, userId);
}

function remove(id, userId) {
  return db.prepare('DELETE FROM destinations WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/** Gabungkan base URL dan stream key menjadi URL RTMP lengkap untuk FFmpeg. */
function buildUrl(destination) {
  const base = String(destination.rtmp_url || '').replace(/\/+$/, '');
  const key = String(destination.stream_key || '').trim();
  if (!key) return base;
  return `${base}/${key}`;
}

module.exports = { PLATFORMS, listByUser, findById, listForStream, create, update, remove, buildUrl };
