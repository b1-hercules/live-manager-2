'use strict';

// Uji utils/filetype.js + middleware verifyContent terhadap file nyata.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const filetype = require('../utils/filetype');
const { verifyVideoContent, verifyImageContent } = require('../middleware/upload');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-'));
const FFMPEG = 'ffmpeg';
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

function ff(args) {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe' });
}

// ---- file media asli hasil ffmpeg -------------------------------------
const src = ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10'];
const real = {
  'real.mp4': [...src, '-pix_fmt', 'yuv420p'],
  'real.mkv': [...src],
  'real.avi': [...src],
  'real.flv': [...src, '-pix_fmt', 'yuv420p'],
  'real.webm': [...src, '-c:v', 'libvpx', '-b:v', '200k'],
  'real.ts': [...src, '-pix_fmt', 'yuv420p'],
  'real.mov': [...src, '-pix_fmt', 'yuv420p'],
  // MPEG-1/2 menolak 10 fps, jadi sumbernya dibuat 25 fps khusus untuk ini.
  'real.mpg': ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25'],
};
for (const [name, args] of Object.entries(real)) {
  const out = path.join(dir, name);
  try {
    ff([...args, out]);
    const got = filetype.inspect(out);
    check(`video asli ${name}`, got && got.family, 'video');
  } catch (err) {
    console.log(`SKIP  ${name} (ffmpeg gagal: ${String(err.message).slice(0, 60)})`);
  }
}

const images = {
  'real.jpg': [...src, '-frames:v', '1'],
  'real.png': [...src, '-frames:v', '1'],
  'real.webp': [...src, '-frames:v', '1'],
};
for (const [name, args] of Object.entries(images)) {
  const out = path.join(dir, name);
  try {
    ff([...args, out]);
    const got = filetype.inspect(out);
    check(`gambar asli ${name}`, got && got.family, 'image');
  } catch (err) {
    console.log(`SKIP  ${name} (ffmpeg gagal: ${String(err.message).slice(0, 60)})`);
  }
}

// ---- file palsu: inilah lubang yang ditutup ---------------------------
const fakes = {
  // PE executable (MZ) dinamai .mp4
  'virus.mp4': Buffer.from('4d5a90000300000004000000ffff0000b8000000', 'hex'),
  // Script PHP dinamai .mp4
  'shell.mp4': Buffer.from('<?php system($_GET["c"]); ?>'),
  // ZIP dinamai .mkv
  'archive.mkv': Buffer.from('504b0304140000000800', 'hex'),
  // Teks polos dinamai .mp4
  'notes.mp4': Buffer.from('halo ini cuma teks biasa, bukan video sama sekali'),
  // File kosong
  'empty.mp4': Buffer.alloc(0),
  // ELF binary dinamai .avi
  'binary.avi': Buffer.from('7f454c4602010100000000000000000002003e00', 'hex'),
};
for (const [name, buf] of Object.entries(fakes)) {
  const out = path.join(dir, name);
  fs.writeFileSync(out, buf);
  const got = filetype.inspect(out);
  check(`palsu ${name} ditolak`, got === null, true);
}

// gambar dinamai .mp4 → terdeteksi, tapi family-nya salah
const crossed = path.join(dir, 'gambar-nyamar.mp4');
fs.copyFileSync(path.join(dir, 'real.png'), crossed);
check('PNG bernama .mp4 → family image', filetype.inspect(crossed).family, 'image');

// ---- middleware: single + array + penolakan ---------------------------
function runMw(mw, req) {
  let result = 'next()';
  mw(req, {}, (err) => { if (err) result = `${err.status}: ${err.message}`; });
  return result;
}

check(
  'mw video: file sah lolos',
  runMw(verifyVideoContent, { file: { path: path.join(dir, 'real.mp4'), originalname: 'real.mp4' } }),
  'next()'
);

const rejected = runMw(verifyVideoContent, { file: { path: path.join(dir, 'virus.mp4'), originalname: 'virus.mp4' } });
check('mw video: PE executable ditolak 400', rejected.startsWith('400:'), true);
console.log(`        pesan → ${rejected}`);

const crossRejected = runMw(verifyVideoContent, { file: { path: crossed, originalname: 'gambar-nyamar.mp4' } });
check('mw video: PNG nyamar .mp4 ditolak', crossRejected.startsWith('400:'), true);
console.log(`        pesan → ${crossRejected}`);

check(
  'mw gambar: array semua sah lolos',
  runMw(verifyImageContent, {
    files: [
      { path: path.join(dir, 'real.png'), originalname: 'a.png' },
      { path: path.join(dir, 'real.jpg'), originalname: 'b.jpg' },
    ],
  }),
  'next()'
);

const mixed = runMw(verifyImageContent, {
  files: [
    { path: path.join(dir, 'real.png'), originalname: 'a.png' },
    { path: path.join(dir, 'shell.mp4'), originalname: 'b.png' },
  ],
});
check('mw gambar: satu busuk membatalkan batch', mixed.startsWith('400:'), true);

check('mw: tanpa file sama sekali lolos', runMw(verifyImageContent, {}), 'next()');
check(
  'mw: file hilang dari disk ditolak, tidak crash',
  runMw(verifyVideoContent, { file: { path: path.join(dir, 'tidak-ada.mp4'), originalname: 'x.mp4' } }).startsWith('400:'),
  true
);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
