import { getTelegramInitData } from './telegram.js';

let devRole = 'admin';

export function setDevRole(role) {
  devRole = role;
}

export function getDevRole() {
  return devRole;
}

export async function apiRequest(path, requestOptions = {}) {
  // `timeoutMs` (optional) aborts a request that hangs, e.g. while the Mini App sits in the
  // background, so callers that guard against overlapping requests don't stay blocked forever.
  const { timeoutMs = 0, ...options } = requestOptions;
  const headers = {
    ...(options.headers || {}),
  };
  const initData = getTelegramInitData();
  if (initData) {
    headers['X-Telegram-Init-Data'] = initData;
  } else {
    headers['X-Dev-Role'] = devRole;
  }
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isForm) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = timeoutMs > 0 && typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  // FormData must be passed through untouched so the browser sets the multipart boundary itself
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers,
      ...(controller ? { signal: controller.signal } : {}),
      body:
        options.body && !isForm && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    });
  } catch (err) {
    if (controller?.signal.aborted) throw new Error('请求超时，请稍后重试');
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export function formatBytes(bytes = 0) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / 1024 ** idx;
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`;
}

export function formatSpeed(bytesPerSec = 0) {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatUptime(seconds = 0) {
  const s = Number(seconds) || 0;
  if (s <= 0) return '离线';
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  if (days > 0) return `在线 ${days} 天 ${hours} 时`;
  const mins = Math.floor((s % 3600) / 60);
  if (hours > 0) return `在线 ${hours} 时 ${mins} 分`;
  return `在线 ${mins} 分`;
}

export function formatTimeAgo(isoString) {
  if (!isoString) return '未知';
  const ts = Date.parse(isoString);
  if (Number.isNaN(ts)) return '未知';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  const days = Math.floor(diffSec / 86400);
  if (days < 30) return `${days} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
