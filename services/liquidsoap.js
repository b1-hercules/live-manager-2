'use strict';

const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, execFile } = require('child_process');
const config = require('../config');
const { createLogger } = require('../utils/logger');

const log = createLogger('liquidsoap');

/**
 * Mesin audio untuk siaran ala radio.
 *
 * Liquidsoap memegang daftar lagu — mengacak, menyamakan volume, menyambung
 * antar lagu — lalu menyiarkannya sebagai MP3 lewat server HTTP kecil di dalam
 * dirinya sendiri (harbor). FFmpeg membaca alamat itu, memasang gambar dan
 * spektrum, lalu mengirim ke RTMP.
 *
 * Kenapa HTTP, bukan pipe stdout->stdin: FFmpeg membaca harbor dengan
 * `-reconnect`, jadi kalau liquidsoap tersendat atau restart, FFmpeg menyambung
 * ulang sendiri. Lewat pipe, pipe putus berarti FFmpeg mati. Untuk siaran 24/7
 * itu menentukan — dan inilah yang membuat rangkaian ini bertahan berjam-jam
 * pada instalasi yang sudah terbukti. Harganya audio dikemas ulang jadi MP3 di
 * tengah jalan; ketahanan lebih berharga daripada satu generasi kompresi.
 */

// ------------------------------------------------------------ lokasi binary

let cachedBinary = null;

function resolveBinary() {
  const explicit = config.liquidsoapPath;
  if (explicit && fs.existsSync(explicit)) return explicit;
  return 'liquidsoap';
}

function liquidsoapPath() {
  if (!cachedBinary) cachedBinary = resolveBinary();
  return cachedBinary;
}

/**
 * Liquidsoap tidak ada di Windows, dan itu bukan kesalahan yang perlu diteriaki
 * saat startup — hanya berarti mode radio tidak tersedia di mesin ini.
 */
function checkAvailability() {
  return new Promise((resolve) => {
    execFile(liquidsoapPath(), ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const version = String(stdout).split('\n')[0] || 'unknown';
      resolve({ ok: true, version, path: liquidsoapPath() });
    });
  });
}

// ------------------------------------------------------------------- berkas

/** Daftar lagu yang dibaca liquidsoap; satu path mutlak per baris. */
function playlistPathFor(streamId) {
  return path.join(config.paths.tmp, `radio_${streamId}.m3u`);
}

/** Skrip .liq yang dijalankan; ditulis ulang setiap siaran dimulai. */
function scriptPathFor(streamId) {
  return path.join(config.paths.tmp, `radio_${streamId}.liq`);
}

/**
 * FFmpeg dan liquidsoap sama-sama menerima garis miring maju di Windows, dan
 * itu menghindari kebingungan antara pemisah direktori dengan karakter escape.
 */
function toForwardSlash(absPath) {
  return absPath.split(path.sep).join('/');
}

/** Literal string liquidsoap memakai "..." dengan escape gaya C. */
function quote(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Tulis daftar lagu. Dipisahkan dari buildScript() karena inilah berkas yang
 * boleh ditulis ulang SELAGI siaran berjalan: dengan reload_mode="watch",
 * liquidsoap memungut perubahannya tanpa memutus siaran.
 */
function writePlaylist(streamId, items) {
  if (!items.length) throw new Error('Playlist musik kosong');

  const lines = items
    .map((item) => toForwardSlash(path.resolve(config.root, item.filepath)))
    .join('\n');

  const target = playlistPathFor(streamId);
  fs.writeFileSync(target, `${lines}\n`, 'utf8');
  return target;
}

// -------------------------------------------------------------------- harbor

// Rentang port khusus mode radio. Harbor hanya mengikat ke loopback, jadi port
// ini tidak pernah terlihat dari luar mesin.
const HARBOR_BASE = 8300;
const HARBOR_RANGE = 200;
const HARBOR_MOUNT = '/radio.mp3';

/**
 * Port pertama yang belum dipakai siaran lain. Sengaja bukan rumus dari
 * streamId: siaran yang dihapus lalu dibuat lagi mendapat id baru terus, dan
 * rumus apa pun akhirnya bertabrakan. Pemanggil yang tahu port mana sedang
 * hidup, jadi dialah yang mengoper `taken`.
 */
function allocatePort(taken = new Set()) {
  for (let port = HARBOR_BASE; port < HARBOR_BASE + HARBOR_RANGE; port += 1) {
    if (!taken.has(port)) return port;
  }
  throw new Error(`Tidak ada port harbor bebas di rentang ${HARBOR_BASE}-${HARBOR_BASE + HARBOR_RANGE - 1}`);
}

function harborUrl(port) {
  return `http://127.0.0.1:${port}${HARBOR_MOUNT}`;
}

// Liquidsoap sungguhan butuh ±15 detik sebelum harbor terbuka (diukur di mesin
// 4 core: "Standard library loaded in 13.93 seconds", tanpa cache antar-putaran).
// 45 detik memberi mesin yang lebih lemah tiga kali ruang, dan tetap di bawah
// batas 60 detik bawaan proxy_read_timeout Nginx — tombol Mulai siaran radio
// menunggu sampai harbor siap.
const HARBOR_READY_TIMEOUT_MS = 45000;
const HARBOR_POLL_MS = 250;

/**
 * Tunggu sampai harbor benar-benar menerima koneksi TCP.
 *
 * Menolak secepatnya kalau prosesnya gagal: spawn() TIDAK melempar untuk binary
 * yang tidak ada — kegagalannya datang sebagai event 'error' (ENOENT) disusul
 * 'close' (kode -2), jadi di sinilah kegagalan itu tertangkap. Proses yang
 * keluar lebih dulu (skrip ditolak, menolak jalan sebagai root) juga ditolak
 * saat itu juga, bukan menunggu batas waktu habis.
 *
 * `shouldAbort` diperiksa setiap putaran, supaya penghentian siaran selama
 * menunggu tidak butuh jalur khusus.
 *
 * Kode penolakan: ENGINE_MISSING, ENGINE_FAILED, ENGINE_EXITED, HARBOR_TIMEOUT,
 * ABORTED.
 */
function waitForHarbor(port, proc, {
  timeoutMs = HARBOR_READY_TIMEOUT_MS,
  intervalMs = HARBOR_POLL_MS,
  shouldAbort = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let timer = null;
    let socket = null;

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      proc.off('error', onError);
      proc.off('close', onClose);
      if (err) reject(err); else resolve(value);
    }

    function fail(code, message) {
      const err = new Error(message);
      err.code = code;
      finish(err);
    }

    function onError(err) {
      if (err.code === 'ENOENT') {
        fail('ENGINE_MISSING', `liquidsoap tidak ditemukan (${liquidsoapPath()}). Pasang paket liquidsoap atau isi LIQUIDSOAP_PATH.`);
      } else {
        fail('ENGINE_FAILED', `liquidsoap tidak bisa dijalankan: ${err.message}`);
      }
    }

    function onClose(code, signal) {
      fail('ENGINE_EXITED', `liquidsoap keluar sebelum harbor siap (kode ${code}${signal ? `, sinyal ${signal}` : ''})`);
    }

    function attempt() {
      if (settled) return;
      if (shouldAbort && shouldAbort()) {
        fail('ABORTED', 'Dibatalkan sebelum harbor siap');
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        fail('HARBOR_TIMEOUT', `harbor liquidsoap tidak terbuka dalam ${Math.round(timeoutMs / 1000)} detik`);
        return;
      }

      const probe = net.connect({ host: '127.0.0.1', port });
      socket = probe;
      probe.setTimeout(1000);
      probe.once('connect', () => finish(null, { ms: Date.now() - startedAt }));
      let retried = false;
      const retry = () => {
        if (retried) return;
        retried = true;
        probe.destroy();
        if (socket === probe) socket = null;
        if (!settled) timer = setTimeout(attempt, intervalMs);
      };
      probe.once('error', retry);
      probe.once('timeout', retry);
    }

    proc.on('error', onError);
    proc.on('close', onClose);
    // Proses yang sudah selesai sebelum fungsi ini dipanggil tidak akan
    // memancarkan event lagi.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      onClose(proc.exitCode, proc.signalCode);
      return;
    }
    attempt();
  });
}

// --------------------------------------------------------------------- skrip

// Belum ada kolomnya di database; dijadikan konstanta bernama supaya jelas
// nilainya berasal dari mana kalau nanti dipindah ke setelan per-siaran.
const NORMALIZE_TARGET = -14.0;
const CROSSFADE_DURATION = 1.0;
const CROSSFADE_FADE = 0.5;
const MP3_BITRATE = '192k';
const SAMPLE_RATE = 44100;

const PLAY_MODES = new Set(['randomize', 'normal']);

/**
 * Susun skrip liquidsoap untuk satu siaran.
 *
 * Sengaja jauh lebih ramping daripada skrip radio pada umumnya: tanpa server
 * telnet, tanpa metadata "now playing", tanpa berkas status. Semua itu ditolak
 * secara eksplisit untuk mode radio di sini, dan tiap baris yang tidak ada
 * adalah satu hal yang tidak bisa rusak.
 */
function buildScript(streamId, { playlistPath, port, mode = 'randomize' }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Port harbor tidak sah: ${port}`);
  }
  const playMode = PLAY_MODES.has(mode) ? mode : 'randomize';

  return `# Dibuat otomatis oleh live-manager-2 untuk stream ${streamId}.
# JANGAN disunting manual: berkas ini ditulis ulang setiap siaran dimulai.

settings.log.stdout.set(true)
settings.log.level.set(3)

# Image Docker menjalankan aplikasi sebagai root, dan liquidsoap menolak jalan
# sebagai root ("init: security exit, root euid & guid") kecuali diizinkan.
# Mengizinkannya tidak menambah hak apa pun: liquidsoap hanya menyamai proses
# Node yang menjalankannya. Harbor tetap hanya loopback, dan tidak ada server
# kendali jarak jauh yang dibuka.
settings.init.allow_root.set(true)

# Harbor HANYA boleh dijangkau dari mesin ini. Bawaan liquidsoap mengikat ke
# 0.0.0.0, yang berarti audio siaran bisa didengarkan siapa pun yang sanggup
# menjangkau port ini. Ditulis dengan .set(), bukan :=, karena liquidsoap 2.1
# (Debian bookworm, yaitu image Docker) menolak := pada setelan: "Error 5: this
# value has type () -> _ but it should be a subtype of ref(_)". := baru menjadi
# alias .set() sejak 2.2.
settings.harbor.bind_addrs.set(["127.0.0.1"])

# reload_mode="watch" memakai notifikasi filesystem, bukan pemeriksaan berkala:
# nol kerja selama daftar tidak berubah, dan perubahan terbaca TANPA memutus
# siaran. Inilah satu-satunya alasan liquidsoap dipakai di sini alih-alih
# FFmpeg saja — daftar concat FFmpeg dibaca sekali lalu tidak pernah lagi.
music = playlist(id="music", reload_mode="watch", mode="${playMode}", ${quote(toForwardSlash(playlistPath))})

# mksafe menyediakan keheningan saat sumbernya gagal, supaya satu berkas rusak
# tidak menjatuhkan siaran. Dipasang dua kali, mengapit rantai efek: sebelumnya
# menjaga playlist, sesudahnya menjaga hasil normalize/crossfade.
music = mksafe(music)
music = normalize(target=${NORMALIZE_TARGET.toFixed(1)}, music)
music = crossfade(duration=${CROSSFADE_DURATION.toFixed(1)}, fade_in=${CROSSFADE_FADE.toFixed(1)}, fade_out=${CROSSFADE_FADE.toFixed(1)}, music)
music = mksafe(music)

output.harbor(
  fallible=true,
  %ffmpeg(format="mp3", %audio(codec="libmp3lame", b="${MP3_BITRATE}", ar=${SAMPLE_RATE})),
  port=${port},
  mount=${quote(HARBOR_MOUNT)},
  music
)
`;
}

/** Tulis skrip ke disk dan kembalikan path-nya. */
function writeScript(streamId, options) {
  const target = scriptPathFor(streamId);
  fs.writeFileSync(target, buildScript(streamId, options), 'utf8');
  return target;
}

// ------------------------------------------------------------------- proses

function spawnEngine(scriptPath) {
  log.debug('spawn liquidsoap', { scriptPath });
  return spawn(liquidsoapPath(), [scriptPath], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Versi perintah yang bisa dibaca manusia, untuk panel debug. */
function previewCommand(scriptPath) {
  const quoted = /[\s"']/.test(scriptPath) ? `"${scriptPath}"` : scriptPath;
  return `${liquidsoapPath()} ${quoted}`;
}

// ---------------------------------------------------------------- kebersihan

function cleanupFiles(streamId) {
  for (const target of [playlistPathFor(streamId), scriptPathFor(streamId)]) {
    try {
      fs.unlinkSync(target);
    } catch (_) { /* tidak pernah dibuat, sudah dihapus, atau masih dipegang */ }
  }
}

/**
 * Buang berkas radio yang tidak lagi dimiliki siaran mana pun. Sama seperti
 * sweepConcatFiles() di services/ffmpeg.js, yang menentukan "tidak dimiliki"
 * adalah pemanggil — di sini sengaja tidak ada asumsi soal siaran mana yang
 * sedang hidup.
 */
function sweepFiles(isOrphan) {
  let files = [];
  try {
    files = fs.readdirSync(config.paths.tmp);
  } catch (_) {
    return 0;
  }

  let removed = 0;
  for (const name of files) {
    const match = /^radio_(\d+)\.(m3u|liq)$/.exec(name);
    if (!match || !isOrphan(Number(match[1]))) continue;
    try {
      fs.unlinkSync(path.join(config.paths.tmp, name));
      removed += 1;
    } catch (_) { /* keburu hilang, atau masih dipegang proses lain */ }
  }
  return removed;
}

module.exports = {
  liquidsoapPath, checkAvailability,
  playlistPathFor, scriptPathFor, writePlaylist,
  buildScript, writeScript,
  allocatePort, harborUrl, HARBOR_BASE, HARBOR_RANGE, HARBOR_MOUNT,
  waitForHarbor, HARBOR_READY_TIMEOUT_MS,
  spawnEngine, previewCommand,
  cleanupFiles, sweepFiles,
};
