'use strict';

const fs = require('fs');
const express = require('express');
const config = require('../config');
const videoModel = require('../models/video');
const accountModel = require('../models/account');
const chunkUpload = require('../services/chunkUpload');
const videoIngest = require('../services/videoIngest');
const videoImport = require('../services/videoImport');
const drive = require('../services/drive');
const { uploadVideo, verifyVideoContent, handleUploadError } = require('../middleware/upload');
const csrf = require('../middleware/csrf');
const { requireAuth } = require('../middleware/auth');
const { formatBytes, formatDuration } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const search = (req.query.q || '').trim();
  const videos = videoModel.listByUser(req.user.id, { search });
  res.render('videos/index', {
    title: 'Galeri Video',
    videos,
    search,
    totalSize: videoModel.totalSize(req.user.id),
    maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
    formatBytes,
    formatDuration,
  });
});

// csrf.verify wajib ada setelah multer: body multipart baru terurai di sini.
router.post('/upload', uploadVideo.single('video'), handleUploadError, csrf.verify, verifyVideoContent, async (req, res, next) => {
  if (!req.file) {
    req.session.flash = { type: 'error', message: 'Tidak ada file yang diunggah.' };
    return res.redirect('/videos');
  }

  const absPath = req.file.path;
  try {
    const video = await videoIngest.register({
      userId: req.user.id,
      absPath,
      originalName: req.file.originalname,
      title: req.body.title,
      size: req.file.size,
      log: req.app.locals.log,
    });

    req.session.flash = {
      type: 'success',
      message: `"${video.title}" berhasil diunggah (${formatBytes(video.filesize)}, ${formatDuration(video.duration)}).`,
    };
    res.redirect('/videos');
  } catch (err) {
    // File yang tidak bisa dibaca FFmpeg tidak berguna — hapus dari disk.
    try { fs.unlinkSync(absPath); } catch (_) { /* sudah tidak ada */ }
    err.status = 400;
    err.message = `File ditolak: ${err.message}`;
    next(err);
  }
});

// ------------------------------------------- unggahan berpotongan (resumable)

// Batas per permintaan, bukan batas berkas. Klien memakai potongan 8 MB;
// ruang lebihnya menampung potongan terakhir yang ukurannya tidak bulat.
const CHUNK_LIMIT = 16 * 1024 * 1024;

/** Offset tidak cocok bukan kegagalan fatal — klien tinggal menyambung ulang. */
function sendResumable(res, err, next) {
  if (err.offset === undefined) return next(err);
  return res.status(err.status || 409).json({ ok: false, error: err.message, offset: err.offset });
}

router.post('/upload/init', (req, res, next) => {
  try {
    const started = chunkUpload.init({
      userId: req.user.id,
      filename: req.body.filename,
      size: req.body.size,
    });
    res.json({ ok: true, ...started });
  } catch (err) {
    next(err);
  }
});

/** Dipakai klien untuk menanyakan sampai byte ke berapa unggahan sudah diterima. */
router.get('/upload/:id', (req, res) => {
  const info = chunkUpload.stat(req.params.id, req.user.id);
  if (!info) return res.status(404).json({ ok: false, error: 'Unggahan tidak ditemukan.' });
  res.json({ ok: true, ...info });
});

router.put('/upload/:id', express.raw({ type: '*/*', limit: CHUNK_LIMIT }), (req, res, next) => {
  try {
    const offset = Number(req.get('upload-offset'));
    res.json({ ok: true, ...chunkUpload.append(req.params.id, req.user.id, offset, req.body) });
  } catch (err) {
    sendResumable(res, err, next);
  }
});

router.post('/upload/:id/finish', async (req, res, next) => {
  let file;
  try {
    file = chunkUpload.finish(req.params.id, req.user.id);
  } catch (err) {
    return sendResumable(res, err, next);
  }

  try {
    // Pemeriksaan magic byte ada di dalam videoIngest.register(), jadi jalur ini
    // tidak bisa lolos tanpanya meski multer tidak pernah menyentuhnya.
    const video = await videoIngest.register({
      userId: req.user.id,
      absPath: file.absPath,
      originalName: file.filename,
      title: req.body.title,
      size: file.size,
      log: req.app.locals.log,
    });

    req.session.flash = {
      type: 'success',
      message: `"${video.title}" berhasil diunggah (${formatBytes(video.filesize)}, ${formatDuration(video.duration)}).`,
    };
    res.json({ ok: true, id: video.id, title: video.title });
  } catch (err) {
    try { fs.unlinkSync(file.absPath); } catch (_) { /* sudah tidak ada */ }
    err.status = err.status || 400;
    err.message = `File ditolak: ${err.message}`;
    next(err);
  }
});

router.delete('/upload/:id', (req, res) => {
  res.json({ ok: chunkUpload.discard(req.params.id, req.user.id) });
});

// ------------------------------------------------- impor dari Google Drive

/**
 * Akun Google yang izin Drive-nya sudah diberikan. Akun yang dihubungkan
 * sebelum scope Drive ditambahkan tetap sah untuk rotasi, tapi belum bisa
 * dipakai mengimpor sampai dihubungkan ulang.
 */
function pickDriveAccount(req) {
  const usable = accountModel.listByUser(req.user.id, 'youtube').filter(drive.hasAccess);
  const wanted = req.query.account || req.body.account;
  const account = wanted
    ? usable.find((a) => String(a.id) === String(wanted))
    : usable[0];

  if (!account) {
    const total = accountModel.listByUser(req.user.id, 'youtube').length;
    const err = new Error(
      total
        ? 'Akun Google yang terhubung belum memberi izin baca Drive. Hubungkan ulang akunnya di halaman Akun.'
        : 'Belum ada akun Google yang terhubung. Hubungkan dulu di halaman Akun.'
    );
    err.status = 400;
    throw err;
  }
  return account;
}

router.get('/import/drive/files', async (req, res, next) => {
  try {
    const account = pickDriveAccount(req);
    const data = await drive.listVideos(account, {
      search: (req.query.q || '').trim(),
      pageToken: req.query.pageToken || null,
    });
    res.json({ ok: true, account: { id: account.id, name: account.name }, ...data });
  } catch (err) {
    next(err);
  }
});

router.post('/import/drive', (req, res, next) => {
  try {
    const account = pickDriveAccount(req);
    const fileId = String(req.body.fileId || '').trim();
    if (!fileId) {
      const err = new Error('Berkas Drive belum dipilih.');
      err.status = 400;
      throw err;
    }
    res.json({
      ok: true,
      job: videoImport.startDrive({
        userId: req.user.id,
        account,
        fileId,
        title: req.body.title,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// Terdaftar sebelum '/import/:jobId' supaya 'jobs' tidak tertangkap sebagai id.
router.get('/import/jobs', (req, res) => {
  res.json({ ok: true, jobs: videoImport.listFor(req.user.id) });
});

router.get('/import/:jobId', (req, res) => {
  const job = videoImport.status(req.params.jobId, req.user.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Impor tidak ditemukan.' });
  res.json({ ok: true, job });
});

router.delete('/import/:jobId', (req, res) => {
  res.json({ ok: videoImport.forget(req.params.jobId, req.user.id) });
});

router.post('/:id/rename', (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) {
    req.session.flash = { type: 'error', message: 'Judul tidak boleh kosong.' };
    return res.redirect('/videos');
  }
  const video = videoModel.rename(req.params.id, req.user.id, title.slice(0, 150));
  req.session.flash = video
    ? { type: 'success', message: 'Judul video diperbarui.' }
    : { type: 'error', message: 'Video tidak ditemukan.' };
  res.redirect('/videos');
});

router.post('/:id/delete', (req, res) => {
  const inUse = videoModel.usedByStreams(req.params.id);
  if (inUse.length) {
    req.session.flash = {
      type: 'error',
      message: `Video dipakai oleh stream: ${inUse.map((s) => s.title).join(', ')}. Hentikan stream itu dulu.`,
    };
    return res.redirect('/videos');
  }

  const removed = videoModel.remove(req.params.id, req.user.id);
  req.session.flash = removed
    ? { type: 'success', message: 'Video dihapus.' }
    : { type: 'error', message: 'Video tidak ditemukan.' };
  res.redirect('/videos');
});

module.exports = router;
