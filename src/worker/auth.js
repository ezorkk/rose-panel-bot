// Official Telegram Mini App initData HMAC-SHA256 verification & Admin authorization

import { resolveSupergroupId } from './config.js';

const encoder = new TextEncoder();

async function hmacSha256Raw(keyBytes, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generates a short-lived HMAC-SHA256 signature for private media proxy URLs
 * so private visitor chat photos can be displayed in <img> tags without leaking BOT_TOKEN
 * or exposing private media to unauthenticated requests.
 */
// Expiry is rounded up to a fixed window so the same file gets the SAME signed URL for the
// whole window. The panel re-fetches chat history every few seconds; if every fetch minted a
// new URL, images would reload and animated stickers would restart (and flash) on each poll.
export const MEDIA_TOKEN_BUCKET_SECONDS = 600;

export async function signMediaToken(fileId, botToken, ttlSeconds = 1800, bucketSeconds = MEDIA_TOKEN_BUCKET_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.max(1, Math.floor(Number(bucketSeconds) || 1));
  // Always valid for at least ttlSeconds (at most ttlSeconds + bucket).
  const exp = Math.ceil((now + ttlSeconds) / bucket) * bucket;
  const key = encoder.encode(`RoseMedia:${botToken || 'dev'}`);
  const sigBytes = await hmacSha256Raw(key, `${fileId}:${exp}`);
  return { exp, sig: toHex(sigBytes) };
}

export async function verifyMediaToken(fileId, expStr, sigHex, botToken) {
  const exp = Number(expStr || 0);
  if (!fileId || !exp || !sigHex || Number.isNaN(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const key = encoder.encode(`RoseMedia:${botToken || 'dev'}`);
  const expected = toHex(await hmacSha256Raw(key, `${fileId}:${exp}`));
  return timingSafeEqualHex(expected, String(sigHex).toLowerCase());
}

/**
 * Verifies Telegram WebApp initData according to Telegram's specification:
 * secret_key = HMAC_SHA256("WebAppData", bot_token)
 * hash = hex(HMAC_SHA256(secret_key, data_check_string))
 */
export async function verifyTelegramInitData(initDataRaw, botToken, maxAgeSeconds = 86400) {
  if (!initDataRaw || !botToken) {
    return { ok: false, error: 'Missing initData or BOT_TOKEN' };
  }

  const params = new URLSearchParams(initDataRaw);
  const providedHash = params.get('hash');
  if (!providedHash) {
    return { ok: false, error: 'Missing hash in initData' };
  }

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Number.isNaN(authDate)) {
    return { ok: false, error: 'Invalid auth_date' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (maxAgeSeconds > 0 && nowSec - authDate > maxAgeSeconds) {
    return { ok: false, error: 'initData expired' };
  }

  const entries = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    entries.push([key, value]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = await hmacSha256Raw(encoder.encode('WebAppData'), botToken);
  const computedBytes = await hmacSha256Raw(secretKey, dataCheckString);
  const computedHex = toHex(computedBytes);

  if (!timingSafeEqualHex(computedHex, providedHash.toLowerCase())) {
    return { ok: false, error: 'Invalid initData signature' };
  }

  let user = null;
  const userStr = params.get('user');
  if (userStr) {
    try {
      user = JSON.parse(userStr);
    } catch {
      return { ok: false, error: 'Invalid user payload in initData' };
    }
  }

  return {
    ok: true,
    user,
    authDate,
    startParam: params.get('start_param') || '',
    chatType: params.get('chat_type') || '',
    chatInstance: params.get('chat_instance') || '',
  };
}

export function parseAdminIds(env) {
  const raw = String(env.ADMIN_IDS || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export async function isUserAdmin(env, userId, tgCallFn = null) {
  if (!userId) return false;
  const uid = String(userId);
  const configuredAdmins = parseAdminIds(env);
  // Fast path: when ADMIN_IDS is explicitly configured, verify in-memory (<0.1ms, 0 KV / 0 TG API calls)
  if (configuredAdmins.size > 0) {
    return configuredAdmins.has(uid);
  }

  // Fallback: check supergroup administrator status if a Forum Supergroup is bound & BOT_TOKEN exists
  const supergroupId = await resolveSupergroupId(env);
  if (!supergroupId || !env.BOT_TOKEN || !tgCallFn) return false;

  const cacheKey = `admin_cache:${uid}`;
  if (env.TOPIC_MAP) {
    const cached = await env.TOPIC_MAP.get(cacheKey);
    if (cached === '1') return true;
    if (cached === '0') return false;
  }

  try {
    const res = await tgCallFn(env, 'getChatMember', {
      chat_id: supergroupId,
      user_id: Number(uid),
    });
    const status = res?.result?.status;
    const isAdmin = status === 'creator' || status === 'administrator';
    if (env.TOPIC_MAP) {
      await env.TOPIC_MAP.put(cacheKey, isAdmin ? '1' : '0', { expirationTtl: 300 });
    }
    return isAdmin;
  } catch {
    return false;
  }
}

const LOCAL_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocalPreviewHost(request) {
  try {
    const host = new URL(request.url).hostname.toLowerCase();
    return LOCAL_PREVIEW_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

export async function authenticateRequest(request, env, tgCallFn = null) {
  const initData = request.headers.get('X-Telegram-Init-Data') || '';

  if (initData) {
    const verified = await verifyTelegramInitData(initData, env.BOT_TOKEN);
    if (!verified.ok || !verified.user) {
      return { ok: false, status: 401, error: verified.error || 'Unauthorized' };
    }
    const admin = await isUserAdmin(env, verified.user.id, tgCallFn);
    return {
      ok: true,
      user: verified.user,
      isAdmin: admin,
      startParam: verified.startParam,
      chatType: verified.chatType,
      isPreview: false,
    };
  }

  // Strictly opt-in local preview mode for browser testing.
  // Only honoured on local hosts so an accidental DEV_PREVIEW="true" in production
  // can never elevate anonymous browser visitors to admin.
  if (String(env.DEV_PREVIEW || '').toLowerCase() === 'true' && isLocalPreviewHost(request)) {
    const roleHeader = request.headers.get('X-Dev-Role') || 'guest';
    const isAdmin = roleHeader === 'admin';
    const devUser = isAdmin
      ? {
          id: Number(Array.from(parseAdminIds(env))[0] || 100001),
          first_name: 'Rose',
          last_name: '',
          username: 'rose_owner',
          language_code: 'zh-hans',
        }
      : {
          id: 200002,
          first_name: '星河旅人',
          last_name: '',
          username: 'stargazer',
          language_code: 'zh-hans',
        };
    return {
      ok: true,
      user: devUser,
      isAdmin,
      startParam: '',
      chatType: isAdmin ? 'private' : 'supergroup',
      isPreview: true,
    };
  }

  // Allow public read-only guest access for non-sensitive pages if opened outside TG
  return {
    ok: true,
    user: null,
    isAdmin: false,
    startParam: '',
    chatType: 'web',
    isPreview: false,
  };
}
