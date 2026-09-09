'use strict';

// Boot app dengan egress() yang melaporkan siaran aktif, supaya tampilan
// bandwidth bisa diuji tanpa benar-benar menyiarkan ke RTMP.
const streamManager = require('../services/streamManager');

streamManager.egress = () => ({ bitsPerSecond: 8400000, streams: 3 });

require('../app.js').boot().catch((err) => {
  console.error('boot gagal:', err);
  process.exit(1);
});
