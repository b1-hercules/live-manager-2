#!/usr/bin/env node
'use strict';

const crypto = require('crypto');

console.log('\nSalin dua baris ini ke file .env kamu:\n');
console.log(`SESSION_SECRET=${crypto.randomBytes(48).toString('hex')}`);
console.log(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
console.log(
  '\nCatatan: ENCRYPTION_KEY dipakai untuk mengenkripsi refresh token YouTube.\n' +
  'Kalau kunci ini diganti, semua akun YouTube yang sudah terhubung harus\n' +
  'dihubungkan ulang.\n'
);
