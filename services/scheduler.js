'use strict';

const streamModel = require('../models/stream');
const rotationModel = require('../models/rotation');
const settings = require('../models/settings');
const streamManager = require('./streamManager');
const { createLogger } = require('../utils/logger');

const log = createLogger('scheduler');

const TICK_MS = 30 * 1000;
/** Jadwal yang terlewat lebih dari ini diabaikan, tidak dikejar. */
const GRACE_MS = 10 * 60 * 1000;

let timer = null;
let cleanupTimer = null;

function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      log.error('Tick scheduler gagal', err);
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();

  // Pembersihan log berjalan sekali sehari, jauh lebih jarang dari tick utama.
  cleanupTimer = setInterval(cleanup, 24 * 60 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  log.info(`Scheduler aktif (cek tiap ${TICK_MS / 1000} detik)`);
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  timer = null;
  cleanupTimer = null;
}

function tick() {
  startDueStreams();
  stopFinishedStreams();
}

/** Mulai stream yang waktu jadwalnya sudah tiba. */
function startDueStreams() {
  const nowMs = Date.now();
  for (const stream of streamModel.listScheduled()) {
    const startAt = new Date(stream.schedule_start_at).getTime();
    if (!Number.isFinite(startAt) || startAt > nowMs) continue;

    if (nowMs - startAt > GRACE_MS) {
      streamModel.setStatus(stream.id, 'idle', {
        error_message: 'Jadwal terlewat saat aplikasi tidak berjalan',
        schedule_start_at: null,
      });
      streamModel.addLog(stream.id, 'warn', 'Jadwal terlewat lebih dari 10 menit — siaran tidak dimulai otomatis.');
      continue;
    }

    log.info(`Memulai stream terjadwal #${stream.id}`);
    streamModel.addLog(stream.id, 'info', 'Jadwal tercapai, memulai siaran.');
    streamManager
      .start(stream.id)
      .then((res) => {
        if (!res.ok) {
          streamModel.setStatus(stream.id, 'error', { error_message: res.error });
          streamModel.addLog(stream.id, 'error', `Gagal memulai dari jadwal: ${res.error}`);
        } else {
          // Jadwal mulai dikosongkan agar tidak terpicu dua kali.
          streamModel.setStatus(stream.id, 'live', { schedule_start_at: null });
        }
      })
      .catch((err) => log.error(`Start terjadwal #${stream.id} gagal`, err));
  }
}

/** Hentikan stream yang sudah melewati batas waktu atau durasinya. */
function stopFinishedStreams() {
  const nowMs = Date.now();
  for (const stream of streamModel.listWithEndTime()) {
    let due = false;
    let reason = '';

    if (stream.schedule_end_at) {
      const endAt = new Date(stream.schedule_end_at).getTime();
      if (Number.isFinite(endAt) && endAt <= nowMs) {
        due = true;
        reason = 'jadwal berakhir';
      }
    }

    if (!due && stream.duration_minutes && stream.started_at) {
      const elapsed = nowMs - new Date(stream.started_at).getTime();
      if (elapsed >= stream.duration_minutes * 60000) {
        due = true;
        reason = `durasi ${stream.duration_minutes} menit tercapai`;
      }
    }

    if (!due) continue;

    log.info(`Menghentikan stream #${stream.id} (${reason})`);
    streamModel.addLog(stream.id, 'info', `Siaran dihentikan otomatis: ${reason}.`);
    streamManager.stop(stream.id, reason);
    streamModel.setStatus(stream.id, 'stopping', { schedule_end_at: null, duration_minutes: null });
  }
}

function cleanup() {
  try {
    const days = parseInt(settings.get('keep_rotation_logs_days', '30'), 10) || 30;
    const removed = rotationModel.pruneLogs(days);
    if (removed) log.info(`${removed} baris log rotasi lama dihapus`);
  } catch (err) {
    log.error('Pembersihan log gagal', err);
  }
}

module.exports = { start, stop, tick, cleanup };
