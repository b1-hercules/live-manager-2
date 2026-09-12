'use strict';

const express = require('express');
const streamModel = require('../models/stream');
const videoModel = require('../models/video');
const playlistModel = require('../models/playlist');
const destinationModel = require('../models/destination');
const rotationModel = require('../models/rotation');
const accountModel = require('../models/account');
const backgroundModel = require('../models/streamBackground');
const streamManager = require('../services/streamManager');
const rotationEngine = require('../services/rotationEngine');
const ffmpeg = require('../services/ffmpeg');
const youtube = require('../services/youtube');
const { uploadThumbnails, verifyImageContent, handleUploadError, relativePath } = require('../middleware/upload');
const csrf = require('../middleware/csrf');
const { requireAuth } = require('../middleware/auth');
const { localInputToIso, isoToLocalInput, formatDuration, humanUptime, maskKey } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth);

function ownedStream(req) {
  const stream = streamModel.findById(req.params.id, req.user.id);
  if (!stream) {
    const err = new Error('Stream tidak ditemukan');
    err.status = 404;
    throw err;
  }
  return stream;
}

/** Data yang dibutuhkan form create/edit. */
function formContext(req) {
  return {
    videos: videoModel.listByUser(req.user.id),
    // Dipisah per jenis: playlist musik tidak boleh muncul sebagai sumber
    // siaran video, dan sebaliknya.
    playlists: playlistModel.listByUser(req.user.id, { kind: 'video' }),
    audioPlaylists: playlistModel.listByUser(req.user.id, { kind: 'audio' }),
    destinations: destinationModel.listByUser(req.user.id),
    profiles: rotationModel.listProfiles(req.user.id),
    accounts: accountModel.listByUser(req.user.id, 'youtube'),
    resolutions: streamModel.RESOLUTIONS,
    platforms: destinationModel.PLATFORMS,
    isoToLocalInput,
    maskKey,
  };
}

/** Ubah field jadwal dari waktu lokal browser menjadi ISO UTC. */
function withSchedule(body) {
  return {
    ...body,
    schedule_start_at: body.enable_schedule ? localInputToIso(body.schedule_start_at) : null,
    schedule_end_at: body.enable_schedule ? localInputToIso(body.schedule_end_at) : null,
    duration_minutes: body.enable_duration ? body.duration_minutes : null,
  };
}

// ----------------------------------------------------------------- daftar

router.get('/', (req, res) => {
  const streams = streamModel.listByUser(req.user.id).map((s) => ({
    ...s,
    runtime: streamManager.runtime(s.id),
    uptime: humanUptime(s.started_at),
  }));

  res.render('streams/index', {
    title: 'Stream',
    streams,
    platforms: destinationModel.PLATFORMS,
    formatDuration,
  });
});

router.get('/new', (req, res) => {
  res.render('streams/form', {
    title: 'Stream Baru',
    stream: null,
    selectedDestinations: [],
    ...formContext(req),
  });
});

router.post('/', (req, res) => {
  const destinationIds = [].concat(req.body.destination_ids || []).filter(Boolean);

  if (!req.body.video_id && !req.body.playlist_id) {
    req.session.flash = { type: 'error', message: 'Pilih video atau playlist sebagai sumber siaran.' };
    return res.redirect('/streams/new');
  }
  if (!destinationIds.length) {
    req.session.flash = { type: 'error', message: 'Pilih minimal satu tujuan streaming.' };
    return res.redirect('/streams/new');
  }

  const stream = streamModel.create(req.user.id, withSchedule(req.body), destinationIds);
  // Setelan spektrum lewat pintunya sendiri; lihat catatan di
  // models/stream.js updateRadioSettings().
  streamModel.updateRadioSettings(stream.id, req.user.id, req.body);
  req.session.flash = {
    type: 'success',
    message: stream.status === 'scheduled'
      ? `Stream "${stream.title}" dijadwalkan.`
      : `Stream "${stream.title}" dibuat. Klik Mulai untuk siaran.`,
  };
  res.redirect(`/streams/${stream.id}`);
});

/**
 * Peringatan khusus siaran radio. Mengembalikan null kalau bukan radio, supaya
 * pemanggil bisa jatuh ke peringatan playlist/video yang sudah ada.
 *
 * Yang diperiksa adalah dua hal yang membuat siaran GAGAL DIMULAI, bukan sekadar
 * kurang rapi — jadi lebih baik terlihat di halaman detail daripada muncul
 * sebagai pesan error setelah tombol Mulai ditekan.
 */
function radioWarnings(isRadio, items, backgrounds, liquidsoapStatus) {
  if (!isRadio) return null;
  const warnings = [];
  // Tanpa liquidsoap siaran radio gagal saat start, bukan saat disimpan. Lebih
  // baik dikatakan di sini daripada dibiarkan jadi status error setelah nunggu.
  if (liquidsoapStatus && !liquidsoapStatus.ok) {
    warnings.push(`Liquidsoap belum terpasang di server (${liquidsoapStatus.error}). Siaran radio tidak akan bisa dimulai — pasang liquidsoap atau isi LIQUIDSOAP_PATH di .env.`);
  }
  if (!items.length) warnings.push('Playlist musiknya belum berisi lagu.');
  if (!backgrounds.length) warnings.push('Siaran radio wajib punya minimal satu gambar latar. Unggah di bawah.');
  return warnings;
}

// ----------------------------------------------------------------- detail

router.get('/:id', (req, res) => {
  const stream = ownedStream(req);
  const video = stream.video_id ? videoModel.findById(stream.video_id) : null;
  const playlistItems = stream.playlist_id ? playlistModel.listItems(stream.playlist_id) : [];
  const destinations = destinationModel.listForStream(stream.id);
  const sourcePlaylist = stream.playlist_id ? playlistModel.findById(stream.playlist_id) : null;
  const isRadio = Boolean(sourcePlaylist && sourcePlaylist.kind === 'audio');
  const backgrounds = isRadio ? backgroundModel.listByStream(stream.id) : [];

  let commandPreview = null;
  try {
    commandPreview = streamManager.commandPreview(stream.id);
  } catch (err) {
    commandPreview = `Tidak bisa menyusun perintah: ${err.message}`;
  }

  res.render('streams/detail', {
    title: stream.title,
    stream,
    video,
    destinations,
    platforms: destinationModel.PLATFORMS,
    runtime: streamManager.runtime(stream.id),
    logs: streamModel.listLogs(stream.id, 100),
    sessions: streamModel.listSessions(stream.id, 10),
    rotationPreview: rotationEngine.preview(stream.id),
    rotationLogs: rotationModel.listLogs({ streamId: stream.id, limit: 30 }),
    rotationState: rotationModel.getState(stream.id),
    account: stream.youtube_account_id ? accountModel.findById(stream.youtube_account_id) : null,
    quota: stream.youtube_account_id ? accountModel.getQuota(stream.youtube_account_id) : null,
    playlistItems,
    isRadio,
    backgrounds,
    warnings: radioWarnings(isRadio, playlistItems, backgrounds, req.app.locals.liquidsoapStatus)
      || (stream.playlist_id
        ? ffmpeg.playlistWarnings(stream, playlistItems)
        : (video ? ffmpeg.compatibilityWarnings(stream, video) : ['Stream ini belum punya video sumber.'])),
    commandPreview,
    uptime: humanUptime(stream.started_at),
    formatDuration,
    maskKey,
  });
});

router.get('/:id/edit', (req, res) => {
  const stream = ownedStream(req);
  res.render('streams/form', {
    title: `Ubah — ${stream.title}`,
    stream,
    selectedDestinations: streamModel.destinationIds(stream.id),
    ...formContext(req),
  });
});

router.post('/:id', (req, res) => {
  const stream = ownedStream(req);
  const destinationIds = [].concat(req.body.destination_ids || []).filter(Boolean);

  if (!destinationIds.length) {
    req.session.flash = { type: 'error', message: 'Pilih minimal satu tujuan streaming.' };
    return res.redirect(`/streams/${stream.id}/edit`);
  }

  streamModel.update(stream.id, req.user.id, withSchedule(req.body), destinationIds);
  streamModel.updateRadioSettings(stream.id, req.user.id, req.body);

  req.session.flash = {
    type: 'success',
    message: stream.isActive
      ? 'Pengaturan disimpan. Perubahan encoding baru berlaku setelah stream direstart.'
      : 'Pengaturan stream disimpan.',
  };
  res.redirect(`/streams/${stream.id}`);
});

// --------------------------------------------------- gambar latar (radio)

/**
 * Unggah gambar latar. Rute literal didaftarkan sebelum '/:bgId' — pola urutan
 * yang sama seperti di routes/rotations.js dan routes/playlists.js.
 *
 * csrf.verify WAJIB setelah multer: body multipart baru terurai di sana.
 */
router.post('/:id/backgrounds',
  uploadThumbnails.array('backgrounds', 30), handleUploadError, csrf.verify, verifyImageContent,
  (req, res) => {
    const stream = ownedStream(req);
    const files = req.files || [];
    if (!files.length) {
      req.session.flash = { type: 'error', message: 'Tidak ada gambar yang diunggah.' };
      return res.redirect(`/streams/${stream.id}`);
    }

    for (const file of files) backgroundModel.add(stream.id, relativePath(file.path));

    req.session.flash = {
      type: 'success',
      message: `${files.length} gambar latar ditambahkan.${stream.isActive ? ' Berlaku setelah siaran direstart.' : ''}`,
    };
    res.redirect(`/streams/${stream.id}`);
  });

router.post('/:id/backgrounds/reorder', express.json(), (req, res) => {
  const stream = ownedStream(req);
  const order = Array.isArray(req.body.order) ? req.body.order.map(Number).filter(Number.isFinite) : [];
  backgroundModel.reorder(stream.id, order);
  res.json({ ok: true });
});

router.post('/:id/backgrounds/:bgId/delete', (req, res) => {
  const stream = ownedStream(req);
  const removed = backgroundModel.remove(Number(req.params.bgId), stream.id);
  req.session.flash = removed
    ? { type: 'success', message: 'Gambar latar dihapus.' }
    : { type: 'error', message: 'Gambar latar tidak ditemukan.' };
  res.redirect(`/streams/${stream.id}`);
});

router.post('/:id/delete', (req, res) => {
  const stream = ownedStream(req);
  if (stream.isActive) streamManager.stop(stream.id, 'stream dihapus');
  streamModel.remove(stream.id, req.user.id);
  req.session.flash = { type: 'success', message: `Stream "${stream.title}" dihapus.` };
  res.redirect('/streams');
});

// ---------------------------------------------------------------- kontrol

router.post('/:id/start', async (req, res) => {
  const stream = ownedStream(req);
  const result = await streamManager.start(stream.id);
  req.session.flash = result.ok
    ? { type: 'success', message: 'Siaran dimulai.' }
    : { type: 'error', message: result.error };
  res.redirect(`/streams/${stream.id}`);
});

router.post('/:id/stop', (req, res) => {
  const stream = ownedStream(req);
  const result = streamManager.stop(stream.id, 'dihentikan manual');
  req.session.flash = result.ok
    ? { type: 'success', message: result.note || 'Siaran dihentikan.' }
    : { type: 'error', message: result.error };
  res.redirect(`/streams/${stream.id}`);
});

router.post('/:id/restart', async (req, res) => {
  const stream = ownedStream(req);
  const result = await streamManager.restart(stream.id);
  req.session.flash = result.ok
    ? { type: 'success', message: 'Siaran direstart.' }
    : { type: 'error', message: result.error };
  res.redirect(`/streams/${stream.id}`);
});

// ---------------------------------------------------------------- rotasi

router.post('/:id/rotation/toggle', (req, res) => {
  const stream = ownedStream(req);
  if (!stream.rotation_profile_id) {
    req.session.flash = { type: 'error', message: 'Pilih profil rotasi dulu di halaman Ubah.' };
    return res.redirect(`/streams/${stream.id}`);
  }
  if (!stream.youtube_account_id) {
    req.session.flash = { type: 'error', message: 'Hubungkan akun YouTube dulu di halaman Ubah.' };
    return res.redirect(`/streams/${stream.id}`);
  }

  const next = stream.rotation_enabled ? 0 : 1;
  streamModel.setStatus(stream.id, stream.status, { rotation_enabled: next });
  if (next && stream.status === 'live') {
    rotationEngine.onStreamStart(stream.id).catch(() => {});
  }

  req.session.flash = { type: 'success', message: next ? 'Rotasi diaktifkan.' : 'Rotasi dimatikan.' };
  res.redirect(`/streams/${stream.id}`);
});

router.post('/:id/rotation/now', async (req, res) => {
  const stream = ownedStream(req);
  try {
    const result = await rotationEngine.rotateNow(stream.id);
    if (result.error) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    if (result.skipped) {
      return res.json({ ok: true, skipped: result.skipped, message: result.skipped });
    }
    return res.json({
      ok: true,
      message: `Diterapkan: ${Object.keys(result.applied || {}).join(', ') || 'tidak ada perubahan'}`,
      applied: result.applied,
      quotaUsed: result.quotaUsed,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/:id/rotation/reset', (req, res) => {
  const stream = ownedStream(req);
  rotationModel.resetState(stream.id);
  req.session.flash = { type: 'success', message: 'Urutan rotasi dikembalikan ke awal.' };
  res.redirect(`/streams/${stream.id}`);
});

/** Paksa deteksi ulang broadcast YouTube yang aktif. */
router.post('/:id/rotation/detect', async (req, res) => {
  const stream = ownedStream(req);
  const account = stream.youtube_account_id ? accountModel.findById(stream.youtube_account_id, req.user.id) : null;
  if (!account) return res.status(400).json({ ok: false, error: 'Stream ini belum terhubung ke akun YouTube' });

  try {
    const broadcast = await youtube.detectActiveBroadcast(account);
    if (!broadcast) {
      return res.json({ ok: true, found: false, message: 'Belum ada siaran aktif di channel ini.' });
    }
    streamModel.setResolvedVideo(stream.id, broadcast.videoId);
    return res.json({
      ok: true,
      found: true,
      videoId: broadcast.videoId,
      broadcastTitle: broadcast.title,
      status: broadcast.status,
      message: `Terdeteksi: ${broadcast.videoId}`,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
// Diekspor hanya untuk diuji langsung: peringatan radio adalah satu-satunya
// tempat ketiadaan liquidsoap sampai ke pengguna sebelum tombol Mulai ditekan.
module.exports.radioWarnings = radioWarnings;
