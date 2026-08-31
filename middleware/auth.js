'use strict';

const userModel = require('../models/user');

/** Isi res.locals.currentUser pada setiap request supaya view bisa memakainya. */
function loadUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session?.userId) {
    const user = userModel.findById(req.session.userId);
    if (user) {
      req.user = user;
      res.locals.currentUser = { id: user.id, username: user.username, display_name: user.display_name };
    } else {
      // Baris user sudah dihapus tapi cookie sesi masih ada.
      req.session.destroy(() => {});
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();

  if (wantsJson(req)) {
    return res.status(401).json({ ok: false, error: 'Sesi berakhir, silakan login ulang' });
  }
  // Simpan tujuan awal agar setelah login pengguna kembali ke halaman yang diminta.
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

function requireGuest(req, res, next) {
  if (req.user) return res.redirect('/');
  next();
}

/**
 * Kalau belum ada user sama sekali, semua rute dialihkan ke halaman setup.
 * Ini mencegah instalasi baru terbuka tanpa kredensial.
 */
function requireSetup(req, res, next) {
  // Health check harus tetap menjawab 200 pada instalasi yang belum di-setup,
  // supaya Docker/monitoring tidak menganggap container gagal.
  if (req.path === '/health') return next();

  const hasUsers = userModel.count() > 0;
  const onSetup = req.path.startsWith('/setup');

  if (!hasUsers && !onSetup) return res.redirect('/setup');
  if (hasUsers && onSetup) return res.redirect('/login');
  next();
}

function wantsJson(req) {
  return (
    req.xhr ||
    req.path.startsWith('/api/') ||
    (req.get('accept') || '').includes('application/json')
  );
}

module.exports = { loadUser, requireAuth, requireGuest, requireSetup, wantsJson };
