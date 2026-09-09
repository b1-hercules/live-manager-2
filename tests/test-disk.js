'use strict';

// Tes disk monitoring: unit untuk diskUsage() + integrasi render dashboard.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(require('os').tmpdir(), `lm-disk-backup-${Date.now()}.db`);
const PORT = 7598;
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

// ---------------------------------------------------------------- unit
const system = require(path.join(ROOT, 'services/system'));
const disk = system.diskUsage();

console.log('disk =', JSON.stringify(disk), '\n');
check('diskUsage() mengembalikan objek', disk !== null && typeof disk === 'object', true);
check('total > 0', disk.total > 0, true);
check('free >= 0 dan tidak melebihi total', disk.free >= 0 && disk.free <= disk.total, true);
check('used + free = total', disk.used + disk.free, disk.total);
check('percent 0..100', disk.percent >= 0 && disk.percent <= 100, true);
check('percent konsisten dengan used/total', Math.round((disk.used / disk.total) * 1000) / 10, disk.percent);
check('disk ikut di snapshot()', typeof system.snapshot().disk, 'object');
check('storageBytes lama tetap ada (tidak merusak consumer)', typeof system.snapshot().storageBytes, 'number');

// Node < 18.15 tidak punya fs.statfsSync — harus jadi null, bukan lempar error.
const realStatfs = fs.statfsSync;
delete fs.statfsSync;
delete require.cache[require.resolve(path.join(ROOT, 'services/system'))];
const systemNoStatfs = require(path.join(ROOT, 'services/system'));
check('tanpa fs.statfsSync → null, tidak crash', systemNoStatfs.diskUsage(), null);
check('snapshot() tetap jalan tanpa statfs', typeof systemNoStatfs.snapshot().cpu, 'number');
fs.statfsSync = realStatfs;

// Filesystem yang menolak statfs juga harus jadi null.
fs.statfsSync = () => { throw new Error('ENOTSUP'); };
delete require.cache[require.resolve(path.join(ROOT, 'services/system'))];
const systemThrows = require(path.join(ROOT, 'services/system'));
check('statfs melempar error → null', systemThrows.diskUsage(), null);
fs.statfsSync = realStatfs;

// ------------------------------------------------------- integrasi UI
let cookies = {};
function saveCookies(res) {
  for (const raw of res.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
async function req(url, opts = {}) {
  const res = await fetch(BASE + url, {
    ...opts,
    redirect: 'manual',
    headers: {
      Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      ...(opts.headers || {}),
    },
  });
  saveCookies(res);
  return res;
}

let server = null;
async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);
  const userModel = require(path.join(ROOT, 'models/user'));
  userModel.create(USER);
  require(path.join(ROOT, 'db')).db.close();

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
  const loginRes = await req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...USER, _csrf: token }).toString(),
  });
  check('login berhasil', loginRes.status, 302);

  const page = await (await req('/')).text();
  check('dashboard punya baris Disk', page.includes('<dt>Disk</dt>'), true);
  check('menampilkan sisa ruang', /bebas dari/.test(page), true);
  check('menampilkan persen terpakai', /\d+(\.\d+)?% terpakai/.test(page), true);
  check('meter disk ter-render', /class="meter mt-1 (ok|warn|danger)"/.test(page), true);
  check('label storage lama tetap ada', page.includes('video &amp; thumbnail'), true);

  // Disk di mesin ini belum penuh, jadi banner peringatan harus TIDAK muncul.
  const nearlyFull = disk.percent >= 90;
  check(
    `banner "Disk hampir penuh" sesuai kondisi (disk ${disk.percent}%)`,
    page.includes('Disk hampir penuh'),
    nearlyFull
  );

  // /api/overview ikut membawa disk supaya polling dashboard bisa memakainya.
  const overview = await (await req('/api/overview', { headers: { Accept: 'application/json' } })).json();
  check('/api/overview menyertakan system.disk', typeof overview.system.disk, 'object');
  check('nilai disk dari API konsisten', overview.system.disk.total, disk.total);
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
