// Telegram Bot API client, avatar proxy & sticker/emoji (WebP/WebM/TGS) proxy helpers

export const WEBHOOK_ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'message_reaction'];

export async function tgCall(env, method, payload = {}) {
  if (!env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN is not configured');
  }
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const err = new Error(data?.description || `Telegram API error (${res.status})`);
      err.code = data?.error_code || res.status;
      err.response = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function tgCallForm(env, method, formData) {
  if (!env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN is not configured');
  }
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const err = new Error(data?.description || `Telegram API error (${res.status})`);
      err.code = data?.error_code || res.status;
      err.response = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildMiniAppDirectLink(env, startParam = '') {
  const botUsername = (env.BOT_USERNAME || '').replace(/^@/, '');
  const shortName = (env.APP_SHORT_NAME || '').replace(/^\/+|\/+$/g, '');
  if (!botUsername) return '';
  if (shortName) {
    return startParam
      ? `https://t.me/${botUsername}/${shortName}?startapp=${encodeURIComponent(startParam)}`
      : `https://t.me/${botUsername}/${shortName}`;
  }
  return startParam
    ? `https://t.me/${botUsername}?startapp=${encodeURIComponent(startParam)}`
    : `https://t.me/${botUsername}`;
}

export function buildWebAppUrl(requestOrigin, query = '') {
  const base = requestOrigin.replace(/\/$/, '');
  return query ? `${base}/?${query}` : `${base}/`;
}

/**
 * In private chats Telegram supports `web_app` buttons directly.
 * In groups/supergroups Telegram ONLY allows direct-link `url` buttons for Mini Apps.
 */
export function buildPanelButton(env, requestOrigin, text, options = {}) {
  const { isGroup = false, startParam = '', query = '' } = options;
  if (isGroup) {
    const direct = buildMiniAppDirectLink(env, startParam);
    if (direct) {
      return { text, url: direct };
    }
    const botUsername = (env.BOT_USERNAME || '').replace(/^@/, '');
    if (botUsername) {
      return { text, url: `https://t.me/${botUsername}?start=panel` };
    }
    return { text, url: buildWebAppUrl(requestOrigin, query) };
  }
  return {
    text,
    web_app: { url: buildWebAppUrl(requestOrigin, query) },
  };
}

export function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Extracts Telegram sticker/emoji pack short name from a URL or raw name.
 * Supports:
 *   https://t.me/addstickers/MyPack
 *   https://t.me/addemoji/MyEmojiPack
 *   MyPack
 */
export function parseStickerPackName(input = '') {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  const urlMatch = trimmed.match(/t\.me\/(?:addstickers|addemoji)\/([A-Za-z0-9_]+)/i);
  if (urlMatch) return urlMatch[1];
  const rawMatch = trimmed.match(/^([A-Za-z0-9_]{3,64})$/);
  return rawMatch ? rawMatch[1] : '';
}

export function normalizeStickerObject(sticker = {}) {
  if (!sticker?.file_id) return null;
  let format = 'webp';
  if (sticker.is_animated) format = 'tgs';
  else if (sticker.is_video) format = 'webm';
  return {
    fileId: sticker.file_id,
    thumbFileId: sticker.thumbnail?.file_id || sticker.thumb?.file_id || '',
    format,
    emoji: sticker.emoji || '',
    setName: sticker.set_name || '',
  };
}

/**
 * Securely proxies a Telegram user's profile photo without exposing BOT_TOKEN.
 */
export async function handleAvatarProxy(env, userId) {
  if (!env.BOT_TOKEN || !/^\d+$/.test(String(userId))) {
    return new Response(null, { status: 404 });
  }
  try {
    const photos = await tgCall(env, 'getUserProfilePhotos', {
      user_id: Number(userId),
      limit: 1,
    });
    const sizes = photos?.result?.photos?.[0];
    if (!sizes || sizes.length === 0) {
      return new Response(null, { status: 404 });
    }
    const chosen = sizes[Math.min(1, sizes.length - 1)] || sizes[0];
    const fileInfo = await tgCall(env, 'getFile', { file_id: chosen.file_id });
    const filePath = fileInfo?.result?.file_path;
    if (!filePath) {
      return new Response(null, { status: 404 });
    }
    const imgRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
    if (!imgRes.ok) {
      return new Response(null, { status: 404 });
    }
    return new Response(imgRes.body, {
      status: 200,
      headers: {
        'Content-Type': imgRes.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/**
 * Securely proxies a Telegram Sticker or Custom Emoji by file_id without exposing BOT_TOKEN.
 * Automatically decompresses `.tgs` (gzipped Lottie) into clean JSON for web lottie playback!
 */
export async function handleStickerProxy(env, fileId) {
  const cleanId = decodeURIComponent(String(fileId || '')).trim();
  if (!env.BOT_TOKEN || !/^[A-Za-z0-9_-]{16,180}$/.test(cleanId)) {
    return new Response(null, { status: 404 });
  }
  try {
    const fileInfo = await tgCall(env, 'getFile', { file_id: cleanId });
    const filePath = fileInfo?.result?.file_path;
    if (!filePath) {
      return new Response(null, { status: 404 });
    }
    const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
    if (!res.ok || !res.body) {
      return new Response(null, { status: 404 });
    }

    const lower = filePath.toLowerCase();

    // Telegram animated vector stickers (.tgs) are gzip-compressed Lottie JSON
    if (lower.endsWith('.tgs')) {
      const decompressed = res.body.pipeThrough(new DecompressionStream('gzip'));
      return new Response(decompressed, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=86400, immutable',
        },
      });
    }

    let contentType = res.headers.get('Content-Type') || 'application/octet-stream';
    if (lower.endsWith('.webp')) contentType = 'image/webp';
    else if (lower.endsWith('.webm')) contentType = 'video/webm';
    else if (lower.endsWith('.png')) contentType = 'image/png';
    else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) contentType = 'image/jpeg';

    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/**
 * Proxies a private Telegram photo/media file after signature verification.
 */
export async function handleSignedMediaProxy(env, fileId) {
  const cleanId = decodeURIComponent(String(fileId || '')).trim();
  if (!env.BOT_TOKEN || !/^[A-Za-z0-9_-]{16,180}$/.test(cleanId)) {
    return new Response(null, { status: 404 });
  }
  try {
    const fileInfo = await tgCall(env, 'getFile', { file_id: cleanId });
    const filePath = fileInfo?.result?.file_path;
    if (!filePath) return new Response(null, { status: 404 });

    const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
    if (!res.ok || !res.body) return new Response(null, { status: 404 });

    const lower = filePath.toLowerCase();

    // Animated Telegram stickers (.tgs) are gzip-compressed Lottie JSON
    if (lower.endsWith('.tgs')) {
      const decompressed = res.body.pipeThrough(new DecompressionStream('gzip'));
      return new Response(decompressed, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'private, max-age=1800',
        },
      });
    }

    let contentType = res.headers.get('Content-Type') || 'image/jpeg';
    if (lower.endsWith('.png')) contentType = 'image/png';
    else if (lower.endsWith('.webp')) contentType = 'image/webp';
    else if (lower.endsWith('.webm')) contentType = 'video/webm';
    else if (lower.endsWith('.gif')) contentType = 'image/gif';
    else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) contentType = 'image/jpeg';

    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=1800',
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
