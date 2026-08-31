'use strict';

const { db } = require('./index');
const { createLogger } = require('../utils/logger');

const log = createLogger('migrate');

/**
 * Migrasi berbasis PRAGMA user_version. Tambahkan langkah baru di akhir array —
 * jangan pernah mengubah langkah yang sudah dirilis ke pengguna.
 */
const MIGRATIONS = [
  // ------------------------------------------------------------ v1: inti
  function v1(d) {
    d.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT,
        role          TEXT NOT NULL DEFAULT 'admin',
        last_login_at TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE sessions (
        sid        TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE videos (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title          TEXT NOT NULL,
        filename       TEXT NOT NULL,
        filepath       TEXT NOT NULL,
        thumbnail_path TEXT,
        filesize       INTEGER DEFAULT 0,
        duration       REAL DEFAULT 0,
        width          INTEGER DEFAULT 0,
        height         INTEGER DEFAULT 0,
        fps            REAL DEFAULT 0,
        video_codec    TEXT,
        audio_codec    TEXT,
        bitrate        INTEGER DEFAULT 0,
        has_audio      INTEGER NOT NULL DEFAULT 1,
        source         TEXT NOT NULL DEFAULT 'upload',
        status         TEXT NOT NULL DEFAULT 'ready',
        error_message  TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_videos_user ON videos(user_id);

      CREATE TABLE accounts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider          TEXT NOT NULL,
        external_id       TEXT,
        name              TEXT,
        avatar_url        TEXT,
        access_token_enc  TEXT,
        refresh_token_enc TEXT,
        token_expires_at  TEXT,
        scopes            TEXT,
        quota_used        INTEGER NOT NULL DEFAULT 0,
        quota_date        TEXT,
        quota_limit       INTEGER NOT NULL DEFAULT 10000,
        status            TEXT NOT NULL DEFAULT 'connected',
        last_error        TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, external_id, user_id)
      );

      CREATE TABLE destinations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        platform   TEXT NOT NULL DEFAULT 'custom',
        rtmp_url   TEXT NOT NULL,
        stream_key TEXT NOT NULL,
        account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_destinations_user ON destinations(user_id);
    `);
  },

  // -------------------------------------------------- v2: rotasi metadata
  function v2(d) {
    d.exec(`
      CREATE TABLE rotation_profiles (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        description       TEXT,
        mode              TEXT NOT NULL DEFAULT 'bundle',
        interval_minutes  INTEGER NOT NULL DEFAULT 60,
        order_mode        TEXT NOT NULL DEFAULT 'sequential',
        apply_title       INTEGER NOT NULL DEFAULT 1,
        apply_description INTEGER NOT NULL DEFAULT 1,
        apply_tags        INTEGER NOT NULL DEFAULT 1,
        apply_thumbnail   INTEGER NOT NULL DEFAULT 1,
        jitter_seconds    INTEGER NOT NULL DEFAULT 0,
        stop_on_quota     INTEGER NOT NULL DEFAULT 1,
        active            INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_rotprofile_user ON rotation_profiles(user_id);

      -- Mode BUNDLE: satu baris = satu paket metadata lengkap.
      CREATE TABLE rotation_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id      INTEGER NOT NULL REFERENCES rotation_profiles(id) ON DELETE CASCADE,
        position        INTEGER NOT NULL DEFAULT 0,
        label           TEXT,
        title           TEXT,
        description     TEXT,
        tags            TEXT,
        thumbnail_path  TEXT,
        weight          INTEGER NOT NULL DEFAULT 1,
        active          INTEGER NOT NULL DEFAULT 1,
        times_applied   INTEGER NOT NULL DEFAULT 0,
        last_applied_at TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_rotitems_profile ON rotation_items(profile_id, position);

      -- Mode INDEPENDENT: satu baris per field, masing-masing interval sendiri.
      CREATE TABLE rotation_fields (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id       INTEGER NOT NULL REFERENCES rotation_profiles(id) ON DELETE CASCADE,
        field            TEXT NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 0,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        order_mode       TEXT NOT NULL DEFAULT 'sequential',
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(profile_id, field)
      );

      CREATE TABLE rotation_field_values (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        field_id        INTEGER NOT NULL REFERENCES rotation_fields(id) ON DELETE CASCADE,
        position        INTEGER NOT NULL DEFAULT 0,
        value           TEXT,
        thumbnail_path  TEXT,
        weight          INTEGER NOT NULL DEFAULT 1,
        active          INTEGER NOT NULL DEFAULT 1,
        times_applied   INTEGER NOT NULL DEFAULT 0,
        last_applied_at TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_rotvalues_field ON rotation_field_values(field_id, position);
    `);
  },

  // ------------------------------------------------- v3: stream + runtime
  function v3(d) {
    d.exec(`
      CREATE TABLE streams (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title               TEXT NOT NULL,
        video_id            INTEGER REFERENCES videos(id) ON DELETE SET NULL,

        encode_mode         TEXT NOT NULL DEFAULT 'copy',
        resolution          TEXT NOT NULL DEFAULT 'source',
        orientation         TEXT NOT NULL DEFAULT 'landscape',
        bitrate             INTEGER NOT NULL DEFAULT 4500,
        audio_bitrate       INTEGER NOT NULL DEFAULT 128,
        fps                 INTEGER NOT NULL DEFAULT 30,
        preset              TEXT NOT NULL DEFAULT 'veryfast',
        loop_video          INTEGER NOT NULL DEFAULT 1,
        auto_restart        INTEGER NOT NULL DEFAULT 1,

        status              TEXT NOT NULL DEFAULT 'idle',
        pid                 INTEGER,
        started_at          TEXT,
        ended_at            TEXT,
        error_message       TEXT,
        restart_count       INTEGER NOT NULL DEFAULT 0,

        schedule_start_at   TEXT,
        schedule_end_at     TEXT,
        duration_minutes    INTEGER,

        rotation_profile_id INTEGER REFERENCES rotation_profiles(id) ON DELETE SET NULL,
        rotation_enabled    INTEGER NOT NULL DEFAULT 0,
        rotate_on_start     INTEGER NOT NULL DEFAULT 1,

        youtube_account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        youtube_video_id    TEXT,
        youtube_auto_detect INTEGER NOT NULL DEFAULT 1,
        resolved_video_id   TEXT,
        resolved_at         TEXT,

        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_streams_user ON streams(user_id);
      CREATE INDEX idx_streams_status ON streams(status);

      CREATE TABLE stream_destinations (
        stream_id      INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
        PRIMARY KEY (stream_id, destination_id)
      );

      CREATE TABLE stream_sessions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id        INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        started_at       TEXT NOT NULL,
        ended_at         TEXT,
        duration_seconds INTEGER DEFAULT 0,
        exit_code        INTEGER,
        stop_reason      TEXT,
        rotations_count  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_streamsessions_stream ON stream_sessions(stream_id);

      CREATE TABLE stream_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id  INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        level      TEXT NOT NULL DEFAULT 'info',
        message    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_streamlogs_stream ON stream_logs(stream_id, id DESC);

      -- Kursor rotasi disimpan per stream (bukan per profil) supaya satu profil
      -- bisa dipakai beberapa stream tanpa saling menimpa posisi.
      CREATE TABLE rotation_state (
        stream_id       INTEGER PRIMARY KEY REFERENCES streams(id) ON DELETE CASCADE,
        profile_id      INTEGER REFERENCES rotation_profiles(id) ON DELETE SET NULL,
        cursor          INTEGER NOT NULL DEFAULT 0,
        shuffle_order   TEXT,
        next_run_at     TEXT,
        field_state     TEXT,
        last_item_id    INTEGER,
        last_applied_at TEXT,
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE rotation_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id  INTEGER REFERENCES streams(id) ON DELETE CASCADE,
        profile_id INTEGER,
        item_id    INTEGER,
        provider   TEXT NOT NULL DEFAULT 'youtube',
        field      TEXT,
        status     TEXT NOT NULL DEFAULT 'success',
        payload    TEXT,
        message    TEXT,
        quota_cost INTEGER NOT NULL DEFAULT 0,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_rotlogs_stream ON rotation_logs(stream_id, id DESC);
    `);
  },
];

function migrate() {
  const current = db.pragma('user_version', { simple: true });
  if (current >= MIGRATIONS.length) {
    log.info(`Skema sudah terbaru (v${current})`);
    return current;
  }

  for (let i = current; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    const step = MIGRATIONS[i];
    log.info(`Menjalankan migrasi v${version}...`);
    db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${version}`);
    })();
  }

  const final = db.pragma('user_version', { simple: true });
  log.info(`Migrasi selesai (v${final})`);
  return final;
}

if (require.main === module) {
  migrate();
  process.exit(0);
}

module.exports = { migrate };
