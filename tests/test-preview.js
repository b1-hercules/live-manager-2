'use strict';

// Tes pratinjau video: markup galeri + kemampuan Range request pada /media
// (tanpa Range, scrub di player tidak jalan).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(require('os').tmpdir(), `lm-prev-backup-${Date.now()}.db`);
const PORT = 7595;
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

let cookies = {};
async function req(url, opts = {}) {
  const res = await fetch(BASE + url, {
    ...opts,
    redirect: 'manual',
    headers: {
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

async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);

  // --- file video sungguhan di storage ---------------------------------
  const videosDir = path.join(ROOT, 'storage', 'videos');
  const mp4Name = `__test_preview_${Date.now()}.mp4`;
  const mkvName = `__test_preview_${Date.now()}.mkv`;
  const mp4Abs = path.join(videosDir, mp4Name);
  const mkvAbs = path.join(videosDir, mkvName);
  for (const [out, extra] of [[mp4Abs, ['-pix_fmt', 'yuv420p']], [mkvAbs, []]]) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc=duration=2:size=320x240:rate=10', ...extra, out], { stdio: 'pipe' });
    madeFiles.push(out);
  }

  const userModel = require(path.join(ROOT, 'models/user'));
  const videoModel = require(path.join(ROOT, 'models/video'));
  const user = userModel.create(USER);
  const mp4 = videoModel.create({
    user_id: user.id, title: 'Klip Uji MP4', filename: mp4Name,
    filepath: `storage/videos/${mp4Name}`, filesize: fs.statSync(mp4Abs).size,
    duration: 2, width: 320, height: 240, fps: 10, video_codec: 'h264', has_audio: 0,
  });
  const mkv = videoModel.create({
    user_id: user.id, title: 'Klip Uji MKV "quote"', filename: mkvName,
    filepath: `storage/videos/${mkvName}`, filesize: fs.statSync(mkvAbs).size,
    duration: 2, width: 320, height: 240, fps: 10, video_codec: 'h264', has_audio: 0,
  });
  require(path.join(ROOT, 'db')).db.close();

  // --- boot -------------------------------------------------------------
  server = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => console.log('[server:err]', String(d).trim().slice(0, 160)));
  const deadline = Date.now() + 25000;
  for (;;) {
    try { await fetch(`${BASE}/login`, { redirect: 'manual' }); break; } catch (_) {
      if (Date.now() > deadline) throw new Error('server tidak siap');
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const loginPage = await (await req('/login')).text();
  const token = loginPage.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  check('login berhasil', (await req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...USER, _csrf: token }).toString(),
  })).status, 302);

  // --- markup galeri ----------------------------------------------------
  const page = await (await req('/videos')).text();
  check('pemicu pratinjau ada untuk tiap video', (page.match(/data-preview-src/g) || []).length, 2);
  check('src menunjuk file video, bukan thumbnail', page.includes(`data-preview-src="/media/videos/${mp4Name}"`), true);
  check('tombol play ter-render', (page.match(/class="play-badge"/g) || []).length, 2);
  check('judul ikut dikirim ke modal', page.includes('data-preview-title="Klip Uji MP4"'), true);
  // Judul dengan tanda kutip harus lolos escaping EJS, bukan merusak atribut.
  check('judul bertanda kutip di-escape', page.includes('data-preview-title="Klip Uji MKV &#34;quote&#34;"'), true);

  // --- /media melayani video + mendukung Range --------------------------
  const full = await req(`/media/videos/${mp4Name}`);
  check('GET /media video → 200', full.status, 200);
  check('accept-ranges: bytes (syarat scrub)', full.headers.get('accept-ranges'), 'bytes');

  const ranged = await req(`/media/videos/${mp4Name}`, { headers: { Range: 'bytes=0-99' } });
  check('Range request → 206 Partial Content', ranged.status, 206);
  check('content-length sesuai range', ranged.headers.get('content-length'), '100');
  check('content-range terpasang', /^bytes 0-99\//.test(ranged.headers.get('content-range') || ''), true);

  // --- /media tetap butuh login ----------------------------------------
  const noAuth = await fetch(`${BASE}/media/videos/${mp4Name}`, { redirect: 'manual' });
  check('/media tanpa sesi tidak menyajikan file', noAuth.status !== 200 && noAuth.status !== 206, true);

  console.log(`        (video #${mp4.id} & #${mkv.id}, status /media tanpa login: ${noAuth.status})`);
}

main()
  .catch((err) => { fail += 1; console.log('ERROR:', err.message); })
  .finally(() => {
    if (server) server.kill();
    setTimeout(() => {
      fs.copyFileSync(BACKUP, DB);
      for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch (_) { /* tidak ada */ } }
      fs.unlinkSync(BACKUP);
      for (const f of madeFiles) { try { fs.unlinkSync(f); } catch (_) { /* sudah hilang */ } }
      console.log(`\nDB dikembalikan, ${madeFiles.length} file uji dihapus.\n${pass} pass, ${fail} fail`);
      process.exit(fail ? 1 : 0);
    }, 600);
  });
