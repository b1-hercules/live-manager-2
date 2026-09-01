'use strict';

const fs = require('fs');
const { google } = require('googleapis');
const youtube = require('./youtube');

/**
 * Akses Google Drive hanya-baca untuk mengimpor video yang sudah ada di sana,
 * tanpa perlu mengunduhnya ke komputer lalu mengunggahnya lagi.
 *
 * Memakai ulang koneksi OAuth yang sama dengan YouTube: klien terotorisasi,
 * penyegaran token, dan penyimpanan token terenkripsi semuanya sudah ditangani
 * services/youtube.js.
 */

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/**
 * Akun yang dihubungkan sebelum scope Drive ditambahkan tidak punya izinnya.
 * Akun seperti itu tetap sah untuk rotasi — hanya impor Drive-nya yang perlu
 * menunggu akun dihubungkan ulang.
 */
function hasAccess(account) {
  return String(account?.scopes || '').includes(SCOPE);
}

function clientFor(account) {
  return google.drive({ version: 'v3', auth: youtube.clientForAccount(account) });
}

/** Tanda kutip tunggal mengakhiri literal di bahasa query Drive, jadi harus dilolosi. */
function escapeQuery(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const FILE_FIELDS = 'id, name, size, mimeType, modifiedTime, videoMediaMetadata(durationMillis, width, height)';

/** Daftar video milik akun ini, terbaru dulu. */
async function listVideos(account, { search = '', pageToken = null, limit = 40 } = {}) {
  const clauses = ["mimeType contains 'video/'", 'trashed = false'];
  if (search) clauses.push(`name contains '${escapeQuery(search)}'`);

  const res = await clientFor(account).files.list({
    q: clauses.join(' and '),
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    orderBy: 'modifiedTime desc',
    pageSize: Math.min(Math.max(Number(limit) || 40, 1), 100),
    pageToken: pageToken || undefined,
    // Berkas di Shared Drive ikut terlihat, bukan hanya milik pribadi.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return {
    files: (res.data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      size: Number(f.size) || 0,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      duration: f.videoMediaMetadata ? Math.round(Number(f.videoMediaMetadata.durationMillis || 0) / 1000) : 0,
      width: f.videoMediaMetadata ? f.videoMediaMetadata.width || 0 : 0,
      height: f.videoMediaMetadata ? f.videoMediaMetadata.height || 0 : 0,
    })),
    nextPageToken: res.data.nextPageToken || null,
  };
}

/** Metadata satu berkas; dipakai untuk memeriksa nama dan ukuran sebelum mengunduh. */
async function fileInfo(account, fileId) {
  const res = await clientFor(account).files.get({
    fileId,
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return { id: res.data.id, name: res.data.name, size: Number(res.data.size) || 0, mimeType: res.data.mimeType };
}

/**
 * Unduh berkas ke destPath. onProgress(byteDiterima, total) dipanggil selama
 * berjalan. onAbort boleh dipasang pemanggil untuk menghentikan unduhan.
 */
async function download(account, fileId, destPath, { onProgress, signal } = {}) {
  const res = await clientFor(account).files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream', signal }
  );

  const total = Number(res.headers['content-length']) || 0;
  let received = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.data.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
    });
    res.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.data.pipe(out);
  });

  return { bytes: received };
}

module.exports = { SCOPE, hasAccess, listVideos, fileInfo, download };
