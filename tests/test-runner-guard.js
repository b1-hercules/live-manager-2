'use strict';

// Runner harus menolak jalan selagi ada LiveManager yang hidup.
//
// Tes integrasi mengembalikan db/livemanager.db dari backup lalu menghapus
// -wal/-shm-nya. Aplikasi yang sedang memegang berkas itu — container Docker
// lewat volume ./db:/app/db, atau proses PM2/npm di host — tidak tahu isinya
// berganti. Yang rusak bukan tesnya, melainkan data pengguna: persis itu yang
// terjadi pada 2026-09-12, dan penjaga ini yang mencegahnya terulang.
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { readPort, probe, DEFAULT_PORT } = require('./lib/running-app');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(actual)}\n        want=${JSON.stringify(expected)}`);
}

/** Server sekali pakai di port acak; resolve dengan { port, close }. */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const HEALTH = { ok: true, uptime: 12, activeStreams: 0, ffmpeg: true, version: '1.0.0' };

function portFree(port) {
  return new Promise((resolve) => {
    const probeSocket = net.createServer();
    probeSocket.once('error', () => resolve(false));
    probeSocket.once('listening', () => probeSocket.close(() => resolve(true)));
    probeSocket.listen(port, '127.0.0.1');
  });
}

/**
 * Runner di dalam runner. Kuncinya dialihkan lewat LM_TEST_LOCK: tanpa itu,
 * saat tes ini dijalankan sebagai bagian dari `npm test`, yang bersarang
 * berebut kunci milik yang di luar — dan menghapusnya saat selesai.
 */
function runRunner(args, lockFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'run.js'), ...args], {
      cwd: ROOT,
      env: { ...process.env, LM_TEST_LOCK: lockFile },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function main() {
  // ---- readPort ----------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-guard-'));
  const envFile = (contents) => {
    const file = path.join(tmp, `env-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(file, contents);
    return file;
  };

  check('PORT dibaca dari .env', readPort(envFile('PORT=8080\n')), 8080);
  check('tanda kutip dibuang', readPort(envFile('PORT="9090"\n')), 9090);
  check('spasi di sekitar tanda sama dengan dimaafkan', readPort(envFile('PORT = 8181\n')), 8181);
  // Pembacaan .env pada umumnya memenangkan baris terakhir; penjaga ini harus ikut.
  check('baris PORT terakhir yang menang', readPort(envFile('PORT=1111\nPORT=2222\n')), 2222);
  check('tanpa PORT → 7575', readPort(envFile('APP_URL=http://localhost:7575\n')), DEFAULT_PORT);
  check('PORT bukan angka → 7575', readPort(envFile('PORT=abc\n')), DEFAULT_PORT);
  check('.env tidak ada → 7575', readPort(path.join(tmp, 'tidak-ada')), DEFAULT_PORT);

  // ---- probe -------------------------------------------------------------
  const live = await serve((req, res) => json(res, HEALTH));
  check('LiveManager menjawab → terdeteksi hidup', (await probe(live.port)).running, true);
  check('versinya ikut terbaca', (await probe(live.port)).version, '1.0.0');
  await live.close();

  check('tidak ada yang mendengarkan → tidak hidup', (await probe(live.port)).running, false);

  // Port yang kebetulan dipakai aplikasi lain tidak boleh membuat tes menolak
  // jalan, jadi bentuk jawabannya ikut diperiksa — bukan cuma status 200.
  const stranger = await serve((req, res) => json(res, { status: 'ok', service: 'lain' }));
  check('aplikasi lain di port itu → tidak dianggap LiveManager', (await probe(stranger.port)).running, false);
  await stranger.close();

  const broken = await serve((req, res) => json(res, { error: 'aduh' }, 500));
  check('/health menjawab 500 → tidak dianggap hidup', (await probe(broken.port)).running, false);
  await broken.close();

  const html = await serve((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>hai</h1>'); });
  check('jawaban bukan JSON → tidak dianggap hidup', (await probe(html.port)).running, false);
  await html.close();

  const slow = await serve(() => { /* sengaja tidak pernah menjawab */ });
  const startedAt = Date.now();
  check('server yang menggantung → timeout, tidak hidup', (await probe(slow.port, 300)).running, false);
  check('timeout benar-benar dihormati (< 3 detik)', Date.now() - startedAt < 3000, true);
  await slow.close();

  // ---- runner menolak jalan ----------------------------------------------
  // Port aplikasi sungguhan dipakai supaya yang diuji adalah jalur yang sama
  // dengan yang dipakai runner. Kalau portnya sedang dipakai container yang
  // hidup, bagian ini dilewati — bukan digagalkan.
  const appPort = readPort();
  if (await portFree(appPort)) {
    const fake = http.createServer((req, res) => json(res, HEALTH));
    await new Promise((r) => fake.listen(appPort, '127.0.0.1', r));

    const lockFile = path.join(tmp, 'runner.lock');
    // Kunci runner yang sebenarnya: ada kalau tes ini dijalankan sebagai bagian
    // dari `npm test`, tidak ada kalau dijalankan sendiri. Apa pun keadaannya,
    // runner bersarang tidak boleh mengubahnya.
    const realLock = path.join(__dirname, '.run.lock');
    const realLockBefore = fs.existsSync(realLock) ? fs.readFileSync(realLock, 'utf8') : null;

    const refused = await runRunner(['filetype'], lockFile);
    check('aplikasi hidup → runner keluar dengan kode 1', refused.code, 1);
    check('pesannya menyebut portnya', refused.out.includes(`port ${appPort}`), true);
    check('pesannya menyebut cara menghentikan Docker', refused.out.includes('docker compose stop'), true);
    check('pesannya menyebut cara menghentikan PM2', refused.out.includes('pm2 stop livemanager'), true);
    check('pesannya menyebut jalan keluarnya', refused.out.includes('--skip-app-check'), true);
    check('tidak ada tes yang sempat dijalankan', /▶ test-/.test(refused.out), false);

    // Bendera pelarian harus benar-benar melewati penjaga, dan tidak boleh
    // ikut terbaca sebagai saringan nama berkas.
    const forced = await runRunner(['filetype', '--skip-app-check'], lockFile);
    check('--skip-app-check → tesnya jalan', forced.code, 0);
    check('--skip-app-check → hanya berkas yang disaring yang jalan',
      (forced.out.match(/▶ test-/g) || []).length, 1);
    check('--skip-app-check tidak dianggap nama berkas',
      forced.out.includes('Tidak ada tes yang cocok'), false);

    check('kunci yang dialihkan dilepas setelah selesai', fs.existsSync(lockFile), false);
    check('kunci runner asli tidak tersentuh',
      fs.existsSync(realLock) ? fs.readFileSync(realLock, 'utf8') : null, realLockBefore);

    await new Promise((r) => fake.close(r));
  } else {
    console.log(`info  port ${appPort} sedang dipakai (aplikasi hidup?), bagian runner dilewati`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('ERROR:', err); process.exit(1); });
