'use strict';

// Boot app dengan akses Drive diganti sumber lokal, supaya seluruh jalur impor
// (daftar, unduh, magic byte, ffprobe, catat ke DB) bisa diuji tanpa OAuth.
const fs = require('fs');
const drive = require('../services/drive');

const FIXTURES = JSON.parse(process.env.DRIVE_FIXTURES); // { fileId: pathLokal }

drive.listVideos = async (account, { search = '' } = {}) => {
  const files = Object.entries(FIXTURES).map(([id, file]) => ({
    id,
    name: file.name,
    size: fs.statSync(file.path).size,
    mimeType: 'video/mp4',
    duration: 12,
    width: 640,
    height: 480,
  }));
  const filtered = search
    ? files.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()))
    : files;
  // Nilai search dipantulkan supaya tes bisa memastikan ia benar-benar diteruskan.
  return { files: filtered, nextPageToken: null, echoSearch: search };
};

drive.fileInfo = async (account, fileId) => {
  const file = FIXTURES[fileId];
  if (!file) throw new Error('Berkas Drive tidak ditemukan.');
  return { id: fileId, name: file.name, size: fs.statSync(file.path).size, mimeType: 'video/mp4' };
};

drive.download = async (account, fileId, destPath, { onProgress } = {}) => {
  const file = FIXTURES[fileId];
  const buf = fs.readFileSync(file.path);
  // Ditulis bertahap supaya laporan kemajuan ikut terlatih.
  const step = Math.max(1, Math.ceil(buf.length / 4));
  fs.writeFileSync(destPath, '');
  for (let at = 0; at < buf.length; at += step) {
    const part = buf.subarray(at, Math.min(at + step, buf.length));
    fs.appendFileSync(destPath, part);
    if (onProgress) onProgress(Math.min(at + step, buf.length), buf.length);
    await new Promise((r) => setTimeout(r, 60));
  }
  return { bytes: buf.length };
};

require('../app.js').boot().catch((err) => {
  console.error('boot gagal:', err);
  process.exit(1);
});
