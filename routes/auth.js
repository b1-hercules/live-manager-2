'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const userModel = require('../models/user');
const { requireGuest, requireAuth } = require('../middleware/auth');

const router = express.Router();

// Batasi percobaan login untuk memperlambat serangan tebak-password.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
});

// ------------------------------------------------------------------ setup

router.get('/setup', (req, res) => {
  if (userModel.count() > 0) return res.redirect('/login');
  res.render('auth/setup', { title: 'Setup Awal', layout: 'layouts/blank', error: null });
});

router.post('/setup', (req, res) => {
  if (userModel.count() > 0) return res.redirect('/login');

  const { username, password, confirm } = req.body;
  const render = (error) =>
    res.status(400).render('auth/setup', { title: 'Setup Awal', layout: 'layouts/blank', error });

  if (!username || username.trim().length < 3) return render('Username minimal 3 karakter.');
  if (!password || password.length < 8) return render('Password minimal 8 karakter.');
  if (password !== confirm) return render('Konfirmasi password tidak cocok.');

  const user = userModel.create({ username: username.trim(), password });
  req.session.userId = user.id;
  req.session.flash = { type: 'success', message: `Selamat datang, ${user.username}! Akun admin sudah dibuat.` };
  res.redirect('/');
});

// ------------------------------------------------------------------ login

router.get('/login', requireGuest, (req, res) => {
  res.render('auth/login', { title: 'Masuk', layout: 'layouts/blank', error: null });
});

router.post('/login', requireGuest, loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const user = userModel.verify(username, password);

  if (!user) {
    return res.status(401).render('auth/login', {
      title: 'Masuk',
      layout: 'layouts/blank',
      error: 'Username atau password salah.',
    });
  }

  // Regenerasi session ID setelah login untuk mencegah session fixation.
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).render('auth/login', {
        title: 'Masuk',
        layout: 'layouts/blank',
        error: 'Gagal membuat sesi. Coba lagi.',
      });
    }
    req.session.userId = user.id;
    userModel.touchLogin(user.id);
    res.redirect(returnTo && returnTo.startsWith('/') ? returnTo : '/');
  });
});

router.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ----------------------------------------------------------------- profil

router.get('/profile', requireAuth, (req, res) => {
  res.render('auth/profile', { title: 'Profil', user: req.user, error: null });
});

router.post('/profile', requireAuth, (req, res) => {
  const { display_name, username } = req.body;
  if (!username || username.trim().length < 3) {
    req.session.flash = { type: 'error', message: 'Username minimal 3 karakter.' };
    return res.redirect('/profile');
  }

  const clash = userModel.findByUsername(username);
  if (clash && clash.id !== req.user.id) {
    req.session.flash = { type: 'error', message: 'Username sudah dipakai.' };
    return res.redirect('/profile');
  }

  userModel.updateProfile(req.user.id, { displayName: display_name || username, username });
  req.session.flash = { type: 'success', message: 'Profil diperbarui.' };
  res.redirect('/profile');
});

router.post('/profile/password', requireAuth, (req, res) => {
  const { current, password, confirm } = req.body;

  if (!userModel.verify(req.user.username, current)) {
    req.session.flash = { type: 'error', message: 'Password saat ini salah.' };
    return res.redirect('/profile');
  }
  if (!password || password.length < 8) {
    req.session.flash = { type: 'error', message: 'Password baru minimal 8 karakter.' };
    return res.redirect('/profile');
  }
  if (password !== confirm) {
    req.session.flash = { type: 'error', message: 'Konfirmasi password tidak cocok.' };
    return res.redirect('/profile');
  }

  userModel.setPassword(req.user.id, password);
  req.session.flash = { type: 'success', message: 'Password berhasil diganti.' };
  res.redirect('/profile');
});

module.exports = router;
