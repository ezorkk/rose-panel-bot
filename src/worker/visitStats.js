// Monthly unique visitor counter (per Telegram UID, per owner-timezone month).
// Designed to stay well inside Cloudflare KV free-tier write quotas:
//   - Repeat opens by the same visitor in the same month perform 1 KV read and 0 KV writes.
//   - First open by a new visitor in the month performs 2 KV reads and 2 KV writes.
//   - Every operation is fail-open so counting errors can NEVER block opening the card.
//
// Known limitation: Cloudflare KV does not support atomic increment; if two brand-new
// visitors open the card at the exact same millisecond, the monthly total can undercount
// by 1. This trade-off is acceptable for personal card traffic.

import { safeGetJSON, safePutJSON } from './config.js';

export const VISIT_SEEN_TTL_SECONDS = 40 * 86400; // 40 days — covers any calendar month safely
export const VISIT_COUNT_TTL_SECONDS = 400 * 86400; // 400 days — retains thisMonth & lastMonth across years

/**
 * Computes current and previous month keys (`YYYYMM`) in the owner's configured timezone.
 */
export function getMonthKeys(nowDate = new Date(), offsetHours = 8) {
  const safeOffset = Number.isFinite(Number(offsetHours)) ? Number(offsetHours) : 8;
  const date = nowDate instanceof Date ? nowDate : new Date(nowDate);
  const shifted = new Date(date.getTime() + safeOffset * 3600 * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;

  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;

  return {
    thisMonthKey: `${year}${String(month).padStart(2, '0')}`,
    lastMonthKey: `${prevYear}${String(prevMonth).padStart(2, '0')}`,
  };
}

/**
 * Records a unique monthly visit for a Telegram user.
 * Repeat visits in the same month return immediately with ZERO KV writes.
 * Any KV or runtime error is swallowed so opening the card is never impacted.
 */
export async function recordMonthlyVisit(env, uid, config = null, nowDate = new Date()) {
  try {
    if (!env?.TOPIC_MAP) return { recorded: false };
    const cleanUid = String(uid ?? '').trim();
    if (!/^\d+$/.test(cleanUid)) return { recorded: false };

    const offsetHours = config?.community?.timezoneOffsetHours ?? 8;
    const { thisMonthKey } = getMonthKeys(nowDate, offsetHours);
    const seenKey = `visit:seen:${thisMonthKey}:${cleanUid}`;

    const alreadySeen = await env.TOPIC_MAP.get(seenKey);
    if (alreadySeen) {
      return { recorded: false, monthKey: thisMonthKey };
    }

    await env.TOPIC_MAP.put(seenKey, '1', { expirationTtl: VISIT_SEEN_TTL_SECONDS });

    const countKey = `visit:count:${thisMonthKey}`;
    const current = await safeGetJSON(env.TOPIC_MAP, countKey, null);
    const nextCount = Math.max(0, Number(current?.n) || 0) + 1;
    await safePutJSON(env.TOPIC_MAP, countKey, { n: nextCount }, { expirationTtl: VISIT_COUNT_TTL_SECONDS });

    return { recorded: true, monthKey: thisMonthKey, count: nextCount };
  } catch {
    return { recorded: false };
  }
}

/**
 * Reads monthly unique visitor totals (1–2 KV reads, 0 KV writes).
 */
export async function getVisitStats(env, config = null, nowDate = new Date(), options = {}) {
  const { includeLastMonth = true } = options;
  try {
    if (!env?.TOPIC_MAP) {
      return includeLastMonth ? { thisMonth: 0, lastMonth: 0 } : { thisMonth: 0 };
    }
    const offsetHours = config?.community?.timezoneOffsetHours ?? 8;
    const { thisMonthKey, lastMonthKey } = getMonthKeys(nowDate, offsetHours);

    if (!includeLastMonth) {
      const thisRec = await safeGetJSON(env.TOPIC_MAP, `visit:count:${thisMonthKey}`, null);
      return { thisMonth: Math.max(0, Number(thisRec?.n) || 0) };
    }

    const [thisRec, lastRec] = await Promise.all([
      safeGetJSON(env.TOPIC_MAP, `visit:count:${thisMonthKey}`, null),
      safeGetJSON(env.TOPIC_MAP, `visit:count:${lastMonthKey}`, null),
    ]);
    return {
      thisMonth: Math.max(0, Number(thisRec?.n) || 0),
      lastMonth: Math.max(0, Number(lastRec?.n) || 0),
    };
  } catch {
    return includeLastMonth ? { thisMonth: 0, lastMonth: 0 } : { thisMonth: 0 };
  }
}
