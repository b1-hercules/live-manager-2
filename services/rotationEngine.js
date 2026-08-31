'use strict';

const streamModel = require('../models/stream');
const rotationModel = require('../models/rotation');
const accountModel = require('../models/account');
const youtube = require('./youtube');
const template = require('./template');
const { createLogger } = require('../utils/logger');
const { weightedPick, shuffle, humanUptime } = require('../utils/helpers');

const log = createLogger('rotation');

const TICK_MS = 20 * 1000;
/** Hasil deteksi broadcast dianggap basi setelah 10 menit. */
const RESOLVE_TTL_MS = 10 * 60 * 1000;

let timer = null;
/** Stream yang rotasinya sedang berjalan — mencegah tumpang tindih tick. */
const inFlight = new Set();
/** Hitungan rotasi per stream sejak proses ini hidup, untuk placeholder {{putaran}}. */
const rotationCounter = new Map();

// ------------------------------------------------------------- siklus hidup

function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => log.error('Tick rotasi gagal', err));
  }, TICK_MS);
  if (timer.unref) timer.unref();
  log.info(`Rotation engine aktif (cek tiap ${TICK_MS / 1000} detik)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  const streams = streamModel.listRotating();
  for (const stream of streams) {
    if (inFlight.has(stream.id)) continue;
    inFlight.add(stream.id);
    try {
      await processStream(stream);
    } catch (err) {
      log.error(`Rotasi stream #${stream.id} gagal`, err);
    } finally {
      inFlight.delete(stream.id);
    }
  }
}

/**
 * Siapkan state saat sebuah stream mulai siaran. Dipanggil oleh streamManager.
 * Kalau rotate_on_start aktif, varian pertama langsung diterapkan.
 */
async function onStreamStart(streamId) {
  const stream = streamModel.findById(streamId);
  if (!stream || !stream.rotation_enabled || !stream.rotation_profile_id) return;

  rotationCounter.set(streamId, 0);
  const dueNow = new Date().toISOString();

  rotationModel.saveState(streamId, {
    profile_id: stream.rotation_profile_id,
    cursor: 0,
    shuffleOrder: [],
    // Kalau rotate_on_start mati, rotasi pertama menunggu satu interval penuh.
    next_run_at: stream.rotate_on_start ? dueNow : addMinutes(profileInterval(stream.rotation_profile_id)),
    fieldState: {},
    last_item_id: null,
  });

  if (stream.rotate_on_start) {
    streamModel.addLog(streamId, 'info', 'Menerapkan varian rotasi pertama...');
    await processStream(streamModel.findById(streamId)).catch((err) =>
      log.error(`Rotasi awal stream #${streamId} gagal`, err)
    );
  }
}

function onStreamStop(streamId) {
  rotationCounter.delete(streamId);
}

function profileInterval(profileId) {
  const profile = rotationModel.findProfile(profileId);
  return profile ? profile.interval_minutes : 60;
}

// ------------------------------------------------------------ inti rotasi

async function processStream(stream, { force = false } = {}) {
  const profile = rotationModel.findProfile(stream.rotation_profile_id);
  if (!profile || !profile.active) return { skipped: 'profil tidak aktif' };

  const account = stream.youtube_account_id ? accountModel.findById(stream.youtube_account_id) : null;
  if (!account) {
    return failOnce(stream, profile, 'Stream ini belum dihubungkan ke akun YouTube.');
  }
  if (account.status === 'error') {
    return failOnce(stream, profile, `Akun YouTube "${account.name}" bermasalah — hubungkan ulang.`);
  }

  const videoId = await resolveVideoId(stream, account);
  if (!videoId) {
    return failOnce(
      stream, profile,
      'Belum ada siaran aktif yang terdeteksi di channel. Rotasi menunggu YouTube menandai broadcast sebagai live.'
    );
  }

  return profile.mode === 'independent'
    ? runIndependent(stream, profile, account, videoId, force)
    : runBundle(stream, profile, account, videoId, force);
}

/** Mode BUNDLE: satu varian lengkap diterapkan sekaligus. */
async function runBundle(stream, profile, account, videoId, force) {
  const state = rotationModel.getState(stream.id) || rotationModel.saveState(stream.id, { profile_id: profile.id });
  if (!force && !isDue(state.next_run_at)) return { skipped: 'belum waktunya' };

  const items = rotationModel.listItems(profile.id, { onlyActive: true });
  if (!items.length) {
    return failOnce(stream, profile, 'Profil rotasi belum punya varian aktif.');
  }

  const picked = pickNext(items, profile.order_mode, state.cursor, state.shuffleOrder);
  const item = items[picked.index];

  const wants = {
    title: profile.apply_title && item.title,
    description: profile.apply_description && item.description !== null && item.description !== '',
    tags: profile.apply_tags && item.tagList.length > 0,
    thumbnail: profile.apply_thumbnail && Boolean(item.thumbnail_path),
  };

  const quotaCheck = checkQuota(stream, profile, account, wants);
  if (quotaCheck) return quotaCheck;

  const ctx = buildContext(stream, picked.index, items.length);
  let quotaUsed = 0;
  const applied = {};
  const errors = [];

  // --- teks (judul / deskripsi / tags) dalam satu panggilan update ---
  if (wants.title || wants.description || wants.tags) {
    try {
      const res = await youtube.updateMetadata(account, videoId, {
        title: wants.title ? template.render(item.title, ctx) : undefined,
        description: wants.description ? template.render(item.description, ctx) : undefined,
        tags: wants.tags ? template.renderTags(item.tagList, ctx) : undefined,
      });
      quotaUsed += res.quotaCost;
      Object.assign(applied, res.changed);
    } catch (err) {
      errors.push(err);
      if (handleFatal(err, stream, profile, item.id)) return { error: err.message };
    }
  }

  // --- thumbnail dalam panggilan terpisah ---
  if (wants.thumbnail) {
    try {
      const res = await youtube.setThumbnail(account, videoId, item.thumbnail_path);
      quotaUsed += res.quotaCost;
      applied.thumbnail = item.thumbnail_path;
    } catch (err) {
      errors.push(err);
      if (handleFatal(err, stream, profile, item.id)) return { error: err.message };
    }
  }

  const nextRun = addMinutes(profile.interval_minutes, profile.jitter_seconds);
  rotationModel.saveState(stream.id, {
    profile_id: profile.id,
    cursor: picked.cursor,
    shuffleOrder: picked.shuffleOrder,
    next_run_at: nextRun,
    last_item_id: item.id,
    last_applied_at: new Date().toISOString(),
  });

  const label = item.label || item.title || `Varian #${picked.index + 1}`;

  if (Object.keys(applied).length) {
    rotationModel.markItemApplied(item.id);
    bumpCounter(stream.id);
    rotationModel.addLog({
      stream_id: stream.id,
      profile_id: profile.id,
      item_id: item.id,
      status: errors.length ? 'partial' : 'success',
      payload: applied,
      message: errors.length ? errors.map((e) => e.message).join(' | ') : null,
      quota_cost: quotaUsed,
    });
    streamModel.addLog(
      stream.id, errors.length ? 'warn' : 'info',
      `Rotasi: "${label}" → ${Object.keys(applied).join(', ')}${errors.length ? ` (sebagian gagal)` : ''}`
    );
    return { applied, item: label, quotaUsed, nextRun };
  }

  rotationModel.addLog({
    stream_id: stream.id, profile_id: profile.id, item_id: item.id,
    status: 'error', message: errors.map((e) => e.message).join(' | ') || 'Tidak ada field yang berubah',
    quota_cost: quotaUsed,
  });
  streamModel.addLog(stream.id, 'error', `Rotasi "${label}" gagal: ${errors.map((e) => e.message).join(' | ')}`);
  return { error: errors.map((e) => e.message).join(' | ') };
}

/** Mode INDEPENDENT: tiap field punya jadwal sendiri. */
async function runIndependent(stream, profile, account, videoId, force) {
  const state = rotationModel.getState(stream.id) || rotationModel.saveState(stream.id, { profile_id: profile.id });
  const fields = rotationModel.readyFields(profile.id);
  if (!fields.length) {
    return failOnce(stream, profile, 'Mode independent aktif tapi belum ada field yang diisi & diaktifkan.');
  }

  const fieldState = { ...(state.fieldState || {}) };
  const due = fields.filter((f) => force || isDue(fieldState[f.field]?.next_run_at));
  if (!due.length) return { skipped: 'belum waktunya' };

  // Gabungkan field teks yang jatuh tempo bersamaan menjadi satu panggilan
  // videos.update — menghemat 51 unit kuota per field yang digabung.
  const textFields = due.filter((f) => f.field !== 'thumbnail');
  const thumbField = due.find((f) => f.field === 'thumbnail');

  const wants = {
    title: textFields.some((f) => f.field === 'title'),
    description: textFields.some((f) => f.field === 'description'),
    tags: textFields.some((f) => f.field === 'tags'),
    thumbnail: Boolean(thumbField),
  };

  const quotaCheck = checkQuota(stream, profile, account, wants);
  if (quotaCheck) return quotaCheck;

  const ctx = buildContext(stream, 0, 0);
  const payload = {};
  const chosen = {};
  let quotaUsed = 0;
  const errors = [];

  for (const field of textFields) {
    const st = fieldState[field.field] || { cursor: 0, shuffleOrder: [] };
    const picked = pickNext(field.values, field.order_mode, st.cursor, st.shuffleOrder);
    const value = field.values[picked.index];
    chosen[field.field] = { value, picked, field };

    if (field.field === 'tags') {
      payload.tags = template.renderTags(String(value.value || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean), ctx);
    } else {
      payload[field.field] = template.render(value.value, ctx);
    }
  }

  if (Object.keys(payload).length) {
    try {
      const res = await youtube.updateMetadata(account, videoId, payload);
      quotaUsed += res.quotaCost;
      for (const [name, info] of Object.entries(chosen)) {
        rotationModel.markFieldValueApplied(info.value.id);
        fieldState[name] = {
          cursor: info.picked.cursor,
          shuffleOrder: info.picked.shuffleOrder,
          next_run_at: addMinutes(info.field.interval_minutes, profile.jitter_seconds),
          last_value_id: info.value.id,
        };
        rotationModel.addLog({
          stream_id: stream.id, profile_id: profile.id, field: name,
          status: 'success', payload: { [name]: res.changed[name] }, quota_cost: 0,
        });
      }
      streamModel.addLog(stream.id, 'info', `Rotasi independent: ${Object.keys(payload).join(', ')} diperbarui`);
      bumpCounter(stream.id);
    } catch (err) {
      errors.push(err);
      if (handleFatal(err, stream, profile, null)) return { error: err.message };
      // Coba lagi setelah 5 menit, jangan bakar kuota dengan retry cepat.
      for (const name of Object.keys(chosen)) {
        fieldState[name] = { ...(fieldState[name] || {}), next_run_at: addMinutes(5) };
      }
      rotationModel.addLog({
        stream_id: stream.id, profile_id: profile.id, field: Object.keys(payload).join(','),
        status: 'error', message: err.message, quota_cost: quotaUsed,
      });
    }
  }

  if (thumbField) {
    const st = fieldState.thumbnail || { cursor: 0, shuffleOrder: [] };
    const candidates = thumbField.values.filter((v) => v.thumbnail_path);
    if (candidates.length) {
      const picked = pickNext(candidates, thumbField.order_mode, st.cursor, st.shuffleOrder);
      const value = candidates[picked.index];
      try {
        const res = await youtube.setThumbnail(account, videoId, value.thumbnail_path);
        quotaUsed += res.quotaCost;
        rotationModel.markFieldValueApplied(value.id);
        fieldState.thumbnail = {
          cursor: picked.cursor,
          shuffleOrder: picked.shuffleOrder,
          next_run_at: addMinutes(thumbField.interval_minutes, profile.jitter_seconds),
          last_value_id: value.id,
        };
        rotationModel.addLog({
          stream_id: stream.id, profile_id: profile.id, field: 'thumbnail',
          status: 'success', payload: { thumbnail: value.thumbnail_path }, quota_cost: res.quotaCost,
        });
        streamModel.addLog(stream.id, 'info', 'Rotasi independent: thumbnail diperbarui');
        bumpCounter(stream.id);
      } catch (err) {
        errors.push(err);
        if (handleFatal(err, stream, profile, null)) return { error: err.message };
        fieldState.thumbnail = { ...(fieldState.thumbnail || {}), next_run_at: addMinutes(5) };
        rotationModel.addLog({
          stream_id: stream.id, profile_id: profile.id, field: 'thumbnail',
          status: 'error', message: err.message, quota_cost: quotaUsed,
        });
      }
    }
  }

  rotationModel.saveState(stream.id, {
    profile_id: profile.id,
    fieldState,
    last_applied_at: new Date().toISOString(),
  });

  return errors.length ? { error: errors.map((e) => e.message).join(' | ') } : { applied: payload, quotaUsed };
}

// ------------------------------------------------------------- pemilihan

/**
 * Tentukan item berikutnya sesuai mode urutan.
 * - sequential: maju satu per satu, kembali ke awal di ujung daftar
 * - random:     acak berbobot, boleh berulang
 * - shuffle:    acak tapi habiskan semua varian dulu sebelum mengocok ulang
 */
function pickNext(items, orderMode, cursor = 0, shuffleOrder = []) {
  if (!items.length) return { index: 0, cursor: 0, shuffleOrder: [] };

  if (orderMode === 'random') {
    const index = weightedPick(items);
    return { index: Math.max(0, index), cursor, shuffleOrder };
  }

  if (orderMode === 'shuffle') {
    // Urutan lama dibuang kalau daftar varian berubah jumlahnya.
    let order = Array.isArray(shuffleOrder) ? shuffleOrder.filter((i) => i < items.length) : [];
    let pos = cursor;
    if (order.length !== items.length || pos >= order.length) {
      order = shuffle(items.map((_, i) => i));
      pos = 0;
    }
    return { index: order[pos], cursor: pos + 1, shuffleOrder: order };
  }

  const index = cursor % items.length;
  return { index, cursor: (index + 1) % items.length, shuffleOrder: [] };
}

// ------------------------------------------------------------------ utils

function isDue(iso) {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  return !Number.isFinite(t) || t <= Date.now();
}

function addMinutes(minutes, jitterSeconds = 0) {
  // Jitter menyebar waktu rotasi beberapa stream agar tidak menabrak
  // rate limit API secara bersamaan.
  const jitter = jitterSeconds ? Math.floor(Math.random() * jitterSeconds * 2) - jitterSeconds : 0;
  return new Date(Date.now() + minutes * 60000 + jitter * 1000).toISOString();
}

function buildContext(stream, index, total) {
  return {
    urutan: index + 1,
    total,
    putaran: rotationCounter.get(stream.id) || 0,
    uptime: humanUptime(stream.started_at),
  };
}

function bumpCounter(streamId) {
  rotationCounter.set(streamId, (rotationCounter.get(streamId) || 0) + 1);
}

/** Hentikan rotasi lebih awal kalau kuota tidak akan cukup. */
function checkQuota(stream, profile, account, wants) {
  const cost = accountModel.estimateRotationCost(wants);
  const quota = accountModel.getQuota(account.id);
  if (!profile.stop_on_quota || quota.remaining >= cost) return null;

  const message =
    `Kuota YouTube API tersisa ${quota.remaining} unit, butuh ${cost}. ` +
    'Rotasi ditunda sampai kuota reset (00:00 Pacific Time).';
  rotationModel.addLog({
    stream_id: stream.id, profile_id: profile.id, status: 'skipped', message, quota_cost: 0,
  });
  streamModel.addLog(stream.id, 'warn', message);
  // Cek lagi 30 menit kemudian, bukan tiap 20 detik.
  rotationModel.saveState(stream.id, { profile_id: profile.id, next_run_at: addMinutes(30) });
  return { skipped: message };
}

/**
 * Error fatal (token mati, kredensial hilang) mematikan rotasi untuk stream ini
 * supaya tidak membanjiri log; siaran video-nya sendiri tetap jalan.
 */
function handleFatal(err, stream, profile, itemId) {
  if (!err.fatal) return false;
  rotationModel.addLog({
    stream_id: stream.id, profile_id: profile.id, item_id: itemId,
    status: 'error', message: err.message, quota_cost: 0,
  });
  streamModel.addLog(stream.id, 'error', `Rotasi dinonaktifkan: ${err.message}`);
  streamModel.setStatus(stream.id, stream.status, { rotation_enabled: 0 });
  return true;
}

/** Catat kegagalan lalu tunda pengecekan berikutnya agar log tidak membanjir. */
function failOnce(stream, profile, message) {
  const state = rotationModel.getState(stream.id);
  const alreadyWarned = state?.next_run_at && new Date(state.next_run_at).getTime() > Date.now();
  if (!alreadyWarned) {
    rotationModel.addLog({ stream_id: stream.id, profile_id: profile?.id, status: 'skipped', message });
    streamModel.addLog(stream.id, 'warn', message);
  }
  rotationModel.saveState(stream.id, { profile_id: profile?.id, next_run_at: addMinutes(2) });
  return { skipped: message };
}

/**
 * Cari video ID target. Hasil deteksi otomatis di-cache di kolom
 * resolved_video_id supaya tidak memanggil API tiap 20 detik.
 */
async function resolveVideoId(stream, account) {
  if (!stream.youtube_auto_detect) {
    return stream.youtube_video_id || null;
  }

  const fresh = stream.resolved_at && Date.now() - new Date(stream.resolved_at).getTime() < RESOLVE_TTL_MS;
  if (stream.resolved_video_id && fresh) return stream.resolved_video_id;

  try {
    const broadcast = await youtube.detectActiveBroadcast(account);
    if (broadcast?.videoId) {
      streamModel.setResolvedVideo(stream.id, broadcast.videoId);
      if (!stream.resolved_video_id) {
        streamModel.addLog(
          stream.id, 'info',
          `Broadcast terdeteksi: ${broadcast.videoId}${broadcast.title ? ` — "${broadcast.title}"` : ''}`
        );
      }
      return broadcast.videoId;
    }
  } catch (err) {
    log.warn(`Deteksi broadcast stream #${stream.id} gagal: ${err.message}`);
    if (err.fatal) throw err;
  }

  // Video ID manual dipakai sebagai cadangan kalau deteksi otomatis gagal.
  return stream.resolved_video_id || stream.youtube_video_id || null;
}

/** Rotasi manual dari tombol "Rotasi sekarang". */
async function rotateNow(streamId) {
  const stream = streamModel.findById(streamId);
  if (!stream) throw new Error('Stream tidak ditemukan');
  if (!stream.rotation_profile_id) throw new Error('Stream ini belum punya profil rotasi');

  if (inFlight.has(streamId)) return { skipped: 'Rotasi sedang berjalan' };
  inFlight.add(streamId);
  try {
    return await processStream(stream, { force: true });
  } finally {
    inFlight.delete(streamId);
  }
}

/** Pratinjau varian berikutnya tanpa memanggil API — dipakai di UI. */
function preview(streamId) {
  const stream = streamModel.findById(streamId);
  if (!stream?.rotation_profile_id) return null;
  const profile = rotationModel.findProfile(stream.rotation_profile_id);
  if (!profile) return null;

  const state = rotationModel.getState(streamId);
  const ctx = buildContext(stream, 0, 0);

  if (profile.mode === 'bundle') {
    const items = rotationModel.listItems(profile.id, { onlyActive: true });
    if (!items.length) return { mode: 'bundle', nextRunAt: state?.next_run_at || null, item: null };
    const picked = pickNext(items, profile.order_mode, state?.cursor || 0, state?.shuffleOrder || []);
    const item = items[picked.index];
    return {
      mode: 'bundle',
      nextRunAt: state?.next_run_at || null,
      item: {
        label: item.label || item.title || `Varian #${picked.index + 1}`,
        title: profile.apply_title ? template.render(item.title, { ...ctx, urutan: picked.index + 1, total: items.length }) : null,
        description: profile.apply_description ? template.render(item.description, ctx) : null,
        tags: profile.apply_tags ? template.renderTags(item.tagList, ctx) : [],
        thumbnail: profile.apply_thumbnail ? item.thumbnail_path : null,
      },
    };
  }

  const fields = rotationModel.readyFields(profile.id).map((field) => {
    const st = state?.fieldState?.[field.field] || {};
    const picked = pickNext(field.values, field.order_mode, st.cursor || 0, st.shuffleOrder || []);
    const value = field.values[picked.index];
    return {
      field: field.field,
      label: field.label,
      intervalMinutes: field.interval_minutes,
      nextRunAt: st.next_run_at || null,
      preview: field.field === 'thumbnail' ? value.thumbnail_path : template.render(value.value, ctx),
    };
  });
  return { mode: 'independent', fields };
}

module.exports = { start, stop, tick, onStreamStart, onStreamStop, rotateNow, preview, pickNext };
