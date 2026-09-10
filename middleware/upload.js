'use strict';

const path = require('path');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const config = require('../config');
const filetype = require('../utils/filetype');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.flv', '.webm', '.m4v', '.ts', '.mpg', '.mpeg']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Nama file di disk selalu UUID — nama asli tidak pernah dipercaya. */
function storageFor(dir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuid()}${ext}`);
    },
  });
}

function extensionFilter(allowed, label) {
  return (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.has(ext)) return cb(null, true);
    const err = new Error(`Format ${label} tidak didukung: ${ext || 'tanpa ekstensi'}`);
    err.status = 400;
    cb(err);
  };
}

const uploadVideo = multer({
  storage: storageFor(config.paths.videos),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: extensionFilter(VIDEO_EXT, 'video'),
});

const uploadThumbnail = multer({
  storage: storageFor(config.paths.thumbnails),
  limits: { fileSize: config.maxThumbBytes, files: 1 },
  fileFilter: extensionFilter(IMAGE_EXT, 'gambar'),
});

/**
 * Beberapa thumbnail sekaligus (dipakai saat menambah banyak varian rotasi).
 * Batasnya 30 file agar satu request tidak menghabiskan disk.
 */
const uploadThumbnails = multer({
  storage: storageFor(config.paths.thumbnails),
  limits: { fileSize: config.maxThumbBytes, files: 30 },
  fileFilter: extensionFilter(IMAGE_EXT, 'gambar'),
});

/**
 * Ekstensi nama file dikendalikan pengunggah, dan fileFilter multer dipanggil
 * sebelum isi file sampai ke disk — jadi signature baru bisa diperiksa di sini,
 * setelah file tertulis. Berkas yang ditolak tidak perlu dihapus manual: error
 * handler global sudah membersihkan unggahan yatim lewat cleanupUploads().
 */
function contentError(filePath, originalName, family, label) {
  let found = null;
  try {
    found = filetype.inspect(filePath);
  } catch (_) {
    // File tidak terbaca — perlakukan sama dengan signature tak dikenal.
  }
  if (found && found.family === family) return null;

  const detail = found ? `isinya terdeteksi sebagai ${found.format}` : 'isinya tidak dikenali';
  const err = new Error(`"${originalName}" bukan file ${label} yang sah — ${detail}.`);
  err.status = 400;
  return err;
}

function verifyContent(family, label) {
  return (req, res, next) => {
    const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : [];
    for (const file of files) {
      const err = contentError(file.path, file.originalname, family, label);
      if (err) return next(err);
    }
    return next();
  };
}

const verifyVideoContent = verifyContent('video', 'video');
const verifyImageContent = verifyContent('image', 'gambar');
const verifyAudioContent = verifyContent('audio', 'audio');

/**
 * Pilih keluarga yang divalidasi dari field `kind` di form.
 *
 * Mempercayai body di sini aman: yang ditentukan field itu hanyalah signature
 * MANA yang harus cocok, dan isi berkaslah yang memutuskan diterima atau tidak.
 * Mengaku 'audio' lalu mengunggah MP4 tetap ditolak.
 */
function verifyMediaContent(req, res, next) {
  const audio = req.body && req.body.kind === 'audio';
  return verifyContent(audio ? 'audio' : 'video', audio ? 'audio' : 'video')(req, res, next);
}

/** Ubah path absolut hasil multer jadi path relatif untuk disimpan di DB. */
function relativePath(absolute) {
  return path.relative(config.root, absolute).split(path.sep).join('/');
}

/** Terjemahkan error multer jadi pesan yang bisa dibaca pengguna. */
function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: `Ukuran file melebihi batas (${Math.round(config.maxUploadBytes / 1024 / 1024)} MB untuk video, ${Math.round(config.maxThumbBytes / 1024 / 1024)} MB untuk gambar).`,
      LIMIT_FILE_COUNT: 'Terlalu banyak file dalam satu unggahan.',
      LIMIT_UNEXPECTED_FILE: 'Field file tidak dikenali.',
    };
    err.status = 400;
    err.message = messages[err.code] || `Gagal mengunggah: ${err.message}`;
  }
  next(err);
}

module.exports = {
  uploadVideo, uploadThumbnail, uploadThumbnails,
  verifyVideoContent, verifyImageContent, verifyAudioContent, verifyMediaContent, contentError,
  relativePath, handleUploadError, VIDEO_EXT, IMAGE_EXT,
};
