'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const config = require('../config');
const { VIDEO_EXT } = require('../middleware/upload');

/**
 * Unggahan berpotongan yang bisa dilanjutkan. Batas unggahan di aplikasi ini
 * 4 GB secara bawaan, dan sekali koneksi putus di tengah, unggahan multipart
 * biasa harus diulang dari nol. Di sini tiap potongan ditulis ke berkas parsial
 * dan posisinya disimpan, jadi klien bisa menyambung dari byte terakhir.
 *
 * Tiap unggahan berjalan menempati dua berkas di storage/tmp:
 *   <id>.part  — byte yang sudah diterima
 *   <id>.json  — pemilik, nama asli, dan ukuran yang dijanjikan klien
 * Kemajuannya ada di ukuran berkas .part itu sendiri, jadi tetap benar meski
 * aplikasi direstart di tengah unggahan.
 */

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Satu id hanya boleh ditulis satu permintaan pada satu saat. Dua PATCH yang
 * datang bersamaan bisa sama-sama lolos pemeriksaan offset lalu menulis dobel. */
const writing = new Set();

// id selalu buatan server, tapi tetap divalidasi karena ia dipakai menyusun
// path — nama yang mengandung ".." atau pemisah direktori tidak boleh lewat.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function partPath(id) {
  return path.join(config.paths.tmp, `${id}.part`);
}

function metaPath(id) {
  return path.join(config.paths.tmp, `${id}.json`);
}

function readMeta(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

function currentOffset(id) {
  try {
    return fs.statSync(partPath(id)).size;
  } catch (_) {
    return 0;
  }
}

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Mulai unggahan baru; mengembalikan id yang dipakai untuk mengirim potongan. */
function init({ userId, filename, size }) {
  const declared = Number(size);
  if (!Number.isFinite(declared) || declared <= 0) {
    throw fail('Ukuran berkas tidak valid.');
  }
  if (declared > config.maxUploadBytes) {
    throw fail(`Ukuran melebihi batas ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`);
  }
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    throw fail(`Format video tidak didukung: ${ext || 'tanpa ekstensi'}`);
  }

  const id = uuid();
  fs.writeFileSync(
    metaPath(id),
    JSON.stringify({ userId, filename: String(filename), ext, size: declared, createdAt: Date.now() })
  );
  fs.writeFileSync(partPath(id), '');
  return { id, offset: 0, size: declared };
}

/** Kemajuan unggahan milik pengguna ini, atau null bila tidak ada/bukan miliknya. */
function stat(id, userId) {
  const meta = readMeta(id);
  if (!meta || meta.userId !== userId) return null;
  return { id, offset: currentOffset(id), size: meta.size, filename: meta.filename };
}

/**
 * Sambung potongan pada posisi tertentu. Offset dari klien hanya diterima kalau
 * cocok persis dengan panjang berkas parsial di server — server yang menentukan,
 * sehingga potongan yang terlambat atau terkirim dua kali tidak merusak berkas.
 */
function append(id, userId, offset, chunk) {
  const meta = readMeta(id);
  if (!meta || meta.userId !== userId) throw fail('Unggahan tidak ditemukan.', 404);
  if (!Buffer.isBuffer(chunk) || !chunk.length) throw fail('Potongan kosong.');

  if (writing.has(id)) throw fail('Potongan lain untuk unggahan ini sedang ditulis.', 409);
  writing.add(id);
  try {
    const at = currentOffset(id);
    if (Number(offset) !== at) {
      // Bukan error fatal: klien tinggal melanjutkan dari offset yang benar.
      const err = fail(`Offset tidak cocok. Lanjutkan dari ${at}.`, 409);
      err.offset = at;
      throw err;
    }
    if (at + chunk.length > meta.size) {
      throw fail('Potongan melebihi ukuran berkas yang dijanjikan.');
    }
    fs.appendFileSync(partPath(id), chunk);
    return { offset: at + chunk.length, size: meta.size };
  } finally {
    writing.delete(id);
  }
}

/**
 * Tutup unggahan: berkas parsial dipindahkan ke storage/videos dan metadatanya
 * dikembalikan supaya rute bisa melanjutkan ke ffprobe. Pemanggil bertanggung
 * jawab menghapus berkas hasil bila pemeriksaan berikutnya gagal.
 */
function finish(id, userId) {
  const meta = readMeta(id);
  if (!meta || meta.userId !== userId) throw fail('Unggahan tidak ditemukan.', 404);

  const received = currentOffset(id);
  if (received !== meta.size) {
    const err = fail(`Unggahan belum lengkap (${received} dari ${meta.size} byte).`, 409);
    err.offset = received;
    throw err;
  }

  const target = path.join(config.paths.videos, `${id}${meta.ext}`);
  fs.renameSync(partPath(id), target);
  try { fs.unlinkSync(metaPath(id)); } catch (_) { /* sudah tidak ada */ }

  return { absPath: target, filename: meta.filename, size: meta.size };
}

/** Batalkan unggahan dan buang berkas parsialnya. */
function discard(id, userId) {
  const meta = readMeta(id);
  if (!meta || meta.userId !== userId) return false;
  for (const file of [partPath(id), metaPath(id)]) {
    try { fs.unlinkSync(file); } catch (_) { /* sudah tidak ada */ }
  }
  return true;
}

/**
 * Buang unggahan yang ditinggalkan. Dipanggil dari pembersihan harian scheduler;
 * tanpa ini, unggahan besar yang gagal akan menumpuk diam-diam di storage/tmp.
 */
function sweep(maxAgeMs = MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let files = [];
  try {
    files = fs.readdirSync(config.paths.tmp);
  } catch (_) {
    return 0;
  }

  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const meta = readMeta(id);
    // Metadata rusak ikut dibuang: tanpa itu berkas .part-nya tidak bisa dilanjutkan.
    if (meta && Number(meta.createdAt) > cutoff) continue;
    for (const file of [partPath(id), metaPath(id)]) {
      try { fs.unlinkSync(file); } catch (_) { /* sudah tidak ada */ }
    }
    removed += 1;
  }
  return removed;
}

module.exports = { init, stat, append, finish, discard, sweep, MAX_AGE_MS };
