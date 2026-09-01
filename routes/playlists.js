'use strict';

const express = require('express');
const playlistModel = require('../models/playlist');
const videoModel = require('../models/video');
const ffmpeg = require('../services/ffmpeg');
const { requireAuth } = require('../middleware/auth');
const { formatBytes, formatDuration } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth);

/** Ambil playlist milik user, atau lempar 404. */
function owned(req) {
  const playlist = playlistModel.findById(req.params.id, req.user.id);
  if (!playlist) {
    const err = new Error('Playlist tidak ditemukan');
    err.status = 404;
    throw err;
  }
  return playlist;
}

router.get('/', (req, res) => {
  res.render('playlists/index', {
    title: 'Playlist',
    playlists: playlistModel.listByUser(req.user.id),
    formatDuration,
  });
});

router.post('/', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    req.session.flash = { type: 'error', message: 'Nama playlist wajib diisi.' };
    return res.redirect('/playlists');
  }
  const playlist = playlistModel.create(req.user.id, { name, description: req.body.description });
  req.session.flash = { type: 'success', message: `Playlist "${playlist.name}" dibuat.` };
  res.redirect(`/playlists/${playlist.id}`);
});

router.get('/:id', (req, res) => {
  const playlist = owned(req);
  const items = playlistModel.listItems(playlist.id);

  // Peringatan ditampilkan untuk kedua mode encode supaya pengguna tahu
  // konsekuensinya sebelum memilih mode di form stream.
  res.render('playlists/detail', {
    title: playlist.name,
    playlist,
    items,
    videos: videoModel.listByUser(req.user.id),
    totalDuration: items.reduce((total, item) => total + (Number(item.duration) || 0), 0),
    copyWarnings: ffmpeg.playlistWarnings({ encode_mode: 'copy' }, items),
    reencodeWarnings: ffmpeg.playlistWarnings({ encode_mode: 'reencode' }, items),
    usedBy: playlistModel.usedByStreams(playlist.id),
    formatBytes,
    formatDuration,
  });
});

router.post('/:id', (req, res) => {
  const playlist = owned(req);
  playlistModel.update(playlist.id, req.user.id, {
    name: req.body.name,
    description: req.body.description,
    shuffle: req.body.shuffle,
  });
  req.session.flash = { type: 'success', message: 'Playlist diperbarui.' };
  res.redirect(`/playlists/${playlist.id}`);
});

router.post('/:id/delete', (req, res) => {
  const playlist = owned(req);
  const inUse = playlistModel.usedByStreams(playlist.id);
  if (inUse.length) {
    req.session.flash = {
      type: 'error',
      message: `Playlist dipakai oleh stream: ${inUse.map((s) => s.title).join(', ')}. Ganti sumber stream itu dulu.`,
    };
    return res.redirect(`/playlists/${playlist.id}`);
  }
  playlistModel.remove(playlist.id, req.user.id);
  req.session.flash = { type: 'success', message: `Playlist "${playlist.name}" dihapus.` };
  res.redirect('/playlists');
});

// -------------------------------------------------------------------- item

router.post('/:id/items', (req, res) => {
  const playlist = owned(req);
  // Video harus milik pengguna yang sama — id dari form tidak dipercaya.
  const video = videoModel.findById(req.body.video_id);
  if (!video || video.user_id !== req.user.id) {
    req.session.flash = { type: 'error', message: 'Video tidak ditemukan.' };
    return res.redirect(`/playlists/${playlist.id}`);
  }
  playlistModel.addItem(playlist.id, video.id);
  req.session.flash = { type: 'success', message: `"${video.title}" ditambahkan ke playlist.` };
  res.redirect(`/playlists/${playlist.id}`);
});

// Rute literal didaftarkan sebelum '/:itemId' — lihat catatan urutan yang sama
// di routes/rotations.js.
router.post('/:id/items/reorder', express.json(), (req, res) => {
  const playlist = owned(req);
  const order = Array.isArray(req.body.order) ? req.body.order.map(Number).filter(Number.isFinite) : [];
  playlistModel.reorderItems(playlist.id, order);
  res.json({ ok: true });
});

router.post('/:id/items/:itemId/delete', (req, res) => {
  const playlist = owned(req);
  playlistModel.removeItem(playlist.id, req.params.itemId);
  req.session.flash = { type: 'success', message: 'Video dikeluarkan dari playlist.' };
  res.redirect(`/playlists/${playlist.id}`);
});

module.exports = router;
