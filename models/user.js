'use strict';

const bcrypt = require('bcryptjs');
const { db, now } = require('../db');

const ROUNDS = 10;

function count() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function findByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim()) || null;
}

function create({ username, password, displayName = null, role = 'admin' }) {
  const hash = bcrypt.hashSync(password, ROUNDS);
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(String(username).trim(), hash, displayName || username, role, now(), now());
  return findById(info.lastInsertRowid);
}

function verify(username, password) {
  const user = findByUsername(username);
  if (!user) {
    // Hash dummy supaya waktu respons untuk user tidak dikenal sama dengan
    // user yang ada — mencegah enumerasi username lewat timing.
    bcrypt.compareSync(String(password || ''), '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidix');
    return null;
  }
  return bcrypt.compareSync(String(password || ''), user.password_hash) ? user : null;
}

function setPassword(id, password) {
  const hash = bcrypt.hashSync(password, ROUNDS);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now(), id);
}

function touchLogin(id) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), id);
}

function updateProfile(id, { displayName, username }) {
  db.prepare('UPDATE users SET display_name = ?, username = ?, updated_at = ? WHERE id = ?')
    .run(displayName, String(username).trim(), now(), id);
  return findById(id);
}

module.exports = { count, findById, findByUsername, create, verify, setPassword, touchLogin, updateProfile };
