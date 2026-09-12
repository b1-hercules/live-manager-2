'use strict';

/**
 * Penanda versi untuk URL /assets.
 *
 * app.js melayani /assets lewat express.static dengan Cache-Control 7 hari di
 * production. Tanpa penanda apa pun di URL-nya, browser yang sudah pernah
 * membuka halaman akan memakai CSS/JS lama sampai seminggu penuh — termasuk
 * setelah image Docker dibangun ulang. Itulah yang membuat perbaikan modal
 * Impor dari Drive (commit ba3f21d) tetap terlihat rusak di browser yang
 * sempat membuka aplikasi sebelum perbaikan itu masuk.
 *
 * Sidik jarinya diambil dari ISI berkas, bukan waktu ubah: rebuild yang tidak
 * menyentuh aset menghasilkan URL yang sama persis, jadi cache yang masih sah
 * tidak ikut dibuang.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Diisi hanya di production; di development sidik jari selalu dihitung ulang. */
const cache = new Map();

function isProd() {
  return (process.env.NODE_ENV || 'development') === 'production';
}

/** Sidik jari 8 hex dari isi berkas, atau null kalau berkasnya tidak ada. */
function fingerprint(relPath) {
  try {
    const buf = fs.readFileSync(path.join(PUBLIC_DIR, relPath));
    return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
  } catch {
    return null;
  }
}

/**
 * URL aset lengkap dengan penanda versi:
 *   assetUrl('/css/app.css') → "/assets/css/app.css?v=1a2b3c4d"
 *
 * Di production dihitung sekali lalu diingat, karena isi berkas tidak berubah
 * selama container hidup. Di development dihitung ulang tiap pemanggilan
 * supaya hasil edit langsung kelihatan tanpa restart.
 *
 * Berkas yang tidak ditemukan tetap menghasilkan URL biasa tanpa `?v=` —
 * halaman lebih baik memuat aset tanpa penanda daripada gagal dirender.
 */
function assetUrl(relPath) {
  const clean = '/' + String(relPath).replace(/^\/+/, '');
  let stamp;
  if (isProd() && cache.has(clean)) {
    stamp = cache.get(clean);
  } else {
    stamp = fingerprint(clean);
    if (isProd()) cache.set(clean, stamp);
  }
  return '/assets' + clean + (stamp ? '?v=' + stamp : '');
}

module.exports = { assetUrl };
