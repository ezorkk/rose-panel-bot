// Monthly unique visitor counter (per Telegram UID, per owner-timezone month).
//   - D1 mode (`env.DB` bound): atomic `INSERT OR IGNORE INTO visit_seen` + `COUNT(*)` (0 KV writes,
//     no concurrent undercounting).
//   - KV mode (no `env.DB`): repeat opens perform 1 KV read / 0 KV writes; first open performs
//     2 KV reads / 2 KV writes (`visit:seen:*`, `visit:count:*`).
//   - Every operation is fail-open so counting errors can NEVER block opening the card.

import { VISIT_COUNT_TTL_SECONDS, VISIT_SEEN_TTL_SECONDS, getStore } from './store/index.js';

export { VISIT_COUNT_TTL_SECONDS, VISIT_SEEN_TTL_SECONDS };

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
 * Any D1/KV or runtime error is swallowed so opening the card is never impacted.
 */
export async function recordMonthlyVisit(env, uid, config = null, nowDate = new Date()) {
  try {
    if (!env?.DB && !env?.TOPIC_MAP) return { recorded: false };
    const cleanUid = String(uid ?? '').trim();
    if (!/^\d+$/.test(cleanUid)) return { recorded: false };

    const offsetHours = config?.community?.timezoneOffsetHours ?? 8;
    const { thisMonthKey } = getMonthKeys(nowDate, offsetHours);
    return await getStore(env).recordMonthlyVisit(thisMonthKey, cleanUid);
  } catch {
    return { recorded: false };
  }
}

/**
 * Reads monthly unique visitor totals (fail-open).
 */
export async function getVisitStats(env, config = null, nowDate = new Date(), options = {}) {
  const { includeLastMonth = true } = options;
  try {
    if (!env?.DB && !env?.TOPIC_MAP) {
      return includeLastMonth ? { thisMonth: 0, lastMonth: 0 } : { thisMonth: 0 };
    }
    const offsetHours = config?.community?.timezoneOffsetHours ?? 8;
    const { thisMonthKey, lastMonthKey } = getMonthKeys(nowDate, offsetHours);
    return await getStore(env).getMonthlyVisitCounts(thisMonthKey, includeLastMonth ? lastMonthKey : null);
  } catch {
    return includeLastMonth ? { thisMonth: 0, lastMonth: 0 } : { thisMonth: 0 };
  }
}
