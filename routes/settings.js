'use strict';

const express = require('express');
const config = require('../config');
const settings = require('../models/settings');
const rotationModel = require('../models/rotation');
const ffmpegService = require('../services/ffmpeg');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const current = settings.all();

  res.render('settings', {
    title: 'Pengaturan',
    // JANGAN beri nama local ini `settings`: Express memakai key `settings`
    // pada view locals untuk app.settings, dan ejs-mate membaca
    // `options.settings.views` saat mencari file layout. Menimpanya membuat
    // render gagal dengan "path argument must be of type string".
    appSettings: current,
    // Secret tidak pernah dikirim balik ke browser — hanya status terisi/kosong.
    hasClientSecret: Boolean(current.google_client_secret),
    redirectUri: config.googleRedirectUri,
    appUrl: config.appUrl,
    timezone: config.timezone,
    encryptionDerived: config.encryptionKeyIsDerived,
    sessionEphemeral: config.sessionSecretIsEphemeral,
    ffmpegStatus: req.app.locals.ffmpegStatus || { ok: false, error: 'Belum diperiksa' },
    envClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
    envClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
  });
});

router.post('/google', (req, res) => {
  const { google_client_id, google_client_secret } = req.body;
  const patch = { google_client_id: (google_client_id || '').trim() };

  // Field secret yang dibiarkan kosong berarti "jangan ubah".
  if (google_client_secret && google_client_secret.trim()) {
    patch.google_client_secret = google_client_secret.trim();
  }

  settings.setMany(patch);
  req.session.flash = { type: 'success', message: 'Kredensial Google disimpan.' };
  res.redirect('/settings');
});

router.post('/google/clear', (req, res) => {
  settings.setMany({ google_client_id: '', google_client_secret: '' });
  req.session.flash = { type: 'success', message: 'Kredensial Google dihapus.' };
  res.redirect('/settings');
});

router.post('/general', (req, res) => {
  settings.setMany({
    default_rotation_interval: String(parseInt(req.body.default_rotation_interval, 10) || 60),
    quota_warn_threshold: String(Math.min(100, Math.max(1, parseInt(req.body.quota_warn_threshold, 10) || 80))),
    keep_rotation_logs_days: String(Math.max(1, parseInt(req.body.keep_rotation_logs_days, 10) || 30)),
  });
  req.session.flash = { type: 'success', message: 'Pengaturan umum disimpan.' };
  res.redirect('/settings');
});

router.post('/logs/prune', (req, res) => {
  const days = Math.max(1, parseInt(req.body.days, 10) || 30);
  const removed = rotationModel.pruneLogs(days);
  req.session.flash = { type: 'success', message: `${removed} baris log rotasi dihapus.` };
  res.redirect('/settings');
});

router.post('/ffmpeg/check', async (req, res) => {
  const status = await ffmpegService.checkAvailability();
  req.app.locals.ffmpegStatus = status;
  req.session.flash = status.ok
    ? { type: 'success', message: `FFmpeg terdeteksi: ${status.version}` }
    : { type: 'error', message: `FFmpeg tidak ditemukan: ${status.error}` };
  res.redirect('/settings');
});

module.exports = router;
