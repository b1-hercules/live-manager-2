'use strict';

const { db, now } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');

/**
 * Biaya kuota YouTube Data API v3 per operasi (unit).
 * Kuota default sebuah project adalah 10.000 unit/hari dan reset pukul
 * 00:00 Pacific Time. Angka ini dipakai untuk memperkirakan pemakaian dan
 * menghentikan rotasi sebelum API menolak.
 */
const QUOTA_COST = {
  'videos.list': 1,
  'videos.update': 50,
  'thumbnails.set': 50,
  'liveBroadcasts.list': 1,
  'channels.list': 1,
};

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    access_token: decrypt(row.access_token_enc),
    refresh_token: decrypt(row.refresh_token_enc),
  };
}

function listByUser(userId, provider = null) {
  const sql = provider
    ? 'SELECT * FROM accounts WHERE user_id = ? AND provider = ? ORDER BY created_at DESC'
    : 'SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at DESC';
  const rows = provider ? db.prepare(sql).all(userId, provider) : db.prepare(sql).all(userId);
  return rows.map(hydrate);
}

function findById(id, userId = null) {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!row) return null;
  if (userId !== null && row.user_id !== userId) return null;
  return hydrate(row);
}

function findByExternalId(userId, provider, externalId) {
  const row = db
    .prepare('SELECT * FROM accounts WHERE user_id = ? AND provider = ? AND external_id = ?')
    .get(userId, provider, externalId);
  return hydrate(row);
}

/** Simpan akun baru, atau perbarui token bila channel yang sama dihubungkan lagi. */
function upsert({ user_id, provider, external_id, name, avatar_url, access_token, refresh_token, expires_at, scopes }) {
  const existing = findByExternalId(user_id, provider, external_id);
  if (existing) {
    db.prepare(
      `UPDATE accounts SET name = ?, avatar_url = ?, access_token_enc = ?,
        refresh_token_enc = COALESCE(?, refresh_token_enc),
        token_expires_at = ?, scopes = ?, status = 'connected', last_error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(
      name, avatar_url, encrypt(access_token),
      refresh_token ? encrypt(refresh_token) : null,
      expires_at, scopes, now(), existing.id
    );
    return findById(existing.id);
  }

  const info = db
    .prepare(
      `INSERT INTO accounts
        (user_id, provider, external_id, name, avatar_url, access_token_enc, refresh_token_enc,
         token_expires_at, scopes, quota_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      user_id, provider, external_id, name, avatar_url,
      encrypt(access_token), encrypt(refresh_token),
      expires_at, scopes, quotaDateKey(), now(), now()
    );
  return findById(info.lastInsertRowid);
}

function updateTokens(id, { access_token, refresh_token, expires_at }) {
  db.prepare(
    `UPDATE accounts SET access_token_enc = ?,
      refresh_token_enc = COALESCE(?, refresh_token_enc),
      token_expires_at = ?, status = 'connected', last_error = NULL, updated_at = ?
     WHERE id = ?`
  ).run(encrypt(access_token), refresh_token ? encrypt(refresh_token) : null, expires_at, now(), id);
}

function markError(id, message) {
  db.prepare(`UPDATE accounts SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?`)
    .run(String(message || '').slice(0, 500), now(), id);
}

function remove(id, userId) {
  return db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/**
 * Kunci hari kuota mengikuti Pacific Time, bukan waktu lokal server, karena
 * di situlah Google mereset hitungan.
 */
function quotaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Ambil pemakaian kuota hari ini, reset otomatis kalau harinya sudah berganti. */
function getQuota(id) {
  const row = db.prepare('SELECT quota_used, quota_date, quota_limit FROM accounts WHERE id = ?').get(id);
  if (!row) return { used: 0, limit: 10000, remaining: 10000, date: quotaDateKey() };
  const today = quotaDateKey();
  if (row.quota_date !== today) {
    db.prepare('UPDATE accounts SET quota_used = 0, quota_date = ? WHERE id = ?').run(today, id);
    return { used: 0, limit: row.quota_limit, remaining: row.quota_limit, date: today };
  }
  return {
    used: row.quota_used,
    limit: row.quota_limit,
    remaining: Math.max(0, row.quota_limit - row.quota_used),
    date: today,
  };
}

function addQuota(id, cost) {
  const today = quotaDateKey();
  db.prepare(
    `UPDATE accounts SET
       quota_used = CASE WHEN quota_date = ? THEN quota_used + ? ELSE ? END,
       quota_date = ?
     WHERE id = ?`
  ).run(today, cost, cost, today, id);
}

function setQuotaLimit(id, userId, limit) {
  db.prepare('UPDATE accounts SET quota_limit = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(Math.max(1, limit), now(), id, userId);
}

/** Perkiraan biaya kuota satu putaran rotasi, untuk ditampilkan di UI. */
function estimateRotationCost({ title, description, tags, thumbnail }) {
  let cost = 0;
  if (title || description || tags) cost += QUOTA_COST['videos.list'] + QUOTA_COST['videos.update'];
  if (thumbnail) cost += QUOTA_COST['thumbnails.set'];
  return cost;
}

module.exports = {
  QUOTA_COST,
  listByUser, findById, findByExternalId, upsert, updateTokens, markError, remove,
  quotaDateKey, getQuota, addQuota, setQuotaLimit, estimateRotationCost,
};
