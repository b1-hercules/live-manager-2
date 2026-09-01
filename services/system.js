'use strict';

const os = require('os');
const fs = require('fs');
const config = require('../config');

let previous = null;

/** Total waktu idle & sibuk seluruh core, untuk menghitung selisih antar sampel. */
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Persentase CPU dihitung dari selisih dua sampel. Panggilan pertama
 * mengembalikan 0 karena belum ada pembanding.
 */
function cpuUsage() {
  const current = cpuTimes();
  if (!previous) {
    previous = current;
    return 0;
  }
  const idleDiff = current.idle - previous.idle;
  const totalDiff = current.total - previous.total;
  previous = current;
  if (totalDiff <= 0) return 0;
  return Math.round((1 - idleDiff / totalDiff) * 1000) / 10;
}

function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return { total, free, used, percent: Math.round((used / total) * 1000) / 10 };
}

/** Ukuran folder storage — dihitung dangkal (satu tingkat) agar tetap cepat. */
function storageUsage() {
  let bytes = 0;
  for (const dir of [config.paths.videos, config.paths.thumbnails]) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        try {
          bytes += fs.statSync(require('path').join(dir, entry.name)).size;
        } catch (_) { /* file terhapus saat dibaca */ }
      }
    } catch (_) { /* folder belum ada */ }
  }
  return bytes;
}

/**
 * Kapasitas partisi tempat folder storage berada — bukan besar folder aplikasi.
 * Ini yang menjawab "apakah disk server akan penuh": begitu partisinya habis,
 * unggahan dan FFmpeg berhenti total, dan storageUsage() saja tidak menunjukkannya.
 *
 * fs.statfs baru ada sejak Node 18.15 sedangkan package.json masih mengizinkan
 * Node 18.0, jadi ketiadaannya diperlakukan sebagai "tidak diketahui" (null),
 * bukan sebagai error.
 */
function diskUsage() {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stat = fs.statfsSync(config.paths.storage);
    const total = stat.blocks * stat.bsize;
    // bavail, bukan bfree: blok yang benar-benar boleh dipakai proses biasa.
    const free = stat.bavail * stat.bsize;
    if (!Number.isFinite(total) || total <= 0) return null;
    const used = total - free;
    return { total, free, used, percent: Math.round((used / total) * 1000) / 10 };
  } catch (_) {
    // Filesystem tidak mendukung statfs (mis. share jaringan tertentu).
    return null;
  }
}

function snapshot() {
  return {
    cpu: cpuUsage(),
    memory: memory(),
    cores: os.cpus().length,
    platform: `${os.type()} ${os.release()}`,
    uptimeSeconds: Math.round(process.uptime()),
    hostUptimeSeconds: Math.round(os.uptime()),
    nodeVersion: process.version,
    storageBytes: storageUsage(),
    disk: diskUsage(),
  };
}

module.exports = { snapshot, cpuUsage, memory, storageUsage, diskUsage };
