'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { v4: uuid } = require('uuid');
const config = require('../config');
const videoModel = require('../models/video');
const ffmpeg = require('../services/ffmpeg');
const { uploadVideo, relativePath, handleUploadError } = require('../middleware/upload');
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
router.post('/upload', uploadVideo.single('video'), handleUploadError, csrf.verify, async (req, res, next) => {
  if (!req.file) {
    req.session.flash = { type: 'error', message: 'Tidak ada file yang diunggah.' };
    return res.redirect('/videos');
  }

  const absPath = req.file.path;
  const title = (req.body.title || path.parse(req.file.originalname).name).slice(0, 150);

  try {
    const meta = await ffmpeg.probe(absPath);

    // Thumbnail dibuat dari frame video; kegagalannya tidak membatalkan upload.
    let thumbRel = null;
    try {
      const thumbAbs = path.join(config.paths.thumbnails, `${uuid()}.jpg`);
      await ffmpeg.generateThumbnail(absPath, thumbAbs, { atSeconds: Math.min(3, meta.duration / 2) });
      thumbRel = relativePath(thumbAbs);
    } catch (thumbErr) {
      req.app.locals.log?.warn?.(`Thumbnail gagal: ${thumbErr.message}`);
    }

    const video = videoModel.create({
      user_id: req.user.id,
      title,
      filename: req.file.originalname,
      filepath: relativePath(absPath),
      thumbnail_path: thumbRel,
      filesize: req.file.size,
      ...meta,
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
