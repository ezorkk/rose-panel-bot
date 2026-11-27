// Grouped anti-spam blocked keyword presets for SettingsDrawer.
// Intentionally contains ONLY ad-specific phrases (never generic everyday single words)
// because matched messages are silently dropped. None are enabled by default.

export const BLOCKED_KEYWORD_MAX_LENGTH = 2000;

export const KEYWORD_PRESET_GROUPS = [
  {
    id: 'crypto',
    label: '💰 币圈投资',
    keywords: ['USDT返利', '稳赚不赔', '带单', '合约喊单', '空投领取'],
  },
  {
    id: 'gambling',
    label: '🎰 博彩',
    keywords: ['菠菜', '博彩', '彩票计划', '百家乐', '充值返水'],
  },
  {
    id: 'parttime',
    label: '💼 兼职刷单',
    keywords: ['日结兼职', '刷单', '点赞赚钱', '手机兼职', '宝妈兼职'],
  },
  {
    id: 'promo',
    label: '📢 引流推广',
    keywords: ['加微信领取', '免费送粉', '互粉', '涨粉'],
  },
  {
    id: 'adult',
    label: '🔞 色情',
    keywords: ['约炮', '同城约', '福利视频', '裸聊'],
  },
  {
    id: 'english',
    label: '🌐 英文广告',
    keywords: ['earn money fast', 'crypto signal', 'investment opportunity', 'forex signal'],
  },
];

export const ALL_KEYWORD_PRESETS = KEYWORD_PRESET_GROUPS.flatMap((group) => group.keywords);

export function splitBlockedKeywords(raw = '') {
  return String(raw || '')
    .split(/[\n,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function keywordKey(word) {
  return String(word || '').trim().normalize('NFKC').toLowerCase();
}

export function hasBlockedKeyword(raw, keyword) {
  const target = keywordKey(keyword);
  if (!target) return false;
  return splitBlockedKeywords(raw).some((item) => keywordKey(item) === target);
}

export function toggleBlockedKeyword(raw, keyword, maxLen = BLOCKED_KEYWORD_MAX_LENGTH) {
  const target = keywordKey(keyword);
  if (!target) return { value: String(raw || ''), added: false, truncated: false };
  const tokens = splitBlockedKeywords(raw);
  const exists = tokens.some((item) => keywordKey(item) === target);
  if (exists) {
    const next = tokens.filter((item) => keywordKey(item) !== target);
    return { value: next.join(', '), added: false, truncated: false };
  }
  const joined = [...tokens, keyword].join(', ');
  if (joined.length > maxLen) {
    return { value: String(raw || ''), added: false, truncated: true };
  }
  return { value: joined, added: true, truncated: false };
}

export function addBlockedKeywordGroup(raw, keywords = [], maxLen = BLOCKED_KEYWORD_MAX_LENGTH) {
  const tokens = splitBlockedKeywords(raw);
  const existing = new Set(tokens.map(keywordKey));
  let addedCount = 0;
  let truncated = false;
  for (const kw of Array.isArray(keywords) ? keywords : []) {
    const key = keywordKey(kw);
    if (!key || existing.has(key)) continue;
    const candidate = [...tokens, kw].join(', ');
    if (candidate.length > maxLen) {
      truncated = true;
      break;
    }
    tokens.push(kw);
    existing.add(key);
    addedCount += 1;
  }
  return { value: tokens.join(', '), addedCount, truncated };
}

export function removeBlockedKeywordGroup(raw, keywords = []) {
  const targets = new Set((Array.isArray(keywords) ? keywords : []).map(keywordKey).filter(Boolean));
  if (targets.size === 0) {
    return { value: String(raw || ''), removedCount: 0 };
  }
  const tokens = splitBlockedKeywords(raw);
  let removedCount = 0;
  const kept = [];
  for (const token of tokens) {
    if (targets.has(keywordKey(token))) {
      removedCount += 1;
    } else {
      kept.push(token);
    }
  }
  return { value: kept.join(', '), removedCount };
}
