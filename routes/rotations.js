'use strict';

const express = require('express');
const rotationModel = require('../models/rotation');
const streamModel = require('../models/stream');
const accountModel = require('../models/account');
const template = require('../services/template');
const { requireAuth } = require('../middleware/auth');
const { uploadThumbnail, uploadThumbnails, verifyImageContent, relativePath, handleUploadError } = require('../middleware/upload');
const csrf = require('../middleware/csrf');
const { parseTags } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth);

/** Ambil profil milik user, atau lempar 404. */
function ownedProfile(req) {
  const profile = rotationModel.findProfile(req.params.id, req.user.id);
  if (!profile) {
    const err = new Error('Profil rotasi tidak ditemukan');
    err.status = 404;
    throw err;
  }
  return profile;
}

// ---------------------------------------------------------------- daftar

router.get('/', (req, res) => {
  res.render('rotations/index', {
    title: 'Profil Rotasi',
    profiles: rotationModel.listProfiles(req.user.id),
  });
});

router.post('/', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    req.session.flash = { type: 'error', message: 'Nama profil wajib diisi.' };
    return res.redirect('/rotations');
  }

  const profile = rotationModel.createProfile({
    user_id: req.user.id,
    name,
    description: req.body.description,
    mode: req.body.mode,
    interval_minutes: req.body.interval_minutes,
    order_mode: req.body.order_mode,
    // Profil baru mengaktifkan semua field; pengguna bisa mematikan sebagian nanti.
    apply_title: 1, apply_description: 1, apply_tags: 1, apply_thumbnail: 1,
    // Default aman: hentikan rotasi sebelum kuota habis. Tanpa ini profil baru
    // akan terus memanggil API sampai ditolak dan membanjiri log dengan error.
    stop_on_quota: 1,
    active: 1,
  });

  req.session.flash = { type: 'success', message: `Profil "${profile.name}" dibuat. Tambahkan varian sekarang.` };
  res.redirect(`/rotations/${profile.id}`);
});

// ------------------------------------------------------------- detail

router.get('/:id', (req, res) => {
  const profile = ownedProfile(req);
  const items = rotationModel.listItems(profile.id);
  const fields = rotationModel.listFields(profile.id).map((f) => ({
    ...f,
    values: rotationModel.listFieldValues(f.id),
  }));

  // Perkiraan biaya kuota agar pengguna tahu konsekuensi intervalnya.
  const costPerRotation = accountModel.estimateRotationCost({
    title: profile.apply_title, description: profile.apply_description,
    tags: profile.apply_tags, thumbnail: profile.apply_thumbnail,
  });
  const rotationsPerDay = profile.mode === 'bundle'
    ? Math.floor((24 * 60) / profile.interval_minutes)
    : fields.filter((f) => f.enabled).reduce((sum, f) => sum + Math.floor((24 * 60) / f.interval_minutes), 0);

  res.render('rotations/detail', {
    title: profile.name,
    profile,
    items,
    fields,
    stats: rotationModel.itemStats(profile.id),
    placeholders: template.PLACEHOLDERS,
    streams: streamModel.listByUser(req.user.id).filter((s) => s.rotation_profile_id === profile.id),
    quota: {
      costPerRotation,
      rotationsPerDay,
      dailyCost: costPerRotation * rotationsPerDay,
      limit: 10000,
    },
  });
});

router.post('/:id', (req, res) => {
  const profile = ownedProfile(req);
  rotationModel.updateProfile(profile.id, req.user.id, req.body);
  req.session.flash = { type: 'success', message: 'Pengaturan profil disimpan.' };
  res.redirect(`/rotations/${profile.id}`);
});

router.post('/:id/delete', (req, res) => {
  const profile = ownedProfile(req);
  rotationModel.removeProfile(profile.id, req.user.id);
  req.session.flash = { type: 'success', message: `Profil "${profile.name}" dihapus.` };
  res.redirect('/rotations');
});

// -------------------------------------------------------- varian (bundle)

router.post('/:id/items', uploadThumbnail.single('thumbnail'), handleUploadError, csrf.verify, verifyImageContent, (req, res) => {
  const profile = ownedProfile(req);
  const item = rotationModel.createItem(profile.id, {
    label: req.body.label,
    title: req.body.title,
    description: req.body.description,
    tags: req.body.tags,
    thumbnail_path: req.file ? relativePath(req.file.path) : null,
    weight: req.body.weight,
    active: 1,
  });

  req.session.flash = { type: 'success', message: `Varian "${item.label || item.title || 'baru'}" ditambahkan.` };
  res.redirect(`/rotations/${profile.id}`);
});

// PENTING: rute literal di bawah ini harus terdaftar SEBELUM '/:id/items/:itemId'.
// Express mencocokkan berdasarkan urutan, jadi '/1/items/bulk' akan tertangkap
// oleh rute :itemId (dengan itemId = "bulk") kalau urutannya terbalik.
router.post('/:id/items/reorder', express.json(), (req, res) => {
  const profile = ownedProfile(req);
  const order = Array.isArray(req.body.order) ? req.body.order.map(Number).filter(Number.isFinite) : [];
  rotationModel.reorderItems(profile.id, order);
  res.json({ ok: true });
});


/**
 * Tambah banyak varian sekaligus dari teks (satu judul per baris).
 * Mempercepat pembuatan 20-30 varian A/B test.
 */
router.post('/:id/items/bulk', (req, res) => {
  const profile = ownedProfile(req);
  const lines = String(req.body.titles || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);

  if (!lines.length) {
    req.session.flash = { type: 'error', message: 'Tidak ada judul yang bisa ditambahkan.' };
    return res.redirect(`/rotations/${profile.id}`);
  }

  const sharedDescription = req.body.shared_description || null;
  const sharedTags = req.body.shared_tags ? parseTags(req.body.shared_tags) : [];

  for (const title of lines) {
    rotationModel.createItem(profile.id, {
      title,
      description: sharedDescription,
      tags: sharedTags,
      weight: 1,
      active: 1,
    });
  }

  req.session.flash = { type: 'success', message: `${lines.length} varian ditambahkan.` };
  res.redirect(`/rotations/${profile.id}`);
});


/** Unggah banyak thumbnail sekaligus, masing-masing jadi satu varian baru. */
router.post('/:id/items/bulk-thumbnails', uploadThumbnails.array('thumbnails', 30), handleUploadError, csrf.verify, verifyImageContent, (req, res) => {
  const profile = ownedProfile(req);
  const files = req.files || [];
  if (!files.length) {
    req.session.flash = { type: 'error', message: 'Tidak ada gambar yang diunggah.' };
    return res.redirect(`/rotations/${profile.id}`);
  }

  for (const file of files) {
    rotationModel.createItem(profile.id, {
      label: file.originalname.replace(/\.[^.]+$/, '').slice(0, 80),
      thumbnail_path: relativePath(file.path),
      weight: 1,
      active: 1,
    });
  }

  req.session.flash = {
    type: 'success',
    message: `${files.length} varian thumbnail ditambahkan. Lengkapi judul/deskripsinya bila perlu.`,
  };
  res.redirect(`/rotations/${profile.id}`);
});

router.post('/:id/items/:itemId', uploadThumbnail.single('thumbnail'), handleUploadError, csrf.verify, verifyImageContent, (req, res) => {
  const profile = ownedProfile(req);
  const existing = rotationModel.findItem(req.params.itemId);
  if (!existing || existing.profile_id !== profile.id) {
    req.session.flash = { type: 'error', message: 'Varian tidak ditemukan.' };
    return res.redirect(`/rotations/${profile.id}`);
  }

  rotationModel.updateItem(existing.id, {
    label: req.body.label,
    title: req.body.title,
    description: req.body.description,
    tags: req.body.tags,
    thumbnail_path: req.file ? relativePath(req.file.path) : null,
    weight: req.body.weight,
    active: req.body.active ? 1 : 0,
  });

  req.session.flash = { type: 'success', message: 'Varian diperbarui.' };
  res.redirect(`/rotations/${profile.id}`);
});

router.post('/:id/items/:itemId/toggle', (req, res) => {
  const profile = ownedProfile(req);
  const item = rotationModel.findItem(req.params.itemId);
  if (item && item.profile_id === profile.id) rotationModel.toggleItem(item.id);
  res.redirect(`/rotations/${profile.id}`);
});

router.post('/:id/items/:itemId/thumbnail/clear', (req, res) => {
  const profile = ownedProfile(req);
  const item = rotationModel.findItem(req.params.itemId);
  if (item && item.profile_id === profile.id) rotationModel.clearItemThumbnail(item.id);
  req.session.flash = { type: 'success', message: 'Thumbnail varian dihapus.' };
  res.redirect(`/rotations/${profile.id}`);
});

router.post('/:id/items/:itemId/delete', (req, res) => {
  const profile = ownedProfile(req);
  const item = rotationModel.findItem(req.params.itemId);
  if (item && item.profile_id === profile.id) rotationModel.removeItem(item.id);
  req.session.flash = { type: 'success', message: 'Varian dihapus.' };
  res.redirect(`/rotations/${profile.id}`);
});


// -------------------------------------------------- field (independent)

router.post('/:id/fields/:field', (req, res) => {
  const profile = ownedProfile(req);
  if (!rotationModel.FIELDS.includes(req.params.field)) {
    req.session.flash = { type: 'error', message: 'Field tidak dikenal.' };
    return res.redirect(`/rotations/${profile.id}`);
  }

  rotationModel.updateField(profile.id, req.params.field, {
    enabled: req.body.enabled ? 1 : 0,
    interval_minutes: req.body.interval_minutes,
    order_mode: req.body.order_mode,
  });

  req.session.flash = { type: 'success', message: `Pengaturan field ${rotationModel.FIELD_LABELS[req.params.field]} disimpan.` };
  res.redirect(`/rotations/${profile.id}#independent`);
});

router.post('/:id/fields/:field/values', uploadThumbnails.array('thumbnails', 30), handleUploadError, csrf.verify, verifyImageContent, (req, res) => {
  const profile = ownedProfile(req);
  const field = rotationModel.findField(profile.id, req.params.field);
  if (!field) {
    req.session.flash = { type: 'error', message: 'Field tidak dikenal.' };
    return res.redirect(`/rotations/${profile.id}`);
  }

  let added = 0;

  if (field.field === 'thumbnail') {
    for (const file of req.files || []) {
      rotationModel.createFieldValue(field.id, {
        value: file.originalname.replace(/\.[^.]+$/, '').slice(0, 80),
        thumbnail_path: relativePath(file.path),
      });
      added++;
    }
  } else {
    // Deskripsi bisa multi-baris, jadi hanya judul & tags yang dipecah per baris.
    const raw = String(req.body.values || '').trim();
    const chunks = field.field === 'description'
      ? raw.split(/\n\s*---\s*\n/)
      : raw.split('\n');

    for (const chunk of chunks.map((s) => s.trim()).filter(Boolean).slice(0, 100)) {
      rotationModel.createFieldValue(field.id, { value: chunk });
      added++;
    }
  }

  req.session.flash = added
    ? { type: 'success', message: `${added} nilai ditambahkan ke ${field.label}.` }
    : { type: 'error', message: 'Tidak ada nilai yang bisa ditambahkan.' };
  res.redirect(`/rotations/${profile.id}#independent`);
});

router.post('/:id/values/:valueId/toggle', (req, res) => {
  const profile = ownedProfile(req);
  const value = rotationModel.findFieldValue(req.params.valueId);
  if (value && rotationModel.findFieldById(value.field_id)?.profile_id === profile.id) {
    rotationModel.toggleFieldValue(value.id);
  }
  res.redirect(`/rotations/${profile.id}#independent`);
});

router.post('/:id/values/:valueId/delete', (req, res) => {
  const profile = ownedProfile(req);
  const value = rotationModel.findFieldValue(req.params.valueId);
  if (value && rotationModel.findFieldById(value.field_id)?.profile_id === profile.id) {
    rotationModel.removeFieldValue(value.id);
  }
  req.session.flash = { type: 'success', message: 'Nilai dihapus.' };
  res.redirect(`/rotations/${profile.id}#independent`);
});

// -------------------------------------------------------------- riwayat

router.get('/:id/logs', (req, res) => {
  const profile = ownedProfile(req);
  res.render('rotations/logs', {
    title: `Riwayat — ${profile.name}`,
    profile,
    logs: rotationModel.listLogs({ userId: req.user.id, limit: 200 })
      .filter((l) => l.profile_id === profile.id),
  });
});

module.exports = router;
