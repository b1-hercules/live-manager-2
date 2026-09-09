'use strict';

// Boot app dengan snapshot() yang melaporkan disk hampir penuh, supaya cabang
// peringatan di dashboard bisa diuji tanpa benar-benar memenuhi disk.
const system = require('../services/system');

const real = system.snapshot;
system.snapshot = () => ({
  ...real(),
  disk: { total: 1000000000000, free: 40000000000, used: 960000000000, percent: 96 },
});

// app.js hanya listen sendiri saat jadi main module, jadi boot() dipanggil manual.
require('../app.js').boot().catch((err) => {
  console.error('boot gagal:', err);
  process.exit(1);
});
