'use strict';

// Siaran ala radio yang SUNGGUHAN: liquidsoap asli, FFmpeg asli, sink RTMP
// lokal, lewat route yang sama dengan tombol Mulai.
//
// Tes ini mustahil di Windows (liquidsoap tidak ada di sana), dan justru karena
// itu dua cacat lolos sampai liquidsoap pertama kali dijalankan di Linux:
//   1. liquidsoap sungguhan butuh ±15 detik sebelum harbor terbuka, sedangkan
//      FFmpeg dijalankan seketika dan `-reconnect` tidak menolong koneksi
//      pertama — FFmpeg mati dalam 0,2 detik, lalu restart otomatis memulai
//      KEDUA proses dari nol sehingga harbor tidak pernah sempat siap;
//   2. spawn() tidak melempar untuk binary yang tidak bisa dijalankan, jadi
//      liquidsoap yang langsung mati berakhir di restart berulang (±12,6 menit)
//      alih-alih gagal dengan pesan yang jelas.
//
// Tanpa liquidsoap, tes ini dilewati (SKIP), bukan gagal. Status siaran dibaca
// dari database lewat koneksi read-only, bukan dari HTML (lihat FINDINGS).

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(os.tmpdir(), `lm-radiolive-backup-${Date.now()}.db`);
const PORT = 7596;
const SINK_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = { username: `__test_radio_${Date.now()}`, password: 'TestPassword!234' };

// ---- lewati kalau liquidsoap tidak ada ----------------------------------
const envBinary = process.env.LIQUIDSOAP_PATH;
const BINARY = envBinary && fs.existsSync(envBinary) ? envBinary : 'liquidsoap';
try {
  execFileSync(BINARY, ['--version'], { stdio: 'pipe', timeout: 30000 });
} catch (err) {
  console.log(`SKIP  liquidsoap tidak tersedia (${String(err.message).split('\n')[0].slice(0, 80)})`);
  console.log('\n0 pass, 0 fail');
  process.exit(0);
}

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(actual)}\n        want=${JSON.stringify(expected)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookies = {};
async function req(url, opts = {}) {
  const res = await fetch(BASE + url, {
    ...opts,
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      ...(opts.headers || {}),
    },
  });
  for (const raw of res.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return res;
}

const madeFiles = [];
let server = null;
let sink = null;
let ro = null;
let streamId = null;

// ---- server ---------------------------------------------------------------

async function bootServer(extraEnv = {}) {
  server = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (/ERROR/.test(s)) console.log('[server]', s.slice(0, 170));
  });
  const deadline = Date.now() + 25000;
  for (;;) {
    try { await fetch(`${BASE}/login`, { redirect: 'manual' }); break; } catch (_) {
      if (Date.now() > deadline) throw new Error('server tidak siap');
      await sleep(400);
    }
  }

  cookies = {};
  const loginPage = await (await req('/login')).text();
  const csrfLogin = loginPage.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  await req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...USER, _csrf: csrfLogin }).toString(),
  });
  const home = await (await req('/')).text();
  const token = home.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
  return (url, fields = {}) => req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
}

async function stopServer() {
  if (!server) return;
  const proc = server;
  server = null;
  if (proc.exitCode === null && proc.signalCode === null) {
    const closed = new Promise((r) => proc.once('close', r));
    proc.kill('SIGTERM');
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { /* sudah mati */ } }, 8000);
    await closed;
    clearTimeout(timer);
  }
}

// ---- pengamatan -------------------------------------------------------------

function streamRow() {
  return ro.prepare('SELECT status, restart_count, error_message FROM streams WHERE id = ?').get(streamId);
}

async function runtimeOf() {
  const live = await (await req('/api/overview')).json();
  return live.streams.find((s) => s.id === streamId) || null;
}

function engineAlive() {
  return spawnSync('pgrep', ['-f', `radio_${streamId}\\.liq`]).status === 0;
}

/** Soket LISTEN pada port tertentu, dibaca langsung dari kernel. */
function listenersOn(port) {
  const found = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue;
      const [addr, portHex] = cols[1].split(':');
      if (parseInt(portHex, 16) === port) found.push(addr);
    }
  }
  return found;
}

// ---- unit: waitForHarbor ------------------------------------------------------

async function unitWaitForHarbor() {
  console.log('--- waitForHarbor (unit) ---');
  const liquidsoap = require(path.join(ROOT, 'services/liquidsoap'));
  if (typeof liquidsoap.waitForHarbor !== 'function') {
    check('liquidsoap.waitForHarbor ada', typeof liquidsoap.waitForHarbor, 'function');
    return;
  }
  const settle = (p) => p.then(() => true, (e) => e);

  // Binary yang tidak ada: spawn() TIDAK melempar, jadi penolakannya harus
  // datang dari event 'error' — dan cepat, bukan menunggu batas waktu habis.
  let t0 = Date.now();
  const missing = spawn('liquidsoap-tidak-ada-di-mana-pun', [], { stdio: ['ignore', 'pipe', 'pipe'] });
  const e1 = await settle(liquidsoap.waitForHarbor(PORT + 200, missing, { timeoutMs: 10000 }));
  check('binary hilang -> kode ENGINE_MISSING', e1 && e1.code, 'ENGINE_MISSING');
  check('binary hilang -> ditolak dalam < 2 dtk', Date.now() - t0 < 2000, true);

  // Proses yang langsung keluar — misalnya liquidsoap yang menolak jalan
  // sebagai root, atau skrip yang ditolak pemeriksa tipenya.
  t0 = Date.now();
  const quits = spawn('sh', ['-c', 'exit 3'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const e2 = await settle(liquidsoap.waitForHarbor(PORT + 201, quits, { timeoutMs: 10000 }));
  check('keluar dini -> kode ENGINE_EXITED', e2 && e2.code, 'ENGINE_EXITED');
  check('keluar dini -> pesan menyebut kode keluarnya', /\b3\b/.test(e2 && e2.message ? e2.message : ''), true);
  check('keluar dini -> ditolak dalam < 2 dtk', Date.now() - t0 < 2000, true);

  // Harbor yang baru membuka port belakangan: inilah perilaku liquidsoap asli.
  const alive = spawn('sleep', ['30']);
  const late = net.createServer((s) => s.destroy());
  setTimeout(() => late.listen(PORT + 202, '127.0.0.1'), 1500);
  t0 = Date.now();
  const ok = await settle(liquidsoap.waitForHarbor(PORT + 202, alive, { timeoutMs: 10000 }));
  const waited = Date.now() - t0;
  check('port yang terbuka belakangan -> ditunggu sampai siap', ok, true);
  check('benar-benar menunggu port terbuka (>= 1,4 dtk)', waited >= 1400, true);
  late.close();
  alive.kill();

  // Dibatalkan dari luar: siaran dihentikan selama menunggu harbor.
  const waiting = spawn('sleep', ['30']);
  let abort = false;
  setTimeout(() => { abort = true; }, 600);
  t0 = Date.now();
  const e4 = await settle(liquidsoap.waitForHarbor(PORT + 204, waiting, {
    timeoutMs: 10000, shouldAbort: () => abort,
  }));
  check('dibatalkan -> kode ABORTED', e4 && e4.code, 'ABORTED');
  check('dibatalkan -> berhenti dalam < 2 dtk', Date.now() - t0 < 2000, true);
  waiting.kill();

  // Port yang tidak pernah terbuka.
  const stuck = spawn('sleep', ['30']);
  const e3 = await settle(liquidsoap.waitForHarbor(PORT + 203, stuck, { timeoutMs: 1000 }));
  check('port tak pernah terbuka -> kode HARBOR_TIMEOUT', e3 && e3.code, 'HARBOR_TIMEOUT');
  stuck.kill();
}

// ---- utama ------------------------------------------------------------------

async function main() {
  const Database = require('better-sqlite3');
  const ckpt = new Database(DB);
  ckpt.pragma('wal_checkpoint(TRUNCATE)');
  ckpt.close();
  fs.copyFileSync(DB, BACKUP);

  await unitWaitForHarbor();

  // --- fixture: lagu, latar, playlist musik, tujuan, siaran ---------------
  const stamp = Date.now();
  const trackAbs = path.join(ROOT, 'storage', 'videos', `__test_radiolive_${stamp}.mp3`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', trackAbs], { stdio: 'pipe' });
  madeFiles.push(trackAbs);
  const bgAbs = path.join(ROOT, 'storage', 'thumbnails', `__test_radiolive_${stamp}.png`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=teal:size=1280x720:d=1',
    '-frames:v', '1', bgAbs], { stdio: 'pipe' });
  madeFiles.push(bgAbs);
  const relative = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

  const userModel = require(path.join(ROOT, 'models/user'));
  const videoModel = require(path.join(ROOT, 'models/video'));
  const playlistModel = require(path.join(ROOT, 'models/playlist'));
  const destModel = require(path.join(ROOT, 'models/destination'));
  const streamModel = require(path.join(ROOT, 'models/stream'));
  const backgroundModel = require(path.join(ROOT, 'models/streamBackground'));

  const user = userModel.create(USER);
  const track = videoModel.create({
    user_id: user.id, title: 'Lagu Uji Radio', filename: path.basename(trackAbs),
    filepath: relative(trackAbs), filesize: fs.statSync(trackAbs).size,
    duration: 12, kind: 'audio', has_audio: 1, audio_codec: 'mp3',
  });
  const playlist = playlistModel.create(user.id, { name: 'Playlist Radio Sungguhan', kind: 'audio' });
  playlistModel.addItem(playlist.id, track.id);
  const dest = destModel.create({
    user_id: user.id, name: 'Sink Radio', platform: 'custom',
    rtmp_url: `rtmp://127.0.0.1:${SINK_PORT}/live`, stream_key: 'uji',
  });
  const stream = streamModel.create(user.id, {
    title: 'Siaran Radio Sungguhan', playlist_id: playlist.id, resolution: '720p',
    fps: 24, preset: 'ultrafast', auto_restart: 1,
  }, [dest.id]);
  streamId = stream.id;
  backgroundModel.add(streamId, relative(bgAbs));
  require(path.join(ROOT, 'db')).db.close();

  // --- kasus 1: siaran radio sungguhan mengalir --------------------------
  console.log('\n--- siaran radio sungguhan ---');
  let post = await bootServer();
  ro = new Database(DB, { readonly: true, fileMustExist: true });

  let sinkLog = '';
  sink = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'info', '-listen', '1',
    '-i', `rtmp://127.0.0.1:${SINK_PORT}/live/uji`, '-c', 'copy', '-f', 'null', '-'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  sink.stderr.on('data', (d) => { sinkLog += d; });
  await sleep(1200);

  let t0 = Date.now();
  const started = await post(`/streams/${streamId}/start`);
  const postMs = Date.now() - t0;
  console.log(`        POST /start dijawab setelah ${postMs} ms`);
  check('POST /start dijawab dengan redirect', started.status, 302);

  let running = null;
  const deadline = Date.now() + 60000;
  for (;;) {
    running = await runtimeOf();
    if (running && running.runtime && running.runtime.stats.frame > 0) break;
    if (Date.now() > deadline) break;
    await sleep(500);
  }
  const flowing = Boolean(running && running.runtime && running.runtime.stats.frame > 0);
  check('siaran radio benar-benar mengalir ke sink', flowing, true);
  if (flowing) console.log(`        frame=${running.runtime.stats.frame} bitrate=${running.runtime.stats.bitrate}`);
  check('status live', streamRow().status, 'live');
  check('tanpa satu pun restart', streamRow().restart_count, 0);
  // Sink baru mencetak susunan stream-nya setelah selesai menganalisis input
  // (analyzeduration FLV beberapa detik); frame pertama saja belum cukup.
  const hasTracks = () => /Stream #0:\d+.*Video:/.test(sinkLog) && /Stream #0:\d+.*Audio:/.test(sinkLog);
  const sinkDeadline = Date.now() + 15000;
  while (Date.now() < sinkDeadline && !hasTracks()) await sleep(300);
  check('sink menerima track video', /Stream #0:\d+.*Video:/.test(sinkLog), true);
  check('sink menerima track audio', /Stream #0:\d+.*Audio:/.test(sinkLog), true);

  const scriptPath = path.join(ROOT, 'storage', 'tmp', `radio_${streamId}.liq`);
  const harborPort = Number((fs.existsSync(scriptPath)
    ? fs.readFileSync(scriptPath, 'utf8').match(/port=(\d+)/) : null)?.[1]);
  const bound = harborPort ? listenersOn(harborPort) : [];
  check('harbor mendengarkan', bound.length > 0, true);
  check('harbor HANYA di 127.0.0.1', bound.length > 0 && bound.every((a) => a === '0100007F'), true);

  await post(`/streams/${streamId}/stop`);
  const stopDeadline = Date.now() + 15000;
  while (Date.now() < stopDeadline && (streamRow().status === 'live' || engineAlive())) await sleep(300);
  check('berhenti rapi (tidak live lagi)', streamRow().status !== 'live', true);
  check('liquidsoap ikut mati setelah Stop', engineAlive(), false);
  check('port harbor dilepas', harborPort ? listenersOn(harborPort).length : 0, 0);
  check('skrip .liq dibersihkan', fs.existsSync(scriptPath), false);

  // --- kasus 1b: Mulai ganda dan Stop selama menunggu harbor ---------------
  // Selama ±15 detik menunggu, siarannya belum masuk `running`. Tanpa penjaga,
  // Mulai kedua menjalankan liquidsoap kedua di port yang sama, dan Stop tidak
  // punya proses untuk dihentikan sehingga siaran tetap live begitu harbor siap.
  console.log('\n--- Mulai ganda & Stop selama menunggu harbor ---');
  t0 = Date.now();
  const pending = post(`/streams/${streamId}/start`);
  const loadDeadline = Date.now() + 10000;
  while (Date.now() < loadDeadline && !engineAlive()) await sleep(200);
  check('liquidsoap sedang dimuat', engineAlive(), true);

  let t1 = Date.now();
  await post(`/streams/${streamId}/start`);
  check('Mulai kedua dijawab seketika (< 3 dtk)', Date.now() - t1 < 3000, true);
  const engines = Number(String(spawnSync('pgrep', ['-fc', `radio_${streamId}\\.liq`]).stdout).trim() || 0);
  check('tetap hanya SATU liquidsoap', engines, 1);

  t1 = Date.now();
  await post(`/streams/${streamId}/stop`);
  await pending;
  const cancelMs = Date.now() - t1;
  console.log(`        Mulai pertama selesai ${cancelMs} ms setelah Stop (total ${Date.now() - t0} ms)`);
  check('Mulai pertama berhenti menunggu begitu Stop ditekan (< 3 dtk)', cancelMs < 3000, true);
  const engineGone = Date.now() + 8000;
  while (Date.now() < engineGone && engineAlive()) await sleep(200);
  check('liquidsoap dimatikan', engineAlive(), false);
  check('status idle, bukan live/error', streamRow().status, 'idle');
  await sleep(1500);
  const cancelled = await runtimeOf();
  check('FFmpeg tidak pernah dijalankan', Boolean(cancelled && cancelled.runtime), false);

  ro.close();
  ro = null;
  await stopServer();
  if (sink) { sink.kill(); sink = null; }
  spawnSync('pkill', ['-f', `radio_${streamId}\\.liq`]);

  // --- kasus 2: liquidsoap langsung keluar -> gagal cepat, tanpa restart ---
  console.log('\n--- liquidsoap yang langsung keluar ---');
  const stub = path.join(os.tmpdir(), `lm-liquidsoap-stub-${stamp}.sh`);
  fs.writeFileSync(stub, '#!/bin/sh\necho "stub uji: liquidsoap menolak dijalankan" >&2\nexit 1\n', { mode: 0o755 });
  madeFiles.push(stub);

  post = await bootServer({ LIQUIDSOAP_PATH: stub });
  ro = new Database(DB, { readonly: true, fileMustExist: true });

  t0 = Date.now();
  await post(`/streams/${streamId}/start`);
  console.log(`        POST /start dijawab setelah ${Date.now() - t0} ms`);

  const errDeadline = Date.now() + 10000;
  while (Date.now() < errDeadline && streamRow().status !== 'error') await sleep(250);
  const row = streamRow();
  check('status error dalam 10 dtk', row.status, 'error');
  check('tanpa restart otomatis', row.restart_count, 0);
  check('pesan menyebut liquidsoap', /liquidsoap/i.test(row.error_message || ''), true);
  check('pesan memuat keluaran liquidsoap sendiri', /stub uji/.test(row.error_message || ''), true);
  console.log(`        error_message=${JSON.stringify(row.error_message)}`);

  // Kalau restart berulang terjadi, statusnya akan berpindah lagi dari error.
  await sleep(7000);
  check('masih error 7 dtk kemudian (tidak berputar restart)', streamRow().status, 'error');
  const after = await runtimeOf();
  check('tidak ada proses siaran yang tertinggal', Boolean(after && after.runtime), false);
}

main()
  .catch((err) => { fail += 1; console.log('ERROR:', err.message, '\n', err.stack); })
  .finally(async () => {
    if (sink) sink.kill();
    if (ro) { try { ro.close(); } catch (_) { /* sudah ditutup */ } }
    await stopServer();
    if (streamId) {
      const orphan = spawnSync('pkill', ['-f', `radio_${streamId}\\.liq`]).status === 0;
      if (orphan) console.log('        (liquidsoap yatim ditemukan dan dimatikan saat pembersihan)');
      const tmp = path.join(ROOT, 'storage', 'tmp');
      for (const name of fs.readdirSync(tmp)) {
        if (new RegExp(`^(radio_${streamId}\\.(m3u|liq)|radiobg_${streamId}_\\d+\\.bmp|radiobg_${streamId}\\.txt)$`).test(name)) {
          try { fs.unlinkSync(path.join(tmp, name)); } catch (_) { /* sudah hilang */ }
        }
      }
    }
    setTimeout(() => {
      fs.copyFileSync(BACKUP, DB);
      for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch (_) { /* tidak ada */ } }
      fs.unlinkSync(BACKUP);
      for (const f of madeFiles) { try { fs.unlinkSync(f); } catch (_) { /* sudah hilang */ } }
      console.log(`\nDB dikembalikan.\n${pass} pass, ${fail} fail`);
      process.exit(fail ? 1 : 0);
    }, 900);
  });
