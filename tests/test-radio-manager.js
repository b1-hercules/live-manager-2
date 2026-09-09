'use strict';

// Uji jalur dua-proses di streamManager: pengenalan siaran radio, validasi
// sumbernya, alokasi port harbor, penulisan berkas, dan pembersihannya.
//
// Yang TIDAK diuji di sini adalah menjalankan liquidsoap sungguhan — ia tidak
// ada di Windows. Yang diuji adalah semua keputusan di sekitarnya, dan itulah
// bagian yang bisa salah tanpa ketahuan.
//
// Pola backup/restore database mengikuti tes integrasi lain di repo ini; WAL
// wajib di-checkpoint sebelum menyalin, kalau tidak migrasi yang belum
// ter-checkpoint ikut hilang.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(ROOT, 'db', `livemanager.db.radiomgr-${Date.now()}`);

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

// ---- backup DB ---------------------------------------------------------
require(path.join(ROOT, 'db')).db.pragma('wal_checkpoint(TRUNCATE)');
require(path.join(ROOT, 'db')).db.close();
fs.copyFileSync(DB, BACKUP);

function restore() {
  try {
    for (const suffix of ['-wal', '-shm']) {
      const extra = DB + suffix;
      if (fs.existsSync(extra)) fs.unlinkSync(extra);
    }
    fs.copyFileSync(BACKUP, DB);
    fs.unlinkSync(BACKUP);
  } catch (err) {
    console.error('GAGAL memulihkan DB:', err.message);
  }
}

const created = [];
process.on('exit', () => {
  for (const f of created) { try { fs.unlinkSync(f); } catch (_) { /* sudah hilang */ } }
});

let sm; let liquidsoap; let ffmpeg; let backgroundModel;

try {
  // Modul di-require SETELAH backup, supaya koneksi DB baru menunjuk ke salinan
  // kerja yang akan dipulihkan di akhir.
  delete require.cache[require.resolve(path.join(ROOT, 'db'))];
  const { db } = require(path.join(ROOT, 'db'));

  const userModel = require(path.join(ROOT, 'models/user'));
  const streamModel = require(path.join(ROOT, 'models/stream'));
  const playlistModel = require(path.join(ROOT, 'models/playlist'));
  const videoModel = require(path.join(ROOT, 'models/video'));
  backgroundModel = require(path.join(ROOT, 'models/streamBackground'));
  liquidsoap = require(path.join(ROOT, 'services/liquidsoap'));
  ffmpeg = require(path.join(ROOT, 'services/ffmpeg'));
  sm = require(path.join(ROOT, 'services/streamManager'));
  const config = require(path.join(ROOT, 'config'));

  const user = userModel.findByUsername('radiotest')
    || userModel.create({ username: 'radiotest', password: 'radiotest123', displayName: 'Radio Test' });

  // ---- fixture: lagu, latar, playlist audio ----------------------------
  fs.mkdirSync(config.paths.videos, { recursive: true });
  fs.mkdirSync(config.paths.thumbnails, { recursive: true });

  const trackPath = path.join(config.paths.videos, `radiotest-${Date.now()}.mp3`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=d=2', '-ac', '2', '-c:a', 'libmp3lame', trackPath], { stdio: 'pipe' });
  created.push(trackPath);

  const bgPath = path.join(config.paths.thumbnails, `radiobgtest-${Date.now()}.png`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=teal:size=320x180:d=1', '-frames:v', '1', bgPath], { stdio: 'pipe' });
  created.push(bgPath);

  const relative = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

  const track = videoModel.create({
    user_id: user.id, title: 'Lagu Uji', filename: 'lagu.mp3',
    filepath: relative(trackPath), filesize: fs.statSync(trackPath).size,
    duration: 2, kind: 'audio', has_audio: true, audio_codec: 'mp3',
  });
  check('lagu tercatat sebagai audio', track.kind, 'audio');

  const audioPlaylist = playlistModel.create(user.id, { name: 'Playlist Radio Uji' });
  db.prepare('UPDATE playlists SET kind = ? WHERE id = ?').run('audio', audioPlaylist.id);
  playlistModel.addItem(audioPlaylist.id, track.id);

  const videoPlaylist = playlistModel.create(user.id, { name: 'Playlist Video Uji' });

  // ---- pengenalan mode radio -------------------------------------------
  const radioStream = streamModel.create(user.id, {
    title: 'Siaran Radio Uji', playlist_id: audioPlaylist.id, resolution: '720p', fps: 24,
  });
  const videoStream = streamModel.create(user.id, {
    title: 'Siaran Video Uji', playlist_id: videoPlaylist.id, resolution: '720p', fps: 24,
  });

  // Tanpa latar, siaran radio harus DITOLAK — bukan dijalankan lalu gagal di
  // tengah dengan pesan FFmpeg yang tidak bisa dimengerti pengguna.
  const noBackground = sm.__test.resolveRadioSource(streamModel.findById(radioStream.id));
  check('radio tanpa latar ditolak', Boolean(noBackground.error), true);
  check('pesannya menyebut gambar latar', /latar/i.test(noBackground.error || ''), true);

  backgroundModel.add(radioStream.id, relative(bgPath));
  check('latar tercatat', backgroundModel.countByStream(radioStream.id), 1);

  const hydrated = streamModel.findById(radioStream.id);
  check('siaran playlist AUDIO dikenali radio', sm.__test.isRadioStream(hydrated), true);
  check('siaran playlist VIDEO bukan radio',
    sm.__test.isRadioStream(streamModel.findById(videoStream.id)), false);

  const resolved = sm.__test.resolveRadioSource(hydrated);
  check('sumber radio lolos validasi', Boolean(resolved.error), false);
  check('port harbor di dalam rentang',
    resolved.port >= liquidsoap.HARBOR_BASE && resolved.port < liquidsoap.HARBOR_BASE + liquidsoap.HARBOR_RANGE,
    true);
  check('audioUrl menunjuk loopback', resolved.audioUrl.startsWith('http://127.0.0.1:'), true);
  check('kanvas mengikuti resolusi siaran',
    `${resolved.canvas.width}x${resolved.canvas.height}`, '1280x720');

  // ---- penulisan berkas -------------------------------------------------
  return (async () => {
    await sm.__test.prepareRadioFiles(hydrated, resolved);

    const listPath = liquidsoap.playlistPathFor(radioStream.id);
    const scriptPath = liquidsoap.scriptPathFor(radioStream.id);
    const bgListPath = ffmpeg.backgroundListPathFor(radioStream.id);

    check('daftar lagu ditulis', fs.existsSync(listPath), true);
    check('skrip liquidsoap ditulis', fs.existsSync(scriptPath), true);
    check('daftar latar ditulis', fs.existsSync(bgListPath), true);

    check('daftar lagu memuat path lagu',
      fs.readFileSync(listPath, 'utf8').includes(path.basename(trackPath)), true);
    check('skrip memuat port yang dialokasikan',
      fs.readFileSync(scriptPath, 'utf8').includes(`port=${resolved.port}`), true);

    // Latar di-pre-render jadi BMP seukuran kanvas; kalau tidak, FFmpeg
    // membongkar ulang PNG-nya setiap frame sepanjang siaran.
    const bgList = fs.readFileSync(bgListPath, 'utf8');
    check('daftar latar menunjuk BMP hasil pre-render', /\.bmp'/.test(bgList), true);
    const bmpMatch = bgList.match(/file '([^']+\.bmp)'/);
    check('BMP-nya benar-benar ada', Boolean(bmpMatch && fs.existsSync(bmpMatch[1])), true);
    if (bmpMatch) {
      const size = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0', bmpMatch[1]], { encoding: 'utf8' }).trim();
      check('BMP seukuran kanvas', size, '1280,720');
    }

    // Durasi entri = background_rotate_minutes * 60 (bawaan 120 menit).
    check('durasi entri latar 7200 detik', bgList.includes('duration 7200'), true);

    // ---- pembersihan ----------------------------------------------------
    sm.__test.cleanupRadioFiles(radioStream.id);
    check('daftar lagu dibersihkan', fs.existsSync(listPath), false);
    check('skrip dibersihkan', fs.existsSync(scriptPath), false);
    check('daftar latar dibersihkan', fs.existsSync(bgListPath), false);
    check('BMP hasil pre-render dibersihkan', bmpMatch ? fs.existsSync(bmpMatch[1]) : false, false);

    // ---- pratinjau perintah ---------------------------------------------
    // Pratinjau dipanggil dari request GET, jadi ia TIDAK boleh meninggalkan
    // berkas — pelajaran yang sudah dibayar sekali di jalur playlist video.
    const preview = sm.commandPreview(radioStream.id);
    check('pratinjau radio tetap null tanpa tujuan RTMP', preview, null);
    check('pratinjau tidak menulis daftar lagu', fs.existsSync(listPath), false);
    check('pratinjau tidak menulis daftar latar', fs.existsSync(bgListPath), false);

    console.log(`\n${pass} pass, ${fail} fail`);
    db.close();
    restore();
    process.exit(fail ? 1 : 0);
  })();
} catch (err) {
  console.error('GAGAL:', err.stack || err.message);
  restore();
  process.exit(1);
}
