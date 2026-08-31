'use strict';

const { db, now } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');

// Nilai ini disimpan terenkripsi karena termasuk kredensial.
const SECRET_KEYS = new Set(['google_client_secret', 'facebook_app_secret']);

const DEFAULTS = {
  google_client_id: '',
  google_client_secret: '',
  default_rotation_interval: '60',
  quota_warn_threshold: '80',
  keep_rotation_logs_days: '30',
};

function get(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback !== null ? fallback : (DEFAULTS[key] ?? null);
  if (SECRET_KEYS.has(key)) return decrypt(row.value) ?? '';
  return row.value;
}

function set(key, value) {
  const stored = SECRET_KEYS.has(key) && value ? encrypt(value) : value;
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, stored, now());
}

function setMany(obj) {
  const run = db.transaction((entries) => {
    for (const [k, v] of entries) set(k, v);
  });
  run(Object.entries(obj));
}

function all() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULTS };
  for (const row of rows) {
    out[row.key] = SECRET_KEYS.has(row.key) ? (decrypt(row.value) ?? '') : row.value;
  }
  return out;
}

/** Kredensial OAuth Google; env var menang atas nilai di database. */
function googleCredentials() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || get('google_client_id') || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || get('google_client_secret') || '',
  };
}

function hasGoogleCredentials() {
  const { clientId, clientSecret } = googleCredentials();
  return Boolean(clientId && clientSecret);
}

module.exports = { get, set, setMany, all, googleCredentials, hasGoogleCredentials, SECRET_KEYS };
