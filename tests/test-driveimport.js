'use strict';

// Tes impor dari Google Drive: prasyarat izin, daftar berkas, siklus job impor,
// pemeriksaan isi berkas, kepemilikan job, dan pembersihan berkas sementara.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(os.tmpdir(), `lm-drive-backup-${Date.now()}.db`);
const PORT = 7591;
const BASE = `http://127.0.0.1:${PORT}`;
const A = { username: `__test_a_${Date.now()}`, password: 'TestPassword!234' };
const B = { username: `__test_b_${Date.now()}`, password: 'TestPassword!234' };
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

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

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const madeFiles = [];
let server = null;

async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);

  // --- fixture: satu video sah, satu berkas palsu berekstensi .mp4 --------
  const goodPath = path.join(os.tmpdir(), `drive-good-${Date.now()}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc=duration=12:size=640x480:rate=25', '-pix_fmt', 'yuv420p', goodPath], { stdio: 'pipe' });
  const badPath = path.join(os.tmpdir(), `drive-bad-${Date.now()}.mp4`);
  fs.writeFileSync(badPath, Buffer.from('MZ\x90\x00 ini executable, bukan video'));
  const goodHash = sha(fs.readFileSync(goodPath));

  const fixtures = {
    'file-good': { name: 'rekaman-drive.mp4', path: goodPath },
    'file-bad': { name: 'menyamar-drive.mp4', path: badPath },
  };

  // --- pengguna & akun ---------------------------------------------------
  const userModel = require(path.join(ROOT, 'models/user'));
  const accountModel = require(path.join(ROOT, 'models/account'));
  const userA = userModel.create(A);
  const userB = userModel.create(B);
  // Akun lama: hanya scope YouTube, tanpa izin Drive.
  accountModel.upsert({
    user_id: userA.id, provider: 'youtube', external_id: 'chan-lama', name: 'Channel Lama',
    access_token: 'x', refresh_token: 'y', expires_at: null,
    scopes: 'https://www.googleapis.com/auth/youtube.force-ssl',
  });
  require(path.join(ROOT, 'db')).db.close();

  server = spawn(process.execPath, [path.join(__dirname, 'boot-drive.js')], {
    cwd: ROOT,
    // Kredensial OAuth lewat env var, bukan tabel settings: google_client_secret
    // disimpan terenkripsi, dan googleCredentials() memang mendahulukan env.
    // Tanpa ini rute Drive berhenti di pemeriksaan kredensial (services/googleStatus.js)
    // sebelum sempat memeriksa izin akun — yang justru diuji di sini.
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
      DRIVE_FIXTURES: JSON.stringify(fixtures),
      GOOGLE_CLIENT_ID: 'uji-client-id',
      GOOGLE_CLIENT_SECRET: 'uji-client-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (!/INFO/.test(s)) console.log('[server]', s.slice(0, 150));
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

  // --- prasyarat izin ----------------------------------------------------
  console.log('--- prasyarat izin Drive ---');
  const noScope = await alice.req('/videos/import/drive/files');
  const noScopeData = await noScope.json();
  check('akun tanpa izin Drive → 400', noScope.status, 400);
  check('pesannya menyuruh hubungkan ulang',
    /belum memberi izin baca Drive/.test(noScopeData.error), true);

  const noAccount = await bob.req('/videos/import/drive/files');
  const noAccountData = await noAccount.json();
  check('tanpa akun sama sekali → 400', noAccount.status, 400);
  check('pesannya menyuruh hubungkan akun',
    /Belum ada akun Google yang terhubung/.test(noAccountData.error), true);

  // Beri izin Drive pada akun Alice, seolah ia menghubungkan ulang.
  const db = require('better-sqlite3')(DB);
  db.prepare('UPDATE accounts SET scopes = ? WHERE external_id = ?')
    .run(`https://www.googleapis.com/auth/youtube.force-ssl ${DRIVE_SCOPE}`, 'chan-lama');
  db.close();

  // --- daftar berkas -----------------------------------------------------
  console.log('\n--- daftar berkas ---');
  const listRes = await alice.req('/videos/import/drive/files');
  const listData = await listRes.json();
  check('setelah izin diberikan → 200', listRes.status, 200);
  check('mengembalikan dua berkas', listData.files.length, 2);
  check('nama akun ikut dikirim', listData.account.name, 'Channel Lama');

  const searched = await (await alice.req('/videos/import/drive/files?q=rekaman')).json();
  check('kata kunci diteruskan ke Drive', searched.echoSearch, 'rekaman');
  check('hasil pencarian tersaring', searched.files.map((f) => f.id), ['file-good']);

  // --- impor berhasil ----------------------------------------------------
  console.log('\n--- impor berkas sah ---');
  const startRes = await alice.req('/videos/import/drive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ fileId: 'file-good', title: 'Hasil Impor Drive' }),
  });
  const started = await startRes.json();
  check('mulai impor → 200', startRes.status, 200);
  check('job dimulai dalam keadaan mengunduh', started.job.state, 'downloading');
  const jobId = started.job.id;

  // --- kepemilikan job ---------------------------------------------------
  const bobPeek = await bob.req(`/videos/import/${jobId}`);
  check('pengguna lain tidak bisa melihat job ini', bobPeek.status, 404);
  const bobList = await (await bob.req('/videos/import/jobs')).json();
  check('daftar job pengguna lain kosong', bobList.jobs.length, 0);

  // --- tunggu selesai ----------------------------------------------------
  let job = null;
  const until = Date.now() + 40000;
  const seen = new Set();
  for (;;) {
    job = (await (await alice.req(`/videos/import/${jobId}`)).json()).job;
    seen.add(job.state);
    if (job.state === 'done' || job.state === 'error') break;
    if (Date.now() > until) throw new Error('impor tidak selesai tepat waktu');
    await new Promise((r) => setTimeout(r, 250));
  }
  check('impor selesai tanpa error', [job.state, job.error], ['done', null]);
  check('sempat melewati keadaan mengunduh', seen.has('downloading'), true);
  check('kemajuan terisi penuh', job.received, job.total);
  check('video_id terisi', typeof job.videoId, 'number');

  // --- hasil di database & disk -----------------------------------------
  console.log('\n--- hasil impor ---');
  const after = require('better-sqlite3')(DB, { readonly: true });
  const row = after.prepare('SELECT * FROM videos WHERE id = ?').get(job.videoId);
  after.close();
  const storedAbs = path.join(ROOT, row.filepath);
  madeFiles.push(storedAbs);
  if (row.thumbnail_path) madeFiles.push(path.join(ROOT, row.thumbnail_path));

  check('judul memakai yang dikirim', row.title, 'Hasil Impor Drive');
  check('nama berkas asli dari Drive tercatat', row.filename, 'rekaman-drive.mp4');
  check('byte identik dengan sumber (sha256)', sha(fs.readFileSync(storedAbs)), goodHash);
  check('ffprobe berjalan (durasi)', Math.round(row.duration), 12);
  check('resolusi terbaca', [row.width, row.height], [640, 480]);
  check('thumbnail dibuat', Boolean(row.thumbnail_path), true);
  const tmpLeft = fs.readdirSync(path.join(ROOT, 'storage/tmp')).filter((f) => f.startsWith('import-'));
  check('tidak ada berkas sementara tertinggal', tmpLeft, []);

  // --- impor berkas palsu ------------------------------------------------
  console.log('\n--- impor berkas yang isinya bukan video ---');
  const badStart = await (await alice.req('/videos/import/drive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tokenA },
    body: JSON.stringify({ fileId: 'file-bad' }),
  })).json();

  let badJob = null;
  const until2 = Date.now() + 30000;
  for (;;) {
    badJob = (await (await alice.req(`/videos/import/${badStart.job.id}`)).json()).job;
    if (badJob.state === 'done' || badJob.state === 'error') break;
    if (Date.now() > until2) throw new Error('job kedua tidak selesai');
    await new Promise((r) => setTimeout(r, 250));
  }
  check('berkas palsu ditolak walau ekstensi .mp4', badJob.state, 'error');
  check('pesan error menyebut isi berkas', /bukan file video yang sah/.test(badJob.error || ''), true);
  check('tidak ada video baru tercatat', badJob.videoId, null);

  const after2 = require('better-sqlite3')(DB, { readonly: true });
  check('jumlah video tetap satu', after2.prepare('SELECT COUNT(*) n FROM videos').get().n, 1);
  after2.close();
  const strays = fs.readdirSync(path.join(ROOT, 'storage/videos')).filter((f) => f.includes(badStart.job.id));
  check('berkas palsu tidak tertinggal di storage', strays, []);
  const tmpLeft2 = fs.readdirSync(path.join(ROOT, 'storage/tmp')).filter((f) => f.startsWith('import-'));
  check('berkas sementara job gagal ikut dibersihkan', tmpLeft2, []);

  // --- daftar & pembuangan job ------------------------------------------
  console.log('\n--- daftar & pembuangan job ---');
  const mine = await (await alice.req('/videos/import/jobs')).json();
  check('kedua job milik Alice terdaftar', mine.jobs.length, 2);
  const forget = await alice.req(`/videos/import/${jobId}`, {
    method: 'DELETE', headers: { 'X-CSRF-Token': tokenA },
  });
  check('job selesai bisa dibuang', (await forget.json()).ok, true);
  const afterForget = await (await alice.req('/videos/import/jobs')).json();
  check('tinggal satu job tersisa', afterForget.jobs.length, 1);

  const bobForget = await bob.req(`/videos/import/${badStart.job.id}`, {
    method: 'DELETE', headers: { 'X-CSRF-Token': tokenB },
  });
  check('pengguna lain tidak bisa membuang job orang', (await bobForget.json()).ok, false);

  // --- CSRF --------------------------------------------------------------
  const noCsrf = await alice.req('/videos/import/drive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: 'file-good' }),
  });
  check('mulai impor tanpa token CSRF → 403', noCsrf.status, 403);

  fs.unlinkSync(goodPath);
  fs.unlinkSync(badPath);
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
