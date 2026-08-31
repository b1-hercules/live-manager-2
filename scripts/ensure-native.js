#!/usr/bin/env node
'use strict';

/**
 * npm >= 12 memblokir install script milik dependency secara default, sehingga
 * `prebuild-install` milik better-sqlite3 tidak pernah jalan dan binary native
 * tidak ikut terpasang. Script ini dipanggil dari `postinstall` (script milik
 * root package selalu boleh jalan) untuk mengunduh binary yang tepat kalau
 * memang belum ada. Aman dipanggil berulang kali.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const PKG_DIR = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');

function bindingExists() {
  const candidates = [
    path.join(PKG_DIR, 'build', 'Release', 'better_sqlite3.node'),
    path.join(PKG_DIR, 'build', 'better_sqlite3.node'),
    path.join(PKG_DIR, 'prebuilds'),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

function main() {
  if (!fs.existsSync(PKG_DIR)) return; // dependency belum terpasang, tidak apa-apa
  if (bindingExists()) return;

  console.log('[setup] Binary native better-sqlite3 belum ada, mengunduh...');

  const prebuild = path.join(__dirname, '..', 'node_modules', 'prebuild-install', 'bin.js');
  if (fs.existsSync(prebuild)) {
    const res = spawnSync(process.execPath, [prebuild, '--runtime=node', `--target=${process.versions.node}`], {
      cwd: PKG_DIR,
      stdio: 'inherit',
    });
    if (res.status === 0 && bindingExists()) {
      console.log('[setup] Binary native terpasang.');
      return;
    }
  }

  console.log('[setup] Prebuild gagal/tidak tersedia, mencoba kompilasi dari sumber...');
  const gyp = spawnSync('npx', ['--yes', 'node-gyp', 'rebuild', '--release'], {
    cwd: PKG_DIR,
    stdio: 'inherit',
    shell: true,
  });

  if (gyp.status !== 0 || !bindingExists()) {
    console.warn(
      '\n[setup] Tidak bisa menyiapkan better-sqlite3 otomatis.\n' +
      '        Jalankan manual:\n' +
      '          cd node_modules/better-sqlite3 && npx prebuild-install --runtime=node\n' +
      '        Atau pasang build tools (Windows: Visual Studio Build Tools, Linux: build-essential python3).\n'
    );
  }
}

try {
  main();
} catch (err) {
  console.warn('[setup] ensure-native dilewati:', err.message);
}
