// Pure helpers for D1 full-history pagination, live-poll tail window replacement,
// cursor URL building, and XSS-safe search keyword highlighting.

export const HISTORY_PAGE_SIZE = 60;

function isPositiveSafeInt(val) {
  const n = Number(val);
  return Number.isSafeInteger(n) && n > 0;
}

/**
 * Merges a freshly polled latest page (`latestRes`, up to 60 newest messages) into the
 * currently displayed chat history (`existingState`).
 *
 * CRITICAL: Replaces the entire overlapping tail window (starting from the first message ID
 * that appears in `latestRes.messages`) rather than merely appending new messages. This ensures
 * message recalls and reaction updates inside the latest window are reflected immediately while
 * any older messages previously loaded via scroll-up pagination remain intact.
 */
export function mergeLatestHistoryTail(existingState = {}, latestRes = {}) {
  const existing = Array.isArray(existingState?.messages) ? existingState.messages : [];
  const latest = Array.isArray(latestRes?.messages) ? latestRes.messages : [];
  const latestHasMore = Boolean(latestRes?.hasMore);
  const latestOldest = latestRes?.oldestCursor || null;
  const latestNewest = latestRes?.newestCursor || null;

  // Empty latest page means history was cleared on the server.
  if (latest.length === 0) {
    return {
      messages: [],
      hasMore: false,
      oldestCursor: null,
      newestCursor: null,
    };
  }

  // Server returned the entire conversation (no older messages exist).
  if (!latestHasMore || existing.length === 0) {
    return {
      messages: latest,
      hasMore: latestHasMore,
      oldestCursor: latestOldest,
      newestCursor: latestNewest,
    };
  }

  const latestIds = new Set(latest.map((m) => m?.id).filter(Boolean));
  const cutIdx = existing.findIndex((m) => latestIds.has(m?.id));

  // Overlap starts after scrolled-up older messages: keep older prefix untouched, replace tail window.
  if (cutIdx > 0) {
    return {
      messages: [...existing.slice(0, cutIdx), ...latest],
      hasMore: Boolean(existingState?.hasMore),
      oldestCursor: existingState?.oldestCursor || latestOldest,
      newestCursor: latestNewest,
    };
  }

  // Overlap starts at index 0 (no older prefix loaded) OR completely disjoint (>60 new messages arrived):
  // adopt the latest server window directly so there is never an invisible unscrollable gap.
  return {
    messages: latest,
    hasMore: latestHasMore,
    oldestCursor: latestOldest,
    newestCursor: latestNewest,
  };
}

/**
 * Prepends an older page onto `existingMessages` while deduplicating by `id`.
 */
export function prependOlderHistory(existingMessages = [], olderMessages = []) {
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const older = Array.isArray(olderMessages) ? olderMessages : [];
  if (older.length === 0) return existing;
  const existingIds = new Set(existing.map((m) => m?.id).filter(Boolean));
  const uniqueOlder = older.filter((m) => m?.id && !existingIds.has(m.id));
  return [...uniqueOlder, ...existing];
}

/**
 * Appends a newer page onto `existingMessages` while deduplicating by `id`.
 */
export function appendNewerHistory(existingMessages = [], newerMessages = []) {
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const newer = Array.isArray(newerMessages) ? newerMessages : [];
  if (newer.length === 0) return existing;
  const existingIds = new Set(existing.map((m) => m?.id).filter(Boolean));
  const uniqueNewer = newer.filter((m) => m?.id && !existingIds.has(m.id));
  return [...existing, ...uniqueNewer];
}

/**
 * Builds `/api/admin/visitors/:uid/history` URL with strictly validated integer cursor params.
 */
export function buildHistoryUrl(uid, options = {}) {
  const params = new URLSearchParams();
  const limit = isPositiveSafeInt(options.limit) ? Number(options.limit) : HISTORY_PAGE_SIZE;
  params.set('limit', String(limit));

  if (options.around) {
    params.set('around', String(options.around).trim());
  } else if (options.beforeCursor && isPositiveSafeInt(options.beforeCursor.ts)) {
    params.set('before', String(options.beforeCursor.ts));
    if (isPositiveSafeInt(options.beforeCursor.id)) {
      params.set('beforeId', String(options.beforeCursor.id));
    }
  } else if (options.afterCursor && isPositiveSafeInt(options.afterCursor.ts)) {
    params.set('after', String(options.afterCursor.ts));
    if (isPositiveSafeInt(options.afterCursor.id)) {
      params.set('afterId', String(options.afterCursor.id));
    }
  }

  if (options.messagesOnly) {
    params.set('messagesOnly', '1');
  }

  return `/api/admin/visitors/${encodeURIComponent(String(uid))}/history?${params.toString()}`;
}

/**
 * Builds `/api/admin/search` URL with strictly validated query & cursor params.
 */
export function buildSearchUrl(options = {}) {
  const params = new URLSearchParams();
  const q = String(options.q || '').trim();
  if (q) params.set('q', q);
  if (options.uid && /^\d+$/.test(String(options.uid).trim())) {
    params.set('uid', String(options.uid).trim());
  }
  if (options.from) params.set('from', String(options.from));
  if (options.to) params.set('to', String(options.to));
  if (isPositiveSafeInt(options.limit)) params.set('limit', String(options.limit));
  if (options.cursor && isPositiveSafeInt(options.cursor.before)) {
    params.set('before', String(options.cursor.before));
    if (isPositiveSafeInt(options.cursor.beforeId)) {
      params.set('beforeId', String(options.cursor.beforeId));
    }
  }
  return `/api/admin/search?${params.toString()}`;
}

/**
 * Splits text into plain & matched segments for safe React highlighting (no raw HTML injection).
 */
export function splitHighlightSegments(text = '', query = '') {
  const source = String(text || '');
  const needle = String(query || '').trim();
  if (!source || !needle) return [{ text: source, match: false }];

  const lowerSource = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const segments = [];
  let pos = 0;

  while (pos < source.length) {
    const idx = lowerSource.indexOf(lowerNeedle, pos);
    if (idx < 0) {
      segments.push({ text: source.slice(pos), match: false });
      break;
    }
    if (idx > pos) {
      segments.push({ text: source.slice(pos, idx), match: false });
    }
    segments.push({ text: source.slice(idx, idx + needle.length), match: true });
    pos = idx + needle.length;
  }

  return segments.length > 0 ? segments : [{ text: source, match: false }];
}
