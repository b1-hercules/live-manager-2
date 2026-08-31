'use strict';

const session = require('express-session');
const { db } = require('../db');

/**
 * Session store di atas better-sqlite3. Dipakai menggantikan connect-sqlite3
 * agar aplikasi hanya bergantung pada satu driver SQLite.
 */
class SqliteStore extends session.Store {
  constructor({ cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.stmt = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      clear: db.prepare('DELETE FROM sessions'),
      length: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?'),
      all: db.prepare('SELECT sid, data FROM sessions WHERE expires_at > ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    };

    this.prune();
    const timer = setInterval(() => this.prune(), cleanupIntervalMs);
    if (timer.unref) timer.unref();
  }

  prune() {
    try {
      this.stmt.prune.run(Date.now());
    } catch (_) { /* pembersihan bersifat best-effort */ }
  }

  expiryFor(sess) {
    const ttl = sess?.cookie?.maxAge;
    return Date.now() + (Number.isFinite(ttl) ? ttl : 7 * 24 * 60 * 60 * 1000);
  }

  get(sid, callback) {
    try {
      const row = this.stmt.get.get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        this.stmt.destroy.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (err) {
      return callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      this.stmt.set.run(sid, JSON.stringify(sess), this.expiryFor(sess));
      return callback ? callback(null) : undefined;
    } catch (err) {
      return callback ? callback(err) : undefined;
    }
  }

  destroy(sid, callback) {
    try {
      this.stmt.destroy.run(sid);
      return callback ? callback(null) : undefined;
    } catch (err) {
      return callback ? callback(err) : undefined;
    }
  }

  touch(sid, sess, callback) {
    try {
      this.stmt.touch.run(this.expiryFor(sess), sid);
      return callback ? callback(null) : undefined;
    } catch (err) {
      return callback ? callback(err) : undefined;
    }
  }

  clear(callback) {
    try {
      this.stmt.clear.run();
      return callback ? callback(null) : undefined;
    } catch (err) {
      return callback ? callback(err) : undefined;
    }
  }

  length(callback) {
    try {
      return callback(null, this.stmt.length.get(Date.now()).n);
    } catch (err) {
      return callback(err);
    }
  }

  all(callback) {
    try {
      const rows = this.stmt.all.all(Date.now());
      return callback(null, rows.map((r) => JSON.parse(r.data)));
    } catch (err) {
      return callback(err);
    }
  }
}

module.exports = SqliteStore;
