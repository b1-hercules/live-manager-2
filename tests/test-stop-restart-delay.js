'use strict';

// Regresi: Stop yang ditekan selama JEDA auto-restart harus benar-benar
// menghentikan siaran. Dulu statusnya tertahan di 'stopping' selamanya: selama
// jeda, state masih ada di `running`, stop() memanggil killProcess() pada FFmpeg
// yang sudah keluar sendiri, tidak ada event 'close' baru, dan handleExit —
// tempat seluruh pembersihan final — tidak pernah berjalan lagi.
//
// Dipakai siaran video biasa dengan tujuan RTMP yang sengaja mati: FFmpeg gagal
// seketika dan handleExit masuk jeda restart 5 detik. Status dibaca dari
// database lewat koneksi read-only, bukan dari HTML (lihat FINDINGS).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(os.tmpdir(), `lm-stopdelay-backup-${Date.now()}.db`);
const PORT = 7587;
const DEAD_RTMP = PORT + 100; // tidak ada yang mendengarkan: FFmpeg gagal seketika
const BASE = `http://127.0.0.1:${PORT}`;
const USER = { username: `__test_stopdelay_${Date.now()}`, password: 'TestPassword!234' };

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(actual)}\n        want=${JSON.stringify(expected)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookies = {};
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
let ro = null;
let streamId = null;

async function main() {
  const Database = require('better-sqlite3');
  const ckpt = new Database(DB);
  ckpt.pragma('wal_checkpoint(TRUNCATE)');
  ckpt.close();
  fs.copyFileSync(DB, BACKUP);

  const file = `__test_stopdelay_${Date.now()}.mp4`;
  const abs = path.join(ROOT, 'storage', 'videos', file);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc=duration=5:size=640x480:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', abs], { stdio: 'pipe' });
  madeFiles.push(abs);

  const userModel = require(path.join(ROOT, 'models/user'));
  const videoModel = require(path.join(ROOT, 'models/video'));
  const destModel = require(path.join(ROOT, 'models/destination'));
  const streamModel = require(path.join(ROOT, 'models/stream'));
  const user = userModel.create(USER);
  const video = videoModel.create({
    user_id: user.id, title: 'Video Uji Stop', filename: file,
    filepath: `storage/videos/${file}`, filesize: fs.statSync(abs).size,
    duration: 5, width: 640, height: 480, fps: 25,
    video_codec: 'h264', audio_codec: 'aac', has_audio: 1,
  });
  const dest = destModel.create({
    user_id: user.id, name: 'Tujuan mati', platform: 'custom',
    rtmp_url: `rtmp://127.0.0.1:${DEAD_RTMP}/live`, stream_key: 'x',
  });
  const stream = streamModel.create(user.id, {
    title: 'Siaran Uji Stop saat jeda', video_id: video.id, encode_mode: 'copy',
    resolution: 'source', fps: 25, loop_video: 1, auto_restart: 1,
  }, [dest.id]);
  streamId = stream.id;
  require(path.join(ROOT, 'db')).db.close();

  server = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = Date.now() + 25000;
  for (;;) {
    try { await fetch(`${BASE}/login`, { redirect: 'manual' }); break; } catch (_) {
      if (Date.now() > ready) throw new Error('server tidak siap');
      await sleep(400);
    }
  }
  const loginPage = await (await req('/login')).text();
  const csrfLogin = loginPage.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  await req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...USER, _csrf: csrfLogin }).toString(),
  });
  const home = await (await req('/')).text();
  const token = home.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
  const post = (url) => req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token }).toString(),
  });

  ro = new Database(DB, { readonly: true, fileMustExist: true });
  const row = () => ro.prepare('SELECT status, restart_count, ended_at FROM streams WHERE id = ?').get(streamId);
  const hasRuntime = async () => {
    const ov = await (await req('/api/overview')).json();
    const s = ov.streams.find((x) => x.id === streamId);
    return Boolean(s && s.runtime);
  };
  const waitInDelay = async () => {
    // Jeda restart ditandai status 'starting' dengan restart_count >= 1.
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const r = row();
      if (r.status === 'starting' && r.restart_count >= 1) return true;
      await sleep(100);
    }
    return false;
  };
  const waitSettled = async () => {
    const until = Date.now() + 5000;
    while (Date.now() < until && row().status === 'stopping') await sleep(200);
  };

  // --- Stop di tengah jeda restart -----------------------------------------
  console.log('--- Stop selama jeda auto-restart ---');
  await post(`/streams/${streamId}/start`);
  check('masuk jeda restart otomatis', await waitInDelay(), true);

  await post(`/streams/${streamId}/stop`);
  await waitSettled();
  check('status idle, tidak tertahan di stopping', row().status, 'idle');
  check('ended_at tercatat', Boolean(row().ended_at), true);
  check('runtime tidak lagi tampil di dashboard', await hasRuntime(), false);

  // Melewati jeda restart 5 detik yang seharusnya sudah dibatalkan.
  await sleep(7000);
  check('masih idle setelah jeda lewat (restart benar-benar batal)', row().status, 'idle');

  // --- pengguna bisa memulai lagi, dan Stop kedua juga bersih ----------------
  console.log('\n--- Mulai lagi, lalu Stop di jeda berikutnya ---');
  await post(`/streams/${streamId}/start`);
  check('bisa dimulai lagi dan masuk jeda restart', await waitInDelay(), true);
  await post(`/streams/${streamId}/stop`);
  await waitSettled();
  check('Stop kedua juga berakhir idle', row().status, 'idle');
}

main()
  .catch((err) => { fail += 1; console.log('ERROR:', err.message, '\n', err.stack); })
  .finally(async () => {
    if (ro) { try { ro.close(); } catch (_) { /* sudah ditutup */ } }
    if (server) {
      const proc = server;
      if (proc.exitCode === null && proc.signalCode === null) {
        const closed = new Promise((r) => proc.once('close', r));
        proc.kill('SIGTERM');
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { /* sudah mati */ } }, 8000);
        await closed;
        clearTimeout(t);
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
