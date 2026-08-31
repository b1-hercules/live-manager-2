'use strict';

const crypto = require('crypto');
const config = require('../config');

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';

/**
 * Enkripsi string (dipakai untuk refresh token OAuth) dengan AES-256-GCM.
 * Format keluaran: v1:<iv-hex>:<tag-hex>:<ciphertext-hex>
 */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, config.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(payload) {
  if (!payload) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const [, ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(ALGO, config.encryptionKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    // Kunci berubah atau data korup: perlakukan sebagai token hilang, jangan crash.
    return null;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Perbandingan aman-waktu untuk token CSRF. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { encrypt, decrypt, randomToken, safeEqual };
