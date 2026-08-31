'use strict';

const express = require('express');
const streamModel = require('../models/stream');
const rotationModel = require('../models/rotation');
const accountModel = require('../models/account');
const streamManager = require('../services/streamManager');
const rotationEngine = require('../services/rotationEngine');
const system = require('../services/system');
const { requireAuth } = require('../middleware/auth');
const { humanUptime } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth);

/** Ringkasan untuk polling dashboard. */
router.get('/overview', (req, res) => {
  const streams = streamModel.listByUser(req.user.id);
  res.json({
    ok: true,
    stats: streamModel.stats(req.user.id),
    system: system.snapshot(),
    streams: streams.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      uptime: humanUptime(s.started_at),
      rotationEnabled: s.rotation_enabled,
      runtime: streamManager.runtime(s.id),
    })),
    accounts: accountModel.listByUser(req.user.id, 'youtube').map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      quota: accountModel.getQuota(a.id),
    })),
  });
});

/** Detail satu stream untuk panel live di halaman detail. */
router.get('/streams/:id', (req, res) => {
  const stream = streamModel.findById(req.params.id, req.user.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'Stream tidak ditemukan' });

  const state = rotationModel.getState(stream.id);
  res.json({
    ok: true,
    stream: {
      id: stream.id,
      status: stream.status,
      uptime: humanUptime(stream.started_at),
      errorMessage: stream.error_message,
      restartCount: stream.restart_count,
      rotationEnabled: stream.rotation_enabled,
      resolvedVideoId: stream.resolved_video_id,
    },
    runtime: streamManager.runtime(stream.id),
    ffmpegLogs: streamManager.recentLogs(stream.id, 40),
    logs: streamModel.listLogs(stream.id, 40),
    rotation: {
      nextRunAt: state?.next_run_at || null,
      lastAppliedAt: state?.last_applied_at || null,
      fieldState: state?.fieldState || {},
      logs: rotationModel.listLogs({ streamId: stream.id, limit: 15 }),
    },
    quota: stream.youtube_account_id ? accountModel.getQuota(stream.youtube_account_id) : null,
  });
});

/** Pratinjau varian berikutnya tanpa memanggil YouTube API. */
router.get('/streams/:id/rotation/preview', (req, res) => {
  const stream = streamModel.findById(req.params.id, req.user.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'Stream tidak ditemukan' });
  res.json({ ok: true, preview: rotationEngine.preview(stream.id) });
});

router.get('/system', (req, res) => {
  res.json({ ok: true, system: system.snapshot(), activeStreams: streamManager.activeCount() });
});

module.exports = router;
