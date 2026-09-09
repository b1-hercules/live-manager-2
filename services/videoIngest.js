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
async function register({ userId, absPath, originalName, title, size, log, kind = 'video' }) {
  // Ekstensi tidak menentukan apa pun soal isi; ini berlaku untuk berkas yang
  // diunggah pengguna maupun yang diunduh dari layanan pihak ketiga.
  //
  // `kind` menyatakan apa yang DIHARAPKAN jalur pemanggil ('video' atau
  // 'audio'); signature berkaslah yang memutuskan diterima atau tidak. Nilai
  // bawaan 'video' membuat ketiga pemanggil lama tidak perlu diubah.
  const bad = contentError(absPath, originalName, kind, kind === 'audio' ? 'audio' : 'video');
  if (bad) throw bad;

  const meta = await ffmpeg.probe(absPath);

  // Thumbnail dibuat dari frame video, jadi berkas musik melewatinya. Yang
  // menentukan adalah meta.kind (isi berkas sesungguhnya), bukan `kind` dari
  // pemanggil — gerbang di atas sudah memastikan keduanya sepakat.
  let thumbRel = null;
  if (meta.kind !== 'audio') {
    try {
      const thumbAbs = path.join(config.paths.thumbnails, `${uuid()}.jpg`);
      await ffmpeg.generateThumbnail(absPath, thumbAbs, { atSeconds: Math.min(3, meta.duration / 2) });
      thumbRel = relativePath(thumbAbs);
    } catch (thumbErr) {
      log?.warn?.(`Thumbnail gagal: ${thumbErr.message}`);
    }
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
