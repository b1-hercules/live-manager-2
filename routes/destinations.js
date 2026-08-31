'use strict';

const express = require('express');
const destinationModel = require('../models/destination');
const accountModel = require('../models/account');
const { requireAuth } = require('../middleware/auth');
const { maskKey } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.render('destinations/index', {
    title: 'Tujuan Streaming',
    destinations: destinationModel.listByUser(req.user.id),
    platforms: destinationModel.PLATFORMS,
    accounts: accountModel.listByUser(req.user.id, 'youtube'),
    maskKey,
  });
});

router.post('/', (req, res) => {
  const { name, platform, rtmp_url, stream_key, account_id, active } = req.body;

  if (!name?.trim() || !rtmp_url?.trim() || !stream_key?.trim()) {
    req.session.flash = { type: 'error', message: 'Nama, URL RTMP, dan Stream Key wajib diisi.' };
    return res.redirect('/destinations');
  }
  if (!/^rtmps?:\/\//i.test(rtmp_url.trim())) {
    req.session.flash = { type: 'error', message: 'URL harus diawali rtmp:// atau rtmps://' };
    return res.redirect('/destinations');
  }

  destinationModel.create({
    user_id: req.user.id,
    name: name.trim().slice(0, 100),
    platform: destinationModel.PLATFORMS[platform] ? platform : 'custom',
    rtmp_url: rtmp_url.trim(),
    stream_key: stream_key.trim(),
    account_id: account_id || null,
    active: active === undefined ? 1 : (active ? 1 : 0),
  });

  req.session.flash = { type: 'success', message: `Tujuan "${name.trim()}" ditambahkan.` };
  res.redirect('/destinations');
});

router.post('/:id', (req, res) => {
  const { name, platform, rtmp_url, stream_key, account_id, active } = req.body;
  const updated = destinationModel.update(req.params.id, req.user.id, {
    name: (name || '').trim().slice(0, 100),
    platform: destinationModel.PLATFORMS[platform] ? platform : 'custom',
    rtmp_url: (rtmp_url || '').trim(),
    // Kosong berarti "pertahankan key lama".
    stream_key: stream_key || '',
    account_id: account_id || null,
    active: active ? 1 : 0,
  });

  req.session.flash = updated
    ? { type: 'success', message: 'Tujuan diperbarui.' }
    : { type: 'error', message: 'Tujuan tidak ditemukan.' };
  res.redirect('/destinations');
});

router.post('/:id/delete', (req, res) => {
  const removed = destinationModel.remove(req.params.id, req.user.id);
  req.session.flash = removed
    ? { type: 'success', message: 'Tujuan dihapus.' }
    : { type: 'error', message: 'Tujuan tidak ditemukan.' };
  res.redirect('/destinations');
});

module.exports = router;
