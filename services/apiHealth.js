'use strict';

const { google } = require('googleapis');
const settings = require('../models/settings');
const accounts = require('../models/account');
const youtube = require('./youtube');
const drive = require('./drive');
const { createLogger } = require('../utils/logger');

const log = createLogger('apihealth');

/**
 * Pemeriksaan kesehatan tiga pintu Google yang dipakai aplikasi ini:
 * kredensial OAuth, YouTube Data API v3, dan Drive API v3.
 *
 * Nilai utamanya bukan sekadar "hidup / mati", melainkan membedakan tiga
 * kegagalan yang gejalanya nyaris sama tapi penyembuhannya berbeda total:
 *
 *   - token kedaluwarsa     -> hubungkan ulang akun di halaman ini
 *   - API belum diaktifkan  -> nyalakan di Google Cloud Console
 *   - kuota harian habis    -> tidak ada yang perlu diperbaiki, tunggu reset
 *
 * Tanpa pembedaan itu ketiganya muncul sebagai "gagal", dan orang menghabiskan
 * waktu menghubungkan ulang akun yang tokennya sebenarnya sehat.
 */

const STATUS = { OK: 'ok', FAIL: 'fail', SKIP: 'skip', WARN: 'warn' };

function result(key, label, status, message, extra = {}) {
  return { key, label, status, ok: status === STATUS.OK, message, ...extra };
}

/**
 * Terjemahkan galat googleapis lewat pemetaan yang sudah dipakai rotation
 * engine, supaya pesan di sini tidak menyimpang dari pesan di tempat lain.
 *
 * `account` sengaja dioper: wrapError menandai akun sebagai error begitu
 * menemui token mati, dan itu memang yang kita inginkan dari sebuah pemeriksaan.
 */
function classify(err, account) {
  const wrapped = youtube.wrapError(err, account);
  return {
    message: wrapped.message,
    reason: wrapped.reason,
    // Kuota habis bukan kerusakan: API-nya sehat, jatahnya saja yang tandas.
    status: wrapped.quota ? STATUS.WARN : STATUS.FAIL,
  };
}

// -------------------------------------------------------------- pemeriksaan

/** Kredensial OAuth aplikasi (Client ID/Secret), bukan token per akun. */
function checkCredentials() {
  const { clientId, clientSecret } = settings.googleCredentials();
  if (!clientId || !clientSecret) {
    return result('oauth', 'Google OAuth', STATUS.FAIL,
      'Client ID/Secret belum diisi. Isi dulu di halaman Pengaturan.',
      { reason: 'no_credentials' });
  }
  return result('oauth', 'Google OAuth', STATUS.OK, 'Client ID dan Secret terpasang.');
}

/**
 * Paksa penukaran refresh token jadi access token baru. Inilah pemeriksaan yang
 * benar-benar menjawab "otorisasinya masih hidup atau tidak"; sisanya hanya
 * menumpang hasil ini.
 */
async function checkToken(account) {
  try {
    const auth = youtube.authClientForAccount(account);
    const { token } = await auth.getAccessToken();
    if (!token) {
      return result('token', 'Token akun', STATUS.FAIL,
        'Google tidak mengembalikan access token. Hubungkan ulang akunnya.',
        { reason: 'no_access_token' });
    }
    return result('token', 'Token akun', STATUS.OK, 'Refresh token masih ditukar dengan sukses.');
  } catch (err) {
    const c = classify(err, account);
    return result('token', 'Token akun', c.status, c.message, { reason: c.reason });
  }
}

/**
 * Panggilan termurah yang tetap membuktikan API-nya menjawab: channels.list,
 * seharga 1 unit dari jatah harian 10.000.
 */
async function checkYouTube(account) {
  try {
    const client = youtube.clientForAccount(account);
    const res = await client.channels.list({ part: ['id'], mine: true });
    accounts.addQuota(account.id, accounts.QUOTA_COST['channels.list']);

    const id = res.data.items && res.data.items[0] ? res.data.items[0].id : null;
    if (!id) {
      return result('youtube', 'YouTube Data API v3', STATUS.FAIL,
        'API menjawab, tapi akun ini tidak punya channel YouTube.',
        { reason: 'no_channel' });
    }
    return result('youtube', 'YouTube Data API v3', STATUS.OK,
      `API menjawab normal (channel ${id}).`,
      { quotaCost: accounts.QUOTA_COST['channels.list'] });
  } catch (err) {
    const c = classify(err, account);
    return result('youtube', 'YouTube Data API v3', c.status, c.message, { reason: c.reason });
  }
}

/**
 * Scope Drive ditambahkan setelah rilis pertama, jadi akun lama sah-sah saja
 * tidak memilikinya — itu bukan kerusakan, hanya perlu dihubungkan ulang. Kalau
 * scope-nya ada, barulah API-nya benar-benar disentuh.
 */
async function checkDrive(account) {
  if (!drive.hasAccess(account)) {
    return result('drive', 'Google Drive API v3', STATUS.WARN,
      'Akun ini dihubungkan sebelum izin Drive ditambahkan. Hubungkan ulang kalau mau memakai impor dari Drive.',
      { reason: 'scope_missing' });
  }

  try {
    const client = google.drive({ version: 'v3', auth: youtube.authClientForAccount(account) });
    await client.files.list({ pageSize: 1, fields: 'files(id)', supportsAllDrives: true });
    return result('drive', 'Google Drive API v3', STATUS.OK, 'API menjawab normal.');
  } catch (err) {
    const c = classify(err, account);
    return result('drive', 'Google Drive API v3', c.status, c.message, { reason: c.reason });
  }
}

// ----------------------------------------------------------------- rangkuman

/**
 * Jalankan keempat pemeriksaan untuk satu akun.
 *
 * Berurutan dan saling menggugurkan: kalau kredensial aplikasi belum diisi atau
 * tokennya sudah mati, memanggil YouTube dan Drive hanya menghasilkan kegagalan
 * turunan yang menyesatkan — jadi keduanya dilewati, bukan dijalankan lalu
 * dilaporkan gagal.
 */
async function checkAccount(account) {
  const checks = [];

  const cred = checkCredentials();
  checks.push(cred);

  if (!cred.ok) {
    const skip = 'Dilewati: kredensial OAuth belum diisi.';
    checks.push(result('token', 'Token akun', STATUS.SKIP, skip));
    checks.push(result('youtube', 'YouTube Data API v3', STATUS.SKIP, skip));
    checks.push(result('drive', 'Google Drive API v3', STATUS.SKIP, skip));
    return summarize(account, checks);
  }

  const token = await checkToken(account);
  checks.push(token);

  if (!token.ok) {
    const skip = 'Dilewati: otorisasi akun bermasalah.';
    checks.push(result('youtube', 'YouTube Data API v3', STATUS.SKIP, skip));
    checks.push(result('drive', 'Google Drive API v3', STATUS.SKIP, skip));
    return summarize(account, checks);
  }

  checks.push(await checkYouTube(account));
  checks.push(await checkDrive(account));
  return summarize(account, checks);
}

function summarize(account, checks) {
  const failed = checks.filter((c) => c.status === STATUS.FAIL);
  const warned = checks.filter((c) => c.status === STATUS.WARN);

  let message;
  if (failed.length) {
    message = `${failed.length} pemeriksaan gagal: ${failed.map((c) => c.label).join(', ')}.`;
  } else if (warned.length) {
    message = `Semua API menjawab, dengan ${warned.length} catatan.`;
  } else {
    message = 'Semua API sehat.';
  }

  log.info('Pemeriksaan API selesai', {
    accountId: account.id, failed: failed.length, warned: warned.length,
  });

  return {
    ok: failed.length === 0,
    accountId: account.id,
    accountName: account.name,
    checkedAt: new Date().toISOString(),
    checks,
    message,
    quota: accounts.getQuota(account.id),
  };
}

module.exports = { STATUS, checkAccount, checkCredentials, checkToken, checkYouTube, checkDrive };
