// Dual-mode playlist track storage helpers:
//   - When Cloudflare D1 (`env.DB`) is bound: atomic SQLite rows in `music_tracks` so concurrent
//     multi-select Telegram audio forwards never overwrite each other across isolates.
//   - When KV-only (`!env.DB`): in-isolate async queue serializes concurrent writes on `config:panel`.

import { ensureSchema } from './d1Schema.js';

export const MAX_MUSIC_TRACKS = 20;

const kvMusicLocks = new WeakMap();

/**
 * Serializes concurrent playlist mutations against the same KV binding within one Worker isolate.
 */
export function withKvMusicLock(kv, fn) {
  if (!kv || typeof kv !== 'object') return fn();
  const prev = kvMusicLocks.get(kv) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.then(
    () => {},
    () => {}
  );
  kvMusicLocks.set(kv, tail);
  return run;
}

function rowToTrack(row) {
  if (!row || !row.id || !row.file_id) return null;
  return {
    id: String(row.id),
    fileId: String(row.file_id),
    fileUniqueId: String(row.file_unique_id || ''),
    title: String(row.title || '未命名音频'),
    performer: String(row.performer || ''),
    duration: Number(row.duration) || 0,
    sourceUrl: String(row.source_url || ''),
    sourceTitle: String(row.source_title || ''),
    addedAt: Number(row.added_at) || 0,
  };
}

/**
 * Loads playlist tracks from D1 `music_tracks`. Performs a one-time idempotent seed from legacy
 * KV tracks when D1 is freshly bound so existing KV-only deployments upgrade seamlessly.
 */
export async function loadD1MusicTracks(env, legacyKvTracks = []) {
  if (!env?.DB) return null;
  await ensureSchema(env);

  const res = await env.DB.prepare(
    `SELECT id, file_id, file_unique_id, title, performer, duration, source_url, source_title, added_at
     FROM music_tracks
     ORDER BY sort_order ASC, added_at DESC, id ASC
     LIMIT ?`
  )
    .bind(MAX_MUSIC_TRACKS)
    .all();
  const rows = (res?.results || []).map(rowToTrack).filter(Boolean);
  if (rows.length > 0) return rows;

  const validLegacy = Array.isArray(legacyKvTracks)
    ? legacyKvTracks.filter((t) => t?.id && t?.fileId).slice(0, MAX_MUSIC_TRACKS)
    : [];
  if (validLegacy.length === 0) return [];

  const seededRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'music_kv_seeded'`).first();
  if (seededRow?.value === '1') return [];

  const stmts = validLegacy.map((t, idx) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO music_tracks (
        id, file_id, file_unique_id, title, performer, duration, source_url, source_title, sort_order, added_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      t.id,
      t.fileId,
      t.fileUniqueId || '',
      t.title || '未命名音频',
      t.performer || '',
      Number(t.duration) || 0,
      t.sourceUrl || '',
      t.sourceTitle || '',
      idx + 1,
      Number(t.addedAt) || Date.now()
    )
  );
  stmts.push(
    env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('music_kv_seeded', '1')`)
  );
  await env.DB.batch(stmts);
  return validLegacy;
}

/**
 * Atomically inserts or bumps a forwarded audio track in D1 `music_tracks`.
 * Uses SQLite partial unique index on non-empty `file_unique_id` so concurrent multi-select
 * forwards (even duplicate forwards of the same song) never drop tracks.
 */
export async function upsertD1MusicTrack(env, extracted, createId, legacyKvTracks = []) {
  await ensureSchema(env);
  if (Array.isArray(legacyKvTracks) && legacyKvTracks.length > 0) {
    await loadD1MusicTracks(env, legacyKvTracks).catch(() => {});
  }

  const now = Date.now();
  const sortOrder = -now;
  const newId = createId();

  if (extracted.fileUniqueId) {
    const upsertStmt = env.DB.prepare(
      `INSERT INTO music_tracks (
        id, file_id, file_unique_id, title, performer, duration, source_url, source_title, sort_order, added_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_unique_id) WHERE file_unique_id != '' DO UPDATE SET
        file_id = excluded.file_id,
        title = CASE
          WHEN music_tracks.title != '' AND music_tracks.title != '未命名音频' THEN music_tracks.title
          ELSE excluded.title
        END,
        performer = CASE
          WHEN music_tracks.performer != '' THEN music_tracks.performer
          ELSE excluded.performer
        END,
        duration = CASE
          WHEN excluded.duration > 0 THEN excluded.duration
          ELSE music_tracks.duration
        END,
        source_url = CASE
          WHEN excluded.source_url != '' THEN excluded.source_url
          ELSE music_tracks.source_url
        END,
        source_title = CASE
          WHEN excluded.source_url != '' THEN excluded.source_title
          ELSE music_tracks.source_title
        END,
        sort_order = excluded.sort_order,
        added_at = excluded.added_at`
    ).bind(
      newId,
      extracted.fileId,
      extracted.fileUniqueId,
      extracted.title || '未命名音频',
      extracted.performer || '',
      Number(extracted.duration) || 0,
      extracted.sourceUrl || '',
      extracted.sourceTitle || '',
      sortOrder,
      now
    );

    const trimStmt = env.DB.prepare(
      `DELETE FROM music_tracks WHERE id NOT IN (
        SELECT id FROM music_tracks ORDER BY sort_order ASC, added_at DESC, id ASC LIMIT ?
      )`
    ).bind(MAX_MUSIC_TRACKS);

    const fetchStmt = env.DB.prepare(
      `SELECT id, file_id, file_unique_id, title, performer, duration, source_url, source_title, added_at
       FROM music_tracks WHERE file_unique_id = ? LIMIT 1`
    ).bind(extracted.fileUniqueId);

    const countStmt = env.DB.prepare(`SELECT COUNT(*) AS cnt FROM music_tracks`);
    const seedStmt = env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('music_kv_seeded', '1')`);

    const results = await env.DB.batch([upsertStmt, trimStmt, fetchStmt, countStmt, seedStmt]);
    const trimmed = Number(results[1]?.meta?.changes || 0) > 0;
    const savedRow = results[2]?.results?.[0];
    const total = Number(results[3]?.results?.[0]?.cnt || 0);
    const track = rowToTrack(savedRow) || { id: newId, ...extracted, addedAt: now };
    return {
      track,
      updatedExisting: track.id !== newId,
      total,
      trimmed,
    };
  }

  // Fallback when Telegram payload lacks `file_unique_id`: match by `file_id`
  const existing = await env.DB.prepare(
    `SELECT id, file_id, file_unique_id, title, performer, duration, source_url, source_title, added_at
     FROM music_tracks WHERE file_id = ? LIMIT 1`
  )
    .bind(extracted.fileId)
    .first();

  let targetId = newId;
  let updatedExisting = false;
  let nextTrack;
  if (existing) {
    targetId = String(existing.id);
    updatedExisting = true;
    nextTrack = {
      id: targetId,
      fileId: extracted.fileId,
      fileUniqueId: String(existing.file_unique_id || ''),
      title: existing.title && existing.title !== '未命名音频' ? String(existing.title) : extracted.title || '未命名音频',
      performer: String(existing.performer || '') || extracted.performer || '',
      duration: Number(extracted.duration) || Number(existing.duration) || 0,
      sourceUrl: extracted.sourceUrl || String(existing.source_url || ''),
      sourceTitle: extracted.sourceUrl ? extracted.sourceTitle || '' : String(existing.source_title || ''),
      addedAt: now,
    };
  } else {
    nextTrack = {
      id: targetId,
      ...extracted,
      addedAt: now,
    };
  }

  const writeStmt = env.DB.prepare(
    `INSERT INTO music_tracks (
      id, file_id, file_unique_id, title, performer, duration, source_url, source_title, sort_order, added_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_id = excluded.file_id,
      title = excluded.title,
      performer = excluded.performer,
      duration = excluded.duration,
      source_url = excluded.source_url,
      source_title = excluded.source_title,
      sort_order = excluded.sort_order,
      added_at = excluded.added_at`
  ).bind(
    nextTrack.id,
    nextTrack.fileId,
    nextTrack.fileUniqueId || '',
    nextTrack.title,
    nextTrack.performer,
    nextTrack.duration,
    nextTrack.sourceUrl,
    nextTrack.sourceTitle,
    sortOrder,
    now
  );
  const trimStmt = env.DB.prepare(
    `DELETE FROM music_tracks WHERE id NOT IN (
      SELECT id FROM music_tracks ORDER BY sort_order ASC, added_at DESC, id ASC LIMIT ?
    )`
  ).bind(MAX_MUSIC_TRACKS);
  const countStmt = env.DB.prepare(`SELECT COUNT(*) AS cnt FROM music_tracks`);
  const seedStmt = env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('music_kv_seeded', '1')`);

  const results = await env.DB.batch([writeStmt, trimStmt, countStmt, seedStmt]);
  return {
    track: nextTrack,
    updatedExisting,
    total: Number(results[2]?.results?.[0]?.cnt || 0),
    trimmed: Number(results[1]?.meta?.changes || 0) > 0,
  };
}

/**
 * Atomically deletes one track by ID in D1 `music_tracks` without touching sibling tracks.
 */
export async function removeD1MusicTrack(env, trackId, legacyKvTracks = []) {
  await ensureSchema(env);
  if (Array.isArray(legacyKvTracks) && legacyKvTracks.length > 0) {
    await loadD1MusicTracks(env, legacyKvTracks).catch(() => {});
  }

  const row = await env.DB.prepare(
    `SELECT id, file_id, file_unique_id, title, performer, duration, source_url, source_title, added_at
     FROM music_tracks WHERE id = ? LIMIT 1`
  )
    .bind(trackId)
    .first();
  if (!row) return null;

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM music_tracks WHERE id = ?`).bind(trackId),
    env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('music_kv_seeded', '1')`),
  ]);
  return rowToTrack(row);
}

/**
 * Syncs Settings-edited tracks into D1 `music_tracks`.
 * When `preserveAfterMs > 0` (the server `snapshotAt` captured when Settings opened),
 * any track forwarded after that timestamp is NEVER deleted even if it arrives concurrently.
 */
export async function saveD1MusicTracks(env, tracks = [], { preserveAfterMs = 0 } = {}) {
  await ensureSchema(env);
  const safeTracks = Array.isArray(tracks) ? tracks.slice(0, MAX_MUSIC_TRACKS) : [];
  const keptIds = safeTracks.map((t) => t.id);
  const stmts = [];

  if (keptIds.length === 0) {
    if (preserveAfterMs > 0) {
      stmts.push(env.DB.prepare(`DELETE FROM music_tracks WHERE added_at <= ?`).bind(preserveAfterMs));
    } else {
      stmts.push(env.DB.prepare(`DELETE FROM music_tracks`));
    }
  } else {
    const placeholders = keptIds.map(() => '?').join(', ');
    if (preserveAfterMs > 0) {
      stmts.push(
        env.DB.prepare(
          `DELETE FROM music_tracks WHERE id NOT IN (${placeholders}) AND added_at <= ?`
        ).bind(...keptIds, preserveAfterMs)
      );
    } else {
      stmts.push(
        env.DB.prepare(`DELETE FROM music_tracks WHERE id NOT IN (${placeholders})`).bind(...keptIds)
      );
    }
  }

  // Upsert tracks in client order with positive `sort_order = idx + 1` (or preserve negative sort_order
  // for newly-forwarded tracks whose `addedAt > preserveAfterMs` so they stay pinned at the top).
  safeTracks.forEach((t, idx) => {
    const sortOrder = preserveAfterMs > 0 && Number(t.addedAt) > preserveAfterMs ? -Number(t.addedAt) : idx + 1;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO music_tracks (
          id, file_id, file_unique_id, title, performer, duration, source_url, source_title, sort_order, added_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_id = excluded.file_id,
          file_unique_id = excluded.file_unique_id,
          title = excluded.title,
          performer = excluded.performer,
          duration = excluded.duration,
          source_url = excluded.source_url,
          source_title = excluded.source_title,
          sort_order = excluded.sort_order,
          added_at = excluded.added_at`
      ).bind(
        t.id,
        t.fileId,
        t.fileUniqueId || '',
        t.title || '未命名音频',
        t.performer || '',
        Number(t.duration) || 0,
        t.sourceUrl || '',
        t.sourceTitle || '',
        sortOrder,
        Number(t.addedAt) || Date.now()
      )
    );
  });

  stmts.push(
    env.DB.prepare(
      `DELETE FROM music_tracks WHERE id NOT IN (
        SELECT id FROM music_tracks ORDER BY sort_order ASC, added_at DESC, id ASC LIMIT ?
      )`
    ).bind(MAX_MUSIC_TRACKS),
    env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('music_kv_seeded', '1')`)
  );

  await env.DB.batch(stmts);
  return loadD1MusicTracks(env);
}
