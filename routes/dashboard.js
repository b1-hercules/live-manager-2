'use strict';

const express = require('express');
const streamModel = require('../models/stream');
const videoModel = require('../models/video');
const destinationModel = require('../models/destination');
const rotationModel = require('../models/rotation');
const accountModel = require('../models/account');
const settings = require('../models/settings');
const streamManager = require('../services/streamManager');
const system = require('../services/system');
const { requireAuth } = require('../middleware/auth');
const { formatBytes, formatBitrate, humanUptime } = require('../utils/helpers');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const streams = streamModel.listByUser(req.user.id);
  const live = streams
    .filter((s) => s.status === 'live' || s.status === 'starting')
    .map((s) => ({ ...s, runtime: streamManager.runtime(s.id), uptime: humanUptime(s.started_at) }));

  const accounts = accountModel.listByUser(req.user.id, 'youtube').map((a) => ({
    ...a,
    quota: accountModel.getQuota(a.id),
  }));

  // Langkah-langkah yang belum selesai ditampilkan sebagai checklist di dashboard
  // supaya pengguna baru tahu apa yang harus dilakukan berikutnya.
  const checklist = [
    { done: videoModel.countByUser(req.user.id) > 0, label: 'Unggah video sumber', href: '/videos' },
    { done: destinationModel.listByUser(req.user.id).length > 0, label: 'Tambah tujuan RTMP', href: '/destinations' },
    { done: settings.hasGoogleCredentials(), label: 'Isi kredensial Google OAuth', href: '/settings' },
    { done: accounts.length > 0, label: 'Hubungkan channel YouTube', href: '/accounts' },
    { done: rotationModel.listProfiles(req.user.id).length > 0, label: 'Buat profil rotasi', href: '/rotations' },
    { done: streams.length > 0, label: 'Buat stream pertama', href: '/streams/new' },
  ];

  res.render('dashboard', {
    title: 'Dashboard',
    stats: streamModel.stats(req.user.id),
    live,
    scheduled: streams.filter((s) => s.status === 'scheduled'),
    recentStreams: streams.slice(0, 6),
    videoCount: videoModel.countByUser(req.user.id),
    storageUsed: videoModel.totalSize(req.user.id),
    destinationCount: destinationModel.listByUser(req.user.id).length,
    profileCount: rotationModel.listProfiles(req.user.id).length,
    accounts,
    rotationLogs: rotationModel.listLogs({ userId: req.user.id, limit: 12 }),
    system: system.snapshot(),
    egress: streamManager.egress(),
    ffmpegStatus: req.app.locals.ffmpegStatus || { ok: false, error: 'Belum diperiksa' },
    checklist,
    checklistDone: checklist.filter((c) => c.done).length,
    platforms: destinationModel.PLATFORMS,
    formatBytes,
    formatBitrate,
  });
});

/** Halaman gabungan seluruh riwayat rotasi lintas stream. */
router.get('/rotation-history', requireAuth, (req, res) => {
  res.render('rotations/history', {
    title: 'Riwayat Rotasi',
    logs: rotationModel.listLogs({ userId: req.user.id, limit: 300 }),
  });
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    activeStreams: streamManager.activeCount(),
    ffmpeg: req.app.locals.ffmpegStatus?.ok ?? null,
    version: require('../package.json').version,
  });
});

module.exports = router;
