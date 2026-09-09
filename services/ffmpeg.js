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

      // Sampul album pada MP3/M4A muncul sebagai stream video mjpeg dengan
      // disposition attached_pic — diuji: MP3 bersampul memberi
      // codec_type=video, attached_pic=1. Itu satu gambar diam, bukan track
      // video. Tanpa saringan ini berkas musik lolos sebagai video dan siaran
      // memutar satu frame beku selamanya.
      const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
      const audio = streams.find((s) => s.codec_type === 'audio');

      if (!video && !audio) {
        return reject(new Error('File tidak memiliki track video maupun audio'));
      }

      const common = {
        duration: parseFloat(data.format?.duration) || 0,
        bitrate: parseInt(data.format?.bit_rate, 10) || 0,
        audio_codec: audio?.codec_name || null,
        has_audio: Boolean(audio),
      };

      // Berkas musik: tidak ada dimensi gambar untuk dilaporkan. Kuncinya tetap
      // disertakan bernilai 0/null, bukan dihilangkan, supaya bentuk objek yang
      // diterima pemanggil lama tidak berubah sama sekali.
      if (!video) {
        return resolve({
          ...common,
          kind: 'audio',
          width: 0,
          height: 0,
          fps: 0,
          video_codec: null,
          pix_fmt: null,
          profile: null,
        });
      }

      resolve({
        ...common,
        kind: 'video',
        width: video.width || 0,
        height: video.height || 0,
        fps: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
        video_codec: video.codec_name || null,
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

// ------------------------------------------------------------- siaran radio

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Kanvas untuk siaran radio.
 *
 * Resolusi "source" tidak punya arti di sini — tidak ada video sumber yang bisa
 * diikuti, hanya gambar diam dan spektrum — jadi ia jatuh ke 1080p.
 *
 * Diekspor karena gambar latar di-pre-render ke ukuran ini SEBELUM siaran
 * dimulai; pemanggil harus memakai angka yang sama persis, kalau tidak
 * gambarnya diskalakan ulang setiap frame dan pre-render itu jadi sia-sia.
 */
function radioCanvas(stream) {
  const preset = RESOLUTIONS[stream.resolution];
  const base = preset && preset.width ? preset : RESOLUTIONS['1080p'];
  return stream.orientation === 'portrait'
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height };
}

const SPECTRUM_MODES = new Set(['bar', 'line', 'dot', 'wave']);

/**
 * Warna spektrum berasal dari pengguna dan masuk ke filtergraph, tempat koma
 * dan titik dua memisahkan filter. Hanya #RRGGBB yang diterima; apa pun selain
 * itu jadi putih. Jangan pernah melonggarkan ini.
 */
function spectrumColor(value) {
  return /^#[0-9A-Fa-f]{6}$/.test(String(value || '')) ? `0x${String(value).slice(1)}` : 'white';
}

/** NULL berarti "di tengah secara mendatar". */
function spectrumX(stream, canvas, spectrum) {
  if (stream.spectrum_x === null || stream.spectrum_x === undefined) {
    return Math.max(0, Math.round((canvas.width - spectrum.width) / 2));
  }
  return clampInt(stream.spectrum_x, 0, Math.max(0, canvas.width - spectrum.width), 0);
}

function spectrumY(stream, canvas, spectrum) {
  return clampInt(stream.spectrum_y, 0, Math.max(0, canvas.height - spectrum.height), 15);
}

/**
 * Lapisan spektrum, siap ditumpuk di atas latar.
 *
 * Angka-angkanya disadur dari instalasi yang sudah terbukti berjalan berjam-jam,
 * bukan dikarang: ascale=cbrt membuat batang bergerak enak dilihat (log terlalu
 * rata), colorkey toleransi 0.08 cukup untuk membuang latar hitam generator
 * tanpa menggerogoti warna batangnya (0.30 terlalu longgar dan membuatnya
 * berlubang), dan aa=0.45 membuatnya tembus pandang sehingga gambar latar tetap
 * terlihat.
 */
function buildSpectrumFilter(stream, canvas) {
  const mode = SPECTRUM_MODES.has(stream.spectrum_mode) ? stream.spectrum_mode : 'bar';
  const color = spectrumColor(stream.spectrum_color);
  const fps = clampInt(stream.fps, 1, 60, 30);

  // Lebar wajib genap: mode cermin memotong tepat separuhnya lalu menyatukannya
  // kembali, dan lebar ganjil membuat hstack menolak ukuran yang tidak cocok.
  let width = clampInt(stream.spectrum_width, 16, canvas.width, 480);
  width -= width % 2;
  const height = clampInt(stream.spectrum_height, 16, canvas.height, 130);

  if (mode === 'wave') {
    // Waveform adalah garis waktu kiri-ke-kanan, bukan spektrum simetris, jadi
    // mode cermin tidak berlaku untuknya.
    const chain = `[1:a]showwaves=s=${width}x${height}:mode=p2p:rate=${fps}:colors=${color},`
      + 'format=rgba,colorkey=0x000000:0.08:0.0,colorchannelmixer=aa=0.45[viz];';
    return { width, height, chain };
  }

  // colors menerima satu warna PER KANAL dipisah "|". Satu nilai saja diabaikan
  // diam-diam dan spektrumnya keluar putih — audio di sini selalu stereo.
  let chain = `[1:a]showfreqs=s=${width}x${height}:mode=${mode}:ascale=cbrt:fscale=log:`
    + `colors=${color}|${color}:averaging=2,`
    + 'format=rgba,colorkey=0x000000:0.08:0.0,colorchannelmixer=aa=0.45[viz_raw];';

  if (stream.spectrum_mirror) {
    const half = width / 2;
    chain += `[viz_raw]crop=${half}:${height}:0:0,split[viz_l][viz_c];`
      + '[viz_c]hflip[viz_r];[viz_l][viz_r]hstack[viz];';
  } else {
    chain += '[viz_raw]null[viz];';
  }

  return { width, height, chain };
}

function backgroundListPathFor(streamId) {
  return path.join(config.paths.tmp, `radiobg_${streamId}.txt`);
}

/**
 * Daftar ffconcat untuk gambar latar yang bergantian.
 *
 * Dipilih ffconcat, bukan menjalankan ulang FFmpeg setiap pergantian seperti
 * instalasi lama: pergantiannya jadi TANPA jeda siaran. Sudah diuji — daftar 3
 * gambar berdurasi 2 detik yang diminta 14 detik menghasilkan tepat 14,0 detik,
 * dengan pergantian tepat waktu pada 7 dari 7 sampel termasuk setelah loop.
 *
 * Entri terakhir sengaja diulang: concat demuxer mengabaikan durasi entri
 * penghabisan, jadi tanpa pengulangan itu gambar terakhir hanya berkelebat satu
 * frame sebelum daftarnya berputar.
 */
function buildBackgroundList(streamId, imagePaths, rotateMinutes, { write = true } = {}) {
  if (!imagePaths.length) throw new Error('Siaran radio tanpa gambar latar');

  const seconds = clampInt(rotateMinutes, 1, 24 * 60, 120) * 60;
  const lines = ['ffconcat version 1.0'];

  for (const image of imagePaths) {
    lines.push(`file '${escapeConcatPath(path.resolve(config.root, image))}'`);
    lines.push(`duration ${seconds}`);
  }
  const last = imagePaths[imagePaths.length - 1];
  lines.push(`file '${escapeConcatPath(path.resolve(config.root, last))}'`);

  const target = backgroundListPathFor(streamId);
  // Sama seperti buildConcatSource(): pratinjau tidak boleh meninggalkan berkas
  // di disk hanya karena halaman detail dibuka.
  if (write) fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  return target;
}

/**
 * Pre-render satu gambar latar jadi BMP seukuran kanvas.
 *
 * Bukan kerapian, melainkan penghematan CPU yang nyata: FFmpeg membongkar ulang
 * berkas latar SETIAP frame selama siaran, dan inflate PNG atau DCT JPEG 30 kali
 * per detik adalah kerja sungguhan untuk piksel yang tidak pernah berubah.
 * Decode BMP nyaris sekadar salin memori. Sekalian menskalakan dan memotongnya
 * di sini, sehingga rangkaian filter saat siaran tidak perlu melakukan apa pun
 * pada latar selain menyeragamkan fps.
 */
function prerenderBackground(imagePath, outPath, canvas) {
  return new Promise((resolve, reject) => {
    const filter = [
      `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase`,
      `crop=${canvas.width}:${canvas.height}`,
    ].join(',');

    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', imagePath,
      '-vf', filter,
      '-frames:v', '1',
      '-update', '1',
      outPath,
    ];
    execFile(ffmpegPath(), args, { timeout: 60000 }, (err) => {
      if (err) return reject(new Error(`Pre-render latar gagal: ${err.message}`));
      resolve(outPath);
    });
  });
}

/**
 * Argumen FFmpeg untuk siaran ala radio: audio dari harbor liquidsoap, gambar
 * latar bergantian, spektrum di atasnya.
 *
 * SENGAJA fungsi terpisah, bukan cabang di dalam buildArgs(). Impact analysis
 * atas buildArgs mengembalikan HIGH — 23 simbol, dan tiga proses yang menyentuh
 * setiap siaran (start terjadwal, auto-restart, pratinjau perintah). Menyisipkan
 * cabang di sana berarti mempertaruhkan seluruh siaran video demi fitur baru.
 * Di sini pemilihan jalur dilakukan pemanggil, dan jalur lama tidak berubah
 * sedikit pun.
 *
 * @param {object} stream  baris streams (sudah di-hydrate)
 * @param {object} source  { audioUrl, backgroundPath } — backgroundPath adalah
 *                         daftar ffconcat berisi gambar yang SUDAH di-pre-render
 *                         seukuran kanvas
 * @param {Array}  urls    daftar URL RTMP tujuan
 */
function buildRadioArgs(stream, source, urls) {
  if (!urls.length) throw new Error('Tidak ada tujuan RTMP');
  if (!source.audioUrl) throw new Error('Sumber radio tanpa audioUrl');
  if (!source.backgroundPath) throw new Error('Sumber radio tanpa gambar latar');

  const canvas = radioCanvas(stream);
  const fps = clampInt(stream.fps, 1, 60, 30);
  const spectrum = buildSpectrumFilter(stream, canvas);

  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-nostdin'];

  // --- input 0: latar ---
  // thread_queue_size dinaikkan di kedua input: bawaannya terlalu kecil untuk
  // sumber yang mengalir terus, dan antrian yang kehabisan muncul sebagai frame
  // hilang di tengah siaran, bukan sebagai kegagalan yang kentara.
  args.push('-thread_queue_size', '512');
  // TANPA -re, dan itu WAJIB. -re memacu input menurut timestamp-nya sendiri,
  // sedangkan satu entri latar berdurasi rotateMinutes*60 detik (bawaannya 7200)
  // — jadi -re menunggu dua jam sebelum frame berikutnya dan siaran mati total.
  // Diukur: dengan -re, 8 detik keluaran tidak selesai dalam 33 detik; tanpa -re,
  // 8 detik keluaran selesai dalam 9,3 detik pada speed=1.04x. Yang memacu
  // rangkaian ini adalah audio harbor yang memang mengalir realtime, bukan -re.
  args.push('-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', source.backgroundPath);

  // --- input 1: audio dari harbor liquidsoap ---
  // -reconnect adalah alasan rangkaian ini bertahan berjam-jam: kalau liquidsoap
  // tersendat atau dijalankan ulang, FFmpeg menyambung sendiri alih-alih mati.
  args.push('-thread_queue_size', '512');
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2');
  args.push('-i', source.audioUrl);

  // --- filter ---
  // Latar sudah di-pre-render seukuran kanvas, jadi tidak ada scale/crop di sini,
  // hanya penyeragaman fps. Menyamakan fps SEBELUM overlay itu wajib dan bukan
  // kosmetik: framesync yang menyulam dua clock berbeda melintasi setiap putaran
  // -stream_loop adalah jebakan pertumbuhan memori yang sudah dikenal, dan
  // siaran ini berputar sepanjang hari.
  const overlayX = spectrumX(stream, canvas, spectrum);
  const overlayY = spectrumY(stream, canvas, spectrum);
  const filter = `[0:v]fps=${fps},format=yuv420p[bg];`
    + spectrum.chain
    // eof_action=endall: tanpa ini, kalau latar berakhir sementara audio terus
    // mengalir, FFmpeg membeku di frame terakhir selamanya alih-alih keluar
    // sehingga pengawasnya bisa menjalankan ulang.
    + `[bg][viz]overlay=${overlayX}:${overlayY}:eof_action=endall[final]`;

  args.push('-filter_complex', filter);

  // Audio dipetakan LANGSUNG dari input, melewati filtergraph: ia tidak perlu
  // diolah, dan jalur terpendek berarti satu hal lebih sedikit yang bisa macet.
  args.push('-map', '[final]', '-map', '1:a');

  const gop = Math.max(2, fps * 2);
  args.push(
    '-c:v', 'libx264',
    '-preset', stream.preset,
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-b:v', `${stream.bitrate}k`,
    '-maxrate', `${stream.bitrate}k`,
    '-bufsize', `${stream.bitrate * 2}k`,
    '-r', String(fps),
    '-g', String(gop),
    '-keyint_min', String(fps),
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', `${stream.audio_bitrate}k`,
    '-ar', '44100',
    '-ac', '2'
  );
  args.push('-max_muxing_queue_size', '1024');

  // --- output ---
  // Radio selalu di-encode ulang, jadi tidak ada stream yang di-copy dan tag
  // codec manual yang dibutuhkan jalur tee di buildArgs() tidak berlaku di sini.
  if (urls.length === 1) {
    args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', urls[0]);
  } else {
    const spec = urls
      .map((url) => `[f=flv:onfail=ignore:flvflags=no_duration_filesize]${escapeTee(url)}`)
      .join('|');
    args.push('-f', 'tee', spec);
  }

  return args;
}

function cleanupBackgroundList(streamId) {
  try {
    fs.unlinkSync(backgroundListPathFor(streamId));
  } catch (_) { /* tidak pernah dibuat, sudah dihapus, atau masih dipegang FFmpeg */ }
}

module.exports = {
  ffmpegPath, ffprobePath, checkAvailability,
  probe, generateThumbnail,
  buildArgs, buildVideoFilter, compatibilityWarnings,
  buildConcatSource, cleanupConcatFile, sweepConcatFiles, concatPathFor,
  buildRadioArgs, radioCanvas, buildSpectrumFilter, spectrumColor,
  buildBackgroundList, backgroundListPathFor, cleanupBackgroundList, prerenderBackground,
  playlistWarnings, playlistBlockers,
  spawnStream, previewCommand, escapeTee,
};
