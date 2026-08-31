'use strict';

const fs = require('fs');
const path = require('path');
const { db, now } = require('../db');
const config = require('../config');

function listByUser(userId, { search = '', limit = 200, offset = 0 } = {}) {
  if (search) {
    return db
      .prepare(
        `SELECT * FROM videos WHERE user_id = ? AND title LIKE ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(userId, `%${search}%`, limit, offset);
  }
  return db
    .prepare('SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(userId, limit, offset);
}

function countByUser(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM videos WHERE user_id = ?').get(userId).n;
}

function totalSize(userId) {
  return db.prepare('SELECT COALESCE(SUM(filesize), 0) AS n FROM videos WHERE user_id = ?').get(userId).n;
}

function findById(id, userId = null) {
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!row) return null;
  if (userId !== null && row.user_id !== userId) return null;
  return row;
}

function create(data) {
  const info = db
    .prepare(
      `INSERT INTO videos
        (user_id, title, filename, filepath, thumbnail_path, filesize, duration,
         width, height, fps, video_codec, audio_codec, bitrate, has_audio,
         source, status, created_at, updated_at)
       VALUES
        (@user_id, @title, @filename, @filepath, @thumbnail_path, @filesize, @duration,
         @width, @height, @fps, @video_codec, @audio_codec, @bitrate, @has_audio,
         @source, @status, @created_at, @updated_at)`
    )
    .run({
      user_id: data.user_id,
      title: data.title,
      filename: data.filename,
      filepath: data.filepath,
      thumbnail_path: data.thumbnail_path || null,
      filesize: data.filesize || 0,
      duration: data.duration || 0,
      width: data.width || 0,
      height: data.height || 0,
      fps: data.fps || 0,
      video_codec: data.video_codec || null,
      audio_codec: data.audio_codec || null,
      bitrate: data.bitrate || 0,
      has_audio: data.has_audio === false ? 0 : 1,
      source: data.source || 'upload',
      status: data.status || 'ready',
      created_at: now(),
      updated_at: now(),
    });
  return findById(info.lastInsertRowid);
}

function updateMeta(id, meta) {
  db.prepare(
    `UPDATE videos SET duration = @duration, width = @width, height = @height, fps = @fps,
      video_codec = @video_codec, audio_codec = @audio_codec, bitrate = @bitrate,
      has_audio = @has_audio, thumbnail_path = COALESCE(@thumbnail_path, thumbnail_path),
      status = @status, error_message = @error_message, updated_at = @updated_at
     WHERE id = @id`
  ).run({
    id,
    duration: meta.duration || 0,
    width: meta.width || 0,
    height: meta.height || 0,
    fps: meta.fps || 0,
    video_codec: meta.video_codec || null,
    audio_codec: meta.audio_codec || null,
    bitrate: meta.bitrate || 0,
    has_audio: meta.has_audio === false ? 0 : 1,
    thumbnail_path: meta.thumbnail_path || null,
    status: meta.status || 'ready',
    error_message: meta.error_message || null,
    updated_at: now(),
  });
  return findById(id);
}

function rename(id, userId, title) {
  db.prepare('UPDATE videos SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(title, now(), id, userId);
  return findById(id, userId);
}

/** Cek apakah video sedang dipakai stream yang belum selesai. */
function usedByStreams(id) {
  return db
    .prepare(`SELECT id, title, status FROM streams WHERE video_id = ? AND status IN ('live','starting','scheduled')`)
    .all(id);
}

function remove(id, userId) {
  const video = findById(id, userId);
  if (!video) return false;
  db.prepare('DELETE FROM videos WHERE id = ? AND user_id = ?').run(id, userId);
  for (const p of [video.filepath, video.thumbnail_path]) {
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.join(config.root, p);
    // Jangan biarkan file sisa menggagalkan penghapusan baris DB.
    try { fs.unlinkSync(abs); } catch (_) { /* file mungkin sudah hilang */ }
  }
  return true;
}

module.exports = {
  listByUser, countByUser, totalSize, findById, create, updateMeta, rename, usedByStreams, remove,
};
