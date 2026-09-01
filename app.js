'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const engine = require('ejs-mate');

const config = require('./config');
const { migrate } = require('./db/migrate');
const { createLogger } = require('./utils/logger');

const SqliteStore = require('./middleware/sessionStore');
const { loadUser, requireAuth, requireSetup } = require('./middleware/auth');
const csrf = require('./middleware/csrf');
const errors = require('./middleware/errors');

const streamManager = require('./services/streamManager');
const rotationEngine = require('./services/rotationEngine');
const scheduler = require('./services/scheduler');
const ffmpegService = require('./services/ffmpeg');

const log = createLogger('app');

// Migrasi dijalankan di sini, BUKAN di dalam boot(). Session store menyiapkan
// prepared statement-nya saat modul dimuat, jadi skema harus sudah ada sebelum
// baris apa pun di bawah dieksekusi — kalau tidak, instalasi baru langsung
// gagal dengan "no such table: sessions". Migrasi bersifat idempoten.
migrate();

const app = express();

// ------------------------------------------------------------------ view

app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.appName = 'LiveManager';
app.locals.appVersion = require('./package.json').version;

/**
 * Path media disimpan relatif terhadap root ("storage/thumbnails/x.jpg"),
 * sementara file-nya dilayani dari mount /media. Helper ini menjembatani
 * keduanya supaya view tidak perlu memanipulasi string sendiri.
 */
app.locals.mediaUrl = (relPath) => {
  if (!relPath) return null;
  const clean = String(relPath).replace(/\\/g, '/').replace(/^\.?\/*/, '');
  return '/media/' + clean.replace(/^storage\//, '');
};

// Di belakang Nginx/Cloudflare, percayai satu hop proxy agar secure cookie
// dan rate limit membaca IP klien yang benar.
app.set('trust proxy', 1);

// --------------------------------------------------------------- request

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

app.use(
  session({
    store: new SqliteStore(),
    secret: config.sessionSecret,
    name: 'livemanager.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.appUrl.startsWith('https://'),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(loadUser);
app.use(csrf);

/** Flash message sekali pakai: dibaca lalu langsung dibuang. */
app.use((req, res, next) => {
  res.locals.flash = req.session?.flash || null;
  if (req.session?.flash) delete req.session.flash;
  res.locals.currentPath = req.path;
  next();
});

// --------------------------------------------------------------- statis

app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: config.isProd ? '7d' : 0 }));

// Media pengguna (video & thumbnail) hanya boleh diakses setelah login.
app.use('/media', requireAuth, express.static(config.paths.storage, { maxAge: '1h' }));

// ---------------------------------------------------------------- routes

app.use(requireSetup);
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/videos', require('./routes/videos'));
app.use('/playlists', require('./routes/playlists'));
app.use('/destinations', require('./routes/destinations'));
app.use('/streams', require('./routes/streams'));
app.use('/rotations', require('./routes/rotations'));
app.use('/accounts', require('./routes/accounts'));
app.use('/settings', require('./routes/settings'));
app.use('/api', require('./routes/api'));

app.use(errors.notFound);
app.use(errors.handler);

// ------------------------------------------------------------------ boot

async function boot() {
  const ffmpegStatus = await ffmpegService.checkAvailability();
  app.locals.ffmpegStatus = ffmpegStatus;
  if (ffmpegStatus.ok) {
    log.info(`FFmpeg siap: ${ffmpegStatus.version}`);
  } else {
    log.error(`FFmpeg TIDAK ditemukan (${ffmpegStatus.error}). Streaming tidak akan bisa dimulai.`);
  }

  // Proses FFmpeg tidak selamat dari restart aplikasi; bereskan status lama.
  streamManager.recoverOnBoot();

  scheduler.start();
  rotationEngine.start();

  const server = app.listen(config.port, config.host, () => {
    log.info(`LiveManager berjalan di ${config.appUrl} (${config.env})`);
    if (config.sessionSecretIsEphemeral) {
      log.warn('SESSION_SECRET belum diset — semua sesi akan hilang setiap restart. Jalankan: npm run generate-secret');
    }
    if (config.encryptionKeyIsDerived) {
      log.warn('ENCRYPTION_KEY belum diset — kunci diturunkan dari SESSION_SECRET. Set keduanya di .env.');
    }
  });

  // Upload video besar butuh waktu lama; jangan putuskan koneksinya.
  server.requestTimeout = 0;
  server.headersTimeout = 120000;

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} diterima, mematikan aplikasi...`);

    scheduler.stop();
    rotationEngine.stop();
    const stopped = streamManager.shutdown();
    if (stopped) log.info(`${stopped} siaran dihentikan`);

    server.close(() => {
      log.info('Selesai.');
      process.exit(0);
    });
    // Jangan menggantung selamanya kalau ada koneksi yang tidak mau tutup.
    setTimeout(() => process.exit(0), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason));
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', err);
    shutdown('uncaughtException');
  });

  return server;
}

if (require.main === module) {
  boot().catch((err) => {
    log.error('Gagal menjalankan aplikasi', err);
    process.exit(1);
  });
}

module.exports = { app, boot };
