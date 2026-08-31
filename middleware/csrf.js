'use strict';

const { randomToken, safeEqual } = require('../utils/crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isMultipart(req) {
  return (req.get('content-type') || '').toLowerCase().startsWith('multipart/form-data');
}

function verifyToken(req, next) {
  const provided =
    (req.body && req.body._csrf) ||
    req.query._csrf ||
    req.get('x-csrf-token') ||
    req.get('x-xsrf-token');

  if (provided && safeEqual(provided, req.session.csrfToken)) {
    req.csrfPending = false;
    return next();
  }

  const err = new Error('Token keamanan tidak valid. Muat ulang halaman lalu coba lagi.');
  err.status = 403;
  err.code = 'EBADCSRFTOKEN';
  return next(err);
}

/**
 * Proteksi CSRF pola synchronizer token: satu token per sesi, dicocokkan pada
 * setiap request yang mengubah data.
 *
 * Request multipart ditangani berbeda. Body-nya baru diurai oleh multer, yang
 * berjalan di dalam rute — jauh setelah middleware ini. Karena itu verifikasi
 * ditunda, dan rute yang menerima berkas WAJIB memasang `csrf.verify` tepat
 * setelah middleware multer-nya. Lihat routes/videos.js dan routes/rotations.js.
 */
function csrf(req, res, next) {
  if (!req.session) return next();

  if (!req.session.csrfToken) req.session.csrfToken = randomToken(24);
  const token = req.session.csrfToken;

  res.locals.csrfToken = token;
  req.csrfToken = () => token;

  if (SAFE_METHODS.has(req.method)) return next();

  // Callback OAuth datang sebagai GET dari Google dan diamankan oleh parameter
  // `state`, jadi tidak melewati jalur ini.
  if (isMultipart(req)) {
    req.csrfPending = true;
    return next();
  }

  return verifyToken(req, next);
}

/** Verifikasi tertunda untuk rute multipart. Pasang tepat setelah multer. */
function verify(req, res, next) {
  if (!req.session) return next();
  return verifyToken(req, next);
}

module.exports = csrf;
module.exports.verify = verify;
module.exports.isMultipart = isMultipart;
