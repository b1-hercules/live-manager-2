'use strict';

const fs = require('fs');
const path = require('path');
const { db, now } = require('../db');
const config = require('../config');
const { safeJsonParse, parseTags, toBool, toInt, clamp } = require('../utils/helpers');

const FIELDS = ['title', 'description', 'tags', 'thumbnail'];

const FIELD_LABELS = {
  title: 'Judul',
  description: 'Deskripsi',
  tags: 'Tags',
  thumbnail: 'Thumbnail',
};

/**
 * Interval minimum. Rotasi terlalu cepat memboroskan kuota API dan tidak
 * memberi waktu YouTube mengumpulkan data impresi yang bermakna.
 */
const MIN_INTERVAL = 5;

// ---------------------------------------------------------------- profiles

function hydrateProfile(row) {
  if (!row) return null;
  return {
    ...row,
    apply_title: !!row.apply_title,
    apply_description: !!row.apply_description,
    apply_tags: !!row.apply_tags,
    apply_thumbnail: !!row.apply_thumbnail,
    stop_on_quota: !!row.stop_on_quota,
    active: !!row.active,
  };
}

function listProfiles(userId) {
  const rows = db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM rotation_items i WHERE i.profile_id = p.id AND i.active = 1) AS item_count,
        (SELECT COUNT(*) FROM streams s WHERE s.rotation_profile_id = p.id) AS stream_count
       FROM rotation_profiles p WHERE p.user_id = ? ORDER BY p.created_at DESC`
    )
    .all(userId);
  return rows.map(hydrateProfile);
}

function findProfile(id, userId = null) {
  const row = db.prepare('SELECT * FROM rotation_profiles WHERE id = ?').get(id);
  if (!row) return null;
  if (userId !== null && row.user_id !== userId) return null;
  return hydrateProfile(row);
}

function createProfile(data) {
  const info = db
    .prepare(
      `INSERT INTO rotation_profiles
        (user_id, name, description, mode, interval_minutes, order_mode,
         apply_title, apply_description, apply_tags, apply_thumbnail,
         jitter_seconds, stop_on_quota, active, created_at, updated_at)
       VALUES (@user_id, @name, @description, @mode, @interval_minutes, @order_mode,
         @apply_title, @apply_description, @apply_tags, @apply_thumbnail,
         @jitter_seconds, @stop_on_quota, @active, @created_at, @updated_at)`
    )
    .run(normalizeProfile(data));
  const profile = findProfile(info.lastInsertRowid);
  ensureFieldRows(profile.id);
  return profile;
}

function updateProfile(id, userId, data) {
  const existing = findProfile(id, userId);
  if (!existing) return null;
  const payload = normalizeProfile({ ...data, user_id: existing.user_id });
  db.prepare(
    `UPDATE rotation_profiles SET name = @name, description = @description, mode = @mode,
      interval_minutes = @interval_minutes, order_mode = @order_mode,
      apply_title = @apply_title, apply_description = @apply_description,
      apply_tags = @apply_tags, apply_thumbnail = @apply_thumbnail,
      jitter_seconds = @jitter_seconds, stop_on_quota = @stop_on_quota,
      active = @active, updated_at = @updated_at
     WHERE id = @id`
  ).run({ ...payload, id });
  ensureFieldRows(id);
  return findProfile(id, userId);
}

function normalizeProfile(data) {
  return {
    user_id: data.user_id,
    name: String(data.name || 'Profil Rotasi').trim().slice(0, 120),
    description: data.description ? String(data.description).slice(0, 500) : null,
    mode: data.mode === 'independent' ? 'independent' : 'bundle',
    interval_minutes: clamp(toInt(data.interval_minutes, 60), MIN_INTERVAL, 10080),
    order_mode: ['sequential', 'random', 'shuffle'].includes(data.order_mode) ? data.order_mode : 'sequential',
    apply_title: toBool(data.apply_title) ? 1 : 0,
    apply_description: toBool(data.apply_description) ? 1 : 0,
    apply_tags: toBool(data.apply_tags) ? 1 : 0,
    apply_thumbnail: toBool(data.apply_thumbnail) ? 1 : 0,
    jitter_seconds: clamp(toInt(data.jitter_seconds, 0), 0, 3600),
    stop_on_quota: toBool(data.stop_on_quota) ? 1 : 0,
    active: toBool(data.active) ? 1 : 0,
    created_at: now(),
    updated_at: now(),
  };
}

function removeProfile(id, userId) {
  const profile = findProfile(id, userId);
  if (!profile) return false;
  for (const item of listItems(id)) deleteThumbFile(item.thumbnail_path);
  for (const field of listFields(id)) {
    for (const value of listFieldValues(field.id)) deleteThumbFile(value.thumbnail_path);
  }
  db.prepare('DELETE FROM rotation_profiles WHERE id = ? AND user_id = ?').run(id, userId);
  return true;
}

// ------------------------------------------------------- items (mode bundle)

function hydrateItem(row) {
  if (!row) return null;
  return { ...row, tagList: safeJsonParse(row.tags, []), active: !!row.active };
}

function listItems(profileId, { onlyActive = false } = {}) {
  const sql = onlyActive
    ? 'SELECT * FROM rotation_items WHERE profile_id = ? AND active = 1 ORDER BY position, id'
    : 'SELECT * FROM rotation_items WHERE profile_id = ? ORDER BY position, id';
  return db.prepare(sql).all(profileId).map(hydrateItem);
}

function findItem(id) {
  return hydrateItem(db.prepare('SELECT * FROM rotation_items WHERE id = ?').get(id));
}

function nextPosition(profileId) {
  const row = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM rotation_items WHERE profile_id = ?').get(profileId);
  return row.p + 1;
}

function createItem(profileId, data) {
  const info = db
    .prepare(
      `INSERT INTO rotation_items
        (profile_id, position, label, title, description, tags, thumbnail_path, weight, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      profileId,
      data.position !== undefined ? toInt(data.position, 0) : nextPosition(profileId),
      data.label ? String(data.label).slice(0, 80) : null,
      data.title ? String(data.title).slice(0, 100) : null,
      data.description ? String(data.description).slice(0, 5000) : null,
      JSON.stringify(parseTags(data.tags)),
      data.thumbnail_path || null,
      clamp(toInt(data.weight, 1), 1, 100),
      toBool(data.active === undefined ? 1 : data.active) ? 1 : 0,
      now(), now()
    );
  return findItem(info.lastInsertRowid);
}

function updateItem(id, data) {
  const existing = findItem(id);
  if (!existing) return null;
  // Thumbnail lama dihapus hanya kalau memang ada penggantinya.
  if (data.thumbnail_path && existing.thumbnail_path && data.thumbnail_path !== existing.thumbnail_path) {
    deleteThumbFile(existing.thumbnail_path);
  }
  db.prepare(
    `UPDATE rotation_items SET label = ?, title = ?, description = ?, tags = ?,
      thumbnail_path = COALESCE(?, thumbnail_path), weight = ?, active = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    data.label ? String(data.label).slice(0, 80) : null,
    data.title ? String(data.title).slice(0, 100) : null,
    data.description ? String(data.description).slice(0, 5000) : null,
    JSON.stringify(parseTags(data.tags)),
    data.thumbnail_path || null,
    clamp(toInt(data.weight, 1), 1, 100),
    toBool(data.active) ? 1 : 0,
    now(),
    id
  );
  return findItem(id);
}

function removeItem(id) {
  const item = findItem(id);
  if (!item) return false;
  deleteThumbFile(item.thumbnail_path);
  db.prepare('DELETE FROM rotation_items WHERE id = ?').run(id);
  return true;
}

function toggleItem(id) {
  db.prepare('UPDATE rotation_items SET active = 1 - active, updated_at = ? WHERE id = ?').run(now(), id);
  return findItem(id);
}

function reorderItems(profileId, orderedIds) {
  const stmt = db.prepare('UPDATE rotation_items SET position = ? WHERE id = ? AND profile_id = ?');
  db.transaction(() => {
    orderedIds.forEach((id, index) => stmt.run(index, id, profileId));
  })();
}

function clearItemThumbnail(id) {
  const item = findItem(id);
  if (!item) return null;
  deleteThumbFile(item.thumbnail_path);
  db.prepare('UPDATE rotation_items SET thumbnail_path = NULL, updated_at = ? WHERE id = ?').run(now(), id);
  return findItem(id);
}

function markItemApplied(id) {
  db.prepare('UPDATE rotation_items SET times_applied = times_applied + 1, last_applied_at = ? WHERE id = ?')
    .run(now(), id);
}

// -------------------------------------------------- fields (mode independent)

/** Setiap profil selalu punya empat baris field agar UI tidak perlu cek null. */
function ensureFieldRows(profileId) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO rotation_fields (profile_id, field, enabled, interval_minutes, order_mode, created_at, updated_at)
     VALUES (?, ?, 0, 60, 'sequential', ?, ?)`
  );
  db.transaction(() => {
    for (const field of FIELDS) insert.run(profileId, field, now(), now());
  })();
}

function listFields(profileId) {
  ensureFieldRows(profileId);
  return db
    .prepare('SELECT * FROM rotation_fields WHERE profile_id = ? ORDER BY id')
    .all(profileId)
    .map((row) => ({ ...row, enabled: !!row.enabled, label: FIELD_LABELS[row.field] }));
}

function findField(profileId, field) {
  ensureFieldRows(profileId);
  const row = db.prepare('SELECT * FROM rotation_fields WHERE profile_id = ? AND field = ?').get(profileId, field);
  return row ? { ...row, enabled: !!row.enabled, label: FIELD_LABELS[row.field] } : null;
}

function findFieldById(id) {
  const row = db.prepare('SELECT * FROM rotation_fields WHERE id = ?').get(id);
  return row ? { ...row, enabled: !!row.enabled, label: FIELD_LABELS[row.field] } : null;
}

function updateField(profileId, field, { enabled, interval_minutes, order_mode }) {
  db.prepare(
    `UPDATE rotation_fields SET enabled = ?, interval_minutes = ?, order_mode = ?, updated_at = ?
     WHERE profile_id = ? AND field = ?`
  ).run(
    toBool(enabled) ? 1 : 0,
    clamp(toInt(interval_minutes, 60), MIN_INTERVAL, 10080),
    ['sequential', 'random', 'shuffle'].includes(order_mode) ? order_mode : 'sequential',
    now(), profileId, field
  );
  return findField(profileId, field);
}

function listFieldValues(fieldId, { onlyActive = false } = {}) {
  const sql = onlyActive
    ? 'SELECT * FROM rotation_field_values WHERE field_id = ? AND active = 1 ORDER BY position, id'
    : 'SELECT * FROM rotation_field_values WHERE field_id = ? ORDER BY position, id';
  return db.prepare(sql).all(fieldId).map((row) => ({ ...row, active: !!row.active }));
}

function findFieldValue(id) {
  const row = db.prepare('SELECT * FROM rotation_field_values WHERE id = ?').get(id);
  return row ? { ...row, active: !!row.active } : null;
}

function createFieldValue(fieldId, { value, thumbnail_path = null, weight = 1 }) {
  const pos = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM rotation_field_values WHERE field_id = ?')
    .get(fieldId).p + 1;
  const info = db
    .prepare(
      `INSERT INTO rotation_field_values (field_id, position, value, thumbnail_path, weight, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
    .run(fieldId, pos, value ?? null, thumbnail_path, clamp(toInt(weight, 1), 1, 100), now());
  return findFieldValue(info.lastInsertRowid);
}

function updateFieldValue(id, { value, thumbnail_path, weight, active }) {
  const existing = findFieldValue(id);
  if (!existing) return null;
  if (thumbnail_path && existing.thumbnail_path && thumbnail_path !== existing.thumbnail_path) {
    deleteThumbFile(existing.thumbnail_path);
  }
  db.prepare(
    `UPDATE rotation_field_values SET value = ?, thumbnail_path = COALESCE(?, thumbnail_path),
      weight = ?, active = ? WHERE id = ?`
  ).run(
    value ?? existing.value,
    thumbnail_path || null,
    clamp(toInt(weight, existing.weight), 1, 100),
    toBool(active === undefined ? existing.active : active) ? 1 : 0,
    id
  );
  return findFieldValue(id);
}

function removeFieldValue(id) {
  const row = findFieldValue(id);
  if (!row) return false;
  deleteThumbFile(row.thumbnail_path);
  db.prepare('DELETE FROM rotation_field_values WHERE id = ?').run(id);
  return true;
}

function toggleFieldValue(id) {
  db.prepare('UPDATE rotation_field_values SET active = 1 - active WHERE id = ?').run(id);
  return findFieldValue(id);
}

function markFieldValueApplied(id) {
  db.prepare('UPDATE rotation_field_values SET times_applied = times_applied + 1, last_applied_at = ? WHERE id = ?')
    .run(now(), id);
}

/** Field mana saja yang benar-benar siap dipakai (aktif dan punya isi). */
function readyFields(profileId) {
  return listFields(profileId)
    .map((field) => ({ ...field, values: listFieldValues(field.id, { onlyActive: true }) }))
    .filter((field) => field.enabled && field.values.length > 0);
}

// ------------------------------------------------------------- state & logs

function getState(streamId) {
  const row = db.prepare('SELECT * FROM rotation_state WHERE stream_id = ?').get(streamId);
  if (!row) return null;
  return {
    ...row,
    shuffleOrder: safeJsonParse(row.shuffle_order, []),
    fieldState: safeJsonParse(row.field_state, {}),
  };
}

function saveState(streamId, patch) {
  const existing = getState(streamId);
  const merged = {
    stream_id: streamId,
    profile_id: patch.profile_id ?? existing?.profile_id ?? null,
    cursor: patch.cursor ?? existing?.cursor ?? 0,
    shuffle_order: JSON.stringify(patch.shuffleOrder ?? existing?.shuffleOrder ?? []),
    next_run_at: patch.next_run_at !== undefined ? patch.next_run_at : (existing?.next_run_at ?? null),
    field_state: JSON.stringify(patch.fieldState ?? existing?.fieldState ?? {}),
    last_item_id: patch.last_item_id !== undefined ? patch.last_item_id : (existing?.last_item_id ?? null),
    last_applied_at: patch.last_applied_at !== undefined ? patch.last_applied_at : (existing?.last_applied_at ?? null),
    updated_at: now(),
  };
  db.prepare(
    `INSERT INTO rotation_state
      (stream_id, profile_id, cursor, shuffle_order, next_run_at, field_state, last_item_id, last_applied_at, updated_at)
     VALUES (@stream_id, @profile_id, @cursor, @shuffle_order, @next_run_at, @field_state, @last_item_id, @last_applied_at, @updated_at)
     ON CONFLICT(stream_id) DO UPDATE SET
      profile_id = excluded.profile_id, cursor = excluded.cursor, shuffle_order = excluded.shuffle_order,
      next_run_at = excluded.next_run_at, field_state = excluded.field_state,
      last_item_id = excluded.last_item_id, last_applied_at = excluded.last_applied_at,
      updated_at = excluded.updated_at`
  ).run(merged);
  return getState(streamId);
}

function resetState(streamId) {
  db.prepare('DELETE FROM rotation_state WHERE stream_id = ?').run(streamId);
}

function addLog({ stream_id, profile_id = null, item_id = null, provider = 'youtube', field = null, status = 'success', payload = null, message = null, quota_cost = 0 }) {
  db.prepare(
    `INSERT INTO rotation_logs (stream_id, profile_id, item_id, provider, field, status, payload, message, quota_cost, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    stream_id, profile_id, item_id, provider, field, status,
    payload ? JSON.stringify(payload) : null,
    message ? String(message).slice(0, 1000) : null,
    quota_cost, now()
  );
}

function listLogs({ streamId = null, userId = null, limit = 100 } = {}) {
  let rows;
  if (streamId) {
    rows = db.prepare('SELECT * FROM rotation_logs WHERE stream_id = ? ORDER BY id DESC LIMIT ?').all(streamId, limit);
  } else if (userId) {
    rows = db
      .prepare(
        `SELECT rl.*, s.title AS stream_title FROM rotation_logs rl
         LEFT JOIN streams s ON s.id = rl.stream_id
         WHERE s.user_id = ? ORDER BY rl.id DESC LIMIT ?`
      )
      .all(userId, limit);
  } else {
    rows = db.prepare('SELECT * FROM rotation_logs ORDER BY id DESC LIMIT ?').all(limit);
  }
  return rows.map((r) => ({ ...r, payloadObj: safeJsonParse(r.payload, null) }));
}

function pruneLogs(days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare('DELETE FROM rotation_logs WHERE applied_at < ?').run(cutoff).changes;
}

/** Ringkasan pemakaian tiap varian, dipakai halaman analitik A/B. */
function itemStats(profileId) {
  return db
    .prepare(
      `SELECT i.id, i.label, i.title, i.times_applied, i.last_applied_at, i.active, i.weight,
        (SELECT COUNT(*) FROM rotation_logs l WHERE l.item_id = i.id AND l.status = 'success') AS success_count,
        (SELECT COUNT(*) FROM rotation_logs l WHERE l.item_id = i.id AND l.status = 'error') AS error_count
       FROM rotation_items i WHERE i.profile_id = ? ORDER BY i.position, i.id`
    )
    .all(profileId);
}

// ------------------------------------------------------------------ utils

function deleteThumbFile(relPath) {
  if (!relPath) return;
  const abs = path.isAbsolute(relPath) ? relPath : path.join(config.root, relPath);
  // Thumbnail hilang bukan alasan untuk menggagalkan operasi database.
  try { fs.unlinkSync(abs); } catch (_) { /* sudah tidak ada */ }
}

module.exports = {
  FIELDS, FIELD_LABELS, MIN_INTERVAL,
  listProfiles, findProfile, createProfile, updateProfile, removeProfile,
  listItems, findItem, createItem, updateItem, removeItem, toggleItem, reorderItems,
  clearItemThumbnail, markItemApplied,
  ensureFieldRows, listFields, findField, findFieldById, updateField,
  listFieldValues, findFieldValue, createFieldValue, updateFieldValue, removeFieldValue,
  toggleFieldValue, markFieldValueApplied, readyFields,
  getState, saveState, resetState,
  addLog, listLogs, pruneLogs, itemStats,
};
