'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const config = require('../config');
const drive = require('./drive');
const videoIngest = require('./videoIngest');
const { VIDEO_EXT } = require('../middleware/upload');
const { createLogger } = require('../utils/logger');

const log = createLogger('import');

/**
 * Impor video dari Google Drive. Berkas berukuran gigabyte tidak selesai dalam
 * satu siklus permintaan-jawaban, jadi unduhan berjalan di latar belakang dan
 * kemajuannya ditanyakan lewat status().
 *
 * Job hanya hidup di memori: kalau aplikasi mati di tengah impor, unduhannya
 * hilang bersama berkas sementaranya, dan pengguna tinggal mengulang. Ini beda
 * dengan unggahan berpotongan yang memang harus tahan restart — di sana klien
 * yang memegang berkasnya, di sini sumbernya masih utuh di Drive.
 */
const jobs = new Map();

/** Job yang sudah selesai ditahan sebentar supaya UI sempat membaca hasilnya. */
const KEEP_DONE_MS = 10 * 60 * 1000;

function view(job) {
  return {
    id: job.id,
    state: job.state, // 'downloading' | 'processing' | 'done' | 'error'
    name: job.name,
    received: job.received,
    total: job.total,
    error: job.error,
    videoId: job.videoId,
  };
}

function status(id, userId) {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) return null;
  return view(job);
}

function listFor(userId) {
  return [...jobs.values()].filter((job) => job.userId === userId).map(view);
}

/** Buang catatan job yang sudah selesai; job yang masih jalan tidak bisa dibuang. */
function forget(id, userId) {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) return false;
  if (job.state === 'downloading' || job.state === 'processing') return false;
  jobs.delete(id);
  return true;
}

async function run(job, account, fileId, title) {
  const info = await drive.fileInfo(account, fileId);
  job.name = info.name;
  job.total = info.size;

  const ext = path.extname(info.name).toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    throw new Error(`Format video tidak didukung: ${ext || 'tanpa ekstensi'}`);
  }
  if (info.size && info.size > config.maxUploadBytes) {
    throw new Error(`Ukuran melebihi batas ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`);
  }

  const tmpPath = path.join(config.paths.tmp, `import-${job.id}${ext}`);
  let finalPath = null;
  try {
    await drive.download(account, fileId, tmpPath, {
      onProgress: (received, total) => {
        job.received = received;
        if (total) job.total = total;
      },
    });

    job.state = 'processing';
    finalPath = path.join(config.paths.videos, `${job.id}${ext}`);
    fs.renameSync(tmpPath, finalPath);

    // register() memeriksa magic byte, jadi berkas dari Drive melewati
    // pemeriksaan yang sama dengan berkas yang diunggah langsung.
    const video = await videoIngest.register({
      userId: job.userId,
      absPath: finalPath,
      originalName: info.name,
      title,
      size: fs.statSync(finalPath).size,
      log,
    });

    job.videoId = video.id;
    job.state = 'done';
  } catch (err) {
    if (finalPath) {
      try { fs.unlinkSync(finalPath); } catch (_) { /* sudah tidak ada */ }
    }
    throw err;
  } finally {
    // Tidak ada lagi setelah rename berhasil; ini untuk jalur yang gagal.
    try { fs.unlinkSync(tmpPath); } catch (_) { /* sudah dipindah atau tidak ada */ }
  }
}

/** Mulai impor satu berkas Drive; mengembalikan job untuk dipantau. */
function startDrive({ userId, account, fileId, title }) {
  const job = {
    id: uuid(),
    userId,
    state: 'downloading',
    name: '',
    received: 0,
    total: 0,
    error: null,
    videoId: null,
  };
  jobs.set(job.id, job);

  run(job, account, fileId, title)
    .catch((err) => {
      job.state = 'error';
      job.error = err.message;
      log.warn(`Impor Drive gagal: ${err.message}`);
    })
    .finally(() => {
      const timer = setTimeout(() => jobs.delete(job.id), KEEP_DONE_MS);
      if (timer.unref) timer.unref();
    });

  return view(job);
}

module.exports = { startDrive, status, listFor, forget };
