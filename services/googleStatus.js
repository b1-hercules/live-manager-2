'use strict';

/**
 * Kesiapan fitur yang bergantung pada Google, dalam bentuk yang bisa langsung
 * dipakai view maupun route.
 *
 * Fitur Google di LiveManager bersifat opsional — menyiarkan ke YouTube,
 * Facebook, dan lainnya sama sekali tidak membutuhkannya. Karena itu tombolnya
 * tidak boleh hilang begitu saja saat belum siap: pengguna jadi tidak tahu
 * fitur itu ada. Tombolnya dinonaktifkan, lalu alasan dan langkah berikutnya
 * ditampilkan apa adanya.
 *
 * Satu sumber kebenaran untuk pesannya: view memakai objek yang sama dengan
 * yang dipakai route saat menolak permintaan, jadi keterangan di layar dan
 * pesan galat tidak pernah berbeda.
 */
const settings = require('../models/settings');
const accountModel = require('../models/account');
const drive = require('./drive');

const READY = { ready: true, reason: '', next: '', href: null, linkLabel: '' };

function blocked(reason, next, href, linkLabel) {
  return { ready: false, reason, next, href, linkLabel };
}

/** Kalimat utuh untuk tooltip dan pesan galat: alasan + langkah berikutnya. */
function message(status) {
  return [status.reason, status.next].filter(Boolean).join(' ');
}

/**
 * Menghubungkan channel YouTube hanya butuh kredensial OAuth; sisanya
 * dikerjakan Google di halaman persetujuan.
 */
function youtubeConnect() {
  if (!settings.hasGoogleCredentials()) {
    return blocked(
      'Kredensial Google OAuth belum diisi.',
      'Buat OAuth Client di Google Cloud, lalu isi Client ID & Secret di Pengaturan.',
      '/settings',
      'Buka Pengaturan'
    );
  }
  return READY;
}

/**
 * Impor dari Drive butuh tiga hal berurutan, dan tiap tahap punya jalan
 * keluarnya sendiri. Akun yang dihubungkan sebelum scope Drive ditambahkan
 * tetap sah untuk rotasi, tapi harus dihubungkan ulang sebelum bisa mengimpor.
 */
function driveImport(userId) {
  const credentials = youtubeConnect();
  if (!credentials.ready) return credentials;

  const accounts = accountModel.listByUser(userId, 'youtube');
  if (!accounts.length) {
    return blocked(
      'Belum ada akun Google yang terhubung.',
      'Hubungkan channel dulu di halaman Akun.',
      '/accounts',
      'Buka Akun'
    );
  }

  if (!accounts.some(drive.hasAccess)) {
    return blocked(
      'Akun Google yang terhubung belum memberi izin baca Drive.',
      'Hubungkan ulang akunnya di halaman Akun supaya izin Drive ikut diminta.',
      '/accounts',
      'Hubungkan ulang'
    );
  }

  return READY;
}

module.exports = { youtubeConnect, driveImport, message };
