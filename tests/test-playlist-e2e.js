'use strict';

// Playlist end-to-end: CRUD, reorder, kepemilikan, penolakan playlist tidak
// seragam, dan siaran nyata (FFmpeg benar-benar dijalankan streamManager).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(os.tmpdir(), `lm-pl-backup-${Date.now()}.db`);
const PORT = 7590;
const BASE = `http://127.0.0.1:${PORT}`;
const A = { username: `__test_a_${Date.now()}`, password: 'TestPassword!234' };
const B = { username: `__test_b_${Date.now()}`, password: 'TestPassword!234' };

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(actual)}\n        want=${JSON.stringify(expected)}`);
}

function jar() {
  const cookies = {};
  return {
    async req(url, opts = {}) {
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
    },
  };
}
async function login(client, creds) {
  const page = await (await client.req('/login')).text();
  const token = page.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  await client.req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...creds, _csrf: token }).toString(),
  });
  const home = await (await client.req('/')).text();
  return home.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
}
const formPost = (client, token) => (url, fields) => client.req(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
});

const madeFiles = [];
let server = null;
let rtmpSink = null;

async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);

  // --- tiga video: dua seragam, satu beda resolusi -----------------------
  const videosDir = path.join(ROOT, 'storage', 'videos');
  const specs = [
    ['a', '640x480', 25], ['b', '640x480', 25], ['beda', '1280x720', 30],
  ];
  const made = {};
  for (const [name, size, rate] of specs) {
    const file = `__test_pl_${name}_${Date.now()}.mp4`;
    const abs = path.join(videosDir, file);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
      `testsrc=duration=4:size=${size}:rate=${rate}`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', abs], { stdio: 'pipe' });
    madeFiles.push(abs);
    made[name] = { file, abs, size, rate };
  }

  const userModel = require(path.join(ROOT, 'models/user'));
  const videoModel = require(path.join(ROOT, 'models/video'));
  const destModel = require(path.join(ROOT, 'models/destination'));
  const userA = userModel.create(A);
  userModel.create(B);

  const vids = {};
  for (const [name, info] of Object.entries(made)) {
    const [w, h] = info.size.split('x').map(Number);
    vids[name] = videoModel.create({
      user_id: userA.id, title: `Klip ${name}`, filename: info.file,
      filepath: `storage/videos/${info.file}`, filesize: fs.statSync(info.abs).size,
      duration: 4, width: w, height: h, fps: info.rate,
      video_codec: 'h264', audio_codec: 'aac', has_audio: 1,
    });
  }
  // Tujuan RTMP ke sink lokal supaya siaran benar-benar bisa berjalan.
  const dest = destModel.create({
    user_id: userA.id, name: 'Sink Lokal', platform: 'custom',
    rtmp_url: `rtmp://127.0.0.1:${PORT + 100}/live`, stream_key: 'uji',
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

  const alice = jar();
  const bob = jar();
  const tokenA = await login(alice, A);
  const tokenB = await login(bob, B);
  const postA = formPost(alice, tokenA);
  const postB = formPost(bob, tokenB);

  // ------------------------------------------------------------ CRUD
  console.log('--- playlist CRUD ---');
  const created = await postA('/playlists', { name: 'Playlist Uji' });
  check('buat playlist → redirect', created.status, 302);
  const plId = Number(created.headers.get('location').split('/').pop());
  check('id playlist terbaca', Number.isFinite(plId), true);

  const emptyPage = await (await alice.req(`/playlists/${plId}`)).text();
  check('halaman playlist kosong tampil', /Playlist masih kosong/.test(emptyPage), true);

  await postA(`/playlists/${plId}/items`, { video_id: vids.a.id });
  await postA(`/playlists/${plId}/items`, { video_id: vids.b.id });
  // Video sama boleh masuk dua kali.
  await postA(`/playlists/${plId}/items`, { video_id: vids.a.id });

  const page = await (await alice.req(`/playlists/${plId}`)).text();
  const itemIds = [...page.matchAll(/data-sort-id="(\d+)"/g)].map((m) => Number(m[1]));
  check('tiga item masuk playlist', itemIds.length, 3);
  check('video yang sama boleh berulang', new Set(itemIds).size, 3);
  check('drag-and-drop terpasang', page.includes(`data-sortable="/playlists/${plId}/items/reorder"`), true);
  check('tidak ada peringatan untuk playlist seragam', /tidak seragam/.test(page), false);

  // -------------------------------------------------------- kepemilikan
  console.log('\n--- kepemilikan ---');
  check('pengguna lain tidak bisa membuka', (await bob.req(`/playlists/${plId}`)).status, 404);
  check('pengguna lain tidak bisa menambah item',
    (await postB(`/playlists/${plId}/items`, { video_id: vids.a.id })).status, 404);
  const bobReorder = await bob.req(`/playlists/${plId}/items/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenB },
    body: JSON.stringify({ order: itemIds.slice().reverse() }),
  });
  check('pengguna lain tidak bisa mengurutkan ulang', bobReorder.status, 404);

  // ------------------------------------------------------------ reorder
  console.log('\n--- urutan ---');
  const reversed = itemIds.slice().reverse();
  const reorder = await alice.req(`/playlists/${plId}/items/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ order: reversed }),
  });
  check('reorder → 200', reorder.status, 200);
  const afterPage = await (await alice.req(`/playlists/${plId}`)).text();
  check('urutan baru persist',
    [...afterPage.matchAll(/data-sort-id="(\d+)"/g)].map((m) => Number(m[1])), reversed);

  // ------------------------------- playlist tidak seragam → diperingatkan
  console.log('\n--- playlist tidak seragam ---');
  const mixed = await postA('/playlists', { name: 'Campuran' });
  const mixedId = Number(mixed.headers.get('location').split('/').pop());
  await postA(`/playlists/${mixedId}/items`, { video_id: vids.a.id });
  await postA(`/playlists/${mixedId}/items`, { video_id: vids.beda.id });
  const mixedPage = await (await alice.req(`/playlists/${mixedId}`)).text();
  check('playlist campuran diperingatkan', /tidak seragam/.test(mixedPage), true);
  check('peringatan menyebut resolusi', /Resolusi antar video berbeda/.test(mixedPage), true);
  check('menyarankan mode Re-encode', /Re-encode/.test(mixedPage), true);

  // ----------------------------------------------- stream memakai playlist
  console.log('\n--- stream dengan sumber playlist ---');
  const streamRes = await postA('/streams', {
    title: 'Siaran Playlist', playlist_id: String(plId), video_id: '',
    destination_ids: String(dest.id), encode_mode: 'copy', resolution: 'source',
    orientation: 'landscape', bitrate: '2500', audio_bitrate: '128', fps: '25',
    preset: 'ultrafast', loop_video: '1',
  });
  check('buat stream playlist → redirect', streamRes.status, 302);
  const streamId = Number(streamRes.headers.get('location').split('/').pop());

  const listPage = await (await alice.req('/streams')).text();
  check('daftar stream menampilkan playlist', /Playlist Uji/.test(listPage), true);
  check('menyebut jumlah video', /3 video/.test(listPage), true);

  const detail = await (await alice.req(`/streams/${streamId}`)).text();
  check('detail tidak bilang "belum punya video sumber"', /belum punya video sumber/.test(detail), false);
  check('pratinjau perintah memakai concat', /-f concat/.test(detail), true);

  // --------------------------------- stream campuran ditolak sebelum mulai
  const badStream = await postA('/streams', {
    title: 'Siaran Campuran', playlist_id: String(mixedId), video_id: '',
    destination_ids: String(dest.id), encode_mode: 'copy', resolution: 'source',
    orientation: 'landscape', bitrate: '2500', audio_bitrate: '128', fps: '25',
    preset: 'ultrafast', loop_video: '1',
  });
  const badId = Number(badStream.headers.get('location').split('/').pop());
  const badStart = await postA(`/streams/${badId}/start`, {});
  const badDetail = await (await alice.req(`/streams/${badId}`)).text();
  check('siaran campuran mode Copy ditolak', /Resolusi antar video berbeda/.test(badDetail), true);
  check('statusnya tidak menjadi live', /badge-live[^>]*>\s*LIVE/.test(badDetail), false);
  void badStart;

  // ------------------------------------------- siaran nyata ke sink RTMP
  console.log('\n--- siaran nyata (FFmpeg sungguhan) ---');
  // Sink RTMP sederhana: FFmpeg mendengarkan dan membuang ke null.
  rtmpSink = spawn('ffmpeg', ['-y', '-loglevel', 'error',
    '-listen', '1', '-i', `rtmp://127.0.0.1:${PORT + 100}/live/uji`,
    '-c', 'copy', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 1200));

  await postA(`/streams/${streamId}/start`, {});

  // Statistik baru muncul setelah FFmpeg menyambung dan mengirim potongan
  // pertama; waktunya tidak pasti, jadi ditunggu sampai ada, bukan sekian detik.
  let running = null;
  const untilStats = Date.now() + 30000;
  for (;;) {
    const live = await (await alice.req('/api/overview', { headers: { Accept: 'application/json' } })).json();
    running = live.streams.find((s) => s.id === streamId);
    if (running && running.runtime && running.runtime.stats.timeSeconds > 0) break;
    if (Date.now() > untilStats) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('stream berstatus live', running.status, 'live');
  check('FFmpeg melaporkan statistik (siaran benar-benar mengalir)',
    Boolean(running.runtime && running.runtime.stats.timeSeconds > 0), true);
  console.log(`        time=${running.runtime.stats.time} frame=${running.runtime.stats.frame} fps=${running.runtime.stats.fps} bitrate=${running.runtime.stats.bitrate}`);

  const concatFile = path.join(ROOT, 'storage/tmp', `playlist_${streamId}.txt`);
  check('daftar concat ada selama siaran', fs.existsSync(concatFile), true);
  const listContent = fs.readFileSync(concatFile, 'utf8');
  check('daftar berisi 3 baris', listContent.trim().split('\n').length, 3);

  await postA(`/streams/${streamId}/stop`, {});
  await new Promise((r) => setTimeout(r, 2500));
  check('daftar concat dibersihkan setelah berhenti', fs.existsSync(concatFile), false);

  // ---------------------------------------- penghapusan playlist terpakai
  console.log('\n--- penghapusan ---');
  const delUsed = await postA(`/playlists/${plId}/delete`, {});
  check('playlist yang dipakai stream tidak terhapus', delUsed.status, 302);
  const stillThere = await alice.req(`/playlists/${plId}`);
  check('playlist masih ada', stillThere.status, 200);
  check('alasannya dijelaskan', /dipakai oleh stream/i.test(await stillThere.text()), true);
}

main()
  .catch((err) => { fail += 1; console.log('ERROR:', err.message, '\n', err.stack); })
  .finally(() => {
    if (rtmpSink) rtmpSink.kill();
    if (server) server.kill();
    setTimeout(() => {
      fs.copyFileSync(BACKUP, DB);
      for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch (_) { /* tidak ada */ } }
      fs.unlinkSync(BACKUP);
      for (const f of madeFiles) { try { fs.unlinkSync(f); } catch (_) { /* sudah hilang */ } }
      for (const f of fs.readdirSync(path.join(ROOT, 'storage/tmp'))) {
        if (f.startsWith('playlist_')) { try { fs.unlinkSync(path.join(ROOT, 'storage/tmp', f)); } catch (_) {} }
      }
      console.log(`\nDB dikembalikan, ${madeFiles.length} berkas uji dihapus.\n${pass} pass, ${fail} fail`);
      process.exit(fail ? 1 : 0);
    }, 1000);
  });
