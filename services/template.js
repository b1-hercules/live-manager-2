'use strict';

const config = require('../config');

const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/**
 * Placeholder yang bisa dipakai di judul/deskripsi varian rotasi.
 * Berguna untuk siaran 24/7 supaya metadata tetap terasa segar tanpa
 * membuat varian baru setiap hari.
 */
const PLACEHOLDERS = [
  { token: '{{tanggal}}', desc: 'Tanggal hari ini, contoh: 31/08/2026' },
  { token: '{{jam}}', desc: 'Jam sekarang, contoh: 14:05' },
  { token: '{{hari}}', desc: 'Nama hari, contoh: Senin' },
  { token: '{{bulan}}', desc: 'Nama bulan, contoh: Agustus' },
  { token: '{{tahun}}', desc: 'Tahun, contoh: 2026' },
  { token: '{{urutan}}', desc: 'Nomor varian yang sedang tayang' },
  { token: '{{total}}', desc: 'Jumlah varian aktif di profil ini' },
  { token: '{{putaran}}', desc: 'Sudah berapa kali stream ini dirotasi' },
  { token: '{{uptime}}', desc: 'Lama siaran berjalan, contoh: 3j 12m' },
];

function parts(date = new Date()) {
  const fmt = (opts) => new Intl.DateTimeFormat('id-ID', { timeZone: config.timezone, ...opts }).format(date);
  // Ambil komponen di zona waktu yang dikonfigurasi, bukan zona server.
  const local = new Date(date.toLocaleString('en-US', { timeZone: config.timezone }));
  return {
    tanggal: fmt({ day: '2-digit', month: '2-digit', year: 'numeric' }),
    jam: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }),
    hari: DAYS[local.getDay()],
    bulan: MONTHS[local.getMonth()],
    tahun: String(local.getFullYear()),
  };
}

/**
 * Ganti semua placeholder. Nilai yang tidak dikenal dibiarkan apa adanya
 * supaya kurung kurawal literal di deskripsi tidak ikut terhapus.
 */
function render(text, context = {}) {
  if (!text) return text;
  const values = { ...parts(), ...context };
  return String(text).replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (match, key) => {
    const value = values[key.toLowerCase()];
    return value === undefined || value === null ? match : String(value);
  });
}

function renderTags(tags, context = {}) {
  if (!Array.isArray(tags)) return [];
  return tags.map((tag) => render(tag, context)).filter(Boolean);
}

module.exports = { render, renderTags, PLACEHOLDERS };
