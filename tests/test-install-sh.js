'use strict';

// Uji install.sh tanpa menyentuh sistem. Semua perintah yang punya efek samping
// (sudo, apt-get, docker, npm, pm2, systemctl, usermod, curl, ss, ...) diganti
// stub yang hanya mencatat pemanggilannya. PATH dibatasi ke stub + symlink
// perkakas dasar yang memang dipakai skrip, sehingga "belum terpasang" bisa
// disimulasikan cukup dengan tidak menyediakan stub-nya.
//
// INSTALL_SH=/path/lain.sh menguji salinan lain (dipakai untuk membuktikan
// tes ini bisa merah terhadap versi yang sengaja dirusak).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = process.env.INSTALL_SH || path.join(ROOT, 'install.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'install-sh-'));
const ME = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

// ---- perkakas dasar (asli) ------------------------------------------------
const TOOLS_DIR = path.join(TMP, 'tools');
fs.mkdirSync(TOOLS_DIR);
const TOOLS = ['bash', 'env', 'sed', 'grep', 'tail', 'head', 'cut', 'tr', 'od', 'cp', 'find',
  'id', 'dirname', 'basename', 'sleep', 'openssl', 'cat', 'rm', 'touch', 'mkdir', 'chmod'];
for (const tool of TOOLS) {
  const res = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  if (res.status === 0) fs.symlinkSync(res.stdout.trim(), path.join(TOOLS_DIR, tool));
}

// ---- stub -----------------------------------------------------------------
const LOG = 'echo "$(basename "$0") $*" >> "$STUB_LOG"';
const STUBS = {
  sudo: `${LOG}\nexport STUB_AS_ROOT=1\nexec "$@"`,
  'apt-get': `${LOG}
for a in "$@"; do
  case $a in
    docker-compose-v2|docker-compose-plugin) touch "$STUB_STATE/compose" ;;
    docker.io) cp "$STUB_SRC/docker" "$STUB_BIN/docker"; chmod +x "$STUB_BIN/docker" ;;
  esac
done`,
  systemctl: LOG,
  usermod: LOG,
  dpkg: `${LOG}\nexit 1`,
  docker: `${LOG}
case $1 in
  info) [[ -n $STUB_DOCKER_NEEDS_SUDO && -z $STUB_AS_ROOT ]] && exit 1; exit 0 ;;
  compose)
    if [[ $2 == version ]]; then
      [[ -f $STUB_STATE/compose ]] && { echo "Docker Compose version v2.40.3"; exit 0; }
      echo "docker: unknown command: docker compose" >&2; exit 1
    fi ;;
  ps) [[ -n $STUB_CONTAINER_RUNNING ]] && echo abc123 ;;
esac
exit 0`,
  ss: `${LOG}\n[[ -n $STUB_PORT_BUSY ]] && echo "LISTEN 0 511 0.0.0.0:7575 0.0.0.0:*"\nexit 0`,
  curl: LOG,
  node: `case $1 in -p) echo "\${STUB_NODE_MAJOR:-22}" ;; -v) echo "v\${STUB_NODE_MAJOR:-22}.0.0" ;; esac`,
  ffmpeg: `echo "ffmpeg version \${STUB_FFMPEG:-5.1.6} Copyright (c) 2000-2024"`,
  ffprobe: 'exit 0',
  liquidsoap: 'exit 0',
  npm: `${LOG}\n[[ "$1 $2" == "prefix -g" ]] && echo "$STUB_STATE"\nexit 0`,
  pm2: `${LOG}
case $1 in
  jlist) [[ -n $STUB_PM2_HAS_APP ]] && echo '[{"name":"livemanager"}]' || echo '[]' ;;
  -v) echo 5.4.0 ;;
esac
exit 0`,
};
const SRC = path.join(TMP, 'stub-src');
fs.mkdirSync(SRC);
for (const [name, body] of Object.entries(STUBS)) {
  fs.writeFileSync(path.join(SRC, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

// ---- satu instalasi palsu -------------------------------------------------
function setup(name, { omit = [], compose = false, env: dotenv } = {}) {
  const dir = path.join(TMP, name);
  const app = path.join(dir, 'app');
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  for (const d of [app, bin, state, ...['storage', 'db', 'logs'].map((s) => path.join(app, s))]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.copyFileSync(SCRIPT, path.join(app, 'install.sh'));
  for (const f of ['.env.example', 'docker-compose.yml', 'ecosystem.config.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(app, f));
  }
  for (const stub of Object.keys(STUBS)) {
    if (!omit.includes(stub)) fs.copyFileSync(path.join(SRC, stub), path.join(bin, stub));
  }
  if (compose) fs.writeFileSync(path.join(state, 'compose'), '');
  if (dotenv) fs.writeFileSync(path.join(app, '.env'), dotenv);
  return { dir, app, bin, state };
}

function run(inst, args, env = {}) {
  const log = path.join(inst.dir, 'calls.log');
  fs.writeFileSync(log, '');
  const res = spawnSync('/bin/bash', [path.join(inst.app, 'install.sh'), ...args], {
    env: {
      PATH: `${inst.bin}:${TOOLS_DIR}`,
      HOME: inst.dir,
      STUB_LOG: log,
      STUB_STATE: inst.state,
      STUB_BIN: inst.bin,
      STUB_SRC: SRC,
      ...env,
    },
    input: '',            // stdin bukan terminal: tanpa -y semua pertanyaan dijawab "tidak"
    encoding: 'utf8',
    timeout: 30000,
  });
  const envFile = path.join(inst.app, '.env');
  return {
    code: res.status,
    out: `${res.stdout}${res.stderr}`,
    calls: fs.readFileSync(log, 'utf8'),
    dotenv: fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '',
  };
}

function envValue(dotenv, key) {
  const lines = dotenv.split('\n').filter((l) => l.startsWith(`${key}=`));
  return lines.length ? lines[lines.length - 1].slice(key.length + 1) : undefined;
}

const HEX96 = /^[0-9a-f]{96}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// ---- sintaks & argumen ----------------------------------------------------
check('bash -n install.sh', spawnSync('bash', ['-n', SCRIPT]).status, 0);

{
  const r = run(setup('noarg'), []);
  check('tanpa mode & tanpa terminal: gagal', r.code !== 0, true);
  check('  ...dan menyebut cara memakainya', r.out.includes('./install.sh docker'), true);
  check('  ...tanpa menyentuh apa pun', r.calls, '');
}
{
  const r = run(setup('badarg'), ['podman']);
  check('argumen tak dikenal: gagal', r.code !== 0, true);
  check('  ...dengan pesan jelas', r.out.includes('Argumen tidak dikenal: podman'), true);
}

// ---- Docker ---------------------------------------------------------------
{
  const inst = setup('docker-fresh');
  const r = run(inst, ['docker', '-y']);
  check('docker, instalasi baru: sukses', r.code, 0);
  check('  .env dibuat, SESSION_SECRET 48 byte hex', HEX96.test(envValue(r.dotenv, 'SESSION_SECRET')), true);
  check('  ENCRYPTION_KEY 32 byte hex', HEX64.test(envValue(r.dotenv, 'ENCRYPTION_KEY')), true);
  check('  APP_URL bawaan localhost', envValue(r.dotenv, 'APP_URL'), 'http://localhost:7575');
  check('  plugin compose dipasang lewat sudo apt',
    r.calls.includes('sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2'), true);
  check('  docker.io TIDAK dipasang ulang (docker sudah ada)', r.calls.includes('docker.io'), false);
  check('  docker compose up -d --build', r.calls.includes('docker compose up -d --build'), true);
  check('  /health ditunggu', r.calls.includes('curl -fsS -o /dev/null http://127.0.0.1:7575/health'), true);

  const again = run(inst, ['docker', '-y']);
  check('docker, dijalankan ulang: sukses', again.code, 0);
  check('  SESSION_SECRET tidak berubah',
    envValue(again.dotenv, 'SESSION_SECRET'), envValue(r.dotenv, 'SESSION_SECRET'));
  check('  ENCRYPTION_KEY tidak berubah',
    envValue(again.dotenv, 'ENCRYPTION_KEY'), envValue(r.dotenv, 'ENCRYPTION_KEY'));
  check('  tidak ada apt-get lagi', again.calls.includes('apt-get'), false);
}
{
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const key = 'a'.repeat(64);
  const dotenv = example
    .replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${key}`)
    .replace(/^APP_URL=.*$/m, 'APP_URL=https://live.example.com');
  const r = run(setup('docker-placeholder', { compose: true, env: dotenv }), ['docker', '-y']);
  check('placeholder "ganti-dengan-..." diganti', HEX96.test(envValue(r.dotenv, 'SESSION_SECRET')), true);
  check('  ENCRYPTION_KEY yang sudah terisi dipertahankan', envValue(r.dotenv, 'ENCRYPTION_KEY'), key);
  check('  APP_URL yang sudah diisi dipertahankan', envValue(r.dotenv, 'APP_URL'), 'https://live.example.com');
  check('  tidak ada baris ganda', r.dotenv.split('\n').filter((l) => l.startsWith('SESSION_SECRET=')).length, 1);
}
{
  const r = run(setup('docker-busy', { compose: true }), ['docker', '-y'], { STUB_PORT_BUSY: '1' });
  check('docker, port dipakai proses lain: gagal', r.code !== 0, true);
  check('  ...dengan pesan port', r.out.includes('sudah dipakai'), true);
  check('  ...tanpa menjalankan container', r.calls.includes('compose up'), false);
}
{
  const r = run(setup('docker-own', { compose: true }), ['docker', '-y'],
    { STUB_PORT_BUSY: '1', STUB_CONTAINER_RUNNING: '1' });
  check('docker, port dipegang container sendiri: lanjut', r.code, 0);
  check('  ...container diperbarui', r.calls.includes('docker compose up -d --build'), true);
}
{
  const r = run(setup('docker-missing', { omit: ['docker'] }), ['docker', '-y']);
  check('docker belum terpasang: sukses', r.code, 0);
  check('  docker.io + docker-compose-v2 dipasang',
    r.calls.includes('apt-get install -y -qq docker.io docker-compose-v2'), true);
  check('  layanan docker dinyalakan', r.calls.includes('systemctl enable --now docker'), true);
  check('  container dijalankan', r.calls.includes('docker compose up -d --build'), true);
}
{
  const r = run(setup('docker-sudo', { compose: true }), ['docker', '-y'], { STUB_DOCKER_NEEDS_SUDO: '1' });
  check('docker butuh sudo: sukses', r.code, 0);
  check('  compose dijalankan lewat sudo', r.calls.includes('sudo docker compose up -d --build'), true);
}
{
  const r = run(setup('docker-no'), ['docker']);
  check('docker tanpa -y & tanpa terminal: menolak memasang paket', r.code !== 0, true);
  check('  ...apt-get tidak disentuh', r.calls.includes('apt-get'), false);
}

// ---- npm + PM2 ------------------------------------------------------------
{
  const r = run(setup('npm-fresh'), ['npm', '-y']);
  check('npm, instalasi baru: sukses', r.code, 0);
  check('  npm install', r.calls.includes('npm install --no-audit --no-fund'), true);
  check('  pm2 start ecosystem.config.js', r.calls.includes('pm2 start ecosystem.config.js'), true);
  check('  pm2 save', r.calls.includes('pm2 save'), true);
  check('  pm2 startup untuk user ini', r.calls.includes(`pm2 startup systemd -u ${ME}`), true);
  check('  tidak restart (belum ada di PM2)', r.calls.includes('pm2 restart'), false);
  check('  tidak ada apt-get (semua sudah ada)', r.calls.includes('apt-get'), false);
  check('  tanpa peringatan FFmpeg 6.1 (stub 5.1)', r.out.includes('frame='), false);
}
{
  const r = run(setup('npm-again'), ['npm', '-y'], { STUB_PM2_HAS_APP: '1', STUB_PORT_BUSY: '1' });
  check('npm, sudah ada di PM2: sukses walau port terpakai (miliknya sendiri)', r.code, 0);
  check('  pm2 restart --update-env', r.calls.includes('pm2 restart livemanager --update-env'), true);
  check('  tidak start ganda', r.calls.includes('pm2 start ecosystem.config.js'), false);
}
{
  const r = run(setup('npm-busy'), ['npm', '-y'], { STUB_PORT_BUSY: '1' });
  check('npm, port dipakai proses lain: gagal', r.code !== 0, true);
  check('  ...tanpa pm2 start', r.calls.includes('pm2 start ecosystem.config.js'), false);
}
{
  const r = run(setup('npm-node24'), ['npm', '-y'], { STUB_NODE_MAJOR: '24', STUB_FFMPEG: '6.1.1-3ubuntu5' });
  check('npm di Node 24 tanpa build tools: sukses', r.code, 0);
  check('  build-essential + python3 dipasang',
    r.calls.includes('apt-get install -y -qq build-essential python3'), true);
  check('  peringatan FFmpeg 6.1 muncul', r.out.includes('tidak mencetak frame='), true);
}
{
  const r = run(setup('npm-noffmpeg', { omit: ['ffmpeg', 'ffprobe'] }), ['npm']);
  check('npm tanpa FFmpeg, tanpa -y: berhenti', r.code !== 0, true);
  check('  ...sebelum npm install', r.calls.includes('npm install'), false);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
