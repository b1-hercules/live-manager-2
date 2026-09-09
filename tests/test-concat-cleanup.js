'use strict';

// Kebersihan daftar concat playlist:
//   - pratinjau perintah tidak boleh menulis berkas (dulu ia menulis, dari GET),
//   - siaran yang mati permanen membersihkan daftarnya,
//   - sisa dari proses sebelumnya disapu saat boot,
//   - sweep hanya menyentuh yang tidak dimiliki siaran berjalan.
// Sekaligus membuktikan rotasi metadata tetap jalan pada siaran bersumber
// playlist — dua fitur itu bertumpuk, bukan saling meniadakan.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'db', 'livemanager.db');
const BACKUP = path.join(os.tmpdir(), `lm-concat-backup-${Date.now()}.db`);
const TMP = path.join(ROOT, 'storage', 'tmp');
const PORT = 7589;
const SINK_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = { username: `__test_concat_${Date.now()}`, password: 'TestPassword!234' };

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

async function login(client) {
  const page = await (await client.req('/login')).text();
  const token = page.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  await client.req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...USER, _csrf: token }).toString(),
  });
  const home = await (await client.req('/')).text();
  return home.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
}

const madeFiles = [];
let server = null;
let rtmpSink = null;

async function bootServer() {
  const proc = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const collect = (d) => { logs.push(String(d)); };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);

  const deadline = Date.now() + 25000;
  for (;;) {
    try { await fetch(`${BASE}/login`, { redirect: 'manual' }); break; } catch (_) {
      if (Date.now() > deadline) {
        // Tanpa keluaran server, kegagalan boot tidak bisa didiagnosis sama sekali.
        console.log('--- keluaran server ---\n' + logs.join('').slice(-2000));
        throw new Error('server tidak siap');
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return { proc, logs };
}

/** Tunggu sampai kondisi terpenuhi, bukan menunggu sekian detik buta. */
async function until(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  require('better-sqlite3')(DB).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, BACKUP);

  // ======================================================= unit: tanpa server
  console.log('--- penyusunan & pembersihan daftar (unit) ---');
  const ffmpeg = require(path.join(ROOT, 'services/ffmpeg'));

  const fakeItems = [
    { filepath: path.join(ROOT, 'storage/videos/satu.mp4'), has_audio: 1, audio_codec: 'aac', duration: 4 },
    { filepath: path.join(ROOT, 'storage/videos/dua.mp4'), has_audio: 1, audio_codec: 'aac', duration: 6 },
  ];
  const UNIT_ID = 9001;
  const unitPath = ffmpeg.concatPathFor(UNIT_ID);
  try { fs.unlinkSync(unitPath); } catch (_) { /* bersih dari awal */ }

  const dry = ffmpeg.buildConcatSource(UNIT_ID, fakeItems, { write: false });
  check('write:false tidak membuat berkas', fs.existsSync(unitPath), false);
  check('write:false tetap memberi concatPath', dry.concatPath, unitPath);
  check('write:false tetap menghitung metadata', [dry.has_audio, dry.duration], [1, 10]);

  const wet = ffmpeg.buildConcatSource(UNIT_ID, fakeItems);
  check('bawaan (write:true) membuat berkas', fs.existsSync(unitPath), true);
  check('path sama antara dry dan write', wet.concatPath, dry.concatPath);
  const lines = fs.readFileSync(unitPath, 'utf8').trim().split('\n');
  check('berkas berisi dua baris', lines.length, 2);
  check('path memakai garis miring maju', /^file '.*\/storage\/videos\/satu\.mp4'$/.test(lines[0]), true);

  ffmpeg.cleanupConcatFile(UNIT_ID);
  check('cleanup menghapus berkas', fs.existsSync(unitPath), false);
  let threw = false;
  try { ffmpeg.cleanupConcatFile(UNIT_ID); } catch (_) { threw = true; }
  check('cleanup berulang tidak melempar', threw, false);

  // --- sweep: hanya yang yatim -------------------------------------------
  const orphan = ffmpeg.concatPathFor(9002);
  const busy = ffmpeg.concatPathFor(9003);
  const decoyName = path.join(TMP, 'playlist_bukan_angka.txt');
  const decoyUpload = path.join(TMP, '__test_decoy.part');
  fs.writeFileSync(orphan, "file 'x'\n");
  fs.writeFileSync(busy, "file 'y'\n");
  fs.writeFileSync(decoyName, 'bukan daftar concat');
  fs.writeFileSync(decoyUpload, 'potongan unggahan');

  const removed = ffmpeg.sweepConcatFiles((id) => id !== 9003);
  check('sweep menghapus yang yatim saja', removed, 1);
  check('daftar yatim hilang', fs.existsSync(orphan), false);
  check('daftar milik siaran berjalan tetap ada', fs.existsSync(busy), true);
  check('nama di luar pola tidak disentuh', fs.existsSync(decoyName), true);
  check('berkas unggahan tidak disentuh', fs.existsSync(decoyUpload), true);
  for (const f of [busy, decoyName, decoyUpload]) fs.unlinkSync(f);

  // ============================================== data uji untuk integrasi
  const videosDir = path.join(ROOT, 'storage', 'videos');
  const clips = [];
  for (const name of ['a', 'b']) {
    const file = `__test_cc_${name}_${Date.now()}.mp4`;
    const abs = path.join(videosDir, file);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc=duration=4:size=640x480:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', abs], { stdio: 'pipe' });
    madeFiles.push(abs);
    clips.push({ file, abs });
  }

  const userModel = require(path.join(ROOT, 'models/user'));
  const videoModel = require(path.join(ROOT, 'models/video'));
  const destModel = require(path.join(ROOT, 'models/destination'));
  const rotationModel = require(path.join(ROOT, 'models/rotation'));

  const user = userModel.create(USER);
  const videos = clips.map((clip, i) => videoModel.create({
    user_id: user.id, title: `Klip ${i + 1}`, filename: clip.file,
    filepath: `storage/videos/${clip.file}`, filesize: fs.statSync(clip.abs).size,
    duration: 4, width: 640, height: 480, fps: 25,
    video_codec: 'h264', audio_codec: 'aac', has_audio: 1,
  }));
  const dest = destModel.create({
    user_id: user.id, name: 'Sink Lokal', platform: 'custom',
    rtmp_url: `rtmp://127.0.0.1:${SINK_PORT}/live`, stream_key: 'uji',
  });
  const profile = rotationModel.createProfile({ user_id: user.id, name: 'Profil Uji Concat', mode: 'bundle' });
  rotationModel.createItem(profile.id, { title: 'Judul Rotasi Uji', weight: 1, active: 1 });
  require(path.join(ROOT, 'db')).db.close();

  const booted = await bootServer();
  server = booted.proc;

  const client = jar();
  const token = await login(client);
  const post = (url, fields) => client.req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });

  const plRes = await post('/playlists', { name: 'Playlist Concat' });
  const plId = Number(plRes.headers.get('location').split('/').pop());
  for (const v of videos) await post(`/playlists/${plId}/items`, { video_id: String(v.id) });

  // Rotasi ikut diaktifkan: sumber playlist + rotasi metadata harus bisa
  // berjalan bersamaan, sebab keduanya memang sumbu yang berbeda.
  const streamRes = await post('/streams', {
    title: 'Siaran Playlist + Rotasi', playlist_id: String(plId), video_id: '',
    destination_ids: String(dest.id), encode_mode: 'copy', resolution: 'source',
    orientation: 'landscape', bitrate: '2500', audio_bitrate: '128', fps: '25',
    preset: 'ultrafast', loop_video: '1',
    rotation_profile_id: String(profile.id), rotation_enabled: '1', rotate_on_start: '1',
    // auto_restart sengaja tidak dikirim → mati, supaya kegagalan bersifat final.
  });
  const streamId = Number(streamRes.headers.get('location').split('/').pop());
  const concatFile = ffmpeg.concatPathFor(streamId);

  // ------------------------------------- pratinjau tidak boleh menulis berkas
  console.log('\n--- pratinjau perintah (inti perbaikan) ---');
  try { fs.unlinkSync(concatFile); } catch (_) { /* memang belum ada */ }
  const detail = await (await client.req(`/streams/${streamId}`)).text();
  check('pratinjau tetap menampilkan concat', /-f concat/.test(detail), true);
  check('pratinjau menyebut berkas daftarnya', detail.includes(`playlist_${streamId}.txt`), true);
  check('membuka detail TIDAK menulis daftar concat', fs.existsSync(concatFile), false);

  for (let i = 0; i < 3; i++) await client.req(`/streams/${streamId}`);
  check('dibuka berulang tetap tidak menulis', fs.existsSync(concatFile), false);

  // --------------------------------------------- siaran nyata lalu mati total
  console.log('\n--- siaran mati permanen (auto-restart off) ---');
  rtmpSink = spawn('ffmpeg', ['-y', '-loglevel', 'error',
    '-listen', '1', '-i', `rtmp://127.0.0.1:${SINK_PORT}/live/uji`,
    '-c', 'copy', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 1200));

  await post(`/streams/${streamId}/start`, {});
  const live = await until('live', async () => {
    const data = await (await client.req('/api/overview', { headers: { Accept: 'application/json' } })).json();
    const s = data.streams.find((x) => x.id === streamId);
    return s && s.runtime && s.runtime.stats.frame > 0 ? s : null;
  });
  check('siaran playlist benar-benar mengalir', Boolean(live), true);
  check('daftar concat ditulis saat siaran dimulai', fs.existsSync(concatFile), true);

  // Rotasi diperiksa selagi siaran hidup: sumber playlist tidak menghalanginya.
  console.log('\n--- rotasi metadata pada siaran bersumber playlist ---');
  const state = await until('rotation_state', async () => {
    const db = require('better-sqlite3')(DB, { readonly: true });
    const row = db.prepare('SELECT * FROM rotation_state WHERE stream_id = ?').get(streamId);
    const logs = db.prepare("SELECT message FROM stream_logs WHERE stream_id = ? AND message LIKE '%varian rotasi pertama%'").all(streamId);
    db.close();
    return row ? { row, logs } : null;
  }, 15000);
  check('rotasi menyimpan state untuk stream playlist', Boolean(state), true);
  check('state menunjuk profil yang benar', state && state.row.profile_id, profile.id);
  check('rotasi pertama dijalankan saat siaran mulai (rotate_on_start)',
    Boolean(state && state.logs.length), true);

  // Sink dimatikan → FFmpeg kehilangan tujuan dan berhenti dengan error.
  rtmpSink.kill();
  rtmpSink = null;

  // Status dibaca dari database, bukan dari HTML: halaman detail menampilkan
  // baris log ber-level ERROR selagi siaran masih hidup, jadi mencocokkan kata
  // "ERROR" di halaman membuat pemeriksaan ini lolos terlalu cepat.
  const readStream = () => {
    const db = require('better-sqlite3')(DB, { readonly: true });
    const row = db.prepare('SELECT status, auto_restart FROM streams WHERE id = ?').get(streamId);
    db.close();
    return row;
  };
  check('auto_restart memang mati (kegagalan bersifat final)', readStream().auto_restart, 0);
  const errored = await until('status error', async () => readStream().status === 'error', 60000);
  check('siaran berakhir dengan status error', Boolean(errored), true);
  check('daftar concat dibersihkan setelah gagal permanen', fs.existsSync(concatFile), false);

  // ------------------------------------------------- sisa dibersihkan saat boot
  console.log('\n--- pembersihan saat boot ---');
  server.kill();
  await new Promise((r) => setTimeout(r, 1500));
  const leftover = ffmpeg.concatPathFor(9999);
  fs.writeFileSync(leftover, "file 'sisa-dari-proses-yang-mati'\n");
  check('sisa daftar disiapkan sebelum boot', fs.existsSync(leftover), true);

  const rebooted = await bootServer();
  server = rebooted.proc;
  const swept = await until('boot sweep', async () => !fs.existsSync(leftover), 15000);
  check('daftar sisa dihapus saat aplikasi boot', Boolean(swept), true);
  check('pembersihannya dicatat di log',
    /daftar playlist sisa siaran sebelumnya dihapus/.test(rebooted.logs.join('')), true);
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
      for (const f of fs.readdirSync(TMP)) {
        if (f.startsWith('playlist_') || f.startsWith('__test_decoy')) {
          try { fs.unlinkSync(path.join(TMP, f)); } catch (_) { /* dipegang proses lain */ }
        }
      }
      console.log(`\nDB dikembalikan, ${madeFiles.length} berkas uji dihapus.\n${pass} pass, ${fail} fail`);
      process.exit(fail ? 1 : 0);
    }, 1000);
  });
