// Cloudflare D1 implementation of the chat history, mappings, visitors, rate limits & visit stats store.
// Unifies `messages`, `photos`, and `pmMessageIds` into `messages` (+ `message_links` for URLs),
// stores visitor profiles in `visitors`, atomic rate limits in `rate_limits`, monthly visits in `visit_seen`,
// reconstructs the exact v1.11.0 response structures, and never deletes legacy KV keys.

import { CHAT_RETENTION_DAYS_OPTIONS, normalizeChatRetentionDays, safeGetJSON } from '../config.js';
import { ensureSchema, getD1SinceMs } from './d1Schema.js';
import {
  DM_MAP_TTL_SECONDS,
  MAX_MESSAGES,
  TOPIC_MSG_MAP_TTL_SECONDS,
  matchRecallEntryInPmList,
  readKvDmMapEntry,
  readKvTopicMapEntry,
} from './kvStore.js';
import { ensureVisitorsBackfilled, isVisitorsBackfilled, serializeVisitorRow } from './migrate.js';

const VISITOR_OVERVIEW_CACHE_META_KEY = 'visitor_overview_cache';
const VISIT_D1_SINCE_META_KEY = 'visit_d1_since';
const visitD1SinceCache = new WeakMap();

async function ensureVisitD1SinceMonth(env, currentMonthKey) {
  const db = env?.DB;
  if (!db) return currentMonthKey;
  if (visitD1SinceCache.has(db)) {
    return visitD1SinceCache.get(db);
  }
  await ensureSchema(env);
  const res = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).bind(VISIT_D1_SINCE_META_KEY, currentMonthKey),
    db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(VISIT_D1_SINCE_META_KEY),
  ]);
  const stored = String(res?.[1]?.results?.[0]?.value || currentMonthKey).trim();
  const valid = /^\d{6}$/.test(stored) ? stored : currentMonthKey;
  visitD1SinceCache.set(db, valid);
  return valid;
}

function getVisitSeenCutoffMonth(nowMs) {
  // Keep current UTC month + previous 2 UTC months so `thisMonth` & `lastMonth` remain intact
  // across every possible owner timezone offset (UTC-12 .. UTC+14).
  const d = new Date(nowMs);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1 - 2;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  return `${year}${String(month).padStart(2, '0')}`;
}

export const D1_PHOTO_QUERY_LIMIT = 500;
export const D1_LINK_QUERY_LIMIT = 500;
export const D1_PM_QUERY_LIMIT = 1000;
export const MAX_HISTORY_PAGE_LIMIT = 100;
export const DEFAULT_SEARCH_LIMIT = 30;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_SEARCH_QUERY_LEN = 100;
export const RETENTION_DELETE_BATCH_SIZE = 500;
export const RETENTION_MAX_BATCHES_PER_RUN = 5;
export const ALLOWED_CHAT_RETENTION_DAYS = CHAT_RETENTION_DAYS_OPTIONS;
export { normalizeChatRetentionDays };

// Excludes internal archive-only photo rows (`p_*`, `p:*`) and non-bubble PM tracking rows (`pm:*`)
// without using SQL `LIKE` `_` single-character wildcards.
const IS_BUBBLE_ID_SQL = `substr(id, 1, 2) NOT IN ('p_', 'p:') AND substr(id, 1, 3) != 'pm:'`;

let localRowSeq = 0;
function nextLocalSuffix() {
  localRowSeq = (localRowSeq + 1) % 100000;
  return `${Math.floor(Math.random() * 1000)}_${localRowSeq}`;
}

function toNullablePositiveInt(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function escapeLikePattern(raw) {
  return String(raw || '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Note: `messages` has a composite TEXT primary key `(uid, id)`, so `rowid` here is SQLite's
// implicit rowid used strictly as a short-lived same-millisecond pagination tie-breaker.
// SQLite VACUUM can renumber implicit rowids, which is low-risk on D1 (user VACUUM is not exposed)
// and cursors are never persisted across sessions.
function buildHistoryCursors(chronologicalRows = []) {
  if (!chronologicalRows.length) {
    return { oldestCursor: null, newestCursor: null };
  }
  const oldest = chronologicalRows[0];
  const newest = chronologicalRows[chronologicalRows.length - 1];
  const oldestId = Number(oldest.rowid);
  const newestId = Number(newest.rowid);
  return {
    oldestCursor:
      Number.isSafeInteger(oldestId) && oldestId > 0
        ? { ts: Number(oldest.created_at), id: oldestId }
        : null,
    newestCursor:
      Number.isSafeInteger(newestId) && newestId > 0
        ? { ts: Number(newest.created_at), id: newestId }
        : null,
  };
}

export function rowToMessage(row) {
  const msg = {
    id: String(row.id),
    sender: row.sender || 'visitor',
    text: row.text || '',
    mediaTag: row.media_tag || '',
    photoFileId: row.photo_file_id || '',
    thumbFileId: row.thumb_file_id || '',
    ...(row.sticker_file_id
      ? { stickerFileId: String(row.sticker_file_id), stickerFormat: String(row.sticker_format || 'webp') }
      : {}),
    pmMessageId: row.pm_message_id !== null && row.pm_message_id !== undefined ? Number(row.pm_message_id) : null,
    topicMsgId: row.topic_msg_id !== null && row.topic_msg_id !== undefined ? Number(row.topic_msg_id) : null,
    at: new Date(Number(row.created_at)).toISOString(),
  };
  if (row.visitor_reaction) {
    msg.visitorReaction = String(row.visitor_reaction);
  }
  if (row.owner_reaction) {
    msg.ownerReaction = String(row.owner_reaction);
  }
  return msg;
}

export function rowToPhoto(row) {
  return {
    id: String(row.id),
    fileId: String(row.photo_file_id),
    thumbFileId: String(row.thumb_file_id || row.photo_file_id),
    caption: String(row.text || '').slice(0, 140),
    sender: row.sender || 'visitor',
    at: new Date(Number(row.created_at)).toISOString(),
  };
}

export function rowToLink(row) {
  return {
    id: `l_${row.created_at}_${row.rowid}`,
    url: String(row.url),
    snippet: row.snippet ? String(row.snippet) : '',
    sender: row.sender || 'visitor',
    at: new Date(Number(row.created_at)).toISOString(),
  };
}

export function rowToPmEntry(row) {
  if (!row || row.pm_message_id === null || row.pm_message_id === undefined) return null;
  const entry = {
    id: Number(row.pm_message_id),
    topicMsgId: row.topic_msg_id !== null && row.topic_msg_id !== undefined ? Number(row.topic_msg_id) : null,
    sender: row.sender || 'visitor',
    at: Number(row.created_at),
  };
  if (row.dm_msg_id) {
    entry.dmMsgId = Number(row.dm_msg_id);
  }
  if (row.topic_chat_id) {
    entry.topicChatId = String(row.topic_chat_id);
  }
  if (row.dm_copy_id) {
    entry.dmCopyId = Number(row.dm_copy_id);
  }
  if (row.topic_copy_id && row.topic_thread_id) {
    entry.topicCopyId = Number(row.topic_copy_id);
    entry.topicThreadId = Number(row.topic_thread_id);
  }
  return entry;
}

/**
 * Returns true once per UTC day on the 5-minute cron (`00:00`–`00:04` UTC),
 * avoiding any extra KV read/write just to track cleanup timestamps.
 */
export function shouldRunDailyCleanup(nowMs = Date.now()) {
  const ts = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const d = new Date(ts);
  return d.getUTCHours() === 0 && d.getUTCMinutes() < 5;
}

/**
 * Purges expired rows from `topic_map` (>30 days), `dm_map` (>7 days), and `rate_limits`
 * (`expires_at <= nowMs`), and when `retentionDays` is set (`180` or `365`), deletes expired
 * `messages` along with their corresponding `message_links` in bounded batches (`LIMIT 500`
 * per batch, capped at `maxBatches` per daily run so a first-time retention switch
 * never risks hitting Worker CPU or D1 query limits; remaining rows are cleaned up
 * automatically on subsequent days). Never deletes KV backups or `migrated_visitors`.
 * Skips immediately when `env.DB` is not bound.
 */
export async function cleanupExpiredMaps(env, nowMs = Date.now(), options = {}) {
  const db = env?.DB;
  if (!db) {
    return { skipped: true, reason: 'no_d1' };
  }
  await ensureSchema(env);
  const ts = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
  const topicCutoff = ts - TOPIC_MSG_MAP_TTL_SECONDS * 1000;
  const dmCutoff = ts - DM_MAP_TTL_SECONDS * 1000;
  const visitCutoffMonth = getVisitSeenCutoffMonth(ts);

  const mapRes = await db.batch([
    db.prepare(`DELETE FROM topic_map WHERE created_at < ?`).bind(topicCutoff),
    db.prepare(`DELETE FROM dm_map WHERE created_at < ?`).bind(dmCutoff),
    db.prepare(`DELETE FROM rate_limits WHERE expires_at <= ?`).bind(ts),
    db.prepare(`DELETE FROM visit_seen WHERE month < ?`).bind(visitCutoffMonth),
  ]);

  const retentionDays = normalizeChatRetentionDays(options?.retentionDays);
  const rawBatchSize = Number(options?.batchSize);
  const batchSize =
    Number.isInteger(rawBatchSize) && rawBatchSize > 0
      ? Math.min(rawBatchSize, 1000)
      : RETENTION_DELETE_BATCH_SIZE;
  const rawMaxBatches = Number(options?.maxBatches);
  const maxBatches =
    Number.isInteger(rawMaxBatches) && rawMaxBatches > 0
      ? Math.min(rawMaxBatches, 20)
      : RETENTION_MAX_BATCHES_PER_RUN;

  let deletedMessages = 0;
  let deletedLinks = 0;
  let retentionBatches = 0;
  let hasMoreExpired = false;

  if (retentionDays > 0) {
    const msgCutoff = ts - retentionDays * 86400 * 1000;
    for (let i = 0; i < maxBatches; i += 1) {
      const batchRes = await db.batch([
        // 1. Delete message_links belonging to the expired messages batch (uses idx_links_uniq via row-value IN)
        db
          .prepare(
            `DELETE FROM message_links
             WHERE (uid, message_id) IN (
               SELECT uid, id FROM messages
               WHERE created_at < ?
               ORDER BY created_at ASC, rowid ASC
               LIMIT ?
             )`
          )
          .bind(msgCutoff, batchSize),
        // 2. Delete up to `batchSize` oldest expired messages by rowid
        db
          .prepare(
            `DELETE FROM messages
             WHERE rowid IN (
               SELECT rowid FROM messages
               WHERE created_at < ?
               ORDER BY created_at ASC, rowid ASC
               LIMIT ?
             )`
          )
          .bind(msgCutoff, batchSize),
        // 3. Delete up to `batchSize` remaining expired message_links (e.g. migrated legacy `l_*` rows)
        db
          .prepare(
            `DELETE FROM message_links
             WHERE rowid IN (
               SELECT rowid FROM message_links
               WHERE created_at < ?
               ORDER BY created_at ASC, rowid ASC
               LIMIT ?
             )`
          )
          .bind(msgCutoff, batchSize),
      ]);

      const pairedLinkChanges = Number(batchRes?.[0]?.meta?.changes || 0);
      const msgChanges = Number(batchRes?.[1]?.meta?.changes || 0);
      const extraLinkChanges = Number(batchRes?.[2]?.meta?.changes || 0);
      deletedMessages += msgChanges;
      deletedLinks += pairedLinkChanges + extraLinkChanges;
      retentionBatches += 1;

      if (msgChanges < batchSize && extraLinkChanges < batchSize) {
        hasMoreExpired = false;
        break;
      }
      if (i === maxBatches - 1) {
        hasMoreExpired = true;
      }
    }
  }

  return {
    ok: true,
    deletedTopicMaps: Number(mapRes?.[0]?.meta?.changes || 0),
    deletedDmMaps: Number(mapRes?.[1]?.meta?.changes || 0),
    deletedRateLimits: Number(mapRes?.[2]?.meta?.changes || 0),
    deletedVisitSeen: Number(mapRes?.[3]?.meta?.changes || 0),
    retentionDays,
    deletedMessages,
    deletedLinks,
    retentionBatches,
    hasMoreExpired,
  };
}

export function createD1Store(env, hooks = {}) {
  const db = env?.DB;
  const kv = env?.TOPIC_MAP || null;
  const ensureMigrated = typeof hooks.ensureMigrated === 'function' ? hooks.ensureMigrated : null;
  const markMigrated = typeof hooks.markMigrated === 'function' ? hooks.markMigrated : null;

  async function ensureReady(uid = '') {
    await ensureSchema(env);
    if (uid && ensureMigrated) {
      await ensureMigrated(env, uid);
    }
  }

  return {
    mode: 'd1',

    async appendExchange(uid, entry) {
      const cleanUid = String(uid || '');
      if (!db || !/^\d+$/.test(cleanUid)) {
        return { photoCount: 0, linkCount: 0, message: null };
      }
      await ensureReady(cleanUid);

      const {
        sender = 'visitor',
        nowMs = Date.now(),
        nowIso = new Date(nowMs).toISOString(),
        text = '',
        snippet = '',
        mediaTag = '',
        photo = null,
        urls = [],
        stickerInfo = null,
        pmMessageId = null,
        topicMsgId = null,
        dmMsgId = null,
        dmCopyId = null,
        topicCopyId = null,
        topicThreadId = null,
        topicChatId = null,
      } = entry || {};

      const ts = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
      const cleanSender = sender === 'admin' ? 'admin' : 'visitor';
      const cleanText = String(text || '').slice(0, 1500);
      const cleanSnippet = String(snippet || '').slice(0, 90);
      const cleanMediaTag = mediaTag ? String(mediaTag) : '';

      const validPmId = toNullablePositiveInt(pmMessageId);
      const validTopicMsgId = toNullablePositiveInt(topicMsgId);
      const validDmMsgId = toNullablePositiveInt(dmMsgId);
      const validDmCopyId = toNullablePositiveInt(dmCopyId);
      const validTopicCopyId = toNullablePositiveInt(topicCopyId);
      const validTopicThreadId = toNullablePositiveInt(topicThreadId);
      const hasTopicCopy = Boolean(validTopicCopyId && validTopicThreadId);
      const validTopicChatId =
        topicChatId !== null && topicChatId !== undefined && String(topicChatId).trim()
          ? String(topicChatId).trim()
          : null;

      const photoFileId = photo?.fileId ? String(photo.fileId) : null;
      const thumbFileId = photo?.thumbFileId ? String(photo.thumbFileId) : photoFileId;
      const stickerFileId = stickerInfo?.fileId ? String(stickerInfo.fileId) : null;
      const stickerFormat = stickerFileId ? String(stickerInfo?.format || 'webp') : null;

      const hasBubble = Boolean(cleanText || photoFileId || cleanMediaTag || stickerFileId);
      let rowId = '';
      let addedMessage = null;
      const batchStmts = [];

      if (hasBubble || validPmId) {
        const suffix = nextLocalSuffix();
        rowId = hasBubble ? `m_${ts}_${suffix}` : `pm:${ts}_${suffix}`;

        batchStmts.push(
          db
            .prepare(
              `INSERT INTO messages (
                id, uid, sender, pm_message_id, topic_msg_id, topic_copy_id, topic_thread_id,
                topic_chat_id, dm_msg_id, dm_copy_id, text, media_tag, photo_file_id,
                thumb_file_id, sticker_file_id, sticker_format, visitor_reaction, owner_reaction, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
            )
            .bind(
              rowId,
              cleanUid,
              cleanSender,
              validPmId,
              validTopicMsgId,
              hasTopicCopy ? validTopicCopyId : null,
              hasTopicCopy ? validTopicThreadId : null,
              validTopicChatId,
              validDmMsgId,
              validDmCopyId,
              cleanText || null,
              cleanMediaTag || null,
              photoFileId,
              thumbFileId,
              stickerFileId,
              stickerFormat,
              ts
            )
        );

        if (hasBubble) {
          addedMessage = {
            id: rowId,
            sender: cleanSender,
            text: cleanText,
            mediaTag: cleanMediaTag,
            photoFileId: photoFileId || '',
            thumbFileId: thumbFileId || '',
            ...(stickerFileId ? { stickerFileId, stickerFormat } : {}),
            pmMessageId: validPmId,
            topicMsgId: validTopicMsgId,
            at: nowIso,
          };
        }
      }

      if (Array.isArray(urls) && urls.length > 0) {
        const linkMsgId = rowId || `l_${ts}_${nextLocalSuffix()}`;
        for (const url of urls) {
          if (!url) continue;
          batchStmts.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO message_links (message_id, uid, url, snippet, sender, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
              )
              .bind(linkMsgId, cleanUid, String(url), cleanSnippet || null, cleanSender, ts)
          );
        }
      }

      batchStmts.push(
        db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM messages WHERE uid = ? AND photo_file_id IS NOT NULL AND photo_file_id != ''`
          )
          .bind(cleanUid),
        db.prepare(`SELECT COUNT(*) AS cnt FROM message_links WHERE uid = ?`).bind(cleanUid)
      );

      const results = await db.batch(batchStmts);
      const photoCount = Number(results[results.length - 2]?.results?.[0]?.cnt || 0);
      const linkCount = Number(results[results.length - 1]?.results?.[0]?.cnt || 0);

      return {
        photoCount,
        linkCount,
        message: addedMessage,
      };
    },

    async getHistory(uid, options = {}) {
      const cleanUid = String(uid || '');
      const rawLimit = Number(options?.limit);
      const limit =
        Number.isInteger(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, MAX_HISTORY_PAGE_LIMIT)
          : MAX_MESSAGES;
      const messagesOnly = Boolean(options?.messagesOnly);
      const before = toNullablePositiveInt(options?.before);
      const beforeId = toNullablePositiveInt(options?.beforeId);
      const after = toNullablePositiveInt(options?.after);
      const afterId = toNullablePositiveInt(options?.afterId);
      const around = typeof options?.around === 'string' ? options.around.trim().slice(0, 128) : '';

      if (!db || !/^\d+$/.test(cleanUid)) {
        return {
          photos: [],
          links: [],
          pmMessageIds: [],
          messages: [],
          hasMore: false,
          hasNewer: false,
          oldestCursor: null,
          newestCursor: null,
        };
      }
      await ensureReady(cleanUid);

      const buildArchiveStmts = () =>
        messagesOnly
          ? []
          : [
              db
                .prepare(
                  `SELECT id, photo_file_id, thumb_file_id, text, sender, created_at
                   FROM messages
                   WHERE uid = ? AND photo_file_id IS NOT NULL AND photo_file_id != ''
                   ORDER BY created_at DESC, rowid DESC
                   LIMIT ?`
                )
                .bind(cleanUid, D1_PHOTO_QUERY_LIMIT),
              db
                .prepare(
                  `SELECT rowid, message_id, url, snippet, sender, created_at
                   FROM message_links
                   WHERE uid = ?
                   ORDER BY created_at DESC, rowid DESC
                   LIMIT ?`
                )
                .bind(cleanUid, D1_LINK_QUERY_LIMIT),
              db
                .prepare(
                  `SELECT pm_message_id, topic_msg_id, topic_copy_id, topic_thread_id,
                          topic_chat_id, dm_msg_id, dm_copy_id, sender, created_at
                   FROM messages
                   WHERE uid = ? AND pm_message_id IS NOT NULL
                   ORDER BY created_at DESC, rowid DESC
                   LIMIT ?`
                )
                .bind(cleanUid, D1_PM_QUERY_LIMIT),
            ];

      const mapArchives = (results, offset) => {
        if (messagesOnly) {
          return { photos: [], links: [], pmMessageIds: [] };
        }
        return {
          photos: (results[offset]?.results || []).map(rowToPhoto),
          links: (results[offset + 1]?.results || []).map(rowToLink),
          pmMessageIds: (results[offset + 2]?.results || []).map(rowToPmEntry).filter(Boolean),
        };
      };

      // Mode 1: `around=<messageId>` — centered context window for jumping to a search hit.
      // If the message was recalled or cleaned up, fall back gracefully to the latest page.
      let aroundFallback = false;
      if (around) {
        const targetRow = await db
          .prepare(
            `SELECT rowid, * FROM messages
             WHERE uid = ? AND id = ? AND ${IS_BUBBLE_ID_SQL}
             LIMIT 1`
          )
          .bind(cleanUid, around)
          .first();

        if (targetRow) {
          const targetTs = Number(targetRow.created_at);
          const targetRowId = Number(targetRow.rowid);
          const olderLimit = Math.floor((limit - 1) / 2);
          const newerLimit = Math.max(0, limit - 1 - olderLimit);

          const batchStmts = [
            db
              .prepare(
                `SELECT rowid, * FROM messages
                 WHERE uid = ? AND ${IS_BUBBLE_ID_SQL}
                   AND (created_at < ? OR (created_at = ? AND rowid < ?))
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?`
              )
              .bind(cleanUid, targetTs, targetTs, targetRowId, olderLimit + 1),
            db
              .prepare(
                `SELECT rowid, * FROM messages
                 WHERE uid = ? AND ${IS_BUBBLE_ID_SQL}
                   AND (created_at > ? OR (created_at = ? AND rowid > ?))
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT ?`
              )
              .bind(cleanUid, targetTs, targetTs, targetRowId, newerLimit + 1),
            ...buildArchiveStmts(),
          ];

          const results = await db.batch(batchStmts);
          const olderRaw = results[0]?.results || [];
          const newerRaw = results[1]?.results || [];
          const hasMore = olderRaw.length > olderLimit;
          const hasNewer = newerRaw.length > newerLimit;
          const chronologicalRows = [
            ...olderRaw.slice(0, olderLimit).reverse(),
            targetRow,
            ...newerRaw.slice(0, newerLimit),
          ];
          const archives = mapArchives(results, 2);
          return {
            ...archives,
            messages: chronologicalRows.map(rowToMessage),
            hasMore,
            hasNewer,
            ...buildHistoryCursors(chronologicalRows),
            aroundFound: true,
          };
        }
        aroundFallback = true;
      }

      // Mode 2: `before` (+ optional `beforeId` rowid tie-breaker) — load older page
      if (before && !aroundFallback) {
        const msgStmt = beforeId
          ? db
              .prepare(
                `SELECT rowid, * FROM messages
                 WHERE uid = ? AND ${IS_BUBBLE_ID_SQL}
                   AND (created_at < ? OR (created_at = ? AND rowid < ?))
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?`
              )
              .bind(cleanUid, before, before, beforeId, limit + 1)
          : db
              .prepare(
                `SELECT rowid, * FROM messages
                 WHERE uid = ? AND ${IS_BUBBLE_ID_SQL}
                   AND created_at < ?
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?`
              )
              .bind(cleanUid, before, limit + 1);

        const results = await db.batch([msgStmt, ...buildArchiveStmts()]);
        const rawRows = results[0]?.results || [];
        const hasMore = rawRows.length > limit;
        const chronologicalRows = rawRows.slice(0, limit).reverse();
        const archives = mapArchives(results, 1);
        return {
          ...archives,
          messages: chronologicalRows.map(rowToMessage),
          hasMore,
          hasNewer: false,
          ...buildHistoryCursors(chronologicalRows),
        };
      }

      // Mode 3: `after` (+ optional `afterId` rowid tie-breaker) — load newer page from historical view
      if (after && !aroundFallback) {
        const msgStmt = afterId
          ? db
              .prepare(
                `SELECT rowid, * FROM messages
                 WHERE uid = ? AND ${IS_BUBBLE_ID_SQL}
                   AND (created_at > ? OR (created_at = ? AND rowid > ?))
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT ?`
              )
              .bind(cleanUid, after, after, afterId, limit + 1)
          : db
              .prepare(
                `SELECT rowid, * FROM messages
                 WHERE uid = ? AND ${IS_BUBBLE_ID_SQL}
                   AND created_at > ?
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT ?`
              )
              .bind(cleanUid, after, limit + 1);

        const results = await db.batch([msgStmt, ...buildArchiveStmts()]);
        const rawRows = results[0]?.results || [];
        const hasNewer = rawRows.length > limit;
        const chronologicalRows = rawRows.slice(0, limit);
        const archives = mapArchives(results, 1);
        return {
          ...archives,
          messages: chronologicalRows.map(rowToMessage),
          hasMore: false,
          hasNewer,
          ...buildHistoryCursors(chronologicalRows),
        };
      }

      // Mode 4: Latest page (default, or graceful fallback when `around` message was missing)
      const results = await db.batch([
        db
          .prepare(
            `SELECT rowid, * FROM messages
             WHERE uid = ? AND ${IS_BUBBLE_ID_SQL}
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?`
          )
          .bind(cleanUid, limit + 1),
        ...buildArchiveStmts(),
      ]);

      const rawRows = results[0]?.results || [];
      const hasMore = rawRows.length > limit;
      const chronologicalRows = rawRows.slice(0, limit).reverse();
      const archives = mapArchives(results, 1);

      return {
        ...archives,
        messages: chronologicalRows.map(rowToMessage),
        hasMore,
        hasNewer: false,
        ...buildHistoryCursors(chronologicalRows),
        ...(aroundFallback ? { aroundFound: false } : {}),
      };
    },

    async searchMessages(options = {}) {
      if (!db) {
        return { supported: false, mode: 'kv', items: [], hasMore: false, nextCursor: null };
      }
      const trimmedQ = String(options?.q || '').trim();
      if (!trimmedQ || trimmedQ.length > MAX_SEARCH_QUERY_LEN) {
        return { supported: true, mode: 'd1', items: [], hasMore: false, nextCursor: null };
      }

      const rawLimit = Number(options?.limit);
      const limit =
        Number.isInteger(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, MAX_SEARCH_LIMIT)
          : DEFAULT_SEARCH_LIMIT;

      const cleanUid = String(options?.uid || '').trim();
      const fromMs = toNullablePositiveInt(options?.from);
      const toMs = toNullablePositiveInt(options?.to);
      const before = toNullablePositiveInt(options?.before);
      const beforeId = toNullablePositiveInt(options?.beforeId);

      await ensureSchema(env);
      if (/^\d+$/.test(cleanUid) && ensureMigrated) {
        await ensureMigrated(env, cleanUid);
      }

      const pattern = `%${escapeLikePattern(trimmedQ)}%`;
      const clauses = [IS_BUBBLE_ID_SQL, `(text LIKE ? ESCAPE '\\' OR media_tag LIKE ? ESCAPE '\\')`];
      const binds = [pattern, pattern];

      if (/^\d+$/.test(cleanUid)) {
        clauses.push(`uid = ?`);
        binds.push(cleanUid);
      }
      if (fromMs) {
        clauses.push(`created_at >= ?`);
        binds.push(fromMs);
      }
      if (toMs) {
        clauses.push(`created_at <= ?`);
        binds.push(toMs);
      }
      if (before) {
        if (beforeId) {
          clauses.push(`(created_at < ? OR (created_at = ? AND rowid < ?))`);
          binds.push(before, before, beforeId);
        } else {
          clauses.push(`created_at < ?`);
          binds.push(before);
        }
      }

      binds.push(limit + 1);
      const res = await db
        .prepare(
          `SELECT rowid, id, uid, sender, pm_message_id, text, media_tag,
                  photo_file_id, sticker_file_id, created_at
           FROM messages
           WHERE ${clauses.join(' AND ')}
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`
        )
        .bind(...binds)
        .all();

      const rawRows = res?.results || [];
      const hasMore = rawRows.length > limit;
      const rows = rawRows.slice(0, limit);
      const items = rows.map((row) => ({
        id: String(row.id),
        uid: String(row.uid),
        sender: row.sender || 'visitor',
        text: row.text || '',
        mediaTag: row.media_tag || '',
        hasPhoto: Boolean(row.photo_file_id),
        hasSticker: Boolean(row.sticker_file_id),
        pmMessageId:
          row.pm_message_id !== null && row.pm_message_id !== undefined ? Number(row.pm_message_id) : null,
        at: new Date(Number(row.created_at)).toISOString(),
        createdAt: Number(row.created_at),
      }));

      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
      const nextCursor =
        hasMore && lastRow && Number.isSafeInteger(Number(lastRow.rowid)) && Number(lastRow.rowid) > 0
          ? { before: Number(lastRow.created_at), beforeId: Number(lastRow.rowid) }
          : null;

      return {
        supported: true,
        mode: 'd1',
        items,
        hasMore,
        nextCursor,
      };
    },

    async findPmEntry(uid, pmMessageId) {
      const cleanUid = String(uid || '').trim();
      const pmId = Number(pmMessageId);
      if (!db || !/^\d+$/.test(cleanUid) || !Number.isInteger(pmId) || pmId <= 0) return null;
      await ensureReady(cleanUid);

      const row = await db
        .prepare(
          `SELECT pm_message_id, topic_msg_id, topic_copy_id, topic_thread_id,
                  topic_chat_id, dm_msg_id, dm_copy_id, sender, created_at
           FROM messages
           WHERE uid = ? AND pm_message_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`
        )
        .bind(cleanUid, pmId)
        .first();
      return row ? rowToPmEntry(row) : null;
    },

    async findAdminMessageForRecall(uid, criteria = {}) {
      const cleanUid = String(uid || '').trim();
      if (!db || !/^\d+$/.test(cleanUid)) return null;
      await ensureReady(cleanUid);

      const res = await db
        .prepare(
          `SELECT pm_message_id, topic_msg_id, topic_copy_id, topic_thread_id,
                  topic_chat_id, dm_msg_id, dm_copy_id, sender, created_at
           FROM messages
           WHERE uid = ? AND pm_message_id IS NOT NULL
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`
        )
        .bind(cleanUid, D1_PM_QUERY_LIMIT)
        .all();
      const list = (res?.results || []).map(rowToPmEntry).filter(Boolean);
      return matchRecallEntryInPmList(list, criteria);
    },

    async findLatestVisitorTopicCopy(uid, threadId) {
      const cleanUid = String(uid || '');
      const tid = Number(threadId);
      if (!db || !/^\d+$/.test(cleanUid) || !Number.isInteger(tid) || tid <= 0) return null;
      await ensureReady(cleanUid);

      const row = await db
        .prepare(
          `SELECT topic_copy_id FROM messages
           WHERE uid = ? AND sender = 'visitor' AND topic_thread_id = ? AND topic_copy_id > 0
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`
        )
        .bind(cleanUid, tid)
        .first();
      return row?.topic_copy_id ? { topicMsgId: Number(row.topic_copy_id) } : null;
    },

    async attachTopicMirror(uid, pmMessageId, topicMsgId, topicChatId) {
      const cleanUid = String(uid || '');
      const pmId = Number(pmMessageId);
      const topicId = Number(topicMsgId);
      if (!db || !/^\d+$/.test(cleanUid) || !(pmId > 0) || !(topicId > 0)) return true;
      await ensureReady(cleanUid);

      const existing = await db
        .prepare(`SELECT id FROM messages WHERE uid = ? AND pm_message_id = ? AND sender = 'admin' LIMIT 1`)
        .bind(cleanUid, pmId)
        .first();
      if (!existing) return false;

      const validChatId =
        topicChatId !== null && topicChatId !== undefined && String(topicChatId).trim()
          ? String(topicChatId).trim()
          : null;
      if (validChatId) {
        await db
          .prepare(
            `UPDATE messages
             SET topic_msg_id = ?, topic_chat_id = ?
             WHERE uid = ? AND pm_message_id = ? AND sender = 'admin'`
          )
          .bind(topicId, validChatId, cleanUid, pmId)
          .run();
      } else {
        await db
          .prepare(
            `UPDATE messages
             SET topic_msg_id = ?
             WHERE uid = ? AND pm_message_id = ? AND sender = 'admin'`
          )
          .bind(topicId, cleanUid, pmId)
          .run();
      }
      return true;
    },

    async removeAdminMessage(uid, pmMessageId) {
      const cleanUid = String(uid || '');
      const targetId = Number(pmMessageId);
      if (!db || !/^\d+$/.test(cleanUid) || !Number.isFinite(targetId) || targetId <= 0) {
        return { removed: false, photoCount: 0, linkCount: 0 };
      }
      await ensureReady(cleanUid);

      const matchedRes = await db
        .prepare(`SELECT id, created_at FROM messages WHERE uid = ? AND pm_message_id = ? AND sender != 'visitor'`)
        .bind(cleanUid, targetId)
        .all();
      const matchedRows = matchedRes?.results || [];
      const bubbleRow =
        matchedRows.find((r) => {
          const rid = String(r.id);
          return !rid.startsWith('p_') && !rid.startsWith('p:') && !rid.startsWith('pm:');
        }) || null;

      const stmts = [
        db
          .prepare(`DELETE FROM messages WHERE uid = ? AND pm_message_id = ? AND sender != 'visitor'`)
          .bind(cleanUid, targetId),
      ];

      for (const row of matchedRows) {
        stmts.push(
          db
            .prepare(
              `DELETE FROM message_links
               WHERE uid = ? AND (message_id = ? OR (sender = 'admin' AND created_at = ?))`
            )
            .bind(cleanUid, String(row.id), Number(row.created_at))
        );
      }

      stmts.push(
        db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM messages WHERE uid = ? AND photo_file_id IS NOT NULL AND photo_file_id != ''`
          )
          .bind(cleanUid),
        db.prepare(`SELECT COUNT(*) AS cnt FROM message_links WHERE uid = ?`).bind(cleanUid)
      );

      const results = await db.batch(stmts);
      const photoCount = Number(results[results.length - 2]?.results?.[0]?.cnt || 0);
      const linkCount = Number(results[results.length - 1]?.results?.[0]?.cnt || 0);

      return {
        removed: Boolean(bubbleRow),
        photoCount,
        linkCount,
      };
    },

    async setReaction(uid, pmMessageId, role, value = '') {
      const cleanUid = String(uid || '').trim();
      const pmId = Number(pmMessageId);
      if (!db || !/^\d+$/.test(cleanUid) || !Number.isInteger(pmId) || pmId <= 0) return false;
      await ensureReady(cleanUid);

      const col = role === 'owner' ? 'owner_reaction' : 'visitor_reaction';
      const target = await db
        .prepare(
          `SELECT id, ${col} AS prev_val FROM messages
           WHERE uid = ? AND pm_message_id = ? AND ${IS_BUBBLE_ID_SQL}
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`
        )
        .bind(cleanUid, pmId)
        .first();
      if (!target) return false;

      const cleanVal = String(value || '').trim().slice(0, 16);
      const prevVal = String(target.prev_val || '');
      if (prevVal === cleanVal) return false;

      await db
        .prepare(`UPDATE messages SET ${col} = ? WHERE uid = ? AND id = ?`)
        .bind(cleanVal || null, cleanUid, String(target.id))
        .run();
      return true;
    },

    async clearHistory(uid) {
      const cleanUid = String(uid || '');
      if (!db || !/^\d+$/.test(cleanUid)) return;
      await ensureSchema(env);
      const now = Date.now();
      // Never delete `history:{uid}` in KV (kept as backup until after v2.2);
      // record `uid` in `migrated_visitors` so cleared KV history is never re-imported into D1.
      await db.batch([
        db.prepare(`DELETE FROM messages WHERE uid = ?`).bind(cleanUid),
        db.prepare(`DELETE FROM message_links WHERE uid = ?`).bind(cleanUid),
        db.prepare(`INSERT OR REPLACE INTO migrated_visitors (uid, migrated_at) VALUES (?, ?)`).bind(cleanUid, now),
      ]);
      if (markMigrated) {
        markMigrated(env, cleanUid);
      }
    },

    async putTopicMap(groupId, topicMsgId, uid, pmId) {
      const tid = Number(topicMsgId);
      const cleanUid = String(uid || '').trim();
      const visitorPmId = Number(pmId);
      const gid = String(groupId ?? '').trim();
      if (!db || !gid || !Number.isInteger(tid) || tid <= 0 || !/^\d+$/.test(cleanUid) || !(visitorPmId > 0)) {
        return;
      }
      await ensureSchema(env);
      await db
        .prepare(
          `INSERT OR REPLACE INTO topic_map (group_id, topic_msg_id, uid, pm_message_id, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(gid, tid, cleanUid, visitorPmId, Date.now())
        .run();
    },

    async getTopicMap(groupId, topicMsgId, nowMs = Date.now()) {
      const tid = Number(topicMsgId);
      const gid = String(groupId ?? '').trim();
      if (!db || !gid || !Number.isInteger(tid) || tid <= 0) return null;
      await ensureSchema(env);

      const ts = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
      const row = await db
        .prepare(`SELECT uid, pm_message_id, created_at FROM topic_map WHERE group_id = ? AND topic_msg_id = ?`)
        .bind(gid, tid)
        .first();
      if (row) {
        const minCreatedAt = ts - TOPIC_MSG_MAP_TTL_SECONDS * 1000;
        if (Number(row.created_at) < minCreatedAt) return null;
        const uid = String(row.uid || '').trim();
        const pmId = Number(row.pm_message_id);
        if (!/^\d+$/.test(uid) || !Number.isInteger(pmId) || pmId <= 0) return null;
        return { uid, pmMessageId: pmId };
      }

      // Time-gated KV fallback: only read legacy KV `tmsg:*` within 30 days of D1 initialization
      // so users upgrading straight from v1.11 never lose recent mappings; stops automatically after 30d.
      if (kv) {
        const d1Since = await getD1SinceMs(env);
        if (d1Since > 0 && ts < d1Since + TOPIC_MSG_MAP_TTL_SECONDS * 1000) {
          return readKvTopicMapEntry(kv, gid, tid);
        }
      }
      return null;
    },

    async putDmMap(ownerMsgId, uid, pmId = null) {
      const msgId = Number(ownerMsgId);
      const cleanUid = String(uid || '').trim();
      if (!db || !Number.isFinite(msgId) || msgId <= 0 || !/^\d+$/.test(cleanUid)) return;
      const validPmId = toNullablePositiveInt(pmId);
      await ensureSchema(env);
      await db
        .prepare(
          `INSERT OR REPLACE INTO dm_map (owner_msg_id, uid, pm_message_id, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .bind(Math.trunc(msgId), cleanUid, validPmId, Date.now())
        .run();
    },

    async getDmMap(ownerMsgId, nowMs = Date.now()) {
      const msgId = Number(ownerMsgId);
      if (!db || !Number.isFinite(msgId) || msgId <= 0) return null;
      await ensureSchema(env);

      const ts = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
      const row = await db
        .prepare(`SELECT uid, pm_message_id, created_at FROM dm_map WHERE owner_msg_id = ?`)
        .bind(Math.trunc(msgId))
        .first();
      if (row) {
        const minCreatedAt = ts - DM_MAP_TTL_SECONDS * 1000;
        if (Number(row.created_at) < minCreatedAt) return null;
        const uid = String(row.uid || '').trim();
        if (!/^\d+$/.test(uid)) return null;
        const pmId = toNullablePositiveInt(row.pm_message_id);
        return { uid, pmMessageId: pmId };
      }

      // Time-gated KV fallback: only read legacy KV `dmmap:*` within 7 days of D1 initialization
      // so DM quote-replies & reactions keep working across upgrades; stops automatically after 7d.
      if (kv) {
        const d1Since = await getD1SinceMs(env);
        if (d1Since > 0 && ts < d1Since + DM_MAP_TTL_SECONDS * 1000) {
          return readKvDmMapEntry(kv, msgId);
        }
      }
      return null;
    },

    async getVisitor(uid) {
      const cleanUid = String(uid || '').trim();
      if (!db || !/^\d+$/.test(cleanUid)) return null;
      await ensureSchema(env);

      const row = await db.prepare(`SELECT data FROM visitors WHERE uid = ?`).bind(cleanUid).first();
      if (row?.data) {
        try {
          const parsed = JSON.parse(row.data);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {
          return null;
        }
      }

      // Lazy single-visitor KV -> D1 fallback before the one-time visitors backfill has completed
      if (kv && !(await isVisitorsBackfilled(env))) {
        const kvRec = await safeGetJSON(kv, `user:${cleanUid}`, null);
        if (kvRec && typeof kvRec === 'object') {
          const serialized = serializeVisitorRow(cleanUid, kvRec);
          await db
            .prepare(
              `INSERT OR IGNORE INTO visitors (uid, data, last_seen_at, source, updated_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .bind(
              serialized.uid,
              serialized.data,
              serialized.lastSeenAt,
              serialized.source,
              serialized.updatedAt
            )
            .run()
            .catch(() => {});
          return { ...kvRec, userId: cleanUid };
        }
      }
      return null;
    },

    async putVisitor(uid, record) {
      const cleanUid = String(uid || '').trim();
      if (!db || !/^\d+$/.test(cleanUid) || !record || typeof record !== 'object') return;
      await ensureSchema(env);
      const serialized = serializeVisitorRow(cleanUid, record);
      await db
        .prepare(
          `INSERT INTO visitors (uid, data, last_seen_at, source, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(uid) DO UPDATE SET
             data = excluded.data,
             last_seen_at = excluded.last_seen_at,
             source = excluded.source,
             updated_at = excluded.updated_at`
        )
        .bind(
          serialized.uid,
          serialized.data,
          serialized.lastSeenAt,
          serialized.source,
          serialized.updatedAt
        )
        .run();
    },

    async getVisitorsByUids(uids = []) {
      const map = new Map();
      if (!db || !Array.isArray(uids) || uids.length === 0) return map;
      const cleanUids = Array.from(new Set(uids.map((u) => String(u || '').trim()).filter((u) => /^\d+$/.test(u))));
      if (cleanUids.length === 0) return map;
      await ensureSchema(env);

      for (let i = 0; i < cleanUids.length; i += 80) {
        const slice = cleanUids.slice(i, i + 80);
        const placeholders = slice.map(() => '?').join(', ');
        const res = await db
          .prepare(`SELECT uid, data FROM visitors WHERE uid IN (${placeholders})`)
          .bind(...slice)
          .all();
        for (const row of res?.results || []) {
          if (!row?.uid || !row?.data) continue;
          try {
            const parsed = JSON.parse(row.data);
            if (parsed && typeof parsed === 'object') {
              map.set(String(row.uid), parsed);
            }
          } catch {
            // Skip malformed row
          }
        }
      }

      const missing = cleanUids.filter((u) => !map.has(u));
      if (missing.length > 0 && kv && !(await isVisitorsBackfilled(env))) {
        const kvRecs = await Promise.all(missing.map((u) => safeGetJSON(kv, `user:${u}`, null)));
        const insertStmts = [];
        const nowMs = Date.now();
        for (let i = 0; i < missing.length; i += 1) {
          const kvRec = kvRecs[i];
          if (!kvRec || typeof kvRec !== 'object') continue;
          const uid = missing[i];
          const serialized = serializeVisitorRow(uid, kvRec, nowMs);
          map.set(uid, { ...kvRec, userId: uid });
          insertStmts.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO visitors (uid, data, last_seen_at, source, updated_at)
                 VALUES (?, ?, ?, ?, ?)`
              )
              .bind(
                serialized.uid,
                serialized.data,
                serialized.lastSeenAt,
                serialized.source,
                serialized.updatedAt
              )
          );
        }
        if (insertStmts.length > 0) {
          await db.batch(insertStmts).catch(() => {});
        }
      }
      return map;
    },

    async listVisitorRecords(options = {}) {
      if (!db) return { rows: [], totalCount: 0 };
      const rawLimit = Number(options?.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 120;
      await ensureSchema(env);
      await ensureVisitorsBackfilled(env);

      const [rowsRes, countRes] = await db.batch([
        db
          .prepare(
            `SELECT uid, data FROM visitors
             ORDER BY last_seen_at DESC, updated_at DESC, uid DESC
             LIMIT ?`
          )
          .bind(limit),
        db.prepare(`SELECT COUNT(*) AS cnt FROM visitors`),
      ]);

      const rows = [];
      for (const row of rowsRes?.results || []) {
        const uid = String(row?.uid || '').trim();
        if (!/^\d+$/.test(uid)) continue;
        let record = { userId: uid };
        if (row?.data) {
          try {
            const parsed = JSON.parse(row.data);
            if (parsed && typeof parsed === 'object') {
              record = { ...parsed, userId: uid };
            }
          } catch {
            // Fall back to minimal record
          }
        }
        rows.push({ uid, record });
      }
      const totalCount = Math.max(rows.length, Number(countRes?.results?.[0]?.cnt || 0));
      return { rows, totalCount };
    },

    async getVisitorOverviewCache(maxAgeMs) {
      if (!db) return null;
      await ensureSchema(env);
      const row = await db
        .prepare(`SELECT value FROM meta WHERE key = ?`)
        .bind(VISITOR_OVERVIEW_CACHE_META_KEY)
        .first();
      if (!row?.value) return null;
      try {
        const parsed = JSON.parse(row.value);
        if (
          parsed &&
          parsed.stats &&
          typeof parsed.stats.pendingReview === 'number' &&
          Array.isArray(parsed.sourceStats) &&
          Date.now() - Number(parsed.cachedAt || 0) < maxAgeMs
        ) {
          return parsed;
        }
      } catch {
        // Ignore corrupt cache
      }
      return null;
    },

    async putVisitorOverviewCache(payload) {
      if (!db || !payload || typeof payload !== 'object') return;
      await ensureSchema(env);
      await db
        .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
        .bind(VISITOR_OVERVIEW_CACHE_META_KEY, JSON.stringify(payload))
        .run();
    },

    async invalidateVisitorOverviewCache() {
      if (!db) return;
      await ensureSchema(env);
      await db.prepare(`DELETE FROM meta WHERE key = ?`).bind(VISITOR_OVERVIEW_CACHE_META_KEY).run();
    },

    async checkRateLimit(key, limit = 40, windowSec = 60, nowMs = Date.now()) {
      const cleanKey = String(key || '').trim();
      const maxLimit = Number(limit);
      if (!cleanKey || !db) return true;
      if (!Number.isFinite(maxLimit) || maxLimit <= 0) return false;
      await ensureSchema(env);

      const ts = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
      const winSec = Math.max(1, Math.trunc(Number.isFinite(Number(windowSec)) ? Number(windowSec) : 60));
      const expiresAt = ts + winSec * 1000;

      const row = await db
        .prepare(
          `INSERT INTO rate_limits (key, count, expires_at)
           VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET
             count = CASE
               WHEN rate_limits.expires_at <= ? THEN 1
               WHEN rate_limits.count <= ? THEN rate_limits.count + 1
               ELSE rate_limits.count
             END,
             expires_at = CASE
               WHEN rate_limits.expires_at <= ? THEN excluded.expires_at
               ELSE rate_limits.expires_at
             END
           RETURNING count`
        )
        .bind(cleanKey, expiresAt, ts, maxLimit, ts)
        .first();

      return Number(row?.count || 0) <= maxLimit;
    },

    async recordMonthlyVisit(monthKey, uid) {
      const cleanMonth = String(monthKey || '').trim();
      const cleanUid = String(uid ?? '').trim();
      if (!db || !/^\d{6}$/.test(cleanMonth) || !/^\d+$/.test(cleanUid)) {
        return { recorded: false };
      }
      const d1SinceMonth = await ensureVisitD1SinceMonth(env, cleanMonth);

      // During the upgrade transition month (`cleanMonth <= d1SinceMonth`), check D1 first (0 KV reads
      // on repeat visits), then check KV `visit:seen:*` once for unseen UIDs so returning visitors
      // already counted in KV `visit:count:*` are inserted directly with `in_kv = 1` (never double-counted).
      if (kv && cleanMonth <= d1SinceMonth) {
        const existing = await db
          .prepare(`SELECT 1 AS ok FROM visit_seen WHERE month = ? AND uid = ?`)
          .bind(cleanMonth, cleanUid)
          .first();
        if (existing) {
          return { recorded: false, monthKey: cleanMonth };
        }
        const alreadyInKv = Boolean(await kv.get(`visit:seen:${cleanMonth}:${cleanUid}`));
        const res = await db
          .prepare(`INSERT OR IGNORE INTO visit_seen (month, uid, in_kv) VALUES (?, ?, ?)`)
          .bind(cleanMonth, cleanUid, alreadyInKv ? 1 : 0)
          .run();
        return {
          recorded: !alreadyInKv && Number(res?.meta?.changes || 0) > 0,
          monthKey: cleanMonth,
        };
      }

      const res = await db
        .prepare(`INSERT OR IGNORE INTO visit_seen (month, uid, in_kv) VALUES (?, ?, 0)`)
        .bind(cleanMonth, cleanUid)
        .run();
      return {
        recorded: Number(res?.meta?.changes || 0) > 0,
        monthKey: cleanMonth,
      };
    },

    async getMonthlyVisitCounts(thisMonthKey, lastMonthKey = null) {
      const cleanThis = String(thisMonthKey || '').trim();
      const cleanLast = lastMonthKey ? String(lastMonthKey).trim() : '';
      if (!db || !/^\d{6}$/.test(cleanThis)) {
        return cleanLast ? { thisMonth: 0, lastMonth: 0 } : { thisMonth: 0 };
      }
      const d1SinceMonth = await ensureVisitD1SinceMonth(env, cleanThis);

      const needKvThis = Boolean(kv && cleanThis <= d1SinceMonth);
      const needKvLast = Boolean(kv && cleanLast && cleanLast <= d1SinceMonth);

      if (!cleanLast) {
        const [d1Row, kvThis] = await Promise.all([
          db.prepare(`SELECT COUNT(*) AS cnt FROM visit_seen WHERE month = ? AND in_kv = 0`).bind(cleanThis).first(),
          needKvThis ? safeGetJSON(kv, `visit:count:${cleanThis}`, null) : Promise.resolve(null),
        ]);
        const d1Count = Math.max(0, Number(d1Row?.cnt) || 0);
        const kvCount = Math.max(0, Number(kvThis?.n) || 0);
        return { thisMonth: kvCount + d1Count };
      }

      const [d1Res, kvThis, kvLast] = await Promise.all([
        db
          .prepare(`SELECT month, COUNT(*) AS cnt FROM visit_seen WHERE month IN (?, ?) AND in_kv = 0 GROUP BY month`)
          .bind(cleanThis, cleanLast)
          .all(),
        needKvThis ? safeGetJSON(kv, `visit:count:${cleanThis}`, null) : Promise.resolve(null),
        needKvLast ? safeGetJSON(kv, `visit:count:${cleanLast}`, null) : Promise.resolve(null),
      ]);

      let d1This = 0;
      let d1Last = 0;
      for (const row of d1Res?.results || []) {
        const m = String(row?.month || '');
        const cnt = Math.max(0, Number(row?.cnt) || 0);
        if (m === cleanThis) d1This = cnt;
        else if (m === cleanLast) d1Last = cnt;
      }
      return {
        thisMonth: Math.max(0, Number(kvThis?.n) || 0) + d1This,
        lastMonth: Math.max(0, Number(kvLast?.n) || 0) + d1Last,
      };
    },
  };
}
