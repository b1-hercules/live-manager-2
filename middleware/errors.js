'use strict';

const fs = require('fs');
const { createLogger } = require('../utils/logger');
const { wantsJson } = require('./auth');

const log = createLogger('http');

/**
 * Multer sudah menulis berkas ke disk sebelum handler rute (dan verifikasi CSRF
 * tertunda) sempat berjalan. Kalau request-nya akhirnya gagal, berkas itu tidak
 * pernah tercatat di database dan akan menumpuk sebagai sampah — jadi dibuang.
 */
function cleanupUploads(req) {
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  else if (req.files) for (const group of Object.values(req.files)) files.push(...group);

  for (const file of files) {
    if (!file?.path) continue;
    try {
      fs.unlinkSync(file.path);
      log.debug(`Berkas unggahan yatim dihapus: ${file.path}`);
    } catch (_) { /* sudah hilang atau terkunci */ }
  }
}

function notFound(req, res, next) {
  const err = new Error(`Halaman tidak ditemukan: ${req.originalUrl}`);
  err.status = 404;
  next(err);
}

function handler(err, req, res, next) {
  cleanupUploads(req);

  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    log.error(`${req.method} ${req.originalUrl} → ${status}`, err);
  } else {
    log.warn(`${req.method} ${req.originalUrl} → ${status}: ${err.message}`);
  }

  // Detail error internal tidak pernah ditampilkan ke pengguna di produksi.
  const message = status >= 500 && process.env.NODE_ENV === 'production'
    ? 'Terjadi kesalahan di server. Cek logs/app.log untuk detailnya.'
    : err.message;

  if (wantsJson(req)) {
    return res.status(status).json({ ok: false, error: message, code: err.code });
  }

  // Aksi form yang gagal dikembalikan ke halaman sebelumnya dengan flash.
  if (req.method !== 'GET' && req.session && err.code !== 'EBADCSRFTOKEN') {
    req.session.flash = { type: 'error', message };
    return res.redirect(req.get('referer') || '/');
  }

  res.status(status).render('error', {
    title: status === 404 ? 'Tidak Ditemukan' : 'Terjadi Kesalahan',
    status,
    message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
}

module.exports = { notFound, handler };
