'use strict';

const { db, now } = require('../db');
const { toBool, toInt, clamp } = require('../utils/helpers');

const ACTIVE_STATUSES = ['starting', 'live', 'stopping'];

const RESOLUTIONS = {
  source: { label: 'Ikut sumber', width: null, height: null },
  '1080p': { label: '1080p (1920x1080)', width: 1920, height: 1080 },
  '720p': { label: '720p (1280x720)', width: 1280, height: 720 },
  '480p': { label: '480p (854x480)', width: 854, height: 480 },
  '360p': { label: '360p (640x360)', width: 640, height: 360 },
};

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    loop_video: !!row.loop_video,
    auto_restart: !!row.auto_restart,
    rotation_enabled: !!row.rotation_enabled,
    rotate_on_start: !!row.rotate_on_start,
    youtube_auto_detect: !!row.youtube_auto_detect,
    isActive: ACTIVE_STATUSES.includes(row.status),
  };
}

function listByUser(userId) {
  return db
    .prepare(
      `SELECT s.*, v.title AS video_title, v.thumbnail_path AS video_thumbnail,
        v.duration AS video_duration, v.width AS video_width, v.height AS video_height,
        p.name AS rotation_profile_name, p.mode AS rotation_mode,
        a.name AS youtube_account_name,
        pl.name AS playlist_name,
        (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = s.playlist_id) AS playlist_count,
        (SELECT COUNT(*) FROM stream_destinations sd WHERE sd.stream_id = s.id) AS destination_count
       FROM streams s
       LEFT JOIN videos v ON v.id = s.video_id
       LEFT JOIN playlists pl ON pl.id = s.playlist_id
       LEFT JOIN rotation_profiles p ON p.id = s.rotation_profile_id
       LEFT JOIN accounts a ON a.id = s.youtube_account_id
       WHERE s.user_id = ? ORDER BY
         CASE s.status WHEN 'live' THEN 0 WHEN 'starting' THEN 1 WHEN 'scheduled' THEN 2 ELSE 3 END,
         s.created_at DESC`
    )
    .all(userId)
    .map(hydrate);
}

function findById(id, userId = null) {
  const row = db
    .prepare(
      `SELECT s.*, v.title AS video_title, v.filepath AS video_filepath,
        v.thumbnail_path AS video_thumbnail, v.duration AS video_duration,
        v.width AS video_width, v.height AS video_height, v.has_audio AS video_has_audio,
        v.video_codec AS video_codec, v.audio_codec AS audio_codec,
        p.name AS rotation_profile_name, p.mode AS rotation_mode,
        a.name AS youtube_account_name,
        pl.name AS playlist_name,
        (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = s.playlist_id) AS playlist_count
       FROM streams s
       LEFT JOIN videos v ON v.id = s.video_id
       LEFT JOIN playlists pl ON pl.id = s.playlist_id
       LEFT JOIN rotation_profiles p ON p.id = s.rotation_profile_id
       LEFT JOIN accounts a ON a.id = s.youtube_account_id
       WHERE s.id = ?`
    )
    .get(id);
  if (!row) return null;
  if (userId !== null && row.user_id !== userId) return null;
  return hydrate(row);
}

/** Semua stream yang prosesnya seharusnya hidup — dipakai saat recovery restart. */
function listActive() {
  return db
    .prepare(`SELECT * FROM streams WHERE status IN ('starting','live','stopping')`)
    .all()
    .map(hydrate);
}

function listScheduled() {
  return db
    .prepare(`SELECT * FROM streams WHERE status = 'scheduled' AND schedule_start_at IS NOT NULL`)
    .all()
    .map(hydrate);
}

/** Stream berjalan yang punya batas waktu berakhir. */
function listWithEndTime() {
  return db
    .prepare(`SELECT * FROM streams WHERE status = 'live' AND (schedule_end_at IS NOT NULL OR duration_minutes IS NOT NULL)`)
    .all()
    .map(hydrate);
}

function listRotating() {
  return db
    .prepare(
      `SELECT s.* FROM streams s
       WHERE s.status = 'live' AND s.rotation_enabled = 1 AND s.rotation_profile_id IS NOT NULL`
    )
    .all()
    .map(hydrate);
}

function normalize(data) {
  // Sumber siaran hanya boleh satu: video tunggal atau playlist. Form mengirim
  // keduanya (yang tidak dipilih bernilai kosong), jadi penentuannya di sini —
  // playlist menang, dan video_id dikosongkan supaya tidak ada sisa yang
  // membingungkan saat sumbernya diganti.
  const playlistId = data.playlist_id ? toInt(data.playlist_id) : null;
  const videoId = data.video_id ? toInt(data.video_id) : null;

  return {
    title: String(data.title || 'Live Stream').trim().slice(0, 150),
    video_id: playlistId ? null : videoId,
    playlist_id: playlistId,
    encode_mode: data.encode_mode === 'reencode' ? 'reencode' : 'copy',
    resolution: RESOLUTIONS[data.resolution] ? data.resolution : 'source',
    orientation: data.orientation === 'portrait' ? 'portrait' : 'landscape',
    bitrate: clamp(toInt(data.bitrate, 4500), 500, 51000),
    audio_bitrate: clamp(toInt(data.audio_bitrate, 128), 32, 512),
    fps: clamp(toInt(data.fps, 30), 1, 60),
    preset: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(data.preset)
      ? data.preset : 'veryfast',
    loop_video: toBool(data.loop_video) ? 1 : 0,
    auto_restart: toBool(data.auto_restart) ? 1 : 0,
    schedule_start_at: data.schedule_start_at || null,
    schedule_end_at: data.schedule_end_at || null,
    duration_minutes: data.duration_minutes ? clamp(toInt(data.duration_minutes), 1, 100000) : null,
    rotation_profile_id: data.rotation_profile_id ? toInt(data.rotation_profile_id) : null,
    rotation_enabled: toBool(data.rotation_enabled) ? 1 : 0,
    rotate_on_start: toBool(data.rotate_on_start) ? 1 : 0,
    youtube_account_id: data.youtube_account_id ? toInt(data.youtube_account_id) : null,
    youtube_video_id: data.youtube_video_id ? String(data.youtube_video_id).trim() : null,
    youtube_auto_detect: toBool(data.youtube_auto_detect) ? 1 : 0,
  };
}

function create(userId, data, destinationIds = []) {
  const payload = normalize(data);
  const status = payload.schedule_start_at ? 'scheduled' : 'idle';
  let id;
  db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO streams
          (user_id, title, video_id, playlist_id, encode_mode, resolution, orientation, bitrate, audio_bitrate,
           fps, preset, loop_video, auto_restart, status, schedule_start_at, schedule_end_at,
           duration_minutes, rotation_profile_id, rotation_enabled, rotate_on_start,
           youtube_account_id, youtube_video_id, youtube_auto_detect, created_at, updated_at)
         VALUES (@user_id, @title, @video_id, @playlist_id, @encode_mode, @resolution, @orientation, @bitrate,
           @audio_bitrate, @fps, @preset, @loop_video, @auto_restart, @status, @schedule_start_at,
           @schedule_end_at, @duration_minutes, @rotation_profile_id, @rotation_enabled,
           @rotate_on_start, @youtube_account_id, @youtube_video_id, @youtube_auto_detect,
           @created_at, @updated_at)`
      )
      .run({ ...payload, user_id: userId, status, created_at: now(), updated_at: now() });
    id = info.lastInsertRowid;
    setDestinations(id, destinationIds);
  })();
  return findById(id);
}

function update(id, userId, data, destinationIds = null) {
  const existing = findById(id, userId);
  if (!existing) return null;
  const payload = normalize(data);
  db.transaction(() => {
    db.prepare(
      `UPDATE streams SET title = @title, video_id = @video_id, playlist_id = @playlist_id,
        encode_mode = @encode_mode,
        resolution = @resolution, orientation = @orientation, bitrate = @bitrate,
        audio_bitrate = @audio_bitrate, fps = @fps, preset = @preset, loop_video = @loop_video,
        auto_restart = @auto_restart, schedule_start_at = @schedule_start_at,
        schedule_end_at = @schedule_end_at, duration_minutes = @duration_minutes,
        rotation_profile_id = @rotation_profile_id, rotation_enabled = @rotation_enabled,
        rotate_on_start = @rotate_on_start, youtube_account_id = @youtube_account_id,
        youtube_video_id = @youtube_video_id, youtube_auto_detect = @youtube_auto_detect,
        updated_at = @updated_at
       WHERE id = @id AND user_id = @user_id`
    ).run({ ...payload, id, user_id: userId, updated_at: now() });

    // Stream idle yang diberi jadwal baru harus pindah ke status scheduled,
    // dan sebaliknya kalau jadwalnya dihapus.
    if (!existing.isActive) {
      const nextStatus = payload.schedule_start_at ? 'scheduled' : 'idle';
      if (existing.status === 'idle' || existing.status === 'scheduled') {
        db.prepare('UPDATE streams SET status = ? WHERE id = ?').run(nextStatus, id);
      }
    }
    if (destinationIds !== null) setDestinations(id, destinationIds);
  })();
  return findById(id, userId);
}

function setDestinations(streamId, destinationIds) {
  db.prepare('DELETE FROM stream_destinations WHERE stream_id = ?').run(streamId);
  const stmt = db.prepare('INSERT OR IGNORE INTO stream_destinations (stream_id, destination_id) VALUES (?, ?)');
  for (const destId of destinationIds || []) stmt.run(streamId, toInt(destId));
}

function destinationIds(streamId) {
  return db
    .prepare('SELECT destination_id FROM stream_destinations WHERE stream_id = ?')
    .all(streamId)
    .map((r) => r.destination_id);
}

function setStatus(id, status, extra = {}) {
  const fields = ['status = @status', 'updated_at = @updated_at'];
  const params = { id, status, updated_at: now() };
  for (const [key, value] of Object.entries(extra)) {
    fields.push(`${key} = @${key}`);
    params[key] = value;
  }
  db.prepare(`UPDATE streams SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return findById(id);
}

function incrementRestart(id) {
  db.prepare('UPDATE streams SET restart_count = restart_count + 1, updated_at = ? WHERE id = ?').run(now(), id);
}

function setResolvedVideo(id, videoId) {
  db.prepare('UPDATE streams SET resolved_video_id = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
    .run(videoId, now(), now(), id);
}

function remove(id, userId) {
  return db.prepare('DELETE FROM streams WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// ------------------------------------------------------------- sesi & log

function openSession(streamId) {
  const info = db
    .prepare('INSERT INTO stream_sessions (stream_id, started_at) VALUES (?, ?)')
    .run(streamId, now());
  return info.lastInsertRowid;
}

function closeSession(sessionId, { exitCode = null, reason = null } = {}) {
  if (!sessionId) return;
  const session = db.prepare('SELECT * FROM stream_sessions WHERE id = ?').get(sessionId);
  if (!session || session.ended_at) return;
  const seconds = Math.max(0, Math.round((Date.now() - new Date(session.started_at).getTime()) / 1000));
  db.prepare(
    'UPDATE stream_sessions SET ended_at = ?, duration_seconds = ?, exit_code = ?, stop_reason = ? WHERE id = ?'
  ).run(now(), seconds, exitCode, reason, sessionId);
}

function bumpSessionRotations(sessionId) {
  if (!sessionId) return;
  db.prepare('UPDATE stream_sessions SET rotations_count = rotations_count + 1 WHERE id = ?').run(sessionId);
}

function listSessions(streamId, limit = 20) {
  return db
    .prepare('SELECT * FROM stream_sessions WHERE stream_id = ? ORDER BY id DESC LIMIT ?')
    .all(streamId, limit);
}

function addLog(streamId, level, message) {
  db.prepare('INSERT INTO stream_logs (stream_id, level, message, created_at) VALUES (?, ?, ?, ?)')
    .run(streamId, level, String(message).slice(0, 2000), now());
}

function listLogs(streamId, limit = 200) {
  return db
    .prepare('SELECT * FROM stream_logs WHERE stream_id = ? ORDER BY id DESC LIMIT ?')
    .all(streamId, limit);
}

/** Batasi log per stream supaya database tidak membengkak pada siaran 24/7. */
function trimLogs(streamId, keep = 500) {
  db.prepare(
    `DELETE FROM stream_logs WHERE stream_id = ? AND id NOT IN
      (SELECT id FROM stream_logs WHERE stream_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(streamId, streamId, keep);
}

function stats(userId) {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END) AS live,
        SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errored
       FROM streams WHERE user_id = ?`
    )
    .get(userId);
  return { total: row.total || 0, live: row.live || 0, scheduled: row.scheduled || 0, errored: row.errored || 0 };
}

module.exports = {
  ACTIVE_STATUSES, RESOLUTIONS,
  listByUser, findById, listActive, listScheduled, listWithEndTime, listRotating,
  create, update, setDestinations, destinationIds, setStatus, incrementRestart,
  setResolvedVideo, remove,
  openSession, closeSession, bumpSessionRotations, listSessions,
  addLog, listLogs, trimLogs, stats,
};
