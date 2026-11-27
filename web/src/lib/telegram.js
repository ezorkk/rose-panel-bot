// Telegram WebApp SDK helpers (gracefully works in both Telegram Mini App and browser preview)

import { DEFAULT_THEME_PRESET, getThemeChromeBg } from './themes.js';

export function getTelegramWebApp() {
  return typeof window !== 'undefined' ? window.Telegram?.WebApp || null : null;
}

export function syncTelegramChrome(theme = 'light', themePreset = DEFAULT_THEME_PRESET) {
  const bg = getThemeChromeBg(theme, themePreset);
  if (typeof document !== 'undefined') {
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute('content', bg);
    });
  }
  const tg = getTelegramWebApp();
  if (!tg) return;
  try {
    tg.setHeaderColor?.(bg);
    tg.setBackgroundColor?.(bg);
    tg.setBottomBarColor?.(bg);
  } catch {
    // Ignore on older Telegram clients
  }
}

export function initTelegramWebApp(themePreset = DEFAULT_THEME_PRESET) {
  const tg = getTelegramWebApp();
  if (!tg) return null;
  try {
    tg.ready();
    tg.expand();
    syncTelegramChrome(getTelegramColorScheme(), themePreset);
  } catch {
    // Ignore outside Telegram
  }
  return tg;
}

export function getTelegramUserId() {
  const tg = getTelegramWebApp();
  const id = tg?.initDataUnsafe?.user?.id;
  return id ? String(id) : '';
}

export function getTelegramInitData() {
  const tg = getTelegramWebApp();
  return tg?.initData || '';
}

export function getTelegramColorScheme() {
  const tg = getTelegramWebApp();
  if (tg?.colorScheme === 'dark' || tg?.colorScheme === 'light') {
    return tg.colorScheme;
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function getLaunchTarget() {
  const tg = getTelegramWebApp();
  const startParam = tg?.initDataUnsafe?.start_param || '';
  const params = new URLSearchParams(window.location.search);

  if (startParam.startsWith('visitor_')) {
    return { tab: 'visitors', visitorId: startParam.slice('visitor_'.length), settings: '' };
  }
  if (startParam.startsWith('settings_')) {
    return { tab: '', visitorId: '', settings: startParam.slice('settings_'.length) };
  }
  if (startParam === 'visitors') return { tab: 'visitors', visitorId: '', settings: '' };
  if (startParam === 'probe') return { tab: 'probe', visitorId: '', settings: '' };
  if (startParam === 'sites') return { tab: 'sites', visitorId: '', settings: '' };
  if (startParam === 'profile') return { tab: 'profile', visitorId: '', settings: '' };
  if (startParam === 'leaderboard') return { tab: 'leaderboard', visitorId: '', settings: '' };

  const queryTab = params.get('tab') || '';
  const visitorId = params.get('uid') || '';
  const settings = params.get('settings') || '';
  if (queryTab) {
    return { tab: queryTab, visitorId, settings };
  }
  // Share-poster QR code always opens the personal card regardless of custom navOrder
  if (startParam === 'src_poster' || params.get('src') === 'poster') {
    return { tab: 'profile', visitorId, settings };
  }
  return { tab: '', visitorId, settings };
}

const SOURCE_PARAM_RE = /^[a-z0-9_]{1,24}$/;

export const BUILTIN_SOURCE_LABELS = {
  poster: '分享海报',
  link: '名片链接',
  site: '个人小站',
  channel: '频道',
};

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
 * Reads the referral source channel from Telegram `start_param` (`src_<x>`) or URL query (`?src=<x>`).
 * Strictly requires `src_` prefix in `start_param` so existing Mini App params are never affected.
 */
export function getLaunchSource() {
  const tg = getTelegramWebApp();
  const startParam = String(tg?.initDataUnsafe?.start_param || '');
  if (startParam.startsWith('src_')) {
    const fromStart = normalizeSourceParam(startParam);
    if (fromStart) return fromStart;
  }
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = normalizeSourceParam(params.get('src') || '');
    if (fromQuery) return fromQuery;
  }
  return '';
}

export function haptic(type = 'light') {
  const tg = getTelegramWebApp();
  try {
    if (type === 'success' || type === 'warning' || type === 'error') {
      tg?.HapticFeedback?.notificationOccurred?.(type);
    } else if (type === 'selection') {
      tg?.HapticFeedback?.selectionChanged?.();
    } else {
      tg?.HapticFeedback?.impactOccurred?.(type);
    }
  } catch {
    // No-op outside Telegram
  }
}

// While a horizontal drag gesture is active, stop Telegram from treating vertical finger drift
// as "swipe down to minimize/close the Mini App" (Bot API 7.7+). Restores only what we changed.
let verticalSwipesLockedByUs = false;
export function lockVerticalSwipes(locked) {
  const tg = getTelegramWebApp();
  if (!tg) return;
  try {
    if (locked) {
      if (!verticalSwipesLockedByUs && tg.isVerticalSwipesEnabled !== false && typeof tg.disableVerticalSwipes === 'function') {
        tg.disableVerticalSwipes();
        verticalSwipesLockedByUs = true;
      }
    } else if (verticalSwipesLockedByUs) {
      verticalSwipesLockedByUs = false;
      tg.enableVerticalSwipes?.();
    }
  } catch {
    // Older Telegram clients do not support swipe control
  }
}

// Subscribe to Telegram theme changes (falls back to prefers-color-scheme in browsers).
export function onColorSchemeChange(callback) {
  const tg = getTelegramWebApp();
  const handler = () => callback(getTelegramColorScheme());
  if (tg && typeof tg.onEvent === 'function') {
    tg.onEvent('themeChanged', handler);
    return () => tg.offEvent?.('themeChanged', handler);
  }
  const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : null;
  if (mq?.addEventListener) {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }
  return () => {};
}

export function openExternalUrl(url) {
  if (!url) return;
  const tg = getTelegramWebApp();
  if (tg && /^https:\/\/t\.me\//i.test(url) && typeof tg.openTelegramLink === 'function') {
    tg.openTelegramLink(url);
    return;
  }
  if (tg && typeof tg.openLink === 'function') {
    tg.openLink(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// window.confirm is unreliable inside Telegram's in-app WebViews; prefer the native WebApp dialog.
export function confirmDialog(message) {
  const tg = getTelegramWebApp();
  if (tg && typeof tg.showConfirm === 'function') {
    return new Promise((resolve) => {
      try {
        tg.showConfirm(message, (ok) => resolve(Boolean(ok)));
      } catch {
        resolve(typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(message) : true);
      }
    });
  }
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return Promise.resolve(window.confirm(message));
  }
  return Promise.resolve(true);
}

export function closeMiniApp() {
  const tg = getTelegramWebApp();
  try {
    tg?.close?.();
  } catch {
    // Ignore outside Telegram
  }
}

export function isOpenedFromGroup() {
  const tg = getTelegramWebApp();
  const chatType = tg?.initDataUnsafe?.chat_type || '';
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') {
    return true;
  }
  const sp = String(tg?.initDataUnsafe?.start_param || '');
  return Boolean(sp);
}

export async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(String(text));
    haptic('light');
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = String(text);
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  }
}
