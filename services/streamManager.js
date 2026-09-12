'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const streamModel = require('../models/stream');
const videoModel = require('../models/video');
const playlistModel = require('../models/playlist');
const backgroundModel = require('../models/streamBackground');
const destinationModel = require('../models/destination');
const ffmpeg = require('./ffmpeg');
const liquidsoap = require('./liquidsoap');
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

// -------------------------------------------------------------- mode radio

/**
 * Apakah siaran ini bermode radio: sumbernya playlist berisi musik, bukan video.
 *
 * Sengaja dibaca dari playlist, bukan dari kolom pembeda baru di `streams`.
 * Menambah kolom ke models/stream.js berarti menyentuh SELECT yang dipakai
 * hampir setiap halaman; satu pembacaan playlist saat start jauh lebih murah
 * daripada risikonya.
 */
function isRadioStream(stream) {
  if (!stream.playlist_id) return false;
  const playlist = playlistModel.findById(stream.playlist_id);
  return Boolean(playlist && playlist.kind === 'audio');
}

/** Port harbor yang sedang dipakai siaran lain, supaya tidak bertabrakan. */
function takenHarborPorts() {
  const taken = new Set();
  for (const state of running.values()) {
    if (state.harborPort) taken.add(state.harborPort);
  }
  return taken;
}

/**
 * Validasi sumber siaran radio dan hitung semua path yang dibutuhkan — TANPA
 * menulis apa pun ke disk.
 *
 * Dipisahkan dari penulisan berkas karena pratinjau perintah memanggilnya juga,
 * dan pratinjau berasal dari request GET: sebuah GET tidak boleh meninggalkan
 * berkas di disk, pelajaran yang sudah dibayar sekali di jalur playlist video.
 *
 * resolveSource() sengaja TIDAK disentuh. Impact analysis atasnya mengembalikan
 * HIGH — 16 simbol dan tiga proses yang menyentuh setiap siaran (start
 * terjadwal, pratinjau, auto-restart). Percabangannya dilakukan pemanggil.
 */
function resolveRadioSource(stream) {
  const playlist = playlistModel.findById(stream.playlist_id);
  if (!playlist) return { error: 'Playlist musik siaran ini sudah dihapus' };

  const items = playlistModel.listItems(playlist.id);
  if (!items.length) return { error: `Playlist "${playlist.name}" belum berisi lagu` };

  const missingTrack = items.find((item) => !fs.existsSync(absoluteVideoPath(item.filepath)));
  if (missingTrack) return { error: `File musik "${missingTrack.title}" tidak ditemukan di disk` };

  const backgrounds = backgroundModel.listByStream(stream.id);
  if (!backgrounds.length) return { error: 'Siaran radio ini belum punya gambar latar' };

  const missingImage = backgrounds.find((bg) => !fs.existsSync(absoluteVideoPath(bg.filepath)));
  if (missingImage) return { error: 'Sebagian gambar latar tidak ditemukan di disk' };

  // Port yang sudah dipakai siaran ini sendiri dipertahankan saat restart
  // otomatis; kalau tidak, setiap putaran restart membakar satu port baru.
  const existing = running.get(stream.id);
  const port = existing && existing.harborPort
    ? existing.harborPort
    : liquidsoap.allocatePort(takenHarborPorts());

  return {
    playlist,
    items,
    backgrounds,
    port,
    canvas: ffmpeg.radioCanvas(stream),
    audioUrl: liquidsoap.harborUrl(port),
    backgroundPath: ffmpeg.backgroundListPathFor(stream.id),
    scriptPath: liquidsoap.scriptPathFor(stream.id),
    label: `radio "${playlist.name}" (${items.length} lagu, ${backgrounds.length} latar)`,
  };
}

/**
 * Tulis semua berkas yang dibutuhkan siaran radio: daftar lagu liquidsoap,
 * skrip .liq, gambar latar yang sudah di-pre-render, dan daftar ffconcat-nya.
 *
 * Async karena pre-render memanggil FFmpeg. Latar di-pre-render jadi BMP
 * seukuran kanvas bukan demi kerapian: FFmpeg membongkar ulang berkas latar
 * setiap frame selama siaran, dan inflate PNG 24 kali per detik adalah kerja
 * sungguhan untuk piksel yang tidak pernah berubah.
 */
async function prepareRadioFiles(stream, resolved) {
  liquidsoap.writePlaylist(
    stream.id,
    resolved.items.map((item) => ({ ...item, filepath: absoluteVideoPath(item.filepath) }))
  );

  liquidsoap.writeScript(stream.id, {
    playlistPath: liquidsoap.playlistPathFor(stream.id),
    port: resolved.port,
    mode: resolved.playlist.shuffle ? 'randomize' : 'normal',
  });

  const rendered = [];
  for (let i = 0; i < resolved.backgrounds.length; i += 1) {
    const target = path.join(config.paths.tmp, `radiobg_${stream.id}_${i}.bmp`);
    await ffmpeg.prerenderBackground(
      absoluteVideoPath(resolved.backgrounds[i].filepath),
      target,
      resolved.canvas
    );
    rendered.push(target);
  }

  ffmpeg.buildBackgroundList(stream.id, rendered, stream.background_rotate_minutes);
}

/**
 * Berkas sementara milik satu siaran, apa pun modenya: daftar concat untuk
 * playlist video, dan daftar lagu + skrip + latar untuk radio. Memanggil
 * keduanya selalu aman — yang tidak pernah dibuat cukup diabaikan.
 */
function cleanupStreamFiles(streamId) {
  ffmpeg.cleanupConcatFile(streamId);
  cleanupRadioFiles(streamId);
}

/** Hapus seluruh berkas sementara milik satu siaran radio. */
function cleanupRadioFiles(streamId) {
  liquidsoap.cleanupFiles(streamId);
  ffmpeg.cleanupBackgroundList(streamId);

  // Latar hasil pre-render dinomori per indeks; jumlahnya tidak diketahui di
  // sini, jadi disapu berdasarkan pola nama.
  try {
    for (const name of fs.readdirSync(config.paths.tmp)) {
      if (new RegExp(`^radiobg_${streamId}_\\d+\\.bmp$`).test(name)) {
        try { fs.unlinkSync(path.join(config.paths.tmp, name)); } catch (_) { /* keburu hilang */ }
      }
    }
  } catch (_) { /* folder tmp belum ada */ }
}

// ------------------------------------------------------------------- start

async function start(streamId, { manual = true } = {}) {
  const existing = running.get(streamId);
  if (existing && !existing.stopping) {
    return { ok: false, error: 'Stream sudah berjalan' };
  }

  const stream = streamModel.findById(streamId);
  if (!stream) return { ok: false, error: 'Stream tidak ditemukan' };

  // resolveSource() TIDAK disentuh; percabangannya di sini. Impact analysis
  // atasnya HIGH — 16 simbol dan tiga proses yang menyentuh setiap siaran.
  const radio = isRadioStream(stream);
  const resolved = radio ? resolveRadioSource(stream) : resolveSource(stream);
  if (resolved.error) {
    streamModel.setStatus(streamId, 'error', { error_message: resolved.error });
    return { ok: false, error: resolved.error };
  }

  const destinations = destinationModel.listForStream(streamId).filter((d) => d.active);
  if (!destinations.length) {
    return { ok: false, error: 'Pilih minimal satu tujuan RTMP yang aktif' };
  }

  const urls = destinations.map((d) => destinationModel.buildUrl(d));

  let args;
  let liq = null;
  if (radio) {
    // Jalan pintas saja: pemeriksaan yang menentukan ada di startRadioEngine().
    // Di sini gunanya supaya klik Mulai kedua tidak menulis ulang berkas yang
    // sedang dibaca liquidsoap pertama.
    if (radioStarting.has(streamId)) return { ok: false, error: RADIO_STARTING_ERROR };

    // Penulisan berkas dipisah dari validasi karena pre-render latar memanggil
    // FFmpeg, dan itu async — sedangkan pratinjau perintah harus tetap sinkron
    // dan tidak boleh menulis apa pun.
    try {
      await prepareRadioFiles(stream, resolved);
    } catch (err) {
      const message = `Persiapan siaran radio gagal: ${err.message}`;
      streamModel.setStatus(streamId, 'error', { error_message: message });
      streamModel.addLog(streamId, 'error', message);
      return { ok: false, error: message };
    }
    args = ffmpeg.buildRadioArgs(
      stream,
      { audioUrl: resolved.audioUrl, backgroundPath: resolved.backgroundPath },
      urls
    );
    liq = { scriptPath: resolved.scriptPath, port: resolved.port };
  } else {
    args = ffmpeg.buildArgs(stream, resolved.source, urls);
  }

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

  // Siaran radio: liquidsoap harus sudah melayani harbor SEBELUM FFmpeg
  // dijalankan. Karena itu tombol Mulai siaran radio menunggu ±15 detik.
  if (liq) {
    const engine = await startRadioEngine(streamId, liq);
    if (!engine.ok) return engine;
    liq.proc = engine.proc;
  }

  return launch(streamId, args, destinations, { manual, liq });
}

// Siaran radio yang sedang menunggu harbornya siap. Selama ±15 detik itu
// siarannya belum masuk `running`, jadi penjaga Mulai-ganda tidak bisa
// mengandalkan peta itu.
const radioStarting = new Set();
const RADIO_STARTING_ERROR = 'Siaran radio ini sedang dimulai — liquidsoap belum siap';

/**
 * Jalankan liquidsoap dan tunggu sampai harbornya benar-benar melayani.
 *
 * FFmpeg tidak boleh dijalankan lebih dulu: `-reconnect` hanya menyambung
 * ulang koneksi yang pernah berhasil, bukan koneksi pertama, sedangkan
 * liquidsoap sungguhan butuh ±15 detik untuk siap. Dulu keduanya dijalankan
 * bersamaan; FFmpeg mati dalam 0,2 detik, restart otomatis memulai KEDUA proses
 * dari nol, dan harbor tidak pernah sempat siap.
 *
 * Kegagalan di sini — binary tidak ada, liquidsoap keluar lebih dulu (skrip
 * ditolak, menolak jalan sebagai root), atau batas waktu — bersifat final:
 * mengulanginya tidak akan menolong, jadi siaran langsung ditandai error dengan
 * kata-kata liquidsoap sendiri, bukan diputar ke auto-restart.
 *
 * Penghentian selama menunggu tidak butuh jalur khusus di stop(): stop() tanpa
 * proses berjalan sudah mengembalikan status ke idle, dan itulah yang dilihat
 * `shouldAbort`.
 */
async function startRadioEngine(streamId, liq) {
  if (radioStarting.has(streamId)) return { ok: false, error: RADIO_STARTING_ERROR };
  radioStarting.add(streamId);

  // `state` untuk handleLiquidsoapOutput belum ada selama menunggu, jadi
  // keluarannya ditampung di sini; baris terakhirnya menjelaskan kegagalan.
  const recent = [];
  const collect = (chunk) => {
    for (const rawLine of chunk.toString().split(SPLIT_LINES)) {
      const line = rawLine.trim();
      if (!line) continue;
      recent.push(line);
      if (recent.length > 20) recent.shift();
    }
  };

  let proc = null;
  try {
    proc = liquidsoap.spawnEngine(liq.scriptPath);
    // Pendengar tetap: event 'error' tanpa pendengar menjatuhkan seluruh
    // aplikasi, dan waitForHarbor melepas pendengarnya sendiri saat selesai.
    proc.on('error', () => { /* dilaporkan lewat waitForHarbor */ });
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);

    const ready = await liquidsoap.waitForHarbor(liq.port, proc, {
      shouldAbort: () => streamModel.findById(streamId)?.status !== 'starting',
    });
    proc.stdout.off('data', collect);
    proc.stderr.off('data', collect);
    streamModel.addLog(streamId, 'info', `Liquidsoap siap dalam ${(ready.ms / 1000).toFixed(1)} detik`);
    return { ok: true, proc };
  } catch (err) {
    if (proc) killProcess(proc);
    if (err.code === 'ABORTED') {
      // stop() sudah merapikan status dan berkasnya.
      streamModel.addLog(streamId, 'info', 'Siaran dihentikan sebelum liquidsoap siap');
      return { ok: false, error: 'Siaran dihentikan sebelum sempat mulai' };
    }
    const tail = recent.slice(-3).join(' | ');
    const message = `Liquidsoap gagal disiapkan: ${err.message}${tail ? ` — ${tail}` : ''}`.slice(0, 500);
    cleanupRadioFiles(streamId);
    streamModel.setStatus(streamId, 'error', {
      pid: null,
      ended_at: new Date().toISOString(),
      error_message: message,
    });
    streamModel.addLog(streamId, 'error', message);
    return { ok: false, error: message };
  } finally {
    radioStarting.delete(streamId);
  }
}

/**
 * Jalankan siaran.
 *
 * Mode radio memakai DUA proses yang diperlakukan sebagai satu siaran:
 * liquidsoap memegang daftar lagu dan menyiarkannya lewat harbor, FFmpeg
 * membacanya dan menyusun gambar. Liquidsoap sudah dijalankan dan harbornya
 * sudah melayani (startRadioEngine) sebelum sampai di sini; launch() hanya
 * mengambil alih pengawasannya.
 */
function launch(streamId, args, destinations, { manual, liq = null }) {
  const lsProc = liq ? liq.proc : null;

  let proc;
  try {
    proc = ffmpeg.spawnStream(args);
  } catch (err) {
    // Jangan tinggalkan liquidsoap yatim kalau FFmpeg gagal dijalankan: ia akan
    // terus memegang port harbor dan siaran berikutnya tidak bisa memakainya.
    if (lsProc) killProcess(lsProc);
    streamModel.setStatus(streamId, 'error', { error_message: `Gagal menjalankan FFmpeg: ${err.message}` });
    streamModel.addLog(streamId, 'error', `Gagal menjalankan FFmpeg: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const sessionId = streamModel.openSession(streamId);
  const state = {
    proc,
    pid: proc.pid,
    lsProc,
    harborPort: liq ? liq.port : null,
    sessionId,
    args,
    destinations,
    startedAt: Date.now(),
    stopping: false,
    stopReason: null,
    logs: [],
    stats: { frame: null, fps: null, bitrate: '-', time: '-', timeSeconds: 0, speed: '-', updatedAt: null },
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

  if (lsProc) {
    // Log liquidsoap dipisahkan dari log FFmpeg: baris rutinnya banyak memuat
    // kata seperti "error" pada konteks yang tidak berarti gagal, dan penyaring
    // di handleOutput akan mencatatnya ke database sebagai masalah.
    lsProc.stderr.on('data', (chunk) => handleLiquidsoapOutput(streamId, state, chunk));
    lsProc.stdout.on('data', (chunk) => handleLiquidsoapOutput(streamId, state, chunk));

    lsProc.on('error', (err) => {
      streamModel.addLog(streamId, 'error', `Proses liquidsoap error: ${err.message}`);
      log.error(`Stream #${streamId} error liquidsoap`, err);
    });

    // Liquidsoap mati duluan: siaran radio tanpa audio tidak ada gunanya. FFmpeg
    // ikut dimatikan supaya penanganannya jatuh ke handleExit yang sudah ada —
    // termasuk backoff dan auto-restart — bukan ke jalur khusus baru.
    lsProc.on('close', (code) => {
      if (state.stopping) return;
      streamModel.addLog(streamId, 'warn', `Liquidsoap keluar dengan kode ${code}; siaran dihentikan untuk dijalankan ulang`);
      killProcess(state.proc);
    });
  }

  // Rotasi disiapkan setelah proses hidup, bukan sebelumnya.
  rotationEngine.onStreamStart(streamId).catch((err) =>
    log.error(`Setup rotasi stream #${streamId} gagal`, err)
  );

  return { ok: true, pid: proc.pid };
}

// ------------------------------------------------------------------- output

// FFmpeg dan liquidsoap sama-sama memisahkan baris dengan CRLF, LF, atau CR
// telanjang, tergantung platform dan apakah barisnya baris progres.
const SPLIT_LINES = /\r?\n|\r/;

const TIME_RE = /\btime=\s*(\d{2}:\d{2}:\d{2}\.\d{2})/;
const FRAME_RE = /\bframe=\s*(\d+)/;
const FPS_RE = /\bfps=\s*([\d.]+)/;
const BITRATE_RE = /\bbitrate=\s*(\S+)/;
const SPEED_RE = /\bspeed=\s*(\S+)/;

/** "00:01:07.65" -> 67.65. Dipakai sebagai bukti siaran benar-benar maju. */
function hmsToSeconds(hms) {
  const m = /^(\d{2}):(\d{2}):(\d{2}\.\d{2})$/.exec(hms);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
}

/**
 * Baris progres FFmpeg. Bentuknya berbeda antar versi DAN antar mode:
 *
 *   5.1, dan semua versi saat re-encode:
 *     frame=  190 fps= 25 q=-1.0 Lsize=  125kB time=00:00:07.50 bitrate= 136.4kbits/s speed=1x
 *   6.1 ke atas, mode copy:
 *     size=     127kB time=00:00:07.65 bitrate= 135.6kbits/s speed=1.07x
 *
 * FFmpeg 6.1 tidak mencetak frame=/fps= pada mode copy — tidak ada encoder video
 * yang menghitungnya (diuji 2026-09-10, pada -loglevel warning maupun info).
 * Regex lama mewajibkan keduanya sekaligus, jadi state.stats tidak pernah terisi
 * di sana: frame 0, bitrate "-", bandwidth dashboard 0, padahal siarannya
 * mengalir. Karena itu field dibaca satu per satu, dan yang WAJIB hanya time= —
 * satu-satunya yang ada di semua versi dan semua mode.
 *
 * frame/fps bernilai null, bukan 0, kalau tidak dilaporkan: nol berarti "tidak
 * ada yang terkirim", null berarti "tidak diberitahu".
 */
function parseStats(line, previous) {
  const time = TIME_RE.exec(line);
  if (!time) return null;

  const frame = FRAME_RE.exec(line);
  const fps = FPS_RE.exec(line);
  const bitrate = BITRATE_RE.exec(line);
  const speed = SPEED_RE.exec(line);
  const prev = previous || {};

  return {
    frame: frame ? parseInt(frame[1], 10) : null,
    fps: fps ? parseFloat(fps[1]) : null,
    bitrate: bitrate ? bitrate[1] : (prev.bitrate || '-'),
    time: time[1],
    timeSeconds: hmsToSeconds(time[1]),
    speed: speed ? speed[1] : (prev.speed || '-'),
    updatedAt: Date.now(),
  };
}

function handleOutput(streamId, state, chunk) {
  const text = chunk.toString();
  for (const rawLine of text.split(/\r?\n|\r/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Baris statistik diperbarui terus-menerus; simpan sebagai angka, bukan log.
    const stats = parseStats(line, state.stats);
    if (stats) {
      state.stats = stats;
      continue;
    }

    pushLog(state, line);

    // Simpan hanya baris yang benar-benar menandakan masalah ke database.
    if (/error|failed|invalid|unable|denied|refused|timed out/i.test(line)) {
      streamModel.addLog(streamId, 'error', line);
    }
  }
}

/**
 * Baris log liquidsoap. Sengaja tidak lewat handleOutput: di sana setiap baris
 * yang memuat kata "error"/"failed" dicatat ke database sebagai masalah, dan
 * liquidsoap rutin mencetak baris semacam itu saat berjalan normal. Hanya
 * kegagalan yang jelas yang diteruskan ke database.
 */
function handleLiquidsoapOutput(streamId, state, chunk) {
  for (const rawLine of chunk.toString().split(SPLIT_LINES)) {
    const line = rawLine.trim();
    if (!line) continue;
    pushLog(state, `[liquidsoap] ${line}`);
    if (/(fatal|cannot|could not|no such file|permission denied|address already in use)/i.test(line)) {
      streamModel.addLog(streamId, 'error', `liquidsoap: ${line}`);
    }
  }
}

function pushLog(state, line) {
  state.logs.push({ at: Date.now(), line });
  if (state.logs.length > LOG_BUFFER_LINES) state.logs.shift();
}

// -------------------------------------------------------------------- exit

function handleExit(streamId, state, code, signal) {
  // Liquidsoap selalu ikut dimatikan, di semua cabang di bawah ini. Setiap
  // cabang berakhir dengan siaran berhenti atau dijalankan ulang dari awal, dan
  // start() membuat proses liquidsoap yang baru — yang lama hanya akan
  // menahan port harbor-nya.
  if (state.lsProc) killProcess(state.lsProc);

  const uptime = Date.now() - state.startedAt;
  streamModel.closeSession(state.sessionId, { exitCode: code, reason: state.stopReason || (signal ? `signal ${signal}` : null) });

  if (state.stopping) {
    running.delete(streamId);
    // Daftar concat hanya berguna selama siaran berjalan. Dihapus di sini,
    // bukan saat restart otomatis, sebab proses baru masih membacanya.
    cleanupStreamFiles(streamId);
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
    cleanupStreamFiles(streamId);
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
    cleanupStreamFiles(streamId);
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
      cleanupStreamFiles(streamId);
      streamModel.setStatus(streamId, 'idle', { pid: null, ended_at: new Date().toISOString() });
      rotationEngine.onStreamStop(streamId);
      return { ok: true, note: 'Status dibersihkan (proses sudah tidak ada)' };
    }
    return { ok: false, error: 'Stream tidak sedang berjalan' };
  }

  if (state.restartTimer) {
    // Jeda auto-restart: FFmpeg lama sudah keluar, dan handleExit sudah menutup
    // sesinya serta mematikan liquidsoap. killProcess() pada proses yang sudah
    // mati tidak memicu 'close' lagi, jadi penutupan final dikerjakan di sini —
    // tanpa ini statusnya tertahan di 'stopping' selamanya.
    clearTimeout(state.restartTimer);
    running.delete(streamId);
    cleanupStreamFiles(streamId);
    streamModel.setStatus(streamId, 'idle', { pid: null, ended_at: new Date().toISOString() });
    streamModel.addLog(streamId, 'info', `Siaran dihentikan saat menunggu restart otomatis (${reason})`);
    streamModel.trimLogs(streamId);
    rotationEngine.onStreamStop(streamId);
    return { ok: true };
  }

  state.stopping = true;
  state.stopReason = reason;
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

  const urls = destinations.map((d) => destinationModel.buildUrl(d));
  const redact = destinations.map((d) => d.stream_key);

  // Pratinjau hanya menyusun teks perintah; tidak boleh menulis apa pun ke
  // disk, karena ia dipanggil dari request GET halaman detail siaran.
  if (isRadioStream(stream)) {
    const resolved = resolveRadioSource(stream);
    if (resolved.error) return null;
    const args = ffmpeg.buildRadioArgs(
      stream,
      { audioUrl: resolved.audioUrl, backgroundPath: resolved.backgroundPath },
      urls
    );
    // Dua proses, jadi dua baris: yang menyusun audio dan yang menyusun gambar.
    return `${liquidsoap.previewCommand(resolved.scriptPath)}

${ffmpeg.previewCommand(args, { redact })}`;
  }

  const resolved = resolveSource(stream, { write: false });
  if (resolved.error) return null;

  const args = ffmpeg.buildArgs(stream, resolved.source, urls);
  return ffmpeg.previewCommand(args, { redact });
}

/**
 * Buang daftar concat yang tidak dimiliki siaran berjalan mana pun. Dipanggil
 * pembersihan harian scheduler; yang berjalan sekarang dilewati karena FFmpeg
 * masih memegang berkasnya.
 */
function sweepConcatFiles() {
  const isOrphan = (streamId) => !running.has(streamId);
  return ffmpeg.sweepConcatFiles(isOrphan) + liquidsoap.sweepFiles(isOrphan);
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
  const sweptOnBoot = ffmpeg.sweepConcatFiles(() => true) + liquidsoap.sweepFiles(() => true);
  if (sweptOnBoot) log.info(`${sweptOnBoot} berkas sisa siaran sebelumnya dihapus`);

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
  // Bagian dalam mode radio, diekspor khusus untuk diuji. Menjalankan
  // liquidsoap sungguhan mustahil di Windows, jadi yang diuji adalah seluruh
  // keputusan di sekitarnya — dan justru di situlah kesalahan bisa lolos tanpa
  // ketahuan sampai siaran benar-benar dijalankan.
  __test: { isRadioStream, resolveRadioSource, prepareRadioFiles, cleanupRadioFiles, parseStats },
};
