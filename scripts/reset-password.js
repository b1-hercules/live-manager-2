#!/usr/bin/env node
'use strict';

/**
 * Reset password lewat terminal, untuk kasus lupa password.
 * Pemakaian:
 *   npm run reset-password                      -> daftar user
 *   npm run reset-password -- <username> <baru> -> ganti password
 */

const { migrate } = require('../db/migrate');
const userModel = require('../models/user');
const { db } = require('../db');

migrate();

const [username, password] = process.argv.slice(2);

if (!username) {
  const users = db.prepare('SELECT id, username, display_name, last_login_at FROM users ORDER BY id').all();
  if (!users.length) {
    console.log('\nBelum ada user. Jalankan aplikasi lalu buka /setup untuk membuat akun admin.\n');
    process.exit(0);
  }
  console.log('\nDaftar user:\n');
  for (const u of users) {
    console.log(`  #${u.id}  ${u.username}${u.display_name && u.display_name !== u.username ? ` (${u.display_name})` : ''}`);
  }
  console.log('\nGanti password dengan:\n  npm run reset-password -- <username> <password-baru>\n');
  process.exit(0);
}

if (!password || password.length < 8) {
  console.error('\nPassword baru wajib diisi dan minimal 8 karakter.\n');
  process.exit(1);
}

const user = userModel.findByUsername(username);
if (!user) {
  console.error(`\nUser "${username}" tidak ditemukan.\n`);
  process.exit(1);
}

userModel.setPassword(user.id, password);

// Sesi lama tidak boleh tetap berlaku setelah password diganti.
const removed = db.prepare('DELETE FROM sessions').run().changes;

console.log(`\nPassword untuk "${user.username}" berhasil diganti.`);
console.log(`${removed} sesi aktif dihapus — semua perangkat harus login ulang.\n`);
process.exit(0);
