'use strict';

/**
 * Deteksi instance LiveManager yang sedang hidup.
 *
 * Tes integrasi menimpa db/livemanager.db dari backup lalu menghapus
 * -wal/-shm-nya. Kalau ada aplikasi yang sedang memegang berkas itu — container
 * Docker lewat volume ./db:/app/db, atau proses PM2/npm di host — koneksi
 * SQLite-nya jadi menunjuk isi yang sudah berganti tanpa WAL yang cocok.
 * Hasilnya bisa data pengguna yang rusak, bukan sekadar tes yang gagal.
 *
 * Probe-nya lewat /health, bukan `docker ps`: satu pemeriksaan yang sama
 * menangkap Docker, PM2, maupun `npm start`, dan tidak menuntut docker CLI ada.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_PORT = 7575;

/**
 * Port aplikasi menurut .env; 7575 kalau tidak disetel atau tidak terbaca.
 * `envPath` hanya diisi oleh tes.
 */
function readPort(envPath = path.join(ROOT, '.env')) {
  try {
    const env = fs.readFileSync(envPath, 'utf8');
    // Baris terakhir yang menang, sama seperti pembacaan .env pada umumnya.
    const found = [...env.matchAll(/^\s*PORT\s*=\s*(.*)$/gm)].pop();
    const value = parseInt(String(found?.[1] || '').replace(/["']/g, '').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/**
 * Apakah ada LiveManager yang menjawab di port itu.
 *
 * Bentuk jawabannya ikut diperiksa, bukan cuma status 200: port yang kebetulan
 * dipakai aplikasi lain tidak boleh membuat tes menolak jalan.
 */
async function probe(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { running: false };
    const body = await res.json();
    const isLiveManager = body
      && typeof body === 'object'
      && 'ok' in body
      && 'ffmpeg' in body
      && 'activeStreams' in body;
    return isLiveManager ? { running: true, version: body.version || null } : { running: false };
  } catch {
    // Sambungan ditolak, timeout, atau jawabannya bukan JSON — anggap tidak ada.
    return { running: false };
  }
}

module.exports = { readPort, probe, DEFAULT_PORT };
