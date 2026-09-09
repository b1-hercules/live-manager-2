'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const streamModel = require('../models/stream');
const videoModel = require('../models/video');
const playlistModel = require('../models/playlist');
const destinationModel = require('../models/destination');
const ffmpeg = require('./ffmpeg');
const rotationEngine = require('./rotationEngine');
const { createLogger } = require('../utils/logger');
const { shuffle } = require('../utils/helpers');

const log = createLogger('stream');

/** streamId -> runtime state (proses, statistik, backoff) */
const running = new Map();

const MAX_RESTARTS = 10;
const RESTART_BASE_MS = 5000;
const RESTART_MAX_MS = 120000;
/** Proses yang mati sebelum ini dianggap gagal, bukan selesai normal. */
const STABLE_AFTER_MS = 60000;
const LOG_BUFFER_LINES = 120;

// ------------------------------------------------------------------- start

/** Path absolut sebuah video, dari nilai relatif yang tersimpan di database. */
function absoluteVideoPath(filepath) {
  return path.isAbsolute(filepath) ? filepath : path.join(config.root, filepath);
}

/**
 * Tentukan sumber siaran: satu video, atau playlist berisi beberapa video.
 * Mengembalikan { source } untuk buildArgs, atau { error } berisi alasan yang
 * bisa langsung ditampilkan ke pengguna.
 *
 * `write: false` menyusun sumber tanpa menulis daftar concat ke disk — dipakai
 * pratinjau perintah, yang tidak menjalankan apa pun dan karena itu tidak boleh
 * meninggalkan jejak.
 */
function resolveSource(stream, { write = true } = {}) {
  if (stream.playlist_id) {
    const playlist = playlistModel.findById(stream.playlist_id);
    if (!playlist) return { error: 'Playlist sumber siaran ini sudah dihapus' };

    const items = playlistModel.listItems(playlist.id);
    if (!items.length) return { error: `Playlist "${playlist.name}" belum berisi video` };

    const missing = items.find((item) => !fs.existsSync(absoluteVideoPath(item.filepath)));
    if (missing) return { error: `File video "${missing.title}" tidak ditemukan di disk` };

    // Ketidakcocokan spesifikasi menghasilkan siaran rusak, bukan sekadar
    // kurang rapi — jadi dihentikan di sini, bukan dibiarkan gagal di tengah.
    const blockers = ffmpeg.playlistBlockers(stream, items);
    if (blockers.length) return { error: blockers.join(' ') };

    const ordered = playlist.shuffle ? shuffle(items) : items;
    return {
      source: ffmpeg.buildConcatSource(
        stream.id,
        ordered.map((item) => ({ ...item, filepath: absoluteVideoPath(item.filepath) })),
        { write }
      ),
      label: `playlist "${playlist.name}" (${items.length} video)`,
    };
  }

  const video = stream.video_id ? videoModel.findById(stream.video_id) : null;
  if (!video) return { error: 'Stream ini belum punya video sumber' };

  const absVideo = absoluteVideoPath(video.filepath);
  if (!fs.existsSync(absVideo)) return { error: 'File video tidak ditemukan di disk' };

  return { source: { ...video, filepath: absVideo }, label: video.title };
}

async function start(streamId, { manual = true } = {}) {
  const existing = running.get(streamId);
  if (existing && !existing.stopping) {
    return { ok: false, error: 'Stream sudah berjalan' };
  }

  const stream = streamModel.findById(streamId);
  if (!stream) return { ok: false, error: 'Stream tidak ditemukan' };

  const resolved = resolveSource(stream);
  if (resolved.error) {
    streamModel.setStatus(streamId, 'error', { error_message: resolved.error });
    return { ok: false, error: resolved.error };
  }

  const destinations = destinationModel.listForStream(streamId).filter((d) => d.active);
  if (!destinations.length) {
    return { ok: false, error: 'Pilih minimal satu tujuan RTMP yang aktif' };
  }

  const urls = destinations.map((d) => destinationModel.buildUrl(d));
  const args = ffmpeg.buildArgs(stream, resolved.source, urls);

  streamModel.setStatus(streamId, 'starting', {
    started_at: new Date().toISOString(),
    ended_at: null,
    error_message: null,
    restart_count: manual ? 0 : stream.restart_count,
  });
  streamModel.addLog(
    streamId, 'info',
    `Memulai siaran ke ${destinations.map((d) => d.name).join(', ')} (mode ${stream.encode_mode})`
  );

  return launch(streamId, args, destinations, { manual });
}

function launch(streamId, args, destinations, { manual }) {
  let proc;
  try {
    proc = ffmpeg.spawnStream(args);
  } catch (err) {
    streamModel.setStatus(streamId, 'error', { error_message: `Gagal menjalankan FFmpeg: ${err.message}` });
    streamModel.addLog(streamId, 'error', `Gagal menjalankan FFmpeg: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const sessionId = streamModel.openSession(streamId);
  const state = {
    proc,
    pid: proc.pid,
    sessionId,
    args,
    destinations,
    startedAt: Date.now(),
    stopping: false,
    stopReason: null,
    logs: [],
    stats: { frame: 0, fps: 0, bitrate: '-', time: '-', speed: '-', updatedAt: null },
    restarts: manual ? 0 : (running.get(streamId)?.restarts || 0),
  };
  running.set(streamId, state);

  streamModel.setStatus(streamId, 'live', { pid: proc.pid });
  log.info(`Stream #${streamId} live (pid ${proc.pid})`);

  proc.stderr.on('data', (chunk) => handleOutput(streamId, state, chunk));
  proc.stdout.on('data', (chunk) => handleOutput(streamId, state, chunk));

  proc.on('error', (err) => {
    streamModel.addLog(streamId, 'error', `Proses FFmpeg error: ${err.message}`);
    log.error(`Stream #${streamId} error proses`, err);
  });

  proc.on('close', (code, signal) => handleExit(streamId, state, code, signal));

  // Rotasi disiapkan setelah proses hidup, bukan sebelumnya.
  rotationEngine.onStreamStart(streamId).catch((err) =>
    log.error(`Setup rotasi stream #${streamId} gagal`, err)
  );

  return { ok: true, pid: proc.pid };
}

// ------------------------------------------------------------------- output

const STATS_RE = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?bitrate=\s*(\S+).*?speed=\s*(\S+)/;
const TIME_RE = /time=(\d{2}:\d{2}:\d{2}\.\d{2})/;

function handleOutput(streamId, state, chunk) {
  const text = chunk.toString();
  for (const rawLine of text.split(/\r?\n|\r/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Baris statistik diperbarui terus-menerus; simpan sebagai angka, bukan log.
    const stats = line.match(STATS_RE);
    if (stats) {
      state.stats = {
        frame: parseInt(stats[1], 10),
        fps: parseFloat(stats[2]),
        bitrate: stats[3],
        time: (line.match(TIME_RE) || [])[1] || state.stats.time,
        speed: stats[4],
        updatedAt: Date.now(),
      };
      continue;
    }

    pushLog(state, line);

    // Simpan hanya baris yang benar-benar menandakan masalah ke database.
    if (/error|failed|invalid|unable|denied|refused|timed out/i.test(line)) {
      streamModel.addLog(streamId, 'error', line);
    }
  }
}

function pushLog(state, line) {
  state.logs.push({ at: Date.now(), line });
  if (state.logs.length > LOG_BUFFER_LINES) state.logs.shift();
}

// -------------------------------------------------------------------- exit

function handleExit(streamId, state, code, signal) {
  const uptime = Date.now() - state.startedAt;
  streamModel.closeSession(state.sessionId, { exitCode: code, reason: state.stopReason || (signal ? `signal ${signal}` : null) });

  if (state.stopping) {
    running.delete(streamId);
    // Daftar concat hanya berguna selama siaran berjalan. Dihapus di sini,
    // bukan saat restart otomatis, sebab proses baru masih membacanya.
    ffmpeg.cleanupConcatFile(streamId);
    streamModel.setStatus(streamId, 'idle', { pid: null, ended_at: new Date().toISOString() });
    streamModel.addLog(streamId, 'info', `Siaran dihentikan (${state.stopReason || 'manual'})`);
    streamModel.trimLogs(streamId);
    rotationEngine.onStreamStop(streamId);
    log.info(`Stream #${streamId} berhenti`);
    return;
  }

  const stream = streamModel.findById(streamId);
  const lastLines = state.logs.slice(-5).map((l) => l.line).join(' | ');
  streamModel.addLog(streamId, 'warn', `FFmpeg keluar dengan kode ${code}. ${lastLines}`);

  if (!stream?.auto_restart) {
    running.delete(streamId);
    // Berhenti untuk selamanya: tidak ada proses baru yang akan membaca
    // daftarnya, jadi dibersihkan seperti pada penghentian manual.
    ffmpeg.cleanupConcatFile(streamId);
    streamModel.setStatus(streamId, 'error', {
      pid: null,
      ended_at: new Date().toISOString(),
      error_message: `FFmpeg berhenti (kode ${code})`,
    });
    rotationEngine.onStreamStop(streamId);
    return;
  }

  // Proses yang sempat berjalan stabil dianggap gangguan sesaat: hitungan
  // restart di-reset supaya siaran 24/7 tidak kehabisan jatah percobaan.
  if (uptime > STABLE_AFTER_MS) state.restarts = 0;
  state.restarts += 1;

  if (state.restarts > MAX_RESTARTS) {
    running.delete(streamId);
    // Jatah restart habis — sama seperti cabang di atas, tidak ada lagi yang
    // akan memakai daftarnya.
    ffmpeg.cleanupConcatFile(streamId);
    streamModel.setStatus(streamId, 'error', {
      pid: null,
      ended_at: new Date().toISOString(),
      error_message: `Gagal setelah ${MAX_RESTARTS} percobaan restart. ${lastLines}`.slice(0, 500),
    });
    streamModel.addLog(streamId, 'error', `Menyerah setelah ${MAX_RESTARTS} percobaan restart`);
    rotationEngine.onStreamStop(streamId);
    return;
  }

  const delay = Math.min(RESTART_BASE_MS * 2 ** (state.restarts - 1), RESTART_MAX_MS);
  streamModel.incrementRestart(streamId);
  streamModel.setStatus(streamId, 'starting', { pid: null });
  streamModel.addLog(streamId, 'warn', `Restart otomatis ke-${state.restarts} dalam ${Math.round(delay / 1000)} detik`);

  const timer = setTimeout(() => {
    const current = streamModel.findById(streamId);
    // Pengguna bisa saja menghentikan stream selama jeda restart.
    if (!current || !['starting', 'live'].includes(current.status)) {
      running.delete(streamId);
      return;
    }
    const prevRestarts = state.restarts;
    running.delete(streamId);
    start(streamId, { manual: false }).then((res) => {
      const next = running.get(streamId);
      if (next) next.restarts = prevRestarts;
      if (!res.ok) {
        streamModel.setStatus(streamId, 'error', { error_message: res.error });
        streamModel.addLog(streamId, 'error', `Restart gagal: ${res.error}`);
      }
    });
  }, delay);
  if (timer.unref) timer.unref();
  state.restartTimer = timer;
}

// -------------------------------------------------------------------- stop

function stop(streamId, reason = 'manual') {
  const state = running.get(streamId);
  if (!state) {
    // Tidak ada proses di memori: rapikan status yang tertinggal di DB.
    const stream = streamModel.findById(streamId);
    if (stream && stream.isActive) {
      // Prosesnya sudah tidak ada (mis. aplikasi sempat direstart), jadi daftar
      // concat yang mungkin tertinggal ikut dibereskan di sini.
      ffmpeg.cleanupConcatFile(streamId);
      streamModel.setStatus(streamId, 'idle', { pid: null, ended_at: new Date().toISOString() });
      rotationEngine.onStreamStop(streamId);
      return { ok: true, note: 'Status dibersihkan (proses sudah tidak ada)' };
    }
    return { ok: false, error: 'Stream tidak sedang berjalan' };
  }

  state.stopping = true;
  state.stopReason = reason;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  streamModel.setStatus(streamId, 'stopping');
  killProcess(state.proc);
  return { ok: true };
}

function killProcess(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32') {
    // FFmpeg di Windows tidak menangani SIGTERM; matikan lewat taskkill
    // beserta seluruh anak prosesnya.
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } catch (_) {
      proc.kill();
    }
    return;
  }

  proc.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGKILL'); } catch (_) { /* sudah mati */ }
    }
  }, 5000);
  if (timer.unref) timer.unref();
}

async function restart(streamId) {
  const state = running.get(streamId);
  if (state) {
    stop(streamId, 'restart');
    // Beri waktu proses lama melepas koneksi RTMP sebelum yang baru menyambung;
    // platform akan menolak dua koneksi dengan stream key yang sama.
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return start(streamId);
}

// -------------------------------------------------------------- monitoring

function isRunning(streamId) {
  const state = running.get(streamId);
  return Boolean(state && !state.stopping);
}

function runtime(streamId) {
  const state = running.get(streamId);
  if (!state) return null;
  return {
    pid: state.pid,
    uptimeMs: Date.now() - state.startedAt,
    restarts: state.restarts,
    stats: state.stats,
    destinations: state.destinations.map((d) => ({ id: d.id, name: d.name, platform: d.platform })),
  };
}

function recentLogs(streamId, limit = 60) {
  const state = running.get(streamId);
  if (!state) return [];
  return state.logs.slice(-limit);
}

/** Perintah FFmpeg yang dipakai, dengan stream key disamarkan. */
function commandPreview(streamId) {
  const state = running.get(streamId);
  if (state) {
    return ffmpeg.previewCommand(state.args, { redact: state.destinations.map((d) => d.stream_key) });
  }
  const stream = streamModel.findById(streamId);
  if (!stream) return null;
  const destinations = destinationModel.listForStream(streamId).filter((d) => d.active);
  if (!destinations.length) return null;

  // Pratinjau hanya menyusun teks perintah — tidak boleh menulis daftar concat.
  const resolved = resolveSource(stream, { write: false });
  if (resolved.error) return null;

  const args = ffmpeg.buildArgs(stream, resolved.source, destinations.map((d) => destinationModel.buildUrl(d)));
  return ffmpeg.previewCommand(args, { redact: destinations.map((d) => d.stream_key) });
}

/**
 * Buang daftar concat yang tidak dimiliki siaran berjalan mana pun. Dipanggil
 * pembersihan harian scheduler; yang berjalan sekarang dilewati karena FFmpeg
 * masih memegang berkasnya.
 */
function sweepConcatFiles() {
  return ffmpeg.sweepConcatFiles((streamId) => !running.has(streamId));
}

function activeCount() {
  let n = 0;
  for (const state of running.values()) if (!state.stopping) n++;
  return n;
}

/** "2500.3kbits/s" → 2500300. null bila FFmpeg belum melaporkan angka ("N/A"). */
function parseBitrate(raw) {
  const match = /^([\d.]+)\s*([kmg]?)bits\/s$/i.exec(String(raw || '').trim());
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  // Bitrate memakai satuan desimal (1000), bukan 1024 seperti ukuran berkas.
  return value * ({ '': 1, k: 1e3, m: 1e6, g: 1e9 }[match[2].toLowerCase()] || 1);
}

/**
 * Total bitrate keluar dari seluruh siaran yang berjalan, dalam bit/detik.
 * Angkanya berasal dari laporan FFmpeg sendiri, jadi ini trafik yang didorong
 * aplikasi ini — bukan total trafik mesin. Siaran yang belum melaporkan bitrate
 * (baru mulai, atau "N/A") tidak ikut dihitung dan tidak dianggap nol, supaya
 * angkanya tidak terlihat lebih kecil dari kenyataan.
 */
function egress() {
  let bitsPerSecond = 0;
  let streams = 0;
  for (const state of running.values()) {
    if (state.stopping) continue;
    const bits = parseBitrate(state.stats && state.stats.bitrate);
    if (bits === null) continue;
    bitsPerSecond += bits;
    streams += 1;
  }
  return { bitsPerSecond, streams };
}

/**
 * Setelah aplikasi restart, proses FFmpeg lama sudah mati bersama proses induk.
 * Baris yang masih berstatus live harus dikembalikan ke keadaan wajar.
 */
function recoverOnBoot() {
  // Saat boot belum ada satu pun siaran berjalan, jadi setiap daftar concat
  // yang masih ada pasti sisa dari proses sebelumnya. Dilakukan di luar cabang
  // `stale` di bawah: aplikasi bisa saja mati setelah status siaran tercatat
  // error, dan berkasnya tetap tertinggal.
  const sweptOnBoot = ffmpeg.sweepConcatFiles(() => true);
  if (sweptOnBoot) log.info(`${sweptOnBoot} daftar playlist sisa siaran sebelumnya dihapus`);

  const stale = streamModel.listActive();
  if (!stale.length) return 0;

  for (const stream of stale) {
    streamModel.setStatus(stream.id, stream.auto_restart ? 'idle' : 'error', {
      pid: null,
      ended_at: new Date().toISOString(),
      error_message: stream.auto_restart ? null : 'Aplikasi restart saat siaran berjalan',
    });
    streamModel.addLog(stream.id, 'warn', 'Aplikasi direstart — siaran ini terputus.');
  }
  log.warn(`${stale.length} stream dibersihkan setelah restart aplikasi`);
  return stale.length;
}

/** Hentikan semua siaran dengan rapi saat aplikasi dimatikan. */
function shutdown() {
  const ids = [...running.keys()];
  for (const id of ids) stop(id, 'shutdown aplikasi');
  return ids.length;
}

module.exports = {
  start, stop, restart, isRunning, runtime, recentLogs, commandPreview,
  activeCount, egress, parseBitrate, recoverOnBoot, shutdown, sweepConcatFiles,
};
