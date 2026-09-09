'use strict';

// detect_changes menandai recoverOnBoot & shutdown sebagai "touched" (HIGH risk)
// setelah egress/parseBitrate ditambahkan. Diff menunjukkan keduanya cuma
// bergeser baris, tapi klaim itu diverifikasi di sini: stream yang tertinggal
// berstatus 'live' harus dibereskan saat aplikasi boot.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(require('os').tmpdir(), `lm-recover-backup-${Date.now()}.db`);
const PORT = 7593;

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(actual)}\n        want=${JSON.stringify(expected)}`);
}

let server = null;
async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);

  const userModel = require(path.join(ROOT, 'models/user'));
  const streamModel = require(path.join(ROOT, 'models/stream'));
  const { db } = require(path.join(ROOT, 'db'));
  const user = userModel.create({ username: `__test_${Date.now()}`, password: 'TestPassword!234' });

  // Dua siaran "tertinggal hidup" seolah aplikasi mati saat sedang menyiarkan.
  const withRestart = streamModel.create(user.id, { title: 'Siaran auto-restart', auto_restart: 1 });
  const noRestart = streamModel.create(user.id, { title: 'Siaran tanpa auto-restart', auto_restart: 0 });
  for (const s of [withRestart, noRestart]) {
    db.prepare("UPDATE streams SET status = 'live', pid = 9999 WHERE id = ?").run(s.id);
  }
  check('kondisi awal: dua stream berstatus live', streamModel.listActive().length, 2);
  db.close();

  // --- boot: recoverOnBoot harus berjalan -------------------------------
  server = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += String(d); });

  const deadline = Date.now() + 25000;
  for (;;) {
    try { await fetch(`http://127.0.0.1:${PORT}/login`, { redirect: 'manual' }); break; } catch (_) {
      if (Date.now() > deadline) throw new Error('server tidak siap');
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  server.kill();
  await new Promise((r) => setTimeout(r, 800));

  // --- verifikasi hasil di database -------------------------------------
  // Dibaca ulang lewat koneksi terpisah supaya nilai yang diperiksa benar-benar
  // dari disk, bukan cache proses tes.
  const after = require('better-sqlite3')(DB, { readonly: true });
  const rows = after.prepare('SELECT id, status, pid, error_message FROM streams ORDER BY id').all();
  const logs = after.prepare("SELECT stream_id, message FROM stream_logs WHERE level = 'warn'").all();
  after.close();

  const a = rows.find((r) => r.id === withRestart.id);
  const b = rows.find((r) => r.id === noRestart.id);

  check('tidak ada lagi stream berstatus live', rows.filter((r) => r.status === 'live').length, 0);
  check('auto_restart=1 → idle', a.status, 'idle');
  check('auto_restart=1 → tanpa pesan error', a.error_message, null);
  check('auto_restart=0 → error', b.status, 'error');
  check('auto_restart=0 → diberi pesan sebab', b.error_message, 'Aplikasi restart saat siaran berjalan');
  check('pid lama dibersihkan', [a.pid, b.pid], [null, null]);
  check('kedua stream dapat log peringatan',
    logs.filter((l) => l.message.includes('Aplikasi direstart')).length, 2);
  check('log server mencatat pembersihan', /2 stream dibersihkan setelah restart aplikasi/.test(stderr), true);
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
