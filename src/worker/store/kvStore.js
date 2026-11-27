// Workers KV implementation of the Stage 1 chat history & message mapping store.
// Preserves 100% identical behavior and KV schema to v1.11.0 when D1 (`env.DB`) is not bound.

import { safeGetJSON, safePutJSON } from '../config.js';

export const MAX_PHOTOS = 150;
export const MAX_LINKS = 200;
export const MAX_PM_IDS = 200;
export const MAX_MESSAGES = 60;
// Workers KV minimum cacheTtl (docs: must be >= 30 seconds).
export const HISTORY_CACHE_TTL_SECONDS = 30;

export const TOPIC_MSG_MAP_PREFIX = 'tmsg:';
export const TOPIC_MSG_MAP_TTL_SECONDS = 30 * 86400;

export const DM_MAP_PREFIX = 'dmmap:';
export const DM_MAP_TTL_SECONDS = 7 * 86400;

export function parseKvDmMapRaw(raw) {
  if (!raw) return null;
  try {
    const trimmed = String(raw).trim();
    if (/^\d+$/.test(trimmed)) {
      return { uid: trimmed, pmMessageId: null };
    }
    const parsed = JSON.parse(trimmed);
    const uid = String(parsed?.u || '').trim();
    if (!/^\d+$/.test(uid)) return null;
    const pmId = Number(parsed?.p);
    return {
      uid,
      pmMessageId: Number.isInteger(pmId) && pmId > 0 ? pmId : null,
    };
  } catch {
    return null;
  }
}

export async function readKvTopicMapEntry(kv, groupId, topicMsgId) {
  const tid = Number(topicMsgId);
  const gid = String(groupId ?? '').trim();
  if (!kv || !gid || !Number.isInteger(tid) || tid <= 0) return null;
  const mapping = await safeGetJSON(kv, `${TOPIC_MSG_MAP_PREFIX}${tid}`, null);
  if (String(mapping?.g || '') !== gid) return null;
  const uid = String(mapping?.u || '').trim();
  const pmId = Number(mapping?.p);
  if (!/^\d+$/.test(uid) || !Number.isInteger(pmId) || pmId <= 0) return null;
  return { uid, pmMessageId: pmId };
}

export async function readKvDmMapEntry(kv, ownerMsgId) {
  const msgId = Number(ownerMsgId);
  if (!kv || !Number.isFinite(msgId) || msgId <= 0) return null;
  try {
    const raw = await kv.get(`${DM_MAP_PREFIX}${msgId}`);
    return parseKvDmMapRaw(raw);
  } catch {
    return null;
  }
}

export function matchRecallEntryInPmList(list = [], criteria = {}) {
  const {
    explicitPmMessageId = null,
    hasDmTarget = false,
    replyToDmMsgId = null,
    replyToTopicMsgId = null,
  } = criteria;

  if (explicitPmMessageId) {
    return list.find((m) => Number(m?.id) === Number(explicitPmMessageId) && m?.sender !== 'visitor') || null;
  }
  if (hasDmTarget) {
    const dmTargetId = Number(replyToDmMsgId);
    if (!Number.isFinite(dmTargetId) || dmTargetId <= 0) return null;
    return list.find((m) => Number(m?.dmMsgId) === dmTargetId && m?.sender !== 'visitor') || null;
  }
  if (replyToTopicMsgId) {
    return list.find((m) => Number(m?.topicMsgId) === Number(replyToTopicMsgId) && m?.sender !== 'visitor') || null;
  }
  return list.find((m) => m?.sender === 'admin') || null;
}

export function createKvStore(env) {
  const kv = env?.TOPIC_MAP || null;

  return {
    mode: 'kv',

    async appendExchange(uid, entry) {
      const cleanUid = String(uid || '');
      if (!kv || !/^\d+$/.test(cleanUid)) {
        return { photoCount: 0, linkCount: 0, message: null };
      }

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

      const historyKey = `history:${cleanUid}`;
      const storedHistory = await safeGetJSON(kv, historyKey, null);
      const history = storedHistory || {
        photos: [],
        links: [],
        pmMessageIds: [],
        messages: [],
      };
      if (!Array.isArray(history.photos)) history.photos = [];
      if (!Array.isArray(history.links)) history.links = [];
      if (!Array.isArray(history.pmMessageIds)) history.pmMessageIds = [];
      if (!Array.isArray(history.messages)) history.messages = [];

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

      if (Array.isArray(urls) && urls.length > 0) {
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

      if (pmMessageId) {
        const pmEntry = {
          id: pmMessageId,
          topicMsgId,
          sender,
          at: nowMs,
        };
        if (dmMsgId) {
          pmEntry.dmMsgId = dmMsgId;
        }
        if (topicChatId) {
          pmEntry.topicChatId = topicChatId;
        }
        if (dmCopyId) {
          pmEntry.dmCopyId = dmCopyId;
        }
        if (topicCopyId && topicThreadId) {
          pmEntry.topicCopyId = topicCopyId;
          pmEntry.topicThreadId = topicThreadId;
        }
        history.pmMessageIds.unshift(pmEntry);
        history.pmMessageIds = history.pmMessageIds.slice(0, MAX_PM_IDS);
      }

      let addedMessage = null;
      if (text || photo || mediaTag || stickerInfo) {
        addedMessage = {
          id: `m_${nowMs}_${Math.floor(Math.random() * 10000)}`,
          sender,
          text: String(text).slice(0, 1500),
          mediaTag,
          photoFileId: photo?.fileId || '',
          thumbFileId: photo?.thumbFileId || '',
          ...(stickerInfo ? { stickerFileId: stickerInfo.fileId, stickerFormat: stickerInfo.format } : {}),
          pmMessageId,
          topicMsgId,
          at: nowIso,
        };
        history.messages.push(addedMessage);
        if (history.messages.length > MAX_MESSAGES) {
          history.messages = history.messages.slice(-MAX_MESSAGES);
        }
      }

      await safePutJSON(kv, historyKey, history);
      return {
        photoCount: history.photos.length,
        linkCount: history.links.length,
        message: addedMessage,
      };
    },

    async getHistory(uid, options = {}) {
      const cleanUid = String(uid || '');
      const limit = Number.isInteger(Number(options?.limit)) && Number(options.limit) > 0 ? Number(options.limit) : MAX_MESSAGES;
      if (!kv || !/^\d+$/.test(cleanUid)) {
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
      const history = (await safeGetJSON(kv, `history:${cleanUid}`, null, { cacheTtl: HISTORY_CACHE_TTL_SECONDS })) || {
        photos: [],
        links: [],
        pmMessageIds: [],
        messages: [],
      };
      const rawMessages = Array.isArray(history.messages) ? history.messages : [];
      return {
        photos: Array.isArray(history.photos) ? history.photos : [],
        links: Array.isArray(history.links) ? history.links : [],
        pmMessageIds: Array.isArray(history.pmMessageIds) ? history.pmMessageIds : [],
        messages: rawMessages.length > limit ? rawMessages.slice(-limit) : rawMessages,
        hasMore: false,
        hasNewer: false,
        oldestCursor: null,
        newestCursor: null,
      };
    },

    async searchMessages() {
      // KV mode never scans KV keys for chat search; D1 binding is required.
      return {
        supported: false,
        mode: 'kv',
        items: [],
        hasMore: false,
        nextCursor: null,
      };
    },

    async findPmEntry(uid, pmMessageId) {
      const cleanUid = String(uid || '').trim();
      const pmId = Number(pmMessageId);
      if (!kv || !/^\d+$/.test(cleanUid) || !Number.isInteger(pmId) || pmId <= 0) return null;
      const history = await safeGetJSON(kv, `history:${cleanUid}`, null);
      const pmList = Array.isArray(history?.pmMessageIds) ? history.pmMessageIds : [];
      return pmList.find((m) => Number(m?.id) === pmId) || null;
    },

    async findAdminMessageForRecall(uid, criteria = {}) {
      const cleanUid = String(uid || '').trim();
      if (!kv || !/^\d+$/.test(cleanUid)) return null;
      const history = await safeGetJSON(kv, `history:${cleanUid}`, null);
      const list = Array.isArray(history?.pmMessageIds) ? history.pmMessageIds : [];
      return matchRecallEntryInPmList(list, criteria);
    },

    async findLatestVisitorTopicCopy(uid, threadId) {
      const cleanUid = String(uid || '');
      const tid = Number(threadId);
      if (!kv || !/^\d+$/.test(cleanUid) || !Number.isInteger(tid) || tid <= 0) return null;
      const history = await safeGetJSON(kv, `history:${cleanUid}`, null);
      const list = Array.isArray(history?.pmMessageIds) ? history.pmMessageIds : [];
      const hit = list.find(
        (m) => m?.sender === 'visitor' && Number(m.topicThreadId) === tid && Number(m.topicCopyId) > 0
      );
      return hit ? { topicMsgId: Number(hit.topicCopyId) } : null;
    },

    async attachTopicMirror(uid, pmMessageId, topicMsgId, topicChatId) {
      const cleanUid = String(uid || '');
      const pmId = Number(pmMessageId);
      const topicId = Number(topicMsgId);
      if (!kv || !/^\d+$/.test(cleanUid) || !(pmId > 0) || !(topicId > 0)) return true;
      const historyKey = `history:${cleanUid}`;
      const fresh = await safeGetJSON(kv, historyKey, null);
      const list = Array.isArray(fresh?.pmMessageIds) ? fresh.pmMessageIds : [];
      const entry = list.find((m) => Number(m?.id) === pmId && m?.sender === 'admin');
      if (!entry) return false;
      entry.topicMsgId = topicId;
      if (topicChatId) entry.topicChatId = String(topicChatId);
      const msgEntry = (Array.isArray(fresh.messages) ? fresh.messages : []).find(
        (m) => Number(m?.pmMessageId) === pmId && m?.sender === 'admin'
      );
      if (msgEntry) msgEntry.topicMsgId = topicId;
      await safePutJSON(kv, historyKey, fresh);
      return true;
    },

    async removeAdminMessage(uid, pmMessageId) {
      const cleanUid = String(uid || '');
      const targetId = Number(pmMessageId);
      if (!kv || !/^\d+$/.test(cleanUid) || !Number.isFinite(targetId) || targetId <= 0) {
        return { removed: false, photoCount: 0, linkCount: 0 };
      }
      const historyKey = `history:${cleanUid}`;
      const fresh = (await safeGetJSON(kv, historyKey, null)) || {
        photos: [],
        links: [],
        pmMessageIds: [],
        messages: [],
      };
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

      await safePutJSON(kv, historyKey, fresh);
      return {
        removed: Boolean(recalledEntry),
        photoCount: Array.isArray(fresh.photos) ? fresh.photos.length : 0,
        linkCount: Array.isArray(fresh.links) ? fresh.links.length : 0,
      };
    },

    async setReaction(uid, pmMessageId, role, value = '') {
      const cleanUid = String(uid || '').trim();
      const pmId = Number(pmMessageId);
      if (!kv || !/^\d+$/.test(cleanUid) || !Number.isInteger(pmId) || pmId <= 0) return false;

      const field = role === 'owner' ? 'ownerReaction' : 'visitorReaction';
      const historyKey = `history:${cleanUid}`;
      const fresh = await safeGetJSON(kv, historyKey, null);
      if (!fresh || !Array.isArray(fresh.messages)) return false;

      let target = null;
      for (let i = fresh.messages.length - 1; i >= 0; i -= 1) {
        if (Number(fresh.messages[i]?.pmMessageId) === pmId) {
          target = fresh.messages[i];
          break;
        }
      }
      if (!target) return false;

      const cleanVal = String(value || '').trim().slice(0, 16);
      const prevVal = String(target[field] || '');
      if (prevVal === cleanVal) return false;

      if (cleanVal) {
        target[field] = cleanVal;
      } else {
        delete target[field];
      }
      await safePutJSON(kv, historyKey, fresh);
      return true;
    },

    async clearHistory(uid) {
      const cleanUid = String(uid || '');
      if (!kv || !/^\d+$/.test(cleanUid)) return;
      await kv.delete(`history:${cleanUid}`);
    },

    async putTopicMap(groupId, topicMsgId, uid, pmId) {
      const tid = Number(topicMsgId);
      const cleanUid = String(uid || '').trim();
      const visitorPmId = Number(pmId);
      const gid = String(groupId ?? '').trim();
      if (!kv || !gid || !Number.isInteger(tid) || tid <= 0 || !/^\d+$/.test(cleanUid) || !(visitorPmId > 0)) {
        return;
      }
      await kv.put(
        `${TOPIC_MSG_MAP_PREFIX}${tid}`,
        JSON.stringify({ g: gid, u: cleanUid, p: visitorPmId }),
        { expirationTtl: TOPIC_MSG_MAP_TTL_SECONDS }
      );
    },

    async getTopicMap(groupId, topicMsgId) {
      return readKvTopicMapEntry(kv, groupId, topicMsgId);
    },

    async putDmMap(ownerMsgId, uid, pmId = null) {
      const msgId = Number(ownerMsgId);
      const cleanUid = String(uid || '').trim();
      if (!kv || !Number.isFinite(msgId) || msgId <= 0 || !/^\d+$/.test(cleanUid)) return;
      const numericPmId = Number(pmId);
      // Store JSON `{ u, p }` only for copied visitor messages so reactions can map back to the
      // visitor's original private-chat message; header cards & owner replies keep plain `uid`.
      const value =
        Number.isInteger(numericPmId) && numericPmId > 0 ? JSON.stringify({ u: cleanUid, p: numericPmId }) : cleanUid;
      await kv.put(`${DM_MAP_PREFIX}${msgId}`, value, { expirationTtl: DM_MAP_TTL_SECONDS });
    },

    async getDmMap(ownerMsgId) {
      return readKvDmMapEntry(kv, ownerMsgId);
    },
  };
}
