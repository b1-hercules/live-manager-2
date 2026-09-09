'use strict';

// Uji lapisan media: pengenalan berkas musik (utils/filetype), pelonggaran
// ffmpeg.probe() untuk berkas tanpa track video, dan penyaringan `kind` di
// models/video.
//
// Berkas medianya nyata, dibuat ffmpeg — bukan buffer palsu. Sebagian jebakan
// di sini (M4A vs MP4, sampul album) hanya muncul pada berkas sungguhan.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const filetype = require('../utils/filetype');
const ffmpeg = require('../services/ffmpeg');
const upload = require('../middleware/upload');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediakind-'));
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

function ff(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe' });
}

const p = (name) => path.join(dir, name);

// ---- fixture ----------------------------------------------------------
const SINE = ['-f', 'lavfi', '-i', 'sine=d=1'];

ff([...SINE, '-c:a', 'libmp3lame', p('a.mp3')]);
ff([...SINE, '-c:a', 'flac', p('a.flac')]);
ff([...SINE, '-c:a', 'aac', p('a.m4a')]);
ff([...SINE, '-c:a', 'libvorbis', p('a.ogg')]);
ff([...SINE, p('a.wav')]);
ff(['-f', 'lavfi', '-i', 'testsrc=d=1:size=64x64', ...SINE,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('v.mp4')]);
ff(['-f', 'lavfi', '-i', 'color=c=orange:size=120x120:d=1', '-frames:v', '1', p('cover.png')]);
// MP3 bersampul: inilah bentuk yang paling mungkin ditemui dari koleksi musik nyata.
ff(['-i', p('a.mp3'), '-i', p('cover.png'), '-map', '0:a', '-map', '1:v',
  '-c:a', 'copy', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', p('cover.mp3')]);

// ---- signature --------------------------------------------------------

for (const [name, want] of [
  ['a.mp3', 'audio'], ['a.flac', 'audio'], ['a.m4a', 'audio'],
  ['a.ogg', 'audio'], ['a.wav', 'audio'], ['v.mp4', 'video'], ['cover.png', 'image'],
]) {
  const got = filetype.inspect(p(name));
  check(`signature ${name}`, got && got.family, want);
}

// Jebakan utama: M4A dan MP4 sama-sama diawali atom `ftyp`; pembedanya cuma
// brand di offset 8. Kalau urutan SIGNATURES dibalik, berkas musik AAC lolos
// sebagai video dan siaran memutar berkas tanpa gambar.
check('M4A tidak tertukar jadi MP4', filetype.inspect(p('a.m4a')).format, 'M4A');
check('MP4 tetap dikenali MP4/MOV', filetype.inspect(p('v.mp4')).format, 'MP4/MOV');

// JPEG juga diawali 0xFF seperti frame MP3 tanpa tag ID3; syarat sync 11 bit
// yang membedakannya. Regresi kalau syarat itu dilonggarkan.
ff(['-f', 'lavfi', '-i', 'color=c=blue:size=64x64:d=1', '-frames:v', '1', p('x.jpg')]);
check('JPEG tidak tertukar jadi MP3', filetype.inspect(p('x.jpg')).family, 'image');

// ---- gerbang unggah ---------------------------------------------------

check('gerbang audio menerima MP3',
  upload.contentError(p('a.mp3'), 'a.mp3', 'audio', 'audio'), null);
check('gerbang audio MENOLAK MP4',
  Boolean(upload.contentError(p('v.mp4'), 'v.mp4', 'audio', 'audio')), true);
check('gerbang video MENOLAK MP3',
  Boolean(upload.contentError(p('a.mp3'), 'a.mp3', 'video', 'video')), true);
check('gerbang video tetap menerima MP4',
  upload.contentError(p('v.mp4'), 'v.mp4', 'video', 'video'), null);

// ---- probe ------------------------------------------------------------

(async () => {
  for (const [name, want] of [
    ['a.mp3', 'audio'], ['a.flac', 'audio'], ['a.m4a', 'audio'],
    ['a.wav', 'audio'], ['v.mp4', 'video'],
  ]) {
    const meta = await ffmpeg.probe(p(name));
    check(`probe ${name} -> kind`, meta.kind, want);
  }

  // Berkas musik tidak punya dimensi gambar, tapi kuncinya tetap ada supaya
  // bentuk objek yang diterima pemanggil lama tidak berubah.
  const audioMeta = await ffmpeg.probe(p('a.mp3'));
  check('audio: width 0', audioMeta.width, 0);
  check('audio: height 0', audioMeta.height, 0);
  check('audio: fps 0', audioMeta.fps, 0);
  check('audio: video_codec null', audioMeta.video_codec, null);
  check('audio: has_audio true', audioMeta.has_audio, true);
  check('audio: durasi terbaca', audioMeta.duration > 0, true);

  // Sampul album muncul sebagai stream video mjpeg (attached_pic). Kalau tidak
  // disaring, MP3 bersampul dicatat sebagai VIDEO dan siaran memutar satu frame
  // beku selamanya — bug yang tidak akan terlihat sampai siaran benar-benar jalan.
  const coverMeta = await ffmpeg.probe(p('cover.mp3'));
  check('MP3 bersampul tetap audio', coverMeta.kind, 'audio');
  check('MP3 bersampul: tidak mewarisi dimensi sampul', coverMeta.width, 0);

  // Video biasa tidak boleh ikut berubah.
  const videoMeta = await ffmpeg.probe(p('v.mp4'));
  check('video: width tetap terbaca', videoMeta.width, 64);
  check('video: video_codec terbaca', videoMeta.video_codec, 'h264');

  // Berkas yang bukan media sama sekali tetap ditolak.
  fs.writeFileSync(p('sampah.bin'), Buffer.alloc(4096));
  let rejected = false;
  try { await ffmpeg.probe(p('sampah.bin')); } catch (_) { rejected = true; }
  check('berkas sampah tetap ditolak', rejected, true);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
