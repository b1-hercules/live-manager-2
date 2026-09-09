'use strict';

const fs = require('fs');
const path = require('path');
const { db, now } = require('../db');
const config = require('../config');

/**
 * Gambar latar milik satu siaran radio.
 *
 * Sengaja tabel sendiri, bukan baris di `videos`: gambar tidak punya durasi,
 * fps, atau codec yang perlu dibaca, jadi probe() tidak perlu tahu-menahu soal
 * gambar dan kolom `kind` di sana cukup dua nilai saja. Konsekuensinya impor
 * dari Drive tidak berlaku untuk latar — itu keputusan yang diambil sadar.
 */

function listByStream(streamId) {
  return db
    .prepare('SELECT * FROM stream_backgrounds WHERE stream_id = ? ORDER BY position ASC, id ASC')
    .all(streamId);
}

function countByStream(streamId) {
  return db.prepare('SELECT COUNT(*) AS n FROM stream_backgrounds WHERE stream_id = ?').get(streamId).n;
}

/** Tambahkan di urutan paling belakang. */
function add(streamId, filepath) {
  const next = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM stream_backgrounds WHERE stream_id = ?')
    .get(streamId).n;

  const info = db
    .prepare('INSERT INTO stream_backgrounds (stream_id, filepath, position, created_at) VALUES (?, ?, ?, ?)')
    .run(streamId, filepath, next, now());
  return db.prepare('SELECT * FROM stream_backgrounds WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Urutkan ulang dari daftar id. Id yang bukan milik siaran ini diabaikan, jadi
 * request yang dipalsukan tidak bisa memindahkan latar milik siaran lain.
 */
function reorder(streamId, orderedIds) {
  const own = new Set(listByStream(streamId).map((row) => row.id));
  const update = db.prepare('UPDATE stream_backgrounds SET position = ? WHERE id = ? AND stream_id = ?');

  const run = db.transaction((ids) => {
    let position = 0;
    for (const id of ids) {
      const numeric = Number(id);
      if (!own.has(numeric)) continue;
      update.run(position, numeric, streamId);
      position += 1;
    }
  });
  run(orderedIds);
}

/**
 * Hapus satu latar beserta berkasnya. Berkas gambar hanya dipakai siaran ini,
 * jadi tidak ada pemilik lain yang perlu diperiksa — berbeda dari video, yang
 * bisa dipakai beberapa playlist sekaligus.
 */
function remove(id, streamId) {
  const row = db.prepare('SELECT * FROM stream_backgrounds WHERE id = ? AND stream_id = ?').get(id, streamId);
  if (!row) return false;

  db.prepare('DELETE FROM stream_backgrounds WHERE id = ?').run(id);

  try {
    const abs = path.isAbsolute(row.filepath) ? row.filepath : path.join(config.root, row.filepath);
    fs.unlinkSync(abs);
  } catch (_) { /* berkas mungkin sudah hilang */ }

  return true;
}

function removeAll(streamId) {
  const rows = listByStream(streamId);
  for (const row of rows) remove(row.id, streamId);
  return rows.length;
}

module.exports = { listByStream, countByStream, add, reorder, remove, removeAll };
