'use strict';

// Fitur Google harus mati dengan penjelasan, bukan mati diam-diam.
//
// Kredensial OAuth bersifat opsional di LiveManager, jadi tombol "Impor dari
// Drive" dan "Hubungkan Channel" sering dibuka orang yang belum menyiapkannya.
// Tombol yang tetap bisa diklik berujung pada galat yang membingungkan; tombol
// yang dihilangkan membuat fiturnya tak pernah ditemukan. Yang benar: tombolnya
// dinonaktifkan, alasannya ada di tooltip, dan langkah berikutnya tertulis
// kasatmata beserta tautannya.
//
// Tanpa database dan tanpa server: dependensi googleStatus disuntik lewat
// require.cache, lalu view dirender langsung dengan ejs.
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

// ---- googleStatus dengan dependensi palsu --------------------------------
// models/settings dan models/account membuka database saat dimuat. Isi
// require.cache lebih dulu supaya modul aslinya tidak pernah dijalankan.
const state = { hasCreds: false, accounts: [] };

function stub(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
stub('../models/settings', { hasGoogleCredentials: () => state.hasCreds });
stub('../models/account', { listByUser: () => state.accounts });
stub('../services/drive', {
  SCOPE: DRIVE_SCOPE,
  hasAccess: (account) => String(account?.scopes || '').includes(DRIVE_SCOPE),
});

const googleStatus = require('../services/googleStatus');

function driveStatus({ hasCreds, accounts }) {
  state.hasCreds = hasCreds;
  state.accounts = accounts;
  return googleStatus.driveImport(1);
}

const noCreds = driveStatus({ hasCreds: false, accounts: [] });
check('tanpa kredensial → belum siap', noCreds.ready, false);
check('tanpa kredensial → diarahkan ke Pengaturan', noCreds.href, '/settings');

const noAccount = driveStatus({ hasCreds: true, accounts: [] });
check('kredensial ada tapi belum ada akun → belum siap', noAccount.ready, false);
check('kredensial ada tapi belum ada akun → diarahkan ke Akun', noAccount.href, '/accounts');
check('alasannya beda dengan tahap sebelumnya', noAccount.reason !== noCreds.reason, true);

const noScope = driveStatus({ hasCreds: true, accounts: [{ id: 1, scopes: 'openid email' }] });
check('akun tanpa izin Drive → belum siap', noScope.ready, false);
check('akun tanpa izin Drive → disuruh menghubungkan ulang', noScope.href, '/accounts');
check('alasannya beda dengan tahap sebelumnya', noScope.reason !== noAccount.reason, true);

const ok = driveStatus({ hasCreds: true, accounts: [{ id: 1, scopes: `openid ${DRIVE_SCOPE}` }] });
check('kredensial + akun + izin Drive → siap', ok.ready, true);

// Tiap keadaan "belum siap" wajib menjelaskan diri: tanpa ini tombol mati
// tanpa keterangan, persis masalah yang mau dihindari.
for (const [label, status] of [['tanpa kredensial', noCreds], ['tanpa akun', noAccount], ['tanpa izin Drive', noScope]]) {
  check(`${label}: alasan, langkah berikutnya, dan label tautan terisi`,
    Boolean(status.reason && status.next && status.linkLabel), true);
  check(`${label}: pesan gabungan memuat keduanya`,
    googleStatus.message(status) === `${status.reason} ${status.next}`, true);
}

check('status siap tidak menyisakan pesan', googleStatus.message(ok), '');

// ---- view: tombol Impor dari Drive ---------------------------------------
function renderVideos(driveImport) {
  const file = path.join(VIEWS, 'videos', 'index.ejs');
  return ejs.render(fs.readFileSync(file, 'utf8'), {
    layout: () => {},
    include: () => '',
    videos: [], search: '', kind: 'video', videoCount: 0, audioCount: 0,
    totalSize: 0, maxUploadMb: 4096, csrfToken: 't',
    formatBytes: (b) => `${b}B`, formatDuration: (d) => `${d}s`,
    driveImport,
  }, { filename: file });
}

const lockedHtml = renderVideos(noCreds);
const readyHtml = renderVideos(ok);

const driveButton = (html) => /<button[^>]*id="driveBtn"[\s\S]*?>/.exec(html)[0];

check('belum siap → tombol Drive disabled', /\bdisabled\b/.test(driveButton(lockedHtml)), true);
check('sudah siap → tombol Drive bisa diklik', /\bdisabled\b/.test(driveButton(readyHtml)), false);
check('belum siap → tooltip memuat alasannya',
  lockedHtml.includes(`title="${noCreds.reason}`), true);
check('belum siap → keterangan kasatmata ikut tampil',
  lockedHtml.includes('id="driveLockNote"'), true);
check('belum siap → ada tautan ke langkah berikutnya',
  lockedHtml.includes(`href="${noCreds.href}"`), true);
check('sudah siap → tidak ada sisa keterangan atau pembungkus terkunci',
  /driveLockNote|btn-locked/.test(readyHtml), false);

// Tooltip hanya muncul kalau pointer-events tombolnya tidak mati; karena
// .btn:disabled mematikannya, title WAJIB ada di pembungkus.
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');
check('.btn:disabled memang mematikan pointer-events',
  /\.btn:disabled[^{]*\{[^}]*pointer-events\s*:\s*none/.test(css), true);
check('app.css punya .btn-locked untuk pembungkusnya',
  /\.btn-locked\s*\{/.test(css), true);
check('title menempel di pembungkus, bukan di tombol',
  /<span class="btn-locked" title="/.test(lockedHtml), true);

// ---- view: tombol Hubungkan Channel --------------------------------------
function renderAccounts(connectStatus) {
  const file = path.join(VIEWS, 'accounts', 'index.ejs');
  return ejs.render(fs.readFileSync(file, 'utf8'), {
    layout: () => {},
    include: () => '',
    accounts: [], hasCredentials: connectStatus.ready, connectStatus,
    redirectUri: 'http://localhost:7575/accounts/youtube/callback',
    scopes: [], quotaCost: {}, csrfToken: 't',
  }, { filename: file });
}

const connectBlocked = renderAccounts(noCreds);
const connectReady = renderAccounts({ ready: true, reason: '', next: '', href: null, linkLabel: '' });
const connectButton = (html) => /<button[^>]*>[\s\S]{0,120}?Hubungkan Channel/.exec(html)[0];

check('tanpa kredensial → tombol Hubungkan Channel disabled',
  /\bdisabled\b/.test(connectButton(connectBlocked)), true);
check('tanpa kredensial → tooltipnya terisi',
  connectBlocked.includes(`title="${noCreds.reason}`), true);
check('dengan kredensial → tombol bisa diklik',
  /\bdisabled\b/.test(connectButton(connectReady)), false);
check('dengan kredensial → pembungkus tidak ikut terkunci',
  /btn-locked/.test(connectReady), false);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
