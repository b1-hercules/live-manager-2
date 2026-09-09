'use strict';

const fs = require('fs');

/**
 * Deteksi tipe file dari magic byte (signature di awal isi file). Ekstensi nama
 * file sepenuhnya dikendalikan pengunggah, jadi signature inilah yang dipakai
 * untuk memutuskan apakah sebuah file benar-benar video atau gambar.
 */

// 384 byte cukup untuk semua signature di bawah, termasuk sync byte MPEG-TS
// yang letaknya di kelipatan 188.
const HEADER_BYTES = 384;

function matches(buf, offset, bytes) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function ascii(buf, offset, text) {
  return matches(buf, offset, Buffer.from(text, 'ascii'));
}

/** Atom pembuka yang sah untuk keluarga ISO-BMFF/QuickTime (mp4, m4v, mov). */
const MP4_ATOMS = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot'];

const SIGNATURES = [
  // WAJIB sebelum MP4/MOV. M4A/M4B dan MP4 sama-sama diawali atom `ftyp`;
  // yang membedakan cuma brand di offset 8 ("M4A " vs "isom"). Kalau urutannya
  // dibalik, setiap berkas musik AAC lolos sebagai video.
  { format: 'M4A', family: 'audio', test: (b) => ascii(b, 4, 'ftyp') && (ascii(b, 8, 'M4A ') || ascii(b, 8, 'M4B ')) },
  { format: 'MP4/MOV', family: 'video', test: (b) => MP4_ATOMS.some((atom) => ascii(b, 4, atom)) },
  { format: 'Matroska/WebM', family: 'video', test: (b) => matches(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) },
  { format: 'AVI', family: 'video', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'AVI ') },
  { format: 'FLV', family: 'video', test: (b) => ascii(b, 0, 'FLV') },
  // MPEG-TS: sync byte 0x47 berulang tiap 188 byte (192 pada varian bertimecode).
  // Satu byte 0x47 saja terlalu longgar, jadi paket kedua ikut diperiksa.
  {
    format: 'MPEG-TS',
    family: 'video',
    test: (b) => b[0] === 0x47 && (b[188] === 0x47 || b[192] === 0x47),
  },
  {
    format: 'MPEG-PS',
    family: 'video',
    test: (b) => matches(b, 0, [0x00, 0x00, 0x01, 0xba]) || matches(b, 0, [0x00, 0x00, 0x01, 0xb3]),
  },
  { format: 'JPEG', family: 'image', test: (b) => matches(b, 0, [0xff, 0xd8, 0xff]) },
  { format: 'PNG', family: 'image', test: (b) => matches(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { format: 'WebP', family: 'image', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
  // RIFF dipakai bertiga (AVI, WebP, WAV); yang menentukan adalah tag di
  // offset 8, jadi ketiganya saling lepas dan urutannya tidak penting.
  { format: 'WAV', family: 'audio', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE') },
  { format: 'FLAC', family: 'audio', test: (b) => ascii(b, 0, 'fLaC') },
  { format: 'OGG', family: 'audio', test: (b) => ascii(b, 0, 'OggS') },
  // MP3 ber-tag ID3 diawali "ID3". Tanpa tag, frame pertama diawali sync 11 bit:
  // 0xFF lalu tiga bit teratas menyala. Syarat bit itu sengaja ketat supaya
  // tidak menyambar JPEG, yang juga diawali 0xFF — pada JPEG byte kedua 0xD8,
  // dan 0xD8 & 0xE0 = 0xC0, jadi tidak lolos.
  { format: 'MP3', family: 'audio', test: (b) => ascii(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
];

/** Baca sebagian awal file; file yang lebih pendek dari HEADER_BYTES tetap dilayani. */
function readHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Kembalikan { format, family } bila signature dikenali, atau null bila tidak.
 * family bernilai 'video', 'audio', atau 'image'.
 */
function inspect(filePath) {
  const header = readHeader(filePath);
  const found = SIGNATURES.find((sig) => sig.test(header));
  return found ? { format: found.format, family: found.family } : null;
}

module.exports = { inspect, HEADER_BYTES };
