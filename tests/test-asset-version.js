'use strict';

// URL /assets wajib membawa penanda versi.
//
// express.static melayani /assets dengan Cache-Control 7 hari di production
// (app.js). URL yang tetap sama setelah isinya berubah berarti browser yang
// sudah pernah membuka halaman memakai CSS/JS lama sampai seminggu penuh,
// termasuk setelah image Docker dibangun ulang — persis yang terjadi pada
// perbaikan modal Impor dari Drive.
//
// Dua hal yang dijaga di sini: assetUrl() benar-benar menempelkan sidik jari
// isi berkas, dan tidak ada layout/view yang menulis URL /assets mentah
// sehingga melewati helper itu.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS = path.join(ROOT, 'views');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

// ---- perilaku assetUrl() -------------------------------------------------
const { assetUrl } = require('../utils/asset-version');

const cssUrl = assetUrl('/css/app.css');
check('assetUrl menempelkan ?v= pada berkas yang ada',
  /^\/assets\/css\/app\.css\?v=[0-9a-f]{8}$/.test(cssUrl), true);

check('garis miring di depan tidak digandakan',
  assetUrl('css/app.css') === cssUrl, true);

check('pemanggilan berulang untuk isi yang sama menghasilkan URL sama',
  assetUrl('/css/app.css') === cssUrl, true);

check('berkas yang tidak ada tetap menghasilkan URL tanpa ?v=',
  assetUrl('/css/tidak-ada-berkas-ini.css'), '/assets/css/tidak-ada-berkas-ini.css');

// Sidik jari harus ikut isi berkas, bukan nama atau waktu ubah. Tanpa ini
// penanda versi tidak berguna: rebuild dengan CSS baru akan memakai URL lama.
const probe = path.join(PUBLIC_DIR, '.asset-version-probe.css');
const prevEnv = process.env.NODE_ENV;
try {
  // Mode development: sidik jari dihitung ulang tiap pemanggilan, jadi
  // perubahan isi langsung terlihat tanpa restart.
  process.env.NODE_ENV = 'development';

  fs.writeFileSync(probe, 'a{color:red}');
  const before = assetUrl('/.asset-version-probe.css');

  fs.writeFileSync(probe, 'a{color:blue}');
  const after = assetUrl('/.asset-version-probe.css');

  check('isi berubah → penanda versi ikut berubah', before !== after, true);
  check('penanda sebelum dan sesudah sama-sama 8 hex',
    /\?v=[0-9a-f]{8}$/.test(before) && /\?v=[0-9a-f]{8}$/.test(after), true);

  fs.writeFileSync(probe, 'a{color:red}');
  check('isi dikembalikan → penanda versi kembali sama juga',
    assetUrl('/.asset-version-probe.css'), before);
} finally {
  fs.rmSync(probe, { force: true });
  if (prevEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevEnv;
}

// ---- views: tidak boleh ada URL /assets mentah ---------------------------
function ejsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return ejsFiles(full);
    return entry.name.endsWith('.ejs') ? [full] : [];
  });
}

const rawRefs = [];
for (const file of ejsFiles(VIEWS)) {
  const html = fs.readFileSync(file, 'utf8');
  for (const m of html.matchAll(/(?:href|src)\s*=\s*"(\/assets\/[^"]*)"/g)) {
    rawRefs.push(`${path.relative(ROOT, file)}: ${m[1]}`);
  }
}
for (const ref of rawRefs) console.log(`info  ${ref} ditulis mentah, seharusnya lewat assetUrl()`);

check('tidak ada view yang menulis URL /assets tanpa assetUrl()', rawRefs.length, 0);

// Pemindai wajib benar-benar melihat aset yang dipakai layout. Kalau tidak,
// pemeriksaan di atas lolos kosong dan tes ini tidak menjaga apa pun.
const layoutSrc = ['main', 'blank']
  .map((n) => fs.readFileSync(path.join(VIEWS, 'layouts', `${n}.ejs`), 'utf8')).join('\n');
check('layout memanggil assetUrl untuk app.css',
  /assetUrl\(\s*'\/css\/app\.css'\s*\)/.test(layoutSrc), true);
check('layout memanggil assetUrl untuk app.js',
  /assetUrl\(\s*'\/js\/app\.js'\s*\)/.test(layoutSrc), true);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
