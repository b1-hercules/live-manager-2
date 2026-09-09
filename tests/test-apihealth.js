'use strict';

// Uji services/apiHealth.js + klasifikasi galat di services/youtube.js.
//
// Tes murni: tidak ada server, tidak ada jaringan, tidak menyentuh database
// kerja. Panggilan Google dipalsukan lewat objek galat yang bentuknya sama
// dengan yang dikembalikan googleapis, karena yang diuji di sini adalah
// PENAFSIRAN jawaban Google — bukan Google-nya.

const { google } = require('googleapis');

const youtube = require('../services/youtube');
const apiHealth = require('../services/apiHealth');
const drive = require('../services/drive');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

/** Galat googleapis tiruan: yang dibaca wrapError hanyalah bentuk ini. */
function apiError(status, reason, message) {
  const err = new Error(message);
  err.response = { status, data: { error: { message, errors: [{ reason }] } } };
  return err;
}

const account = {
  id: 4242,
  name: 'Channel Uji',
  refresh_token: 'refresh-palsu',
  access_token: 'access-palsu',
  scopes: 'https://www.googleapis.com/auth/youtube.force-ssl',
};

// ---- regresi: klien auth Drive ----------------------------------------
//
// Bug yang pernah ada: drive.js mengoper objek layanan YouTube sebagai `auth`.
// googleapis menerimanya tanpa protes saat dibangun, jadi kegagalannya baru
// muncul di panggilan pertama sebagai "authClient.request is not a function" —
// dan itu berarti SELURUH impor Drive mati tanpa satu pun tes yang berbunyi.
// Dua pemeriksaan di bawah inilah yang seharusnya berbunyi waktu itu.

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'uji-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'uji-client-secret';

const authClient = youtube.authClientForAccount(account);
check('authClientForAccount mengembalikan klien OAuth2',
  authClient instanceof google.auth.OAuth2, true);
check('klien auth punya .request() — syarat googleapis',
  typeof authClient.request, 'function');

// Penjagaan langsung atas bug-nya: yang terpasang sebagai `auth` di klien
// Drive harus klien OAuth. Kalau seseorang mengembalikannya ke
// clientForAccount(), pemeriksaan ini gagal seketika — tanpa jaringan.
const driveAuth = drive.clientFor(account).context._options.auth;
check('klien Drive memakai klien OAuth sebagai auth',
  driveAuth instanceof google.auth.OAuth2, true);
check('auth klien Drive punya .request()',
  typeof driveAuth.request, 'function');

// clientForAccount tetap mengembalikan objek layanan seperti sebelumnya:
// pemanggil lama (rotationEngine, routes) tidak boleh ikut berubah.
const service = youtube.clientForAccount(account);
check('clientForAccount tetap objek layanan YouTube',
  typeof service.channels && typeof service.channels.list, 'function');
check('objek layanan BUKAN klien auth — tidak boleh dioper sebagai auth',
  service instanceof google.auth.OAuth2, false);

// ---- klasifikasi galat -------------------------------------------------

check('kuota habis -> ditandai quota, bukan fatal',
  youtube.wrapError(apiError(403, 'quotaExceeded', 'quota'), null).quota, true);

check('token mati -> fatal',
  youtube.wrapError(apiError(401, 'authError', 'invalid'), null).fatal, true);

const notConfigured = youtube.wrapError(
  apiError(403, 'accessNotConfigured',
    'YouTube Data API has not been used in project 123 before or it is disabled'),
  null
);
check('API belum diaktifkan -> reason khusus, bukan forbidden umum',
  notConfigured.reason, 'access_not_configured');
check('API belum diaktifkan -> fatal (perlu tindakan di Cloud Console)',
  notConfigured.fatal, true);

// Cabang baru tidak boleh menelan 403 biasa.
check('403 biasa tetap forbidden',
  youtube.wrapError(apiError(403, 'forbidden', 'akses ditolak'), null).reason, 'forbidden');

// ---- kredensial --------------------------------------------------------

const savedId = process.env.GOOGLE_CLIENT_ID;
const savedSecret = process.env.GOOGLE_CLIENT_SECRET;

check('kredensial terpasang -> ok', apiHealth.checkCredentials().ok, true);

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
const noCred = apiHealth.checkCredentials();
// Nilai dari database bisa saja terisi di mesin pengembang, jadi yang diuji
// adalah konsistensi ok<->reason, bukan kegagalannya secara mutlak.
check('tanpa env, hasil konsisten dengan reason-nya',
  noCred.ok === (noCred.reason === undefined), true);

process.env.GOOGLE_CLIENT_ID = savedId;
process.env.GOOGLE_CLIENT_SECRET = savedSecret;

// ---- scope Drive -------------------------------------------------------

check('akun tanpa scope Drive -> hasAccess false', drive.hasAccess(account), false);

const withDrive = { ...account, scopes: `${account.scopes} ${drive.SCOPE}` };
check('akun dengan scope Drive -> hasAccess true', drive.hasAccess(withDrive), true);

(async () => {
  const skipped = await apiHealth.checkDrive(account);
  check('Drive tanpa scope -> warn, bukan fail', skipped.status, apiHealth.STATUS.WARN);
  check('Drive tanpa scope -> reason scope_missing', skipped.reason, 'scope_missing');

  // ---- penggugurun berantai -------------------------------------------
  //
  // Tanpa refresh token, pemeriksaan token pasti gagal; YouTube dan Drive
  // harus DILEWATI, bukan dijalankan lalu dilaporkan gagal — kegagalan
  // turunan itulah yang membuat orang salah menduga penyebabnya.
  const broken = { ...account, refresh_token: null };
  const report = await apiHealth.checkAccount(broken);

  const byKey = {};
  report.checks.forEach((c) => { byKey[c.key] = c; });

  check('laporan memuat keempat pemeriksaan', report.checks.length, 4);
  check('token tanpa refresh -> gagal', byKey.token.status, apiHealth.STATUS.FAIL);
  check('YouTube dilewati, bukan gagal', byKey.youtube.status, apiHealth.STATUS.SKIP);
  check('Drive dilewati, bukan gagal', byKey.drive.status, apiHealth.STATUS.SKIP);
  check('laporan keseluruhan tidak ok', report.ok, false);
  check('laporan menyebut akun yang diperiksa', report.accountId, broken.id);

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
