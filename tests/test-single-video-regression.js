'use strict';

// Regresi jalur video tunggal setelah start() di-refactor ke resolveSource().
// Ini kasus pemakaian paling umum dan paling berisiko dari perubahan playlist:
// siaran satu video harus tetap benar-benar mengalir, berhenti rapi, dan
// tidak meninggalkan berkas concat.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(os.tmpdir(), `lm-single-backup-${Date.now()}.db`);
const PORT = 7588;
const SINK_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = { username: `__test_${Date.now()}`, password: 'TestPassword!234' };

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(actual)}\n        want=${JSON.stringify(expected)}`);
}

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
let sink = null;

async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);

  const file = `__test_single_${Date.now()}.mp4`;
  const abs = path.join(ROOT, 'storage', 'videos', file);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc=duration=5:size=640x480:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', abs], { stdio: 'pipe' });
  madeFiles.push(abs);

  const userModel = require(path.join(ROOT, 'models/user'));
  const videoModel = require(path.join(ROOT, 'models/video'));
  const destModel = require(path.join(ROOT, 'models/destination'));
  const user = userModel.create(USER);
  const video = videoModel.create({
    user_id: user.id, title: 'Video Tunggal', filename: file,
    filepath: `storage/videos/${file}`, filesize: fs.statSync(abs).size,
    duration: 5, width: 640, height: 480, fps: 25,
    video_codec: 'h264', audio_codec: 'aac', has_audio: 1,
  });
  const dest = destModel.create({
    user_id: user.id, name: 'Sink', platform: 'custom',
    rtmp_url: `rtmp://127.0.0.1:${SINK_PORT}/live`, stream_key: 'uji',
  });
  require(path.join(ROOT, 'db')).db.close();

  server = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
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
      await new Promise((r) => setTimeout(r, 400));
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
  const post = (url, fields) => req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });

  // --- buat stream video tunggal (tanpa menyentuh playlist sama sekali) ---
  console.log('--- stream video tunggal ---');
  const created = await post('/streams', {
    title: 'Siaran Video Tunggal', video_id: String(video.id), playlist_id: '',
    destination_ids: String(dest.id), encode_mode: 'copy', resolution: 'source',
    orientation: 'landscape', bitrate: '2500', audio_bitrate: '128', fps: '25',
    preset: 'ultrafast', loop_video: '1',
  });
  check('stream dibuat', created.status, 302);
  const streamId = Number(created.headers.get('location').split('/').pop());

  const detail = await (await req(`/streams/${streamId}`)).text();
  check('detail menampilkan video sumber', /Video Tunggal/.test(detail), true);
  check('pratinjau TIDAK memakai concat', /-f concat/.test(detail), false);
  check('daftar stream tidak salah menandai playlist', /playlist/i.test(
    (await (await req('/streams')).text()).split('Siaran Video Tunggal')[1]?.slice(0, 200) || ''), false);

  // --- siaran nyata ------------------------------------------------------
  console.log('\n--- siaran nyata ---');
  sink = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-listen', '1',
    '-i', `rtmp://127.0.0.1:${SINK_PORT}/live/uji`, '-c', 'copy', '-f', 'null', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 1200));

  await post(`/streams/${streamId}/start`, {});

  let running = null;
  const untilStats = Date.now() + 30000;
  for (;;) {
    const live = await (await req('/api/overview')).json();
    running = live.streams.find((s) => s.id === streamId);
    if (running && running.runtime && running.runtime.stats.frame > 0) break;
    if (Date.now() > untilStats) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('stream video tunggal live', running.status, 'live');
  check('siaran benar-benar mengalir', Boolean(running.runtime && running.runtime.stats.frame > 0), true);
  console.log(`        frame=${running.runtime.stats.frame} bitrate=${running.runtime.stats.bitrate}`);

  // Video tunggal tidak boleh membuat berkas concat sama sekali.
  const concatFile = path.join(ROOT, 'storage/tmp', `playlist_${streamId}.txt`);
  check('tidak ada berkas concat untuk video tunggal', fs.existsSync(concatFile), false);

  await post(`/streams/${streamId}/stop`, {});
  await new Promise((r) => setTimeout(r, 2500));
  const after = await (await req('/api/overview')).json();
  const stopped = after.streams.find((s) => s.id === streamId);
  check('berhenti rapi (tidak live lagi)', stopped.status !== 'live', true);
}

main()
  .catch((err) => { fail += 1; console.log('ERROR:', err.message, '\n', err.stack); })
  .finally(() => {
    if (sink) sink.kill();
    if (server) server.kill();
    setTimeout(() => {
      fs.copyFileSync(BACKUP, DB);
      for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch (_) { /* tidak ada */ } }
      fs.unlinkSync(BACKUP);
      for (const f of madeFiles) { try { fs.unlinkSync(f); } catch (_) { /* sudah hilang */ } }
      console.log(`\nDB dikembalikan.\n${pass} pass, ${fail} fail`);
      process.exit(fail ? 1 : 0);
    }, 900);
  });
