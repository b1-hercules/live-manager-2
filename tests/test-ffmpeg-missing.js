'use strict';

// FFmpeg yang tidak terpasang harus gagal dengan kalimat yang benar, sekali.
//
// spawn() TIDAK melempar untuk binary yang tidak ada: kembaliannya objek dengan
// pid undefined, lalu event "error" (ENOENT), disusul "close" berkode -2. Jadi
// `try { ffmpeg.spawnStream() } catch` di launch() tidak pernah jalan untuk
// "FFmpeg tidak terpasang". Akibatnya siaran sempat berstatus live tanpa pid,
// lalu handleExit memutarnya ke auto-restart ±12,6 menit yang berakhir
// menyalahkan FFmpeg berhenti — sementara penyebab sebenarnya hanya ada di satu
// baris log. Pola yang sama sudah diperbaiki untuk liquidsoap di langkah 6;
// jalur FFmpeg tertinggal.
//
// Tanpa database dan tanpa server: db/index.js dan models/stream disuntik lewat
// require.cache, dan spawn-nya benar-benar dijalankan (bukan tiruan) supaya yang
// diuji adalah perilaku Node yang sesungguhnya.
const { spawn } = require('child_process');
const path = require('path');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

function stub(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ---- lebih dulu: perilaku Node yang jadi dasar seluruh perbaikan ----------
const ghost = spawn('ffmpeg-yang-tidak-ada-xyz', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
ghost.on('error', () => { /* wajib, kalau tidak prosesnya mati */ });
check('spawn() tidak melempar untuk binary yang hilang', typeof ghost === 'object', true);
check('spawn() memberi pid undefined, bukan melempar', ghost.pid, undefined);
const alive = spawn(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { stdio: ['ignore', 'pipe', 'pipe'] });
check('spawn() yang berhasil langsung punya pid angka', typeof alive.pid, 'number');
alive.kill();

// ---- model palsu yang merekam ---------------------------------------------
const recorded = { status: [], logs: [], sessions: 0 };
stub('../db/index.js', {
  db: { prepare: () => ({ get: () => null, all: () => [], run: () => ({ changes: 0 }) }), pragma: () => {}, exec: () => {}, transaction: (fn) => fn },
  tx: (fn) => fn(),
  now: () => new Date().toISOString(),
});
stub('../models/stream', {
  setStatus: (id, status, patch) => recorded.status.push({ id, status, patch }),
  addLog: (id, level, message) => recorded.logs.push({ id, level, message }),
  openSession: () => { recorded.sessions += 1; return recorded.sessions; },
  closeSession: () => {},
  trimLogs: () => {},
  findById: () => null,
  listLogs: () => [],
  RESOLUTIONS: {},
});

// services/ffmpeg diganti seluruhnya: launch() hanya memakai spawnStream() dan
// ffmpegPath() darinya, dan spawn-nya tetap spawn sungguhan.
let spawnTarget = 'ffmpeg-yang-tidak-ada-xyz';
let spawnArgs = ['-version'];
// Modul aslinya dipakai apa adanya — cleanupStreamFiles() memanggil helper
// lain di dalamnya — dan hanya dua fungsi yang dialihkan.
const realFfmpeg = require('../services/ffmpeg');
stub('../services/ffmpeg', {
  ...realFfmpeg,
  ffmpegPath: () => spawnTarget,
  spawnStream: () => spawn(spawnTarget, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'] }),
});

const streamManager = require('../services/streamManager');
const { launch } = streamManager.__test;

const destinations = [{ id: 1, name: 'uji', platform: 'youtube' }];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- FFmpeg tidak ada ---------------------------------------------------
  const result = launch(1, ['-version'], destinations, { manual: true });

  check('launch() menolak, bukan melapor sukses', result.ok, false);
  check('alasannya menyebut binary-nya', result.error.includes(spawnTarget), true);
  check('alasannya menunjuk FFMPEG_PATH', result.error.includes('FFMPEG_PATH'), true);

  const statuses = recorded.status.map((s) => s.status);
  check('status berakhir error', statuses[statuses.length - 1], 'error');
  check('TIDAK pernah sempat berstatus live', statuses.includes('live'), false);
  check('pid dibersihkan', recorded.status[recorded.status.length - 1].patch.pid, null);
  check('ended_at ikut diisi',
    Boolean(recorded.status[recorded.status.length - 1].patch.ended_at), true);

  // Inti perbaikannya: siaran tidak masuk pengawasan, jadi handleExit tidak
  // pernah memutarnya ke auto-restart.
  check('tidak masuk daftar siaran berjalan (tidak ada auto-restart)',
    streamManager.isRunning(1), false);
  check('tidak ada sesi yang dibuka untuk siaran yang gagal', recorded.sessions, 0);

  // Event "error" datang belakangan. Tanpa pendengar, Node menjatuhkan seluruh
  // proses — tes ini masih hidup berarti pendengarnya terpasang.
  await wait(300);
  check('proses tes selamat dari event error (pendengarnya terpasang)', true, true);
  check('pesan ENOENT asli ikut tercatat di log siaran',
    recorded.logs.some((l) => /ENOENT/.test(l.message)), true);
  check('log kegagalannya ber-level error',
    recorded.logs.every((l) => l.level === 'error'), true);

  // ---- kontrol: FFmpeg yang ADA tidak ikut kena penjagaan ----------------
  spawnTarget = process.execPath;
  spawnArgs = ['-e', 'setTimeout(()=>{},1500)'];
  recorded.status.length = 0;
  recorded.logs.length = 0;

  const good = launch(2, spawnArgs, destinations, { manual: true });
  check('binary yang ada tetap dijalankan', good.ok, true);
  check('dan pid-nya dilaporkan', typeof good.pid, 'number');
  check('siaran normal masuk pengawasan', streamManager.isRunning(2), true);
  check('siaran normal berstatus live',
    recorded.status.map((s) => s.status).includes('live'), true);

  streamManager.stop(2, 'uji selesai');
  await wait(500);
  check('siaran kontrol sudah berhenti lagi', streamManager.isRunning(2), false);

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
