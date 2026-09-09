'use strict';

// Verifikasi cabang "disk hampir penuh" (>=90%) pada dashboard.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(require('os').tmpdir(), `lm-full-backup-${Date.now()}.db`);
const PORT = 7597;
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

let server = null;
async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);
  require(path.join(ROOT, 'models/user')).create(USER);
  require(path.join(ROOT, 'db')).db.close();

  server = spawn(process.execPath, [path.join(__dirname, 'boot-fulldisk.js')], {
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
  await req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...USER, _csrf: token }).toString(),
  });

  const page = await (await req('/')).text();
  check('banner peringatan muncul saat 96%', page.includes('Disk hampir penuh'), true);
  check('banner memakai gaya warn', /alert alert-warn/.test(page), true);
  check('menyebut sisa ruang', page.includes('37.3 GB') || /Sisa [\d.]+ GB/.test(page), true);
  check('mengarahkan ke galeri', /hapus video yang tidak terpakai di <a href="\/videos">galeri<\/a>/.test(page), true);
  check('meter memakai kelas danger', page.includes('class="meter mt-1 danger"'), true);
  check('persen ditampilkan', page.includes('96% terpakai'), true);
}

main()
  .catch((err) => { fail += 1; console.log('ERROR:', err.message); })
  .finally(() => {
    if (server) server.kill();
    setTimeout(() => {
      fs.copyFileSync(BACKUP, DB);
      for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch (_) { /* tidak ada */ } }
      fs.unlinkSync(BACKUP);
      console.log(`\nDB dikembalikan.\n${pass} pass, ${fail} fail`);
      process.exit(fail ? 1 : 0);
    }, 600);
  });
