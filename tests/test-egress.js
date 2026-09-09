'use strict';

// Tes bandwidth keluar: parseBitrate, formatBitrate, egress(), lalu tampilan
// dashboard + /api/overview (dengan egress dipatch supaya ada angka nyata).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(require('os').tmpdir(), `lm-egress-backup-${Date.now()}.db`);
const PORT = 7594;
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

// ------------------------------------------------------------ unit
const { parseBitrate, egress } = require(path.join(ROOT, 'services/streamManager'));
const { formatBitrate } = require(path.join(ROOT, 'utils/helpers'));

console.log('--- parseBitrate (format yang dikeluarkan FFmpeg) ---');
check('kbits/s', parseBitrate('2500.3kbits/s'), 2500300);
check('mbits/s', parseBitrate('1.5mbits/s'), 1500000);
check('gbits/s', parseBitrate('2gbits/s'), 2000000000);
check('bits/s polos', parseBitrate('800bits/s'), 800);
check('ada spasi', parseBitrate('2500.3 kbits/s'), 2500300);
check('huruf besar', parseBitrate('2500.3KBITS/S'), 2500300);
check('nol tetap nol, bukan null', parseBitrate('0kbits/s'), 0);
check('N/A → null', parseBitrate('N/A'), null);
check('strip → null', parseBitrate('-'), null);
check('string kosong → null', parseBitrate(''), null);
check('null → null', parseBitrate(null), null);
check('undefined → null', parseBitrate(undefined), null);
check('sampah → null', parseBitrate('abc'), null);
check('satuan salah → null', parseBitrate('2500kbytes/s'), null);

console.log('\n--- formatBitrate ---');
check('nol', formatBitrate(0), '0 bps');
check('di bawah 1000', formatBitrate(999), '999 bps');
check('tepat 1000', formatBitrate(1000), '1.0 kbps');
check('8.4 Mbps', formatBitrate(8400000), '8.4 Mbps');
check('>= 10 dibulatkan', formatBitrate(12000000), '12 Mbps');
check('Gbps', formatBitrate(1234567890), '1.2 Gbps');
check('input tidak valid → 0 bps', formatBitrate('bukan angka'), '0 bps');
check('desimal 1000 bukan 1024', formatBitrate(1000000), '1.0 Mbps');

console.log('\n--- egress() tanpa siaran ---');
check('nol dan tidak crash', egress(), { bitsPerSecond: 0, streams: 0 });

// ------------------------------------------------------ integrasi
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

  server = spawn(process.execPath, [path.join(__dirname, 'boot-egress.js')], {
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

  console.log('\n--- dashboard (egress dipatch: 8.4 Mbps, 3 siaran) ---');
  const page = await (await req('/')).text();
  check('baris "Keluar" ada', page.includes('>Keluar</dt>'), true);
  check('nilai terformat tampil', /id="statEgress">8\.4 Mbps</.test(page), true);
  check('jumlah siaran tampil', /id="statEgressNote">· 3 siaran</.test(page), true);
  check('ada penjelasan sumber angka', page.includes('Total bitrate yang dilaporkan FFmpeg'), true);

  console.log('\n--- /api/overview ---');
  const data = await (await req('/api/overview', { headers: { Accept: 'application/json' } })).json();
  check('egress ada di respons', typeof data.egress, 'object');
  check('bitsPerSecond mentah dikirim', data.egress.bitsPerSecond, 8400000);
  check('jumlah siaran dikirim', data.egress.streams, 3);
  check('text sudah diformat server (klien tidak perlu formatter)', data.egress.text, '8.4 Mbps');
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
