'use strict';

// Tes integrasi drag-and-drop reorder: boot app sungguhan, login, render
// halaman, panggil endpoint, lalu verifikasi urutan di database.
// DB di-backup sebelum mulai dan dikembalikan di akhir apa pun hasilnya.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(require('os').tmpdir(), `livemanager-backup-${Date.now()}.db`);
const PORT = 7599;
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

// ---- cookie jar sederhana ---------------------------------------------
let cookies = {};
function saveCookies(res) {
  for (const raw of res.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function req(url, opts = {}) {
  const res = await fetch(BASE + url, {
    ...opts,
    redirect: 'manual',
    headers: { Cookie: cookieHeader(), ...(opts.headers || {}) },
  });
  saveCookies(res);
  return res;
}

let server = null;
async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);
  console.log(`DB dibackup ke ${BACKUP}\n`);

  // --- data uji langsung lewat model -----------------------------------
  const userModel = require(path.join(ROOT, 'models/user'));
  const rotationModel = require(path.join(ROOT, 'models/rotation'));
  const user = userModel.create(USER);
  const profile = rotationModel.createProfile({ user_id: user.id, name: 'Profil Uji Reorder', mode: 'bundle' });
  const made = ['Varian A', 'Varian B', 'Varian C'].map((title) =>
    rotationModel.createItem(profile.id, { title, weight: 1, active: 1 })
  );
  const ids = made.map((i) => i.id);
  require(path.join(ROOT, 'db')).db.close();
  console.log(`user #${user.id}, profil #${profile.id}, varian ${ids.join(',')}\n`);

  // --- boot aplikasi ---------------------------------------------------
  server = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => console.log('[server:err]', String(d).trim().slice(0, 200)));
  // Tunggu port benar-benar menerima koneksi, jangan bergantung pada teks log.
  const deadline = Date.now() + 25000;
  for (;;) {
    try {
      await fetch(`${BASE}/login`, { redirect: 'manual' });
      break;
    } catch (_) {
      if (Date.now() > deadline) throw new Error('server tidak siap dalam 25 detik');
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // --- login -----------------------------------------------------------
  const loginPage = await (await req('/login')).text();
  const token = loginPage.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  check('halaman login memuat token CSRF', Boolean(token), true);

  const loginRes = await req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...USER, _csrf: token }).toString(),
  });
  check('login berhasil (redirect 302)', loginRes.status, 302);

  // --- markup halaman --------------------------------------------------
  const page = await (await req(`/rotations/${profile.id}`)).text();
  check('wadah punya data-sortable', page.includes(`data-sortable="/rotations/${profile.id}/items/reorder"`), true);
  check('tiap varian punya data-sort-id', ids.every((id) => page.includes(`data-sort-id="${id}"`)), true);
  check('pegangan seret terpasang', (page.match(/data-sort-handle/g) || []).length, 3);
  check('nomor urut terpasang', (page.match(/data-sort-index/g) || []).length, 3);
  check('ikon grip ter-render', page.includes('class="grip"'), true);
  check('hint seret muncul', page.includes('seret nomor untuk mengubah urutan'), true);

  // urutan awal di halaman = urutan pembuatan
  const shown = [...page.matchAll(/data-sort-id="(\d+)"/g)].map((m) => Number(m[1]));
  check('urutan awal di halaman', shown, ids);

  // --- endpoint reorder ------------------------------------------------
  const pageToken = page.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
  check('halaman memuat meta csrf-token (dipakai LM.post)', Boolean(pageToken), true);

  const reversed = [...ids].reverse();
  const saveRes = await req(`/rotations/${profile.id}/items/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': pageToken },
    body: JSON.stringify({ order: reversed }),
  });
  check('POST reorder → 200', saveRes.status, 200);
  check('respons { ok: true }', await saveRes.json(), { ok: true });

  // --- urutan benar-benar persist di halaman ---------------------------
  const after = await (await req(`/rotations/${profile.id}`)).text();
  const shownAfter = [...after.matchAll(/data-sort-id="(\d+)"/g)].map((m) => Number(m[1]));
  check('urutan baru persist setelah reload', shownAfter, reversed);

  // --- endpoint menolak request tanpa CSRF -----------------------------
  const noCsrf = await req(`/rotations/${profile.id}/items/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: ids }),
  });
  check('POST reorder tanpa token CSRF → 403', noCsrf.status, 403);

  // --- urutan tidak berubah oleh request yang ditolak ------------------
  const after2 = await (await req(`/rotations/${profile.id}`)).text();
  const shownAfter2 = [...after2.matchAll(/data-sort-id="(\d+)"/g)].map((m) => Number(m[1]));
  check('urutan tetap setelah request ditolak', shownAfter2, reversed);
}

main()
  .catch((err) => { fail += 1; console.log('ERROR:', err.message); })
  .finally(() => {
    if (server) server.kill();
    setTimeout(() => {
      fs.copyFileSync(BACKUP, DB);
      for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(DB + suffix); } catch (_) { /* tidak ada */ }
      }
      fs.unlinkSync(BACKUP);
      console.log(`\nDB dikembalikan dari backup.\n${pass} pass, ${fail} fail`);
      process.exit(fail ? 1 : 0);
    }, 600);
  });
