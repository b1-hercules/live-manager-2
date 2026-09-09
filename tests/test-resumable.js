'use strict';

// Tes unggahan berpotongan: protokol, resume setelah putus, kepemilikan,
// integritas byte, penolakan konten palsu, dan regresi jalur multipart lama.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(os.tmpdir(), `lm-resume-backup-${Date.now()}.db`);
const PORT = 7592;
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
          // Sama seperti klien sungguhan: menyatakan ingin JSON supaya error
          // tidak dikembalikan sebagai redirect HTML.
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

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const madeFiles = [];
let server = null;

async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);
  const userModel = require(path.join(ROOT, 'models/user'));
  userModel.create(A);
  userModel.create(B);
  require(path.join(ROOT, 'db')).db.close();

  // Video sungguhan ~3 MB supaya terbagi ke beberapa potongan.
  const srcPath = path.join(os.tmpdir(), `src-${Date.now()}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc=duration=12:size=640x480:rate=25', '-pix_fmt', 'yuv420p', srcPath], { stdio: 'pipe' });
  const source = fs.readFileSync(srcPath);
  const sourceHash = sha(source);
  console.log(`sumber: ${(source.length / 1048576).toFixed(2)} MB, sha256 ${sourceHash.slice(0, 16)}…\n`);

  server = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (!/WARN|INFO/.test(s)) console.log('[server:err]', s.slice(0, 160));
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

  const put = (client, token, id, offset, chunk) => client.req(`/videos/upload/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Upload-Offset': String(offset),
      'X-CSRF-Token': token,
    },
    body: chunk,
  });

  // ---------------------------------------------------------- init
  console.log('--- init ---');
  const initRes = await alice.req('/videos/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ filename: 'klip-besar.mp4', size: source.length }),
  });
  const init = await initRes.json();
  check('init → 200', initRes.status, 200);
  check('mengembalikan offset 0', init.offset, 0);
  check('ukuran dicatat', init.size, source.length);
  const id = init.id;

  const badExt = await alice.req('/videos/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ filename: 'jahat.exe', size: 1000 }),
  });
  check('ekstensi non-video ditolak', badExt.status, 400);

  const tooBig = await alice.req('/videos/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ filename: 'raksasa.mp4', size: 999 * 1024 * 1024 * 1024 }),
  });
  check('ukuran melebihi batas ditolak', tooBig.status, 400);

  // ------------------------------------------- unggah sebagian lalu "putus"
  console.log('\n--- unggah sebagian, lalu koneksi dianggap putus ---');
  // Sengaja kecil supaya berkas uji terbagi ke banyak potongan.
  const CHUNK = 16 * 1024;
  if (source.length < CHUNK * 4) throw new Error('berkas uji terlalu kecil untuk menguji multi-potongan');
  let offset = 0;
  for (let i = 0; i < 2; i++) {
    const slice = source.subarray(offset, Math.min(offset + CHUNK, source.length));
    const r = await put(alice, tokenA, id, offset, slice);
    const d = await r.json();
    offset = d.offset;
  }
  check('dua potongan diterima', offset, CHUNK * 2);

  const statRes = await alice.req(`/videos/upload/${id}`);
  const stat = await statRes.json();
  check('GET offset mencerminkan kemajuan (dasar resume)', stat.offset, CHUNK * 2);

  // ------------------------------------------------ penolakan offset salah
  console.log('\n--- offset salah ---');
  const wrong = await put(alice, tokenA, id, 0, source.subarray(0, 1024));
  const wrongData = await wrong.json();
  check('offset usang → 409', wrong.status, 409);
  check('server memberi tahu posisi benar', wrongData.offset, CHUNK * 2);

  const ahead = await put(alice, tokenA, id, offset + 999999, source.subarray(0, 1024));
  check('offset melompat ke depan → 409', ahead.status, 409);

  // ------------------------------------------------------- kepemilikan
  console.log('\n--- kepemilikan ---');
  const bobStat = await bob.req(`/videos/upload/${id}`);
  check('pengguna lain tidak bisa melihat unggahan ini', bobStat.status, 404);
  const bobPut = await put(bob, tokenB, id, offset, source.subarray(offset, offset + 1024));
  check('pengguna lain tidak bisa menyambung', bobPut.status, 404);
  const bobFinish = await bob.req(`/videos/upload/${id}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenB },
    body: JSON.stringify({ title: 'curian' }),
  });
  check('pengguna lain tidak bisa menyelesaikan', bobFinish.status, 404);

  // ------------------------------------------------------ path traversal
  const traversal = await alice.req('/videos/upload/..%2F..%2Fconfig%2Findex');
  check('id berbentuk path ditolak', traversal.status, 404);

  // -------------------------------------------------- finish terlalu dini
  const early = await alice.req(`/videos/upload/${id}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ title: 'belum lengkap' }),
  });
  const earlyData = await early.json();
  check('finish sebelum lengkap → 409', early.status, 409);
  check('finish memberi offset untuk disambung', earlyData.offset, CHUNK * 2);

  // -------------------------------------- sambung sampai selesai (resume)
  console.log('\n--- sambung sampai selesai ---');
  while (offset < source.length) {
    const slice = source.subarray(offset, Math.min(offset + CHUNK, source.length));
    const r = await put(alice, tokenA, id, offset, slice);
    const d = await r.json();
    if (!r.ok) throw new Error(`potongan gagal: ${d.error}`);
    offset = d.offset;
  }
  check('seluruh byte terkirim', offset, source.length);

  // 400, bukan 409: ini permintaan cacat (melebihi ukuran yang dijanjikan),
  // bukan ketidakcocokan offset yang bisa dipulihkan dengan menyambung ulang.
  const over = await put(alice, tokenA, id, offset, Buffer.alloc(16));
  check('kelebihan byte ditolak', over.status, 400);

  const finishRes = await alice.req(`/videos/upload/${id}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ title: 'Klip Hasil Sambungan' }),
  });
  const finished = await finishRes.json();
  check('finish → 200', finishRes.status, 200);
  check('video tercatat dengan judul yang dikirim', finished.title, 'Klip Hasil Sambungan');

  // ----------------------------------------------------- integritas byte
  console.log('\n--- integritas hasil ---');
  const after = require('better-sqlite3')(DB, { readonly: true });
  const row = after.prepare('SELECT * FROM videos WHERE id = ?').get(finished.id);
  after.close();
  const storedAbs = path.join(ROOT, row.filepath);
  madeFiles.push(storedAbs);
  if (row.thumbnail_path) madeFiles.push(path.join(ROOT, row.thumbnail_path));

  check('berkas hasil ada di storage', fs.existsSync(storedAbs), true);
  check('byte identik dengan sumber (sha256)', sha(fs.readFileSync(storedAbs)), sourceHash);
  check('ukuran tercatat benar', row.filesize, source.length);
  check('ffprobe terisi (durasi)', Math.round(row.duration), 12);
  check('resolusi terbaca', [row.width, row.height], [640, 480]);
  check('thumbnail dibuat', Boolean(row.thumbnail_path), true);
  check('berkas parsial sudah tidak tersisa', fs.existsSync(path.join(ROOT, 'storage/tmp', `${id}.part`)), false);
  check('metadata parsial sudah dibersihkan', fs.existsSync(path.join(ROOT, 'storage/tmp', `${id}.json`)), false);

  // --------------------------------- konten palsu ditolak di jalur finish
  console.log('\n--- magic byte tetap berlaku di jalur berpotongan ---');
  const fakeBody = Buffer.from('MZ\x90\x00 ini executable, bukan video sama sekali');
  const fakeInit = await (await alice.req('/videos/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ filename: 'menyamar.mp4', size: fakeBody.length }),
  })).json();
  await put(alice, tokenA, fakeInit.id, 0, fakeBody);
  const fakeFinish = await alice.req(`/videos/upload/${fakeInit.id}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ title: 'palsu' }),
  });
  check('konten palsu ditolak walau ekstensi .mp4', [fakeFinish.status, fakeFinish.status === 302 || fakeFinish.status === 400], [fakeFinish.status, true]);
  const leftovers = fs.readdirSync(path.join(ROOT, 'storage/videos')).filter((f) => f.startsWith(fakeInit.id));
  check('berkas palsu tidak tertinggal di storage', leftovers, []);

  // ------------------------------------------------------------ discard
  console.log('\n--- pembatalan ---');
  const cancelInit = await (await alice.req('/videos/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ filename: 'batal.mp4', size: source.length }),
  })).json();
  await put(alice, tokenA, cancelInit.id, 0, source.subarray(0, CHUNK));
  const del = await alice.req(`/videos/upload/${cancelInit.id}`, {
    method: 'DELETE', headers: { 'X-CSRF-Token': tokenA },
  });
  check('DELETE → 200', del.status, 200);
  check('berkas parsial terhapus', fs.existsSync(path.join(ROOT, 'storage/tmp', `${cancelInit.id}.part`)), false);

  // ---------------------------------------------------------------- CSRF
  const noCsrf = await alice.req('/videos/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'x.mp4', size: 100 }),
  });
  check('init tanpa token CSRF → 403', noCsrf.status, 403);

  // --------------------------------------- regresi: jalur multipart lama
  console.log('\n--- regresi jalur multipart lama ---');
  const small = fs.readFileSync(srcPath).subarray(0, 0); // placeholder, dipakai di bawah
  void small;
  const fd = new FormData();
  fd.append('_csrf', tokenA);
  fd.append('title', 'Lewat Multipart');
  fd.append('video', new Blob([source], { type: 'video/mp4' }), 'multipart.mp4');
  const mp = await alice.req('/videos/upload', { method: 'POST', body: fd });
  check('unggahan multipart tetap berhasil (redirect)', mp.status, 302);

  const after2 = require('better-sqlite3')(DB, { readonly: true });
  const mpRow = after2.prepare("SELECT * FROM videos WHERE title = 'Lewat Multipart'").get();
  after2.close();
  check('video multipart tercatat', Boolean(mpRow), true);
  if (mpRow) {
    madeFiles.push(path.join(ROOT, mpRow.filepath));
    if (mpRow.thumbnail_path) madeFiles.push(path.join(ROOT, mpRow.thumbnail_path));
    check('byte multipart juga identik', sha(fs.readFileSync(path.join(ROOT, mpRow.filepath))), sourceHash);
  }

  // ------------------------------------------------------- sweep (unit)
  console.log('\n--- sweep unggahan tertinggal ---');
  const chunkUpload = require(path.join(ROOT, 'services/chunkUpload'));
  const stale = chunkUpload.init({ userId: 999, filename: 'tertinggal.mp4', size: 4096 });
  const metaFile = path.join(ROOT, 'storage/tmp', `${stale.id}.json`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.createdAt = Date.now() - 48 * 60 * 60 * 1000;
  fs.writeFileSync(metaFile, JSON.stringify(meta));

  const fresh = chunkUpload.init({ userId: 999, filename: 'baru.mp4', size: 4096 });
  const removed = chunkUpload.sweep();
  check('unggahan tua dibersihkan', removed >= 1, true);
  check('berkas tua hilang', fs.existsSync(path.join(ROOT, 'storage/tmp', `${stale.id}.part`)), false);
  check('unggahan baru tidak ikut terhapus', fs.existsSync(path.join(ROOT, 'storage/tmp', `${fresh.id}.part`)), true);
  chunkUpload.discard(fresh.id, 999);

  fs.unlinkSync(srcPath);
}

main()
  .catch((err) => { fail += 1; console.log('ERROR:', err.message, '\n', err.stack); })
  .finally(() => {
    if (server) server.kill();
    setTimeout(() => {
      fs.copyFileSync(BACKUP, DB);
      for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch (_) { /* tidak ada */ } }
      fs.unlinkSync(BACKUP);
      for (const f of madeFiles) { try { fs.unlinkSync(f); } catch (_) { /* sudah hilang */ } }
      console.log(`\nDB dikembalikan, ${madeFiles.length} berkas uji dihapus.\n${pass} pass, ${fail} fail`);
      process.exit(fail ? 1 : 0);
    }, 800);
  });
