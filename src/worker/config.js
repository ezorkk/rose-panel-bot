// Configuration defaults and KV storage helpers for RosePanel Bot

import { buildMiniAppDirectLink } from './telegram.js';

export const LEVELS = [
  { level: 1, title: '初遇者', minXp: 0, badge: 'petal', color: '#E38AA6' },
  { level: 2, title: '漫游者', minXp: 100, badge: 'compass', color: '#D96B90' },
  { level: 3, title: '追光者', minXp: 300, badge: 'sparkle', color: '#C84E79' },
  { level: 4, title: '入戏者', minXp: 700, badge: 'bottle', color: '#B03460' },
  { level: 5, title: '知影人', minXp: 1300, badge: 'crystal', color: '#99244D' },
  { level: 6, title: '守夜人', minXp: 2400, badge: 'moon', color: '#7D1B3F' },
  { level: 7, title: '星辰主', minXp: 4200, badge: 'crown', color: '#611331' },
];

export const BADGE_CATALOG = [
  { id: 'first_checkin', name: '初见印记', desc: '完成首次每日签到', icon: '🌸' },
  { id: 'streak_3', name: '三日之约', desc: '连续签到达到 3 天', icon: '🔥' },
  { id: 'streak_7', name: '七日星火', desc: '连续签到达到 7 天', icon: '✨' },
  { id: 'streak_30', name: '满月守望', desc: '连续签到达到 30 天', icon: '🌙' },
  { id: 'points_500', name: '积微成著', desc: '累计积分达到 500 分', icon: '💎' },
  { id: 'points_2000', name: '玫瑰藏家', desc: '累计积分达到 2000 分', icon: '👑' },
  { id: 'early_bird', name: '晨光打卡', desc: '在早上 05:00-08:30 完成签到', icon: '🌅' },
  { id: 'loyal_10', name: '常驻旅人', desc: '累计签到满 10 天', icon: '🎫' },
];

export const DEFAULT_EMBLEM = {
  type: 'builtin', // builtin | tg_sticker | url
  variant: 'owner', // owner | bottle | crown
  fileId: '',
  format: 'webp', // webp | webm | tgs
  url: '',
  emoji: '',
  setName: '',
  savedStickers: [],
};

export const DEFAULT_SPLASH = {
  style: 'emblem', // emblem | emoji | skeleton
  text: '正在打开个人面板…',
  emoji: '🌹',
};

// Card labels that used to ship as defaults. Configs saved before labelsRev 2 still carry them
// verbatim in KV, so they are cleared once on load; anything the owner typed is left untouched.
export const PROFILE_LABELS_REV = 2;
export const SOCIALS_CLEANUP_REV = 1;
const LEGACY_DEFAULT_LABELS = {
  badgeTitle: ['站长 · Owner'],
  joinedText: ['Cloudflare Edge'],
};

function isLegacyDefaultTgSocial(item) {
  return (
    item &&
    String(item.label || '').trim() === 'Telegram 私聊' &&
    String(item.value || '').trim() === '直接发送消息即可联系我' &&
    !String(item.url || '').trim()
  );
}

export const DEFAULT_PROBE_ALERTS = {
  enabled: false, // 总开关，默认关闭
  intervalMinutes: 5, // 5 | 10 | 15 | 30
  confirmChecks: 2, // 1–5
  notifyRecovery: true,
  mutedNodes: [], // 节点 uuid 列表
  resource: {
    enabled: false, // 资源告警单独开关，默认关闭
    cpu: 90, // 50–100，填 0 表示不检测这一项
    ram: 90,
    disk: 90,
    sustainChecks: 3, // 1–10
  },
};

export const DEFAULT_PROBATION = {
  enabled: true, // 默认开启
  maxMessages: 3, // 1–20
  hours: 24, // 1–168
  allowDomains: [], // 链接白名单，例如 ['github.com', 'example.com']，匹配域名本身及其子域名
};

export const DEFAULT_NAV_ORDER = ['profile', 'sites', 'probe', 'visitors', 'leaderboard'];

export function normalizeNavOrder(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const id = String(item || '').trim();
    if (DEFAULT_NAV_ORDER.includes(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of DEFAULT_NAV_ORDER) {
    if (!seen.has(id)) {
      result.push(id);
    }
  }
  return result;
}

export const DEFAULT_CONFIG = {
  profile: {
    displayName: 'RosePanel',
    handle: '@your_bot',
    tagline: '欢迎来到我的个人面板，这里汇集了我的个人小站与节点探针。',
    statusText: '在线营业中',
    statusTone: 'online', // online | busy | away
    avatarMode: 'bot', // bot | owner | custom
    avatarUrl: '',
    ownerTag: '个人名片',
    badgeTitle: '',
    joinedText: '',
    // Bumped when legacy default card labels are cleaned up; see loadPanelConfig
    labelsRev: PROFILE_LABELS_REV,
    notice: '',
    tags: '',
    showVisitCounter: false, // 是否在名片上公开显示本月访客数，默认不公开
    showPoweredBy: true, // 名片底部是否显示「Made with RosePanel · 想要同款？」，默认显示
    noteTitle: '来信礼仪',
    noteLines:
      '初次私聊请直接说明来意，不用只发「在吗」\n欢迎技术交流、友链与合作，谢绝广告推销\n看到消息后会尽快回复，请稍作等待 🌙',
    emblem: { ...DEFAULT_EMBLEM },
    splash: { ...DEFAULT_SPLASH },
    socialsRev: SOCIALS_CLEANUP_REV,
    socials: [
      { id: 'github', label: 'GitHub', value: 'github.com/mango0114', url: 'https://github.com/mango0114', icon: 'github' },
    ],
  },
  sites: [
    {
      id: 'site-blog',
      name: '个人博客',
      url: 'https://example.com',
      description: '记录技术笔记、折腾日志与生活随想',
      category: '博客',
      icon: '✍️',
      badge: '主站',
      visibility: 'public',
    },
    {
      id: 'site-nav',
      name: '个人导航站',
      url: 'https://nav.example.com',
      description: '常用服务、自托管应用与精选书签入口',
      category: '导航',
      icon: '🧭',
      badge: '直达',
      visibility: 'public',
    },
  ],
  probe: {
    provider: 'komari', // komari | nezha | nodeget | json
    url: '',
    publicUrl: '',
    apiKey: '',
    title: '节点探针',
    subtitle: '实时节点监控与负载一览',
    cacheTtlSeconds: 15,
    demoMode: false,
    visibility: 'public', // public | private
    alerts: structuredClone(DEFAULT_PROBE_ALERTS),
  },
  community: {
    enableCheckin: false, // 个人名片模式默认关闭；群社区部署时可一键开启
    timezoneOffsetHours: 8, // UTC+8 Asia/Shanghai
    dailyMinPoints: 10,
    dailyMaxPoints: 25,
    streakStepBonus: 2,
    streakMaxBonus: 20,
    milestone7Bonus: 30,
    milestone30Bonus: 120,
    currencyName: '积分',
    groupTitle: '群友票根',
  },
  pmBot: {
    enableVerification: true,
    verificationMode: 'emoji', // emoji | sticker_quiz | quiz | turnstile | off
    maxVerifyFailures: 2,
    cooldownMinutes: 10,
    enableCasCheck: true,
    smartEscalation: true,
    blockUnverifiedMedia: true,
    enableHoneypot: true,
    honeypotAction: 'cooldown', // cooldown | ban (default cooldown prevents permanent lockout on human misclick)
    blockedKeywords: '',
    stickerChallenges: [],
    welcomeText: '你好呀 🌸 这里是我的私聊助手。\n点击下方「开始」完成简单人机验证后，即可直接发消息联系我。',
    welcomeImageUrl: '',
    syncBotDescription: true,
    showChatMenuButton: true,
    enableStartWelcome: true,
    showPanelButtonInWelcome: true,
    autoAckEnabled: true,
    autoReplyEnabled: false,
    autoReplyText: '已收到您的消息 🌸 看到后会第一时间回复，请稍等片刻～',
    autoReplyCooldownMinutes: 30,
    keywordReplies: [],
    verifiedDays: 30,
    showVisitorAvatarInCard: false,
    probation: structuredClone(DEFAULT_PROBATION),
  },
  updater: {
    forkRepo: '', // e.g. "yourname/rose-panel-bot"
    branch: 'main',
    githubToken: '', // optional single-repo Fine-grained PAT for in-app 1-click fork sync
  },
  ui: {
    navOrder: [...DEFAULT_NAV_ORDER],
  },
};

const CONFIG_KV_KEY = 'config:panel';
export const SUPERGROUP_KV_KEY = 'config:supergroup_id';

export async function resolveSupergroupId(env) {
  if (env?.TOPIC_MAP) {
    try {
      const bound = await env.TOPIC_MAP.get(SUPERGROUP_KV_KEY);
      if (bound && /^-?\d+$/.test(String(bound).trim())) {
        return String(bound).trim();
      }
    } catch {
      // Ignore KV read failures
    }
  }
  return String(env?.SUPERGROUP_ID || '').trim();
}

export async function saveBoundSupergroupId(env, chatId) {
  if (!env?.TOPIC_MAP) return;
  await env.TOPIC_MAP.put(SUPERGROUP_KV_KEY, String(chatId));
}

export async function clearBoundSupergroupId(env) {
  if (!env?.TOPIC_MAP) return;
  await env.TOPIC_MAP.delete(SUPERGROUP_KV_KEY);
}

export async function safeGetJSON(kv, key, fallback = null, readOptions = undefined) {
  if (!kv) return fallback;
  try {
    const val = await kv.get(key, { ...(readOptions || {}), type: 'json' });
    return val === null || val === undefined ? fallback : val;
  } catch {
    return fallback;
  }
}

export async function safePutJSON(kv, key, value, options = undefined) {
  if (!kv) return;
  await kv.put(key, JSON.stringify(value), options);
}

export function normalizeKeywordRule(rule = {}, idx = 0) {
  return {
    id: String(rule.id || `kr-${Date.now()}-${idx}`).slice(0, 64),
    keywords: String(rule.keywords || '').trim().slice(0, 300),
    matchMode: rule.matchMode === 'exact' ? 'exact' : 'contains',
    reply: String(rule.reply || '').trim().slice(0, 2000),
    forwardToAdmin: rule.forwardToAdmin !== false,
    enabled: rule.enabled !== false,
  };
}

export function hasValidKeywords(keywords = '') {
  return String(keywords || '')
    .split(/[,，\n|]/)
    .some((k) => k.trim().length > 0);
}

export function normalizeSite(site = {}, idx = 0) {
  return {
    id: String(site.id || `site-${Date.now()}-${idx}`),
    name: String(site.name || '未命名站点'),
    url: String(site.url || ''),
    description: String(site.description || ''),
    category: String(site.category || '常用'),
    icon: String(site.icon || '🌐'),
    badge: String(site.badge || ''),
    visibility: site.visibility === 'private' ? 'private' : 'public',
  };
}

export function normalizeEmblem(baseEmblem = DEFAULT_EMBLEM, override = null) {
  const merged = {
    ...DEFAULT_EMBLEM,
    ...(baseEmblem || {}),
    ...(override || {}),
  };
  if (!['builtin', 'tg_sticker', 'url'].includes(merged.type)) {
    merged.type = 'builtin';
  }
  if (!['webp', 'webm', 'tgs'].includes(merged.format)) {
    merged.format = 'webp';
  }
  merged.savedStickers = Array.isArray(merged.savedStickers) ? merged.savedStickers.slice(0, 30) : [];
  return merged;
}

export function normalizeSplash(baseSplash = DEFAULT_SPLASH, override = null) {
  const merged = {
    ...DEFAULT_SPLASH,
    ...(baseSplash || {}),
    ...(override || {}),
  };
  if (!['emblem', 'emoji', 'skeleton'].includes(merged.style)) {
    merged.style = 'emblem';
  }
  merged.text = String(merged.text || '').trim().slice(0, 48) || DEFAULT_SPLASH.text;
  merged.emoji = String(merged.emoji || '').trim().slice(0, 8) || DEFAULT_SPLASH.emoji;
  return merged;
}

export const PROBE_PROVIDER_IDS = ['komari', 'nezha', 'nodeget', 'json'];
export const ALERT_INTERVAL_OPTIONS = [5, 10, 15, 30];
const AVATAR_MODES = ['bot', 'owner', 'custom'];

function clampInt(val, min, max, fallback) {
  if (val === '' || val === null || val === undefined) return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

function clampAlertThreshold(val, fallback = 90) {
  if (val === '' || val === null || val === undefined) return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded <= 0) return 0; // 0 disables monitoring for this metric
  return Math.min(Math.max(rounded, 50), 100);
}

export function normalizeProbeAlerts(baseAlerts = DEFAULT_PROBE_ALERTS, override = null) {
  const base = baseAlerts && typeof baseAlerts === 'object' ? baseAlerts : DEFAULT_PROBE_ALERTS;
  const ov = override && typeof override === 'object' ? override : {};
  const rawInterval = Number(ov.intervalMinutes ?? base.intervalMinutes ?? DEFAULT_PROBE_ALERTS.intervalMinutes);
  const intervalMinutes = ALERT_INTERVAL_OPTIONS.includes(rawInterval)
    ? rawInterval
    : DEFAULT_PROBE_ALERTS.intervalMinutes;
  const rawMuted = Array.isArray(ov.mutedNodes)
    ? ov.mutedNodes
    : Array.isArray(base.mutedNodes)
      ? base.mutedNodes
      : [];
  const mutedNodes = Array.from(
    new Set(
      rawMuted
        .map((id) => String(id ?? '').trim().slice(0, 128))
        .filter(Boolean)
    )
  ).slice(0, 200);

  const baseRes =
    base.resource && typeof base.resource === 'object' ? base.resource : DEFAULT_PROBE_ALERTS.resource;
  const ovRes = ov.resource && typeof ov.resource === 'object' ? ov.resource : {};

  return {
    enabled: Boolean(ov.enabled ?? base.enabled ?? false),
    intervalMinutes,
    confirmChecks: clampInt(ov.confirmChecks ?? base.confirmChecks, 1, 5, DEFAULT_PROBE_ALERTS.confirmChecks),
    notifyRecovery: (ov.notifyRecovery ?? base.notifyRecovery) !== false,
    mutedNodes,
    resource: {
      enabled: Boolean(ovRes.enabled ?? baseRes.enabled ?? false),
      cpu: clampAlertThreshold(ovRes.cpu ?? baseRes.cpu, DEFAULT_PROBE_ALERTS.resource.cpu),
      ram: clampAlertThreshold(ovRes.ram ?? baseRes.ram, DEFAULT_PROBE_ALERTS.resource.ram),
      disk: clampAlertThreshold(ovRes.disk ?? baseRes.disk, DEFAULT_PROBE_ALERTS.resource.disk),
      sustainChecks: clampInt(
        ovRes.sustainChecks ?? baseRes.sustainChecks,
        1,
        10,
        DEFAULT_PROBE_ALERTS.resource.sustainChecks
      ),
    },
  };
}

function normalizeAllowDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/[/?#].*$/, '');
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    return '';
  }
  return s.slice(0, 128);
}

export function normalizeProbation(baseProbation = DEFAULT_PROBATION, override = null) {
  const base = baseProbation && typeof baseProbation === 'object' ? baseProbation : DEFAULT_PROBATION;
  const ov = override && typeof override === 'object' ? override : {};
  const rawDomains =
    ov.allowDomains !== undefined
      ? ov.allowDomains
      : base.allowDomains !== undefined
        ? base.allowDomains
        : DEFAULT_PROBATION.allowDomains;
  const domainList = Array.isArray(rawDomains)
    ? rawDomains
    : typeof rawDomains === 'string'
      ? rawDomains.split(/[\r\n,，;；]+/)
      : [];
  const allowDomains = Array.from(new Set(domainList.map(normalizeAllowDomain).filter(Boolean))).slice(0, 50);

  return {
    enabled: (ov.enabled ?? base.enabled) !== false,
    maxMessages: clampInt(ov.maxMessages ?? base.maxMessages, 1, 20, DEFAULT_PROBATION.maxMessages),
    hours: clampInt(ov.hours ?? base.hours, 1, 168, DEFAULT_PROBATION.hours),
    allowDomains,
  };
}

function resolveAvatarMode(rawMode, avatarUrl) {
  if (AVATAR_MODES.includes(rawMode)) return rawMode;
  return String(avatarUrl || '').trim() ? 'custom' : 'bot';
}

export function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') {
    const cloned = structuredClone(base);
    cloned.sites = cloned.sites.map(normalizeSite);
    cloned.profile.emblem = normalizeEmblem(cloned.profile.emblem);
    cloned.profile.splash = normalizeSplash(cloned.profile.splash);
    cloned.profile.avatarMode = resolveAvatarMode(cloned.profile.avatarMode, cloned.profile.avatarUrl);
    cloned.profile.showVisitCounter = Boolean(cloned.profile.showVisitCounter);
    cloned.profile.showPoweredBy =
      cloned.profile.showPoweredBy === undefined ? true : Boolean(cloned.profile.showPoweredBy);
    cloned.probe.visibility = cloned.probe.visibility === 'private' ? 'private' : 'public';
    cloned.probe.provider = PROBE_PROVIDER_IDS.includes(cloned.probe.provider) ? cloned.probe.provider : 'komari';
    cloned.probe.alerts = normalizeProbeAlerts(DEFAULT_PROBE_ALERTS, cloned.probe.alerts);
    cloned.pmBot.probation = normalizeProbation(DEFAULT_PROBATION, cloned.pmBot?.probation);
    cloned.ui = {
      navOrder: normalizeNavOrder(cloned.ui?.navOrder),
    };
    cloned.siteOrigin = String(cloned.siteOrigin || '').trim();
    return cloned;
  }
  const rawSites = Array.isArray(override.sites) ? override.sites : base.sites;
  const mergedProbe = {
    ...base.probe,
    ...(override.probe || {}),
    alerts: normalizeProbeAlerts(base.probe?.alerts, override.probe?.alerts),
  };
  mergedProbe.visibility = mergedProbe.visibility === 'private' ? 'private' : 'public';
  mergedProbe.provider = PROBE_PROVIDER_IDS.includes(mergedProbe.provider) ? mergedProbe.provider : 'komari';
  const mergedProfile = {
    ...base.profile,
    ...(override.profile || {}),
    emblem: normalizeEmblem(base.profile?.emblem, override.profile?.emblem),
    splash: normalizeSplash(base.profile?.splash, override.profile?.splash),
    socials: Array.isArray(override.profile?.socials)
      ? override.profile.socials
      : structuredClone(base.profile.socials),
  };
  // Preserve custom mode for existing configs that had avatarUrl set before avatarMode existed
  const explicitMode = override.profile?.avatarMode;
  mergedProfile.avatarMode = resolveAvatarMode(
    explicitMode !== undefined ? explicitMode : base.profile?.avatarMode && !override.profile?.avatarUrl ? base.profile.avatarMode : undefined,
    mergedProfile.avatarUrl
  );
  mergedProfile.showVisitCounter = Boolean(
    override.profile?.showVisitCounter ?? base.profile?.showVisitCounter ?? false
  );
  const rawShowPoweredBy =
    override.profile?.showPoweredBy !== undefined
      ? override.profile.showPoweredBy
      : base.profile?.showPoweredBy;
  mergedProfile.showPoweredBy = rawShowPoweredBy === undefined ? true : Boolean(rawShowPoweredBy);
  return {
    profile: mergedProfile,
    sites: rawSites.map(normalizeSite),
    probe: mergedProbe,
    community: {
      ...base.community,
      ...(override.community || {}),
    },
    pmBot: {
      ...base.pmBot,
      ...(override.pmBot || {}),
      honeypotAction:
        (override.pmBot?.honeypotAction ?? base.pmBot?.honeypotAction) === 'ban' ? 'ban' : 'cooldown',
      syncBotDescription:
        (override.pmBot?.syncBotDescription ?? base.pmBot?.syncBotDescription) !== false,
      showChatMenuButton:
        (override.pmBot?.showChatMenuButton ?? base.pmBot?.showChatMenuButton) !== false,
      enableStartWelcome:
        (override.pmBot?.enableStartWelcome ?? base.pmBot?.enableStartWelcome) !== false,
      showPanelButtonInWelcome:
        (override.pmBot?.showPanelButtonInWelcome ?? base.pmBot?.showPanelButtonInWelcome) !== false,
      autoReplyEnabled: Boolean(override.pmBot?.autoReplyEnabled ?? base.pmBot?.autoReplyEnabled ?? false),
      autoReplyCooldownMinutes: Math.min(
        Math.max(Number(override.pmBot?.autoReplyCooldownMinutes ?? base.pmBot?.autoReplyCooldownMinutes) || 30, 1),
        1440
      ),
      keywordReplies: Array.isArray(override.pmBot?.keywordReplies)
        ? override.pmBot.keywordReplies.map(normalizeKeywordRule).slice(0, 50)
        : Array.isArray(base.pmBot?.keywordReplies)
          ? base.pmBot.keywordReplies.map(normalizeKeywordRule).slice(0, 50)
          : [],
      showVisitorAvatarInCard: Boolean(
        override.pmBot?.showVisitorAvatarInCard ?? base.pmBot?.showVisitorAvatarInCard ?? false
      ),
      probation: normalizeProbation(base.pmBot?.probation, override.pmBot?.probation),
    },
    updater: {
      ...base.updater,
      ...(override.updater || {}),
    },
    ui: {
      navOrder: normalizeNavOrder(override.ui?.navOrder ?? base.ui?.navOrder),
    },
    botUsername: String(override.botUsername ?? base.botUsername ?? '')
      .trim()
      .replace(/^@/, ''),
    siteOrigin: String(override.siteOrigin ?? base.siteOrigin ?? '')
      .trim()
      .replace(/\/+$/, ''),
  };
}

export async function loadPanelConfig(env) {
  const saved = await safeGetJSON(env.TOPIC_MAP, CONFIG_KV_KEY, null);
  const merged = mergeConfig(DEFAULT_CONFIG, saved);

  // One-time cleanup of legacy default card labels for configs saved before labelsRev 2
  if (saved && !(Number(saved.profile?.labelsRev) >= PROFILE_LABELS_REV)) {
    for (const [field, legacyValues] of Object.entries(LEGACY_DEFAULT_LABELS)) {
      if (legacyValues.includes(String(merged.profile[field] ?? '').trim())) {
        merged.profile[field] = '';
      }
    }
  }
  merged.profile.labelsRev = PROFILE_LABELS_REV;

  // One-time cleanup of legacy non-clickable "直接发送消息即可联系我" duplicate social row
  if (saved && !(Number(saved.profile?.socialsRev) >= SOCIALS_CLEANUP_REV) && Array.isArray(merged.profile.socials)) {
    merged.profile.socials = merged.profile.socials.filter((item) => !isLegacyDefaultTgSocial(item));
  }
  merged.profile.socialsRev = SOCIALS_CLEANUP_REV;

  // Environment variable fallbacks when KV fields are unset
  const fallbackBotUname = String(env.BOT_USERNAME || merged.botUsername || '').trim().replace(/^@/, '');
  if ((!saved?.profile?.handle || saved?.profile?.handle === '@your_bot') && fallbackBotUname) {
    merged.profile.handle = `@${fallbackBotUname}`;
  }
  // PROBE_* are the generic names; KOMARI_* are kept for backward compatibility
  const envProbeUrl = env.PROBE_URL || env.KOMARI_URL;
  const envProbeKey = env.PROBE_API_KEY || env.KOMARI_API_KEY;
  const envProbeProvider = String(env.PROBE_PROVIDER || '').trim().toLowerCase();
  if (!saved?.probe?.provider && PROBE_PROVIDER_IDS.includes(envProbeProvider)) {
    merged.probe.provider = envProbeProvider;
  }
  if (!merged.probe.url && envProbeUrl) {
    merged.probe.url = envProbeUrl;
  }
  if (!merged.probe.publicUrl && (merged.probe.url || envProbeUrl)) {
    merged.probe.publicUrl = merged.probe.url || envProbeUrl;
  }
  if (!merged.probe.apiKey && envProbeKey) {
    merged.probe.apiKey = envProbeKey;
  }
  if (saved?.community?.enableCheckin === undefined && env.ENABLE_CHECKIN !== undefined) {
    merged.community.enableCheckin = String(env.ENABLE_CHECKIN).toLowerCase() === 'true';
  }
  if (!merged.updater.forkRepo && env.UPDATE_FORK_REPO) {
    merged.updater.forkRepo = String(env.UPDATE_FORK_REPO).trim();
  }
  // NOTE: Intentionally do NOT copy env.GITHUB_UPDATE_TOKEN into merged.updater.githubToken
  // so saving Settings never persists an environment Secret in plaintext inside KV.
  return merged;
}

export async function savePanelConfig(env, nextConfig) {
  const current = await loadPanelConfig(env);
  const merged = mergeConfig(current, nextConfig);

  // Preserve stored secrets if admin sent masked placeholder
  if (nextConfig?.probe?.apiKey === '********') {
    merged.probe.apiKey = current.probe.apiKey;
  }
  if (nextConfig?.updater?.githubToken === '********') {
    merged.updater.githubToken = current.updater.githubToken;
  }
  merged.updater.forkRepo = String(merged.updater.forkRepo || '').trim().slice(0, 120);
  merged.updater.branch = String(merged.updater.branch || 'main').trim().slice(0, 64) || 'main';
  merged.updater.githubToken = String(merged.updater.githubToken || '').trim().slice(0, 256);

  merged.profile.labelsRev = PROFILE_LABELS_REV;
  merged.profile.socialsRev = SOCIALS_CLEANUP_REV;
  merged.profile.ownerTag = String(merged.profile.ownerTag ?? '').trim().slice(0, 32);
  merged.profile.badgeTitle = String(merged.profile.badgeTitle ?? '').trim().slice(0, 32);
  merged.profile.joinedText = String(merged.profile.joinedText ?? '').trim().slice(0, 48);
  merged.profile.showVisitCounter = Boolean(merged.profile.showVisitCounter);
  merged.profile.showPoweredBy =
    merged.profile.showPoweredBy === undefined ? true : Boolean(merged.profile.showPoweredBy);

  // Clamp numeric settings
  merged.probe.cacheTtlSeconds = Math.min(Math.max(Number(merged.probe.cacheTtlSeconds) || 15, 5), 300);
  merged.probe.alerts = normalizeProbeAlerts(DEFAULT_PROBE_ALERTS, merged.probe.alerts);
  const rawSiteOrigin = String(merged.siteOrigin || '').trim().replace(/\/+$/, '');
  merged.siteOrigin = /^https:\/\/[^\s/]+$/i.test(rawSiteOrigin) ? rawSiteOrigin.slice(0, 200) : '';
  merged.community.dailyMinPoints = Math.min(Math.max(Number(merged.community.dailyMinPoints) || 10, 1), 1000);
  merged.community.dailyMaxPoints = Math.min(
    Math.max(Number(merged.community.dailyMaxPoints) || 25, merged.community.dailyMinPoints),
    2000
  );
  merged.community.streakStepBonus = Math.min(Math.max(Number(merged.community.streakStepBonus) || 0, 0), 100);
  merged.community.streakMaxBonus = Math.min(Math.max(Number(merged.community.streakMaxBonus) || 0, 0), 500);
  if (!['emoji', 'sticker_quiz', 'quiz', 'turnstile', 'off'].includes(merged.pmBot.verificationMode)) {
    merged.pmBot.verificationMode = merged.pmBot.enableVerification ? 'emoji' : 'off';
  }
  merged.pmBot.enableVerification = merged.pmBot.verificationMode !== 'off';
  merged.pmBot.maxVerifyFailures = Math.min(Math.max(Number(merged.pmBot.maxVerifyFailures) || 2, 1), 5);
  merged.pmBot.cooldownMinutes = Math.min(Math.max(Number(merged.pmBot.cooldownMinutes) || 10, 1), 1440);
  merged.pmBot.enableCasCheck = merged.pmBot.enableCasCheck !== false;
  merged.pmBot.smartEscalation = merged.pmBot.smartEscalation !== false;
  merged.pmBot.blockUnverifiedMedia = merged.pmBot.blockUnverifiedMedia !== false;
  merged.pmBot.enableHoneypot = merged.pmBot.enableHoneypot !== false;
  merged.pmBot.honeypotAction = merged.pmBot.honeypotAction === 'ban' ? 'ban' : 'cooldown';
  merged.pmBot.verifiedDays = Math.min(Math.max(Number(merged.pmBot.verifiedDays) || 30, 1), 3650);
  merged.pmBot.syncBotDescription = merged.pmBot.syncBotDescription !== false;
  merged.pmBot.showChatMenuButton = merged.pmBot.showChatMenuButton !== false;
  const rawWelcomeImg = String(merged.pmBot.welcomeImageUrl || '').trim();
  merged.pmBot.welcomeImageUrl = /^https:\/\/\S+/i.test(rawWelcomeImg) ? rawWelcomeImg.slice(0, 500) : '';
  merged.pmBot.enableStartWelcome = merged.pmBot.enableStartWelcome !== false;
  merged.pmBot.showPanelButtonInWelcome = merged.pmBot.showPanelButtonInWelcome !== false;
  merged.pmBot.autoReplyEnabled = Boolean(merged.pmBot.autoReplyEnabled);
  merged.pmBot.autoReplyText = String(merged.pmBot.autoReplyText ?? '').trim().slice(0, 2000);
  merged.pmBot.autoReplyCooldownMinutes = Math.min(
    Math.max(Number(merged.pmBot.autoReplyCooldownMinutes) || 30, 1),
    1440
  );
  merged.pmBot.keywordReplies = Array.isArray(merged.pmBot.keywordReplies)
    ? merged.pmBot.keywordReplies
        .map(normalizeKeywordRule)
        .filter((rule) => hasValidKeywords(rule.keywords) && rule.reply.length > 0)
        .slice(0, 50)
    : [];
  merged.pmBot.showVisitorAvatarInCard = Boolean(merged.pmBot.showVisitorAvatarInCard);
  merged.pmBot.welcomeText = String(merged.pmBot.welcomeText ?? '').slice(0, 2000);
  merged.pmBot.blockedKeywords = String(merged.pmBot.blockedKeywords || '').slice(0, 2000);
  merged.pmBot.stickerChallenges = Array.isArray(merged.pmBot.stickerChallenges)
    ? merged.pmBot.stickerChallenges.filter((item) => item?.fileId && item?.question && item?.answer).slice(0, 40)
    : [];
  merged.pmBot.probation = normalizeProbation(DEFAULT_PROBATION, merged.pmBot.probation);
  merged.ui = {
    navOrder: normalizeNavOrder(merged.ui?.navOrder),
  };

  await safePutJSON(env.TOPIC_MAP, CONFIG_KV_KEY, merged);
  return merged;
}

export function resolveShareUrl(config, env = {}, requestOrigin = '') {
  const botUsername =
    String(env?.BOT_USERNAME || '').trim().replace(/^@/, '') ||
    String(config?.botUsername || '').trim().replace(/^@/, '');
  const appShortName = String(env?.APP_SHORT_NAME || '').trim().replace(/^\/+|\/+$/g, '');
  if (botUsername && appShortName) {
    return buildMiniAppDirectLink({ BOT_USERNAME: botUsername, APP_SHORT_NAME: appShortName });
  }
  const cleanOrigin = String(requestOrigin || config?.siteOrigin || '').trim().replace(/\/+$/, '');
  return cleanOrigin ? `${cleanOrigin}/` : '';
}

/**
 * Returns panel configuration tailored to caller privileges.
 * CRITICAL SECURITY: Private sites (`visibility === 'private'`) and saved sticker library
 * are strictly stripped server-side for non-admin visitors.
 */
export function sanitizePublicConfig(config, env, isAdmin = false, requestOrigin = '', visitStats = null) {
  const visibleSites = isAdmin
    ? config.sites
    : config.sites.filter((s) => (s.visibility || 'public') !== 'private');

  const activeEmblem = {
    type: config.profile.emblem?.type || 'builtin',
    variant: config.profile.emblem?.variant || 'owner',
    fileId: config.profile.emblem?.fileId || '',
    format: config.profile.emblem?.format || 'webp',
    url: config.profile.emblem?.url || '',
  };

  const probePrivateHidden = config.probe.visibility === 'private' && !isAdmin;
  const publicVisitStats =
    config.profile?.showVisitCounter === true
      ? { thisMonth: Math.max(0, Number(visitStats?.thisMonth) || 0) }
      : undefined;

  return {
    profile: {
      ...config.profile,
      showPoweredBy: config.profile?.showPoweredBy === undefined ? true : Boolean(config.profile.showPoweredBy),
      emblem: activeEmblem,
      splash: normalizeSplash(config.profile.splash),
    },
    sites: visibleSites,
    probe: probePrivateHidden
      ? {
          provider: config.probe.provider,
          configured: false,
          publicUrl: '',
          title: '',
          subtitle: '',
          demoMode: false,
          visibility: 'private',
        }
      : {
          provider: config.probe.provider,
          configured: Boolean(config.probe.url || config.probe.demoMode),
          publicUrl: config.probe.publicUrl || config.probe.url || '',
          title: config.probe.title,
          subtitle: config.probe.subtitle,
          demoMode: Boolean(config.probe.demoMode),
          visibility: config.probe.visibility === 'private' ? 'private' : 'public',
        },
    community: {
      enableCheckin: Boolean(config.community.enableCheckin),
      currencyName: config.community.currencyName,
      groupTitle: config.community.groupTitle,
      dailyMinPoints: config.community.dailyMinPoints,
      dailyMaxPoints: config.community.dailyMaxPoints,
      streakStepBonus: config.community.streakStepBonus,
      streakMaxBonus: config.community.streakMaxBonus,
      milestone7Bonus: config.community.milestone7Bonus,
      milestone30Bonus: config.community.milestone30Bonus,
    },
    bot: {
      username:
        (env.BOT_USERNAME || '').replace(/^@/, '') ||
        (config.botUsername || '').replace(/^@/, '') ||
        (() => {
          const h = String(config.profile?.handle || '').trim().replace(/^@/, '');
          return h && h !== 'your_bot' && /bot$/i.test(h) ? h : '';
        })(),
      appShortName: env.APP_SHORT_NAME || '',
    },
    ui: {
      navOrder: normalizeNavOrder(config.ui?.navOrder),
    },
    shareUrl: resolveShareUrl(config, env, requestOrigin),
    ...(publicVisitStats ? { visitStats: publicVisitStats } : {}),
  };
}

export function sanitizeAdminConfig(config, env = {}, inboxStatus = {}) {
  const cloned = structuredClone(config);
  if (cloned.probe.apiKey) {
    cloned.probe.apiKey = '********';
    cloned.probe.hasApiKey = true;
  } else {
    cloned.probe.hasApiKey = false;
  }
  const hasStoredGhToken = Boolean(cloned.updater?.githubToken);
  const hasEnvGhToken = Boolean(env.GITHUB_UPDATE_TOKEN);
  if (cloned.updater) {
    if (hasStoredGhToken || hasEnvGhToken) {
      cloned.updater.githubToken = '********';
      cloned.updater.hasGithubToken = true;
      cloned.updater.tokenFromEnv = !hasStoredGhToken && hasEnvGhToken;
    } else {
      cloned.updater.hasGithubToken = false;
      cloned.updater.tokenFromEnv = false;
    }
  }
  cloned.pmBot.turnstileReady = Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
  if (inboxStatus && typeof inboxStatus === 'object') {
    if (inboxStatus.inboxMode !== undefined) {
      cloned.inboxMode = inboxStatus.inboxMode;
    }
    if (inboxStatus.ownerUnreachable !== undefined) {
      cloned.ownerUnreachable = Boolean(inboxStatus.ownerUnreachable);
    }
    if (inboxStatus.webhookNeedsResync !== undefined) {
      cloned.webhookNeedsResync = Boolean(inboxStatus.webhookNeedsResync);
    }
  }
  return cloned;
}
