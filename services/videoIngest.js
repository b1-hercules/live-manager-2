'use strict';

const path = require('path');
const { v4: uuid } = require('uuid');
const config = require('../config');
const videoModel = require('../models/video');
const ffmpeg = require('./ffmpeg');
const { relativePath, contentError } = require('../middleware/upload');

/**
 * Langkah bersama setelah sebuah berkas video utuh berada di disk, dari jalur
 * mana pun: unggahan multipart, unggahan berpotongan, atau impor dari cloud.
 * Memeriksa isi berkas, menjalankan ffprobe, membuat thumbnail, lalu mencatat
 * ke database.
 *
 * Disatukan di satu tempat supaya jalur baru tidak bisa diam-diam melewati
 * pemeriksaan yang sudah berlaku di jalur lama.
 */
async function register({ userId, absPath, originalName, title, size, log }) {
  // Ekstensi tidak menentukan apa pun soal isi; ini berlaku untuk berkas yang
  // diunggah pengguna maupun yang diunduh dari layanan pihak ketiga.
  const bad = contentError(absPath, originalName, 'video', 'video');
  if (bad) throw bad;

  const meta = await ffmpeg.probe(absPath);

  // Thumbnail dibuat dari frame video; kegagalannya tidak membatalkan proses.
  let thumbRel = null;
  try {
    const thumbAbs = path.join(config.paths.thumbnails, `${uuid()}.jpg`);
    await ffmpeg.generateThumbnail(absPath, thumbAbs, { atSeconds: Math.min(3, meta.duration / 2) });
    thumbRel = relativePath(thumbAbs);
  } catch (thumbErr) {
    log?.warn?.(`Thumbnail gagal: ${thumbErr.message}`);
  }

  return videoModel.create({
    user_id: userId,
    title: String(title || path.parse(originalName).name).slice(0, 150),
    filename: originalName,
    filepath: relativePath(absPath),
    thumbnail_path: thumbRel,
    filesize: size,
    ...meta,
  });
}

module.exports = { register };
