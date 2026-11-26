// Progressive & batched KV-to-D1 chat history migration for Stage 1 (v2.0).
// Highest rule: NEVER delete legacy KV keys (`history:*`, `user:*`, `tmsg:*`, `dmmap:*`),
// keeping KV intact as a zero-risk backup until after v2.2.

import { safeGetJSON } from '../config.js';
import { ensureSchema, isSchemaInitialized } from './d1Schema.js';

export const DEFAULT_MIGRATE_BATCH_SIZE = 20;
export const MAX_MIGRATE_BATCH_SIZE = 50;
// Cloudflare Workers Free plan limits each Worker invocation to 50 D1 queries (`batch()` counts as 1).
// Keep a 40-query budget so `ensureSchema` + `discover` + a multi-chunk visitor at the end never exceed 50.
export const MIGRATE_QUERY_BUDGET = 40;
const D1_BATCH_CHUNK_SIZE = 80;
const KV_LIST_MAX_PAGES = 10;
// Deterministic fallback base timestamp when a legacy KV entry has no valid `at`,
// ensuring concurrent or retried migrations always derive identical row IDs.
const FALLBACK_MIGRATION_TS = 1700000000000;

// Per-isolate cache of UIDs confirmed present in `migrated_visitors`, keyed by `env.DB`
const migratedUidCache = new WeakMap();

function getMigratedSet(db) {
  let set = migratedUidCache.get(db);
  if (!set) {
    set = new Set();
    migratedUidCache.set(db, set);
  }
  return set;
}

export function markVisitorMigratedInCache(env, uid) {
  if (!env?.DB || !uid) return;
  getMigratedSet(env.DB).add(String(uid));
}

function toNullablePositiveInt(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseTimestampMs(isoCandidate, numericCandidate, fallbackMs) {
  if (typeof isoCandidate === 'string' && isoCandidate.trim()) {
    const parsed = Date.parse(isoCandidate);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  if (typeof isoCandidate === 'number' && Number.isFinite(isoCandidate) && isoCandidate > 0) {
    return Math.trunc(isoCandidate);
  }
  if (numericCandidate !== null && numericCandidate !== undefined) {
    const num = Number(numericCandidate);
    if (Number.isFinite(num) && num > 0) return Math.trunc(num);
  }
  return Math.trunc(fallbackMs);
}

/**
 * Migrates a single visitor's KV `history:{uid}` into D1 (`messages` + `message_links`)
 * and marks `uid` in `migrated_visitors`. Safe under concurrent calls and partial-failure retries.
 */
export async function migrateVisitor(env, uid, options = {}) {
  const db = env?.DB;
  const cleanUid = String(uid || '').trim();
  if (!db || !/^\d+$/.test(cleanUid)) {
    return {
      ok: false,
      uid: cleanUid,
      alreadyMigrated: false,
      migratedMessages: 0,
      migratedLinks: 0,
      queriesUsed: 0,
    };
  }

  let queriesUsed = 0;
  const schemaWasCached = isSchemaInitialized(env);
  await ensureSchema(env);
  if (!schemaWasCached) {
    queriesUsed += 1;
  }

  const memSet = getMigratedSet(db);
  if (memSet.has(cleanUid)) {
    return {
      ok: true,
      uid: cleanUid,
      alreadyMigrated: true,
      migratedMessages: 0,
      migratedLinks: 0,
      queriesUsed,
    };
  }

  if (!options?.skipMigratedCheck) {
    const doneRow = await db.prepare(`SELECT 1 AS ok FROM migrated_visitors WHERE uid = ?`).bind(cleanUid).first();
    queriesUsed += 1;
    if (doneRow) {
      memSet.add(cleanUid);
      return {
        ok: true,
        uid: cleanUid,
        alreadyMigrated: true,
        migratedMessages: 0,
        migratedLinks: 0,
        queriesUsed,
      };
    }
  }

  const kv = env?.TOPIC_MAP || null;
  const kvHistory = kv ? await safeGetJSON(kv, `history:${cleanUid}`, null) : null;
  const nowMs = Date.now();

  if (!kvHistory || typeof kvHistory !== 'object') {
    await db
      .prepare(`INSERT OR IGNORE INTO migrated_visitors (uid, migrated_at) VALUES (?, ?)`)
      .bind(cleanUid, nowMs)
      .run();
    queriesUsed += 1;
    memSet.add(cleanUid);
    return {
      ok: true,
      uid: cleanUid,
      alreadyMigrated: false,
      migratedMessages: 0,
      migratedLinks: 0,
      queriesUsed,
    };
  }

  // Inspect any already-present D1 rows for this uid so retries after a mid-flight failure skip written rows
  const [existingMsgRes, existingLinkRes] = await db.batch([
    db.prepare(`SELECT id, pm_message_id FROM messages WHERE uid = ?`).bind(cleanUid),
    db.prepare(`SELECT message_id, url FROM message_links WHERE uid = ?`).bind(cleanUid),
  ]);
  queriesUsed += 1;

  const existingIds = new Set();
  const matchedPmIds = new Set();
  for (const r of existingMsgRes?.results || []) {
    if (r?.id) existingIds.add(String(r.id));
    const pId = toNullablePositiveInt(r?.pm_message_id);
    if (pId) matchedPmIds.add(pId);
  }

  const existingLinkKeys = new Set();
  for (const r of existingLinkRes?.results || []) {
    if (r?.message_id && r?.url) {
      existingLinkKeys.add(`${r.message_id}|${r.url}`);
    }
  }

  const kvMessages = Array.isArray(kvHistory.messages) ? kvHistory.messages : [];
  const kvPhotos = Array.isArray(kvHistory.photos) ? kvHistory.photos : [];
  const kvLinks = Array.isArray(kvHistory.links) ? kvHistory.links : [];
  const kvPmIds = Array.isArray(kvHistory.pmMessageIds) ? kvHistory.pmMessageIds : [];

  // Index newest pmMessageIds metadata by PM message ID so bubble rows inherit DM / Topic copy fields
  const pmById = new Map();
  for (const pm of kvPmIds) {
    const pId = toNullablePositiveInt(pm?.id);
    if (pId && !pmById.has(pId)) {
      pmById.set(pId, pm);
    }
  }

  const seenInCurrentKv = new Set();
  const unmatchedPhotos = [...kvPhotos];
  const writeStmts = [];
  let migratedMessages = 0;
  let migratedLinks = 0;

  // 1. Migrate chat bubble rows (`kvMessages` is already oldest -> newest)
  for (let i = 0; i < kvMessages.length; i += 1) {
    const m = kvMessages[i];
    if (!m || typeof m !== 'object') continue;

    const pmId = toNullablePositiveInt(m.pmMessageId);
    const pmEntry = pmId ? pmById.get(pmId) : null;
    if (pmId) {
      matchedPmIds.add(pmId);
    }

    let matchedPhoto = null;
    if (m.photoFileId) {
      const targetFileId = String(m.photoFileId);
      let pIdx = unmatchedPhotos.findIndex((p) => p?.fileId === targetFileId && p?.at === m.at);
      if (pIdx < 0) {
        pIdx = unmatchedPhotos.findIndex((p) => p?.fileId === targetFileId);
      }
      if (pIdx >= 0) {
        [matchedPhoto] = unmatchedPhotos.splice(pIdx, 1);
      }
    }

    const createdAt = parseTimestampMs(m.at, pmEntry?.at, FALLBACK_MIGRATION_TS + i);
    const rawMsgId = typeof m.id === 'string' ? m.id.trim() : '';
    let rowId = rawMsgId
      ? rawMsgId.startsWith('p_') || rawMsgId.startsWith('p:') || rawMsgId.startsWith('pm:')
        ? `m_${rawMsgId}`
        : rawMsgId
      : `m_mig_${createdAt}_${i}`;
    if (seenInCurrentKv.has(rowId)) {
      rowId = `${rowId}_dup_${i}`;
    }
    seenInCurrentKv.add(rowId);

    if (existingIds.has(rowId)) {
      continue;
    }

    const sender = m.sender === 'admin' ? 'admin' : 'visitor';
    const topicMsgId = toNullablePositiveInt(m.topicMsgId ?? pmEntry?.topicMsgId);
    const topicCopyId = toNullablePositiveInt(pmEntry?.topicCopyId);
    const topicThreadId = toNullablePositiveInt(pmEntry?.topicThreadId);
    const hasTopicCopy = Boolean(topicCopyId && topicThreadId);
    const topicChatId =
      pmEntry?.topicChatId !== null && pmEntry?.topicChatId !== undefined && String(pmEntry.topicChatId).trim()
        ? String(pmEntry.topicChatId).trim()
        : null;
    const dmMsgId = toNullablePositiveInt(pmEntry?.dmMsgId);
    const dmCopyId = toNullablePositiveInt(pmEntry?.dmCopyId);

    const rawText = m.text
      ? String(m.text).slice(0, 1500)
      : matchedPhoto?.caption
        ? String(matchedPhoto.caption).slice(0, 140)
        : '';
    const mediaTag = m.mediaTag ? String(m.mediaTag) : null;
    const photoFileId = m.photoFileId ? String(m.photoFileId) : null;
    const thumbFileId = m.thumbFileId
      ? String(m.thumbFileId)
      : matchedPhoto?.thumbFileId
        ? String(matchedPhoto.thumbFileId)
        : photoFileId;
    const stickerFileId = m.stickerFileId ? String(m.stickerFileId) : null;
    const stickerFormat = stickerFileId ? String(m.stickerFormat || 'webp') : null;
    const visitorReaction = m.visitorReaction ? String(m.visitorReaction).slice(0, 16) : null;
    const ownerReaction = m.ownerReaction ? String(m.ownerReaction).slice(0, 16) : null;

    writeStmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO messages (
            id, uid, sender, pm_message_id, topic_msg_id, topic_copy_id, topic_thread_id,
            topic_chat_id, dm_msg_id, dm_copy_id, text, media_tag, photo_file_id,
            thumb_file_id, sticker_file_id, sticker_format, visitor_reaction, owner_reaction, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          rowId,
          cleanUid,
          sender,
          pmId,
          topicMsgId,
          hasTopicCopy ? topicCopyId : null,
          hasTopicCopy ? topicThreadId : null,
          topicChatId,
          dmMsgId,
          dmCopyId,
          rawText || null,
          mediaTag,
          photoFileId,
          thumbFileId,
          stickerFileId,
          stickerFormat,
          visitorReaction,
          ownerReaction,
          createdAt
        )
    );
    migratedMessages += 1;
  }

  // 2. Migrate archive-only photos (`p_*`, e.g. older than the 60-message KV bubble cap), oldest -> newest
  const olderPhotosChronological = [...unmatchedPhotos].reverse();
  for (let i = 0; i < olderPhotosChronological.length; i += 1) {
    const p = olderPhotosChronological[i];
    if (!p?.fileId) continue;
    const createdAt = parseTimestampMs(p.at, null, FALLBACK_MIGRATION_TS - 200_000 + i);
    let rowId = typeof p.id === 'string' && p.id.startsWith('p_') ? p.id : `p:${createdAt}_${i}`;
    if (seenInCurrentKv.has(rowId)) {
      rowId = `${rowId}_dup_${i}`;
    }
    seenInCurrentKv.add(rowId);
    if (existingIds.has(rowId)) continue;

    const fileId = String(p.fileId);
    const thumbFileId = p.thumbFileId ? String(p.thumbFileId) : fileId;
    const caption = p.caption ? String(p.caption).slice(0, 140) : null;
    const sender = p.sender === 'admin' ? 'admin' : 'visitor';

    writeStmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO messages (
            id, uid, sender, pm_message_id, topic_msg_id, topic_copy_id, topic_thread_id,
            topic_chat_id, dm_msg_id, dm_copy_id, text, media_tag, photo_file_id,
            thumb_file_id, sticker_file_id, sticker_format, visitor_reaction, owner_reaction, created_at
          ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)`
        )
        .bind(rowId, cleanUid, sender, caption, fileId, thumbFileId, createdAt)
    );
    migratedMessages += 1;
  }

  // 3. Migrate non-bubble or older `pmMessageIds` entries (`pm:*`), oldest -> newest
  const olderPmChronological = [...kvPmIds].reverse();
  for (let i = 0; i < olderPmChronological.length; i += 1) {
    const pm = olderPmChronological[i];
    const pmId = toNullablePositiveInt(pm?.id);
    if (!pmId || matchedPmIds.has(pmId)) continue;
    matchedPmIds.add(pmId);

    const createdAt = parseTimestampMs(null, pm?.at, FALLBACK_MIGRATION_TS - 100_000 + i);
    const rowId = `pm:${createdAt}_${pmId}_${i}`;
    if (seenInCurrentKv.has(rowId)) continue;
    seenInCurrentKv.add(rowId);
    if (existingIds.has(rowId)) continue;

    const sender = pm?.sender === 'admin' ? 'admin' : 'visitor';
    const topicMsgId = toNullablePositiveInt(pm?.topicMsgId);
    const topicCopyId = toNullablePositiveInt(pm?.topicCopyId);
    const topicThreadId = toNullablePositiveInt(pm?.topicThreadId);
    const hasTopicCopy = Boolean(topicCopyId && topicThreadId);
    const topicChatId =
      pm?.topicChatId !== null && pm?.topicChatId !== undefined && String(pm.topicChatId).trim()
        ? String(pm.topicChatId).trim()
        : null;
    const dmMsgId = toNullablePositiveInt(pm?.dmMsgId);
    const dmCopyId = toNullablePositiveInt(pm?.dmCopyId);

    writeStmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO messages (
            id, uid, sender, pm_message_id, topic_msg_id, topic_copy_id, topic_thread_id,
            topic_chat_id, dm_msg_id, dm_copy_id, text, media_tag, photo_file_id,
            thumb_file_id, sticker_file_id, sticker_format, visitor_reaction, owner_reaction, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`
        )
        .bind(
          rowId,
          cleanUid,
          sender,
          pmId,
          topicMsgId,
          hasTopicCopy ? topicCopyId : null,
          hasTopicCopy ? topicThreadId : null,
          topicChatId,
          dmMsgId,
          dmCopyId,
          createdAt
        )
    );
    migratedMessages += 1;
  }

  // 4. Migrate `links` oldest -> newest so `ORDER BY created_at DESC, rowid DESC` matches KV order
  const linksChronological = [...kvLinks].reverse();
  const seenLinkKeys = new Set(existingLinkKeys);
  for (let i = 0; i < linksChronological.length; i += 1) {
    const l = linksChronological[i];
    if (!l?.url) continue;
    const url = String(l.url);
    const createdAt = parseTimestampMs(l.at, null, FALLBACK_MIGRATION_TS - 50_000 + i);
    const linkMsgId = typeof l.id === 'string' && l.id ? l.id : `l_mig_${createdAt}_${i}`;
    const dedupKey = `${linkMsgId}|${url}`;
    if (seenLinkKeys.has(dedupKey)) continue;
    seenLinkKeys.add(dedupKey);

    const snippet = l.snippet ? String(l.snippet).slice(0, 90) : null;
    const sender = l.sender === 'admin' ? 'admin' : 'visitor';

    writeStmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO message_links (message_id, uid, url, snippet, sender, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(linkMsgId, cleanUid, url, snippet, sender, createdAt)
    );
    migratedLinks += 1;
  }

  // 5. Execute in bounded chunks, marking `migrated_visitors` ONLY at the end of the final batch
  const markStmt = db
    .prepare(`INSERT OR IGNORE INTO migrated_visitors (uid, migrated_at) VALUES (?, ?)`)
    .bind(cleanUid, nowMs);

  if (writeStmts.length === 0) {
    await markStmt.run();
    queriesUsed += 1;
  } else {
    for (let offset = 0; offset < writeStmts.length; offset += D1_BATCH_CHUNK_SIZE) {
      const chunk = writeStmts.slice(offset, offset + D1_BATCH_CHUNK_SIZE);
      if (offset + D1_BATCH_CHUNK_SIZE >= writeStmts.length) {
        chunk.push(markStmt);
      }
      await db.batch(chunk);
      queriesUsed += 1;
    }
  }

  memSet.add(cleanUid);
  return {
    ok: true,
    uid: cleanUid,
    alreadyMigrated: false,
    migratedMessages,
    migratedLinks,
    queriesUsed,
  };
}

export async function ensureVisitorMigrated(env, uid) {
  if (!env?.DB) return;
  const cleanUid = String(uid || '').trim();
  if (!/^\d+$/.test(cleanUid)) return;
  if (getMigratedSet(env.DB).has(cleanUid)) return;
  await migrateVisitor(env, cleanUid);
}

async function listKvPrefixUids(kv, prefix) {
  const found = [];
  if (!kv || typeof kv.list !== 'function') return found;
  let cursor = undefined;
  for (let page = 0; page < KV_LIST_MAX_PAGES; page += 1) {
    let listed;
    try {
      listed = await kv.list(cursor ? { prefix, limit: 1000, cursor } : { prefix, limit: 1000 });
    } catch {
      break;
    }
    for (const k of listed?.keys || []) {
      const uid = String(k?.name || '').slice(prefix.length);
      if (/^\d+$/.test(uid)) {
        found.push(uid);
      }
    }
    if (!listed || listed.list_complete || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return found;
}

async function discoverVisitorMigrationSet(env) {
  const db = env?.DB;
  const kv = env?.TOPIC_MAP || null;
  const schemaWasCached = isSchemaInitialized(env);
  await ensureSchema(env);
  const queriesUsed = (schemaWasCached ? 0 : 1) + 1;

  const [indexedRaw, historyUids, userUids, migratedRes] = await Promise.all([
    kv ? safeGetJSON(kv, 'visitors:index', []) : Promise.resolve([]),
    listKvPrefixUids(kv, 'history:'),
    listKvPrefixUids(kv, 'user:'),
    db.prepare(`SELECT uid FROM migrated_visitors`).all(),
  ]);

  const migratedSet = new Set();
  const memSet = getMigratedSet(db);
  for (const r of migratedRes?.results || []) {
    const uid = String(r?.uid || '').trim();
    if (/^\d+$/.test(uid)) {
      migratedSet.add(uid);
      memSet.add(uid);
    }
  }

  const allSet = new Set();
  for (const id of Array.isArray(indexedRaw) ? indexedRaw : []) {
    const uid = String(id || '').trim();
    if (/^\d+$/.test(uid)) allSet.add(uid);
  }
  for (const uid of historyUids) allSet.add(uid);
  for (const uid of userUids) allSet.add(uid);
  for (const uid of migratedSet) allSet.add(uid);

  const allUids = Array.from(allSet);
  const pendingUids = allUids.filter((u) => !migratedSet.has(u));
  return {
    allUids,
    migratedSet,
    pendingUids,
    queriesUsed,
  };
}

export async function getStorageStatus(env) {
  if (!env?.DB) {
    return {
      ok: true,
      mode: 'kv',
      d1Bound: false,
      done: 0,
      total: 0,
      finished: true,
    };
  }

  const { allUids, pendingUids } = await discoverVisitorMigrationSet(env);
  const total = allUids.length;
  const done = total - pendingUids.length;
  return {
    ok: true,
    mode: 'd1',
    d1Bound: true,
    done,
    total,
    finished: pendingUids.length === 0,
  };
}

export async function migrateVisitorsBatch(env, options = {}) {
  if (!env?.DB) {
    return {
      ok: false,
      mode: 'kv',
      d1Bound: false,
      error: '当前尚未绑定 D1 数据库（绑定名 DB），仍处于 KV 存储模式',
    };
  }

  const requestedSize = Number(options?.batchSize);
  const batchSize =
    Number.isInteger(requestedSize) && requestedSize > 0
      ? Math.min(requestedSize, MAX_MIGRATE_BATCH_SIZE)
      : DEFAULT_MIGRATE_BATCH_SIZE;

  const requestedBudget = Number(options?.queryBudget);
  const queryBudget =
    Number.isInteger(requestedBudget) && requestedBudget > 0 ? requestedBudget : MIGRATE_QUERY_BUDGET;

  const { allUids, pendingUids, queriesUsed: discoverQueries } = await discoverVisitorMigrationSet(env);
  const candidates = pendingUids.slice(0, batchSize);
  let queriesUsed = discoverQueries;
  let batchMigrated = 0;

  for (const uid of candidates) {
    // Always migrate at least 1 visitor when `candidates` is non-empty so a large visitor never stalls;
    // afterwards, stop before starting the next visitor if remaining budget cannot cover a 2-query visitor.
    if (batchMigrated > 0 && queriesUsed + 2 > queryBudget) {
      break;
    }
    const res = await migrateVisitor(env, uid, { skipMigratedCheck: true });
    queriesUsed += Number(res.queriesUsed || 0);
    batchMigrated += 1;
  }

  const total = allUids.length;
  const remaining = pendingUids.length - batchMigrated;
  const done = total - remaining;

  return {
    ok: true,
    mode: 'd1',
    d1Bound: true,
    batchMigrated,
    queriesUsed,
    done,
    total,
    finished: remaining <= 0,
  };
}
