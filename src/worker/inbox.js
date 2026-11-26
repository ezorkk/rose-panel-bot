// Unified visitor message delivery layer:
//   - 'topic' mode: Forum Supergroup Topics (unchanged behavior & KV schema)
//   - 'dm' mode:    Direct push to the first ADMIN_IDS UID when no supergroup is bound
//   - 'off' mode:   Neither supergroup nor ADMIN_IDS configured (welcome card only)

import { parseAdminIds } from './auth.js';
import { resolveSupergroupId, safeGetJSON, safePutJSON } from './config.js';
import { buildPanelButton, escapeHtml, tgCall } from './telegram.js';
import { formatDisplayName, formatSourceLabel, recordVisitorExchange, upsertVisitorProfile } from './visitors.js';

export const DM_LAST_HEADER_KEY = 'dm:last_header';
export const DM_OWNER_UNREACHABLE_KEY = 'dm:owner_unreachable';
export const DM_MAP_PREFIX = 'dmmap:';
export const DM_HEADER_INTERVAL_MS = 10 * 60 * 1000;
export const DM_MAP_TTL_SECONDS = 7 * 86400;

export function previewTextOfMessage(msg = {}) {
  if (msg.text) return msg.text.slice(0, 100);
  if (msg.caption) return msg.caption.slice(0, 100);
  if (msg.photo) return '[图片]';
  if (msg.video) return '[视频]';
  if (msg.voice) return '[语音]';
  if (msg.sticker) return `[贴纸 ${msg.sticker.emoji || ''}]`.trim();
  if (msg.document) return `[文件 ${msg.document.file_name || ''}]`.trim();
  return '[消息]';
}

/**
 * Returns the first numeric UID in ADMIN_IDS (the owner who receives DM pushes).
 */
export function getOwnerChatId(env) {
  const ids = parseAdminIds(env || {});
  for (const id of ids) {
    if (/^\d+$/.test(id)) return id;
  }
  return '';
}

/**
 * Computes active inbox delivery mode in real time (never stored in KV):
 *   'topic' | 'dm' | 'off'
 */
export async function resolveInboxMode(env, knownSupergroupId = undefined) {
  const supergroupId =
    knownSupergroupId !== undefined
      ? String(knownSupergroupId || '').trim()
      : await resolveSupergroupId(env);
  if (supergroupId) return 'topic';
  if (getOwnerChatId(env)) return 'dm';
  return 'off';
}

export async function isOwnerUnreachable(env) {
  if (!env?.TOPIC_MAP) return false;
  try {
    return (await env.TOPIC_MAP.get(DM_OWNER_UNREACHABLE_KEY)) === '1';
  } catch {
    return false;
  }
}

export function isOwnerUnreachableError(err) {
  if (Number(err?.code) === 403) return true;
  return /bot can't initiate|bot was blocked|chat not found|user is deactivated|forbidden/i.test(
    String(err?.message || '')
  );
}

export async function clearOwnerUnreachable(env) {
  if (!env?.TOPIC_MAP) return;
  try {
    const current = await env.TOPIC_MAP.get(DM_OWNER_UNREACHABLE_KEY);
    if (current) {
      await env.TOPIC_MAP.delete(DM_OWNER_UNREACHABLE_KEY);
    }
  } catch {
    // Ignore KV errors
  }
}

export async function saveDmMessageMap(env, ownerMsgId, visitorUid, visitorPmMsgId = null) {
  const msgId = Number(ownerMsgId);
  const uid = String(visitorUid || '').trim();
  if (!env?.TOPIC_MAP || !Number.isFinite(msgId) || msgId <= 0 || !/^\d+$/.test(uid)) return;
  const pmId = Number(visitorPmMsgId);
  // Store JSON `{ u, p }` only for copied visitor messages so reactions can map back to the
  // visitor's original private-chat message; header cards & owner replies keep plain `uid`.
  const value = Number.isInteger(pmId) && pmId > 0 ? JSON.stringify({ u: uid, p: pmId }) : uid;
  await env.TOPIC_MAP.put(`${DM_MAP_PREFIX}${msgId}`, value, { expirationTtl: DM_MAP_TTL_SECONDS });
}

export async function lookupDmMessageEntry(env, ownerMsgId) {
  const msgId = Number(ownerMsgId);
  if (!env?.TOPIC_MAP || !Number.isFinite(msgId) || msgId <= 0) return null;
  try {
    const raw = await env.TOPIC_MAP.get(`${DM_MAP_PREFIX}${msgId}`);
    if (!raw) return null;
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

export async function lookupDmMessageMap(env, ownerMsgId) {
  const entry = await lookupDmMessageEntry(env, ownerMsgId);
  return entry?.uid || '';
}

/**
 * Pushes a visitor message directly to the owner's private chat with the bot.
 * Sends an on-demand visitor header card only when switching visitors or after >10 minutes,
 * copies the original message verbatim, maps both message IDs in KV (`dmmap:*`), and
 * captures push errors (e.g. 403 when owner hasn't /started the bot) without throwing.
 */
export async function pushToOwner(env, origin, msg, knownPreview = undefined, visitorSource = '') {
  const ownerId = getOwnerChatId(env);
  if (!ownerId) {
    return { mode: 'off', delivered: false };
  }

  const ownerChatId = Number(ownerId);
  const user = msg.from || {};
  const uid = String(user.id || '');
  const preview = knownPreview !== undefined ? knownPreview : previewTextOfMessage(msg);
  const now = Date.now();

  const lastHeader = await safeGetJSON(env.TOPIC_MAP, DM_LAST_HEADER_KEY, null);
  const lastAt = Number(lastHeader?.at || 0);
  const needHeader =
    !lastHeader ||
    String(lastHeader.uid || '') !== uid ||
    !Number.isFinite(lastAt) ||
    now - lastAt >= DM_HEADER_INTERVAL_MS;

  let headerMsgId = null;
  let copiedMsgId = null;

  try {
    if (needHeader) {
      const displayName = formatDisplayName({ ...user, userId: uid });
      const handlePart =
        user.username && displayName !== `@${user.username}` ? ` (@${escapeHtml(user.username)})` : '';
      const safeUid = /^\d+$/.test(uid) ? uid : '';
      const nameHtml = safeUid
        ? `<a href="tg://user?id=${safeUid}"><b>${escapeHtml(displayName)}</b></a>`
        : `<b>${escapeHtml(displayName)}</b>`;
      const lines = [`👤 ${nameHtml}${handlePart} · <code>${escapeHtml(uid)}</code>`];
      if (visitorSource) {
        lines.push(`• 来源：${escapeHtml(formatSourceLabel(visitorSource))}`);
      }
      if (preview) {
        lines.push(escapeHtml(preview));
      }

      const sentHeader = await tgCall(env, 'sendMessage', {
        chat_id: ownerChatId,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              buildPanelButton(env, origin, '💬 在面板聊天', {
                isGroup: false,
                query: `tab=visitors&uid=${encodeURIComponent(uid)}`,
              }),
            ],
          ],
        },
      });
      headerMsgId = sentHeader?.result?.message_id || null;
      if (headerMsgId) {
        await saveDmMessageMap(env, headerMsgId, uid);
      }
      await safePutJSON(env.TOPIC_MAP, DM_LAST_HEADER_KEY, { uid, at: now });
    }

    const copied = await tgCall(env, 'copyMessage', {
      chat_id: ownerChatId,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
    copiedMsgId = copied?.result?.message_id || null;
    if (copiedMsgId) {
      await saveDmMessageMap(env, copiedMsgId, uid, msg.message_id);
    }

    await clearOwnerUnreachable(env);
    return { mode: 'dm', ownerChatId, delivered: true, headerMsgId, copiedMsgId };
  } catch (err) {
    // Only "owner can't be messaged" errors mean the owner must /start the bot; anything else
    // (an uncopyable message type, a visitor message deleted mid-flight) is a per-message failure.
    const unreachable = isOwnerUnreachableError(err);
    if (unreachable && env?.TOPIC_MAP) {
      await env.TOPIC_MAP.put(DM_OWNER_UNREACHABLE_KEY, '1').catch(() => {});
    }
    return {
      mode: 'dm',
      ownerChatId,
      delivered: false,
      unreachable,
      headerMsgId,
      copiedMsgId,
      error: err?.message || 'Push failed',
    };
  }
}

/**
 * Unified visitor message delivery entrypoint.
 * Always upserts visitor profile and records visitor exchange (photos/links/chat history)
 * once across both 'topic' and 'dm' modes so the Mini App panel remains the source of truth.
 */
export async function deliverVisitorMessage(env, origin, msg, options = {}) {
  const supergroupId = await resolveSupergroupId(env);
  const mode = await resolveInboxMode(env, supergroupId);
  if (mode === 'off') {
    return { mode: 'off', delivered: false };
  }

  const user = msg.from;
  const uid = String(user.id);
  const preview = previewTextOfMessage(msg);
  const profile = await upsertVisitorProfile(env, user, { incrementMsg: false, lastPreview: preview });

  let delivery;
  if (mode === 'topic') {
    if (typeof options.forwardToTopic !== 'function') {
      throw new Error('forwardToTopic handler is required in topic mode');
    }
    const topicRes = await options.forwardToTopic(env, origin, msg, preview);
    delivery = topicRes
      ? {
          mode: 'topic',
          delivered: true,
          supergroupId: topicRes.supergroupId,
          threadId: topicRes.threadId,
          topicMsgId: topicRes.topicMsgId || null,
        }
      : { mode: 'topic', delivered: false };
  } else {
    delivery = await pushToOwner(env, origin, msg, preview, profile?.source || '');
  }

  await recordVisitorExchange(env, uid, msg, {
    sender: 'visitor',
    pmMessageId: msg.message_id,
    ...(mode === 'dm' ? { topicMsgId: null } : {}),
    ...(mode === 'topic' && delivery?.topicMsgId
      ? { topicCopyId: delivery.topicMsgId, topicThreadId: delivery.threadId, topicChatId: delivery.supergroupId }
      : {}),
    ...(mode === 'dm' && delivery?.copiedMsgId ? { dmCopyId: delivery.copiedMsgId } : {}),
    incrementCount: true,
    preview,
  }).catch(() => {});

  return delivery;
}
