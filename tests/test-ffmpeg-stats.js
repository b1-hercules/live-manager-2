'use strict';

// Baris progres FFmpeg tidak seragam, dan regex lama mengandaikan sebaliknya.
//
// FFmpeg >= 6.1 pada mode copy TIDAK mencetak frame=/fps= — tidak ada encoder
// video yang menghitungnya. STATS_RE lama mewajibkan keduanya sekaligus,
// sehingga state.stats tidak pernah terisi di instalasi bare-metal: frame 0,
// bitrate "-", bandwidth dashboard 0, padahal siarannya mengalir. Tiga tes
// integrasi yang membuktikan "siaran benar-benar mengalir" ikut merah karena
// membaca stats.frame.
//
// Yang wajib ada di semua versi dan semua mode hanyalah time=, jadi itulah
// syarat minimumnya — dan timeSeconds yang jadi bukti siaran maju.
//
// Tanpa database dan tanpa server: db/index.js disuntik lewat require.cache.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

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

const { parseStats } = require('../services/streamManager').__test;

// ---- baris sungguhan dari kedua versi ------------------------------------
// Keduanya disalin apa adanya dari pengukuran yang tercatat di TASKS.md.
const LINE_51 = 'frame=  190 fps= 25 q=-1.0 Lsize=     125kB time=00:00:07.50 bitrate= 136.4kbits/s speed=   1x';
const LINE_61_COPY = 'size=     127kB time=00:00:07.65 bitrate= 135.6kbits/s speed=1.07x';

const old = parseStats(LINE_51, null);
check('5.1: dikenali', Boolean(old), true);
check('5.1: frame', old.frame, 190);
check('5.1: fps', old.fps, 25);
check('5.1: bitrate', old.bitrate, '136.4kbits/s');
check('5.1: speed', old.speed, '1x');
check('5.1: time', old.time, '00:00:07.50');
check('5.1: timeSeconds', old.timeSeconds, 7.5);

const copy = parseStats(LINE_61_COPY, null);
check('6.1 copy: dikenali (dulu tidak)', Boolean(copy), true);
check('6.1 copy: bitrate tetap terbaca', copy.bitrate, '135.6kbits/s');
check('6.1 copy: speed tetap terbaca', copy.speed, '1.07x');
check('6.1 copy: time', copy.time, '00:00:07.65');
check('6.1 copy: timeSeconds', copy.timeSeconds, 7.65);
// null, bukan 0: nol berarti "tidak ada yang terkirim", null berarti
// "FFmpeg tidak memberitahu". Dashboard menyembunyikan yang null.
check('6.1 copy: frame null, bukan nol', copy.frame, null);
check('6.1 copy: fps null, bukan nol', copy.fps, null);

// ---- syaratnya time=, bukan frame= ---------------------------------------
check('baris tanpa time= diabaikan', parseStats('frame=  190 fps= 25 q=-1.0', null), null);
check('baris log biasa diabaikan', parseStats('[flv @ 0x5] Failed to update header', null), null);
check('baris kosong diabaikan', parseStats('', null), null);
check('time=N/A diabaikan (belum ada yang mengalir)',
  parseStats('size=       0kB time=N/A bitrate=N/A speed=N/A', null), null);
check('time negatif di awal siaran diabaikan',
  parseStats('size=       0kB time=-00:00:00.02 bitrate=N/A speed=N/A', null), null);

const hours = parseStats('size=  1kB time=02:03:04.50 bitrate= 10kbits/s speed=1x', null);
check('jam ikut dihitung', hours.timeSeconds, 2 * 3600 + 3 * 60 + 4.5);

// ---- field yang hilang mewarisi nilai sebelumnya --------------------------
// Siaran panjang sesekali mencetak baris progres tanpa bitrate; jangan sampai
// egress() menganggap siaran itu berhenti mengirim.
const previous = parseStats(LINE_61_COPY, null);
const partial = parseStats('size=     200kB time=00:00:12.00', previous);
check('bitrate hilang → warisi yang terakhir', partial.bitrate, '135.6kbits/s');
check('speed hilang → warisi yang terakhir', partial.speed, '1.07x');
check('time tetap dari baris baru', partial.time, '00:00:12.00');
const fresh = parseStats('size=     200kB time=00:00:12.00', null);
check('tanpa riwayat → bitrate jatuh ke tanda hubung', fresh.bitrate, '-');

// ---- egress: mode copy sekarang ikut terhitung ---------------------------
const { parseBitrate } = require('../services/streamManager');
check('bitrate mode copy bisa diubah jadi angka', parseBitrate(copy.bitrate), 135600);

// ---- lawan bicara sungguhan: FFmpeg di mesin ini -------------------------
// Nilai di atas disalin dari catatan. Pemeriksaan ini menghadapkan parseStats
// pada keluaran FFmpeg yang benar-benar terpasang, dengan argumen mode copy
// yang sama seperti aplikasi.
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-stats-'));
const src = path.join(tmp, 'src.mp4');
const out = path.join(tmp, 'out.flv');

function run(args) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stderr: String(stderr || '') });
    });
  });
}

(async () => {
  const made = await run(['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', src]);

  if (made.err || !fs.existsSync(src)) {
    console.log(`SKIP  FFmpeg tidak bisa membuat contoh (${made.err && made.err.message})`);
  } else {
    // Argumen salinan persis seperti buildArgs(): -c copy, -stats, warning.
    const real = await run(['-hide_banner', '-loglevel', 'warning', '-stats', '-nostdin', '-y',
      '-i', src, '-c:v', 'copy', '-c:a', 'copy', '-f', 'flv', out]);

    const lines = real.stderr.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((l) => parseStats(l, null)).filter(Boolean);

    check('FFmpeg mesin ini: ada baris progres yang terbaca', parsed.length > 0, true);
    if (parsed.length) {
      const last = parsed[parsed.length - 1];
      check('FFmpeg mesin ini: waktunya maju', last.timeSeconds > 0, true);
      check('FFmpeg mesin ini: bitrate terisi', last.bitrate !== '-', true);
      console.log(`        versi mode copy melaporkan frame=${last.frame} fps=${last.fps} time=${last.time} bitrate=${last.bitrate}`);
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
