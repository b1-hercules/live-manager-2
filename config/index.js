'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Kunci enkripsi harus 32 byte. Kalau user belum mengisi ENCRYPTION_KEY kita
 * turunkan dari SESSION_SECRET supaya app tetap jalan, tapi kita tandai supaya
 * halaman Settings bisa memperingatkan.
 */
function resolveEncryptionKey() {
  const raw = (process.env.ENCRYPTION_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return { key: Buffer.from(raw, 'hex'), derived: false };
  }
  const seed = raw || process.env.SESSION_SECRET || 'live-manager-insecure-default';
  return { key: crypto.createHash('sha256').update(seed).digest(), derived: true };
}

const encryption = resolveEncryptionKey();

const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',

  port: envInt('PORT', 7575),
  host: process.env.HOST || '0.0.0.0',
  appUrl: (process.env.APP_URL || `http://localhost:${envInt('PORT', 7575)}`).replace(/\/+$/, ''),

  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionSecretIsEphemeral: !process.env.SESSION_SECRET,

  encryptionKey: encryption.key,
  encryptionKeyIsDerived: encryption.derived,

  paths: {
    db: path.join(ROOT, 'db', 'livemanager.db'),
    storage: path.join(ROOT, 'storage'),
    videos: path.join(ROOT, 'storage', 'videos'),
    thumbnails: path.join(ROOT, 'storage', 'thumbnails'),
    tmp: path.join(ROOT, 'storage', 'tmp'),
    logs: path.join(ROOT, 'logs'),
  },

  ffmpegPath: process.env.FFMPEG_PATH || '',
  ffprobePath: process.env.FFPROBE_PATH || '',
  // Dipakai mode radio saja. Kosong berarti "andalkan PATH"; di Windows
  // liquidsoap memang tidak ada, dan itu hanya berarti mode radio tak tersedia
  // di mesin itu — bukan kesalahan yang perlu menghentikan aplikasi.
  liquidsoapPath: process.env.LIQUIDSOAP_PATH || '',

  maxUploadBytes: envInt('MAX_UPLOAD_MB', 4096) * 1024 * 1024,
  maxThumbBytes: envInt('MAX_THUMB_MB', 2) * 1024 * 1024,

  timezone: process.env.TZ || 'Asia/Jakarta',

  // Callback OAuth Google. Harus didaftarkan persis seperti ini di Google Cloud Console.
  googleRedirectPath: '/accounts/youtube/callback',
  get googleRedirectUri() {
    return this.appUrl + this.googleRedirectPath;
  },
};

for (const dir of Object.values(config.paths)) {
  const target = path.extname(dir) ? path.dirname(dir) : dir;
  fs.mkdirSync(target, { recursive: true });
}

module.exports = config;
