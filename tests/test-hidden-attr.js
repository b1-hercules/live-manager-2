'use strict';

// Atribut `hidden` harus benar-benar menyembunyikan elemen.
//
// Aturan `hidden` bawaan browser hanyalah `display: none` di stylesheet
// user-agent, dan stylesheet penulis SELALU menang atasnya. Elemen ber-`hidden`
// yang kelasnya menyetel `display` (grid, flex, inline-flex) jadi tetap tampil —
// begitulah modal Impor dari Drive muncul sejak /videos dibuka, dan tombol
// Tutup-nya (yang hanya menyetel `modal.hidden = true`) tidak berefek apa pun.
//
// Tes statis, tanpa browser: memindai views/ untuk elemen ber-`hidden`, lalu
// mencocokkan kelasnya dengan aturan `display` di public/css/app.css.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS_FILE = path.join(ROOT, 'public', 'css', 'app.css');
const VIEWS = path.join(ROOT, 'views');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${actual} want=${expected}`);
}

// ---- CSS: kelas yang menyetel display selain none ------------------------
const css = fs.readFileSync(CSS_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].trim().split(',').map((s) => s.trim()),
  body: m[2],
}));

const displayClasses = new Set();
for (const rule of rules) {
  const display = /(?:^|;)\s*display\s*:\s*([^;!]+)/.exec(rule.body);
  if (!display || display[1].trim() === 'none') continue;
  for (const selector of rule.selectors) {
    // Hanya subjek selektor (compound terakhir) yang menentukan elemen mana
    // yang kena: `.card-head h2` menyetel display pada h2, bukan .card-head.
    const subject = selector.split(/[\s>+~]+/).pop();
    for (const c of subject.matchAll(/\.([\w-]+)/g)) displayClasses.add(c[1]);
  }
}

const globalHidden = rules.some((r) =>
  r.selectors.includes('[hidden]') && /display\s*:\s*none\s*!important/.test(r.body));

// ---- views: elemen yang membawa atribut hidden ---------------------------
function ejsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return ejsFiles(full);
    return entry.name.endsWith('.ejs') ? [full] : [];
  });
}

const hiddenElements = [];
for (const file of ejsFiles(VIEWS)) {
  const html = fs.readFileSync(file, 'utf8')
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    // `<%= cond ? 'hidden' : '' %>` dihitung ber-hidden: salah satu cabangnya memang begitu.
    .replace(/<%[=-]?([\s\S]*?)%>/g, (m, code) => (/'hidden'|"hidden"/.test(code) ? ' hidden ' : ' '));

  for (const tag of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/g)) {
    const attrs = tag[2];
    if (!/(?:^|\s)hidden(?=[\s=/]|$)/.test(attrs)) continue;
    const id = (/\bid="([^"]*)"/.exec(attrs) || [])[1] || '';
    const classes = ((/\bclass="([^"]*)"/.exec(attrs) || [])[1] || '').split(/\s+/).filter(Boolean);
    hiddenElements.push({ file: path.relative(ROOT, file), tag: tag[1], id, classes });
  }
}

const conflicts = hiddenElements.filter((el) => el.classes.some((c) => displayClasses.has(c)));
for (const el of conflicts) {
  console.log(`info  ${el.file}: <${el.tag}${el.id ? ` id="${el.id}"` : ''} class="${el.classes.join(' ')}"> `
    + 'ber-hidden, tapi kelasnya menyetel display');
}

// Pemindai wajib menemukan kasus yang memang ada. Kalau tidak, pemeriksaan
// terakhir lolos kosong dan tes ini tidak menjaga apa-apa.
check('pemindai mengenali #driveModal (.modal-backdrop, display: grid)',
  conflicts.some((el) => el.id === 'driveModal'), true);
check('pemindai mengenali #uploadCancel (.btn, display: inline-flex)',
  conflicts.some((el) => el.id === 'uploadCancel'), true);

check('app.css punya [hidden] { display: none !important } selama ada elemen yang bentrok',
  conflicts.length === 0 || globalHidden, true);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
