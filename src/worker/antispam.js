// 4-Layer Anti-Spam Shield for RosePanel Bot:
// 1. Combot Anti-Spam (CAS) global blacklist lookup with KV caching (fail-open)
// 2. Unicode de-obfuscation (zero-width stripping, NFKC full-width folding, Cyrillic homoglyph folding)
// 3. Heuristic risk scoring (forwarded ads, external/t.me links, zero-width tricks, ad profile names, blocked keywords)
// 4. Intercepted spam counter in KV for admin visibility

const ZERO_WIDTH_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

// Common Cyrillic/Greek homoglyphs spammers use to bypass Latin keyword/link filters
const HOMOGLYPH_MAP = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  к: 'k',
  м: 'm',
  т: 't',
  н: 'h',
  в: 'b',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ɡ: 'g',
  ν: 'v',
};

const SPAM_STATS_KEY = 'stats:blocked_spam';
export const BLOCKED_DAILY_TTL_SECONDS = 3 * 86400; // 3 days

export function getBlockedDateKey(nowDate = new Date(), offsetHours = 8) {
  const safeOffset = Number.isFinite(Number(offsetHours)) ? Number(offsetHours) : 8;
  const date = nowDate instanceof Date ? nowDate : new Date(nowDate);
  const shifted = new Date(date.getTime() + safeOffset * 3600 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export const PROBATION_REASON_LABELS = {
  link: '含链接',
  forwarded: '转发消息',
  mention: '含 @用户名',
  contact: '含联系方式',
};

const LINK_TOKEN_RE = /(?:https?:\/\/|t\.me\/|telegram\.me\/|wa\.me\/)[^\s<>"'`\u4e00-\u9fa5，。！？；：】）)]+/gi;
const MENTION_RE = /(?:^|[^a-z0-9_.])@[a-z0-9_]{5,}/i;
const PHONE_NUMBER_RE = /(?:^|[^\d])(\d(?:[ \t-]{0,2}\d){6,})(?=$|[^\d])/g;
const ISO_DATE_RE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const WECHAT_CONTACT_RE =
  /(?:微信(?:号)?(?:[^\S\n]|号|是|为|[:：=+\-—，,、]){0,6}[a-z0-9_][a-z0-9_-]{3,}|(?<![a-z0-9])(?:vx|wx)(?:(?:[^\S\n]|号|是|为|[:：=+\-—，,、]){1,6}[a-z0-9_][a-z0-9_-]{3,}|_[a-z0-9_-]{3,}|[0-9][a-z0-9_-]{4,})|(?:加我|联系我)(?:[^\S\n]|号|是|为|微信|vx|wx|qq|tg|[:：=+\-—，,、]){0,8}[a-z0-9][a-z0-9_-]{4,})/i;

export function formatProbationReasons(reasons = []) {
  const labels = (Array.isArray(reasons) ? reasons : [])
    .map((r) => PROBATION_REASON_LABELS[r] || String(r || ''))
    .filter(Boolean);
  return labels.join(' · ') || '可疑内容';
}

export function normalizeDomain(raw = '') {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/[/?#].*$/, '');
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
  return s;
}

export function isDomainAllowed(hostname, allowDomains = []) {
  const host = normalizeDomain(hostname);
  if (!host) return false;
  for (const rawAllowed of Array.isArray(allowDomains) ? allowDomains : []) {
    const allowed = normalizeDomain(rawAllowed);
    if (!allowed) continue;
    if (host === allowed || host.endsWith(`.${allowed}`)) {
      return true;
    }
  }
  return false;
}

function parseLinkHostname(raw) {
  const trimmed = String(raw || '').trim().replace(/[),.;!?，。！？；：】）]+$/, '');
  if (!trimmed) return '';
  let withScheme = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(withScheme)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(withScheme)) return '';
    withScheme = `https://${withScheme}`;
  }
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return String(u.hostname || '').toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function stripAllowedUrls(text, allowDomains) {
  if (!text || !Array.isArray(allowDomains) || allowDomains.length === 0) return text;
  return String(text).replace(LINK_TOKEN_RE, (match) => {
    const host = parseLinkHostname(match);
    return host && isDomainAllowed(host, allowDomains) ? ' ' : match;
  });
}

function hasPhoneNumber(text) {
  if (!text) return false;
  PHONE_NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = PHONE_NUMBER_RE.exec(text)) !== null) {
    const candidate = String(m[1] || '').trim();
    if (!candidate) continue;
    if (ISO_DATE_RE.test(candidate)) continue;
    return true;
  }
  return false;
}

/**
 * Strips invisible zero-width characters, folds full-width Unicode (NFKC),
 * and normalizes common homoglyphs into clean lowercase text for reliable matching.
 */
export function normalizeAntiSpamText(raw = '') {
  const input = String(raw || '');
  const zeroWidthMatches = input.match(ZERO_WIDTH_REGEX);
  const zeroWidthCount = zeroWidthMatches ? zeroWidthMatches.length : 0;

  const stripped = input.replace(ZERO_WIDTH_REGEX, '').normalize('NFKC').toLowerCase();
  let folded = '';
  for (const ch of stripped) {
    folded += HOMOGLYPH_MAP[ch] || ch;
  }

  return {
    normalized: folded,
    zeroWidthCount,
  };
}

export function parseBlockedKeywords(raw = '') {
  if (Array.isArray(raw)) {
    return raw.map((k) => normalizeAntiSpamText(k).normalized.trim()).filter(Boolean);
  }
  return String(raw || '')
    .split(/[\n,，;；]+/)
    .map((k) => normalizeAntiSpamText(k).normalized.trim())
    .filter(Boolean);
}

/**
 * Layer 1: Checks Combot Anti-Spam (CAS) global spammer database (`https://api.cas.chat/check`).
 * Cached in KV (24h for flagged spammers, 6h for clean accounts). Fails open on network errors.
 */
export async function checkCasBlacklist(env, userId, fetchFn = fetch) {
  const uid = String(userId || '');
  if (!/^\d+$/.test(uid)) return { isSpammer: false, cached: false };

  const cacheKey = `cas:${uid}`;
  if (env.TOPIC_MAP) {
    const cached = await env.TOPIC_MAP.get(cacheKey);
    if (cached === '1') return { isSpammer: true, cached: true };
    if (cached === '0') return { isSpammer: false, cached: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetchFn(`https://api.cas.chat/check?user_id=${encodeURIComponent(uid)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { isSpammer: false, cached: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const isSpammer = Boolean(data?.ok === true);

    if (env.TOPIC_MAP) {
      await env.TOPIC_MAP.put(cacheKey, isSpammer ? '1' : '0', {
        expirationTtl: isSpammer ? 86400 : 21600,
      });
    }
    return { isSpammer, cached: false, offenses: data?.result?.offenses || 0 };
  } catch (err) {
    // Always fail open so legitimate users are never locked out if CAS is slow/unreachable
    return { isSpammer: false, cached: false, error: err?.message || 'timeout' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Layer 2 & 4: Evaluates incoming or edited message for spam signals & blocked keywords.
 */
export function assessIncomingRisk(msg = {}, pmBotConfig = {}) {
  const rawText = String(msg.text || msg.caption || '');
  const rawName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ');

  const textInfo = normalizeAntiSpamText(rawText);
  const nameInfo = normalizeAntiSpamText(rawName);
  const combinedNorm = `${textInfo.normalized}\n${nameInfo.normalized}`;

  const reasons = [];

  // 1. Forwarded message from a channel or third party (classic ad broadcast)
  const isForwarded = Boolean(
    msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name
  );
  if (isForwarded) reasons.push('forwarded');

  // 1b. Unsolicited photo / video / animation / document poster (classic USDT/casino/VPN flyer ad)
  const isMedia = Boolean(
    (Array.isArray(msg.photo) && msg.photo.length > 0) ||
      msg.video ||
      msg.animation ||
      msg.document ||
      msg.sticker
  );
  if (isMedia && pmBotConfig.blockUnverifiedMedia !== false) {
    reasons.push('unverified_media');
  }

  // 2. Contains external URL or t.me link (in text or hidden text_link entity)
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const hasEntityLink = entities.some(
    (e) => e.type === 'url' || e.type === 'text_link' || (e.type === 'mention' && rawText.length > 40)
  );
  const hasRegexLink = /(?:https?:\/\/|t\.me\/|telegram\.me\/|wa\.me\/)/i.test(textInfo.normalized);
  if (hasEntityLink || hasRegexLink) reasons.push('contains_link');

  // 3. Zero-width invisible character obfuscation
  if (textInfo.zeroWidthCount >= 3 || nameInfo.zeroWidthCount >= 3) {
    reasons.push('zero_width_obfuscation');
  }

  // 4. Profile display name advertises a link/domain (Bio/Name spam)
  if (/(?:https?:\/\/|t\.me\/|\.(?:com|net|org|vip|xyz|cc|top|shop)\b)/i.test(nameInfo.normalized)) {
    reasons.push('suspicious_profile_name');
  }

  // 5. Admin custom blocked keywords (evaluated after de-obfuscation!)
  const keywords = parseBlockedKeywords(pmBotConfig.blockedKeywords || '');
  const matchedKeyword = keywords.find((kw) => kw && combinedNorm.includes(kw)) || '';
  if (matchedKeyword) {
    reasons.push(`blocked_keyword:${matchedKeyword}`);
  }

  return {
    isBlockedKeyword: Boolean(matchedKeyword),
    matchedKeyword,
    isHighRisk: reasons.length > 0,
    isForwarded,
    isMedia,
    hasLink: hasEntityLink || hasRegexLink,
    reasons,
  };
}

/**
 * Evaluates whether a verified visitor's message during the new-visitor probation window
 * should be held for admin review.
 * Suspicious signals (any triggers hold):
 *   - Non-whitelisted link (including t.me / telegram.me / wa.me / url & text_link entities)
 *   - Forwarded message
 *   - @username mention (mention entity or @[A-Za-z0-9_]{5,})
 *   - Contact info (7+ digit phone number allowing spaces/hyphens, or WeChat/VX/wx/加我/联系我 + handle)
 * Media alone (photo/video/file/sticker) is intentionally NOT suspicious after verification.
 */
export function assessProbationRisk(msg = {}, pmBotConfig = {}) {
  const baseRisk = assessIncomingRisk(msg, pmBotConfig);
  const rawText = String(msg.text || msg.caption || '');
  const textInfo = normalizeAntiSpamText(rawText);
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const allowDomains = Array.isArray(pmBotConfig?.probation?.allowDomains)
    ? pmBotConfig.probation.allowDomains
    : [];

  // 1. Links: extract from entities, raw text (catches IDN/homoglyph spoofing), and normalized text
  const linkCandidates = [];
  for (const ent of entities) {
    if (ent.type === 'text_link') {
      linkCandidates.push(String(ent.url || ''));
    } else if (ent.type === 'url') {
      if (typeof ent.offset === 'number' && typeof ent.length === 'number') {
        linkCandidates.push(rawText.slice(ent.offset, ent.offset + ent.length));
      } else {
        linkCandidates.push('');
      }
    }
  }
  const rawMatches = rawText.match(LINK_TOKEN_RE) || [];
  const normMatches = textInfo.normalized.match(LINK_TOKEN_RE) || [];
  linkCandidates.push(...rawMatches, ...normMatches);

  let hasUnallowedLink = false;
  if (linkCandidates.length > 0) {
    for (const candidate of linkCandidates) {
      const host = parseLinkHostname(candidate);
      if (!host || !isDomainAllowed(host, allowDomains)) {
        hasUnallowedLink = true;
        break;
      }
    }
  }

  // Strip whitelisted URLs before mention / contact checks so allowed links with digits or @paths don't false-trigger
  const rawWithoutAllowed = stripAllowedUrls(rawText, allowDomains);
  const normWithoutAllowed = stripAllowedUrls(textInfo.normalized, allowDomains);

  // 2. Forwarded message
  const isForwarded = baseRisk.isForwarded;

  // 3. @username mention
  const hasEntityMention = entities.some((e) => e.type === 'mention');
  const hasMention = hasEntityMention || MENTION_RE.test(rawWithoutAllowed) || MENTION_RE.test(normWithoutAllowed);

  // 4. Contact info (phone number or WeChat/VX/wx/加我/联系我 + account-like token)
  const hasContact = hasPhoneNumber(normWithoutAllowed) || WECHAT_CONTACT_RE.test(normWithoutAllowed);

  const reasons = [];
  if (hasUnallowedLink) reasons.push('link');
  if (isForwarded) reasons.push('forwarded');
  if (hasMention) reasons.push('mention');
  if (hasContact) reasons.push('contact');

  return {
    isSuspicious: reasons.length > 0,
    hasLink: hasUnallowedLink,
    isForwarded,
    hasMention,
    hasContact,
    reasons,
  };
}

export async function recordBlockedSpam(env, config = null, nowDate = new Date()) {
  if (!env.TOPIC_MAP) return 0;
  const offsetHours = config?.community?.timezoneOffsetHours ?? 8;
  const dailyKey = `stats:blocked:${getBlockedDateKey(nowDate, offsetHours)}`;
  const [curTotalRaw, curDailyRaw] = await Promise.all([
    env.TOPIC_MAP.get(SPAM_STATS_KEY),
    env.TOPIC_MAP.get(dailyKey),
  ]);
  const nextTotal = Number(curTotalRaw || 0) + 1;
  const nextDaily = Number(curDailyRaw || 0) + 1;
  await Promise.all([
    env.TOPIC_MAP.put(SPAM_STATS_KEY, String(nextTotal)),
    env.TOPIC_MAP.put(dailyKey, String(nextDaily), { expirationTtl: BLOCKED_DAILY_TTL_SECONDS }),
  ]);
  return nextTotal;
}

export async function getBlockedSpamCount(env) {
  if (!env.TOPIC_MAP) return 0;
  return Number((await env.TOPIC_MAP.get(SPAM_STATS_KEY)) || 0);
}

export async function getBlockedSpamToday(env, config = null, nowDate = new Date()) {
  if (!env.TOPIC_MAP) return 0;
  const offsetHours = config?.community?.timezoneOffsetHours ?? 8;
  const dailyKey = `stats:blocked:${getBlockedDateKey(nowDate, offsetHours)}`;
  return Number((await env.TOPIC_MAP.get(dailyKey)) || 0);
}
