/**
 * Konfigurasi PM2 untuk produksi.
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'livemanager',
      script: 'app.js',
      // Satu instance saja. Proses FFmpeg dan penjadwal rotasi disimpan di
      // memori proses, jadi cluster mode akan menjalankan siaran berkali-kali.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      time: true,
      // Beri waktu FFmpeg dimatikan dengan rapi saat restart.
      kill_timeout: 12000,
    },
  ],
};
