'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const config = require('../config');
const { RESOLUTIONS } = require('../models/stream');
const { createLogger } = require('../utils/logger');

const log = createLogger('ffmpeg');

// ---------------------------------------------------------- lokasi binary

let cachedFfmpeg = null;
let cachedFfprobe = null;

function resolveBinary(kind) {
  const explicit = kind === 'ffmpeg' ? config.ffmpegPath : config.ffprobePath;
  if (explicit && fs.existsSync(explicit)) return explicit;

  // Kalau paket @ffmpeg-installer ada, pakai itu; kalau tidak, andalkan PATH.
  try {
    const pkg = kind === 'ffmpeg' ? '@ffmpeg-installer/ffmpeg' : '@ffprobe-installer/ffprobe';
    const mod = require(pkg);
    if (mod && mod.path && fs.existsSync(mod.path)) return mod.path;
  } catch (_) { /* paket opsional, tidak wajib ada */ }

  return kind;
}

function ffmpegPath() {
  if (!cachedFfmpeg) cachedFfmpeg = resolveBinary('ffmpeg');
  return cachedFfmpeg;
}

function ffprobePath() {
  if (!cachedFfprobe) cachedFfprobe = resolveBinary('ffprobe');
  return cachedFfprobe;
}

/** Cek ketersediaan FFmpeg saat startup supaya kegagalan ketahuan lebih awal. */
function checkAvailability() {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-version'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const version = String(stdout).split('\n')[0] || 'unknown';
      resolve({ ok: true, version, path: ffmpegPath() });
    });
  });
}

// ------------------------------------------------------------------ probe

function probe(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
    execFile(ffprobePath(), args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`ffprobe gagal: ${err.message}`));
      let data;
      try {
        data = JSON.parse(stdout);
      } catch (parseErr) {
        return reject(new Error('Output ffprobe tidak bisa dibaca'));
      }

      const streams = data.streams || [];
      const video = streams.find((s) => s.codec_type === 'video');
      const audio = streams.find((s) => s.codec_type === 'audio');

      if (!video) return reject(new Error('File tidak memiliki track video'));

      resolve({
        duration: parseFloat(data.format?.duration) || 0,
        bitrate: parseInt(data.format?.bit_rate, 10) || 0,
        width: video.width || 0,
        height: video.height || 0,
        fps: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
        video_codec: video.codec_name || null,
        audio_codec: audio?.codec_name || null,
        has_audio: Boolean(audio),
        pix_fmt: video.pix_fmt || null,
        profile: video.profile || null,
      });
    });
  });
}

function parseFrameRate(str) {
  if (!str) return 0;
  const [num, den] = String(str).split('/').map(Number);
  if (!den) return num || 0;
  return Math.round((num / den) * 100) / 100;
}

/** Ambil satu frame sebagai thumbnail. Gagal di sini tidak fatal untuk upload. */
function generateThumbnail(filePath, outPath, { atSeconds = 3, width = 640 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(atSeconds),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', '4',
      outPath,
    ];
    execFile(ffmpegPath(), args, { timeout: 60000 }, (err) => {
      if (err || !fs.existsSync(outPath)) {
        // Video lebih pendek dari atSeconds: coba lagi dari frame pertama.
        if (atSeconds > 0) return generateThumbnail(filePath, outPath, { atSeconds: 0, width }).then(resolve, reject);
        return reject(new Error('Gagal membuat thumbnail'));
      }
      resolve(outPath);
    });
  });
}

// ------------------------------------------------------- builder argumen

/**
 * Muxer tee memakai `|` sebagai pemisah output dan `[ ]` untuk opsi, jadi
 * karakter itu harus di-escape kalau muncul di dalam URL/stream key.
 */
function escapeTee(url) {
  return String(url).replace(/([\\|[\]:])/g, '\\$1');
}

function buildVideoFilter(stream) {
  const preset = RESOLUTIONS[stream.resolution];
  if (!preset || !preset.width) return null;

  const portrait = stream.orientation === 'portrait';
  const w = portrait ? preset.height : preset.width;
  const h = portrait ? preset.width : preset.height;

  // Skala sambil menjaga rasio, lalu beri padding hitam agar pas persis di
  // kanvas target — mencegah platform menolak resolusi ganjil.
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1',
  ].join(',');
}

/**
 * Susun argumen FFmpeg lengkap.
 * @param {object} stream  baris streams (sudah di-hydrate)
 * @param {object} source  baris videos, atau sumber playlist dari
 *                         buildConcatSource() yang membawa concatPath
 * @param {Array}  urls    daftar URL RTMP tujuan (sudah lengkap dengan key)
 */
function buildArgs(stream, source, urls) {
  if (!urls.length) throw new Error('Tidak ada tujuan RTMP');

  // Playlist memakai concat demuxer; sisanya (codec, filter, output) identik
  // dengan siaran video tunggal.
  const concatPath = source.concatPath || null;
  const hasAudio = source.has_audio !== 0 && source.has_audio !== false;
  const reencode = stream.encode_mode === 'reencode';
  // -stats tetap mencetak baris progres meski loglevel warning; baris itulah
  // yang dibaca streamManager untuk menampilkan fps/bitrate real-time.
  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-nostdin'];

  // --- opsi input ---
  // genpts membangun ulang timestamp setiap kali file diulang; tanpa ini
  // siaran loop panjang sering putus karena PTS mundur.
  args.push('-fflags', '+genpts');
  args.push('-re');
  // Pada playlist, -stream_loop mengulang seluruh daftar, bukan satu berkas.
  if (stream.loop_video) args.push('-stream_loop', '-1');
  if (concatPath) {
    // -safe 0 diperlukan karena daftar berisi path absolut.
    args.push('-f', 'concat', '-safe', '0', '-i', concatPath);
  } else {
    args.push('-i', source.filepath);
  }

  // Platform menolak siaran tanpa track audio, jadi sediakan audio senyap.
  // `-re` di sini WAJIB: anullsrc adalah sumber tak berhingga, dan tanpa
  // pacing realtime FFmpeg akan membacanya secepat mungkin sehingga audio
  // berlari jauh mendahului video (bitrate meledak, muxer membengkak).
  if (!hasAudio) {
    args.push('-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }

  args.push('-map', '0:v:0');
  args.push('-map', hasAudio ? '0:a:0' : '1:a:0');

  // --- codec ---
  // Dicatat karena muxer tee butuh codec tag eksplisit untuk stream yang di-copy
  // (lihat penjelasan di bagian output).
  let videoCopied = false;
  let audioCopied = false;

  if (reencode) {
    const vf = buildVideoFilter(stream);
    if (vf) args.push('-vf', vf);

    const gop = Math.max(2, stream.fps * 2);
    args.push(
      '-c:v', 'libx264',
      '-preset', stream.preset,
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-b:v', `${stream.bitrate}k`,
      '-maxrate', `${stream.bitrate}k`,
      '-bufsize', `${stream.bitrate * 2}k`,
      '-r', String(stream.fps),
      '-g', String(gop),
      '-keyint_min', String(stream.fps),
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', `${stream.audio_bitrate}k`,
      '-ar', '44100',
      '-ac', '2'
    );
  } else {
    args.push('-c:v', 'copy');
    videoCopied = true;
    // Copy video saja; audio tetap di-encode kalau sumbernya bukan AAC atau
    // kalau kita memakai anullsrc.
    if (hasAudio && isFlvSafeAudio(source.audio_codec)) {
      args.push('-c:a', 'copy');
      audioCopied = true;
    } else {
      args.push('-c:a', 'aac', '-b:a', `${stream.audio_bitrate}k`, '-ar', '44100', '-ac', '2');
    }
  }

  args.push('-max_muxing_queue_size', '1024');

  // Hentikan output begitu input terpendek habis. Penting untuk video tanpa
  // audio yang tidak di-loop: tanpa ini anullsrc terus mengalir selamanya
  // setelah videonya selesai. Saat loop aktif, tidak ada input yang berakhir
  // sehingga flag ini tidak berpengaruh.
  if (!hasAudio) args.push('-shortest');

  // --- output ---
  if (urls.length === 1) {
    args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', urls[0]);
  } else {
    // tee: satu kali decode/encode, banyak keluaran. onfail=ignore menjaga
    // siaran lain tetap hidup kalau satu platform menolak koneksi.
    //
    // Codec tag WAJIB diset manual di jalur ini. Pada output tunggal, FFmpeg
    // tahu format tujuannya (flv) dan menormalkan tag secara otomatis; lewat
    // tee ia tidak tahu, sehingga tag asli dari MP4 ("avc1"/"mp4a") diteruskan
    // apa adanya dan muxer FLV menolaknya:
    //   "Tag avc1 incompatible with output codec id '27'"
    // FLV memakai 7 untuk H.264 dan 10 untuk AAC. Hanya perlu untuk stream
    // yang di-copy; stream hasil encoding sudah membawa tag yang benar.
    if (videoCopied) args.push('-tag:v', '7');
    if (audioCopied) args.push('-tag:a', '10');

    const spec = urls
      .map((url) => `[f=flv:onfail=ignore:flvflags=no_duration_filesize]${escapeTee(url)}`)
      .join('|');
    args.push('-f', 'tee', spec);
  }

  return args;
}

function isFlvSafeAudio(codec) {
  return ['aac', 'mp3'].includes(String(codec || '').toLowerCase());
}

// --------------------------------------------------------------- playlist

/**
 * Di dalam daftar concat, kutip tunggal ditulis sebagai '\'' — ia menutup
 * literal, menyisipkan kutip yang di-escape, lalu membukanya lagi.
 */
function escapeConcatPath(absPath) {
  // FFmpeg menerima garis miring maju di Windows, dan itu menghindari
  // kebingungan antara pemisah direktori dengan karakter escape.
  return absPath.split(path.sep).join('/').replace(/'/g, "'\\''");
}

/**
 * Satu berkas daftar per stream, bukan per playlist: dua stream boleh memakai
 * playlist yang sama tanpa saling menimpa daftarnya.
 */
function concatPathFor(streamId) {
  return path.join(config.paths.tmp, `playlist_${streamId}.txt`);
}

/**
 * Tulis daftar concat untuk sebuah playlist dan kembalikan sumber yang bisa
 * dipakai buildArgs. Berkas daftarnya berumur sependek siaran itu sendiri;
 * streamManager yang menghapusnya lewat cleanupConcatFile().
 *
 * Codec diambil dari item pertama — aman karena playlist yang tidak seragam
 * ditolak oleh playlistWarnings() sebelum siaran dimulai.
 */
function buildConcatSource(streamId, items, { write = true } = {}) {
  if (!items.length) throw new Error('Playlist kosong');

  const concatPath = concatPathFor(streamId);

  // `write: false` dipakai pratinjau perintah. Menyusun argumen tidak boleh
  // meninggalkan berkas di disk: pratinjau dipanggil dari request GET halaman
  // detail stream, dan efek samping tulis-ke-disk dari sebuah GET berarti
  // berkas menumpuk hanya karena halaman dibuka.
  if (write) {
    const lines = items
      .map((item) => `file '${escapeConcatPath(path.resolve(config.root, item.filepath))}'`)
      .join('\n');
    fs.writeFileSync(concatPath, `${lines}\n`, 'utf8');
  }

  const first = items[0];
  return {
    concatPath,
    has_audio: first.has_audio,
    audio_codec: first.audio_codec,
    duration: items.reduce((total, item) => total + (Number(item.duration) || 0), 0),
  };
}

function cleanupConcatFile(streamId) {
  try {
    fs.unlinkSync(concatPathFor(streamId));
  } catch (_) { /* tidak pernah dibuat, sudah dihapus, atau masih dipegang FFmpeg */ }
}

/**
 * Buang daftar concat yang tidak lagi dimiliki siaran mana pun. Yang menentukan
 * "tidak dimiliki" adalah pemanggil (`isOrphan`), sebab streamManager yang tahu
 * isi peta `running` — di sini sengaja tidak ada asumsi soal itu.
 *
 * Milik siaran berjalan tidak boleh disentuh: FFmpeg memegang berkas daftarnya
 * tetap terbuka selama siaran (diuji — di Windows OS bahkan menolak
 * menghapusnya dengan EBUSY), jadi menghapusnya paling baik sia-sia dan paling
 * buruk merusak putaran playlist berikutnya.
 */
function sweepConcatFiles(isOrphan) {
  let files = [];
  try {
    files = fs.readdirSync(config.paths.tmp);
  } catch (_) {
    return 0;
  }

  let removed = 0;
  for (const name of files) {
    const match = /^playlist_(\d+)\.txt$/.exec(name);
    if (!match || !isOrphan(Number(match[1]))) continue;
    try {
      fs.unlinkSync(path.join(config.paths.tmp, name));
      removed += 1;
    } catch (_) { /* keburu hilang, atau masih dipegang proses lain */ }
  }
  return removed;
}

/**
 * Peringatan khusus playlist. Concat demuxer menyambung potongan tanpa
 * menormalkannya: kalau spesifikasi antar video berbeda di mode Copy, hasilnya
 * bukan sekadar kurang rapi — frame berukuran lain masuk ke stream yang sudah
 * terlanjur dideklarasikan, dan pemutar maupun platform akan menolaknya.
 * Mode re-encode menormalkan gambar, tapi sambungannya tetap bisa tersendat.
 */
function playlistWarnings(stream, items) {
  const warnings = [];
  if (!items.length) return ['Playlist belum berisi video.'];

  const differs = (key) => new Set(items.map((i) => i[key])).size > 1;
  const copyMode = stream.encode_mode !== 'reencode';

  if (differs('width') || differs('height')) {
    const sizes = [...new Set(items.map((i) => `${i.width}×${i.height}`))].join(', ');
    warnings.push(
      copyMode
        ? `Resolusi antar video berbeda (${sizes}). Di mode Copy ini menghasilkan siaran rusak — samakan resolusinya atau pakai mode Re-encode.`
        : `Resolusi antar video berbeda (${sizes}). Mode Re-encode akan menyeragamkannya, tapi perpindahan antar video bisa tersendat sesaat.`
    );
  }

  if (copyMode && differs('video_codec')) {
    const codecs = [...new Set(items.map((i) => (i.video_codec || '?').toUpperCase()))].join(', ');
    warnings.push(`Codec video berbeda (${codecs}). Mode Copy tidak bisa menyambungnya — pakai mode Re-encode.`);
  }

  // Sebagian video punya audio dan sebagian tidak: track audio akan hilang
  // timbul di tengah siaran, dan itu memutus koneksi di banyak platform.
  if (differs('has_audio')) {
    warnings.push('Sebagian video punya audio dan sebagian tidak. Samakan dulu, atau siaran akan terputus saat berpindah video.');
  }

  if (copyMode && differs('audio_codec') && !differs('has_audio')) {
    warnings.push('Codec audio antar video berbeda. Di mode Copy ini bisa membuat audio hilang setelah video pertama.');
  }

  if (copyMode && differs('fps')) {
    const rates = [...new Set(items.map((i) => Math.round(i.fps || 0)))].join(', ');
    warnings.push(`FPS antar video berbeda (${rates}). Perpindahan bisa tersendat; mode Re-encode menyeragamkannya.`);
  }

  return warnings;
}

/** Apakah playlist ini aman disiarkan dengan pengaturan stream sekarang. */
function playlistBlockers(stream, items) {
  if (!items.length) return ['Playlist belum berisi video.'];

  const differs = (key) => new Set(items.map((i) => i[key])).size > 1;
  const blockers = [];

  // Berlaku di kedua mode: re-encode menyeragamkan gambar, tapi tidak bisa
  // memunculkan track audio yang memang tidak ada di sebagian berkas. Susunan
  // stream berubah di tengah siaran, dan platform memutus koneksi.
  if (differs('has_audio')) {
    blockers.push('Sebagian video tidak punya audio — siaran akan terputus saat berpindah video.');
  }

  // Sisanya khusus mode Copy; re-encode menormalkan resolusi dan codec.
  if (stream.encode_mode !== 'reencode') {
    if (differs('width') || differs('height')) {
      blockers.push('Resolusi antar video berbeda — di mode Copy siaran akan rusak.');
    }
    if (differs('video_codec')) {
      blockers.push('Codec video antar video berbeda — mode Copy tidak bisa menyambungnya.');
    }
  }

  return blockers;
}

/**
 * Peringatan pra-siaran: kombinasi codec yang bisa gagal di mode copy.
 * Dikembalikan sebagai array string untuk ditampilkan di UI.
 */
function compatibilityWarnings(stream, video) {
  const warnings = [];
  if (!video) return ['Stream belum punya video sumber.'];

  if (stream.encode_mode === 'copy') {
    const vcodec = String(video.video_codec || '').toLowerCase();
    if (vcodec && vcodec !== 'h264') {
      warnings.push(
        `Video memakai codec ${vcodec.toUpperCase()}, sedangkan RTMP/FLV hanya menerima H.264. ` +
        'Ganti ke mode Re-encode atau konversi videonya dulu.'
      );
    }
    if (stream.resolution !== 'source') {
      warnings.push('Pengaturan resolusi diabaikan di mode Copy karena video diteruskan apa adanya.');
    }
    if (stream.bitrate && video.bitrate && video.bitrate > stream.bitrate * 1000 * 1.5) {
      warnings.push(
        `Bitrate sumber (${Math.round(video.bitrate / 1000)} kbps) jauh di atas target (${stream.bitrate} kbps). ` +
        'Di mode Copy bitrate tidak dibatasi, pastikan koneksi upload kamu cukup.'
      );
    }
  }

  if (stream.encode_mode === 'reencode' && stream.fps > 30 && stream.bitrate < 4500) {
    warnings.push('FPS di atas 30 dengan bitrate di bawah 4500 kbps biasanya menghasilkan gambar pecah.');
  }

  if (video.duration && video.duration < 60 && stream.loop_video) {
    warnings.push('Durasi video sangat pendek; loop yang terlalu sering bisa dianggap spam oleh platform.');
  }

  return warnings;
}

/** Jalankan FFmpeg dan kembalikan child process. */
function spawnStream(args) {
  log.debug('spawn ffmpeg', { args: args.join(' ') });
  return spawn(ffmpegPath(), args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Versi perintah yang bisa dibaca manusia, untuk panel debug. */
function previewCommand(args, { redact = [] } = {}) {
  let cmd = [ffmpegPath(), ...args]
    .map((a) => (/[\s"']/.test(a) ? `"${a}"` : a))
    .join(' ');
  for (const secret of redact) {
    if (secret) cmd = cmd.split(secret).join('••••••••');
  }
  return cmd;
}

module.exports = {
  ffmpegPath, ffprobePath, checkAvailability,
  probe, generateThumbnail,
  buildArgs, buildVideoFilter, compatibilityWarnings,
  buildConcatSource, cleanupConcatFile, sweepConcatFiles, concatPathFor,
  playlistWarnings, playlistBlockers,
  spawnStream, previewCommand, escapeTee,
};
