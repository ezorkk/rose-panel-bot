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

  // Fast exact match on the oldest message of the polled tail (`latest[0]`):
  // Since `existing` is strictly ordered `(created_at ASC, rowid ASC)`, everything strictly before
  // `firstLatestIdx` is guaranteed older than `latest[0]` (even with identical millisecond timestamps).
  const firstLatestIdx = existing.findIndex((m) => m?.id === latest[0]?.id);
  if (firstLatestIdx > 0) {
    return {
      messages: [...existing.slice(0, firstLatestIdx), ...latest],
      hasMore: Boolean(existingState?.hasMore),
      oldestCursor: existingState?.oldestCursor || latestOldest,
      newestCursor: latestNewest,
    };
  }
  if (firstLatestIdx === 0) {
    return {
      messages: latest,
      hasMore: latestHasMore,
      oldestCursor: latestOldest,
      newestCursor: latestNewest,
    };
  }

  // `latest[0]` is not in `existing` (e.g. `existing[0]` was deleted on the server so the 60-message tail
  // shifted backward to an unloaded older message `M-1`, or >60 brand-new messages arrived).
  // Only retain messages from `existing` strictly older than `latest[0]`'s timestamp (`latestStartTs`),
  // dropping any deleted boundary messages that were >= `latestStartTs`.
  const latestIds = new Set(latest.map((m) => m?.id).filter(Boolean));
  const hasOverlap = existing.some((m) => latestIds.has(m?.id));
  const latestStartTs = Number(latestOldest?.ts) || Date.parse(latest[0]?.at || '');
  if (hasOverlap && Number.isFinite(latestStartTs) && latestStartTs > 0) {
    const strictlyOlder = existing.filter((m) => {
      if (latestIds.has(m?.id)) return false;
      const ts = Date.parse(m?.at || '');
      return Number.isFinite(ts) && ts < latestStartTs;
    });
    if (strictlyOlder.length > 0) {
      return {
        messages: [...strictlyOlder, ...latest],
        hasMore: Boolean(existingState?.hasMore),
        oldestCursor: existingState?.oldestCursor || latestOldest,
        newestCursor: latestNewest,
      };
    }
  }

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
 * Uses an escaped case-insensitive RegExp directly against `source` so indices always stay aligned
 * in UTF-16 coordinates even for Unicode characters whose `.toLowerCase()` length differs (e.g. `İ`).
 */
export function splitHighlightSegments(text = '', query = '') {
  const source = String(text || '');
  const needle = String(query || '').trim();
  if (!source || !needle) return [{ text: source, match: false }];

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  const segments = [];
  let pos = 0;
  let match;

  while ((match = re.exec(source)) !== null) {
    if (match[0].length === 0) break;
    if (match.index > pos) {
      segments.push({ text: source.slice(pos, match.index), match: false });
    }
    segments.push({ text: match[0], match: true });
    pos = match.index + match[0].length;
  }

  if (pos < source.length) {
    segments.push({ text: source.slice(pos), match: false });
  }

  return segments.length > 0 ? segments : [{ text: source, match: false }];
}
