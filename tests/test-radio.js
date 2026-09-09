'use strict';

// Uji mesin siaran ala radio: skrip liquidsoap, argumen FFmpeg, dan rangkaian
// gambar+spektrum yang sungguhan dirender.
//
// Liquidsoap TIDAK dibutuhkan di sini. Sisi audionya digantikan server HTTP
// kecil yang menyuarakan MP3 dengan laju dibatasi — persis bentuk yang dilihat
// FFmpeg dari harbor. Yang benar-benar butuh liquidsoap hanyalah menjalankannya,
// dan itu diuji di container.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const ff = require('../services/ffmpeg');
const ls = require('../services/liquidsoap');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-'));
const p = (n) => path.join(dir, n);
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

const sh = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe' });
const fwd = (f) => f.split(path.sep).join('/');

// ---- skrip liquidsoap --------------------------------------------------

const script = ls.buildScript(7, { playlistPath: p('list.m3u'), port: 8305 });

check('harbor mengikat loopback saja',
  script.includes('settings.harbor.bind_addrs := ["127.0.0.1"]'), true);
check('memakai reload_mode watch', script.includes('reload_mode="watch"'), true);
check('port tersemat', script.includes('port=8305'), true);
check('mksafe dipasang', /mksafe/.test(script), true);
check('normalize dipasang', /normalize\(target=/.test(script), true);

// Fitur yang DITOLAK untuk mode radio. Kalau salah satu muncul lagi, seseorang
// menyeretnya masuk dari proyek lama tanpa diminta.
check('tanpa server telnet', /telnet/i.test(script), false);
check('tanpa metadata now-playing', /on_metadata|now_playing|file\.write/i.test(script), false);

// Port di luar rentang sah harus ditolak, bukan diam-diam masuk ke skrip.
let portRejected = false;
try { ls.buildScript(7, { playlistPath: p('l.m3u'), port: 99999 }); } catch (_) { portRejected = true; }
check('port tidak sah ditolak', portRejected, true);

// Alokasi port melompati yang sedang dipakai.
check('port pertama', ls.allocatePort(new Set()), ls.HARBOR_BASE);
check('port melompati yang terpakai',
  ls.allocatePort(new Set([ls.HARBOR_BASE, ls.HARBOR_BASE + 1])), ls.HARBOR_BASE + 2);

// ---- validasi yang masuk ke filtergraph --------------------------------

// Warna berasal dari pengguna dan masuk ke filtergraph, tempat koma dan titik
// dua memisahkan filter. Apa pun selain #RRGGBB wajib jadi putih.
check('warna sah diterima', ff.spectrumColor('#00FF88'), '0x00FF88');
check('warna tanpa pagar ditolak', ff.spectrumColor('00FF88'), 'white');
check('warna dengan koma ditolak', ff.spectrumColor('#00FF88,drawtext=x'), 'white');
check('warna kosong ditolak', ff.spectrumColor(''), 'white');

const base = {
  resolution: '720p', orientation: 'landscape', fps: 24,
  preset: 'ultrafast', bitrate: 2500, audio_bitrate: 128,
  spectrum_mode: 'bar', spectrum_color: '#00FF88',
  spectrum_width: 400, spectrum_height: 120,
  spectrum_x: null, spectrum_y: 220, spectrum_mirror: 0,
};

const canvas = ff.radioCanvas(base);
check('kanvas 720p landscape', `${canvas.width}x${canvas.height}`, '1280x720');
check('kanvas portrait terbalik',
  (() => { const c = ff.radioCanvas({ ...base, orientation: 'portrait' }); return `${c.width}x${c.height}`; })(),
  '720x1280');
check('resolution "source" jatuh ke 1080p',
  (() => { const c = ff.radioCanvas({ ...base, resolution: 'source' }); return `${c.width}x${c.height}`; })(),
  '1920x1080');

// spectrum_x NULL berarti di tengah mendatar.
const centered = ff.buildRadioArgs(base, { audioUrl: 'http://127.0.0.1:1/a', backgroundPath: 'x.txt' }, ['rtmp://x/y']);
const graph = centered[centered.indexOf('-filter_complex') + 1];
check('x NULL dipusatkan', graph.includes(`overlay=${(1280 - 400) / 2}:220`), true);

// Nilai di luar kanvas dijepit, tidak diteruskan apa adanya.
const clamped = ff.buildRadioArgs({ ...base, spectrum_x: 99999 },
  { audioUrl: 'http://127.0.0.1:1/a', backgroundPath: 'x.txt' }, ['rtmp://x/y']);
const clampedGraph = clamped[clamped.indexOf('-filter_complex') + 1];
check('x di luar kanvas dijepit', clampedGraph.includes(`overlay=${1280 - 400}:`), true);

// -re pada input latar akan mematikan siaran: ia memacu menurut timestamp, dan
// satu entri latar berdurasi rotateMinutes*60 detik.
check('TIDAK ada -re pada input latar', centered.includes('-re'), false);
check('ada -reconnect pada input audio', centered.includes('-reconnect'), true);
check('ada thread_queue_size', centered.includes('-thread_queue_size'), true);
check('eof_action=endall dipasang', graph.includes('eof_action=endall'), true);

// Mode cermin memotong separuh lalu menyatukannya kembali; lebar ganjil membuat
// hstack menolak.
const mirrored = ff.buildRadioArgs({ ...base, spectrum_mirror: 1, spectrum_width: 401 },
  { audioUrl: 'http://127.0.0.1:1/a', backgroundPath: 'x.txt' }, ['rtmp://x/y']);
const mirrorGraph = mirrored[mirrored.indexOf('-filter_complex') + 1];
check('cermin memakai hstack', mirrorGraph.includes('hstack'), true);
check('lebar ganjil dibulatkan ke genap', mirrorGraph.includes('crop=200:'), true);

// Mode waveform memakai showwaves, dan cermin tidak berlaku untuknya.
const wave = ff.buildRadioArgs({ ...base, spectrum_mode: 'wave', spectrum_mirror: 1 },
  { audioUrl: 'http://127.0.0.1:1/a', backgroundPath: 'x.txt' }, ['rtmp://x/y']);
const waveGraph = wave[wave.indexOf('-filter_complex') + 1];
check('wave memakai showwaves', waveGraph.includes('showwaves'), true);
check('wave tidak dicerminkan', waveGraph.includes('hstack'), false);

// ---- render sungguhan --------------------------------------------------

(async () => {
  for (const c of ['red', 'green', 'blue']) {
    sh(['-f', 'lavfi', '-i', `color=c=${c}:size=640x360:d=1`, '-frames:v', '1', p(`bg_${c}.png`)]);
  }

  const bmps = [];
  for (const c of ['red', 'green', 'blue']) {
    const out = p(`bg_${c}.bmp`);
    await ff.prerenderBackground(p(`bg_${c}.png`), out, canvas);
    bmps.push(out);
  }
  const size = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', bmps[0]], { encoding: 'utf8' }).trim();
  check('latar ter-pre-render seukuran kanvas', size, '1280,720');

  // Daftar sungguhan dibatasi minimal 1 menit; untuk melihat pergantiannya dalam
  // hitungan detik, daftar pendek ditulis dengan format yang sama.
  const listPath = p('bg.txt');
  const lines = ['ffconcat version 1.0'];
  for (const b of bmps) { lines.push(`file '${fwd(b)}'`); lines.push('duration 2'); }
  lines.push(`file '${fwd(bmps[bmps.length - 1])}'`);
  fs.writeFileSync(listPath, `${lines.join('\n')}\n`);

  // Server harbor tiruan: laju dibatasi seperti MP3 192 kbps sungguhan. Tanpa
  // pembatasan itu, pengujian tidak menyerupai harbor sama sekali.
  sh(['-f', 'lavfi', '-i', 'anoisesrc=d=30:c=pink:a=0.5', '-ac', '2', '-b:a', '192k',
    '-c:a', 'libmp3lame', p('audio.mp3')]);
  const mp3 = fs.readFileSync(p('audio.mp3'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    let offset = 0;
    const step = 2400; // ~24000 byte/detik pada interval 100 ms
    const timer = setInterval(() => {
      if (res.writableEnded) return clearInterval(timer);
      const end = Math.min(offset + step, mp3.length);
      res.write(mp3.subarray(offset, end));
      offset = end >= mp3.length ? 0 : end;
    }, 100);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const audioUrl = `http://127.0.0.1:${server.address().port}/radio.mp3`;

  const out = p('out.flv');
  const args = ff.buildRadioArgs(base, { audioUrl, backgroundPath: listPath }, [out]);
  args.splice(args.length - 3, 0, '-t', '9');

  const started = Date.now();
  await new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const guard = setTimeout(() => proc.kill('SIGKILL'), 60000);
    proc.on('close', (code) => {
      clearTimeout(guard);
      if (code !== 0) console.log('  stderr:', err.slice(-300));
      resolve();
    });
  });
  server.close();
  const elapsed = (Date.now() - started) / 1000;

  check('berkas keluaran terbentuk', fs.existsSync(out) && fs.statSync(out).size > 10000, true);

  // Siaran langsung WAJIB sanggup realtime. Yang memacunya adalah audio harbor,
  // bukan -re; kalau -re tersandung masuk lagi ke input latar, angka ini meledak.
  console.log(`        (9 detik keluaran selesai dalam ${elapsed.toFixed(1)} detik)`);
  check('sanggup realtime', elapsed < 20, true);

  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim().split('\n');
  check('ada video h264', streams.some((s) => s.includes('h264')), true);
  check('ada audio aac', streams.some((s) => s.includes('aac')), true);

  const colorAt = (t) => {
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t),
      '-i', out, '-frames:v', '1', '-vf', 'crop=200:200:20:20,scale=1:1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 });
    if (raw[0] > 100) return 'merah';
    if (raw[1] > 100) return 'hijau';
    return 'biru';
  };
  check('t=1 latar merah', colorAt(1), 'merah');
  check('t=3 latar hijau', colorAt(3), 'hijau');
  check('t=5 latar biru', colorAt(5), 'biru');
  check('t=7 kembali ke merah (daftar berputar)', colorAt(7), 'merah');

  // Kontrol senyap: siaran yang sama, audionya saja diganti keheningan.
  const silent = p('silent.flv');
  sh(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=12',
    '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-filter_complex',
    '[1:v]fps=24,format=yuv420p[bg];'
    + '[0:a]showfreqs=s=400x120:mode=bar:ascale=cbrt:fscale=log:colors=0x00FF88|0x00FF88:averaging=2,'
    + 'format=rgba,colorkey=0x000000:0.08:0.0,colorchannelmixer=aa=0.45[viz];'
    + '[bg][viz]overlay=440:220[final]',
    '-map', '[final]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '2500k', '-r', '24',
    '-c:a', 'aac', '-t', '9', silent]);

  // Luma TERTINGGI di antara pita 20px dalam kotak spektrum. Merata-ratakan
  // seluruh kotak tidak berguna: tinggi batang bergantung kenyaringan audio, dan
  // pada derau uji ini batangnya hanya mengisi pita terbawah — selisihnya larut
  // jadi 0,9 luma kalau dirata-rata, tapi 40 luma pada pita yang benar.
  const lumaOf = (file, x, y, w, h) => {
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '1',
      '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},scale=1:1`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 });
    return 0.299 * raw[0] + 0.587 * raw[1] + 0.114 * raw[2];
  };
  const peak = (file) => {
    let best = 0;
    for (let dy = 0; dy < 120; dy += 20) best = Math.max(best, lumaOf(file, 440, 220 + dy, 400, 20));
    return best;
  };
  const withAudio = peak(out);
  const withSilence = peak(silent);
  console.log(`        (luma puncak — berbunyi ${withAudio.toFixed(1)}, senyap ${withSilence.toFixed(1)})`);
  check('spektrum bereaksi pada audio', withAudio > withSilence + 20, true);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('GAGAL:', e.message);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
