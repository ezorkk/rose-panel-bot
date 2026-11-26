// Visitor profile storage, bidirectional message/photo/link archive & moderation service.
// 100% compatible with mango0114/telegram_private_chatbot KV schema:
//   user:<uid>     -> JSON { thread_id, closed, ...profileFields }
//   thread:<tid>   -> "<uid>"
//   banned:<uid>   -> "1"
//   verified:<uid> -> "trusted" | "turnstile:v1" | "quiz:v1"
//   history:<uid>  -> JSON { photos: [], links: [], pmMessageIds: [] }

import { resolveSupergroupId, safeGetJSON, safePutJSON } from './config.js';

const VISITOR_INDEX_KEY = 'visitors:index';
const VISITOR_MIGRATED_KEY = 'visitors:migrated';
const VISITOR_BANNED_MIGRATED_KEY = 'visitors:banned_migrated';
const VISITOR_SUMMARY_CACHE_KEY = 'cache:visitor_summary';
const VISITOR_SUMMARY_TTL_MS = 10 * 60 * 1000;
const MAX_PHOTOS = 150;
const MAX_LINKS = 200;
const MAX_PM_IDS = 200;
const MAX_MESSAGES = 60;

export const SOURCE_PARAM_RE = /^[a-z0-9_]{1,24}$/;
export const PENDING_SOURCE_TTL_SECONDS = 7 * 86400;
export const BUILTIN_SOURCE_LABELS = {
  poster: '分享海报',
  link: '名片链接',
  site: '个人小站',
  channel: '频道',
};

/**
 * Normalizes a visitor attribution channel name (`src_site` or `site` -> `site`).
 * Strictly accepts lowercase ASCII letters, digits, and underscores (1–24 chars).
 */
export function normalizeSourceParam(raw) {
  if (typeof raw !== 'string') return '';
  const stripped = raw.startsWith('src_') ? raw.slice(4) : raw;
  return SOURCE_PARAM_RE.test(stripped) ? stripped : '';
}

export function formatSourceLabel(source) {
  const raw = String(source || '').trim();
  if (!raw) return '未知';
  const stripped = raw.startsWith('src_') ? raw.slice(4) : raw;
  if (!stripped) return '未知';
  return BUILTIN_SOURCE_LABELS[stripped] || stripped;
}

/**
 * Appends a source attribution parameter to a bot/app/web link without clobbering existing query params.
 *   kind === 'bot' -> ?start=src_<x>
 *   kind === 'app' -> ?startapp=src_<x>
 *   kind === 'web' -> ?src=<x>
 */
export function buildSourceLink(base, source, kind = 'web') {
  const cleanBase = String(base || '').trim();
  if (!cleanBase) return '';
  const normalized = normalizeSourceParam(source);
  if (!normalized) return cleanBase;
  const hashIdx = cleanBase.indexOf('#');
  const beforeHash = hashIdx >= 0 ? cleanBase.slice(0, hashIdx) : cleanBase;
  const hashPart = hashIdx >= 0 ? cleanBase.slice(hashIdx) : '';
  const sep = beforeHash.includes('?') ? '&' : '?';
  if (kind === 'bot') {
    return `${beforeHash}${sep}start=src_${normalized}${hashPart}`;
  }
  if (kind === 'app') {
    return `${beforeHash}${sep}startapp=src_${normalized}${hashPart}`;
  }
  return `${beforeHash}${sep}src=${normalized}${hashPart}`;
}

/**
 * Records a visitor's first attribution channel in `src:{uid}` (7d TTL).
 * Strictly first-touch: if `src:{uid}` or `user:{uid}.source` already exists, does nothing (0 KV writes).
 */
export async function rememberPendingSource(env, userId, rawSource) {
  if (!env?.TOPIC_MAP) return false;
  const uid = String(userId || '').trim();
  if (!/^\d+$/.test(uid)) return false;
  const source = normalizeSourceParam(rawSource);
  if (!source) return false;

  const pendingKey = `src:${uid}`;
  const [existingPending, existingUser] = await Promise.all([
    env.TOPIC_MAP.get(pendingKey),
    safeGetJSON(env.TOPIC_MAP, `user:${uid}`, null),
  ]);
  if (existingPending || existingUser?.source) {
    return false;
  }

  await env.TOPIC_MAP.put(pendingKey, source, { expirationTtl: PENDING_SOURCE_TTL_SECONDS });
  return true;
}

/**
 * Computes channel breakdown on the fly from visitor items without any KV writes.
 * Unknown/legacy visitors without `source` are grouped into `未知` at the end.
 */
export function computeSourceStats(visitors = []) {
  const counts = new Map();
  let unknownCount = 0;

  for (const v of Array.isArray(visitors) ? visitors : []) {
    const src = normalizeSourceParam(v?.source || '');
    if (!src) {
      unknownCount += 1;
    } else {
      counts.set(src, (counts.get(src) || 0) + 1);
    }
  }

  const rows = Array.from(counts.entries())
    .map(([source, count]) => ({
      source,
      label: formatSourceLabel(source),
      count,
    }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.source.localeCompare(b.source)));

  if (unknownCount > 0) {
    rows.push({ source: '', label: '未知', count: unknownCount });
  }
  return rows;
}

export async function invalidateVisitorSummaryCache(env) {
  if (!env?.TOPIC_MAP) return;
  try {
    await env.TOPIC_MAP.delete(VISITOR_SUMMARY_CACHE_KEY);
  } catch {
    // Ignore cache invalidation errors
  }
}

export function formatDisplayName(rec = {}) {
  const full = [rec.first_name, rec.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (rec.username) return `@${rec.username}`;
  if (rec.title) return String(rec.title).trim();
  return `用户 ${rec.userId || ''}`.trim();
}

/**
 * Extracts unique URLs from Telegram message text/caption & entities (`url`, `text_link`).
 */
export function extractLinksFromMessage(msg = {}) {
  const text = String(msg.text || msg.caption || '');
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const found = new Set();

  for (const ent of entities) {
    if (ent.type === 'text_link' && ent.url) {
      found.add(normalizeFoundUrl(ent.url));
    } else if (ent.type === 'url' && typeof ent.offset === 'number' && typeof ent.length === 'number') {
      const slice = text.slice(ent.offset, ent.offset + ent.length);
      if (slice) found.add(normalizeFoundUrl(slice));
    }
  }

  // Regex fallback to catch plain URLs and t.me links
  const regex = /(?:https?:\/\/|t\.me\/)[^\s<>"'`\u4e00-\u9fa5]+/gi;
  const matches = text.match(regex) || [];
  for (const m of matches) {
    const cleaned = m.replace(/[),.;!?，。！？；：】）]+$/, '');
    if (cleaned) found.add(normalizeFoundUrl(cleaned));
  }

  return Array.from(found).filter(Boolean);
}

function normalizeFoundUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^t\.me\//i.test(trimmed)) return `https://${trimmed}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(trimmed)) return `https://${trimmed}`;
  return '';
}

/**
 * Extracts photo metadata from standard Telegram photo messages or image documents.
 */
export function extractPhotoFromMessage(msg = {}) {
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const medium = msg.photo[Math.min(1, msg.photo.length - 1)] || largest;
    if (largest?.file_id) {
      return {
        fileId: largest.file_id,
        thumbFileId: medium?.file_id || largest.file_id,
        caption: String(msg.caption || '').slice(0, 140),
      };
    }
  }

  if (msg.document?.file_id && String(msg.document.mime_type || '').startsWith('image/')) {
    return {
      fileId: msg.document.file_id,
      thumbFileId: msg.document.thumbnail?.file_id || msg.document.thumb?.file_id || msg.document.file_id,
      caption: String(msg.caption || msg.document.file_name || '').slice(0, 140),
    };
  }

  return null;
}

export async function upsertVisitorProfile(env, tgUser, extra = {}) {
  if (!env.TOPIC_MAP || !tgUser?.id) return null;
  const uid = String(tgUser.id);
  const key = `user:${uid}`;
  const existing = (await safeGetJSON(env.TOPIC_MAP, key, {})) || {};
  const now = new Date().toISOString();

  const existingTotal = Number(existing.msg_count) || 0;
  const existingVisitor =
    existing.visitor_msg_count !== undefined ? Number(existing.visitor_msg_count) || 0 : existingTotal;
  const existingAdmin = Number(existing.admin_msg_count) || 0;

  const incVisitor = extra.incrementMsg ? 1 : 0;
  let resolvedSource = existing.source || '';
  let resolvedSourceAt = existing.source_at || null;
  let consumedPendingKey = '';
  if (!resolvedSource) {
    const rawPending = await env.TOPIC_MAP.get(`src:${uid}`);
    const pendingSource = normalizeSourceParam(rawPending || '');
    if (pendingSource) {
      resolvedSource = pendingSource;
      resolvedSourceAt = now;
      consumedPendingKey = `src:${uid}`;
    }
  }

  const updated = {
    ...existing,
    userId: uid,
    first_name: tgUser.first_name ?? existing.first_name ?? '',
    last_name: tgUser.last_name ?? existing.last_name ?? '',
    username: tgUser.username ?? existing.username ?? '',
    language_code: tgUser.language_code ?? existing.language_code ?? '',
    first_seen_at: existing.first_seen_at || now,
    last_seen_at: extra.touchLastSeen === false ? existing.last_seen_at || now : now,
    msg_count: existingTotal + incVisitor,
    visitor_msg_count: existingVisitor + incVisitor,
    admin_msg_count: existingAdmin,
    photo_count: Number(existing.photo_count) || 0,
    link_count: Number(existing.link_count) || 0,
    last_preview: extra.lastPreview !== undefined ? String(extra.lastPreview).slice(0, 120) : existing.last_preview || '',
    note: existing.note || '',
    ...(resolvedSource ? { source: resolvedSource, source_at: resolvedSourceAt || now } : {}),
    ...(extra.threadId !== undefined ? { thread_id: extra.threadId } : {}),
    ...(extra.closed !== undefined ? { closed: extra.closed } : {}),
  };

  await safePutJSON(env.TOPIC_MAP, key, updated);
  if (consumedPendingKey) {
    await env.TOPIC_MAP.delete(consumedPendingKey).catch(() => {});
  }
  await addToVisitorIndex(env, uid);
  await invalidateVisitorSummaryCache(env);
  return updated;
}

/**
 * Archives bidirectional message counts, photos, links, and private-chat message IDs
 * for a visitor so admin can inspect all shared photos/links and clear history anytime.
 */
export async function recordVisitorExchange(env, userId, msg, options = {}) {
  const uid = String(userId || '');
  if (!env.TOPIC_MAP || !/^\d+$/.test(uid)) return null;

  const {
    sender = 'visitor', // 'visitor' | 'admin'
    pmMessageId = null,
    topicMsgId = undefined,
    dmMsgId = null,
    dmCopyId = null,
    // Real message ID of the visitor's copied message inside its forum topic (+ that topic's ID),
    // used to quote the visitor when mirroring panel replies. Kept separate from `topicMsgId`,
    // which older visitor entries filled with the visitor's private-chat message ID.
    topicCopyId = null,
    topicThreadId = null,
    incrementCount = true,
    preview = '',
  } = options;

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const historyKey = `history:${uid}`;
  const userKey = `user:${uid}`;
  // Both records are read up front in one round trip (they were read one after another).
  const [storedHistory, storedRec] = await Promise.all([
    safeGetJSON(env.TOPIC_MAP, historyKey, null),
    safeGetJSON(env.TOPIC_MAP, userKey, { userId: uid }),
  ]);
  const history = storedHistory || {
    photos: [],
    links: [],
    pmMessageIds: [],
    messages: [],
  };
  if (!Array.isArray(history.messages)) history.messages = [];

  const photo = extractPhotoFromMessage(msg);
  if (photo) {
    history.photos.unshift({
      id: `p_${nowMs}_${Math.floor(Math.random() * 10000)}`,
      fileId: photo.fileId,
      thumbFileId: photo.thumbFileId,
      caption: photo.caption,
      sender,
      at: nowIso,
    });
    history.photos = history.photos.slice(0, MAX_PHOTOS);
  }

  const urls = extractLinksFromMessage(msg);
  const snippet = String(msg.text || msg.caption || '').trim().slice(0, 90);
  if (urls.length > 0) {
    for (const url of urls) {
      history.links.unshift({
        id: `l_${nowMs}_${Math.floor(Math.random() * 10000)}`,
        url,
        snippet,
        sender,
        at: nowIso,
      });
    }
    history.links = history.links.slice(0, MAX_LINKS);
  }

  const numericPmId = pmMessageId && Number.isFinite(Number(pmMessageId)) ? Number(pmMessageId) : null;
  const rawTopicId = topicMsgId !== undefined ? topicMsgId : msg?.message_id;
  const numericTopicId = rawTopicId && Number.isFinite(Number(rawTopicId)) ? Number(rawTopicId) : null;
  const numericDmId = dmMsgId && Number.isFinite(Number(dmMsgId)) ? Number(dmMsgId) : null;

  if (numericPmId) {
    const entry = {
      id: numericPmId,
      topicMsgId: numericTopicId,
      sender,
      at: nowMs,
    };
    if (numericDmId) {
      entry.dmMsgId = numericDmId;
    }
    const numericDmCopyId = Number(dmCopyId);
    if (Number.isInteger(numericDmCopyId) && numericDmCopyId > 0) {
      entry.dmCopyId = numericDmCopyId;
    }
    const numericCopyId = Number(topicCopyId);
    const numericThreadId = Number(topicThreadId);
    if (Number.isInteger(numericCopyId) && numericCopyId > 0 && Number.isInteger(numericThreadId) && numericThreadId > 0) {
      entry.topicCopyId = numericCopyId;
      entry.topicThreadId = numericThreadId;
    }
    history.pmMessageIds.unshift(entry);
    history.pmMessageIds = history.pmMessageIds.slice(0, MAX_PM_IDS);
  }

  const rawMsgText = String(msg?.text || msg?.caption || '').trim();
  const stickerInfo = msg?.sticker?.file_id
    ? {
        fileId: String(msg.sticker.file_id),
        format: msg.sticker.is_animated ? 'tgs' : msg.sticker.is_video ? 'webm' : 'webp',
      }
    : null;
  const mediaTag = !photo
    ? msg?.video
      ? '[视频]'
      : msg?.voice
        ? '[语音]'
        : msg?.sticker
          ? `[贴纸 ${msg.sticker.emoji || ''}]`.trim()
          : msg?.document
            ? `[文件 ${msg.document.file_name || ''}]`.trim()
            : ''
    : '';

  let addedMessage = null;
  if (rawMsgText || photo || mediaTag || stickerInfo) {
    addedMessage = {
      id: `m_${nowMs}_${Math.floor(Math.random() * 10000)}`,
      sender,
      text: rawMsgText.slice(0, 1500),
      mediaTag,
      photoFileId: photo?.fileId || '',
      thumbFileId: photo?.thumbFileId || '',
      ...(stickerInfo ? { stickerFileId: stickerInfo.fileId, stickerFormat: stickerInfo.format } : {}),
      pmMessageId: numericPmId,
      topicMsgId: numericTopicId,
      at: nowIso,
    };
    history.messages.push(addedMessage);
    if (history.messages.length > MAX_MESSAGES) {
      history.messages = history.messages.slice(-MAX_MESSAGES);
    }
  }

  // Sync summary counters onto user:<uid>
  const rec = storedRec || { userId: uid };
  const prevTotal = Number(rec.msg_count) || 0;
  const prevVisitor = rec.visitor_msg_count !== undefined ? Number(rec.visitor_msg_count) || 0 : prevTotal;
  const prevAdmin = Number(rec.admin_msg_count) || 0;

  if (incrementCount) {
    if (sender === 'admin') {
      rec.admin_msg_count = prevAdmin + 1;
      rec.visitor_msg_count = prevVisitor;
    } else {
      rec.visitor_msg_count = prevVisitor + 1;
      rec.admin_msg_count = prevAdmin;
    }
    rec.msg_count = rec.visitor_msg_count + rec.admin_msg_count;
  } else {
    rec.visitor_msg_count = prevVisitor;
    rec.admin_msg_count = prevAdmin;
    rec.msg_count = Math.max(prevTotal, prevVisitor + prevAdmin);
  }

  rec.photo_count = history.photos.length;
  rec.link_count = history.links.length;
  rec.last_seen_at = nowIso;
  if (preview) {
    rec.last_preview = sender === 'admin' ? `我：${preview}`.slice(0, 120) : preview.slice(0, 120);
  }

  // Independent writes go out together instead of one after another.
  await Promise.all([
    safePutJSON(env.TOPIC_MAP, historyKey, history),
    safePutJSON(env.TOPIC_MAP, userKey, rec),
    addToVisitorIndex(env, uid),
    invalidateVisitorSummaryCache(env),
  ]);

  return {
    photoAdded: Boolean(photo),
    linksAdded: urls.length,
    photoCount: history.photos.length,
    linkCount: history.links.length,
    totalCount: rec.msg_count,
    message: addedMessage,
  };
}

/**
 * Returns the newest visitor message copied into forum topic `threadId` as
 * `{ topicMsgId }`, or null. Only entries recorded with `topicCopyId` qualify, so older entries
 * whose `topicMsgId` holds a private-chat ID are never used to quote. 1 KV read, 0 writes.
 */
export async function findLatestVisitorTopicMessage(env, userId, threadId) {
  const uid = String(userId || '');
  const tid = Number(threadId);
  if (!env?.TOPIC_MAP || !/^\d+$/.test(uid) || !Number.isInteger(tid) || tid <= 0) return null;
  const history = await safeGetJSON(env.TOPIC_MAP, `history:${uid}`, null);
  const list = Array.isArray(history?.pmMessageIds) ? history.pmMessageIds : [];
  const hit = list.find(
    (m) => m?.sender === 'visitor' && Number(m.topicThreadId) === tid && Number(m.topicCopyId) > 0
  );
  return hit ? { topicMsgId: Number(hit.topicCopyId) } : null;
}

/**
 * Persists or clears a message reaction (`visitorReaction` or `ownerReaction`) on the matching
 * `history:{uid}.messages` entry. Re-reads `history:{uid}` fresh before writing to avoid
 * clobbering concurrent message archives. 1 read + at most 1 write.
 */
export async function updateVisitorMessageReaction(env, userId, pmMessageId, role, reactionText = '') {
  const uid = String(userId || '').trim();
  const pmId = Number(pmMessageId);
  if (!env?.TOPIC_MAP || !/^\d+$/.test(uid) || !Number.isInteger(pmId) || pmId <= 0) return false;

  const field = role === 'owner' ? 'ownerReaction' : 'visitorReaction';
  const historyKey = `history:${uid}`;
  const fresh = await safeGetJSON(env.TOPIC_MAP, historyKey, null);
  if (!fresh || !Array.isArray(fresh.messages)) return false;

  let target = null;
  for (let i = fresh.messages.length - 1; i >= 0; i -= 1) {
    if (Number(fresh.messages[i]?.pmMessageId) === pmId) {
      target = fresh.messages[i];
      break;
    }
  }
  if (!target) return false;

  const cleanVal = String(reactionText || '').trim().slice(0, 16);
  const prevVal = String(target[field] || '');
  if (prevVal === cleanVal) return false;

  if (cleanVal) {
    target[field] = cleanVal;
  } else {
    delete target[field];
  }
  await safePutJSON(env.TOPIC_MAP, historyKey, fresh);
  return true;
}

export async function getVisitorHistory(env, userId) {
  const uid = String(userId || '');
  if (!env.TOPIC_MAP || !/^\d+$/.test(uid)) {
    return { photos: [], links: [], pmMessageIds: [], messages: [] };
  }
  const history = (await safeGetJSON(env.TOPIC_MAP, `history:${uid}`, null)) || {
    photos: [],
    links: [],
    pmMessageIds: [],
    messages: [],
  };
  return {
    photos: Array.isArray(history.photos) ? history.photos : [],
    links: Array.isArray(history.links) ? history.links : [],
    pmMessageIds: Array.isArray(history.pmMessageIds) ? history.pmMessageIds : [],
    messages: Array.isArray(history.messages) ? history.messages : [],
  };
}

/**
 * Clears visitor archived photos, links & message counts.
 * When mode === 'full', also deletes the visitor's Forum Topic in SUPERGROUP_ID
 * (wiping all topic history regardless of 48h limit) and attempts to delete recorded
 * private-chat messages within Telegram's 48-hour deletion window.
 */
export async function clearVisitorHistory(env, userId, mode = 'archive', tgCallFn = null) {
  const uid = String(userId || '');
  if (!env.TOPIC_MAP || !/^\d+$/.test(uid)) {
    throw new Error('Invalid userId');
  }

  const history = await getVisitorHistory(env, uid);
  const userKey = `user:${uid}`;
  const rec = (await safeGetJSON(env.TOPIC_MAP, userKey, { userId: uid })) || { userId: uid };

  let deletedTopic = false;
  let deletedPmCount = 0;

  if (mode === 'full' && tgCallFn && env.BOT_TOKEN) {
    // 1. Delete recorded private-chat messages within 48h window
    const cutoff = Date.now() - 47.5 * 3600 * 1000;
    const recentIds = history.pmMessageIds
      .filter((item) => item?.id && (!item.at || item.at >= cutoff))
      .map((item) => Number(item.id))
      .filter((id, idx, arr) => Number.isFinite(id) && arr.indexOf(id) === idx);

    for (let i = 0; i < recentIds.length; i += 100) {
      const batch = recentIds.slice(i, i + 100);
      try {
        await tgCallFn(env, 'deleteMessages', {
          chat_id: Number(uid),
          message_ids: batch,
        });
        deletedPmCount += batch.length;
      } catch {
        // Fallback: delete individually so one un-deletable message doesn't fail the batch
        for (const msgId of batch) {
          try {
            await tgCallFn(env, 'deleteMessage', { chat_id: Number(uid), message_id: msgId });
            deletedPmCount += 1;
          } catch {
            // Ignore Telegram 48h / already-deleted errors
          }
        }
      }
    }

    // 2. Delete the visitor's entire Forum Topic in admin supergroup (no 48h limit!)
    const supergroupId = await resolveSupergroupId(env);
    if (rec.thread_id && supergroupId) {
      const oldThreadId = rec.thread_id;
      try {
        await tgCallFn(env, 'deleteForumTopic', {
          chat_id: supergroupId,
          message_thread_id: Number(oldThreadId),
        });
        deletedTopic = true;
      } catch {
        // Topic may already be deleted
      }
      delete rec.thread_id;
      await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
    }
  }

  // Always clear KV history index & counters
  await env.TOPIC_MAP.delete(`history:${uid}`);
  rec.msg_count = 0;
  rec.visitor_msg_count = 0;
  rec.admin_msg_count = 0;
  rec.photo_count = 0;
  rec.link_count = 0;
  rec.last_preview = '';
  await safePutJSON(env.TOPIC_MAP, userKey, rec);
  await invalidateVisitorSummaryCache(env);

  const visitor = await getVisitorDetail(env, uid);
  return { visitor, deletedTopic, deletedPmCount };
}

async function addToVisitorIndex(env, uid) {
  if (!env.TOPIC_MAP) return;
  const index = (await safeGetJSON(env.TOPIC_MAP, VISITOR_INDEX_KEY, [])) || [];
  const strId = String(uid);
  const filtered = index.filter((id) => String(id) !== strId);
  filtered.unshift(strId);
  await safePutJSON(env.TOPIC_MAP, VISITOR_INDEX_KEY, filtered.slice(0, 500));
}

export async function getVisitorDetail(env, userId, knownSupergroupId = null) {
  const uid = String(userId);
  if (!env.TOPIC_MAP) return null;

  const [rec, bannedVal, verifiedVal, resolvedGroupId] = await Promise.all([
    safeGetJSON(env.TOPIC_MAP, `user:${uid}`, null),
    env.TOPIC_MAP.get(`banned:${uid}`),
    env.TOPIC_MAP.get(`verified:${uid}`),
    knownSupergroupId !== null ? Promise.resolve(knownSupergroupId) : resolveSupergroupId(env),
  ]);

  if (!rec && !bannedVal && !verifiedVal) {
    return null;
  }

  const base = rec || { userId: uid };
  const isBanned = bannedVal === '1';
  const isTrusted = verifiedVal === 'trusted';
  const isVerified = Boolean(verifiedVal);
  const isClosed = Boolean(base.closed);

  let status = 'pending';
  if (isBanned) status = 'banned';
  else if (isClosed) status = 'closed';
  else if (isTrusted) status = 'trusted';
  else if (isVerified) status = 'verified';

  const supergroupClean = String(resolvedGroupId || '').replace(/^-100/, '');
  const topicLink =
    supergroupClean && base.thread_id
      ? `https://t.me/c/${supergroupClean}/${base.thread_id}`
      : '';

  const totalMsgs = Number(base.msg_count || 0);
  const visitorMsgs =
    base.visitor_msg_count !== undefined ? Number(base.visitor_msg_count || 0) : totalMsgs;
  const adminMsgs = Number(base.admin_msg_count || 0);

  return {
    userId: uid,
    displayName: formatDisplayName({ ...base, userId: uid }),
    first_name: base.first_name || '',
    last_name: base.last_name || '',
    username: base.username || '',
    language_code: base.language_code || '',
    thread_id: base.thread_id || null,
    topicLink,
    first_seen_at: base.first_seen_at || null,
    last_seen_at: base.last_seen_at || null,
    msg_count: Math.max(totalMsgs, visitorMsgs + adminMsgs),
    visitor_msg_count: visitorMsgs,
    admin_msg_count: adminMsgs,
    photo_count: Number(base.photo_count || 0),
    link_count: Number(base.link_count || 0),
    last_preview: base.last_preview || '',
    note: base.note || '',
    source: base.source || '',
    source_at: base.source_at || null,
    isBanned,
    isTrusted,
    isVerified,
    isClosed,
    status,
  };
}

export async function listVisitors(env, options = {}) {
  const { search = '', filter = 'all', limit = 60 } = options;
  if (!env.TOPIC_MAP) {
    return { stats: { total: 0, active: 0, trusted: 0, banned: 0, closed: 0 }, sourceStats: [], items: [] };
  }

  const [indexedRaw, migrated, bannedMigrated] = await Promise.all([
    safeGetJSON(env.TOPIC_MAP, VISITOR_INDEX_KEY, []),
    env.TOPIC_MAP.get(VISITOR_MIGRATED_KEY),
    env.TOPIC_MAP.get(VISITOR_BANNED_MIGRATED_KEY),
  ]);
  const indexed = Array.isArray(indexedRaw) ? indexedRaw : [];
  let idList = Array.from(new Set(indexed.map(String)));
  const idSet = new Set(idList);

  // Run one-time legacy `user:*` discovery only until migrated, avoiding recurring KV.list quota burn
  if (!migrated && typeof env.TOPIC_MAP.list === 'function') {
    try {
      const listed = await env.TOPIC_MAP.list({ prefix: 'user:', limit: 200 });
      let discovered = 0;
      for (const k of listed.keys || []) {
        const uid = k.name.slice(5);
        if (/^\d+$/.test(uid) && !idSet.has(uid)) {
          idSet.add(uid);
          idList.push(uid);
          discovered += 1;
        }
      }
      if (discovered > 0) {
        await safePutJSON(env.TOPIC_MAP, VISITOR_INDEX_KEY, idList.slice(0, 500));
      }
      await env.TOPIC_MAP.put(VISITOR_MIGRATED_KEY, '1');
    } catch {
      // Ignore list failure
    }
  }

  // One-time orphan `banned:*` discovery so pre-v1.5.3 honeypot/CAS auto-bans appear in Admin -> Banned for 1-click unban
  if (!bannedMigrated && typeof env.TOPIC_MAP.list === 'function') {
    try {
      const listedBanned = await env.TOPIC_MAP.list({ prefix: 'banned:', limit: 200 });
      const prepended = [];
      for (const k of listedBanned.keys || []) {
        const uid = k.name.slice(7);
        if (/^\d+$/.test(uid) && !idSet.has(uid)) {
          idSet.add(uid);
          prepended.push(uid);
        }
      }
      if (prepended.length > 0) {
        idList = [...prepended, ...idList].slice(0, 500);
        await safePutJSON(env.TOPIC_MAP, VISITOR_INDEX_KEY, idList);
      }
      await env.TOPIC_MAP.put(VISITOR_BANNED_MIGRATED_KEY, '1');
    } catch {
      // Ignore list failure
    }
  }

  const allIds = idList.slice(0, 120);
  const supergroupId = await resolveSupergroupId(env);
  const details = (await Promise.all(allIds.map((uid) => getVisitorDetail(env, uid, supergroupId)))).filter(Boolean);

  details.sort((a, b) => {
    const ta = a.last_seen_at ? Date.parse(a.last_seen_at) : 0;
    const tb = b.last_seen_at ? Date.parse(b.last_seen_at) : 0;
    return tb - ta;
  });

  const stats = {
    total: details.length,
    active: details.filter((v) => !v.isBanned && !v.isClosed).length,
    trusted: details.filter((v) => v.isTrusted && !v.isBanned).length,
    banned: details.filter((v) => v.isBanned).length,
    closed: details.filter((v) => v.isClosed && !v.isBanned).length,
  };
  const sourceStats = computeSourceStats(details);

  // Opportunistically refresh single-key summary cache only when missing or expired (avoids unnecessary KV writes)
  if (!search && filter === 'all') {
    const existingCache = await safeGetJSON(env.TOPIC_MAP, VISITOR_SUMMARY_CACHE_KEY, null);
    const cacheFresh =
      existingCache &&
      existingCache.stats &&
      Array.isArray(existingCache.sourceStats) &&
      Date.now() - Number(existingCache.cachedAt || 0) < VISITOR_SUMMARY_TTL_MS;
    if (!cacheFresh) {
      await safePutJSON(
        env.TOPIC_MAP,
        VISITOR_SUMMARY_CACHE_KEY,
        { stats, sourceStats, recent: details.slice(0, 5), cachedAt: Date.now() },
        { expirationTtl: 600 }
      ).catch(() => {});
    }
  }

  const q = String(search || '').trim().toLowerCase();
  const filtered = details.filter((v) => {
    if (filter === 'banned' && !v.isBanned) return false;
    if (filter === 'trusted' && (!v.isTrusted || v.isBanned)) return false;
    if (filter === 'closed' && (!v.isClosed || v.isBanned)) return false;
    if (filter === 'active' && (v.isBanned || v.isClosed)) return false;
    if (q) {
      const hay = `${v.displayName} ${v.username} ${v.userId} ${v.note} ${v.last_preview} ${v.source} ${formatSourceLabel(v.source)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return {
    stats,
    sourceStats,
    items: filtered.slice(0, limit),
  };
}

/**
 * Ultra-fast single-KV-read overview for Admin bootstrap (replaces 100+ per-open KV reads).
 * Automatically invalidated whenever a visitor chats or admin moderates a visitor.
 */
export async function getVisitorOverview(env) {
  if (!env.TOPIC_MAP) {
    return { stats: { total: 0, active: 0, trusted: 0, banned: 0, closed: 0 }, sourceStats: [], recent: [], cached: false };
  }
  const cached = await safeGetJSON(env.TOPIC_MAP, VISITOR_SUMMARY_CACHE_KEY, null);
  if (cached && cached.stats && Date.now() - Number(cached.cachedAt || 0) < VISITOR_SUMMARY_TTL_MS) {
    return {
      stats: cached.stats,
      sourceStats: Array.isArray(cached.sourceStats) ? cached.sourceStats : [],
      recent: Array.isArray(cached.recent) ? cached.recent : [],
      cached: true,
    };
  }
  const listed = await listVisitors(env, { limit: 5 });
  return {
    stats: listed.stats,
    sourceStats: listed.sourceStats,
    recent: listed.items,
    cached: false,
  };
}

export async function applyVisitorAction(env, userId, action, payload = {}) {
  const uid = String(userId);
  if (!env.TOPIC_MAP || !/^\d+$/.test(uid)) {
    throw new Error('Invalid userId');
  }

  const key = `user:${uid}`;
  const rec = (await safeGetJSON(env.TOPIC_MAP, key, { userId: uid })) || { userId: uid };

  switch (action) {
    case 'ban':
      await env.TOPIC_MAP.put(`banned:${uid}`, '1');
      if (rec.casExempt) {
        delete rec.casExempt;
        await safePutJSON(env.TOPIC_MAP, key, rec);
      }
      break;
    case 'unban':
      await env.TOPIC_MAP.delete(`banned:${uid}`);
      await env.TOPIC_MAP.delete(`verify_cool:${uid}`);
      await env.TOPIC_MAP.delete(`verify_cool_hint:${uid}`);
      rec.casExempt = true;
      await safePutJSON(env.TOPIC_MAP, key, rec);
      break;
    case 'trust':
      await env.TOPIC_MAP.delete(`banned:${uid}`);
      await env.TOPIC_MAP.delete(`verify_cool:${uid}`);
      await env.TOPIC_MAP.delete(`verify_cool_hint:${uid}`);
      await env.TOPIC_MAP.put(`verified:${uid}`, 'trusted');
      await env.TOPIC_MAP.delete(`needs_verify:${uid}`);
      break;
    case 'reset':
      await env.TOPIC_MAP.delete(`verified:${uid}`);
      await env.TOPIC_MAP.delete(`verify_cool:${uid}`);
      await env.TOPIC_MAP.delete(`verify_cool_hint:${uid}`);
      await env.TOPIC_MAP.put(`needs_verify:${uid}`, '1', { expirationTtl: 600 });
      break;
    case 'close':
      rec.closed = true;
      await safePutJSON(env.TOPIC_MAP, key, rec);
      break;
    case 'open':
      rec.closed = false;
      await safePutJSON(env.TOPIC_MAP, key, rec);
      break;
    case 'note':
      rec.note = String(payload.note || '').slice(0, 300);
      await safePutJSON(env.TOPIC_MAP, key, rec);
      break;
    default:
      throw new Error(`Unsupported action: ${action}`);
  }

  await addToVisitorIndex(env, uid);
  await invalidateVisitorSummaryCache(env);
  return await getVisitorDetail(env, uid);
}

/**
 * Recalls an admin reply sent to a visitor in private chat (either matching a replied-to topic message
 * or falling back to the most recent admin reply within 48 hours).
 */
// Bots can delete their own private-chat messages for 48 hours.
const RECALL_WINDOW_MS = 48 * 60 * 60 * 1000;

export async function recallAdminVisitorMessage(
  env,
  userId,
  replyToTopicMsgId = null,
  tgCallFn = null,
  explicitPmMessageId = null,
  options = {}
) {
  const uid = String(userId || '');
  if (!env.TOPIC_MAP || !/^\d+$/.test(uid) || typeof tgCallFn !== 'function') {
    return { ok: false, error: '参数无效' };
  }
  const historyKey = `history:${uid}`;
  const history = (await safeGetJSON(env.TOPIC_MAP, historyKey, null)) || {
    photos: [],
    links: [],
    pmMessageIds: [],
    messages: [],
  };
  const list = Array.isArray(history.pmMessageIds) ? history.pmMessageIds : [];
  const hasDmTarget = Boolean(options && Object.prototype.hasOwnProperty.call(options, 'replyToDmMsgId'));
  const dmTargetId = hasDmTarget ? Number(options.replyToDmMsgId) : null;

  let idx = -1;
  if (explicitPmMessageId) {
    idx = list.findIndex((m) => Number(m?.id) === Number(explicitPmMessageId) && m?.sender !== 'visitor');
  } else if (hasDmTarget) {
    // DM inbox mode: strictly match the replied-to owner DM message; NEVER fall back to "most recent".
    idx =
      Number.isFinite(dmTargetId) && dmTargetId > 0
        ? list.findIndex((m) => Number(m?.dmMsgId) === dmTargetId && m?.sender !== 'visitor')
        : -1;
  } else if (replyToTopicMsgId) {
    idx = list.findIndex((m) => Number(m?.topicMsgId) === Number(replyToTopicMsgId) && m?.sender !== 'visitor');
  } else {
    idx = list.findIndex((m) => m?.sender === 'admin');
  }

  if (idx === -1) {
    return {
      ok: false,
      error:
        replyToTopicMsgId || hasDmTarget
          ? '未找到该条消息对应的私聊记录（仅支持撤回站长发出的近期消息）'
          : '暂无可撤回的站长近期回复记录',
    };
  }

  const target = list[idx];
  // Telegram only lets bots delete their private-chat messages for 48h; fail fast instead of
  // spending a round trip on a call that cannot succeed.
  if (Number(target.at) > 0 && Date.now() - Number(target.at) > RECALL_WINDOW_MS) {
    return { ok: false, error: '撤回失败：已超过 Telegram 48 小时撤回时限' };
  }

  // If recalled from Mini App (`explicitPmMessageId`) and a mirrored topic message exists, clean it up too.
  // The group lookup runs alongside the visitor-side delete; the topic copy is only deleted once the
  // visitor-side delete succeeded, so a failed recall never leaves the topic and the chat out of sync.
  const mirrorInTopic = Boolean(explicitPmMessageId && target.topicMsgId);
  const groupLookup = mirrorInTopic ? resolveSupergroupId(env).catch(() => '') : Promise.resolve('');
  try {
    await tgCallFn(env, 'deleteMessage', {
      chat_id: Number(uid),
      message_id: Number(target.id),
    });
  } catch (err) {
    return { ok: false, error: `撤回失败（可能已超过 Telegram 48 小时撤回时限）：${err.message}` };
  }

  const supergroupId = await groupLookup;
  const topicDelete =
    mirrorInTopic && supergroupId
      ? tgCallFn(env, 'deleteMessage', {
          chat_id: supergroupId,
          message_id: Number(target.topicMsgId),
        }).catch(() => {})
      : Promise.resolve();

  // Re-read after the (slow) Telegram round-trips so messages archived concurrently by the webhook
  // are not overwritten by the stale snapshot taken above. The topic delete runs meanwhile.
  const userKey = `user:${uid}`;
  const [freshStored, storedRec] = await Promise.all([
    safeGetJSON(env.TOPIC_MAP, historyKey, null),
    safeGetJSON(env.TOPIC_MAP, userKey, null),
  ]);
  const fresh = freshStored || history;
  const targetId = Number(target.id);
  const freshMessages = Array.isArray(fresh.messages) ? fresh.messages : [];
  const recalledEntry = freshMessages.find(
    (m) => Number(m?.pmMessageId) === targetId && m?.sender !== 'visitor'
  );

  fresh.pmMessageIds = (Array.isArray(fresh.pmMessageIds) ? fresh.pmMessageIds : []).filter(
    (m) => !(Number(m?.id) === targetId && m?.sender !== 'visitor')
  );
  fresh.messages = freshMessages.filter((m) => !(Number(m?.pmMessageId) === targetId && m?.sender !== 'visitor'));

  // Drop the recalled photo / links from the archive too, so the gallery doesn't keep serving
  // signed URLs for content the visitor can no longer see.
  if (recalledEntry) {
    if (Array.isArray(fresh.photos) && recalledEntry.photoFileId) {
      fresh.photos = fresh.photos.filter(
        (p) => !(p?.sender === 'admin' && p?.fileId === recalledEntry.photoFileId && p?.at === recalledEntry.at)
      );
    }
    if (Array.isArray(fresh.links)) {
      fresh.links = fresh.links.filter((l) => !(l?.sender === 'admin' && l?.at === recalledEntry.at));
    }
  }
  const writes = [safePutJSON(env.TOPIC_MAP, historyKey, fresh), topicDelete];
  if (recalledEntry && storedRec) {
    storedRec.photo_count = Array.isArray(fresh.photos) ? fresh.photos.length : 0;
    storedRec.link_count = Array.isArray(fresh.links) ? fresh.links.length : 0;
    writes.push(safePutJSON(env.TOPIC_MAP, userKey, storedRec), invalidateVisitorSummaryCache(env));
  }
  await Promise.all(writes);
  return { ok: true, deletedPmMessageId: target.id };
}
