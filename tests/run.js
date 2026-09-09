#!/usr/bin/env node
'use strict';

/**
 * Runner tes: menjalankan seluruh `tests/test-*.js` satu per satu.
 *
 * Berurutan, bukan paralel, dan itu wajib: sebagian tes memakai database kerja
 * (`db/livemanager.db`) dengan pola backup → jalankan → kembalikan. Dua tes yang
 * berjalan bersamaan akan saling menimpa backup satu sama lain.
 *
 * Pemakaian:
 *   npm test                 # semua
 *   npm test -- playlist     # hanya yang namanya mengandung "playlist"
 *   npm test -- disk egress  # beberapa saringan sekaligus
 *   npm test -- --force      # abaikan kunci sisa proses yang mati
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LOCK = path.join(__dirname, '.run.lock');

// Tes murni (tanpa server/DB) didahulukan supaya kesalahan dasar ketahuan
// sebelum menunggu tes integrasi yang memakan menit.
const ORDER = ['test-filetype.js', 'test-playlist-core.js'];

function testFiles(filters) {
  const all = fs.readdirSync(__dirname)
    .filter((name) => name.startsWith('test-') && name.endsWith('.js'))
    .sort((a, b) => {
      const ai = ORDER.indexOf(a);
      const bi = ORDER.indexOf(b);
      if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.localeCompare(b);
    });

  if (!filters.length) return all;
  return all.filter((name) => filters.some((f) => name.includes(f)));
}

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
    });

    // Keluaran diteruskan apa adanya (tes integrasi bisa jalan menit-menitan,
    // jadi kemajuannya harus kelihatan), sambil ditampung untuk diringkas.
    let buffer = '';
    const forward = (stream, target) => stream.on('data', (chunk) => {
      buffer += chunk;
      target.write(chunk);
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);

    const startedAt = Date.now();
    child.on('close', (code) => {
      // Ringkasan diambil dari kemunculan TERAKHIR: sebagian tes mencetak
      // hitungan antara sebelum baris penutupnya.
      const all = [...buffer.matchAll(/(\d+) pass, (\d+) fail/g)];
      const match = all.length ? all[all.length - 1] : null;
      resolve({
        file,
        code,
        pass: match ? Number(match[1]) : 0,
        fail: match ? Number(match[2]) : 0,
        // Baris gagal disimpan supaya bisa diulang di ringkasan akhir; tanpa
        // ini, satu kegagalan tenggelam di ratusan baris keluaran tes lain.
        failures: buffer.split(/\r?\n/).filter((line) => line.startsWith('FAIL')),
        // Tanpa baris ringkasan, tes mati di tengah jalan — jangan dihitung lulus.
        summarized: Boolean(match),
        seconds: Math.round((Date.now() - startedAt) / 1000),
      });
    });
  });
}

function claimLock(force) {
  // Dua runner bersamaan akan saling menimpa backup database dan berebut port
  // yang sama — kegagalannya menyesatkan, dan yang lebih buruk, database kerja
  // bisa dikembalikan dari backup yang sudah basi.
  if (fs.existsSync(LOCK) && !force) {
    const owner = fs.readFileSync(LOCK, 'utf8').trim();
    console.error(`Tes lain sedang berjalan (${owner}).`);
    console.error(`Kalau itu sisa proses yang mati, hapus ${LOCK} atau jalankan dengan --force.`);
    process.exit(1);
  }
  fs.writeFileSync(LOCK, `pid ${process.pid}, mulai ${new Date().toISOString()}`);
  const release = () => { try { fs.unlinkSync(LOCK); } catch (_) { /* sudah dilepas */ } };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const files = testFiles(args.filter((a) => a !== '--force'));
  if (!files.length) {
    console.error('Tidak ada tes yang cocok dengan saringan itu.');
    process.exit(1);
  }

  claimLock(force);

  console.log(`Menjalankan ${files.length} berkas tes (berurutan).`);
  console.log('Catatan: tes integrasi memakai db/livemanager.db dengan backup & restore,');
  console.log('membutuhkan ffmpeg/ffprobe di PATH, dan memakai port 7588–7599.\n');

  const results = [];
  for (const file of files) {
    console.log(`\n${'='.repeat(70)}\n▶ ${file}\n${'='.repeat(70)}`);
    results.push(await runOne(file));
  }

  console.log(`\n${'='.repeat(70)}\nRINGKASAN\n${'='.repeat(70)}`);
  let pass = 0;
  let fail = 0;
  let broken = 0;
  for (const r of results) {
    pass += r.pass;
    fail += r.fail;
    const ok = r.code === 0 && r.summarized && r.fail === 0;
    if (!ok) broken += 1;
    const detail = r.summarized ? `${r.pass} pass, ${r.fail} fail` : `tidak selesai (exit ${r.code})`;
    console.log(`${ok ? 'OK  ' : 'GAGAL'}  ${r.file.padEnd(34)} ${detail} · ${r.seconds}s`);
    for (const line of r.failures) console.log(`        ${line}`);
  }

  console.log(`\nTotal: ${pass} pass, ${fail} fail, ${broken} berkas bermasalah dari ${results.length}.`);
  process.exit(broken ? 1 : 0);
}

main().catch((err) => {
  console.error('Runner gagal:', err);
  process.exit(1);
});
