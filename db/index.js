'use strict';

const Database = require('better-sqlite3');
const config = require('../config');
const { createLogger } = require('../utils/logger');

const log = createLogger('db');

const db = new Database(config.paths.db);

// WAL memberi pembacaan bersamaan tanpa memblokir penulisan — penting karena
// scheduler, rotation engine, dan request HTTP semuanya menyentuh DB bersamaan.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

log.info('Database siap', { file: config.paths.db });

/** Jalankan fungsi di dalam satu transaksi. */
function tx(fn) {
  return db.transaction(fn)();
}

/** Format waktu standar seluruh aplikasi: ISO-8601 UTC. */
function now() {
  return new Date().toISOString();
}

module.exports = { db, tx, now };
