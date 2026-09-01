'use strict';

const { db, now } = require('../db');
const { toBool, toInt } = require('../utils/helpers');

/**
 * Playlist: beberapa video diputar berurutan dalam satu siaran, menggantikan
 * satu video yang diulang terus-menerus.
 *
 * Video yang sama boleh muncul lebih dari sekali dalam satu playlist, jadi yang
 * dipakai sebagai identitas baris adalah playlist_items.id — bukan video_id.
 */

function hydrate(row) {
  if (!row) return null;
  return { ...row, shuffle: Boolean(row.shuffle) };
}

function listByUser(userId) {
  return db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) AS item_count,
              (SELECT COALESCE(SUM(v.duration), 0)
                 FROM playlist_items pi JOIN videos v ON v.id = pi.video_id
                WHERE pi.playlist_id = p.id) AS total_duration
         FROM playlists p
        WHERE p.user_id = ?
        ORDER BY p.created_at DESC`
    )
    .all(userId)
    .map(hydrate);
}

function findById(id, userId = null) {
  const sql = userId
    ? 'SELECT * FROM playlists WHERE id = ? AND user_id = ?'
    : 'SELECT * FROM playlists WHERE id = ?';
  const row = userId ? db.prepare(sql).get(id, userId) : db.prepare(sql).get(id);
  return hydrate(row);
}

function create(userId, { name, description = null, shuffle = 0 }) {
  const info = db
    .prepare(
      `INSERT INTO playlists (user_id, name, description, shuffle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      String(name || 'Playlist baru').slice(0, 120),
      description ? String(description).slice(0, 500) : null,
      toBool(shuffle) ? 1 : 0,
      now(),
      now()
    );
  return findById(info.lastInsertRowid);
}

function update(id, userId, { name, description, shuffle }) {
  const existing = findById(id, userId);
  if (!existing) return null;
  db.prepare('UPDATE playlists SET name = ?, description = ?, shuffle = ?, updated_at = ? WHERE id = ?')
    .run(
      String(name || existing.name).slice(0, 120),
      description !== undefined ? (description ? String(description).slice(0, 500) : null) : existing.description,
      toBool(shuffle) ? 1 : 0,
      now(),
      id
    );
  return findById(id);
}

function remove(id, userId) {
  return db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// ------------------------------------------------------------------- item

/** Item beserta metadata videonya — dipakai untuk memeriksa kecocokan spesifikasi. */
function listItems(playlistId) {
  return db
    .prepare(
      `SELECT pi.id, pi.playlist_id, pi.video_id, pi.position,
              v.title, v.filepath, v.thumbnail_path, v.duration, v.filesize,
              v.width, v.height, v.fps, v.video_codec, v.audio_codec, v.has_audio
         FROM playlist_items pi
         JOIN videos v ON v.id = pi.video_id
        WHERE pi.playlist_id = ?
        ORDER BY pi.position, pi.id`
    )
    .all(playlistId);
}

function nextPosition(playlistId) {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM playlist_items WHERE playlist_id = ?')
    .get(playlistId);
  return row.p + 1;
}

function addItem(playlistId, videoId) {
  const info = db
    .prepare('INSERT INTO playlist_items (playlist_id, video_id, position, created_at) VALUES (?, ?, ?, ?)')
    .run(playlistId, toInt(videoId, 0), nextPosition(playlistId), now());
  touch(playlistId);
  return info.lastInsertRowid;
}

function removeItem(playlistId, itemId) {
  const changed = db
    .prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .run(itemId, playlistId).changes;
  if (changed) touch(playlistId);
  return changed > 0;
}

function reorderItems(playlistId, orderedIds) {
  const stmt = db.prepare('UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?');
  db.transaction(() => {
    orderedIds.forEach((id, index) => stmt.run(index, id, playlistId));
  })();
  touch(playlistId);
}

function touch(playlistId) {
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), playlistId);
}

/** Stream yang memakai playlist ini — dipakai agar penghapusan tidak diam-diam. */
function usedByStreams(playlistId) {
  return db.prepare('SELECT id, title, status FROM streams WHERE playlist_id = ?').all(playlistId);
}

module.exports = {
  listByUser, findById, create, update, remove,
  listItems, addItem, removeItem, reorderItems, usedByStreams,
};
