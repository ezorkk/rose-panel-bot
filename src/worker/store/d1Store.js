// Cloudflare D1 implementation of the Stage 1 (v2.0) chat history & message mapping store.
// Unifies `messages`, `photos`, and `pmMessageIds` into `messages` (+ `message_links` for URLs),
// reconstructs the exact v1.11.0 response structures, and never deletes legacy KV keys.

import { ensureSchema } from './d1Schema.js';
import {
  DM_MAP_TTL_SECONDS,
  MAX_MESSAGES,
  TOPIC_MSG_MAP_TTL_SECONDS,
  matchRecallEntryInPmList,
  readKvDmMapEntry,
  readKvTopicMapEntry,
} from './kvStore.js';

export const D1_PHOTO_QUERY_LIMIT = 500;
export const D1_LINK_QUERY_LIMIT = 500;
export const D1_PM_QUERY_LIMIT = 1000;

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
  return Number.isInteger(n) && n > 0 ? n : null;
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
 * Purges expired rows from `topic_map` (>30 days) and `dm_map` (>7 days).
 * Skips immediately when `env.DB` is not bound.
 */
export async function cleanupExpiredMaps(env, nowMs = Date.now()) {
  const db = env?.DB;
  if (!db) {
    return { skipped: true, reason: 'no_d1' };
  }
  await ensureSchema(env);
  const ts = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
  const topicCutoff = ts - TOPIC_MSG_MAP_TTL_SECONDS * 1000;
  const dmCutoff = ts - DM_MAP_TTL_SECONDS * 1000;

  const res = await db.batch([
    db.prepare(`DELETE FROM topic_map WHERE created_at < ?`).bind(topicCutoff),
    db.prepare(`DELETE FROM dm_map WHERE created_at < ?`).bind(dmCutoff),
  ]);

  return {
    ok: true,
    deletedTopicMaps: Number(res?.[0]?.meta?.changes || 0),
    deletedDmMaps: Number(res?.[1]?.meta?.changes || 0),
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
      const limit =
        Number.isInteger(Number(options?.limit)) && Number(options.limit) > 0 ? Number(options.limit) : MAX_MESSAGES;
      if (!db || !/^\d+$/.test(cleanUid)) {
        return { photos: [], links: [], pmMessageIds: [], messages: [] };
      }
      await ensureReady(cleanUid);

      const [msgRes, photoRes, linkRes, pmRes] = await db.batch([
        db
          .prepare(
            `SELECT * FROM messages
             WHERE uid = ? AND ${IS_BUBBLE_ID_SQL}
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?`
          )
          .bind(cleanUid, limit),
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
      ]);

      const messages = (msgRes?.results || []).map(rowToMessage).reverse();
      const photos = (photoRes?.results || []).map(rowToPhoto);
      const links = (linkRes?.results || []).map(rowToLink);
      const pmMessageIds = (pmRes?.results || []).map(rowToPmEntry).filter(Boolean);

      return {
        photos,
        links,
        pmMessageIds,
        messages,
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

    async getTopicMap(groupId, topicMsgId) {
      const tid = Number(topicMsgId);
      const gid = String(groupId ?? '').trim();
      if (!db || !gid || !Number.isInteger(tid) || tid <= 0) return null;
      await ensureSchema(env);

      const row = await db
        .prepare(`SELECT uid, pm_message_id, created_at FROM topic_map WHERE group_id = ? AND topic_msg_id = ?`)
        .bind(gid, tid)
        .first();
      if (row) {
        const minCreatedAt = Date.now() - TOPIC_MSG_MAP_TTL_SECONDS * 1000;
        if (Number(row.created_at) < minCreatedAt) return null;
        const uid = String(row.uid || '').trim();
        const pmId = Number(row.pm_message_id);
        if (!/^\d+$/.test(uid) || !Number.isInteger(pmId) || pmId <= 0) return null;
        return { uid, pmMessageId: pmId };
      }

      // Stage 1 fallback: check legacy KV `tmsg:*` once if D1 had no row (removed after v2.2)
      if (kv) {
        return readKvTopicMapEntry(kv, gid, tid);
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

    async getDmMap(ownerMsgId) {
      const msgId = Number(ownerMsgId);
      if (!db || !Number.isFinite(msgId) || msgId <= 0) return null;
      await ensureSchema(env);

      const row = await db
        .prepare(`SELECT uid, pm_message_id, created_at FROM dm_map WHERE owner_msg_id = ?`)
        .bind(Math.trunc(msgId))
        .first();
      if (row) {
        const minCreatedAt = Date.now() - DM_MAP_TTL_SECONDS * 1000;
        if (Number(row.created_at) < minCreatedAt) return null;
        const uid = String(row.uid || '').trim();
        if (!/^\d+$/.test(uid)) return null;
        const pmId = toNullablePositiveInt(row.pm_message_id);
        return { uid, pmMessageId: pmId };
      }

      // Stage 1 fallback: check legacy KV `dmmap:*` once if D1 had no row (removed after v2.2)
      if (kv) {
        return readKvDmMapEntry(kv, msgId);
      }
      return null;
    },
  };
}
