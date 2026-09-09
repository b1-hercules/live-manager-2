'use strict';

const express = require('express');
const config = require('../config');
const accountModel = require('../models/account');
const settings = require('../models/settings');
const youtube = require('../services/youtube');
const apiHealth = require('../services/apiHealth');
const { requireAuth } = require('../middleware/auth');
const { randomToken, safeEqual } = require('../utils/crypto');
const { createLogger } = require('../utils/logger');

const log = createLogger('accounts');
const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const list = accountModel.listByUser(req.user.id).map((a) => ({
    ...a,
    quota: accountModel.getQuota(a.id),
  }));

  res.render('accounts/index', {
    title: 'Akun Terhubung',
    accounts: list,
    hasCredentials: settings.hasGoogleCredentials(),
    redirectUri: config.googleRedirectUri,
    quotaCost: accountModel.QUOTA_COST,
  });
});

/** Mulai alur OAuth. `state` mengikat callback ke sesi yang memulainya. */
router.post('/youtube/connect', (req, res, next) => {
  try {
    const state = randomToken(16);
    req.session.oauthState = state;
    res.redirect(youtube.getAuthUrl(state));
  } catch (err) {
    err.status = err.reason === 'no_credentials' ? 400 : 500;
    next(err);
  }
});

/**
 * Callback dari Google. Ini GET dari pihak ketiga, jadi CSRF token tidak
 * berlaku; pengamanannya adalah parameter `state` yang kita simpan di sesi.
 */
router.get('/youtube/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const expected = req.session.oauthState;
  delete req.session.oauthState;

  if (error) {
    req.session.flash = { type: 'error', message: `Google menolak izin: ${error}` };
    return res.redirect('/accounts');
  }
  if (!code || !state || !expected || !safeEqual(state, expected)) {
    req.session.flash = { type: 'error', message: 'Callback OAuth tidak valid atau kedaluwarsa. Coba hubungkan lagi.' };
    return res.redirect('/accounts');
  }

  try {
    const { tokens, channel } = await youtube.exchangeCode(code);

    if (!tokens.refresh_token) {
      const existing = accountModel.findByExternalId(req.user.id, 'youtube', channel.id);
      if (!existing?.refresh_token) {
        req.session.flash = {
          type: 'error',
          message:
            'Google tidak mengirim refresh token. Cabut akses aplikasi ini di myaccount.google.com/permissions, ' +
            'lalu hubungkan ulang.',
        };
        return res.redirect('/accounts');
      }
    }

    const account = accountModel.upsert({
      user_id: req.user.id,
      provider: 'youtube',
      external_id: channel.id,
      name: channel.title,
      avatar_url: channel.avatar,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scopes: (tokens.scope || youtube.SCOPES.join(' ')),
    });

    log.info(`Akun YouTube terhubung: ${channel.title}`, { accountId: account.id });
    req.session.flash = { type: 'success', message: `Channel "${channel.title}" berhasil dihubungkan.` };
  } catch (err) {
    log.error('OAuth callback gagal', err);
    req.session.flash = { type: 'error', message: `Gagal menghubungkan: ${err.message}` };
  }

  res.redirect('/accounts');
});

/** Uji koneksi: deteksi broadcast aktif sekaligus memastikan token masih hidup. */
router.post('/:id/test', async (req, res) => {
  const account = accountModel.findById(req.params.id, req.user.id);
  if (!account) return res.status(404).json({ ok: false, error: 'Akun tidak ditemukan' });

  try {
    const broadcast = await youtube.detectActiveBroadcast(account);
    return res.json({
      ok: true,
      broadcast,
      quota: accountModel.getQuota(account.id),
      message: broadcast
        ? `Siaran ${broadcast.status === 'active' ? 'aktif' : 'terjadwal'} terdeteksi: ${broadcast.videoId}`
        : 'Koneksi berhasil, tapi belum ada siaran aktif di channel ini.',
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message, reason: err.reason });
  }
});

/**
 * Periksa ketiga API Google yang dipakai aplikasi ini. Berbeda dari /test di
 * atas: yang itu menjawab "adakah siaran aktif", yang ini menjawab "apakah
 * otorisasi dan API-nya masih sehat" — dan membedakan token mati dari API yang
 * belum diaktifkan dari kuota yang habis.
 *
 * Selalu 200: hasil "gagal" adalah jawaban yang sah dari sebuah pemeriksaan,
 * bukan galat HTTP. Yang 4xx/5xx hanya kalau pemeriksaannya sendiri tidak bisa
 * dijalankan.
 */
router.post('/:id/health', async (req, res, next) => {
  const account = accountModel.findById(req.params.id, req.user.id);
  if (!account) return res.status(404).json({ ok: false, error: 'Akun tidak ditemukan' });

  try {
    return res.json(await apiHealth.checkAccount(account));
  } catch (err) {
    log.error('Pemeriksaan API gagal dijalankan', err);
    return next(err);
  }
});

router.post('/:id/quota-limit', (req, res) => {
  const limit = parseInt(req.body.quota_limit, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    req.session.flash = { type: 'error', message: 'Batas kuota harus angka positif.' };
    return res.redirect('/accounts');
  }
  accountModel.setQuotaLimit(req.params.id, req.user.id, limit);
  req.session.flash = { type: 'success', message: 'Batas kuota diperbarui.' };
  res.redirect('/accounts');
});

router.post('/:id/delete', (req, res) => {
  const removed = accountModel.remove(req.params.id, req.user.id);
  req.session.flash = removed
    ? { type: 'success', message: 'Akun diputuskan. Stream yang memakainya tidak bisa lagi merotasi metadata.' }
    : { type: 'error', message: 'Akun tidak ditemukan.' };
  res.redirect('/accounts');
});

module.exports = router;
