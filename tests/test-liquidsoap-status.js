'use strict';

// Liquidsoap harus diperiksa, bukan diandaikan ada.
//
// `services/liquidsoap.js` punya checkAvailability() sejak fitur radio dibuat,
// tetapi tidak pernah ada yang memanggilnya: app.js dan routes/settings.js
// sama-sama memanggil checkAvailability() milik services/ffmpeg.js — nama yang
// kembar persis. Akibatnya aplikasi tidak pernah tahu liquidsoap terpasang atau
// tidak, halaman Pengaturan hanya menampilkan FFmpeg, dan pengguna baru
// menemukan masalahnya sebagai siaran radio yang gagal start.
//
// Tanpa database dan tanpa server: db/index.js disuntik lewat require.cache,
// view dirender langsung dengan ejs.
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

// ---- checkAvailability() benar-benar dipanggil ---------------------------
// Inti bug-nya: bukan fungsinya yang salah, melainkan nol pemanggil. Karena
// kedua service punya fungsi bernama sama, pemeriksaannya harus menyebut
// modulnya — `liquidsoapService.checkAvailability(`, bukan sekadar namanya.
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(ROOT, 'routes', 'settings.js'), 'utf8');

check('app.js me-require services/liquidsoap',
  /require\('\.\/services\/liquidsoap'\)/.test(appSrc), true);
check('boot() memanggil liquidsoapService.checkAvailability()',
  appSrc.includes('liquidsoapService.checkAvailability('), true);
check('hasilnya disimpan di app.locals.liquidsoapStatus',
  /app\.locals\.liquidsoapStatus\s*=\s*liquidsoapStatus/.test(appSrc), true);
check('ada nilai awal app.locals.liquidsoapStatus sebelum boot()',
  /app\.locals\.liquidsoapStatus\s*=\s*\{/.test(appSrc), true);
check('halaman Pengaturan punya rute cek ulang liquidsoap',
  settingsSrc.includes("router.post('/liquidsoap/check'"), true);
check('rute itu memakai checkAvailability milik liquidsoap, bukan ffmpeg',
  settingsSrc.includes('liquidsoapService.checkAvailability('), true);

// Ketiadaan liquidsoap bukan kegagalan startup — mode video tetap jalan — jadi
// log-nya warn, bukan error seperti FFmpeg.
const bootBlock = appSrc.slice(appSrc.indexOf('liquidsoapStatus.ok'));
check('liquidsoap yang hilang dicatat sebagai warn, bukan error',
  /log\.warn\(`Liquidsoap tidak ditemukan/.test(bootBlock), true);

// ---- bentuk jawaban checkAvailability() ----------------------------------
const liquidsoap = require('../services/liquidsoap');

(async () => {
  const status = await liquidsoap.checkAvailability();
  check('checkAvailability() menjawab objek dengan flag ok',
    typeof status.ok === 'boolean', true);
  if (status.ok) {
    check('terpasang → versi terisi', Boolean(status.version), true);
    check('terpasang → path terisi', Boolean(status.path), true);
  } else {
    check('tidak terpasang → alasannya terisi', Boolean(status.error), true);
  }
  console.log(`        (liquidsoap di mesin ini: ${status.ok ? status.version : status.error})`);

  // ---- peringatan di halaman detail siaran radio -------------------------
  // routes/streams.js memuat model yang membuka database saat di-require;
  // db/index.js diganti palsu supaya tes ini tidak menyentuh DB kerja sama
  // sekali.
  const dbPath = require.resolve('../db/index.js');
  const stmt = { get: () => null, all: () => [], run: () => ({ changes: 0 }) };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      db: { prepare: () => stmt, pragma: () => {}, exec: () => {}, transaction: (fn) => fn },
      tx: (fn) => fn(),
      now: () => new Date().toISOString(),
    },
  };

  const { radioWarnings } = require('../routes/streams');
  const missing = { ok: false, error: 'spawn liquidsoap ENOENT' };
  const present = { ok: true, version: 'Liquidsoap 2.2.4', path: '/usr/bin/liquidsoap' };
  const items = [{ id: 1 }];
  const backgrounds = [{ id: 1 }];

  const hasLiquidsoapWarning = (list) => (list || []).some((w) => w.includes('Liquidsoap'));

  check('bukan siaran radio → tidak ada peringatan radio sama sekali',
    radioWarnings(false, [], [], missing), null);
  check('radio + liquidsoap hilang → diperingatkan',
    hasLiquidsoapWarning(radioWarnings(true, items, backgrounds, missing)), true);
  check('peringatannya menyebut jalan keluarnya',
    radioWarnings(true, items, backgrounds, missing)[0].includes('LIQUIDSOAP_PATH'), true);
  check('peringatannya membawa pesan aslinya',
    radioWarnings(true, items, backgrounds, missing)[0].includes('ENOENT'), true);
  check('radio + liquidsoap ada → tidak ada peringatan liquidsoap',
    hasLiquidsoapWarning(radioWarnings(true, items, backgrounds, present)), false);
  check('radio + liquidsoap ada + lengkap → tidak ada peringatan apa pun',
    radioWarnings(true, items, backgrounds, present).length, 0);

  // Status yang belum diperiksa (undefined) tidak boleh memunculkan peringatan
  // palsu — halaman detail bisa dirender sebelum boot() selesai.
  check('status belum diperiksa → tidak mengarang peringatan',
    hasLiquidsoapWarning(radioWarnings(true, items, backgrounds, undefined)), false);

  // Peringatan lama tetap berjalan berdampingan.
  check('playlist kosong tetap diperingatkan',
    radioWarnings(true, [], backgrounds, present).length, 1);
  check('gambar latar kosong tetap diperingatkan',
    radioWarnings(true, items, [], present).length, 1);
  check('semuanya kurang → tiga peringatan sekaligus',
    radioWarnings(true, [], [], missing).length, 3);

  // ---- kartu Liquidsoap di halaman Pengaturan ----------------------------
  function renderSettings(liquidsoapStatus) {
    const file = path.join(VIEWS, 'settings.ejs');
    return ejs.render(fs.readFileSync(file, 'utf8'), {
      layout: () => {},
      include: () => '',
      appSettings: {}, hasClientSecret: false,
      redirectUri: 'http://localhost:7575/accounts/youtube/callback',
      appUrl: 'http://localhost:7575', timezone: 'Asia/Jakarta',
      encryptionDerived: false, sessionEphemeral: false,
      envClientId: false, envClientSecret: false, csrfToken: 't',
      ffmpegStatus: { ok: true, version: 'ffmpeg 6.1', path: '/usr/bin/ffmpeg' },
      liquidsoapStatus,
    }, { filename: file });
  }

  let okHtml = null;
  let missingHtml = null;
  try {
    okHtml = renderSettings(present);
    missingHtml = renderSettings(missing);
  } catch (err) {
    check(`settings.ejs bisa dirender (${err.message})`, false, true);
  }

  if (okHtml && missingHtml) {
    check('terpasang → versinya tampil', okHtml.includes(present.version), true);
    check('terpasang → path-nya tampil', okHtml.includes(present.path), true);
    check('tidak terpasang → alasannya tampil', missingHtml.includes(missing.error), true);
    check('tidak terpasang → disebut hanya untuk radio, video tetap jalan',
      /Siaran video tetap jalan/.test(missingHtml), true);
    check('tidak terpasang → LIQUIDSOAP_PATH ditawarkan', missingHtml.includes('LIQUIDSOAP_PATH'), true);
    // Peringatan, bukan error: FFmpeg hilang mematikan semua siaran, liquidsoap
    // hilang hanya mematikan mode radio.
    check('tidak terpasang → gayanya peringatan, bukan galat',
      /alert-warn[\s\S]{0,400}Liquidsoap tidak|Tidak ditemukan[\s\S]{0,400}LIQUIDSOAP_PATH/.test(missingHtml), true);
    check('kedua keadaan punya tombol cek ulang',
      okHtml.includes('/settings/liquidsoap/check') && missingHtml.includes('/settings/liquidsoap/check'), true);
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
