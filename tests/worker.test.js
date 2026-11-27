import { describe, expect, it, vi } from 'vitest';
import {
  ALERT_STATE_KEY,
  ALERT_TOPIC_ID_KEY,
  evaluateProbeAlerts,
  formatAlertMessage,
  runProbeAlerts,
  sendAlertNotification,
} from '../src/worker/alerts.js';
import {
  BLOCKED_DAILY_TTL_SECONDS,
  assessIncomingRisk,
  assessProbationRisk,
  checkCasBlacklist,
  formatProbationReasons,
  getBlockedDateKey,
  getBlockedSpamCount,
  getBlockedSpamToday,
  isDomainAllowed,
  normalizeAntiSpamText,
  recordBlockedSpam,
} from '../src/worker/antispam.js';
import {
  MEDIA_TOKEN_BUCKET_SECONDS,
  signMediaToken,
  verifyMediaToken,
  verifyTelegramInitData,
} from '../src/worker/auth.js';
import {
  TOPIC_MSG_MAP_PREFIX,
  TOPIC_MSG_MAP_TTL_SECONDS,
  VISITOR_REACTION_LIMIT_PER_MIN,
  WEBHOOK_UPDATES_REV,
  WEBHOOK_UPDATES_REV_KEY,
  buildVisitorCardCaption,
  buildVisitorCardText,
  completeTurnstileVerification,
  ensureWebhookReactionSubscription,
  formatSafeReviewPreviewHtml,
  generateInlineChallenge,
  generateStickerChallenge,
  handleTelegramUpdate,
  initiateChatFromMiniApp,
  matchKeywordReply,
  parseStickerQuizInput,
  reviewPendingVisitor,
  startVisitorProbation,
  syncTelegramBotSurface,
} from '../src/worker/bot.js';
import { getLeaderboard, getMemberTicket, performCheckin, resolveLevel } from '../src/worker/checkin.js';
import {
  CHAT_RETENTION_DAYS_OPTIONS,
  DEFAULT_CONFIG,
  DEFAULT_NAV_ORDER,
  loadPanelConfig,
  normalizeChatRetentionDays,
  normalizeNavOrder,
  resolveSupergroupId,
  sanitizeAdminConfig,
  sanitizePublicConfig,
  savePanelConfig,
} from '../src/worker/config.js';
import {
  DM_LAST_HEADER_KEY,
  DM_MAP_PREFIX,
  DM_OWNER_UNREACHABLE_KEY,
  getOwnerChatId,
  lookupDmMessageMap,
  resolveInboxMode,
} from '../src/worker/inbox.js';
import worker, { WEBHOOK_ALLOWED_UPDATES } from '../src/worker/index.js';
import { apiRequest } from '../web/src/lib/api.js';
import {
  fetchKomariStatus,
  fetchProbeStatus,
  getDemoKomariNodes,
  normalizeKomariLatencyMap,
  normalizeNodeMetrics,
} from '../src/worker/komari.js';
import { normalizeStickerObject, parseStickerPackName } from '../src/worker/telegram.js';
import { renderTurnstileVerifyPage } from '../src/worker/turnstile.js';
import { checkLatestRelease, compareSemver, syncForkWithUpstream } from '../src/worker/updater.js';
import { APP_VERSION } from '../src/worker/version.js';
import {
  VISIT_COUNT_TTL_SECONDS,
  VISIT_SEEN_TTL_SECONDS,
  getMonthKeys,
  getVisitStats,
  recordMonthlyVisit,
} from '../src/worker/visitStats.js';
import { BRAND_NAME, BRAND_SIGNATURE } from '../web/src/lib/brand.js';
import {
  appendNewerHistory,
  buildHistoryUrl,
  buildSearchUrl,
  mergeLatestHistoryTail,
  prependOlderHistory,
  splitHighlightSegments,
} from '../web/src/lib/chatHistory.js';
import {
  ALL_KEYWORD_PRESETS,
  BLOCKED_KEYWORD_MAX_LENGTH,
  KEYWORD_PRESET_GROUPS,
  addBlockedKeywordGroup,
  hasBlockedKeyword,
  removeBlockedKeywordGroup,
  toggleBlockedKeyword,
} from '../web/src/lib/keywordPresets.js';
import pkg from '../package.json' with { type: 'json' };
import {
  addPendingReviewMessage,
  applyVisitorAction,
  buildSourceLink,
  clearVisitorHistory,
  computeSourceStats,
  extractLinksFromMessage,
  extractPhotoFromMessage,
  filterFreshPendingReview,
  getVisitorDetail,
  HISTORY_CACHE_TTL_SECONDS,
  getVisitorHistory,
  getVisitorOverview,
  listVisitors,
  normalizeSourceParam,
  PENDING_REVIEW_TTL_MS,
  recallAdminVisitorMessage,
  recordVisitorExchange,
  rememberPendingSource,
  searchVisitorMessages,
  updateVisitorMessageReaction,
  upsertVisitorProfile,
} from '../src/worker/visitors.js';
import {
  buildSourceLink as buildClientSourceLink,
  normalizeSourceParam as normalizeClientSourceParam,
} from '../web/src/lib/telegram.js';
import {
  MAX_SEARCH_QUERY_LEN,
  RETENTION_DELETE_BATCH_SIZE,
  SCHEMA_VERSION,
  cleanupExpiredMaps,
  ensureSchema,
  escapeLikePattern,
  getStorageStatus,
  getStore,
  migrateVisitor,
  migrateVisitorsBatch,
  shouldRunDailyCleanup,
} from '../src/worker/store/index.js';
import { createD1Shim } from './helpers/d1Shim.js';

// Minimal in-memory Cloudflare KV mock
function createMemoryKV() {
  const store = new Map();
  return {
    store,
    async get(key, opts) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (opts === 'json' || opts?.type === 'json') {
        return JSON.parse(raw);
      }
      return raw;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [];
      for (const name of store.keys()) {
        if (name.startsWith(prefix)) keys.push({ name });
        if (keys.length >= limit) break;
      }
      return { keys, list_complete: true };
    },
  };
}

// Helper to sign valid Telegram WebApp initData for tests
async function signInitData(fields, botToken) {
  const enc = new TextEncoder();
  const params = new URLSearchParams();
  Object.entries(fields).forEach(([k, v]) => params.set(k, v));

  const pairs = Array.from(params.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const key1 = await crypto.subtle.importKey(
    'raw',
    enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const secretKey = new Uint8Array(await crypto.subtle.sign('HMAC', key1, enc.encode(botToken)));

  const key2 = await crypto.subtle.importKey(
    'raw',
    secretKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const hashBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key2, enc.encode(dataCheckString)));
  const hashHex = Array.from(hashBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  params.set('hash', hashHex);
  return params.toString();
}

describe.each(['kv', 'd1'])('Full regression suite [%s storage mode]', (storageMode) => {
  function makeEnv(props = {}) {
    if (storageMode === 'd1' && props && props.TOPIC_MAP && !Object.prototype.hasOwnProperty.call(props, 'DB')) {
      if (!props.TOPIC_MAP._pairedD1) {
        props.TOPIC_MAP._pairedD1 = createD1Shim();
      }
      return { ...props, DB: props.TOPIC_MAP._pairedD1 };
    }
    return props;
  }

describe('Telegram Mini App initData verification', () => {
  const token = '123456:TEST_BOT_TOKEN_SECRET';

  it('verifies legitimately signed initData and parses user + start_param', async () => {
    const now = Math.floor(Date.now() / 1000);
    const initData = await signInitData(
      {
        auth_date: String(now),
        query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
        start_param: 'visitor_998877',
        user: JSON.stringify({ id: 10001, first_name: 'Rose', username: 'rose_owner' }),
      },
      token
    );

    const res = await verifyTelegramInitData(initData, token);
    expect(res.ok).toBe(true);
    expect(res.user.id).toBe(10001);
    expect(res.startParam).toBe('visitor_998877');
  });

  it('rejects tampered initData signature', async () => {
    const now = Math.floor(Date.now() / 1000);
    const initData = await signInitData(
      {
        auth_date: String(now),
        user: JSON.stringify({ id: 10001, first_name: 'Rose' }),
      },
      token
    );
    const tampered = initData.replace('10001', '99999');
    const res = await verifyTelegramInitData(tampered, token);
    expect(res.ok).toBe(false);
  });

  it('rejects expired initData', async () => {
    const old = Math.floor(Date.now() / 1000) - 90000;
    const initData = await signInitData(
      {
        auth_date: String(old),
        user: JSON.stringify({ id: 10001, first_name: 'Rose' }),
      },
      token
    );
    const res = await verifyTelegramInitData(initData, token, 3600);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('expired');
  });
});

describe('Group check-in, streaks, levels and badges', () => {
  it('handles daily check-in idempotency, streaks, early bird badge, and leaderboard', async () => {
    const env = makeEnv({ TOPIC_MAP: createMemoryKV() });
    const cfg = { ...DEFAULT_CONFIG.community, enableCheckin: true, dailyMinPoints: 20, dailyMaxPoints: 20, streakStepBonus: 5 };
    const user = { id: 55501, first_name: 'Alice', username: 'alice_tg' };

    // Day 1 at 06:30 UTC+8 (22:30 UTC previous day) -> unlocks first_checkin + early_bird
    const day1 = new Date('2026-11-20T22:30:00Z');
    const r1 = await performCheckin(env, user, cfg, day1);
    expect(r1.alreadyCheckedIn).toBe(false);
    expect(r1.gained).toBe(20);
    expect(r1.ticket.streak).toBe(1);
    expect(r1.newlyUnlocked.map((b) => b.id)).toContain('first_checkin');
    expect(r1.newlyUnlocked.map((b) => b.id)).toContain('early_bird');

    // Same day repeat -> idempotent
    const r1Repeat = await performCheckin(env, user, cfg, new Date('2026-11-21T04:00:00Z'));
    expect(r1Repeat.alreadyCheckedIn).toBe(true);
    expect(r1Repeat.gained).toBe(0);

    // Day 2 -> streak 2, +5 bonus => 25 pts
    const r2 = await performCheckin(env, user, cfg, new Date('2026-11-22T02:00:00Z'));
    expect(r2.ticket.streak).toBe(2);
    expect(r2.gained).toBe(25);

    // Day 3 -> streak 3, unlocks streak_3 badge
    const r3 = await performCheckin(env, user, cfg, new Date('2026-11-23T02:00:00Z'));
    expect(r3.ticket.streak).toBe(3);
    expect(r3.newlyUnlocked.map((b) => b.id)).toContain('streak_3');

    // Skip a day (Day 5) -> streak resets to 1, bestStreak stays 3
    const r5 = await performCheckin(env, user, cfg, new Date('2026-11-25T02:00:00Z'));
    expect(r5.ticket.streak).toBe(1);
    expect(r5.ticket.bestStreak).toBe(3);

    const board = await getLeaderboard(env, 10);
    expect(board.items).toHaveLength(1);
    expect(board.items[0].userId).toBe('55501');

    const lvl = resolveLevel(1350);
    expect(lvl.current.level).toBe(5);
    expect(lvl.current.title).toBe('知影人');
  });
});

describe('Visitor profiles & moderation (telegram_private_chatbot KV compatibility)', () => {
  it('reads legacy KV keys, supports ban/unban/trust/close/note and filtering', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, SUPERGROUP_ID: '-1001234567890' });

    // Simulate a legacy user key created by telegram_private_chatbot v5.3
    await kv.put('user:77701', JSON.stringify({ thread_id: 42, closed: false }));
    await kv.put('verified:77701', 'turnstile:v1');

    // Plus a new enriched visitor
    await upsertVisitorProfile(
      env,
      { id: 88802, first_name: 'Bob', username: 'bob_dev', language_code: 'zh-hans' },
      { threadId: 99, incrementMsg: true, lastPreview: '你好，咨询合作' }
    );

    const listed = await listVisitors(env);
    expect(listed.stats.total).toBe(2);
    expect(listed.items.some((v) => v.userId === '77701')).toBe(true);
    expect(listed.items.some((v) => v.userId === '88802')).toBe(true);

    // Ban Bob -> writes exact `banned:88802 = "1"` key
    const bannedBob = await applyVisitorAction(env, '88802', 'ban');
    expect(bannedBob.isBanned).toBe(true);
    expect(await kv.get('banned:88802')).toBe('1');

    // Add note & filter
    await applyVisitorAction(env, '88802', 'note', { note: '广告推销号' });
    const bannedOnly = await listVisitors(env, { filter: 'banned', search: '广告' });
    expect(bannedOnly.items).toHaveLength(1);
    expect(bannedOnly.items[0].userId).toBe('88802');

    // Unban & Trust
    await applyVisitorAction(env, '88802', 'trust');
    const trustedBob = await getVisitorDetail(env, '88802');
    expect(trustedBob.isBanned).toBe(false);
    expect(trustedBob.isTrusted).toBe(true);
    expect(await kv.get('verified:88802')).toBe('trusted');

    // Single-key visitor overview cache hit & auto-invalidation on mutation
    const listSpy = vi.spyOn(kv, 'list');
    const ov1 = await getVisitorOverview(env);
    expect(ov1.stats.total).toBe(2);
    expect(ov1.cached).toBe(false);
    // Migration flag prevents future KV.list calls
    expect(listSpy).toHaveBeenCalledTimes(0);

    const ov2 = await getVisitorOverview(env);
    expect(ov2.cached).toBe(true);
    expect(ov2.stats.total).toBe(2);

    await applyVisitorAction(env, '88802', 'ban');
    const ov3 = await getVisitorOverview(env);
    expect(ov3.cached).toBe(false);
    expect(ov3.stats.banned).toBe(1);
  });
});

describe('Komari probe adapter', () => {
  it('normalizes Komari metrics accurately', () => {
    const node = normalizeNodeMetrics(
      {
        uuid: 'node-1',
        name: 'Tokyo Edge',
        region: '🇯🇵',
        tags: 'jp;bgp',
        mem_total: 2147483648,
        disk_total: 42949672960,
        os: 'Debian 12',
        arch: 'amd64',
      },
      {
        cpu: { usage: 18.44, load1: 0.35 },
        ram: { total: 2147483648, used: 1073741824 },
        disk: { total: 42949672960, used: 10737418240 },
        network: { up: 102400, down: 512000, totalUp: 1000000, totalDown: 2000000 },
        uptime: 86400,
      }
    );

    expect(node.online).toBe(true);
    expect(node.cpuUsage).toBe(18.4);
    expect(node.ramUsage).toBe(50);
    expect(node.diskUsage).toBe(25);
    expect(node.tags).toEqual(['jp', 'bgp']);
  });

  it('normalizes Komari v2 flat numeric RPC2 status fields (ram, disk, load, online)', () => {
    const node = normalizeNodeMetrics(
      {
        uuid: 'node-v2',
        name: 'Tokyo VPS',
        region: '🇯🇵',
        mem_total: 456126464,
        disk_total: 3227110400,
        os: 'Alpine Linux',
        arch: 'amd64',
      },
      {
        client: 'node-v2',
        cpu: 12.5,
        ram: 228063232,
        ram_total: 456126464,
        disk: 806777600,
        disk_total: 3227110400,
        load: 0.42,
        net_in: 436,
        net_out: 562,
        net_total_up: 5000,
        net_total_down: 6000,
        online: true,
        uptime: 4101474,
      }
    );

    expect(node.online).toBe(true);
    expect(node.cpuUsage).toBe(12.5);
    expect(node.ramUsed).toBe(228063232);
    expect(node.ramUsage).toBe(50);
    expect(node.diskUsed).toBe(806777600);
    expect(node.diskUsage).toBe(25);
    expect(node.load1).toBe(0.42);
    expect(node.netDown).toBe(436);
    expect(node.netUp).toBe(562);
  });

  it('detects redirect loops immediately without exhausting subrequests', async () => {
    const origFetch = globalThis.fetch;
    const mockFetch = vi.fn(async (url) => {
      return new Response(null, {
        status: 301,
        headers: { Location: url },
      });
    });
    globalThis.fetch = mockFetch;

    try {
      const env = makeEnv({ TOPIC_MAP: createMemoryKV() });
      const res = await fetchKomariStatus(env, {
        ...DEFAULT_CONFIG.probe,
        url: 'https://probe.example.com',
      });
      expect(res.protocol).toBe('error');
      expect(res.error).toContain('重定向循环');
      // Only 2 parallel RPC2 probes sent (no 20-hop loop, no wasted REST fallback)
      expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns demo nodes when demoMode is enabled without URL', async () => {
    const env = makeEnv({ TOPIC_MAP: createMemoryKV() });
    const status = await fetchKomariStatus(env, { ...DEFAULT_CONFIG.probe, demoMode: true, url: '' });
    expect(status.configured).toBe(true);
    expect(status.demo).toBe(true);
    expect(status.nodes.length).toBeGreaterThan(0);
    expect(status.summary.online).toBeGreaterThan(0);
  });

  it('fetches live Komari RPC2 nodes when endpoint responds', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'common:getNodes') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              'uuid-hk': { name: 'HK-01', region: '🇭🇰', mem_total: 1000, disk_total: 2000 },
            },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            'uuid-hk': {
              cpu: { usage: 22.5 },
              ram: { total: 1000, used: 400 },
              disk: { total: 2000, used: 500 },
              uptime: 3600,
            },
          },
        }),
        { status: 200 }
      );
    });

    try {
      const env = makeEnv({ TOPIC_MAP: createMemoryKV() });
      const res = await fetchKomariStatus(env, {
        ...DEFAULT_CONFIG.probe,
        url: 'https://probe.example.com',
      });
      expect(res.protocol).toBe('rpc2');
      expect(res.nodes).toHaveLength(1);
      expect(res.nodes[0].name).toBe('HK-01');
      expect(res.nodes[0].ramUsage).toBe(40);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('Worker API authorization & config masking', () => {
  const token = '987654:UNIT_TEST_BOT_TOKEN';

  it('blocks non-admin access to admin endpoints and allows admin config update with secret preservation', async () => {
    const env = makeEnv({
      TOPIC_MAP: createMemoryKV(),
      BOT_TOKEN: token,
      ADMIN_IDS: '10001',
    });

    const now = Math.floor(Date.now() / 1000);
    const guestInit = await signInitData(
      { auth_date: String(now), user: JSON.stringify({ id: 20002, first_name: 'Guest' }) },
      token
    );
    const adminInit = await signInitData(
      { auth_date: String(now), user: JSON.stringify({ id: 10001, first_name: 'Rose' }) },
      token
    );

    // Health check
    const healthRes = await worker.fetch(new Request('https://example.workers.dev/health'), env);
    expect(healthRes.status).toBe(200);

    // Guest blocked from admin visitors
    const forbidden = await worker.fetch(
      new Request('https://example.workers.dev/api/admin/visitors', {
        headers: { 'X-Telegram-Init-Data': guestInit },
      }),
      env
    );
    expect(forbidden.status).toBe(403);

    // Admin saves config with secret Komari API key
    await savePanelConfig(env, { probe: { url: 'https://komari.test', apiKey: 'super-secret-key' } });

    // Admin reads masked config via bootstrap
    const bootRes = await worker.fetch(
      new Request('https://example.workers.dev/api/bootstrap', {
        headers: { 'X-Telegram-Init-Data': adminInit },
      }),
      env
    );
    const bootJson = await bootRes.json();
    expect(bootJson.ok).toBe(true);
    expect(bootJson.isAdmin).toBe(true);
    expect(bootJson.adminConfig.probe.apiKey).toBe('********');

    // Admin updates display name while sending masked apiKey back -> secret stays intact!
    await worker.fetch(
      new Request('https://example.workers.dev/api/admin/config', {
        method: 'PUT',
        headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: { displayName: 'Rose Studio' },
          probe: { url: 'https://komari.test', apiKey: '********' },
        }),
      }),
      env
    );

    const persisted = await loadPanelConfig(env);
    expect(persisted.profile.displayName).toBe('Rose Studio');
    expect(persisted.probe.apiKey).toBe('super-secret-key');
  });

  it('strictly hides private sites from non-admin visitors while letting admin toggle visibility', async () => {
    const env = makeEnv({
      TOPIC_MAP: createMemoryKV(),
      BOT_TOKEN: token,
      ADMIN_IDS: '10001',
    });

    await savePanelConfig(env, {
      sites: [
        { id: 'pub-1', name: '公开博客', url: 'https://blog.test', visibility: 'public' },
        { id: 'priv-1', name: '私密后台', url: 'https://secret.test', visibility: 'private' },
      ],
    });

    const now = Math.floor(Date.now() / 1000);
    const guestInit = await signInitData(
      { auth_date: String(now), user: JSON.stringify({ id: 20002, first_name: 'Guest' }) },
      token
    );
    const adminInit = await signInitData(
      { auth_date: String(now), user: JSON.stringify({ id: 10001, first_name: 'Rose' }) },
      token
    );

    // Guest bootstrap MUST NOT leak private sites or admin visitor data
    const guestBoot = await (
      await worker.fetch(
        new Request('https://example.workers.dev/api/bootstrap', {
          headers: { 'X-Telegram-Init-Data': guestInit },
        }),
        env
      )
    ).json();
    expect(guestBoot.config.sites.map((s) => s.id)).toEqual(['pub-1']);
    expect(guestBoot.visitorSummary).toBeNull();
    expect(guestBoot.recentVisitors).toEqual([]);
    expect(guestBoot.blockedSpamCount).toBe(0);

    // Admin bootstrap sees both public & private sites plus owner dashboard summary
    const adminBoot = await (
      await worker.fetch(
        new Request('https://example.workers.dev/api/bootstrap', {
          headers: { 'X-Telegram-Init-Data': adminInit },
        }),
        env
      )
    ).json();
    expect(adminBoot.config.sites.map((s) => s.id)).toEqual(['pub-1', 'priv-1']);
    expect(adminBoot.visitorSummary).toBeTruthy();
    expect(Array.isArray(adminBoot.recentVisitors)).toBe(true);
    expect(typeof adminBoot.blockedSpamCount).toBe('number');

    // Admin toggles pub-1 -> private via quick toggle endpoint
    const toggled = await (
      await worker.fetch(
        new Request('https://example.workers.dev/api/admin/sites/toggle', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'pub-1', visibility: 'private' }),
        }),
        env
      )
    ).json();
    expect(toggled.ok).toBe(true);
    expect(toggled.config.sites.find((s) => s.id === 'pub-1').visibility).toBe('private');

    // Now guest sees zero sites
    const guestBootAfter = await (
      await worker.fetch(
        new Request('https://example.workers.dev/api/bootstrap', {
          headers: { 'X-Telegram-Init-Data': guestInit },
        }),
        env
      )
    ).json();
    expect(guestBootAfter.config.sites).toHaveLength(0);

    // Private probe visibility hides probe from guest and blocks /api/probe with 403
    await savePanelConfig(env, {
      probe: { url: 'https://komari.internal', visibility: 'private' },
      profile: { splash: { style: 'emoji', emoji: '✨', text: '欢迎光临' } },
    });
    const guestPrivProbeBoot = await (
      await worker.fetch(
        new Request('https://example.workers.dev/api/bootstrap', {
          headers: { 'X-Telegram-Init-Data': guestInit },
        }),
        env
      )
    ).json();
    expect(guestPrivProbeBoot.config.probe.configured).toBe(false);
    expect(guestPrivProbeBoot.config.probe.publicUrl).toBe('');
    expect(guestPrivProbeBoot.config.profile.splash).toEqual({
      style: 'emoji',
      emoji: '✨',
      text: '欢迎光临',
    });

    const guestProbeDenied = await worker.fetch(
      new Request('https://example.workers.dev/api/probe', {
        headers: { 'X-Telegram-Init-Data': guestInit },
      }),
      env
    );
    expect(guestProbeDenied.status).toBe(403);

    // Worker injects safe __ROSE_SPLASH__ payload into HTML responses on /
    const envWithAssets = {
      ...env,
      ASSETS: {
        async fetch() {
          return new Response('<!doctype html><html><head><title>App</title></head><body></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        },
      },
    };
    const htmlRes = await worker.fetch(new Request('https://example.workers.dev/'), envWithAssets);
    const htmlBody = await htmlRes.text();
    expect(htmlBody).toContain('window.__ROSE_SPLASH__=');
    expect(htmlBody).toContain('欢迎光临');
  });
});

describe('Telegram sticker pack parser & metadata normalizer', () => {
  it('parses addstickers, addemoji URLs and plain names', () => {
    expect(parseStickerPackName('https://t.me/addstickers/RoseBadges')).toBe('RoseBadges');
    expect(parseStickerPackName('https://t.me/addemoji/My_Emoji_Pack_2026')).toBe('My_Emoji_Pack_2026');
    expect(parseStickerPackName('CustomPack123')).toBe('CustomPack123');
    expect(parseStickerPackName('https://example.com/nope')).toBe('');
  });

  it('normalizes webp, webm, and animated tgs sticker formats', () => {
    expect(normalizeStickerObject({ file_id: 'f1', is_animated: true, emoji: '✨' }).format).toBe('tgs');
    expect(normalizeStickerObject({ file_id: 'f2', is_video: true, emoji: '🌸' }).format).toBe('webm');
    expect(normalizeStickerObject({ file_id: 'f3', emoji: '🎀' }).format).toBe('webp');
  });
});

describe('Visitor bidirectional archive, signed media proxy & clear history', () => {
  it('extracts photos & links from both directions, signs media tokens, and clears archive/full topic', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '111222:MEDIA_TEST_SECRET',
      SUPERGROUP_ID: '-100999888',
      ADMIN_IDS: '10001',
    });

    await upsertVisitorProfile(env, { id: 30003, first_name: 'Clara', username: 'clara_tg' }, { threadId: 77 });

    // Visitor sends a photo with caption link
    const visitorPhotoMsg = {
      message_id: 501,
      photo: [
        { file_id: 'thumb_file_id_1234567890' },
        { file_id: 'full_file_id_123456789012' },
      ],
      caption: '看一下这个 https://example.com/demo 和 t.me/Rose202_bot',
    };
    expect(extractPhotoFromMessage(visitorPhotoMsg).fileId).toBe('full_file_id_123456789012');
    expect(extractLinksFromMessage(visitorPhotoMsg)).toEqual([
      'https://example.com/demo',
      'https://t.me/Rose202_bot',
    ]);

    await recordVisitorExchange(env, '30003', visitorPhotoMsg, {
      sender: 'visitor',
      pmMessageId: 501,
      preview: '[图片]',
    });

    // Admin replies with a text_link entity
    const adminReplyMsg = {
      message_id: 902,
      text: '点这里查看文档',
      entities: [{ type: 'text_link', offset: 0, length: 3, url: 'https://docs.example.org/guide' }],
    };
    await recordVisitorExchange(env, '30003', adminReplyMsg, {
      sender: 'admin',
      pmMessageId: 502,
      preview: '点这里查看文档',
    });

    const detail = await getVisitorDetail(env, '30003');
    expect(detail.msg_count).toBe(2);
    expect(detail.visitor_msg_count).toBe(1);
    expect(detail.admin_msg_count).toBe(1);
    expect(detail.photo_count).toBe(1);
    expect(detail.link_count).toBe(3);

    // Media token signing & tampering rejection
    const signed = await signMediaToken('full_file_id_123456789012', env.BOT_TOKEN, 600);
    expect(await verifyMediaToken('full_file_id_123456789012', signed.exp, signed.sig, env.BOT_TOKEN)).toBe(true);
    expect(await verifyMediaToken('other_file_id_000000000000', signed.exp, signed.sig, env.BOT_TOKEN)).toBe(false);

    // Full clear calls deleteMessages & deleteForumTopic and wipes counters/history
    const calls = [];
    const mockTgCall = vi.fn(async (_env, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: true };
    });

    const cleared = await clearVisitorHistory(env, '30003', 'full', mockTgCall);
    expect(cleared.deletedTopic).toBe(true);
    expect(cleared.deletedPmCount).toBe(2);
    expect(cleared.visitor.msg_count).toBe(0);
    expect(cleared.visitor.photo_count).toBe(0);
    expect(cleared.visitor.link_count).toBe(0);
    expect(cleared.visitor.thread_id).toBeNull();
    expect((await getVisitorHistory(env, '30003')).photos).toHaveLength(0);
    expect(calls.map((c) => c.method)).toContain('deleteForumTopic');
    expect(calls.map((c) => c.method)).toContain('deleteMessages');
  });
});

describe('3-Mode Anti-Spam Verification (Emoji / Quiz / CF Turnstile)', () => {
  it('generates valid 3x3 Emoji challenges (with optional honeypot) and 2x2 Quiz challenges', () => {
    const emojiChal = generateInlineChallenge('emoji', 'vid123', true);
    expect(emojiChal.keyboard).toHaveLength(4); // 3 rows + 1 honeypot trap row
    expect(emojiChal.keyboard[3][0].callback_data).toBe('v:vid123:trap');
    expect(emojiChal.correctIndex).toBeGreaterThanOrEqual(0);
    expect(emojiChal.correctIndex).toBeLessThan(9);
    expect(emojiChal.keyboard.slice(0, 3).flat()[emojiChal.correctIndex].callback_data).toBe(
      `v:vid123:${emojiChal.correctIndex}`
    );

    const quizChal = generateInlineChallenge('quiz', 'vid456', false);
    expect(quizChal.keyboard).toHaveLength(2);
    expect(quizChal.keyboard.flat()).toHaveLength(4);
    expect(quizChal.correctIndex).toBeGreaterThanOrEqual(0);
    expect(quizChal.correctIndex).toBeLessThan(4);

    // Custom TG Sticker Quiz parser & generator (supports |, spaces, commas, newlines)
    const parsed = parseStickerQuizInput('这个表情在干嘛？ | 两条腿在晃 | 两个胳膊在晃 | 在睡觉 | 在吃饭');
    expect(parsed.question).toBe('这个表情在干嘛？');
    expect(parsed.answer).toBe('两条腿在晃');
    expect(parsed.wrong).toEqual(['两个胳膊在晃', '在睡觉', '在吃饭']);

    const parsedSpaces = parseStickerQuizInput('这个表情是什么情绪？ 惊讶 开心 生气 困了');
    expect(parsedSpaces.question).toBe('这个表情是什么情绪？');
    expect(parsedSpaces.answer).toBe('惊讶');
    expect(parsedSpaces.wrong).toEqual(['开心', '生气', '困了']);

    const sq = generateStickerChallenge(
      [{ id: 'sq1', fileId: 'CAAC_TEST_STICKER_123456', ...parsed }],
      'vid999',
      true
    );
    expect(sq.fileId).toBe('CAAC_TEST_STICKER_123456');
    expect(sq.keyboard[sq.keyboard.length - 1][0].callback_data).toBe('v:vid999:trap');
    const answerRowBtns = sq.keyboard.slice(0, -1).flat();
    expect(answerRowBtns[sq.correctIndex].text).toBe('两条腿在晃');
  });

  it('renders Cloudflare Turnstile strict verification page cleanly', async () => {
    const res = renderTurnstileVerifyPage('0xTEST_SITE_KEY', 'vid789');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
    expect(html).toContain('0xTEST_SITE_KEY');
    expect(html).toContain('vid789');
  });
});

describe('4-Layer Intelligent Anti-Spam Shield', () => {
  it('de-obfuscates zero-width, full-width, and Cyrillic homoglyphs and flags photo flyers & keywords', () => {
    const norm = normalizeAntiSpamText('Ｕ\u200bＳ\u200bＤ\u200bＴ 换汇 t.mе/sсаm');
    expect(norm.zeroWidthCount).toBe(3);
    expect(norm.normalized).toContain('usdt');
    expect(norm.normalized).toContain('t.me/scam');

    const kwRisk = assessIncomingRisk(
      { text: '高薪兼职 Ｕ\u200bＳ\u200bＤ\u200bＴ 日结', from: { first_name: 'Alice' } },
      { blockedKeywords: 'USDT, 赌场, 机场' }
    );
    expect(kwRisk.isBlockedKeyword).toBe(true);
    expect(kwRisk.matchedKeyword).toBe('usdt');

    const flyerRisk = assessIncomingRisk(
      { photo: [{ file_id: 'flyer_123' }], from: { first_name: 'Promo' } },
      { blockUnverifiedMedia: true }
    );
    expect(flyerRisk.isHighRisk).toBe(true);
    expect(flyerRisk.isMedia).toBe(true);
    expect(flyerRisk.reasons).toContain('unverified_media');

    const cleanHuman = assessIncomingRisk(
      { text: '你好呀，请问你的项目怎么配置？', from: { first_name: '小明' } },
      { blockedKeywords: 'USDT, 赌场, 机场', blockUnverifiedMedia: true }
    );
    expect(cleanHuman.isBlockedKeyword).toBe(false);
    expect(cleanHuman.isHighRisk).toBe(false);
  });

  it('checks CAS blacklist with KV caching and fails open on network errors', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv });

    const spamFetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { offenses: 3 } }), { status: 200 })
    );
    const r1 = await checkCasBlacklist(env, '999001', spamFetch);
    expect(r1.isSpammer).toBe(true);
    expect(await kv.get('cas:999001')).toBe('1');

    // Second lookup hits KV cache without calling fetch
    const r2 = await checkCasBlacklist(env, '999001', spamFetch);
    expect(r2.isSpammer).toBe(true);
    expect(r2.cached).toBe(true);
    expect(spamFetch).toHaveBeenCalledTimes(1);

    // Network error fails open cleanly
    const brokenFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const r3 = await checkCasBlacklist(env, '999002', brokenFetch);
    expect(r3.isSpammer).toBe(false);
  });
});

describe('One-click /bind & /unbind Forum Inbox binding', () => {
  it('allows authorized admin to bind and unbind a Forum supergroup while blocking strangers', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '123456:BIND_TEST_TOKEN',
      ADMIN_IDS: '10001',
    });

    const tgCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      if (method === 'getChat') {
        return new Response(JSON.stringify({ ok: true, result: { id: body.chat_id, is_forum: true, title: '通知群' } }), {
          status: 200,
        });
      }
      if (method === 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: { id: 999, is_bot: true } }), { status: 200 });
      }
      if (method === 'getChatMember') {
        return new Response(
          JSON.stringify({ ok: true, result: { status: 'administrator', can_manage_topics: true } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    try {
      // 1. Stranger attempting /bind is silently ignored
      await handleTelegramUpdate(
        {
          message: {
            message_id: 1,
            from: { id: 88888, first_name: 'Stranger' },
            chat: { id: -1005555555, type: 'supergroup', title: 'Hijack' },
            text: '/bind',
          },
        },
        env,
        'https://panel.test'
      );
      expect(await resolveSupergroupId(env)).toBe('');

      // 2. Admin running /bind in a Forum supergroup binds it to KV
      await handleTelegramUpdate(
        {
          message: {
            message_id: 2,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -1007777888, type: 'supergroup', title: '通知群' },
            text: '/bind',
          },
        },
        env,
        'https://panel.test'
      );
      expect(await resolveSupergroupId(env)).toBe('-1007777888');
      expect(tgCalls.some((c) => c.method === 'sendMessage' && c.body.text?.includes('绑定成功'))).toBe(true);

      // 3. Admin running /unbind inside the bound supergroup clears the KV binding
      await handleTelegramUpdate(
        {
          message: {
            message_id: 3,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -1007777888, type: 'supergroup', title: '通知群' },
            text: '/unbind',
          },
        },
        env,
        'https://panel.test'
      );
      expect(await resolveSupergroupId(env)).toBe('');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('Security hardening: webhook secret, /setup guard & DEV_PREVIEW scope', () => {
  const baseEnv = () => (makeEnv({
    TOPIC_MAP: createMemoryKV(),
    BOT_TOKEN: '987654:UNIT_TEST_BOT_TOKEN',
    ADMIN_IDS: '10001',
    WEBHOOK_SECRET: 'unit-test-secret',
  }));
  const forgedUpdate = JSON.stringify({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 10001, type: 'private' },
      from: { id: 10001, is_bot: false, first_name: 'Fake' },
      text: '/start',
    },
  });

  it('rejects forged updates without or with wrong secret header on BOTH /webhook and legacy root /', async () => {
    for (const path of ['/webhook', '/']) {
      const missingRes = await worker.fetch(
        new Request(`https://example.workers.dev${path}`, { method: 'POST', body: forgedUpdate }),
        baseEnv()
      );
      expect(missingRes.status).toBe(401);

      const wrongRes = await worker.fetch(
        new Request(`https://example.workers.dev${path}`, {
          method: 'POST',
          headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
          body: forgedUpdate,
        }),
        baseEnv()
      );
      expect(wrongRes.status).toBe(401);
    }
  });

  it('refuses /setup when WEBHOOK_SECRET is missing (500) or mismatched (403)', async () => {
    const missingEnv = baseEnv();
    delete missingEnv.WEBHOOK_SECRET;
    const missingRes = await worker.fetch(new Request('https://example.workers.dev/setup'), missingEnv);
    expect(missingRes.status).toBe(500);
    expect((await missingRes.json()).ok).toBe(false);

    const wrongRes = await worker.fetch(
      new Request('https://example.workers.dev/setup?secret=wrong'),
      baseEnv()
    );
    expect(wrongRes.status).toBe(403);
    expect((await wrongRes.json()).ok).toBe(false);
  });

  it('ignores DEV_PREVIEW on public hosts and defaults localhost preview role to guest', async () => {
    const env = { ...baseEnv(), DEV_PREVIEW: 'true' };
    const publicAdmin = await worker.fetch(
      new Request('https://panel.example.com/api/admin/visitors', { headers: { 'X-Dev-Role': 'admin' } }),
      env
    );
    expect(publicAdmin.status).toBe(403);

    const publicBoot = await worker.fetch(
      new Request('https://panel.example.com/api/bootstrap', { headers: { 'X-Dev-Role': 'admin' } }),
      env
    );
    expect((await publicBoot.json()).isAdmin).toBe(false);

    const localGuest = await worker.fetch(new Request('http://localhost:8787/api/bootstrap'), env);
    expect((await localGuest.json()).isAdmin).toBe(false);

    const localAdmin = await worker.fetch(
      new Request('http://localhost:8787/api/bootstrap', { headers: { 'X-Dev-Role': 'admin' } }),
      env
    );
    expect((await localAdmin.json()).isAdmin).toBe(true);
  });
});

function createMockWebSocket(onSend) {
  const listeners = { message: [], close: [], error: [] };
  const ws = {
    accepted: false,
    closed: false,
    accept() {
      this.accepted = true;
    },
    addEventListener(type, fn) {
      if (listeners[type]) listeners[type].push(fn);
    },
    emit(type, payload) {
      for (const fn of [...(listeners[type] || [])]) fn(payload);
    },
    send(data) {
      onSend?.(ws, data);
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close', {});
    },
  };
  return ws;
}

describe('Pluggable probe providers (Nezha v1 WS/REST & v0, NodeGet, generic JSON)', () => {
  const env = () => (makeEnv({ TOPIC_MAP: createMemoryKV() }));

  it('fetches public Nezha v1 dashboards over /api/v1/ws/server without a token and converts country codes to flags', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://nezha.test/api/v1/ws/server');
      expect(init.headers.Upgrade).toBe('websocket');
      expect(init.headers.Origin).toBe('https://nezha.test');
      const ws = createMockWebSocket();
      const origAccept = ws.accept.bind(ws);
      ws.accept = () => {
        origAccept();
        queueMicrotask(() => {
          ws.emit('message', {
            data: JSON.stringify({
              now: Date.now(),
              online: 1,
              servers: [
                {
                  id: 7,
                  name: 'HK-Public',
                  country_code: 'hk',
                  host: { platform: 'debian', mem_total: 2048, disk_total: 4096, cpu: ['AMD EPYC'] },
                  state: { cpu: 18.5, mem_used: 1024, disk_used: 1024, net_in_speed: 100, net_out_speed: 200, uptime: 3600 },
                  last_active: new Date().toISOString(),
                },
              ],
            }),
          });
        });
      };
      return { status: 101, webSocket: ws };
    });

    try {
      const res = await fetchKomariStatus(env(), { provider: 'nezha', url: 'https://nezha.test' }, { forceRefresh: true });
      expect(res.protocol).toBe('nezha-v1-ws');
      expect(res.provider).toBe('nezha');
      expect(res.nodes[0]).toMatchObject({
        name: 'HK-Public',
        region: '🇭🇰',
        online: true,
        cpuUsage: 18.5,
        ramUsage: 50,
        diskUsage: 25,
        netUp: 200,
        netDown: 100,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('supports authenticated Nezha v1 REST and falls back to Nezha v0 raw-token REST', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/api/v1/server')) {
        expect(init.headers.Authorization).toBe('Bearer tok123');
        return new Response('Unauthorized', { status: 401 });
      }
      if (String(url).endsWith('/api/v1/ws/server')) {
        return new Response('Forbidden', { status: 403 });
      }
      if (String(url).endsWith('/api/v1/server/details')) {
        // Nezha v0 expects raw token without "Bearer "
        expect(init.headers.Authorization).toBe('tok123');
        return new Response(
          JSON.stringify({
            code: 0,
            result: [
              {
                id: 2,
                name: 'JP-v0',
                tag: 'Asia',
                host: { Platform: 'ubuntu', CountryCode: 'jp', MemTotal: 4000, DiskTotal: 8000 },
                status: { CPU: 25, MemUsed: 1000, DiskUsed: 4000, NetInSpeed: 50, NetOutSpeed: 80, Uptime: 500 },
                last_active: Math.floor(Date.now() / 1000),
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      const res = await fetchKomariStatus(
        env(),
        { provider: 'nezha', url: 'https://nezha-v0.test', apiKey: 'tok123' },
        { forceRefresh: true }
      );
      expect(res.protocol).toBe('nezha-v0');
      expect(res.nodes[0]).toMatchObject({
        name: 'JP-v0',
        region: '🇯🇵',
        group: 'Asia',
        online: true,
        cpuUsage: 25,
        ramUsage: 25,
        diskUsage: 50,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('fetches NodeGet (NodeSeek official probe) nodes via WebSocket JSON-RPC 2.0 and filters hidden nodes', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://nodeget.test');
      expect(init.headers.Upgrade).toBe('websocket');
      const ws = createMockWebSocket((sock, raw) => {
        const req = JSON.parse(raw);
        expect(req.params.token).toBe('ng-token');
        let result;
        if (req.method === 'nodeget-server_list_all_agent_uuid') {
          result = { uuids: ['u-pub', 'u-stale', 'u-hid'] };
        } else if (req.method === 'kv_get_multi_value') {
          result = [
            { namespace: 'u-pub', key: 'metadata_name', value: 'Tokyo-NG' },
            { namespace: 'u-pub', key: 'metadata_region', value: 'jp' },
            { namespace: 'u-pub', key: 'metadata_tags', value: ['NodeSeek', 'BGP'] },
            { namespace: 'u-stale', key: 'metadata_name', value: 'Stale-NG' },
            { namespace: 'u-hid', key: 'metadata_hidden', value: true },
          ];
        } else if (req.method === 'agent_static_data_multi_last_query') {
          result = [
            {
              uuid: 'u-pub',
              system: { distribution_id: 'debian', cpu_arch: 'amd64', virtualization: 'kvm' },
              cpu: { brand: 'AMD EPYC 9654', logical_cores: 4 },
            },
          ];
        } else if (req.method === 'agent_dynamic_summary_multi_last_query') {
          result = [
            {
              uuid: 'u-pub',
              timestamp: Math.floor(Date.now() / 1000),
              cpu_usage: 14.2,
              used_memory: 1000,
              total_memory: 4000,
              total_space: 10000,
              available_space: 6000,
              receive_speed: 300,
              transmit_speed: 500,
              load_one: 0.42,
              uptime: 86400,
            },
            {
              uuid: 'u-stale',
              // 45s old -> offline under NodeGet-StatusShow 30s threshold
              timestamp: Math.floor((Date.now() - 45_000) / 1000),
              cpu_usage: 5,
            },
          ];
        }
        queueMicrotask(() => {
          sock.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
        });
      });
      return { status: 101, webSocket: ws };
    });

    try {
      const res = await fetchKomariStatus(
        env(),
        { provider: 'nodeget', url: 'wss://nodeget.test', apiKey: 'ng-token' },
        { forceRefresh: true }
      );
      expect(res.protocol).toBe('nodeget-rpc');
      expect(res.nodes).toHaveLength(2);
      expect(res.nodes[0]).toMatchObject({
        uuid: 'u-pub',
        name: 'Tokyo-NG',
        region: '🇯🇵',
        online: true,
        cpuUsage: 14.2,
        ramUsage: 25,
        diskUsage: 40,
        netUp: 500,
        netDown: 300,
      });
      expect(res.nodes[1]).toMatchObject({ uuid: 'u-stale', name: 'Stale-NG', online: false });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('auto-detects generic JSON probes, isolates KV cache by provider, and rejects empty URL test', async () => {
    const kv = createMemoryKV();
    const testEnv = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:ABC', ADMIN_IDS: '10001', DEV_PREVIEW: 'true' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          servers: [{ name: 'CF-1', location: 'us', online: true, cpu: 0.3, memory_total: 1000, memory_used: 250, uptime: 50 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    try {
      const res = await fetchKomariStatus(
        testEnv,
        { provider: 'json', url: 'https://probe.test/api/stats.json' },
        { forceRefresh: false }
      );
      expect(res.protocol).toBe('json');
      expect(res.nodes[0]).toMatchObject({ name: 'CF-1', region: '🇺🇸', online: true, cpuUsage: 30, ramUsage: 25 });

      // Empty URL test in admin endpoint returns 400 instead of false-positive success
      const emptyTestRes = await worker.fetch(
        new Request('http://localhost:8787/api/admin/probe/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Dev-Role': 'admin' },
          body: JSON.stringify({ provider: 'json', url: '', demoMode: false }),
        }),
        testEnv
      );
      expect(emptyTestRes.status).toBe(400);
      expect((await emptyTestRes.json()).ok).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('In-app version checker (Scheme A) & optional Fork syncer (Scheme B)', () => {
  it('keeps APP_VERSION in sync with package.json and compares SemVer accurately', () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(compareSemver('v1.4.0', '1.3.0')).toBe(1);
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1);
    expect(compareSemver('v1.3.0', '1.3.0')).toBe(0);
    expect(compareSemver('1.2.9', '1.3.0')).toBe(-1);
    expect(compareSemver('v1.4.0-beta.1', '1.3.0')).toBe(1);
  });

  it('checks latest GitHub release with 6h KV caching and supports forceRefresh', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv });
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      expect(String(url)).toBe('https://api.github.com/repos/mango0114/rose-panel-bot/releases/latest');
      return new Response(
        JSON.stringify({
          tag_name: 'v9.9.9',
          name: 'v9.9.9 — Future',
          html_url: 'https://github.com/mango0114/rose-panel-bot/releases/tag/v9.9.9',
          published_at: '2026-12-01T00:00:00Z',
          body: 'New features!',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    try {
      const r1 = await checkLatestRelease(env);
      expect(r1.ok).toBe(true);
      expect(r1.hasUpdate).toBe(true);
      expect(r1.latestVersion).toBe('9.9.9');
      expect(r1.cached).toBe(false);

      // Second call hits KV cache without calling fetch again
      const r2 = await checkLatestRelease(env);
      expect(r2.cached).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      // forceRefresh bypasses cache
      const r3 = await checkLatestRelease(env, { forceRefresh: true });
      expect(r3.cached).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('falls back to raw package.json on GitHub 403/429 rate limits and caches errors for 30 min', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv });
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('api.github.com')) {
        return new Response('rate limited', { status: 403 });
      }
      expect(String(url)).toBe('https://raw.githubusercontent.com/mango0114/rose-panel-bot/main/package.json');
      return new Response(JSON.stringify({ version: '9.1.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      const fallbackRes = await checkLatestRelease(env);
      expect(fallbackRes.ok).toBe(true);
      expect(fallbackRes.latestVersion).toBe('9.1.0');
      expect(fallbackRes.hasUpdate).toBe(true);
      expect(fallbackRes.fallbackSource).toBe('raw-package-json');

      // When both API and raw fail, cache error for 30 min so repeat opens don't hammer GitHub
      globalThis.fetch = vi.fn(async () => new Response('down', { status: 503 }));
      const fail1 = await checkLatestRelease(env, { forceRefresh: true });
      expect(fail1.ok).toBe(false);
      expect(fail1.cached).toBe(false);

      const fail2 = await checkLatestRelease(env);
      expect(fail2.ok).toBe(false);
      expect(fail2.cached).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('never writes env GITHUB_UPDATE_TOKEN into KV on savePanelConfig and returns clear 422 message for non-fork copies', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '123:ENV_TOK_TEST',
      ADMIN_IDS: '10001',
      DEV_PREVIEW: 'true',
      GITHUB_UPDATE_TOKEN: 'env_super_secret_pat',
    });

    // Save config with masked placeholder while token is only provided via env Secret
    await savePanelConfig(env, { updater: { forkRepo: 'bob/rose-panel-bot', branch: 'main', githubToken: '********' } });
    const rawSaved = JSON.parse(await kv.get('config:panel'));
    expect(rawSaved.updater.githubToken).toBe('');
    expect(await kv.get('config:panel')).not.toContain('env_super_secret_pat');

    const adminBoot = await (
      await worker.fetch(new Request('http://localhost:8787/api/bootstrap', { headers: { 'X-Dev-Role': 'admin' } }), env)
    ).json();
    expect(adminBoot.adminConfig.updater.hasGithubToken).toBe(true);
    expect(adminBoot.adminConfig.updater.tokenFromEnv).toBe(true);

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toBe('Bearer env_super_secret_pat');
      return new Response(JSON.stringify({ message: 'This repository is not a fork' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      const syncRes = await worker.fetch(
        new Request('http://localhost:8787/api/admin/update/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Dev-Role': 'admin' },
          body: JSON.stringify({ forkRepo: 'bob/rose-panel-bot', branch: 'main', githubToken: '********' }),
        }),
        env
      );
      expect(syncRes.status).toBe(422);
      const data = await syncRes.json();
      expect(data.ok).toBe(false);
      expect(data.error).toContain('不是 Fork');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('validates fork repo strictly, syncs via GitHub merge-upstream, and masks/isolates token in API', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '123:UPD_TEST',
      ADMIN_IDS: '10001',
      DEV_PREVIEW: 'true',
    });

    // Rejects invalid repo, path traversal, and upstream self-sync
    expect((await syncForkWithUpstream(env, { forkRepo: '../evil', githubToken: 'tok' })).ok).toBe(false);
    expect((await syncForkWithUpstream(env, { forkRepo: 'mango0114/rose-panel-bot', githubToken: 'tok' })).ok).toBe(false);
    expect((await syncForkWithUpstream(env, { forkRepo: 'alice/rose-panel-bot', githubToken: '' })).ok).toBe(false);

    // Non-admin cannot access /api/admin/update/*
    const guestCheck = await worker.fetch(new Request('http://localhost:8787/api/admin/update/check'), env);
    expect(guestCheck.status).toBe(403);
    const guestSync = await worker.fetch(
      new Request('http://localhost:8787/api/admin/update/sync', { method: 'POST', body: '{}' }),
      env
    );
    expect(guestSync.status).toBe(403);

    // Save updater config with token, verify public config strips updater and admin masks token
    await savePanelConfig(env, {
      updater: { forkRepo: 'alice/rose-panel-bot', branch: 'main', githubToken: 'github_pat_secret123' },
    });
    const publicBoot = await (await worker.fetch(new Request('http://localhost:8787/api/bootstrap'), env)).json();
    expect(publicBoot.config.updater).toBeUndefined();

    const adminBoot = await (
      await worker.fetch(new Request('http://localhost:8787/api/bootstrap', { headers: { 'X-Dev-Role': 'admin' } }), env)
    ).json();
    expect(adminBoot.adminConfig.updater.githubToken).toBe('********');
    expect(adminBoot.adminConfig.updater.hasGithubToken).toBe(true);

    // Admin sync with masked placeholder reuses stored secret and calls merge-upstream
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://api.github.com/repos/alice/rose-panel-bot/merge-upstream');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer github_pat_secret123');
      expect(JSON.parse(init.body)).toEqual({ branch: 'main' });
      return new Response(JSON.stringify({ merge_type: 'fast-forward' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      const syncRes = await worker.fetch(
        new Request('http://localhost:8787/api/admin/update/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Dev-Role': 'admin' },
          body: JSON.stringify({ forkRepo: 'https://github.com/alice/rose-panel-bot', branch: 'main', githubToken: '********' }),
        }),
        env
      );
      expect(syncRes.status).toBe(200);
      const syncData = await syncRes.json();
      expect(syncData.ok).toBe(true);
      expect(syncData.alreadyLatest).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('Privacy-safe 3-way owner/bot card avatar proxy (/api/avatar/owner)', () => {
  it('defaults to bot avatar (ignoring client query overrides), switches to owner avatar when configured, and preserves legacy custom avatarUrl', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '555000:AVATAR_TEST_TOKEN',
      ADMIN_IDS: '999888',
    });

    const requestedUserIds = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/getUserProfilePhotos')) {
        const body = JSON.parse(init.body);
        requestedUserIds.push(body.user_id);
        return new Response(
          JSON.stringify({ ok: true, result: { photos: [[{ file_id: `photo_${body.user_id}` }]] } }),
          { status: 200 }
        );
      }
      if (u.endsWith('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg' } }), { status: 200 });
      }
      if (u.includes('/file/bot')) {
        return new Response('fake-jpeg-bytes', { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });

    try {
      // 1. Default mode = 'bot': fetches bot UID (555000), ignoring any ?mode=owner tamper attempt
      const botRes = await worker.fetch(new Request('https://panel.test/api/avatar/owner?mode=owner'), env);
      expect(botRes.status).toBe(200);
      expect(requestedUserIds.at(-1)).toBe(555000);

      // 2. Owner mode: fetches ADMIN_IDS[0] (999888) server-side without exposing UID to clients
      await savePanelConfig(env, { profile: { avatarMode: 'owner' } });
      const ownerRes = await worker.fetch(new Request('https://panel.test/api/avatar/owner'), env);
      expect(ownerRes.status).toBe(200);
      expect(requestedUserIds.at(-1)).toBe(999888);

      // 3. Legacy config with avatarUrl and no avatarMode automatically preserves 'custom'
      await kv.put('config:panel', JSON.stringify({ profile: { avatarUrl: 'https://cdn.test/me.png' } }));
      const legacyCfg = await loadPanelConfig(env);
      expect(legacyCfg.profile.avatarMode).toBe('custom');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('Topic visitor profile card clickable mention & optional avatar photo mode', () => {
  it('links visitor display name via tg://user?id= and sends compact text card by default', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '777000:CARD_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100999888',
    });
    await upsertVisitorProfile(
      env,
      { id: 424242, first_name: 'NoHandleUser' },
      { threadId: 77, incrementMsg: false }
    );
    await kv.put('thread:77', '424242');

    const tgCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), { status: 200 });
    });

    try {
      await handleTelegramUpdate(
        {
          message: {
            message_id: 50,
            message_thread_id: 77,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -100999888, type: 'supergroup' },
            text: '/info',
          },
        },
        env,
        'https://panel.test'
      );

      expect(tgCalls.some((c) => c.method === 'getUserProfilePhotos')).toBe(false);
      const sent = tgCalls.find((c) => c.method === 'sendMessage');
      expect(sent).toBeTruthy();
      expect(sent.body.text).toContain('<a href="tg://user?id=424242"><b>NoHandleUser</b></a>');
      expect(sent.body.text).toContain('未设置');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('sends photo visitor card when enabled, falls back when avatar hidden, and edits caption on moderation button', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '777000:CARD_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100999888',
    });
    await savePanelConfig(env, { pmBot: { showVisitorAvatarInCard: true } });
    await upsertVisitorProfile(
      env,
      { id: 515151, first_name: 'Alice', username: 'alice_tg' },
      { threadId: 88, incrementMsg: false }
    );
    await kv.put('thread:88', '515151');

    let returnAvatar = true;
    const tgCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      if (method === 'getUserProfilePhotos') {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              photos: returnAvatar
                ? [[{ file_id: 'small_id' }, { file_id: 'hd_avatar_file_id' }]]
                : [],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 20 } }), { status: 200 });
    });

    try {
      // 1. Visitor with public avatar -> sendPhoto with sharpest file_id + HTML caption
      await handleTelegramUpdate(
        {
          message: {
            message_id: 60,
            message_thread_id: 88,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -100999888, type: 'supergroup' },
            text: '/info',
          },
        },
        env,
        'https://panel.test'
      );
      const photoCall = tgCalls.find((c) => c.method === 'sendPhoto');
      expect(photoCall).toBeTruthy();
      expect(photoCall.body.photo).toBe('hd_avatar_file_id');
      expect(photoCall.body.caption).toContain('<a href="tg://user?id=515151"><b>Alice</b></a>');

      // 2. Moderation button click on photo card -> editMessageCaption (not editMessageText)
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cb_1',
            from: { id: 10001, first_name: 'Owner' },
            data: 'mod:trust:515151',
            message: {
              message_id: 20,
              chat: { id: -100999888, type: 'supergroup' },
              photo: [{ file_id: 'hd_avatar_file_id' }],
              caption: photoCall.body.caption,
            },
          },
        },
        env,
        'https://panel.test'
      );
      const editCap = tgCalls.find((c) => c.method === 'editMessageCaption');
      expect(editCap).toBeTruthy();
      expect(editCap.body.caption).toContain('永久信任');
      expect(tgCalls.some((c) => c.method === 'editMessageText')).toBe(false);

      // 3. Visitor with hidden/no avatar -> gracefully falls back to sendMessage
      tgCalls.length = 0;
      returnAvatar = false;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 61,
            message_thread_id: 88,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -100999888, type: 'supergroup' },
            text: '/info',
          },
        },
        env,
        'https://panel.test'
      );
      expect(tgCalls.some((c) => c.method === 'sendPhoto')).toBe(false);
      expect(tgCalls.some((c) => c.method === 'sendMessage')).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('Configurable /start verification-first flow & panel button visibility', () => {
  it('immediately triggers verification on stranger /start, prompts to chat after passing, and honors welcome/panel toggles', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '888000:WELCOME_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100999888',
    });

    const tgCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes('api.cas.chat')) {
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      }
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });

    const mkPrivateMsg = (text, uid = 20002) => ({
      message: {
        message_id: 100,
        from: { id: uid, first_name: 'Visitor' },
        chat: { id: uid, type: 'private' },
        text,
      },
    });

    try {
      const defaultCfg = await loadPanelConfig(env);
      expect(defaultCfg.pmBot.enableStartWelcome).toBe(true);
      expect(defaultCfg.pmBot.showPanelButtonInWelcome).toBe(true);

      // 1. Unverified stranger sends /start -> immediately receives verification challenge (with owner welcome header)
      await handleTelegramUpdate(mkPrivateMsg('/start'), env, 'https://panel.test');
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0].method).toBe('sendMessage');
      expect(tgCalls[0].body.text).toContain('私聊助手');
      expect(tgCalls[0].body.text).toContain('人机验证');
      const chalId = await kv.get('user_challenge:20002');
      expect(chalId).toBeTruthy();
      const chalState = JSON.parse(await kv.get(`chal:${chalId}`));
      expect(chalState.pending).toEqual([]); // /start is NOT queued as a chat message

      // Stranger passes verification -> message clearly tells them they can type directly now!
      tgCalls.length = 0;
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cq_pass_start',
            from: { id: 20002, first_name: 'Visitor' },
            data: `v:${chalId}:${chalState.correctIndex}`,
            message: { message_id: 1, chat: { id: 20002, type: 'private' } },
          },
        },
        env,
        'https://panel.test'
      );
      const editPass = tgCalls.find((c) => c.method === 'editMessageText');
      expect(editPass.body.text).toContain('现在您可以直接在下方输入框打字');
      expect(editPass.body.reply_markup?.inline_keyboard?.length).toBe(1);
      expect(tgCalls.some((c) => c.method === 'createForumTopic')).toBe(false);

      // 2. Now verified: /start with showPanelButtonInWelcome: false sends text-only ready-to-chat welcome
      tgCalls.length = 0;
      await savePanelConfig(env, { pmBot: { enableStartWelcome: true, showPanelButtonInWelcome: false } });
      await handleTelegramUpdate(mkPrivateMsg('/start'), env, 'https://panel.test');
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0].body.text).toContain('已完成验证');
      expect(tgCalls[0].body.reply_markup).toBeUndefined();

      // 3. Verified + enableStartWelcome: false -> /start stays silent, while /panel always opens panel
      tgCalls.length = 0;
      await savePanelConfig(env, { pmBot: { enableStartWelcome: false } });
      await handleTelegramUpdate(mkPrivateMsg('/start'), env, 'https://panel.test');
      expect(tgCalls).toHaveLength(0);

      await handleTelegramUpdate(mkPrivateMsg('/panel', 10001), env, 'https://panel.test');
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0].body.reply_markup?.inline_keyboard?.length).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('Auto-reply & keyword reply engine', () => {
  it('matches contains/exact keyword rules case-insensitively and skips disabled rules', () => {
    const rules = [
      { id: 'r1', keywords: '停用词', matchMode: 'contains', reply: 'nope', enabled: false },
      { id: 'r2', keywords: '菜单, menu', matchMode: 'exact', reply: '菜单列表', enabled: true },
      { id: 'r3', keywords: '友链，交换友链 | blog', matchMode: 'contains', reply: '欢迎互换友链', enabled: true },
    ];

    expect(matchKeywordReply('这是停用词', rules)).toBeNull();
    expect(matchKeywordReply('我要菜单', rules)).toBeNull(); // exact mode shouldn't match substring
    expect(matchKeywordReply('  MENU ', rules)?.rule.reply).toBe('菜单列表');
    const hit = matchKeywordReply('请问怎么交换友链呀？', rules);
    expect(hit?.matchedKeyword).toBe('友链');
    expect(hit?.rule.reply).toBe('欢迎互换友链');
    expect(matchKeywordReply('check my BLOG link', rules)?.matchedKeyword).toBe('blog');
  });

  it('replies to verified visitors via keyword rules (with optional silent no-forward) and enforces general auto-reply cooldown', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '999000:AUTOREPLY_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100777666',
    });

    await savePanelConfig(env, {
      pmBot: {
        autoReplyEnabled: true,
        autoReplyText: '站长暂时忙碌，稍后回复你～',
        autoReplyCooldownMinutes: 30,
        keywordReplies: [
          {
            id: 'k-silent',
            keywords: '菜单',
            matchMode: 'exact',
            reply: '这里是自助菜单',
            forwardToAdmin: false,
            enabled: true,
          },
          {
            id: 'k-forward',
            keywords: '友链, 合作',
            matchMode: 'contains',
            reply: '友链请发站名和链接',
            forwardToAdmin: true,
            enabled: true,
          },
          {
            id: 'k-invalid',
            keywords: ' , ， ',
            reply: 'should be filtered out',
          },
        ],
      },
    });
    const savedCfg = await loadPanelConfig(env);
    expect(savedCfg.pmBot.keywordReplies).toHaveLength(2);

    // Pre-verify visitor 30001 and bind existing topic 55
    await kv.put('verified:30001', 'emoji:v1');
    await upsertVisitorProfile(env, { id: 30001, first_name: 'Bob' }, { threadId: 55, incrementMsg: false });
    await kv.put('thread:55', '30001');

    const tgCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
    });

    const sendFromBob = (message_id, text) =>
      handleTelegramUpdate(
        {
          message: {
            message_id,
            from: { id: 30001, first_name: 'Bob' },
            chat: { id: 30001, type: 'private' },
            text,
          },
        },
        env,
        'https://panel.test'
      );

    try {
      // 1. Silent keyword rule (forwardToAdmin: false) -> replies to visitor, zero copyMessage to supergroup
      await sendFromBob(1, '菜单');
      expect(tgCalls.some((c) => c.method === 'copyMessage')).toBe(false);
      expect(tgCalls.some((c) => c.method === 'sendMessage' && c.body.chat_id === 30001 && c.body.text === '这里是自助菜单')).toBe(true);

      // 2. Forwarding keyword rule -> forwards to topic, replies to visitor, leaves silent topic note, does NOT trigger generic auto-reply
      tgCalls.length = 0;
      await sendFromBob(2, '你好想交换友链');
      expect(tgCalls.some((c) => c.method === 'copyMessage')).toBe(true);
      expect(tgCalls.some((c) => c.method === 'sendMessage' && c.body.chat_id === 30001 && c.body.text === '友链请发站名和链接')).toBe(true);
      expect(tgCalls.some((c) => c.method === 'sendMessage' && c.body.chat_id === '-100777666' && c.body.disable_notification === true)).toBe(true);
      expect(tgCalls.some((c) => c.body.text === '站长暂时忙碌，稍后回复你～')).toBe(false);

      // 3. Normal message -> forwards & sends general auto-reply ONCE; second message within cooldown does NOT repeat auto-reply
      tgCalls.length = 0;
      await sendFromBob(3, '请问服务器稳定吗？');
      expect(tgCalls.some((c) => c.method === 'copyMessage')).toBe(true);
      expect(tgCalls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === 30001 && c.body.text === '站长暂时忙碌，稍后回复你～')).toHaveLength(1);

      tgCalls.length = 0;
      await sendFromBob(4, '补充问一下带宽');
      expect(tgCalls.some((c) => c.method === 'copyMessage')).toBe(true);
      expect(tgCalls.some((c) => c.method === 'sendMessage' && c.body.chat_id === 30001)).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('never triggers keyword or general auto-reply for unverified strangers before verification passes', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '999000:AUTOREPLY_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100777666',
    });
    await savePanelConfig(env, {
      pmBot: {
        verificationMode: 'emoji',
        enableCasCheck: false,
        autoReplyEnabled: true,
        autoReplyText: '通用自动回复',
        keywordReplies: [{ id: 'k1', keywords: '菜单', matchMode: 'contains', reply: '自助菜单', forwardToAdmin: false }],
      },
    });

    const tgCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), { status: 200 });
    });

    try {
      await handleTelegramUpdate(
        {
          message: {
            message_id: 1,
            from: { id: 40001, first_name: 'Unverified' },
            chat: { id: 40001, type: 'private' },
            text: '菜单',
          },
        },
        env,
        'https://panel.test'
      );
      expect(tgCalls.some((c) => c.body.text === '自助菜单')).toBe(false);
      expect(tgCalls.some((c) => c.body.text === '通用自动回复')).toBe(false);
      expect(tgCalls.some((c) => c.body.text?.includes('人机验证'))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('v1.5.0 edge cases: caption limits, fallbacks, welcome toggles & pending keyword replay', () => {
  const visible = (html) => String(html).replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot);/g, '_').length;
  const baseDetail = {
    userId: '313131',
    displayName: 'Bob',
    username: '',
    status: 'verified',
    msg_count: 1,
  };

  function mockTelegram(overrides = {}) {
    const calls = [];
    const fetchMock = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ method, body });
      if (overrides[method]) return overrides[method](body);
      if (method === 'getUserProfilePhotos') {
        return new Response(
          JSON.stringify({ ok: true, result: { photos: [[{ file_id: 'small' }, { file_id: 'big_avatar' }]] } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5, message_thread_id: 99 } }), {
        status: 200,
      });
    });
    return { calls, fetchMock };
  }

  async function withFetch(fetchMock, fn) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      await fn();
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  const tgError = () =>
    new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }), { status: 400 });

  it('fits captions to the 1024 visible-char limit by trimming, then dropping the note, else returns null', () => {
    const shortNote = buildVisitorCardCaption({ ...baseDetail, note: 'VIP 客户' });
    expect(shortNote).toContain('VIP 客户');
    expect(shortNote).not.toContain('…');

    const longNote = buildVisitorCardCaption({ ...baseDetail, note: '备'.repeat(2000) });
    expect(longNote).toContain('…');
    expect(visible(longNote)).toBeLessThanOrEqual(1024);

    // HTML escaping must not count against the limit: 700 "&" render as 700 visible chars
    const escaped = buildVisitorCardCaption({ ...baseDetail, note: '&'.repeat(700) });
    expect(escaped).toContain('&amp;');
    expect(visible(escaped)).toBeLessThanOrEqual(1024);

    expect(buildVisitorCardCaption({ ...baseDetail, displayName: 'N'.repeat(1200) })).toBeNull();
  });

  it('sends a photo card when a brand-new visitor topic is created', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '999000:EDGE', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777' });
    await savePanelConfig(env, {
      pmBot: { showVisitorAvatarInCard: true, verificationMode: 'off', enableCasCheck: false },
    });
    const { calls, fetchMock } = mockTelegram();

    await withFetch(fetchMock, async () => {
      await handleTelegramUpdate(
        {
          message: {
            message_id: 1,
            from: { id: 616161, first_name: 'Newbie' },
            chat: { id: 616161, type: 'private' },
            text: 'hello',
          },
        },
        env,
        'https://panel.test'
      );
    });

    expect(calls.some((c) => c.method === 'createForumTopic')).toBe(true);
    const photo = calls.find((c) => c.method === 'sendPhoto');
    expect(photo).toBeTruthy();
    expect(photo.body.message_thread_id).toBe(99);
    expect(photo.body.photo).toBe('big_avatar');
    expect(photo.body.caption).toContain('tg://user?id=616161');
  });

  it('falls back to a text card when sendPhoto fails, and to editMessageReplyMarkup when a caption edit fails', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '999000:EDGE', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777' });
    await savePanelConfig(env, { pmBot: { showVisitorAvatarInCard: true } });
    await upsertVisitorProfile(env, { id: 717171, first_name: 'Carol' }, { threadId: 55, incrementMsg: false });
    await kv.put('thread:55', '717171');
    const { calls, fetchMock } = mockTelegram({ sendPhoto: tgError, editMessageCaption: tgError });

    await withFetch(fetchMock, async () => {
      await handleTelegramUpdate(
        {
          message: {
            message_id: 2,
            message_thread_id: 55,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -100777, type: 'supergroup' },
            text: '/info',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.some((c) => c.method === 'sendPhoto')).toBe(true);
      const textCard = calls.find((c) => c.method === 'sendMessage');
      expect(textCard?.body.text).toContain('tg://user?id=717171');

      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cb_edge',
            from: { id: 10001, first_name: 'Owner' },
            data: 'mod:trust:717171',
            message: {
              message_id: 5,
              chat: { id: -100777, type: 'supergroup' },
              photo: [{ file_id: 'big_avatar' }],
              caption: 'old',
            },
          },
        },
        env,
        'https://panel.test'
      );
    });

    expect(calls.some((c) => c.method === 'editMessageCaption')).toBe(true);
    const markup = calls.find((c) => c.method === 'editMessageReplyMarkup');
    expect(markup).toBeTruthy();
    expect(markup.body.reply_markup?.inline_keyboard?.length).toBeGreaterThan(0);
  });

  it('honors the welcome toggles when inbox is off (no group or ADMIN_IDS), and handles /start with a payload', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '999000:EDGE' });
    const { calls, fetchMock } = mockTelegram();
    const privateMsg = (text) => ({
      message: { message_id: 3, from: { id: 818181, first_name: 'Dan' }, chat: { id: 818181, type: 'private' }, text },
    });

    await withFetch(fetchMock, async () => {
      await handleTelegramUpdate(privateMsg('/start ref_forum'), env, 'https://panel.test');
      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);

      calls.length = 0;
      await savePanelConfig(env, { pmBot: { enableStartWelcome: true, showPanelButtonInWelcome: false } });
      await handleTelegramUpdate(privateMsg('hi there'), env, 'https://panel.test');
      const sent = calls.filter((c) => c.method === 'sendMessage');
      expect(sent).toHaveLength(1);
      expect(sent[0].body.reply_markup).toBeUndefined();

      calls.length = 0;
      await savePanelConfig(env, { pmBot: { enableStartWelcome: false } });
      await handleTelegramUpdate(privateMsg('hi again'), env, 'https://panel.test');
      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    });
  });

  it('does not match keyword rules against the placeholder preview of replayed media messages', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '999000:EDGE', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777' });
    await savePanelConfig(env, {
      pmBot: {
        keywordReplies: [{ keywords: '图片', reply: '图片请发原图哦', matchMode: 'contains', forwardToAdmin: false }],
      },
    });
    const user = { id: 919191, first_name: 'Eve' };
    await kv.put(
      'chal:v_edge',
      JSON.stringify({
        userId: '919191',
        user,
        pending: [
          { chatId: 919191, messageId: 11, preview: '[图片]', text: '', caption: '', photo: [{ file_id: 'p1' }] },
          { chatId: 919191, messageId: 12, preview: '有图片吗', text: '有图片吗', caption: '' },
        ],
      })
    );
    const { calls, fetchMock } = mockTelegram();

    await withFetch(fetchMock, async () => {
      const res = await completeTurnstileVerification(env, 'https://panel.test', 'v_edge');
      expect(res.ok).toBe(true);
    });

    const keywordReplies = calls.filter((c) => c.method === 'sendMessage' && c.body.text === '图片请发原图哦');
    expect(keywordReplies).toHaveLength(1);
    expect(keywordReplies[0].body.reply_to_message_id).toBe(12);
    // The photo-only message is forwarded normally instead of being swallowed by the keyword rule
    expect(calls.some((c) => c.method === 'copyMessage' && c.body.message_id === 11)).toBe(true);
  });
});

describe('Card labels cleanup (labelsRev 2)', () => {
  it('ships empty owner title/subtitle and clears legacy default labels once without touching custom ones', async () => {
    expect(DEFAULT_CONFIG.profile.badgeTitle).toBe('');
    expect(DEFAULT_CONFIG.profile.joinedText).toBe('');
    expect('showCardName' in DEFAULT_CONFIG.profile).toBe(false);

    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:LABELS', ADMIN_IDS: '10001' });

    // Config saved by an older version still carries the shipped defaults verbatim
    await kv.put(
      'config:panel',
      JSON.stringify({ profile: { displayName: 'Legacy', badgeTitle: '站长 · Owner', joinedText: 'Cloudflare Edge', ownerTag: '个人名片' } })
    );
    const migrated = await loadPanelConfig(env);
    expect(migrated.profile.badgeTitle).toBe('');
    expect(migrated.profile.joinedText).toBe('');
    expect(migrated.profile.ownerTag).toBe('个人名片');
    expect(migrated.profile.displayName).toBe('Legacy');

    // Labels the owner customised before the upgrade are kept
    await kv.put('config:panel', JSON.stringify({ profile: { badgeTitle: '群主 · VIP', joinedText: 'Tokyo' } }));
    const custom = await loadPanelConfig(env);
    expect(custom.profile.badgeTitle).toBe('群主 · VIP');
    expect(custom.profile.joinedText).toBe('Tokyo');

    // After saving once (labelsRev 2), typing the old default back in is respected
    await kv.put('config:panel', JSON.stringify({ profile: { badgeTitle: '站长 · Owner' } }));
    await savePanelConfig(env, { profile: { badgeTitle: '站长 · Owner' } });
    const stored = JSON.parse(await kv.get('config:panel'));
    expect(stored.profile.labelsRev).toBe(2);
    expect((await loadPanelConfig(env)).profile.badgeTitle).toBe('站长 · Owner');
  });
});

describe('Honeypot / CAS auto-ban visibility & unban cooldown clearing', () => {
  it('defaults honeypot click to temporary cooldown (preventing permanent lockout) with single-shot cooldown reminder', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '555111:HONEYPOT_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100888999',
    });

    const tgPayloads = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes('api.cas.chat')) {
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      }
      if (String(url).includes('/sendMessage') && init?.body) {
        tgPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
    });

    try {
      const chal = generateInlineChallenge('emoji', 'trapcool1', true);
      expect(chal.keyboard[3][0].text).toBe('🚫 防脚本陷阱 · 点此直接锁定');

      await kv.put(
        'chal:trapcool1',
        JSON.stringify({ userId: '60000', correctIndex: 0, failures: 0, mode: 'emoji' })
      );
      await kv.put('user_challenge:60000', 'trapcool1');

      // Visitor accidentally clicks honeypot under default config (`honeypotAction: 'cooldown'`)
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cq_trap_cool',
            from: { id: 60000, first_name: 'MisclickFriend' },
            data: 'v:trapcool1:trap',
            message: { message_id: 8, chat: { id: 60000, type: 'private' } },
          },
        },
        env,
        'https://panel.test'
      );

      // Must NOT permanently ban; must enter verification cooldown instead!
      expect(await kv.get('banned:60000')).toBeNull();
      expect(await kv.get('verify_cool:60000')).toBe('1');
      expect(await kv.get('chal:trapcool1')).toBeNull();

      // Sending 2 messages during cooldown sends at most 1 gentle reminder (anti-amplification)
      for (const mId of [21, 22]) {
        await handleTelegramUpdate(
          {
            message: {
              message_id: mId,
              from: { id: 60000, first_name: 'MisclickFriend' },
              chat: { id: 60000, type: 'private' },
              text: '在吗？',
            },
          },
          env,
          'https://panel.test'
        );
      }
      expect(tgPayloads).toHaveLength(1);
      expect(tgPayloads[0].text).toContain('冷却中');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('supports strict honeypot ban mode, recovers pre-v1.5.3 orphan banned:* keys, and prevents CAS re-ban after manual unban', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '555111:HONEYPOT_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100888999',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 50 } }), { status: 200 }));

    try {
      await savePanelConfig(env, { pmBot: { honeypotAction: 'ban' } });

      // Simulate an already-migrated deployment that ALSO has an orphan pre-v1.5.3 `banned:59999` key without `user:59999`
      await kv.put('visitors:migrated', '1');
      await kv.put('banned:59999', '1');
      // Plus a legacy telegram_private_chatbot record with `title` only
      await kv.put('user:58888', JSON.stringify({ thread_id: 12, title: 'Legacy Friend', closed: false }));
      await kv.put('banned:58888', '1');

      // Seed active challenge for visitor 60001
      await kv.put(
        'chal:traptest1',
        JSON.stringify({ userId: '60001', correctIndex: 0, failures: 0, mode: 'emoji' })
      );
      await kv.put('user_challenge:60001', 'traptest1');

      // Visitor clicks honeypot under strict `ban` mode
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cq_trap',
            from: { id: 60001, first_name: 'CuriousHuman', username: 'curious_user' },
            data: 'v:traptest1:trap',
            message: { message_id: 9, chat: { id: 60001, type: 'private' } },
          },
        },
        env,
        'https://panel.test'
      );

      expect(await kv.get('banned:60001')).toBe('1');

      // Admin opens Visitors -> Banned tab and sees BOTH new ban (60001) AND pre-v1.5.3 orphan bans (59999, 58888)!
      const bannedList = await listVisitors(env, { filter: 'banned' });
      expect(bannedList.items.some((v) => v.userId === '60001' && v.isBanned)).toBe(true);
      expect(bannedList.items.some((v) => v.userId === '59999' && v.isBanned)).toBe(true);
      expect(bannedList.items.find((v) => v.userId === '58888')?.displayName).toBe('Legacy Friend');

      // Even if CAS cached `cas:60001 = "1"`, manual admin `unban` clears cooldown AND exempts from CAS auto-reban
      await kv.put('cas:60001', '1');
      await kv.put('verify_cool:60001', '1');
      await kv.put('verify_cool_hint:60001', '1');
      await applyVisitorAction(env, '60001', 'unban');
      expect(await kv.get('banned:60001')).toBeNull();
      expect(await kv.get('verify_cool:60001')).toBeNull();
      expect(await kv.get('verify_cool_hint:60001')).toBeNull();

      await handleTelegramUpdate(
        {
          message: {
            message_id: 30,
            from: { id: 60001, first_name: 'CuriousHuman', username: 'curious_user' },
            chat: { id: 60001, type: 'private' },
            text: '你好，感谢解封！',
          },
        },
        env,
        'https://panel.test'
      );
      expect(await kv.get('banned:60001')).toBeNull();
      expect(await kv.get('user_challenge:60001')).toBeTruthy();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('v1.6.0: Mini App PM wake-up, Bot surface sync, legacy social cleanup, /del recall & General hint', () => {
  it('cleans legacy non-clickable TG social row once while preserving custom socials', async () => {
    expect(DEFAULT_CONFIG.profile.socials).toHaveLength(1);
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:SOC', ADMIN_IDS: '10001' });

    await kv.put(
      'config:panel',
      JSON.stringify({
        profile: {
          socials: [
            { id: 'tg', label: 'Telegram 私聊', value: '直接发送消息即可联系我', url: '' },
            { id: 'blog', label: 'Blog', value: 'my.blog', url: 'https://my.blog' },
          ],
        },
      })
    );
    const loaded = await loadPanelConfig(env);
    expect(loaded.profile.socials).toHaveLength(1);
    expect(loaded.profile.socials[0].id).toBe('blog');
  });

  it('wakes up verification from POST /api/chat/start, syncs Bot description & menu button on save, supports /del recall & General topic hint', async () => {
    const kv = createMemoryKV();
    const botToken = '777888:SURFACE_TEST_TOKEN';
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100555666',
    });

    const tgCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes('api.cas.chat')) {
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      }
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      if (method === 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: { id: 777888, username: 'AutoSynced_bot' } }), {
          status: 200,
        });
      }
      if (method === 'copyMessage') {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 404 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), { status: 200 });
    });

    try {
      // 1. Admin saves config over HTTPS -> auto-syncs setMyDescription, getMe username & default menu button when showChatMenuButton=false
      const adminInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
        botToken
      );
      const saveRes = await worker.fetch(
        new Request('https://panel.example.com/api/admin/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
          body: JSON.stringify({
            pmBot: {
              welcomeText: '欢迎来到我的机器人，点开始即可验证私聊！',
              syncBotDescription: true,
              showChatMenuButton: false,
              verifiedDays: 90,
            },
          }),
        }),
        env
      );
      const saveJson = await saveRes.json();
      expect(saveJson.ok).toBe(true);
      expect(saveJson.config.bot.username).toBe('AutoSynced_bot');
      expect(saveJson.adminConfig.pmBot.verifiedDays).toBe(90);
      expect(tgCalls.some((c) => c.method === 'setMyDescription' && c.body.description.includes('点开始即可验证'))).toBe(true);
      expect(tgCalls.some((c) => c.method === 'setChatMenuButton' && c.body.menu_button?.type === 'default')).toBe(true);

      // 2. Unverified guest clicks `[发私信]` inside Mini App -> POST /api/chat/start triggers verification directly in private chat
      tgCalls.length = 0;
      const guestInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 70707, first_name: 'Guest' }) },
        botToken
      );
      const startChatRes = await worker.fetch(
        new Request('https://panel.example.com/api/chat/start', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': guestInit },
        }),
        env
      );
      const startChatJson = await startChatRes.json();
      expect(startChatJson.ok).toBe(true);
      expect(startChatJson.triggeredVerification).toBe(true);
      expect(await kv.get('user_challenge:70707')).toBeTruthy();

      // 3. Admin accidentally types in General topic (no visitor thread) -> receives gentle 1-time hint
      tgCalls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 201,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -100555666, type: 'supergroup' },
            text: '你好，我在总话题回错了',
          },
        },
        env,
        'https://panel.example.com'
      );
      expect(tgCalls.some((c) => c.method === 'sendMessage' && c.body.text.includes('独立话题'))).toBe(true);

      // 4. Admin replies to visitor in visitor topic 66, then recalls via /del -> calls deleteMessage on visitor's PM!
      await upsertVisitorProfile(env, { id: 70707, first_name: 'Guest' }, { threadId: 66, incrementMsg: false });
      await kv.put('thread:66', '70707');
      tgCalls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 301,
            message_thread_id: 66,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -100555666, type: 'supergroup' },
            text: '不小心打错字的消息',
          },
        },
        env,
        'https://panel.example.com'
      );
      expect(tgCalls.some((c) => c.method === 'copyMessage' && c.body.chat_id === 70707)).toBe(true);

      tgCalls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 302,
            message_thread_id: 66,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -100555666, type: 'supergroup' },
            reply_to_message: { message_id: 301 },
            text: '/del',
          },
        },
        env,
        'https://panel.example.com'
      );
      expect(tgCalls.some((c) => c.method === 'deleteMessage' && c.body.chat_id === 70707 && c.body.message_id === 404)).toBe(
        true
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('v1.6.0 review fixes: challenge refresh cannot reset failures, rate limits & username caching', () => {
  function mockTg() {
    const calls = [];
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).includes('api.cas.chat')) {
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      }
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ method, body });
      if (method === 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'Review_bot' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
    });
    return { calls, fetchMock };
  }

  async function withFetch(fetchMock, fn) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      await fn();
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  const startMsg = (uid) => ({
    message: { message_id: 7, from: { id: uid, first_name: 'V' }, chat: { id: uid, type: 'private' }, text: '/start' },
  });

  it('keeps failure count, queued messages and Turnstile escalation when /start re-issues a challenge', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '555:REFRESH',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100123',
      TURNSTILE_SITE_KEY: 'site',
      TURNSTILE_SECRET: 'secret',
    });
    const { fetchMock } = mockTg();

    await withFetch(fetchMock, async () => {
      await handleTelegramUpdate(startMsg(40404), env, 'https://panel.test');
      const firstId = await kv.get('user_challenge:40404');
      const first = JSON.parse(await kv.get(`chal:${firstId}`));
      expect(first.failures).toBe(0);

      // Visitor already burned one attempt, queued a message and was escalated to strict mode
      await kv.put(
        `chal:${firstId}`,
        JSON.stringify({
          ...first,
          failures: 1,
          escalated: true,
          pending: [{ chatId: 40404, messageId: 3, preview: 'hi', text: 'hi' }],
        })
      );

      await handleTelegramUpdate(startMsg(40404), env, 'https://panel.test');
      const secondId = await kv.get('user_challenge:40404');
      expect(secondId).not.toBe(firstId);
      expect(await kv.get(`chal:${firstId}`)).toBeNull();
      const second = JSON.parse(await kv.get(`chal:${secondId}`));
      expect(second.failures).toBe(1);
      expect(second.pending).toHaveLength(1);
      expect(second.pending[0].messageId).toBe(3);
      expect(second.mode).toBe('turnstile');
      expect(second.escalated).toBe(true);
    });
  });

  it('caps repeated /start challenges and Mini App PM wake-ups per user', async () => {
    const kv = createMemoryKV();
    const botToken = '556:LIMITS';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001', SUPERGROUP_ID: '-100124' });
    const { calls, fetchMock } = mockTg();

    await withFetch(fetchMock, async () => {
      for (let i = 0; i < 7; i += 1) {
        await handleTelegramUpdate(startMsg(50505), env, 'https://panel.test');
      }
      // 5 allowed per minute; each issues exactly one challenge prompt
      expect(calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === 50505)).toHaveLength(5);

      const guestInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 60606, first_name: 'G' }) },
        botToken
      );
      const results = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await worker.fetch(
          new Request('https://panel.example.com/api/chat/start', {
            method: 'POST',
            headers: { 'X-Telegram-Init-Data': guestInit },
          }),
          env
        );
        results.push(await res.json());
      }
      expect(results.slice(0, 3).every((r) => r.ok && !r.rateLimited)).toBe(true);
      expect(results[3].rateLimited).toBe(true);
    });
  });

  it('caches the bot @username in the same KV write as the owner settings save', async () => {
    const kv = createMemoryKV();
    const botToken = '557:USERNAME';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' });
    const { calls, fetchMock } = mockTg();
    const putSpy = vi.spyOn(kv, 'put');

    await withFetch(fetchMock, async () => {
      const adminInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
        botToken
      );
      const res = await worker.fetch(
        new Request('https://panel.example.com/api/admin/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
          body: JSON.stringify({ pmBot: { welcomeText: '新的欢迎语' } }),
        }),
        env
      );
      expect((await res.json()).ok).toBe(true);
    });

    const configWrites = putSpy.mock.calls.filter(([key]) => key === 'config:panel');
    expect(configWrites).toHaveLength(1);
    const stored = JSON.parse(configWrites[0][1]);
    expect(stored.botUsername).toBe('Review_bot');
    expect(stored.pmBot.welcomeText).toBe('新的欢迎语');
    expect(calls.filter((c) => c.method === 'getMe')).toHaveLength(1);
  });
});

describe('Mini App in-panel visitor chat log, direct text/photo reply & recall', () => {
  it('blocks non-admins, sends text & multipart photo replies to visitor + mirrors to topic, signs chat history, and recalls cleanly', async () => {
    const kv = createMemoryKV();
    const botToken = '999111:CHAT_DRAWER_TOKEN';
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100888777',
    });

    await upsertVisitorProfile(
      env,
      { id: 90909, first_name: 'Hula', username: 'hula_user' },
      { threadId: 77, closed: true, incrementMsg: false }
    );
    await kv.put('thread:77', '90909');
    await kv.put('verified:90909', 'emoji:v1');

    const tgCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      let bodySummary = {};
      if (init?.body instanceof FormData) {
        bodySummary = {
          isForm: true,
          chat_id: init.body.get('chat_id'),
          caption: init.body.get('caption'),
          hasPhoto: Boolean(init.body.get('photo')),
        };
      } else if (typeof init?.body === 'string') {
        bodySummary = JSON.parse(init.body);
      }
      tgCalls.push({ method, body: bodySummary });

      if (method === 'sendPhoto' && bodySummary.isForm) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 702,
              photo: [{ file_id: 'thumb_fid_1' }, { file_id: 'full_fid_1' }],
            },
          }),
          { status: 200 }
        );
      }
      if (method === 'sendPhoto') {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 802 } }), { status: 200 });
      }
      if (method === 'sendMessage' && Number(bodySummary.chat_id) === 90909) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 701 } }), { status: 200 });
      }
      if (method === 'sendMessage') {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 801 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    try {
      const guestInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 90909, first_name: 'Hula' }) },
        botToken
      );
      const adminInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
        botToken
      );

      // 1. Non-admin strictly blocked (403)
      const guestTry = await worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/90909/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': guestInit },
          body: JSON.stringify({ text: 'hack' }),
        }),
        env
      );
      expect(guestTry.status).toBe(403);

      // 2. Visitor sends a normal PM first -> logged in chronological `messages`
      await handleTelegramUpdate(
        {
          message: {
            message_id: 500,
            from: { id: 90909, first_name: 'Hula', username: 'hula_user' },
            chat: { id: 90909, type: 'private' },
            text: '请问友链怎么换呀？',
          },
        },
        env,
        'https://panel.example.com'
      );
      // Note: conversation was closed earlier -> let's see! Admin replying via Mini App auto-reopens it!

      // 3. Admin sends direct text reply from Mini App -> delivers to visitor, mirrors silently to topic 77, and reopens closed thread
      tgCalls.length = 0;
      const textReplyRes = await worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/90909/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
          body: JSON.stringify({ text: '直接在面板里回复你啦 🌸' }),
        }),
        env
      );
      const textReplyJson = await textReplyRes.json();
      expect(textReplyJson.ok).toBe(true);
      expect(textReplyJson.visitor.isClosed).toBe(false);
      expect(tgCalls.some((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === 90909)).toBe(true);
      expect(
        tgCalls.some(
          (c) =>
            c.method === 'sendMessage' &&
            c.body.chat_id === '-100888777' &&
            c.body.message_thread_id === 77 &&
            c.body.disable_notification === true
        )
      ).toBe(true);

      // 4. Admin sends multipart photo + caption from Mini App -> delivers photo via FormData, mirrors to topic, signs URLs
      tgCalls.length = 0;
      const form = new FormData();
      form.append('photo', new File([new Uint8Array([137, 80, 78, 71])], 'card.png', { type: 'image/png' }));
      form.append('text', '这是我的站点图标');
      const photoReplyRes = await worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/90909/reply', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': adminInit },
          body: form,
        }),
        env
      );
      const photoReplyJson = await photoReplyRes.json();
      expect(photoReplyJson.ok).toBe(true);
      expect(photoReplyJson.message.photoUrl).toContain('/api/media/full_fid_1');
      expect(tgCalls.some((c) => c.method === 'sendPhoto' && c.body.isForm && c.body.chat_id === '90909')).toBe(true);
      expect(tgCalls.some((c) => c.method === 'sendPhoto' && c.body.chat_id === '-100888777')).toBe(true);

      // 5. History endpoint returns signed chronological messages & archived photo
      const histRes = await worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/90909/history', {
          headers: { 'X-Telegram-Init-Data': adminInit },
        }),
        env
      );
      const histJson = await histRes.json();
      expect(histJson.messages).toHaveLength(2);
      expect(histJson.photos).toHaveLength(1);

      // 6. Admin recalls the photo bubble right inside Mini App -> deletes BOTH visitor PM (702) AND topic mirror (802)!
      tgCalls.length = 0;
      const recallRes = await worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/90909/recall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
          body: JSON.stringify({ pmMessageId: 702 }),
        }),
        env
      );
      expect((await recallRes.json()).ok).toBe(true);
      expect(tgCalls.some((c) => c.method === 'deleteMessage' && c.body.chat_id === 90909 && c.body.message_id === 702)).toBe(true);
      expect(
        tgCalls.some((c) => c.method === 'deleteMessage' && c.body.chat_id === '-100888777' && c.body.message_id === 802)
      ).toBe(true);

      const histAfterRecall = await (
        await worker.fetch(
          new Request('https://panel.example.com/api/admin/visitors/90909/history', {
            headers: { 'X-Telegram-Init-Data': adminInit },
          }),
          env
        )
      ).json();
      expect(histAfterRecall.messages).toHaveLength(1);
      // Recalled photo is pruned from the gallery archive too
      expect(histAfterRecall.photos).toHaveLength(0);

      const postJson = (path, body) =>
        worker.fetch(
          new Request(`https://panel.example.com${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
            body: JSON.stringify(body),
          }),
          env
        );

      // 7. Recall without an explicit pmMessageId must NOT fall back to "latest admin reply"
      tgCalls.length = 0;
      const badRecall = await postJson('/api/admin/visitors/90909/recall', {});
      expect(badRecall.status).toBe(400);
      expect(tgCalls.some((c) => c.method === 'deleteMessage')).toBe(false);

      // 8. Replying to an unknown visitor UID is rejected without contacting Telegram
      const unknownReply = await postJson('/api/admin/visitors/123456789/reply', { text: 'hi' });
      expect(unknownReply.status).toBe(404);
      expect(tgCalls.length).toBe(0);

      // 9. Non-image bytes disguised as image/png are rejected by magic-byte sniffing
      const fakeForm = new FormData();
      fakeForm.append('photo', new File([new TextEncoder().encode('<html>nope</html>')], 'x.png', { type: 'image/png' }));
      const fakeRes = await worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/90909/reply', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': adminInit },
          body: fakeForm,
        }),
        env
      );
      expect(fakeRes.status).toBe(400);
      expect(tgCalls.some((c) => c.method === 'sendPhoto')).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('mirrors panel replies to the topic as a blockquote quoting the latest visitor message, without a text label', async () => {
    const kv = createMemoryKV();
    const botToken = '999222:MIRROR_STYLE';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777' });
    await upsertVisitorProfile(env, { id: 91919, first_name: 'Momo' }, { threadId: 55, incrementMsg: false });
    await kv.put('thread:55', '91919');
    await kv.put('verified:91919', 'emoji:v1');
    // Legacy entry recorded before topicCopyId existed: its topicMsgId is the visitor's PM ID and must never be quoted
    await recordVisitorExchange(env, '91919', { message_id: 3, text: 'old' }, { sender: 'visitor', pmMessageId: 3 });

    const tgCalls = [];
    let nextId = 640;
    let lastCopyId = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      if (method === 'copyMessage' || method === 'sendMessage') {
        nextId += 1;
        if (method === 'copyMessage') lastCopyId = nextId;
        return new Response(JSON.stringify({ ok: true, result: { message_id: nextId } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    const adminInit = await signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
      botToken
    );
    const panelReply = (text) =>
      worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/91919/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
          body: JSON.stringify({ text }),
        }),
        env
      );
    const topicMirror = () =>
      tgCalls.find((c) => c.method === 'sendMessage' && c.body.chat_id === '-100777' && c.body.message_thread_id === 55);

    try {
      // 1. Only a legacy entry exists -> mirror is styled but quotes nothing
      expect((await panelReply('hello')).status).toBe(200);
      expect(topicMirror().body.reply_parameters).toBeUndefined();

      // 2. Visitor message copied into topic 55 (copy gets ID 642 there) -> recorded as topicCopyId
      tgCalls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 500,
            from: { id: 91919, first_name: 'Momo' },
            chat: { id: 91919, type: 'private' },
            text: '机器人很好用，感谢',
          },
        },
        env,
        'https://panel.example.com'
      );
      const copy = tgCalls.find((c) => c.method === 'copyMessage');
      expect(copy.body.message_thread_id).toBe(55);
      const copyId = lastCopyId;
      expect(copyId).toBeGreaterThan(0);

      // 3. Panel reply -> labelled blockquote, HTML-escaped, quoting the visitor's copied message in the same topic
      tgCalls.length = 0;
      expect((await panelReply('感动 <b>不是标签</b>')).status).toBe(200);
      const mirror = topicMirror();
      expect(mirror.body.parse_mode).toBe('HTML');
      expect(mirror.body.text).toBe('<blockquote>感动 &lt;b&gt;不是标签&lt;/b&gt;</blockquote>');
      expect(mirror.body.text).not.toContain('面板回复');
      expect(mirror.body.reply_parameters).toEqual({ message_id: copyId, allow_sending_without_reply: true });
      expect(mirror.body.disable_notification).toBe(true);
      // The visitor's own private chat still gets the plain text
      const toVisitor = tgCalls.find((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === 91919);
      expect(toVisitor.body.text).toBe('感动 <b>不是标签</b>');
      expect(toVisitor.body.parse_mode).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('reply fast path: reuses the known topic without rewriting the thread map, and a failed delivery writes nothing', async () => {
    const kv = createMemoryKV();
    const botToken = '999333:FAST_REPLY';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777' });
    await upsertVisitorProfile(env, { id: 92929, first_name: 'Kiki' }, { threadId: 66, incrementMsg: false });
    await kv.put('thread:66', '92929');

    let failVisitorSend = false;
    const tgCalls = [];
    let nextId = 900;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      if (failVisitorSend && method === 'sendMessage' && Number(body.chat_id) === 92929) {
        return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
      }
      nextId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextId } }), { status: 200 });
    });
    const adminInit = await signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
      botToken
    );
    const reply = (text) =>
      worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/92929/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
          body: JSON.stringify({ text }),
        }),
        env
      );

    try {
      const putSpy = vi.spyOn(kv, 'put');
      const res = await reply('hi');
      expect(res.status).toBe(200);
      expect(tgCalls.some((c) => c.method === 'createForumTopic')).toBe(false);
      expect(tgCalls.find((c) => c.body.chat_id === '-100777').body.message_thread_id).toBe(66);
      expect(putSpy.mock.calls.some((c) => String(c[0]).startsWith('thread:'))).toBe(false);
      const hist = await getVisitorHistory(env, '92929');
      expect(hist.messages.at(-1).text).toBe('hi');
      expect((await getVisitorDetail(env, '92929')).admin_msg_count).toBe(1);

      // Delivery fails -> error returned, nothing mirrored or archived
      putSpy.mockClear();
      tgCalls.length = 0;
      failVisitorSend = true;
      const failed = await reply('second');
      expect(failed.status).toBe(400);
      expect(tgCalls.filter((c) => c.body.chat_id === '-100777')).toHaveLength(0);
      expect(putSpy.mock.calls.filter((c) => String(c[0]).startsWith('history:'))).toHaveLength(0);
      putSpy.mockRestore();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('recall fails fast past 48 hours and only deletes the topic copy after the visitor-side delete succeeds', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, SUPERGROUP_ID: '-100777' });
    const now = Date.now();
    await kv.put(
      'history:93939',
      JSON.stringify({
        photos: [],
        links: [],
        messages: [
          { id: 'm1', sender: 'admin', text: 'old', pmMessageId: 11, topicMsgId: 21 },
          { id: 'm2', sender: 'admin', text: 'new', pmMessageId: 12, topicMsgId: 22 },
        ],
        pmMessageIds: [
          { id: 12, topicMsgId: 22, sender: 'admin', at: now - 60 * 1000 },
          { id: 11, topicMsgId: 21, sender: 'admin', at: now - 49 * 60 * 60 * 1000 },
        ],
      })
    );

    const calls = [];
    let failVisitorDelete = false;
    const tg = async (_env, method, body) => {
      calls.push({ method, body });
      if (failVisitorDelete && Number(body.chat_id) === 93939) throw new Error('message to delete not found');
      return { ok: true, result: true };
    };

    // Older than 48h -> no Telegram call at all
    const old = await recallAdminVisitorMessage(env, '93939', null, tg, 11);
    expect(old.ok).toBe(false);
    expect(old.error).toContain('48');
    expect(calls).toHaveLength(0);

    // Visitor-side delete fails -> topic copy is left alone, history untouched
    failVisitorDelete = true;
    const failed = await recallAdminVisitorMessage(env, '93939', null, tg, 12);
    expect(failed.ok).toBe(false);
    expect(calls.map((c) => c.body.chat_id)).toEqual([93939]);
    expect((await getVisitorHistory(env, '93939')).messages).toHaveLength(2);

    // Success -> both copies deleted, entry removed from history
    calls.length = 0;
    failVisitorDelete = false;
    const done = await recallAdminVisitorMessage(env, '93939', null, tg, 12);
    expect(done.ok).toBe(true);
    expect(calls.map((c) => [c.body.chat_id, c.body.message_id])).toEqual([
      [93939, 12],
      ['-100777', 22],
    ]);
    const hist = await getVisitorHistory(env, '93939');
    expect(hist.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('confirms a panel reply before the topic mirror, attaches the mirror later, and cleans it up if recalled first', async () => {
    const kv = createMemoryKV();
    const botToken = '999444:BG_MIRROR';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777' });
    await upsertVisitorProfile(env, { id: 94949, first_name: 'Bea' }, { threadId: 77, incrementMsg: false });
    await kv.put('thread:77', '94949');

    const tgCalls = [];
    let nextId = 1000;
    // The topic mirror is held until the test opens the gate, to prove the response doesn't wait for it
    let openGate;
    let gate = new Promise((r) => (openGate = r));
    let lastMirrorId = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      tgCalls.push({ method, body });
      if (method === 'sendMessage' && body.chat_id === '-100777') await gate;
      nextId += 1;
      if (method === 'sendMessage' && body.chat_id === '-100777') lastMirrorId = nextId;
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextId } }), { status: 200 });
    });
    const adminInit = await signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
      botToken
    );
    const replyWithCtx = async (text) => {
      const pending = [];
      const res = await worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/94949/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
          body: JSON.stringify({ text }),
        }),
        env,
        { waitUntil: (p) => pending.push(p) }
      );
      return { json: await res.json(), pending };
    };
    const mirrorCalls = () => tgCalls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === '-100777');

    try {
      // 1. Response comes back after delivery + archive; the mirror is deferred to waitUntil
      const first = await replyWithCtx('先回复你');
      expect(first.json.ok).toBe(true);
      expect(first.json.message.pmMessageId).toBeGreaterThan(0);
      expect(first.pending).toHaveLength(1);
      // Mirror still in flight, so nothing is attached yet
      const before = await getVisitorHistory(env, '94949');
      expect(before.pmMessageIds.find((m) => m.id === first.json.message.pmMessageId).topicMsgId).toBeNull();
      openGate();
      await Promise.all(first.pending);
      expect(mirrorCalls()).toHaveLength(1);
      const mirrorId = lastMirrorId;
      const hist = await getVisitorHistory(env, '94949');
      const entry = hist.pmMessageIds.find((m) => m.id === first.json.message.pmMessageId);
      expect(entry.topicMsgId).toBe(mirrorId);
      expect(entry.topicChatId).toBe('-100777');

      // 2. Recalled before the mirror lands -> the orphaned topic copy is deleted afterwards
      tgCalls.length = 0;
      gate = new Promise((r) => (openGate = r));
      const second = await replyWithCtx('马上撤回');
      const pmId = second.json.message.pmMessageId;
      const recallRes = await worker.fetch(
        new Request('https://panel.example.com/api/admin/visitors/94949/recall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
          body: JSON.stringify({ pmMessageId: pmId }),
        }),
        env
      );
      expect((await recallRes.json()).ok).toBe(true);
      openGate();
      await Promise.all(second.pending);
      const lateMirrorId = lastMirrorId;
      expect(lateMirrorId).not.toBe(mirrorId);
      expect(lateMirrorId).toBeTruthy();
      expect(
        tgCalls.some((c) => c.method === 'deleteMessage' && c.body.chat_id === '-100777' && c.body.message_id === lateMirrorId)
      ).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('reads chat history with the shortest KV edge cache so new visitor messages show up sooner', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv });
    const getSpy = vi.spyOn(kv, 'get');
    await getVisitorHistory(env, '95959');
    if (storageMode === 'kv') {
      expect(getSpy).toHaveBeenCalledWith('history:95959', expect.objectContaining({ cacheTtl: HISTORY_CACHE_TTL_SECONDS, type: 'json' }));
    } else {
      expect(getSpy).toHaveBeenCalledTimes(1);
      getSpy.mockClear();
      await getVisitorHistory(env, '95959');
      expect(getSpy).not.toHaveBeenCalled();
    }
    expect(HISTORY_CACHE_TTL_SECONDS).toBe(30);
  });

  it('apiRequest aborts a hanging request after timeoutMs so polling guards can recover', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      (url, init) =>
        new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    try {
      await expect(apiRequest('/api/admin/visitors/1/history', { timeoutMs: 20 })).rejects.toThrow('请求超时');
      expect(globalThis.fetch.mock.calls[0][1].timeoutMs).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('signs media with a stable URL within a time window so polled stickers and photos do not reload', async () => {
    const botToken = '999555:STABLE_MEDIA';
    const base = Date.UTC(2026, 10, 27, 12, 0, 0);
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(base + 1000);
      const a = await signMediaToken('sticker_file_1', botToken, 1800);
      nowSpy.mockReturnValue(base + 7000); // next 6s poll
      const b = await signMediaToken('sticker_file_1', botToken, 1800);
      expect(b).toEqual(a);
      // Still valid for at least the requested TTL, at most TTL + one window
      const nowSec = Math.floor((base + 7000) / 1000);
      expect(b.exp - nowSec).toBeGreaterThanOrEqual(1800);
      expect(b.exp - nowSec).toBeLessThanOrEqual(1800 + MEDIA_TOKEN_BUCKET_SECONDS);
      expect(await verifyMediaToken('sticker_file_1', String(b.exp), b.sig, botToken)).toBe(true);

      // A later window rolls to a new (still valid) URL
      nowSpy.mockReturnValue(base + (MEDIA_TOKEN_BUCKET_SECONDS + 5) * 1000);
      const c = await signMediaToken('sticker_file_1', botToken, 1800);
      expect(c.exp).toBeGreaterThan(a.exp);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('Bot DM direct push inbox (dm-inbox)', () => {
  function createMockTg({ failOwnerPush = false, nextMsgStart = 1000 } = {}) {
    let nextId = nextMsgStart;
    const calls = [];
    const state = { failOwnerPush };
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).includes('api.cas.chat')) {
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      }
      const method = String(url).split('/').pop();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      calls.push({ method, body });
      if (state.failOwnerPush && Number(body.chat_id) === 10001 && (method === 'sendMessage' || method === 'copyMessage')) {
        return new Response(
          JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }),
          { status: 403 }
        );
      }
      if (method === 'createForumTopic') {
        return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 321 } }), { status: 200 });
      }
      if (method === 'sendMessage' || method === 'copyMessage') {
        nextId += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: nextId } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    return { calls, fetchMock, state };
  }

  async function withFetch(fetchMock, fn) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      await fn();
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  it('resolves inbox mode accurately across topic, dm, and off configurations', async () => {
    const kv = createMemoryKV();
    expect(await resolveInboxMode(makeEnv({ TOPIC_MAP: kv }))).toBe('off');
    expect(getOwnerChatId(makeEnv({ TOPIC_MAP: kv }))).toBe('');

    expect(await resolveInboxMode(makeEnv({ TOPIC_MAP: kv, ADMIN_IDS: '10001, 10002' }))).toBe('dm');
    expect(getOwnerChatId(makeEnv({ TOPIC_MAP: kv, ADMIN_IDS: '10001, 10002' }))).toBe('10001');

    expect(await resolveInboxMode(makeEnv({ TOPIC_MAP: kv, ADMIN_IDS: '10001', SUPERGROUP_ID: '-100123' }))).toBe('topic');

    // KV-bound supergroup also selects topic mode immediately
    await kv.put('config:supergroup_id', '-100456');
    expect(await resolveInboxMode(makeEnv({ TOPIC_MAP: kv, ADMIN_IDS: '10001' }))).toBe('topic');
  });

  it('pushes visitor card on demand (10min / visitor switch), copies message verbatim, and records dmmap & archive', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:DM_PUSH', ADMIN_IDS: '10001,10002' });
    await kv.put('verified:20001', 'emoji:v1');
    await kv.put('verified:20002', 'emoji:v1');

    const { calls, fetchMock } = createMockTg({ nextMsgStart: 500 });

    await withFetch(fetchMock, async () => {
      // 1. Visitor A first message -> sends header card (501) + copies message (502), both mapped in dmmap
      await handleTelegramUpdate(
        {
          message: {
            message_id: 11,
            from: { id: 20001, first_name: 'Alice', username: 'alice_dev' },
            chat: { id: 20001, type: 'private' },
            text: '你好，咨询一下 https://example.com',
          },
        },
        env,
        'https://panel.test'
      );

      const headerCall = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === 10001);
      const copyCall = calls.find((c) => c.method === 'copyMessage' && c.body.chat_id === 10001);
      expect(headerCall).toBeTruthy();
      expect(headerCall.body.text).toContain('Alice');
      expect(headerCall.body.text).toContain('@alice_dev');
      expect(headerCall.body.text).toContain('20001');
      expect(headerCall.body.reply_markup.inline_keyboard[0][0].web_app.url).toBe(
        'https://panel.test/?tab=visitors&uid=20001'
      );
      expect(copyCall).toBeTruthy();
      expect(copyCall.body.from_chat_id).toBe(20001);
      expect(copyCall.body.message_id).toBe(11);
      // Must NOT push to second admin 10002
      expect(calls.some((c) => Number(c.body.chat_id) === 10002)).toBe(false);
      // Both header card and copied message mapped to visitor 20001 (copied visitor msg carries `{ u, p }`)
      if (storageMode === 'kv') {
        expect(await kv.get(`${DM_MAP_PREFIX}501`)).toBe('20001');
        expect(JSON.parse(await kv.get(`${DM_MAP_PREFIX}502`))).toEqual({ u: '20001', p: 11 });
      } else {
        expect(await kv.get(`${DM_MAP_PREFIX}501`)).toBeNull();
        expect(await kv.get(`${DM_MAP_PREFIX}502`)).toBeNull();
        expect(await env.DB.prepare(`SELECT uid, pm_message_id FROM dm_map WHERE owner_msg_id = 501`).first()).toEqual({
          uid: '20001',
          pm_message_id: null,
        });
        expect(await env.DB.prepare(`SELECT uid, pm_message_id FROM dm_map WHERE owner_msg_id = 502`).first()).toEqual({
          uid: '20001',
          pm_message_id: 11,
        });
      }
      expect(await lookupDmMessageMap(env, 502)).toBe('20001');

      // Visitor profile & archive saved cleanly without thread_id
      const detail = await getVisitorDetail(env, '20001');
      expect(detail.thread_id).toBeNull();
      expect(detail.topicLink).toBe('');
      expect(detail.visitor_msg_count).toBe(1);
      expect(detail.link_count).toBe(1);

      // 2. Same visitor sends again within 10 minutes -> NO duplicate header card, only copyMessage + dmmap
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 12,
            from: { id: 20001, first_name: 'Alice', username: 'alice_dev' },
            chat: { id: 20001, type: 'private' },
            text: '补充一条消息',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === 10001)).toHaveLength(0);
      expect(calls.filter((c) => c.method === 'copyMessage' && c.body.chat_id === 10001)).toHaveLength(1);
      if (storageMode === 'kv') {
        expect(JSON.parse(await kv.get(`${DM_MAP_PREFIX}503`))).toEqual({ u: '20001', p: 12 });
      } else {
        expect(await kv.get(`${DM_MAP_PREFIX}503`)).toBeNull();
        expect(await env.DB.prepare(`SELECT uid, pm_message_id FROM dm_map WHERE owner_msg_id = 503`).first()).toEqual({
          uid: '20001',
          pm_message_id: 12,
        });
      }
      expect(await lookupDmMessageMap(env, 503)).toBe('20001');

      // 3. Same visitor sends after >10 minutes -> re-sends header card
      await kv.put(DM_LAST_HEADER_KEY, JSON.stringify({ uid: '20001', at: Date.now() - 11 * 60 * 1000 }));
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 13,
            from: { id: 20001, first_name: 'Alice', username: 'alice_dev' },
            chat: { id: 20001, type: 'private' },
            text: '过了十一分钟再来问一句',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === 10001)).toHaveLength(1);
      expect(calls.filter((c) => c.method === 'copyMessage' && c.body.chat_id === 10001)).toHaveLength(1);

      // 4. Different visitor B sends a message -> sends a new header card for visitor B
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 21,
            from: { id: 20002, first_name: 'Bob' },
            chat: { id: 20002, type: 'private' },
            text: '你好我是 Bob',
          },
        },
        env,
        'https://panel.test'
      );
      const bobHeader = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === 10001);
      expect(bobHeader).toBeTruthy();
      expect(bobHeader.body.text).toContain('Bob');
      expect(bobHeader.body.text).toContain('20002');
      expect(calls.some((c) => c.method === 'copyMessage' && c.body.chat_id === 10001 && c.body.from_chat_id === 20002)).toBe(
        true
      );
    });
  });

  it('delivers owner quote-replies to visitor, records admin exchange, and chains replies to own reply', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:DM_REPLY', ADMIN_IDS: '10001' });
    await kv.put(`${DM_MAP_PREFIX}502`, '20001');
    await upsertVisitorProfile(env, { id: 20001, first_name: 'Alice' }, { incrementMsg: false });

    const { calls, fetchMock } = createMockTg({ nextMsgStart: 800 });

    await withFetch(fetchMock, async () => {
      // 1. Owner quotes pushed message 502 -> copies to visitor 20001 (gets pmMessageId 801)
      await handleTelegramUpdate(
        {
          message: {
            message_id: 601,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            reply_to_message: { message_id: 502 },
            text: '收到啦，马上看！',
          },
        },
        env,
        'https://panel.test'
      );

      expect(
        calls.some(
          (c) =>
            c.method === 'copyMessage' &&
            c.body.chat_id === 20001 &&
            c.body.from_chat_id === 10001 &&
            c.body.message_id === 601
        )
      ).toBe(true);
      // Owner's own reply is also mapped in dmmap
      if (storageMode === 'kv') {
        expect(await kv.get(`${DM_MAP_PREFIX}601`)).toBe('20001');
      } else {
        expect(await kv.get(`${DM_MAP_PREFIX}601`)).toBeNull();
        expect(await lookupDmMessageMap(env, 601)).toBe('20001');
      }

      const hist = await getVisitorHistory(env, '20001');
      expect(hist.messages).toHaveLength(1);
      expect(hist.messages[0].sender).toBe('admin');
      expect(hist.messages[0].text).toBe('收到啦，马上看！');
      expect(hist.pmMessageIds[0]).toMatchObject({ id: 801, topicMsgId: null, dmMsgId: 601, sender: 'admin' });

      // 2. Owner quotes their OWN reply 601 to send a follow-up -> reaches 20001 too
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 602,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            reply_to_message: { message_id: 601 },
            text: '再补充一个链接',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.some((c) => c.method === 'copyMessage' && c.body.chat_id === 20001 && c.body.message_id === 602)).toBe(
        true
      );
    });
  });

  it('never guesses recipient when owner does not quote or quotes unknown message, and hints only once per 24h', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:DM_HINT', ADMIN_IDS: '10001' });
    await upsertVisitorProfile(env, { id: 20001, first_name: 'Alice' }, { incrementMsg: true });
    await kv.put(DM_LAST_HEADER_KEY, JSON.stringify({ uid: '20001', at: Date.now() }));

    const { calls, fetchMock } = createMockTg();

    await withFetch(fetchMock, async () => {
      // 1. Owner sends plain message without replying -> hints once, zero messages sent to any visitor
      await handleTelegramUpdate(
        {
          message: {
            message_id: 701,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            text: '随便发一句',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.some((c) => c.method === 'copyMessage')).toBe(false);
      expect(calls.some((c) => Number(c.body.chat_id) === 20001)).toBe(false);
      expect(calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === 10001)).toHaveLength(1);
      expect(calls[0].body.text).toContain('引用回复');
      expect(await kv.get('hint:dm_reply:10001')).toBe('1');

      // 2. Owner quotes an unmapped message ID within 24h -> NO duplicate hint, ZERO visitor calls
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 702,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            reply_to_message: { message_id: 999999 },
            text: '回复一条过期消息',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls).toHaveLength(0);
    });
  });

  it('supports /ban, /info, and strict /del in DM mode without falling back to most recent reply', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:DM_CMD', ADMIN_IDS: '10001' });
    await upsertVisitorProfile(env, { id: 20001, first_name: 'Alice', username: 'alice_tg' }, { incrementMsg: false });
    await kv.put(`${DM_MAP_PREFIX}502`, '20001'); // pushed visitor msg
    await kv.put(`${DM_MAP_PREFIX}601`, '20001'); // owner reply #1
    await kv.put(`${DM_MAP_PREFIX}602`, '20001'); // owner reply #2
    await recordVisitorExchange(
      env,
      '20001',
      { text: '第一条回复' },
      { sender: 'admin', pmMessageId: 801, topicMsgId: null, dmMsgId: 601, preview: '第一条回复' }
    );
    await recordVisitorExchange(
      env,
      '20001',
      { text: '第二条回复' },
      { sender: 'admin', pmMessageId: 802, topicMsgId: null, dmMsgId: 602, preview: '第二条回复' }
    );

    const { calls, fetchMock } = createMockTg();

    await withFetch(fetchMock, async () => {
      // 1. /info quoting pushed msg 502 -> sends visitor card WITHOUT message_thread_id
      await handleTelegramUpdate(
        {
          message: {
            message_id: 710,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            reply_to_message: { message_id: 502 },
            text: '/info',
          },
        },
        env,
        'https://panel.test'
      );
      const infoCall = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === 10001);
      expect(infoCall).toBeTruthy();
      expect(infoCall.body.message_thread_id).toBeUndefined();
      expect(infoCall.body.text).toContain('Alice');
      expect(infoCall.body.reply_markup.inline_keyboard[0][0].web_app.url).toContain('tab=visitors&uid=20001');

      // 2. /del quoting visitor's pushed message 502 -> MUST error and MUST NOT delete recent admin reply 802!
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 711,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            reply_to_message: { message_id: 502 },
            text: '/del',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);
      expect(calls.some((c) => c.method === 'sendMessage' && c.body.text.includes('⚠️'))).toBe(true);

      // 3. /del without quoting anything -> MUST error and MUST NOT delete anything!
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 712,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            text: '/del',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);
      expect(calls.some((c) => c.method === 'sendMessage' && c.body.text.includes('⚠️'))).toBe(true);

      // 4. /del quoting owner's specific reply 601 -> deletes ONLY pmMessageId 801 (not 802)
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 713,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            reply_to_message: { message_id: 601 },
            text: '/del',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.some((c) => c.method === 'deleteMessage' && c.body.chat_id === 20001 && c.body.message_id === 801)).toBe(
        true
      );
      expect(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 802)).toBe(false);

      // 5. /ban quoting pushed message 502 -> bans 20001 and sends receipt with private-chat keyboard
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 714,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            reply_to_message: { message_id: 502 },
            text: '/ban',
          },
        },
        env,
        'https://panel.test'
      );
      expect(await kv.get('banned:20001')).toBe('1');
      const banCall = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === 10001);
      expect(banCall.body.text).toContain('已拉黑');
      expect(banCall.body.message_thread_id).toBeUndefined();
    });
  });

  it('enforces verification in DM mode (no supergroup bound) on /start, normal PM, and Mini App /api/chat/start', async () => {
    const kv = createMemoryKV();
    const botToken = '123:DM_VERIFY';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' });
    const { calls, fetchMock } = createMockTg({ nextMsgStart: 300 });

    await withFetch(fetchMock, async () => {
      // 1. Unverified stranger sends /start -> triggers verification challenge (not bypassed!)
      await handleTelegramUpdate(
        {
          message: {
            message_id: 1,
            from: { id: 30001, first_name: 'Stranger1' },
            chat: { id: 30001, type: 'private' },
            text: '/start',
          },
        },
        env,
        'https://panel.test'
      );
      expect(await kv.get('user_challenge:30001')).toBeTruthy();
      expect(calls.some((c) => Number(c.body.chat_id) === 10001)).toBe(false);

      // 2. Unverified stranger sends normal message -> triggers verification & queues pending message; passing delivers to owner DM!
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 2,
            from: { id: 30002, first_name: 'Stranger2' },
            chat: { id: 30002, type: 'private' },
            text: '你好，通过验证后请转发给我',
          },
        },
        env,
        'https://panel.test'
      );
      const chalId = await kv.get('user_challenge:30002');
      expect(chalId).toBeTruthy();
      expect(calls.some((c) => Number(c.body.chat_id) === 10001)).toBe(false);
      const chalState = JSON.parse(await kv.get(`chal:${chalId}`));

      calls.length = 0;
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cq_dm_pass',
            from: { id: 30002, first_name: 'Stranger2' },
            data: `v:${chalId}:${chalState.correctIndex}`,
            message: { message_id: 302, chat: { id: 30002, type: 'private' } },
          },
        },
        env,
        'https://panel.test'
      );
      // Pending message flushed directly to owner 10001!
      expect(calls.some((c) => c.method === 'copyMessage' && c.body.chat_id === 10001 && c.body.message_id === 2)).toBe(
        true
      );

      // Verified stranger sending /start sees canChatNow prompt
      calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 3,
            from: { id: 30002, first_name: 'Stranger2' },
            chat: { id: 30002, type: 'private' },
            text: '/start',
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.some((c) => c.method === 'sendMessage' && c.body.text.includes('已完成验证'))).toBe(true);

      // 3. Unverified stranger tapping Mini App `[发私信]` -> triggers verification in DM mode
      const guestInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 30003, first_name: 'Stranger3' }) },
        botToken
      );
      const chatStartRes = await worker.fetch(
        new Request('https://panel.test/api/chat/start', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': guestInit },
        }),
        env
      );
      const chatStartJson = await chatStartRes.json();
      expect(chatStartJson.ok).toBe(true);
      expect(chatStartJson.triggeredVerification).toBe(true);
      expect(await kv.get('user_challenge:30003')).toBeTruthy();
    });
  });

  it('records dm:owner_unreachable on 403 push failure, preserves message in panel archive, and exposes status only to admin', async () => {
    const kv = createMemoryKV();
    const botToken = '123:DM_403';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' });
    await kv.put('verified:20001', 'emoji:v1');

    const { calls, fetchMock, state } = createMockTg({ failOwnerPush: true });

    await withFetch(fetchMock, async () => {
      // Push fails with 403 -> does NOT throw, sets dm:owner_unreachable = '1', STILL archives visitor message!
      await handleTelegramUpdate(
        {
          message: {
            message_id: 41,
            from: { id: 20001, first_name: 'Alice' },
            chat: { id: 20001, type: 'private' },
            text: '重要留言不能丢',
          },
        },
        env,
        'https://panel.test'
      );

      expect(await kv.get(DM_OWNER_UNREACHABLE_KEY)).toBe('1');
      const hist = await getVisitorHistory(env, '20001');
      expect(hist.messages).toHaveLength(1);
      expect(hist.messages[0].text).toBe('重要留言不能丢');

      // Admin bootstrap exposes inboxMode='dm' & ownerUnreachable=true; guest bootstrap leaks neither
      const now = Math.floor(Date.now() / 1000);
      const adminInit = await signInitData(
        { auth_date: String(now), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
        botToken
      );
      const guestInit = await signInitData(
        { auth_date: String(now), user: JSON.stringify({ id: 20001, first_name: 'Alice' }) },
        botToken
      );

      const adminBoot = await (
        await worker.fetch(
          new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': adminInit } }),
          env
        )
      ).json();
      expect(adminBoot.adminConfig.inboxMode).toBe('dm');
      expect(adminBoot.adminConfig.ownerUnreachable).toBe(true);
      expect(adminBoot.config.inboxMode).toBeUndefined();
      expect(adminBoot.config.ownerUnreachable).toBeUndefined();

      const guestBoot = await (
        await worker.fetch(
          new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': guestInit } }),
          env
        )
      ).json();
      expect(guestBoot.adminConfig).toBeNull();
      expect(guestBoot.config.inboxMode).toBeUndefined();

      // In-panel direct reply in DM mode sends to visitor ONLY (does not mirror to owner DM)
      calls.length = 0;
      const replyRes = await worker.fetch(
        new Request('https://panel.test/api/admin/visitors/20001/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': adminInit },
          body: JSON.stringify({ text: '面板直接回复你' }),
        }),
        env
      );
      expect((await replyRes.json()).ok).toBe(true);
      expect(calls.some((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === 20001)).toBe(true);
      expect(calls.some((c) => Number(c.body.chat_id) === 10001)).toBe(false);

      // Once push succeeds again, dm:owner_unreachable is cleared automatically
      state.failOwnerPush = false;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 42,
            from: { id: 20001, first_name: 'Alice' },
            chat: { id: 20001, type: 'private' },
            text: '恢复推送测试',
          },
        },
        env,
        'https://panel.test'
      );
      expect(await kv.get(DM_OWNER_UNREACHABLE_KEY)).toBeNull();
    });
  });

  it('sends silent keyword notice in DM mode and preserves full regression behavior in topic mode', async () => {
    // Part A: DM mode silent keyword auto-reply notice
    const dmKv = createMemoryKV();
    const dmEnv = makeEnv({ TOPIC_MAP: dmKv, BOT_TOKEN: '123:DM_KW', ADMIN_IDS: '10001' });
    await savePanelConfig(dmEnv, {
      pmBot: {
        keywordReplies: [{ id: 'kw1', keywords: '友链', matchMode: 'contains', reply: '欢迎换友链', forwardToAdmin: true }],
      },
    });
    await dmKv.put('verified:20001', 'emoji:v1');
    const dmMock = createMockTg({ nextMsgStart: 900 });

    await withFetch(dmMock.fetchMock, async () => {
      await handleTelegramUpdate(
        {
          message: {
            message_id: 51,
            from: { id: 20001, first_name: 'Alice' },
            chat: { id: 20001, type: 'private' },
            text: '请问换友链吗',
          },
        },
        dmEnv,
        'https://panel.test'
      );
      expect(
        dmMock.calls.some(
          (c) =>
            c.method === 'sendMessage' &&
            c.body.chat_id === 10001 &&
            c.body.disable_notification === true &&
            c.body.text.includes('已触发关键词自动回复')
        )
      ).toBe(true);
    });

    // Part B: Regression in topic mode (forwarding, topic reply, /del, keyword notice, unchanged KV schema)
    const topicKv = createMemoryKV();
    const topicEnv = makeEnv({
      TOPIC_MAP: topicKv,
      BOT_TOKEN: '123:TOPIC_REG',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100999111',
    });
    await savePanelConfig(topicEnv, {
      pmBot: {
        keywordReplies: [{ id: 'kw2', keywords: '合作', matchMode: 'contains', reply: '请留联系方式', forwardToAdmin: true }],
      },
    });
    await topicKv.put('verified:20009', 'emoji:v1');
    const topicMock = createMockTg({ nextMsgStart: 2000 });

    await withFetch(topicMock.fetchMock, async () => {
      // Visitor message with keyword -> creates topic, copies to topic, replies to visitor, silent topic notice, recorded ONCE
      await handleTelegramUpdate(
        {
          message: {
            message_id: 61,
            from: { id: 20009, first_name: 'TopicGuest' },
            chat: { id: 20009, type: 'private' },
            text: '商务合作咨询',
          },
        },
        topicEnv,
        'https://panel.test'
      );
      expect(topicMock.calls.some((c) => c.method === 'createForumTopic')).toBe(true);
      expect(
        topicMock.calls.some(
          (c) => c.method === 'copyMessage' && c.body.chat_id === '-100999111' && c.body.message_thread_id === 321
        )
      ).toBe(true);
      expect(
        topicMock.calls.some(
          (c) =>
            c.method === 'sendMessage' &&
            c.body.chat_id === '-100999111' &&
            c.body.message_thread_id === 321 &&
            c.body.disable_notification === true &&
            c.body.text.includes('已触发关键词自动回复')
        )
      ).toBe(true);
      // Recorded exactly once (no double-write!)
      const detail = await getVisitorDetail(topicEnv, '20009');
      expect(detail.visitor_msg_count).toBe(1);
      expect(detail.msg_count).toBe(1);

      // Admin replies inside topic -> copies to visitor, KV entry has NO dmMsgId field
      topicMock.calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 700,
            message_thread_id: 321,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -100999111, type: 'supergroup' },
            text: '话题内回复测试',
          },
        },
        topicEnv,
        'https://panel.test'
      );
      const copyToVisitor = topicMock.calls.find((c) => c.method === 'copyMessage' && c.body.chat_id === 20009);
      expect(copyToVisitor).toBeTruthy();
      const hist = await getVisitorHistory(topicEnv, '20009');
      expect(hist.pmMessageIds[0].topicMsgId).toBe(700);
      expect('dmMsgId' in hist.pmMessageIds[0]).toBe(false);

      // /del inside topic quoting 700 recalls the visitor PM message
      const sentPmId = hist.pmMessageIds[0].id;
      topicMock.calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 701,
            message_thread_id: 321,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: -100999111, type: 'supergroup' },
            reply_to_message: { message_id: 700 },
            text: '/del',
          },
        },
        topicEnv,
        'https://panel.test'
      );
      expect(
        topicMock.calls.some((c) => c.method === 'deleteMessage' && c.body.chat_id === 20009 && c.body.message_id === sentPmId)
      ).toBe(true);

      // Admin bootstrap reports inboxMode='topic' and ownerUnreachable=false
      const adminInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
        '123:TOPIC_REG'
      );
      const boot = await (
        await worker.fetch(
          new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': adminInit } }),
          topicEnv
        )
      ).json();
      expect(boot.adminConfig.inboxMode).toBe('topic');
      expect(boot.adminConfig.ownerUnreachable).toBe(false);
    });
  });

  it('never resolves dmmap for a non-owner admin (per-chat message IDs collide) and hints once per 24h', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:DM_COADMIN', ADMIN_IDS: '10001,10002' });
    // Owner's message #42 maps to visitor 20001; co-admin 10002 also has a message #42 in their own chat
    await kv.put(`${DM_MAP_PREFIX}42`, '20001');

    const { calls, fetchMock } = createMockTg();
    const coAdminReply = (id) => ({
      message: {
        message_id: id,
        from: { id: 10002, first_name: 'CoAdmin' },
        chat: { id: 10002, type: 'private' },
        text: 'hi there',
        reply_to_message: { message_id: 42, chat: { id: 10002, type: 'private' } },
      },
    });

    await withFetch(fetchMock, async () => {
      await handleTelegramUpdate(coAdminReply(43), env, 'https://panel.test');
      expect(calls.some((c) => Number(c.body.chat_id) === 20001)).toBe(false);
      const hints = calls.filter((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === 10002);
      expect(hints).toHaveLength(1);
      expect(hints[0].body.text).toContain('只有主人');

      calls.length = 0;
      await handleTelegramUpdate(coAdminReply(44), env, 'https://panel.test');
      expect(calls).toHaveLength(0);
    });
  });

  it('does not flag owner unreachable when a push fails for a non-403 reason', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:DM_400', ADMIN_IDS: '10001' });
    await kv.put('verified:20001', 'emoji:v1');

    const { fetchMock: baseFetch } = createMockTg();
    const fetchMock = vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (method === 'copyMessage' && Number(body.chat_id) === 10001) {
        return new Response(
          JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message to copy not found' }),
          { status: 400 }
        );
      }
      return baseFetch(url, init);
    });

    await withFetch(fetchMock, async () => {
      await handleTelegramUpdate(
        {
          message: {
            message_id: 51,
            from: { id: 20001, first_name: 'Alice' },
            chat: { id: 20001, type: 'private' },
            text: 'deleted right away',
          },
        },
        env,
        'https://panel.test'
      );
      expect(await kv.get(DM_OWNER_UNREACHABLE_KEY)).toBeNull();
      const hist = await getVisitorHistory(env, '20001');
      expect(hist.messages).toHaveLength(1);
    });
  });

  it('does not forward an unknown command to the visitor when the owner quotes a push', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:DM_UNKNOWN_CMD', ADMIN_IDS: '10001' });
    await kv.put(`${DM_MAP_PREFIX}42`, '20001');

    const { calls, fetchMock } = createMockTg();
    await withFetch(fetchMock, async () => {
      await handleTelegramUpdate(
        {
          message: {
            message_id: 60,
            from: { id: 10001, first_name: 'Owner' },
            chat: { id: 10001, type: 'private' },
            text: '/bna',
            entities: [{ type: 'bot_command', offset: 0, length: 4 }],
            reply_to_message: { message_id: 42, chat: { id: 10001, type: 'private' } },
          },
        },
        env,
        'https://panel.test'
      );
      expect(calls.some((c) => Number(c.body.chat_id) === 20001)).toBe(false);
      const notice = calls.find((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === 10001);
      expect(notice?.body.text).toContain('未识别的命令 /bna');
    });
  });

  it('tells visitors messaging is unavailable instead of inviting them to type when the inbox is off', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:INBOX_OFF' });

    const { calls, fetchMock } = createMockTg();
    await withFetch(fetchMock, async () => {
      const res = await initiateChatFromMiniApp(env, 'https://panel.test', { id: 20001, first_name: 'Alice' });
      expect(res.inboxOff).toBe(true);
      const sent = calls.filter((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === 20001);
      expect(sent).toHaveLength(1);
      expect(sent[0].body.text).toContain('暂未开启私信功能');
      expect(sent[0].body.text).not.toContain('直接在下方输入框打字');
    });
  });
});

describe('Probe offline & resource alerts (v1.8)', () => {
  function setupMockNet({ probeResponder, tgOverrides = {} } = {}) {
    const tgCalls = [];
    const probeCalls = [];
    let topicSeq = 900;
    const fetchMock = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.startsWith('https://api.telegram.org/')) {
        const method = u.split('/').pop();
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        tgCalls.push({ method, body });
        if (tgOverrides[method]) return tgOverrides[method](body, tgCalls);
        if (method === 'createForumTopic') {
          topicSeq += 1;
          return new Response(JSON.stringify({ ok: true, result: { message_thread_id: topicSeq } }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), { status: 200 });
      }
      probeCalls.push({ url: u, init });
      if (probeResponder) return probeResponder(u, init);
      return new Response(JSON.stringify({ servers: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return { tgCalls, probeCalls, fetchMock };
  }

  async function withFetch(fetchMock, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      await fn();
    } finally {
      globalThis.fetch = orig;
    }
  }

  const jsonNodesRes = (nodes) =>
    new Response(JSON.stringify({ servers: nodes }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('skips probe fetch and performs zero KV writes when disabled, unconfigured, or in demoMode', async () => {
    const kv = createMemoryKV();
    const putSpy = vi.spyOn(kv, 'put');
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:ALERT', ADMIN_IDS: '10001' });
    const { tgCalls, probeCalls, fetchMock } = setupMockNet();
    const tick = Date.parse('2026-11-26T10:00:00Z');

    await withFetch(fetchMock, async () => {
      // 1. Default config (alerts.enabled === false) -> 0 probe fetches, 0 KV writes
      const r1 = await runProbeAlerts(env, tick);
      expect(r1.skipped).toBe(true);
      expect(r1.reason).toBe('disabled');
      expect(probeCalls).toHaveLength(0);
      expect(putSpy).toHaveBeenCalledTimes(0);

      // 2. Enabled but no probe URL -> 0 fetches, 0 KV writes
      await savePanelConfig(env, { probe: { url: '', demoMode: false, alerts: { enabled: true } } });
      putSpy.mockClear();
      const r2 = await runProbeAlerts(env, tick);
      expect(r2.skipped).toBe(true);
      expect(r2.reason).toBe('unconfigured_or_demo');
      expect(probeCalls).toHaveLength(0);
      expect(putSpy).toHaveBeenCalledTimes(0);

      // 3. Enabled with demoMode: true (even if URL is filled) -> 0 fetches, 0 KV writes
      await savePanelConfig(env, {
        probe: { provider: 'json', url: 'https://probe.test/stats.json', demoMode: true, alerts: { enabled: true } },
      });
      putSpy.mockClear();
      const r3 = await runProbeAlerts(env, tick);
      expect(r3.skipped).toBe(true);
      expect(r3.reason).toBe('unconfigured_or_demo');
      expect(probeCalls).toHaveLength(0);
      expect(tgCalls).toHaveLength(0);
      expect(putSpy).toHaveBeenCalledTimes(0);
    });
  });

  it('requires confirmChecks consecutive misses before offline alert, avoids duplicates, and sends silent recovery with duration', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:ALERT_OFF', ADMIN_IDS: '10001' });
    await savePanelConfig(env, {
      siteOrigin: 'https://panel.test',
      probe: {
        provider: 'json',
        url: 'https://probe.test/stats.json',
        alerts: { enabled: true, intervalMinutes: 5, confirmChecks: 2, notifyRecovery: true },
      },
    });

    let nodeOnline = true;
    const { tgCalls, fetchMock } = setupMockNet({
      probeResponder: () =>
        jsonNodesRes([{ id: 'n1', name: '东京 01', online: nodeOnline, cpu: 12, memory: 30, disk: 40 }]),
    });

    const t0 = Date.parse('2026-11-26T10:00:00Z');

    await withFetch(fetchMock, async () => {
      // Baseline check (online) -> records node, no alert
      await runProbeAlerts(env, t0);
      expect(tgCalls).toHaveLength(0);

      // Miss #1 -> not confirmed yet, no alert
      nodeOnline = false;
      await runProbeAlerts(env, t0 + 5 * 60000);
      expect(tgCalls).toHaveLength(0);

      // Miss #2 -> confirmed! Sends non-silent offline alert
      await runProbeAlerts(env, t0 + 10 * 60000);
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0].method).toBe('sendMessage');
      expect(tgCalls[0].body.chat_id).toBe(10001);
      expect(tgCalls[0].body.disable_notification).toBe(false);
      expect(tgCalls[0].body.text).toContain('节点掉线：东京 01');
      expect(tgCalls[0].body.text).toContain('分钟');

      // Miss #3 -> still offline, NO duplicate alert and ZERO KV writes!
      const putSpy = vi.spyOn(kv, 'put');
      tgCalls.length = 0;
      await runProbeAlerts(env, t0 + 15 * 60000);
      expect(tgCalls).toHaveLength(0);
      expect(putSpy).toHaveBeenCalledTimes(0);

      // Recovery after 35 minutes offline -> sends silent recovery notice with duration
      nodeOnline = true;
      await runProbeAlerts(env, t0 + 40 * 60000);
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0].body.disable_notification).toBe(true);
      expect(tgCalls[0].body.text).toContain('节点恢复：东京 01');
      expect(tgCalls[0].body.text).toContain('35 分钟');

      // When notifyRecovery is disabled, recovery stays silent (0 messages)
      await savePanelConfig(env, { probe: { alerts: { notifyRecovery: false } } });
      nodeOnline = false;
      await runProbeAlerts(env, t0 + 45 * 60000);
      await runProbeAlerts(env, t0 + 50 * 60000);
      tgCalls.length = 0;
      nodeOnline = true;
      await runProbeAlerts(env, t0 + 55 * 60000);
      expect(tgCalls).toHaveLength(0);
    });
  });

  it('sends only one probe-down alert when probe endpoint fails without flagging nodes offline, then sends recovery', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:PROBE_DOWN', ADMIN_IDS: '10001' });
    await savePanelConfig(env, {
      probe: {
        provider: 'json',
        url: 'https://probe.test/stats.json',
        alerts: { enabled: true, intervalMinutes: 5, confirmChecks: 2 },
      },
    });

    let probeUp = true;
    const { tgCalls, fetchMock } = setupMockNet({
      probeResponder: () => {
        if (!probeUp) return new Response('Bad Gateway', { status: 502 });
        return jsonNodesRes([
          { id: 'n1', name: 'Tokyo', online: true, cpu: 10 },
          { id: 'n2', name: 'HK', online: true, cpu: 15 },
        ]);
      },
    });
    const t0 = Date.parse('2026-11-26T10:00:00Z');

    await withFetch(fetchMock, async () => {
      await runProbeAlerts(env, t0);
      expect(tgCalls).toHaveLength(0);

      // Probe fails twice -> emits ONLY "探针连接失败", zero node offline alerts
      probeUp = false;
      await runProbeAlerts(env, t0 + 5 * 60000);
      expect(tgCalls).toHaveLength(0);

      await runProbeAlerts(env, t0 + 10 * 60000);
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0].body.text).toContain('探针连接失败');
      expect(tgCalls[0].body.text).not.toContain('节点掉线');
      expect(tgCalls[0].body.disable_notification).toBe(false);

      // Probe stays down on 3rd tick -> no duplicate alert
      tgCalls.length = 0;
      await runProbeAlerts(env, t0 + 15 * 60000);
      expect(tgCalls).toHaveLength(0);

      // Probe recovers -> sends silent "探针已恢复连接", nodes still online -> no spurious node recovery
      probeUp = true;
      await runProbeAlerts(env, t0 + 20 * 60000);
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0].body.text).toContain('探针已恢复连接');
      expect(tgCalls[0].body.disable_notification).toBe(true);
    });
  });

  it('never alerts on first-seen offline nodes, skips muted nodes, and treats vanished nodes as offline until pruned', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:FIRST_MUTE', ADMIN_IDS: '10001' });
    await savePanelConfig(env, {
      probe: {
        provider: 'json',
        url: 'https://probe.test/stats.json',
        alerts: { enabled: true, intervalMinutes: 5, confirmChecks: 1, mutedNodes: ['n-muted'] },
      },
    });

    let nodes = [
      { id: 'n-already-off', name: 'OldDead', online: false },
      { id: 'n-muted', name: 'MutedBox', online: true },
      { id: 'n-temp', name: 'TempBox', online: true },
    ];
    const { tgCalls, fetchMock } = setupMockNet({ probeResponder: () => jsonNodesRes(nodes) });
    const t0 = Date.parse('2026-11-26T10:00:00Z');

    await withFetch(fetchMock, async () => {
      // Round 1: already-offline node must NOT notify even with confirmChecks: 1
      await runProbeAlerts(env, t0);
      expect(tgCalls).toHaveLength(0);

      // Round 2: already-offline stays offline (still no alert), muted node goes offline (skipped!),
      // TempBox vanishes from the probe list -> counted as offline (some probes drop offline nodes)
      nodes = [
        { id: 'n-already-off', name: 'OldDead', online: false },
        { id: 'n-muted', name: 'MutedBox', online: false },
      ];
      await runProbeAlerts(env, t0 + 5 * 60000);
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0].body.text).toContain('TempBox');
      expect(tgCalls[0].body.text).toContain('已不再返回');

      const saved = await kv.get(ALERT_STATE_KEY, { type: 'json' });
      expect(saved.nodes['n-muted']).toBeUndefined();
      expect(saved.nodes['n-temp'].online).toBe(false);
      expect(saved.nodes['n-temp'].absentSince).toBe(t0 + 5 * 60000);
      expect(saved.nodes['n-already-off'].online).toBe(false);

      // Round 3: OldDead comes online for the first time -> NO spurious recovery notice;
      // TempBox still absent -> already notified, no duplicate
      tgCalls.length = 0;
      nodes = [{ id: 'n-already-off', name: 'OldDead', online: true }];
      await runProbeAlerts(env, t0 + 10 * 60000);
      expect(tgCalls).toHaveLength(0);

      // A steady absent node writes nothing; after 24h absent it is pruned silently
      const putSpy = vi.spyOn(kv, 'put');
      await runProbeAlerts(env, t0 + 15 * 60000);
      expect(putSpy.mock.calls.filter((c) => c[0] === ALERT_STATE_KEY)).toHaveLength(0);
      putSpy.mockRestore();

      await runProbeAlerts(env, t0 + 5 * 60000 + 24 * 60 * 60000);
      expect(tgCalls).toHaveLength(0);
      const pruned = await kv.get(ALERT_STATE_KEY, { type: 'json' });
      expect(pruned.nodes['n-temp']).toBeUndefined();
    });
  });

  it('triggers resource breach alert only after sustainChecks consecutive ticks, once per breach, and clears silently on drop', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:RES', ADMIN_IDS: '10001' });
    await savePanelConfig(env, {
      probe: {
        provider: 'json',
        url: 'https://probe.test/stats.json',
        alerts: {
          enabled: true,
          intervalMinutes: 5,
          resource: { enabled: true, cpu: 90, ram: 90, disk: 0, sustainChecks: 3 },
        },
      },
    });

    let cpu = 20;
    let disk = 99; // disk threshold is 0 -> disabled!
    const { tgCalls, fetchMock } = setupMockNet({
      probeResponder: () =>
        jsonNodesRes([{ id: 'n1', name: '东京 01', online: true, cpu, memory: 50, disk }]),
    });
    const t0 = Date.parse('2026-11-26T10:00:00Z');

    await withFetch(fetchMock, async () => {
      // Baseline
      await runProbeAlerts(env, t0);
      expect(tgCalls).toHaveLength(0);

      // Breach tick 1 & 2 -> not sustained yet
      cpu = 96;
      await runProbeAlerts(env, t0 + 5 * 60000);
      await runProbeAlerts(env, t0 + 10 * 60000);
      expect(tgCalls).toHaveLength(0);

      // Breach tick 3 -> triggers ONCE; disk=99% ignored because threshold=0
      await runProbeAlerts(env, t0 + 15 * 60000);
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0].body.text).toContain('东京 01 CPU 持续 ≥ 90%');
      expect(tgCalls[0].body.text).toContain('96%');
      expect(tgCalls[0].body.text).not.toContain('磁盘');

      // Breach tick 4 -> already notified, no duplicate
      tgCalls.length = 0;
      await runProbeAlerts(env, t0 + 20 * 60000);
      expect(tgCalls).toHaveLength(0);

      // Drops below threshold -> clears state, NO recovery notification
      cpu = 40;
      await runProbeAlerts(env, t0 + 25 * 60000);
      expect(tgCalls).toHaveLength(0);
      const state = await kv.get(ALERT_STATE_KEY, { type: 'json' });
      expect(state.nodes.n1.breach.cpu).toBe(0);
      expect(state.nodes.n1.notifiedBreach.cpu).toBe(false);
    });
  });

  it('respects intervalMinutes gating, performs zero KV writes when steady-state healthy, and honors skipCacheWrite', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:ZERO_WRITE', ADMIN_IDS: '10001' });
    await savePanelConfig(env, {
      probe: {
        provider: 'json',
        url: 'https://probe.test/stats.json',
        alerts: { enabled: true, intervalMinutes: 10 },
      },
    });

    const { probeCalls, fetchMock } = setupMockNet({
      probeResponder: () => jsonNodesRes([{ id: 'n1', name: 'SG-01', online: true, cpu: 25, memory: 40, disk: 50 }]),
    });

    await withFetch(fetchMock, async () => {
      // 10:05 is NOT divisible by 10 -> skipped!
      const skipped = await runProbeAlerts(env, Date.parse('2026-11-26T10:05:00Z'));
      expect(skipped.skipped).toBe(true);
      expect(skipped.reason).toBe('interval');
      expect(probeCalls).toHaveLength(0);

      // 10:10 IS divisible by 10 -> runs baseline (writes alert:state once, does NOT write cache:komari_probe!)
      const first = await runProbeAlerts(env, Date.parse('2026-11-26T10:10:00Z'));
      expect(first.skipped).toBe(false);
      expect(first.stateWritten).toBe(true);
      expect(await kv.get('cache:komari_probe')).toBeNull();

      // 10:20 steady-state healthy -> ZERO KV writes (neither alert:state nor cache:komari_probe)!
      const putSpy = vi.spyOn(kv, 'put');
      const steady = await runProbeAlerts(env, Date.parse('2026-11-26T10:20:00Z'));
      expect(steady.skipped).toBe(false);
      expect(steady.stateWritten).toBe(false);
      expect(putSpy).toHaveBeenCalledTimes(0);
      expect(await kv.get('cache:komari_probe')).toBeNull();
    });
  });

  it('routes alerts to dedicated Forum Topic (reusing & recreating if deleted), merges >10 alerts, and supports alert-test API with rate limit', async () => {
    const kv = createMemoryKV();
    const botToken = '123:ALERT_ROUTE';
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100555999',
      BOT_USERNAME: 'RoseTest_bot',
      APP_SHORT_NAME: 'panel',
    });
    await savePanelConfig(env, {
      probe: {
        provider: 'json',
        url: 'https://probe.test/stats.json',
        alerts: { enabled: true, intervalMinutes: 5, confirmChecks: 1 },
      },
    });

    // 12 nodes all online -> all 12 drop offline in same tick -> merged into ONE message listing 10 + "另有 2 个"
    let allOnline = true;
    const twelveNodes = () =>
      Array.from({ length: 12 }, (_, i) => ({
        id: `n-${i + 1}`,
        name: `Node-${String(i + 1).padStart(2, '0')}`,
        online: allOnline,
      }));

    let failFirstTopicSend = false;
    const { tgCalls, fetchMock } = setupMockNet({
      probeResponder: () => jsonNodesRes(twelveNodes()),
      tgOverrides: {
        sendMessage: (body) => {
          if (failFirstTopicSend) {
            failFirstTopicSend = false;
            return new Response(
              JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message thread not found' }),
              { status: 400 }
            );
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 200, chat: { id: body.chat_id } } }), {
            status: 200,
          });
        },
      },
    });

    const t0 = Date.parse('2026-11-26T10:00:00Z');
    await withFetch(fetchMock, async () => {
      // Via worker.scheduled entrypoint
      const waitPromises = [];
      await worker.scheduled({ scheduledTime: t0 }, env, { waitUntil: (p) => waitPromises.push(p) });
      await Promise.all(waitPromises);
      expect(tgCalls).toHaveLength(0);

      // All 12 drop offline -> creates dedicated alert topic (901), sends ONE merged message with 10 items + overflow note
      allOnline = false;
      await runProbeAlerts(env, t0 + 5 * 60000);
      expect(tgCalls.filter((c) => c.method === 'createForumTopic')).toHaveLength(1);
      expect(await kv.get(ALERT_TOPIC_ID_KEY, { type: 'json' })).toEqual({ chatId: '-100555999', threadId: 901 });
      const sentAlerts = tgCalls.filter((c) => c.method === 'sendMessage');
      expect(sentAlerts).toHaveLength(1);
      expect(sentAlerts[0].body.message_thread_id).toBe(901);
      expect(sentAlerts[0].body.text).toContain('另有 2 个');
      expect(sentAlerts[0].body.reply_markup.inline_keyboard[0][0].url).toBe(
        'https://t.me/RoseTest_bot/panel?startapp=probe'
      );

      // All 12 recover, and simulate deleted alert topic -> recreates topic (902) and resends cleanly
      tgCalls.length = 0;
      failFirstTopicSend = true;
      allOnline = true;
      await runProbeAlerts(env, t0 + 10 * 60000);
      expect(tgCalls.filter((c) => c.method === 'createForumTopic')).toHaveLength(1);
      expect(await kv.get(ALERT_TOPIC_ID_KEY, { type: 'json' })).toEqual({ chatId: '-100555999', threadId: 902 });

      // POST /api/admin/probe/alert-test: blocks guest (403), allows admin up to 3/min then 429
      const now = Math.floor(Date.now() / 1000);
      const guestInit = await signInitData(
        { auth_date: String(now), user: JSON.stringify({ id: 20002, first_name: 'Guest' }) },
        botToken
      );
      const adminInit = await signInitData(
        { auth_date: String(now), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
        botToken
      );
      const guestRes = await worker.fetch(
        new Request('https://panel.test/api/admin/probe/alert-test', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': guestInit },
        }),
        env
      );
      expect(guestRes.status).toBe(403);

      for (let i = 0; i < 3; i += 1) {
        const okRes = await worker.fetch(
          new Request('https://panel.test/api/admin/probe/alert-test', {
            method: 'POST',
            headers: { 'X-Telegram-Init-Data': adminInit },
          }),
          env
        );
        expect(okRes.status).toBe(200);
        const body = await okRes.json();
        expect(body.ok).toBe(true);
        expect(body.mode).toBe('topic');
      }
      const limitedRes = await worker.fetch(
        new Request('https://panel.test/api/admin/probe/alert-test', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': adminInit },
        }),
        env
      );
      expect(limitedRes.status).toBe(429);
    });
  });

  it('strips probe.alerts from sanitizePublicConfig while keeping it clamped in sanitizeAdminConfig', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, ADMIN_IDS: '10001' });
    const saved = await savePanelConfig(env, {
      probe: {
        url: 'https://probe.test',
        alerts: {
          enabled: true,
          intervalMinutes: 7, // invalid -> falls back to 5
          confirmChecks: 99, // clamped to 5
          mutedNodes: ['a', 'a', '  b  ', ''],
          resource: { enabled: true, cpu: 20, ram: 120, disk: 0, sustainChecks: 0 },
        },
      },
    });

    expect(saved.probe.alerts.intervalMinutes).toBe(5);
    expect(saved.probe.alerts.confirmChecks).toBe(5);
    expect(saved.probe.alerts.mutedNodes).toEqual(['a', 'b']);
    expect(saved.probe.alerts.resource).toEqual({
      enabled: true,
      cpu: 50,
      ram: 100,
      disk: 0,
      sustainChecks: 1,
    });

    const pubGuest = sanitizePublicConfig(saved, env, false);
    const pubAdmin = sanitizePublicConfig(saved, env, true);
    expect('alerts' in pubGuest.probe).toBe(false);
    expect('alerts' in pubAdmin.probe).toBe(false);

    const adminCfg = sanitizeAdminConfig(saved, env, { inboxMode: 'dm', ownerUnreachable: false });
    expect(adminCfg.probe.alerts.enabled).toBe(true);
    expect(formatAlertMessage([]).text).toBe('');
    expect(evaluateProbeAlerts(null, { protocol: 'json', nodes: [] }, saved.probe.alerts, 0).events).toEqual([]);
  });

  it('does not reuse a cached alert topic after rebinding to a different group', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:REBIND', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100111' });
    // Group A's alert topic was thread 57; the owner then rebinds to group B (where 57 is a visitor topic)
    await kv.put(ALERT_TOPIC_ID_KEY, JSON.stringify({ chatId: '-100111', threadId: 57 }));
    await kv.put('config:supergroup_id', '-100222');

    const { tgCalls, fetchMock } = setupMockNet();
    await withFetch(fetchMock, async () => {
      const res = await sendAlertNotification(env, 'test');
      expect(res.ok).toBe(true);
      expect(tgCalls.filter((c) => c.method === 'createForumTopic')).toHaveLength(1);
      expect(tgCalls.find((c) => c.method === 'createForumTopic').body.chat_id).toBe('-100222');
      const sent = tgCalls.find((c) => c.method === 'sendMessage');
      expect(sent.body.chat_id).toBe('-100222');
      expect(sent.body.message_thread_id).toBe(901);
      expect(await kv.get(ALERT_TOPIC_ID_KEY, { type: 'json' })).toEqual({ chatId: '-100222', threadId: 901 });

      // Same group again -> cached topic reused, no new topic
      tgCalls.length = 0;
      await sendAlertNotification(env, 'again');
      expect(tgCalls.filter((c) => c.method === 'createForumTopic')).toHaveLength(0);
      expect(tgCalls.find((c) => c.method === 'sendMessage').body.message_thread_id).toBe(901);
    });
  });

  it('treats a sudden empty node list as a probe failure instead of mass offline alerts', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123:EMPTY', ADMIN_IDS: '10001' });
    await savePanelConfig(env, {
      probe: {
        provider: 'json',
        url: 'https://probe.test/stats.json',
        alerts: { enabled: true, intervalMinutes: 5, confirmChecks: 1 },
      },
    });

    let nodes = [
      { id: 'a', name: 'A', online: true },
      { id: 'b', name: 'B', online: true },
    ];
    const { tgCalls, fetchMock } = setupMockNet({ probeResponder: () => jsonNodesRes(nodes) });
    const t0 = Date.parse('2026-11-26T10:00:00Z');
    await withFetch(fetchMock, async () => {
      await runProbeAlerts(env, t0);
      nodes = [];
      await runProbeAlerts(env, t0 + 5 * 60000);
      const sent = tgCalls.filter((c) => c.method === 'sendMessage');
      expect(sent).toHaveLength(1);
      expect(sent[0].body.text).toContain('探针未返回任何节点');
      expect(sent[0].body.text).not.toContain('节点掉线');

      // Nodes come back -> probe recovery notice, node state was preserved (no spurious per-node alerts)
      tgCalls.length = 0;
      nodes = [
        { id: 'a', name: 'A', online: true },
        { id: 'b', name: 'B', online: true },
      ];
      await runProbeAlerts(env, t0 + 10 * 60000);
      const recovered = tgCalls.filter((c) => c.method === 'sendMessage');
      expect(recovered).toHaveLength(1);
      expect(recovered[0].body.text).toContain('探针已恢复连接');
    });
  });

  it('keeps the existing siteOrigin when settings are saved from another origin (e.g. a preview URL)', async () => {
    const kv = createMemoryKV();
    const botToken = '123:ORIGIN';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001', BOT_USERNAME: 'RoseTest_bot' });
    const now = Math.floor(Date.now() / 1000);
    const adminInit = await signInitData(
      { auth_date: String(now), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
      botToken
    );
    const { fetchMock } = setupMockNet();
    const save = (origin) =>
      worker.fetch(
        new Request(`${origin}/api/admin/config`, {
          method: 'PUT',
          headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: { tagline: `saved from ${origin}` } }),
        }),
        env
      );

    await withFetch(fetchMock, async () => {
      // Unknown siteOrigin -> filled from the first HTTPS origin
      expect((await save('https://panel.example.com')).status).toBe(200);
      expect((await loadPanelConfig(env)).siteOrigin).toBe('https://panel.example.com');

      // Saving from a preview deployment must not overwrite it
      expect((await save('https://feat-x-rose.example.workers.dev')).status).toBe(200);
      const cfg = await loadPanelConfig(env);
      expect(cfg.profile.tagline).toBe('saved from https://feat-x-rose.example.workers.dev');
      expect(cfg.siteOrigin).toBe('https://panel.example.com');
    });
  });
});

describe('Share card poster & Open Graph link preview (v1.8)', () => {
  function createHtmlAssetsEnv(kv, extra = {}) {
    return makeEnv({
      TOPIC_MAP: kv,
      ASSETS: {
        async fetch() {
          return new Response(
            '<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>RosePanel · 个人面板</title></head><body><div id="root"></div></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        },
      },
      ...extra,
    });
  }

  it('injects OG meta tags, single <title>, and truncates og:description to 160 chars', async () => {
    const kv = createMemoryKV();
    const env = createHtmlAssetsEnv(kv);
    const longTagline = '欢迎来到我的个人名片 '.repeat(25).trim();
    await savePanelConfig(env, {
      profile: {
        displayName: 'Rose Garden',
        tagline: longTagline,
        avatarMode: 'owner',
      },
    });

    const res = await worker.fetch(new Request('https://card.example.com/'), env);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(BRAND_NAME).toBe('RosePanel');
    expect(BRAND_SIGNATURE).toBe('Made with RosePanel 🌹');
    expect(html).toContain('<meta property="og:site_name" content="RosePanel" />');
    expect(html).toContain('<meta property="og:type" content="profile" />');
    expect(html).toContain('<meta property="og:title" content="Rose Garden" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain('<title>Rose Garden · RosePanel</title>');

    // Strictly one <title> tag in the rendered page
    const titles = html.match(/<title>[\s\S]*?<\/title>/gi) || [];
    expect(titles).toHaveLength(1);

    // og:description truncated to <= 160 characters
    const descMatch = html.match(/<meta property="og:description" content="([^"]*)" \/>/);
    expect(descMatch).toBeTruthy();
    expect(Array.from(descMatch[1]).length).toBeLessThanOrEqual(160);
    expect(descMatch[1].endsWith('…')).toBe(true);
  });

  it('HTML-escapes displayName and tagline in OG tags and <title> to prevent tag injection', async () => {
    const kv = createMemoryKV();
    const env = createHtmlAssetsEnv(kv);
    await savePanelConfig(env, {
      profile: {
        displayName: 'Alice"><script>alert(1)</script>',
        tagline: 'Hi "friends" & <img src=x onerror=alert(2)>',
      },
    });

    const res = await worker.fetch(new Request('https://card.example.com/'), env);
    const html = await res.text();

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(
      '<meta property="og:title" content="Alice&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" />'
    );
    expect(html).toContain(
      '<meta property="og:description" content="Hi &quot;friends&quot; &amp; &lt;img src=x onerror=alert(2)&gt;" />'
    );
    expect(html).toContain(
      '<title>Alice&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; · RosePanel</title>'
    );
  });

  it('resolves og:image accurately for bot, owner, and custom avatarMode (and omits non-https custom)', async () => {
    const kv = createMemoryKV();
    const env = createHtmlAssetsEnv(kv);

    // 1. bot mode
    await savePanelConfig(env, { profile: { displayName: 'BotMode', avatarMode: 'bot', avatarUrl: '' } });
    let html = await (await worker.fetch(new Request('https://card.example.com/'), env)).text();
    expect(html).toContain('<meta property="og:image" content="https://card.example.com/api/avatar/owner" />');

    // 2. owner mode
    await savePanelConfig(env, { profile: { displayName: 'OwnerMode', avatarMode: 'owner', avatarUrl: '' } });
    html = await (await worker.fetch(new Request('https://card.example.com/'), env)).text();
    expect(html).toContain('<meta property="og:image" content="https://card.example.com/api/avatar/owner" />');

    // 3. custom mode with https URL
    await savePanelConfig(env, {
      profile: {
        displayName: 'CustomHttps',
        avatarMode: 'custom',
        avatarUrl: 'https://cdn.example.com/avatar.png',
      },
    });
    html = await (await worker.fetch(new Request('https://card.example.com/'), env)).text();
    expect(html).toContain('<meta property="og:image" content="https://cdn.example.com/avatar.png" />');

    // 4. custom mode with non-https URL omits og:image
    await savePanelConfig(env, {
      profile: {
        displayName: 'CustomHttp',
        avatarMode: 'custom',
        avatarUrl: 'http://insecure.example.com/avatar.png',
      },
    });
    html = await (await worker.fetch(new Request('https://card.example.com/'), env)).text();
    expect(html).not.toContain('property="og:image"');
  });

  it('computes shareUrl using t.me direct link when BOT_USERNAME & APP_SHORT_NAME are set, else site origin', async () => {
    const kv = createMemoryKV();
    const config = await loadPanelConfig(makeEnv({ TOPIC_MAP: kv }));

    const withDirect = sanitizePublicConfig(
      config,
      makeEnv({ TOPIC_MAP: kv, BOT_USERNAME: '@Rose202_bot', APP_SHORT_NAME: 'panel' }),
      false,
      'https://panel.example.com'
    );
    expect(withDirect.shareUrl).toBe('https://t.me/Rose202_bot/panel');

    const withoutAppShort = sanitizePublicConfig(
      config,
      makeEnv({ TOPIC_MAP: kv, BOT_USERNAME: 'Rose202_bot' }),
      false,
      'https://panel.example.com'
    );
    expect(withoutAppShort.shareUrl).toBe('https://panel.example.com/');

    const withoutBot = sanitizePublicConfig(config, makeEnv({ TOPIC_MAP: kv }), false, 'https://panel.example.com');
    expect(withoutBot.shareUrl).toBe('https://panel.example.com/');
  });
});

describe('Visitor source parameter attribution & promo links (v1.8)', () => {
  it('normalizes valid source params and rejects empty, uppercase, spaces, special chars, and >24 chars', () => {
    for (const fn of [normalizeSourceParam, normalizeClientSourceParam]) {
      expect(fn('src_site')).toBe('site');
      expect(fn('site')).toBe('site');
      expect(fn('src_nodeseek_2026')).toBe('nodeseek_2026');
      expect(fn('a'.repeat(24))).toBe('a'.repeat(24));
      expect(fn(`src_${'a'.repeat(24)}`)).toBe('a'.repeat(24));

      expect(fn('')).toBe('');
      expect(fn('src_')).toBe('');
      expect(fn('Site')).toBe('');
      expect(fn('src_Site')).toBe('');
      expect(fn('my site')).toBe('');
      expect(fn('src_my site')).toBe('');
      expect(fn('src_<script>')).toBe('');
      expect(fn('foo-bar')).toBe('');
      expect(fn('a'.repeat(25))).toBe('');
      expect(fn(`src_${'a'.repeat(25)}`)).toBe('');
      expect(fn(null)).toBe('');
      expect(fn(123)).toBe('');
    }
  });

  it('records src:{uid} during /start before verification, persists onto profile on first message, and deletes src:{uid}', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '123456:TEST_TOKEN',
      ADMIN_IDS: '999001',
    });
    await savePanelConfig(env, {
      pmBot: { enableVerification: true, verificationMode: 'emoji', enableCasCheck: false },
    });

    const tgCalls = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      const method = String(url).split('/').pop();
      const body = opts?.body ? JSON.parse(opts.body) : {};
      tgCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 400 + tgCalls.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      const visitor = { id: 50101, first_name: 'Newcomer', username: 'newcomer' };
      const putSpy = vi.spyOn(kv, 'put');

      // 1. Visitor taps /start src_site while still unverified
      await handleTelegramUpdate(
        {
          update_id: 1,
          message: {
            message_id: 10,
            from: visitor,
            chat: { id: 50101, type: 'private' },
            text: '/start src_site',
          },
        },
        env,
        'https://panel.test'
      );

      // Pending source written with 7d TTL; visitor is NOT yet in visitor list
      expect(await kv.get('src:50101')).toBe('site');
      const srcPut = putSpy.mock.calls.find(([k]) => k === 'src:50101');
      expect(srcPut?.[2]).toEqual({ expirationTtl: 7 * 86400 });
      expect(await kv.get('user:50101')).toBeNull();

      // 2. Visitor passes verification and sends first message
      await kv.put('verified:50101', 'emoji:v1');
      await handleTelegramUpdate(
        {
          update_id: 2,
          message: {
            message_id: 11,
            from: visitor,
            chat: { id: 50101, type: 'private' },
            text: '你好，从小站过来的！',
          },
        },
        env,
        'https://panel.test'
      );

      const detail = await getVisitorDetail(env, '50101');
      expect(detail.source).toBe('site');
      expect(detail.source_at).toBeTruthy();
      expect(await kv.get('src:50101')).toBeNull();

      // DM push header card also displays the source
      const headerPush = tgCalls.find(
        (c) => c.method === 'sendMessage' && String(c.body.chat_id) === '999001' && String(c.body.text || '').includes('50101')
      );
      expect(headerPush?.body?.text).toContain('• 来源：个人小站');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps first-touch source only: never overwrites pending src:{uid} or existing visitor source', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '123456:TEST_TOKEN',
      ADMIN_IDS: '999001',
    });
    await savePanelConfig(env, {
      pmBot: { enableVerification: false, verificationMode: 'off', enableCasCheck: false },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    try {
      const visitor = { id: 50202, first_name: 'FirstTouch' };
      await handleTelegramUpdate(
        {
          update_id: 10,
          message: { message_id: 20, from: visitor, chat: { id: 50202, type: 'private' }, text: '/start src_site' },
        },
        env,
        'https://panel.test'
      );
      expect(await kv.get('src:50202')).toBe('site');

      // Second /start with different channel must NOT overwrite
      const putSpy = vi.spyOn(kv, 'put');
      await handleTelegramUpdate(
        {
          update_id: 11,
          message: { message_id: 21, from: visitor, chat: { id: 50202, type: 'private' }, text: '/start src_channel' },
        },
        env,
        'https://panel.test'
      );
      expect(await kv.get('src:50202')).toBe('site');
      expect(putSpy.mock.calls.filter(([k]) => k === 'src:50202')).toHaveLength(0);

      // Persist onto profile via first message
      await upsertVisitorProfile(env, visitor, { incrementMsg: true, lastPreview: 'hi' });
      expect((await getVisitorDetail(env, '50202')).source).toBe('site');
      expect(await kv.get('src:50202')).toBeNull();

      // Returning visitor with existing source arriving via another link does not overwrite or write src:{uid}
      putSpy.mockClear();
      const wrote = await rememberPendingSource(env, '50202', 'poster');
      expect(wrote).toBe(false);
      expect(await kv.get('src:50202')).toBeNull();
      expect(putSpy).not.toHaveBeenCalled();
      expect((await getVisitorDetail(env, '50202')).source).toBe('site');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('ignores /start panel, bare /start, invalid /start src_<script>, and admin /start src_site', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '123456:TEST_TOKEN',
      ADMIN_IDS: '999001',
    });
    await savePanelConfig(env, {
      pmBot: { enableVerification: true, verificationMode: 'emoji', enableCasCheck: false },
    });

    const tgCalls = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      tgCalls.push({ method: String(url).split('/').pop(), body: opts?.body ? JSON.parse(opts.body) : {} });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 600 + tgCalls.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      // Non-src /start variants do not write src:* and still trigger normal verification
      for (const [uid, text] of [
        [50301, '/start panel'],
        [50302, '/start'],
        [50303, '/start src_<script>'],
      ]) {
        await handleTelegramUpdate(
          {
            update_id: uid,
            message: { message_id: 30, from: { id: uid, first_name: 'Guest' }, chat: { id: uid, type: 'private' }, text },
          },
          env,
          'https://panel.test'
        );
        expect(await kv.get(`src:${uid}`)).toBeNull();
        // Normal verification flow still triggered
        expect(tgCalls.some((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === uid)).toBe(true);
      }

      // Admin /start src_site never records source
      await handleTelegramUpdate(
        {
          update_id: 999,
          message: {
            message_id: 31,
            from: { id: 999001, first_name: 'Owner' },
            chat: { id: 999001, type: 'private' },
            text: '/start src_site',
          },
        },
        env,
        'https://panel.test'
      );
      expect(await kv.get('src:999001')).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('records valid source from POST /api/chat/start and ignores invalid source', async () => {
    const kv = createMemoryKV();
    const botToken = '123456:CHAT_SRC_SECRET';
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '999001',
    });
    await savePanelConfig(env, {
      pmBot: { enableVerification: true, verificationMode: 'emoji', enableCasCheck: false },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 701 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    try {
      const guest1Init = await signInitData(
        { user: JSON.stringify({ id: 50401, first_name: 'PosterUser' }), auth_date: Math.floor(Date.now() / 1000) },
        botToken
      );
      const res1 = await worker.fetch(
        new Request('https://panel.test/api/chat/start', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': guest1Init, 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'poster' }),
        }),
        env
      );
      expect(res1.status).toBe(200);
      expect(await kv.get('src:50401')).toBe('poster');

      const guest2Init = await signInitData(
        { user: JSON.stringify({ id: 50402, first_name: 'BadSrcUser' }), auth_date: Math.floor(Date.now() / 1000) },
        botToken
      );
      const res2 = await worker.fetch(
        new Request('https://panel.test/api/chat/start', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': guest2Init, 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'BAD <SCRIPT>' }),
        }),
        env
      );
      expect(res2.status).toBe(200);
      expect(await kv.get('src:50402')).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('renders visitor card source with built-in label or HTML-escaped custom channel name', () => {
    const baseDetail = {
      userId: '50501',
      displayName: 'Carol',
      username: 'carol',
      status: 'verified',
      msg_count: 1,
      visitor_msg_count: 1,
      admin_msg_count: 0,
      photo_count: 0,
      link_count: 0,
    };

    const posterCard = buildVisitorCardText({ ...baseDetail, source: 'poster' });
    expect(posterCard).toContain('• 来源：分享海报');

    const customCard = buildVisitorCardText({ ...baseDetail, source: 'nodeseek' });
    expect(customCard).toContain('• 来源：nodeseek');

    const xssCard = buildVisitorCardText({ ...baseDetail, source: 'a<script>"x"</script>' });
    expect(xssCard).not.toContain('<script>');
    expect(xssCard).toContain('• 来源：a&lt;script&gt;&quot;x&quot;&lt;/script&gt;');

    const noSourceCard = buildVisitorCardText({ ...baseDetail, source: '' });
    expect(noSourceCard).not.toContain('• 来源：');
  });

  it('computes source stats on the fly with legacy visitors grouped under 未知 and zero KV writes on read', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, ADMIN_IDS: '999001' });

    await rememberPendingSource(env, '60101', 'poster');
    await upsertVisitorProfile(env, { id: 60101, first_name: 'U1' }, { incrementMsg: true });
    await rememberPendingSource(env, '60102', 'poster');
    await upsertVisitorProfile(env, { id: 60102, first_name: 'U2' }, { incrementMsg: true });
    await rememberPendingSource(env, '60103', 'nodeseek');
    await upsertVisitorProfile(env, { id: 60103, first_name: 'U3' }, { incrementMsg: true });
    // Legacy visitor without any source
    await upsertVisitorProfile(env, { id: 60104, first_name: 'Legacy' }, { incrementMsg: true });

    // Warm one-time migration flags & summary cache
    const firstList = await listVisitors(env);
    expect(firstList.sourceStats).toEqual([
      { source: 'poster', label: '分享海报', count: 2 },
      { source: 'nodeseek', label: 'nodeseek', count: 1 },
      { source: '', label: '未知', count: 1 },
    ]);

    // Subsequent reads of listVisitors, getVisitorOverview, and computeSourceStats must produce ZERO KV writes
    const putSpy = vi.spyOn(kv, 'put');
    const secondList = await listVisitors(env);
    const overview = await getVisitorOverview(env);
    const directStats = computeSourceStats(secondList.items);

    expect(putSpy).not.toHaveBeenCalled();
    expect(secondList.sourceStats).toEqual(firstList.sourceStats);
    expect(overview.sourceStats).toEqual(firstList.sourceStats);
    expect(overview.recent.some((v) => v.userId === '60101' && v.source === 'poster')).toBe(true);
    expect(directStats).toEqual(firstList.sourceStats);
  });

  it('builds source links correctly for bot, app, and web kinds and uses & when query already exists', () => {
    for (const fn of [buildSourceLink, buildClientSourceLink]) {
      expect(fn('https://t.me/mybot', 'site', 'bot')).toBe('https://t.me/mybot?start=src_site');
      expect(fn('https://t.me/mybot', 'src_site', 'bot')).toBe('https://t.me/mybot?start=src_site');
      expect(fn('https://t.me/mybot/panel', 'poster', 'app')).toBe('https://t.me/mybot/panel?startapp=src_poster');
      expect(fn('https://example.com/', 'link', 'web')).toBe('https://example.com/?src=link');

      // Preserves existing query string with `&`
      expect(fn('https://t.me/mybot?ref=1', 'channel', 'bot')).toBe('https://t.me/mybot?ref=1&start=src_channel');
      expect(fn('https://t.me/mybot/panel?foo=bar', 'link', 'app')).toBe('https://t.me/mybot/panel?foo=bar&startapp=src_link');
      expect(fn('https://example.com/?tab=profile', 'poster', 'web')).toBe('https://example.com/?tab=profile&src=poster');

      // Invalid source returns base untouched
      expect(fn('https://t.me/mybot', 'INVALID!', 'bot')).toBe('https://t.me/mybot');
    }
  });
});

describe('Monthly unique visitor counter (v1.8)', () => {
  it('counts a returning visitor once per month and performs zero KV writes on repeat opens', async () => {
    const kv = createMemoryKV();
    const botToken = '123456:VISIT_SECRET';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '900001' });

    const visitorInit = await signInitData(
      { user: JSON.stringify({ id: 70001, first_name: 'Alice' }), auth_date: Math.floor(Date.now() / 1000) },
      botToken
    );

    const putSpy = vi.spyOn(kv, 'put');

    // Open #1 -> writes visit:seen:* and visit:count:* (2 writes)
    const r1 = await worker.fetch(
      new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': visitorInit } }),
      env
    );
    expect(r1.status).toBe(200);
    expect(putSpy).toHaveBeenCalledTimes(2);

    // Verify TTLs on both KV keys
    const seenCall = putSpy.mock.calls.find(([k]) => k.startsWith('visit:seen:'));
    const countCall = putSpy.mock.calls.find(([k]) => k.startsWith('visit:count:'));
    expect(seenCall?.[2]).toEqual({ expirationTtl: VISIT_SEEN_TTL_SECONDS });
    expect(countCall?.[2]).toEqual({ expirationTtl: VISIT_COUNT_TTL_SECONDS });

    // Opens #2 & #3 -> ZERO KV writes
    putSpy.mockClear();
    const r2 = await worker.fetch(
      new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': visitorInit } }),
      env
    );
    const r3 = await worker.fetch(
      new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': visitorInit } }),
      env
    );
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(putSpy).not.toHaveBeenCalled();

    const stats = await getVisitStats(env);
    expect(stats.thisMonth).toBe(1);
  });

  it('counts two distinct Telegram visitors as 2 and ignores admin, preview, and anonymous web visits', async () => {
    const kv = createMemoryKV();
    const botToken = '123456:VISIT_MULTI';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '900001', DEV_PREVIEW: 'true' });

    const u1Init = await signInitData(
      { user: JSON.stringify({ id: 71001, first_name: 'One' }), auth_date: Math.floor(Date.now() / 1000) },
      botToken
    );
    const u2Init = await signInitData(
      { user: JSON.stringify({ id: 71002, first_name: 'Two' }), auth_date: Math.floor(Date.now() / 1000) },
      botToken
    );
    const adminInit = await signInitData(
      { user: JSON.stringify({ id: 900001, first_name: 'Owner' }), auth_date: Math.floor(Date.now() / 1000) },
      botToken
    );

    // 2 real Telegram visitors
    await worker.fetch(
      new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': u1Init } }),
      env
    );
    await worker.fetch(
      new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': u2Init } }),
      env
    );
    expect((await getVisitStats(env)).thisMonth).toBe(2);

    // Admin, local preview (guest & admin), and anonymous web visits must NOT increment count
    await worker.fetch(
      new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': adminInit } }),
      env
    );
    await worker.fetch(
      new Request('http://localhost:8787/api/bootstrap', { headers: { 'X-Dev-Role': 'guest' } }),
      env
    );
    await worker.fetch(
      new Request('http://localhost:8787/api/bootstrap', { headers: { 'X-Dev-Role': 'admin' } }),
      env
    );
    await worker.fetch(new Request('https://panel.test/api/bootstrap'), env);

    expect((await getVisitStats(env)).thisMonth).toBe(2);
  });

  it('calculates month rollover using owner timezoneOffsetHours and exposes lastMonth accurately', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv });
    const cfg = { community: { timezoneOffsetHours: 8 } };

    // UTC 2026-01-31 15:30 = UTC+8 2026-01-31 23:30 -> January (202601)
    const janDate = new Date('2026-01-31T15:30:00Z');
    expect(getMonthKeys(janDate, 8)).toEqual({ thisMonthKey: '202601', lastMonthKey: '202512' });
    await recordMonthlyVisit(env, '72001', cfg, janDate);
    await recordMonthlyVisit(env, '72002', cfg, janDate);

    // UTC 2026-01-31 16:30 = UTC+8 2026-02-01 00:30 -> February (202602)
    const febDate = new Date('2026-01-31T16:30:00Z');
    expect(getMonthKeys(febDate, 8)).toEqual({ thisMonthKey: '202602', lastMonthKey: '202601' });

    // Before anyone opens in Feb: thisMonth is 0, lastMonth is 2
    expect(await getVisitStats(env, cfg, febDate)).toEqual({ thisMonth: 0, lastMonth: 2 });

    // Same user opening in Feb counts as 1 for Feb without touching Jan
    await recordMonthlyVisit(env, '72001', cfg, febDate);
    expect(await getVisitStats(env, cfg, febDate)).toEqual({ thisMonth: 1, lastMonth: 2 });
  });

  it('fails open on KV write errors so /api/bootstrap still succeeds normally', async () => {
    const kv = createMemoryKV();
    const botToken = '123456:VISIT_FAILOPEN';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '900001' });

    vi.spyOn(kv, 'put').mockRejectedValue(new Error('KV daily write quota exceeded'));

    const guestInit = await signInitData(
      { user: JSON.stringify({ id: 73001, first_name: 'QuotaTest' }), auth_date: Math.floor(Date.now() / 1000) },
      botToken
    );
    const res = await worker.fetch(
      new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': guestInit } }),
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('hides visitStats when showVisitCounter is false, exposes only thisMonth when true, and always gives admin both numbers', async () => {
    const kv = createMemoryKV();
    const botToken = '123456:VISIT_VISIBILITY';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '900001' });

    const cfgDefault = await loadPanelConfig(env);
    expect(cfgDefault.profile.showVisitCounter).toBe(false);

    // Seed this month + last month totals
    const { thisMonthKey, lastMonthKey } = getMonthKeys(new Date(), cfgDefault.community.timezoneOffsetHours);
    await kv.put(`visit:count:${thisMonthKey}`, JSON.stringify({ n: 42 }));
    await kv.put(`visit:count:${lastMonthKey}`, JSON.stringify({ n: 31 }));

    const guestInit = await signInitData(
      { user: JSON.stringify({ id: 74001, first_name: 'Viewer' }), auth_date: Math.floor(Date.now() / 1000) },
      botToken
    );
    const adminInit = await signInitData(
      { user: JSON.stringify({ id: 900001, first_name: 'Owner' }), auth_date: Math.floor(Date.now() / 1000) },
      botToken
    );

    // 1. showVisitCounter === false (default)
    const guestOff = await (
      await worker.fetch(
        new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': guestInit } }),
        env
      )
    ).json();
    expect('visitStats' in guestOff.config).toBe(false);
    expect('visitStats' in guestOff).toBe(false);

    const adminOff = await (
      await worker.fetch(
        new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': adminInit } }),
        env
      )
    ).json();
    expect('visitStats' in adminOff.config).toBe(false);
    expect(adminOff.visitStats).toEqual({ thisMonth: 43, lastMonth: 31 }); // 42 seeded + guest 74001

    // 2. showVisitCounter === true -> public config exposes ONLY thisMonth (never lastMonth)
    await savePanelConfig(env, { profile: { showVisitCounter: true } });

    const guestOn = await (
      await worker.fetch(
        new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': guestInit } }),
        env
      )
    ).json();
    expect(guestOn.config.visitStats).toEqual({ thisMonth: 43 });
    expect('lastMonth' in guestOn.config.visitStats).toBe(false);
    expect('visitStats' in guestOn).toBe(false);

    const adminOn = await (
      await worker.fetch(
        new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': adminInit } }),
        env
      )
    ).json();
    expect(adminOn.config.visitStats).toEqual({ thisMonth: 43 });
    expect(adminOn.visitStats).toEqual({ thisMonth: 43, lastMonth: 31 });
  });
});

describe('Card footer signature & Get-Same-Card config (v1.8)', () => {
  it('defaults showPoweredBy to true in public config', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv });
    const cfg = await loadPanelConfig(env);
    expect(cfg.profile.showPoweredBy).toBe(true);

    const pub = sanitizePublicConfig(cfg, env, false);
    expect(pub.profile.showPoweredBy).toBe(true);
  });

  it('persists showPoweredBy: false and normalizes non-boolean values to strict booleans', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv });

    // Disable explicitly
    await savePanelConfig(env, { profile: { showPoweredBy: false } });
    let loaded = await loadPanelConfig(env);
    expect(loaded.profile.showPoweredBy).toBe(false);
    expect(sanitizePublicConfig(loaded, env, false).profile.showPoweredBy).toBe(false);

    // Subsequent unrelated profile edit preserves showPoweredBy: false
    await savePanelConfig(env, { profile: { displayName: 'KeepHidden' } });
    loaded = await loadPanelConfig(env);
    expect(loaded.profile.showPoweredBy).toBe(false);

    // Non-boolean truthy value normalizes to boolean true
    await savePanelConfig(env, { profile: { showPoweredBy: 'yes' } });
    loaded = await loadPanelConfig(env);
    expect(loaded.profile.showPoweredBy).toBe(true);
    expect(typeof sanitizePublicConfig(loaded, env, false).profile.showPoweredBy).toBe('boolean');

    // Non-boolean falsy values (0, '', null) normalize to boolean false
    for (const raw of [0, '', null]) {
      await savePanelConfig(env, { profile: { showPoweredBy: raw } });
      loaded = await loadPanelConfig(env);
      expect(loaded.profile.showPoweredBy).toBe(false);
      expect(sanitizePublicConfig(loaded, env, false).profile.showPoweredBy).toBe(false);
    }
  });

  it('defaults showPoweredBy to true when loading legacy KV config without the field', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv });
    await kv.put(
      'config:panel',
      JSON.stringify({
        profile: {
          displayName: 'LegacyCard',
          tagline: 'From v1.7',
        },
      })
    );

    const loaded = await loadPanelConfig(env);
    expect(loaded.profile.displayName).toBe('LegacyCard');
    expect(loaded.profile.showPoweredBy).toBe(true);
    expect(sanitizePublicConfig(loaded, env, false).profile.showPoweredBy).toBe(true);
  });
});

describe('Bidirectional Telegram reaction sync & panel display (v1.9)', () => {
  function mockTgForReactions(handler = null) {
    const calls = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      const method = String(url).split('/').pop();
      const body = opts?.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
      calls.push({ method, body });
      if (handler) {
        const custom = await handler(method, body, calls);
        if (custom) return custom;
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 800 + calls.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return { calls, restore: () => fetchSpy.mockRestore() };
  }

  it('registers message_reaction in /setup allowed_updates using WEBHOOK_ALLOWED_UPDATES', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: '123456:SETUP_REACT',
      WEBHOOK_SECRET: 'setup-secret-123',
      ADMIN_IDS: '10001',
    });
    const tg = mockTgForReactions();
    try {
      const res = await worker.fetch(new Request('https://panel.test/setup?secret=setup-secret-123'), env);
      expect(res.status).toBe(200);
      const setWebhookCall = tg.calls.find((c) => c.method === 'setWebhook');
      expect(setWebhookCall).toBeTruthy();
      expect(setWebhookCall.body.allowed_updates).toEqual(WEBHOOK_ALLOWED_UPDATES);
      expect(setWebhookCall.body.allowed_updates).toContain('message_reaction');
      expect(setWebhookCall.body.secret_token).toBe('setup-secret-123');
      expect(await kv.get(WEBHOOK_UPDATES_REV_KEY)).toBe(WEBHOOK_UPDATES_REV);
    } finally {
      tg.restore();
    }
  });

  it('auto-upgrades old Webhook on settings save when WEBHOOK_SECRET is set, skips when already present or missing secret, and respects webhook:updates_rev', async () => {
    // 1. Missing message_reaction + WEBHOOK_SECRET set -> resets with SAME url & secret_token
    {
      const kv = createMemoryKV();
      const env = makeEnv({
        TOPIC_MAP: kv,
        BOT_TOKEN: '123456:AUTO_UPGRADE',
        WEBHOOK_SECRET: 'sec-keep-me',
        ADMIN_IDS: '10001',
      });
      const tg = mockTgForReactions((method) => {
        if (method === 'getWebhookInfo') {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                url: 'https://custom-old.example.com/webhook',
                allowed_updates: ['message', 'edited_message', 'callback_query'],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return null;
      });
      try {
        await syncTelegramBotSurface(env, 'https://panel.test', null, { persistUsername: false });
        const setCalls = tg.calls.filter((c) => c.method === 'setWebhook');
        expect(setCalls).toHaveLength(1);
        expect(setCalls[0].body.url).toBe('https://custom-old.example.com/webhook');
        expect(setCalls[0].body.secret_token).toBe('sec-keep-me');
        expect(setCalls[0].body.allowed_updates).toEqual(WEBHOOK_ALLOWED_UPDATES);
        expect(await kv.get(WEBHOOK_UPDATES_REV_KEY)).toBe(WEBHOOK_UPDATES_REV);

        // Once webhook:updates_rev is set, subsequent calls NEVER call getWebhookInfo again
        tg.calls.length = 0;
        const second = await ensureWebhookReactionSubscription(env);
        expect(second.skipped).toBe(true);
        expect(tg.calls.filter((c) => c.method === 'getWebhookInfo')).toHaveLength(0);
        expect(tg.calls.filter((c) => c.method === 'setWebhook')).toHaveLength(0);
      } finally {
        tg.restore();
      }
    }

    // 2. Webhook already contains message_reaction -> does NOT call setWebhook, still records rev
    {
      const kv = createMemoryKV();
      const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:ALREADY_OK', WEBHOOK_SECRET: 'sec-1', ADMIN_IDS: '10001' });
      const tg = mockTgForReactions((method) => {
        if (method === 'getWebhookInfo') {
          return new Response(
            JSON.stringify({
              ok: true,
              result: { url: 'https://panel.test/webhook', allowed_updates: WEBHOOK_ALLOWED_UPDATES },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return null;
      });
      try {
        const res = await ensureWebhookReactionSubscription(env);
        expect(res.ok).toBe(true);
        expect(res.updated).toBe(false);
        expect(tg.calls.filter((c) => c.method === 'setWebhook')).toHaveLength(0);
        expect(await kv.get(WEBHOOK_UPDATES_REV_KEY)).toBe(WEBHOOK_UPDATES_REV);
      } finally {
        tg.restore();
      }
    }

    // 3. No WEBHOOK_SECRET -> NEVER calls setWebhook or getWebhookInfo, and exposes webhookNeedsResync to admin
    {
      const kv = createMemoryKV();
      const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:NO_SECRET', ADMIN_IDS: '10001' });
      const tg = mockTgForReactions();
      try {
        const res = await ensureWebhookReactionSubscription(env);
        expect(res.skipped).toBe(true);
        expect(res.reason).toBe('no_webhook_secret');
        expect(tg.calls).toHaveLength(0);
        expect(await kv.get(WEBHOOK_UPDATES_REV_KEY)).toBeNull();

        const adminInit = await signInitData(
          { user: JSON.stringify({ id: 10001, first_name: 'Owner' }), auth_date: Math.floor(Date.now() / 1000) },
          env.BOT_TOKEN
        );
        const cfgRes = await worker.fetch(
          new Request('https://panel.test/api/admin/config', {
            headers: { 'X-Telegram-Init-Data': adminInit },
          }),
          env
        );
        const cfgJson = await cfgRes.json();
        expect(cfgJson.config.webhookNeedsResync).toBe(true);
      } finally {
        tg.restore();
      }
    }
  });

  it('Direction A: syncs visitor reactions on topic reply, panel reply mirror, dm reply, own message, and clears on removal', async () => {
    const kv = createMemoryKV();
    const botToken = '123456:DIR_A';
    const topicEnv = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100777888',
    });
    const uid = '30001';
    await kv.put(
      `history:${uid}`,
      JSON.stringify({
        photos: [],
        links: [],
        pmMessageIds: [
          { id: 101, sender: 'admin', topicMsgId: 901, topicChatId: '-100777888', at: Date.now() }, // direct topic reply
          { id: 102, sender: 'admin', topicMsgId: 902, topicChatId: '-100777888', at: Date.now() }, // panel reply mirror
          { id: 103, sender: 'visitor', topicMsgId: 103, topicCopyId: 903, topicThreadId: 55, topicChatId: '-100777888', at: Date.now() }, // visitor own msg
        ],
        messages: [
          { id: 'm1', sender: 'admin', text: '话题回复', pmMessageId: 101, topicMsgId: 901, at: new Date().toISOString() },
          { id: 'm2', sender: 'admin', text: '面板回复', pmMessageId: 102, topicMsgId: 902, at: new Date().toISOString() },
          { id: 'm3', sender: 'visitor', text: '访客消息', pmMessageId: 103, topicMsgId: 103, at: new Date().toISOString() },
        ],
      })
    );

    const tg = mockTgForReactions();
    try {
      // React to topic reply (101 -> group -100777888 msg 901) with multiple emojis -> uses LAST emoji
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30001, type: 'private' },
            message_id: 101,
            user: { id: 30001, first_name: 'Alice' },
            date: 1700000001,
            old_reaction: [],
            new_reaction: [
              { type: 'emoji', emoji: '👍' },
              { type: 'emoji', emoji: '❤️' },
            ],
          },
        },
        topicEnv,
        'https://panel.test'
      );

      // React to panel reply mirror (102 -> group -100777888 msg 902)
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30001, type: 'private' },
            message_id: 102,
            user: { id: 30001, first_name: 'Alice' },
            date: 1700000002,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '🔥' }],
          },
        },
        topicEnv,
        'https://panel.test'
      );

      // React to visitor's own message (103 -> group -100777888 topicCopyId 903)
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30001, type: 'private' },
            message_id: 103,
            user: { id: 30001, first_name: 'Alice' },
            date: 1700000003,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '🎉' }],
          },
        },
        topicEnv,
        'https://panel.test'
      );

      const reactCalls = tg.calls.filter((c) => c.method === 'setMessageReaction');
      expect(reactCalls).toHaveLength(3);
      expect(reactCalls[0].body).toEqual({
        chat_id: -100777888,
        message_id: 901,
        reaction: [{ type: 'emoji', emoji: '❤️' }],
      });
      expect(reactCalls[1].body).toEqual({
        chat_id: -100777888,
        message_id: 902,
        reaction: [{ type: 'emoji', emoji: '🔥' }],
      });
      expect(reactCalls[2].body).toEqual({
        chat_id: -100777888,
        message_id: 903,
        reaction: [{ type: 'emoji', emoji: '🎉' }],
      });

      // Remove reaction on 101 -> sends reaction: [] and clears visitorReaction in history
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30001, type: 'private' },
            message_id: 101,
            user: { id: 30001, first_name: 'Alice' },
            date: 1700000004,
            old_reaction: [{ type: 'emoji', emoji: '❤️' }],
            new_reaction: [],
          },
        },
        topicEnv,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toEqual([
        { method: 'setMessageReaction', body: { chat_id: -100777888, message_id: 901, reaction: [] } },
      ]);
      const histAfterClear = await getVisitorHistory(topicEnv, uid);
      expect(histAfterClear.messages.find((m) => m.pmMessageId === 101)?.visitorReaction).toBeUndefined();
      expect(histAfterClear.messages.find((m) => m.pmMessageId === 102)?.visitorReaction).toBe('🔥');

      // DM mode: visitor reacts to owner DM reply (dmMsgId) and own message (dmCopyId)
      const dmEnv = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' });
      await kv.put(
        'history:30002',
        JSON.stringify({
          photos: [],
          links: [],
          pmMessageIds: [
            { id: 201, sender: 'admin', topicMsgId: null, dmMsgId: 601, at: Date.now() },
            { id: 202, sender: 'visitor', topicMsgId: null, dmCopyId: 602, at: Date.now() },
          ],
          messages: [
            { id: 'dm1', sender: 'admin', text: '私聊回复', pmMessageId: 201, at: new Date().toISOString() },
            { id: 'dm2', sender: 'visitor', text: '我的消息', pmMessageId: 202, at: new Date().toISOString() },
          ],
        })
      );
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30002, type: 'private' },
            message_id: 201,
            user: { id: 30002, first_name: 'Bob' },
            date: 1700000005,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '👍' }],
          },
        },
        dmEnv,
        'https://panel.test'
      );
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30002, type: 'private' },
            message_id: 202,
            user: { id: 30002, first_name: 'Bob' },
            date: 1700000006,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '👏' }],
          },
        },
        dmEnv,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toEqual([
        { method: 'setMessageReaction', body: { chat_id: 10001, message_id: 601, reaction: [{ type: 'emoji', emoji: '👍' }] } },
        { method: 'setMessageReaction', body: { chat_id: 10001, message_id: 602, reaction: [{ type: 'emoji', emoji: '👏' }] } },
      ]);
    } finally {
      tg.restore();
    }
  });

  it('Direction A: does nothing and calls zero Telegram APIs when mapping is missing', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:MISSING_MAP', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777888' });
    await kv.put(
      'history:30003',
      JSON.stringify({
        photos: [],
        links: [],
        pmMessageIds: [
          // Legacy visitor message without topicCopyId must NOT fall back to topicMsgId
          { id: 301, sender: 'visitor', topicMsgId: 301, at: Date.now() },
        ],
        messages: [{ id: 'old1', sender: 'visitor', text: 'old', pmMessageId: 301, at: new Date().toISOString() }],
      })
    );

    const tg = mockTgForReactions();
    try {
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30003, type: 'private' },
            message_id: 99999,
            user: { id: 30003, first_name: 'Ghost' },
            date: 1700000010,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '👍' }],
          },
        },
        env,
        'https://panel.test'
      );
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30003, type: 'private' },
            message_id: 301,
            user: { id: 30003, first_name: 'Ghost' },
            date: 1700000011,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '👍' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toHaveLength(0);
    } finally {
      tg.restore();
    }
  });

  it('Direction B (Topic mode): writes tmsg:* with 30d TTL, syncs admin reactions to visitor, ignores non-admins and admin-own messages', async () => {
    const kv = createMemoryKV();
    const botToken = '123456:DIR_B_TOPIC';
    const env = makeEnv({
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100777888',
    });
    await kv.put('verified:30010', 'emoji:v1');

    let nextId = 700;
    const tg = mockTgForReactions((method) => {
      if (method === 'createForumTopic') {
        return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 42 } }), { status: 200 });
      }
      if (method === 'getChatMember') {
        return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }), { status: 200 });
      }
      nextId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextId } }), { status: 200 });
    });

    const putSpy = vi.spyOn(kv, 'put');
    try {
      // 1. Visitor sends message 55 -> copied into topic as topicMsgId -> writes tmsg:{topicMsgId} with 30d TTL
      await handleTelegramUpdate(
        {
          message: {
            message_id: 55,
            from: { id: 30010, first_name: 'VisitorT' },
            chat: { id: 30010, type: 'private' },
            text: '你好呀',
          },
        },
        env,
        'https://panel.test'
      );

      const tmsgPut = putSpy.mock.calls.find(([k]) => k.startsWith(TOPIC_MSG_MAP_PREFIX));
      let topicCopyId;
      if (storageMode === 'kv') {
        expect(tmsgPut).toBeTruthy();
        expect(JSON.parse(tmsgPut[1])).toEqual({ g: '-100777888', u: '30010', p: 55 });
        expect(tmsgPut[2]).toEqual({ expirationTtl: TOPIC_MSG_MAP_TTL_SECONDS });
        topicCopyId = Number(tmsgPut[0].slice(TOPIC_MSG_MAP_PREFIX.length));
      } else {
        expect(tmsgPut).toBeUndefined();
        const tmsgRow = await env.DB.prepare(
          `SELECT group_id, topic_msg_id, uid, pm_message_id FROM topic_map WHERE group_id = '-100777888' AND uid = '30010'`
        ).first();
        expect(tmsgRow).toBeTruthy();
        expect(tmsgRow.pm_message_id).toBe(55);
        topicCopyId = Number(tmsgRow.topic_msg_id);
      }

      // 2. Non-admin reacts to topic copy -> ignored
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: -100777888, type: 'supergroup' },
            message_id: topicCopyId,
            user: { id: 88888, first_name: 'NotAdmin' },
            date: 1700000020,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '👍' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toHaveLength(0);

      // 3. Admin reacts to an unmapped message (e.g. admin's own reply or panel mirror) -> ignored
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: -100777888, type: 'supergroup' },
            message_id: 999999,
            user: { id: 10001, first_name: 'Owner' },
            date: 1700000021,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '👍' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toHaveLength(0);

      // 4. Admin reacts to visitor's topic copy -> syncs to visitor chat 30010 msg 55 & stores ownerReaction
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: -100777888, type: 'supergroup' },
            message_id: topicCopyId,
            user: { id: 10001, first_name: 'Owner' },
            date: 1700000022,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '👍' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toEqual([
        { method: 'setMessageReaction', body: { chat_id: 30010, message_id: 55, reaction: [{ type: 'emoji', emoji: '👍' }] } },
      ]);

      // History API returns ownerReaction
      const adminInit = await signInitData(
        { user: JSON.stringify({ id: 10001, first_name: 'Owner' }), auth_date: Math.floor(Date.now() / 1000) },
        botToken
      );
      const histRes = await worker.fetch(
        new Request('https://panel.test/api/admin/visitors/30010/history', {
          headers: { 'X-Telegram-Init-Data': adminInit },
        }),
        env
      );
      const histJson = await histRes.json();
      expect(histJson.ok).toBe(true);
      expect(histJson.messages.find((m) => m.pmMessageId === 55)?.ownerReaction).toBe('👍');
    } finally {
      tg.restore();
    }
  });

  it('Direction B (DM mode): syncs owner reactions on visitor copy, skips legacy plain-uid dmmap without error', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:DIR_B_DM', ADMIN_IDS: '10001' });
    await kv.put(`${DM_MAP_PREFIX}501`, '30020'); // legacy plain uid (or header card)
    await kv.put(`${DM_MAP_PREFIX}502`, JSON.stringify({ u: '30020', p: 77 }));
    await kv.put(
      'history:30020',
      JSON.stringify({
        photos: [],
        links: [],
        pmMessageIds: [{ id: 77, sender: 'visitor', topicMsgId: null, dmCopyId: 502, at: Date.now() }],
        messages: [{ id: 'm77', sender: 'visitor', text: 'DM 访客消息', pmMessageId: 77, at: new Date().toISOString() }],
      })
    );

    const tg = mockTgForReactions();
    try {
      // Legacy plain uid -> skip silently
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 10001, type: 'private' },
            message_id: 501,
            user: { id: 10001, first_name: 'Owner' },
            date: 1700000030,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '👍' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toHaveLength(0);

      // JSON dmmap entry with p -> syncs to visitor chat 30020 msg 77
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 10001, type: 'private' },
            message_id: 502,
            user: { id: 10001, first_name: 'Owner' },
            date: 1700000031,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '🥰' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toEqual([
        { method: 'setMessageReaction', body: { chat_id: 30020, message_id: 77, reaction: [{ type: 'emoji', emoji: '🥰' }] } },
      ]);
      const hist = await getVisitorHistory(env, '30020');
      expect(hist.messages[0].ownerReaction).toBe('🥰');
    } finally {
      tg.restore();
    }
  });

  it('handles custom_emoji and paid reactions by clearing bot reaction and storing ✨ in panel, and swallows setMessageReaction errors', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:SPECIAL_REACT', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777888' });
    await kv.put(
      'history:30030',
      JSON.stringify({
        photos: [],
        links: [],
        pmMessageIds: [
          { id: 81, sender: 'admin', topicMsgId: 981, topicChatId: '-100777888', at: Date.now() },
          { id: 82, sender: 'admin', topicMsgId: 982, topicChatId: '-100777888', at: Date.now() },
        ],
        messages: [
          { id: 'm81', sender: 'admin', text: 'msg1', pmMessageId: 81, at: new Date().toISOString() },
          { id: 'm82', sender: 'admin', text: 'msg2', pmMessageId: 82, at: new Date().toISOString() },
        ],
      })
    );

    const tg = mockTgForReactions((method, body) => {
      if (method === 'setMessageReaction' && body.message_id === 982) {
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: REACTION_INVALID' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return null;
    });

    try {
      // Custom emoji -> clears bot reaction ([]) and stores '✨'
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30030, type: 'private' },
            message_id: 81,
            user: { id: 30030, first_name: 'PremiumUser' },
            date: 1700000040,
            old_reaction: [],
            new_reaction: [{ type: 'custom_emoji', custom_emoji_id: '5368324170671202286' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toEqual([
        { method: 'setMessageReaction', body: { chat_id: -100777888, message_id: 981, reaction: [] } },
      ]);
      expect((await getVisitorHistory(env, '30030')).messages.find((m) => m.pmMessageId === 81)?.visitorReaction).toBe('✨');

      // Paid reaction + Telegram REACTION_INVALID failure -> does NOT throw, still stores '✨'
      await expect(
        handleTelegramUpdate(
          {
            message_reaction: {
              chat: { id: 30030, type: 'private' },
              message_id: 82,
              user: { id: 30030, first_name: 'PremiumUser' },
              date: 1700000041,
              old_reaction: [],
              new_reaction: [{ type: 'paid' }],
            },
          },
          env,
          'https://panel.test'
        )
      ).resolves.toBeUndefined();
      expect((await getVisitorHistory(env, '30030')).messages.find((m) => m.pmMessageId === 82)?.visitorReaction).toBe('✨');
    } finally {
      tg.restore();
    }
  });

  it('ignores topic message mappings from a previously bound group in both directions', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:REBIND_REACT', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100222' });
    // Recorded while group -100111 was bound; owner has since rebound to -100222
    await kv.put(
      'history:30040',
      JSON.stringify({
        photos: [],
        links: [],
        pmMessageIds: [
          { id: 401, sender: 'admin', topicMsgId: 57, topicChatId: '-100111', at: Date.now() },
          { id: 402, sender: 'visitor', topicMsgId: 402, topicCopyId: 58, topicThreadId: 9, topicChatId: '-100111', at: Date.now() },
        ],
        messages: [
          { id: 'a1', sender: 'admin', text: 'old reply', pmMessageId: 401, at: new Date().toISOString() },
          { id: 'v1', sender: 'visitor', text: 'old msg', pmMessageId: 402, at: new Date().toISOString() },
        ],
      })
    );
    await kv.put(`${TOPIC_MSG_MAP_PREFIX}58`, JSON.stringify({ g: '-100111', u: '30040', p: 402 }));

    const tg = mockTgForReactions();
    try {
      // Direction A: visitor reacts to the old admin reply -> no reaction in the new group, panel still updated
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: 30040, type: 'private' },
            message_id: 401,
            user: { id: 30040, first_name: 'Rebind' },
            date: 1700000100,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '👍' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toHaveLength(0);
      const hist = await getVisitorHistory(env, '30040');
      expect(hist.messages.find((m) => m.id === 'a1').visitorReaction).toBe('👍');

      // Direction B: admin reacts to message 58 in the NEW group -> old mapping must not hit visitor 30040
      await handleTelegramUpdate(
        {
          message_reaction: {
            chat: { id: -100222, type: 'supergroup' },
            message_id: 58,
            user: { id: 10001, first_name: 'Owner' },
            date: 1700000101,
            old_reaction: [],
            new_reaction: [{ type: 'emoji', emoji: '❤' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toHaveLength(0);
    } finally {
      tg.restore();
    }
  });

  it('caps how many reactions per minute a visitor can sync', async () => {
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:REACT_LIMIT', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777888' });
    await kv.put(
      'history:30050',
      JSON.stringify({
        photos: [],
        links: [],
        pmMessageIds: [{ id: 501, sender: 'admin', topicMsgId: 951, topicChatId: '-100777888', at: Date.now() }],
        messages: [{ id: 'a1', sender: 'admin', text: 'hi', pmMessageId: 501, at: new Date().toISOString() }],
      })
    );
    const tg = mockTgForReactions();
    try {
      for (let i = 0; i < VISITOR_REACTION_LIMIT_PER_MIN + 3; i += 1) {
        await handleTelegramUpdate(
          {
            message_reaction: {
              chat: { id: 30050, type: 'private' },
              message_id: 501,
              user: { id: 30050, first_name: 'Spammy' },
              date: 1700000200 + i,
              old_reaction: [],
              new_reaction: i % 2 === 0 ? [{ type: 'emoji', emoji: '👍' }] : [],
            },
          },
          env,
          'https://panel.test'
        );
      }
      expect(tg.calls.filter((c) => c.method === 'setMessageReaction')).toHaveLength(VISITOR_REACTION_LIMIT_PER_MIN);
    } finally {
      tg.restore();
    }
  });
});

describe('Panel chat sticker rendering & signed media proxy (v1.9)', () => {
  it('records stickerFileId & stickerFormat (webp/webm/tgs), returns signed /api/media stickerUrl, and serves all 3 formats privately', async () => {
    const kv = createMemoryKV();
    const botToken = '123456:STICKER_CHAT_TOKEN';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' });
    const uid = '40001';

    await upsertVisitorProfile(env, { id: 40001, first_name: 'StickerFan' }, { incrementMsg: false });

    const webpId = 'CAACAgIAAxkBAAIB_webp_sticker_001';
    const webmId = 'CAACAgIAAxkBAAIB_webm_sticker_002';
    const tgsId = 'CAACAgIAAxkBAAIB_tgs_sticker_003';
    const adminStickerId = 'CAACAgIAAxkBAAIB_admin_sticker_004';

    await recordVisitorExchange(
      env,
      uid,
      { message_id: 1, sticker: { file_id: webpId, emoji: '😂', is_animated: false, is_video: false } },
      { sender: 'visitor', pmMessageId: 1 }
    );
    await recordVisitorExchange(
      env,
      uid,
      { message_id: 2, sticker: { file_id: webmId, emoji: '🔥', is_animated: false, is_video: true } },
      { sender: 'visitor', pmMessageId: 2 }
    );
    await recordVisitorExchange(
      env,
      uid,
      { message_id: 3, sticker: { file_id: tgsId, emoji: '🌸', is_animated: true, is_video: false } },
      { sender: 'visitor', pmMessageId: 3 }
    );
    await recordVisitorExchange(
      env,
      uid,
      { message_id: 4, sticker: { file_id: adminStickerId, emoji: '👍', is_animated: false, is_video: false } },
      { sender: 'admin', pmMessageId: 4 }
    );

    const rawHist = await getVisitorHistory(env, uid);
    expect(rawHist.messages).toHaveLength(4);
    expect(rawHist.messages[0]).toMatchObject({ stickerFileId: webpId, stickerFormat: 'webp', mediaTag: '[贴纸 😂]' });
    expect(rawHist.messages[1]).toMatchObject({ stickerFileId: webmId, stickerFormat: 'webm', mediaTag: '[贴纸 🔥]' });
    expect(rawHist.messages[2]).toMatchObject({ stickerFileId: tgsId, stickerFormat: 'tgs', mediaTag: '[贴纸 🌸]' });
    expect(rawHist.messages[3]).toMatchObject({
      sender: 'admin',
      stickerFileId: adminStickerId,
      stickerFormat: 'webp',
      mediaTag: '[贴纸 👍]',
    });

    // History API returns HMAC-signed /api/media/... URLs (NEVER public /api/sticker/...)
    const adminInit = await signInitData(
      { user: JSON.stringify({ id: 10001, first_name: 'Owner' }), auth_date: Math.floor(Date.now() / 1000) },
      botToken
    );
    const histRes = await worker.fetch(
      new Request(`https://panel.test/api/admin/visitors/${uid}/history`, {
        headers: { 'X-Telegram-Init-Data': adminInit },
      }),
      env
    );
    expect(histRes.status).toBe(200);
    const histJson = await histRes.json();
    expect(histJson.messages).toHaveLength(4);

    for (const [idx, expectedFormat, expectedId] of [
      [0, 'webp', webpId],
      [1, 'webm', webmId],
      [2, 'tgs', tgsId],
      [3, 'webp', adminStickerId],
    ]) {
      const m = histJson.messages[idx];
      expect(m.stickerFormat).toBe(expectedFormat);
      expect(m.stickerUrl).toMatch(/^\/api\/media\/[^?]+\?exp=\d+&sig=[0-9a-f]+$/);
      expect(m.stickerUrl).not.toContain('/api/sticker/');
      const u = new URL(`https://panel.test${m.stickerUrl}`);
      expect(await verifyMediaToken(expectedId, u.searchParams.get('exp'), u.searchParams.get('sig'), botToken)).toBe(
        true
      );
    }

    // Signed media proxy serves .tgs (gzip-decompressed Lottie JSON), .webm (video/webm), and .webp (image/webp) privately
    const sampleLottie = JSON.stringify({ v: '5.5.7', fr: 60, layers: [] });
    const gzippedTgsBytes = await new Response(
      new Blob([sampleLottie]).stream().pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/getFile')) {
        const body = JSON.parse(opts.body);
        const pathMap = {
          [webpId]: 'stickers/s1.webp',
          [webmId]: 'stickers/s2.webm',
          [tgsId]: 'stickers/s3.tgs',
        };
        return new Response(JSON.stringify({ ok: true, result: { file_path: pathMap[body.file_id] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.endsWith('stickers/s1.webp')) {
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { status: 200 });
      }
      if (urlStr.endsWith('stickers/s2.webm')) {
        return new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), { status: 200 });
      }
      if (urlStr.endsWith('stickers/s3.tgs')) {
        return new Response(gzippedTgsBytes, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    try {
      // 1. WebP
      const webpRes = await worker.fetch(new Request(`https://panel.test${histJson.messages[0].stickerUrl}`), env);
      expect(webpRes.status).toBe(200);
      expect(webpRes.headers.get('content-type')).toBe('image/webp');
      expect(webpRes.headers.get('cache-control')).toContain('private');

      // 2. WebM video sticker
      const webmRes = await worker.fetch(new Request(`https://panel.test${histJson.messages[1].stickerUrl}`), env);
      expect(webmRes.status).toBe(200);
      expect(webmRes.headers.get('content-type')).toBe('video/webm');
      expect(webmRes.headers.get('cache-control')).toContain('private');

      // 3. TGS animated Lottie sticker (auto-decompressed to JSON)
      const tgsRes = await worker.fetch(new Request(`https://panel.test${histJson.messages[2].stickerUrl}`), env);
      expect(tgsRes.status).toBe(200);
      expect(tgsRes.headers.get('content-type')).toContain('application/json');
      expect(tgsRes.headers.get('cache-control')).toContain('private');
      expect(await tgsRes.json()).toEqual({ v: '5.5.7', fr: 60, layers: [] });

      // 4. Tampered signature is rejected with 403
      const badRes = await worker.fetch(
        new Request(`https://panel.test/api/media/${encodeURIComponent(tgsId)}?exp=9999999999&sig=deadbeef`),
        env
      );
      expect(badRes.status).toBe(403);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('New visitor probation & pending message review (v1.10)', () => {
  function createTrackingKV() {
    const base = createMemoryKV();
    const putMeta = new Map();
    return {
      ...base,
      putMeta,
      async put(key, value, opts) {
        putMeta.set(key, opts || {});
        return base.put(key, value, opts);
      },
    };
  }

  function mockTelegramProbation() {
    const calls = [];
    let nextMsgId = 5000;
    let nextTopicId = 900;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ method, body });
      if (method === 'createForumTopic') {
        nextTopicId += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_thread_id: nextTopicId } }), { status: 200 });
      }
      if (method === 'copyMessage' || method === 'sendMessage' || method === 'editMessageText') {
        nextMsgId += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: nextMsgId } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    return { calls, restore: () => spy.mockRestore() };
  }

  it('starts probation on inline & Turnstile verification pass, skips trusted/admin/legacy visitors, and clears probation on trust', async () => {
    const kv = createTrackingKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:PROB_START', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100888999' });
    const tg = mockTelegramProbation();

    try {
      // 1. Inline emoji verification pass writes probation:{uid} with expirationTtl
      await kv.put(
        'chal:c_inline',
        JSON.stringify({
          mode: 'emoji',
          userId: '50001',
          correctIndex: 2,
          user: { id: 50001, first_name: 'Newbie' },
          pending: [],
        })
      );
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cq_p1',
            from: { id: 50001, first_name: 'Newbie' },
            data: 'v:c_inline:2',
            message: { message_id: 10, chat: { id: 50001, type: 'private' } },
          },
        },
        env,
        'https://panel.test'
      );
      const prob1 = await kv.get('probation:50001', 'json');
      expect(prob1).toBeTruthy();
      expect(prob1.left).toBe(3);
      expect(prob1.until).toBeGreaterThan(Date.now());
      expect(kv.putMeta.get('probation:50001')?.expirationTtl).toBe(24 * 3600);

      // 2. Turnstile verification pass writes probation:{uid}
      await kv.put(
        'chal:c_ts',
        JSON.stringify({
          mode: 'turnstile',
          userId: '50002',
          user: { id: 50002, first_name: 'TurnstileUser' },
          pending: [],
        })
      );
      const tsRes = await completeTurnstileVerification(env, 'https://panel.test', 'c_ts');
      expect(tsRes.ok).toBe(true);
      const prob2 = await kv.get('probation:50002', 'json');
      expect(prob2?.left).toBe(3);
      expect(kv.putMeta.get('probation:50002')?.expirationTtl).toBe(24 * 3600);

      // 3. Admin and permanently trusted visitor never get probation:{uid}
      await kv.put('verified:50003', 'trusted');
      expect(await startVisitorProbation(env, '10001')).toBeNull();
      expect(await kv.get('probation:10001')).toBeNull();
      expect(await startVisitorProbation(env, '50003')).toBeNull();
      expect(await kv.get('probation:50003')).toBeNull();

      // 4. Marking a visitor permanently trusted deletes their existing probation:{uid}
      await applyVisitorAction(env, '50001', 'trust');
      expect(await kv.get('probation:50001')).toBeNull();

      // 5. Legacy visitor (verified before v1.10, no probation:{uid} key) forwards links untouched
      await kv.put('verified:50004', 'emoji:v1');
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 401,
            from: { id: 50004, first_name: 'LegacyUser' },
            chat: { id: 50004, type: 'private' },
            text: '老朋友分享一个 https://example.org/post',
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.some((c) => c.method === 'copyMessage' && c.body.message_id === 401)).toBe(true);
      const legacyDetail = await getVisitorDetail(env, '50004');
      expect(legacyDetail.pendingReview).toEqual([]);
    } finally {
      tg.restore();
    }
  });

  it('holds suspicious messages during probation without forwarding, sends silent alert, and decrements/clears on clean messages', async () => {
    const kv = createTrackingKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:PROB_HOLD', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100888999' });
    const tg = mockTelegramProbation();

    try {
      await kv.put('verified:51001', 'emoji:v1');
      await kv.put('probation:51001', JSON.stringify({ left: 2, until: Date.now() + 3600 * 1000 }));

      // Suspicious cases: link, @username, phone, wechat, forwarded -> all held, ZERO copyMessage calls, left stays 2
      const suspiciousMsgs = [
        { message_id: 101, text: '快看 https://spam.example/deal <script>' },
        { message_id: 102, text: '找我 @promo_agent88' },
        { message_id: 103, text: '打电话 138-1234-5678 咨询' },
        { message_id: 104, text: '加我微信 wx_ad888999 领福利' },
        { message_id: 105, text: '转发一条活动', forward_origin: { type: 'channel' } },
      ];

      for (const m of suspiciousMsgs) {
        await handleTelegramUpdate(
          {
            message: {
              ...m,
              from: { id: 51001, first_name: 'Suspect' },
              chat: { id: 51001, type: 'private' },
            },
          },
          env,
          'https://panel.test'
        );
      }

      // NEVER forwarded any held message
      expect(tg.calls.filter((c) => c.method === 'copyMessage')).toHaveLength(0);

      // Left count was NOT decremented by held messages
      expect((await kv.get('probation:51001', 'json')).left).toBe(2);

      // Silent notification sent ONCE within 10 minutes with inline buttons & safe <code> URL escaping
      const reviewAlerts = tg.calls.filter(
        (c) => c.method === 'sendMessage' && String(c.body.text || '').includes('新访客消息待审核')
      );
      expect(reviewAlerts).toHaveLength(1);
      expect(reviewAlerts[0].body.disable_notification).toBe(true);
      expect(reviewAlerts[0].body.text).toContain('<code>https://spam.example/deal</code>');
      expect(reviewAlerts[0].body.text).toContain('&lt;script&gt;');
      expect(reviewAlerts[0].body.reply_markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual([
        'rv:ok:51001',
        'rv:ban:51001',
      ]);

      // All 5 held messages stored in order in user:51001.pendingReview & counted in listVisitors(filter=pending)
      const detail = await getVisitorDetail(env, '51001');
      expect(detail.pendingReview).toHaveLength(5);
      expect(detail.pendingReview.map((x) => x.pmMessageId)).toEqual([101, 102, 103, 104, 105]);
      const pendingList = await listVisitors(env, { filter: 'pending' });
      expect(pendingList.stats.pendingReview).toBe(1);
      expect(pendingList.items.map((v) => v.userId)).toEqual(['51001']);

      // Media without suspicious caption is NOT held (counts as clean message: left 2 -> 1)
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 201,
            from: { id: 51001, first_name: 'Suspect' },
            chat: { id: 51001, type: 'private' },
            photo: [{ file_id: 'photo_clean_1' }],
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.some((c) => c.method === 'copyMessage' && c.body.message_id === 201)).toBe(true);
      expect((await kv.get('probation:51001', 'json')).left).toBe(1);

      // Another clean text message decrements left 1 -> 0 and deletes probation:{uid}
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          message: {
            message_id: 202,
            from: { id: 51001, first_name: 'Suspect' },
            chat: { id: 51001, type: 'private' },
            text: '你好，请问博客友链怎么申请？',
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.some((c) => c.method === 'copyMessage' && c.body.message_id === 202)).toBe(true);
      expect(await kv.get('probation:51001')).toBeNull();

      // Expired pendingReview items (>7d) are dropped on read
      const expired = filterFreshPendingReview([
        { pmMessageId: 1, chatId: 1, preview: 'old', reasons: ['link'], at: Date.now() - PENDING_REVIEW_TTL_MS - 1000 },
        { pmMessageId: 2, chatId: 1, preview: 'fresh', reasons: ['link'], at: Date.now() - 1000 },
      ]);
      expect(expired.map((x) => x.pmMessageId)).toEqual([2]);
    } finally {
      tg.restore();
    }
  });

  it('matches allowDomains and subdomains accurately while rejecting suffix lookalikes like evilgithub.com', () => {
    const cfg = { probation: { enabled: true, allowDomains: ['github.com', 'example.com'] } };

    expect(isDomainAllowed('github.com', ['github.com'])).toBe(true);
    expect(isDomainAllowed('gist.github.com', ['github.com'])).toBe(true);
    expect(isDomainAllowed('evilgithub.com', ['github.com'])).toBe(false);
    expect(isDomainAllowed('github.com.evil.net', ['github.com'])).toBe(false);

    // Exact allowed domain & subdomain pass (even with 7+ digits in URL path)
    expect(
      assessProbationRisk({ text: '参考 https://github.com/mango0114/rose-panel-bot/issues/1234567' }, cfg).isSuspicious
    ).toBe(false);
    expect(
      assessProbationRisk({ text: '文档在 https://docs.github.com/en/actions' }, cfg).isSuspicious
    ).toBe(false);

    // Lookalike domain is flagged
    const evilRes = assessProbationRisk({ text: '看 https://evilgithub.com/phish' }, cfg);
    expect(evilRes.isSuspicious).toBe(true);
    expect(evilRes.reasons).toContain('link');

    // Mixed allowed + disallowed link is flagged
    const mixedRes = assessProbationRisk(
      { text: '仓库 https://github.com/a/b 和推广 https://ad.xyz/go' },
      cfg
    );
    expect(mixedRes.isSuspicious).toBe(true);
    expect(mixedRes.reasons).toContain('link');

    // Cyrillic homoglyph spoof of allowed domain is flagged
    const spoofRes = assessProbationRisk({ text: '看 https://gіthub.com/scam' }, cfg);
    expect(spoofRes.isSuspicious).toBe(true);

    // Safe review HTML escapes tags & wraps links in <code>
    const html = formatSafeReviewPreviewHtml('点 https://evil.com/a?x=1&y=2 <b>hi</b>');
    expect(html).toContain('<code>https://evil.com/a?x=1&amp;y=2</code>');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(formatProbationReasons(['link', 'contact'])).toBe('含链接 · 含联系方式');
  });

  it('approves in exact order, bans & counts spam, blocks non-admins, and keeps callback buttons & panel API in sync', async () => {
    const kv = createTrackingKV();
    const botToken = '123456:PROB_REVIEW';
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001', SUPERGROUP_ID: '-100888999' });
    const tg = mockTelegramProbation();

    try {
      // --- Case A: Approve via Telegram callback button ---
      await kv.put('verified:52001', 'emoji:v1');
      await kv.put('probation:52001', JSON.stringify({ left: 3, until: Date.now() + 3600 * 1000 }));

      for (const [mid, text] of [
        [301, '第一条 https://foo.test/1'],
        [302, '第二条 https://foo.test/2'],
        [303, '第三条 @my_handle'],
      ]) {
        await handleTelegramUpdate(
          {
            message: {
              message_id: mid,
              from: { id: 52001, first_name: 'ApproveMe' },
              chat: { id: 52001, type: 'private' },
              text,
            },
          },
          env,
          'https://panel.test'
        );
      }

      // Non-admin clicking rv:ok:52001 is rejected and nothing is forwarded
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cq_non_admin',
            from: { id: 99999, first_name: 'Hacker' },
            data: 'rv:ok:52001',
            message: { message_id: 700, chat: { id: -100888999, type: 'supergroup' } },
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.some((c) => c.method === 'copyMessage')).toBe(false);
      expect(
        tg.calls.some((c) => c.method === 'answerCallbackQuery' && c.body.show_alert === true)
      ).toBe(true);
      expect((await getVisitorDetail(env, '52001')).pendingReview).toHaveLength(3);

      // Non-admin calling panel review API gets 403
      const guestInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 99999, first_name: 'Hacker' }) },
        botToken
      );
      const guestRes = await worker.fetch(
        new Request('https://panel.test/api/admin/visitors/52001/review', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': guestInit, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve' }),
        }),
        env
      );
      expect(guestRes.status).toBe(403);

      // Admin approves via callback button -> replays 301, 302, 303 in exact order, clears pendingReview & probation
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cq_admin_ok',
            from: { id: 10001, first_name: 'Owner' },
            data: 'rv:ok:52001',
            message: { message_id: 700, chat: { id: -100888999, type: 'supergroup' } },
          },
        },
        env,
        'https://panel.test'
      );
      const copiedIds = tg.calls.filter((c) => c.method === 'copyMessage').map((c) => c.body.message_id);
      expect(copiedIds).toEqual([301, 302, 303]);
      expect(await kv.get('probation:52001')).toBeNull();
      expect((await getVisitorDetail(env, '52001')).pendingReview).toEqual([]);
      const editOk = tg.calls.find((c) => c.method === 'editMessageText');
      expect(editOk?.body?.text).toBe('✅ 已放行');
      expect(editOk?.body?.reply_markup).toBeUndefined();

      // --- Case B: Ban via Panel API, then stale Telegram button reports 「已处理」 ---
      await kv.put('verified:52002', 'emoji:v1');
      await kv.put('probation:52002', JSON.stringify({ left: 3, until: Date.now() + 3600 * 1000 }));
      await handleTelegramUpdate(
        {
          message: {
            message_id: 401,
            from: { id: 52002, first_name: 'AdSpammer' },
            chat: { id: 52002, type: 'private' },
            text: '联系我 promo_wx888',
          },
        },
        env,
        'https://panel.test'
      );

      const adminInit = await signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
        botToken
      );
      const beforeBlocked = await getBlockedSpamCount(env);
      const banApiRes = await worker.fetch(
        new Request('https://panel.test/api/admin/visitors/52002/review', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ban' }),
        }),
        env
      );
      expect(banApiRes.status).toBe(200);
      const banJson = await banApiRes.json();
      expect(banJson.ok).toBe(true);
      expect(banJson.alreadyHandled).toBe(false);
      expect(banJson.visitor.isBanned).toBe(true);
      expect(banJson.visitor.pendingReview).toEqual([]);
      expect(await kv.get('banned:52002')).toBe('1');
      expect(await kv.get('probation:52002')).toBeNull();
      expect(await getBlockedSpamCount(env)).toBe(beforeBlocked + 1);

      // Clicking the stale notification button after panel already handled it replies 「已处理」
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cq_stale_btn',
            from: { id: 10001, first_name: 'Owner' },
            data: 'rv:ok:52002',
            message: { message_id: 701, chat: { id: -100888999, type: 'supergroup' } },
          },
        },
        env,
        'https://panel.test'
      );
      expect(tg.calls.some((c) => c.method === 'copyMessage')).toBe(false);
      expect(tg.calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === '已处理')).toBe(true);

      // --- Case C: Approve via Panel API matches callback approve behavior ---
      await kv.put('verified:52003', 'emoji:v1');
      await kv.put('probation:52003', JSON.stringify({ left: 3, until: Date.now() + 3600 * 1000 }));
      await handleTelegramUpdate(
        {
          message: {
            message_id: 501,
            from: { id: 52003, first_name: 'PanelApprove' },
            chat: { id: 52003, type: 'private' },
            text: '看看 https://blog.test/1',
          },
        },
        env,
        'https://panel.test'
      );
      await handleTelegramUpdate(
        {
          message: {
            message_id: 502,
            from: { id: 52003, first_name: 'PanelApprove' },
            chat: { id: 52003, type: 'private' },
            text: '还有 https://blog.test/2',
          },
        },
        env,
        'https://panel.test'
      );
      tg.calls.length = 0;
      const approveApiRes = await worker.fetch(
        new Request('https://panel.test/api/admin/visitors/52003/review', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve' }),
        }),
        env
      );
      expect(approveApiRes.status).toBe(200);
      const approveJson = await approveApiRes.json();
      expect(approveJson.deliveredCount).toBe(2);
      expect(approveJson.visitor.pendingReview).toEqual([]);
      expect(await kv.get('probation:52003')).toBeNull();
      expect(tg.calls.filter((c) => c.method === 'copyMessage').map((c) => c.body.message_id)).toEqual([501, 502]);
    } finally {
      tg.restore();
    }
  });

  it('keeps blocked keywords higher priority than probation: matched messages are dropped silently without entering pendingReview', async () => {
    const kv = createTrackingKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:PROB_KW', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100888999' });
    await savePanelConfig(env, { pmBot: { blockedKeywords: '稳赚不赔, 合约喊单' } });
    await kv.put('verified:53001', 'emoji:v1');
    await kv.put('probation:53001', JSON.stringify({ left: 3, until: Date.now() + 3600 * 1000 }));

    const tg = mockTelegramProbation();
    try {
      const beforeBlocked = await getBlockedSpamCount(env);
      await handleTelegramUpdate(
        {
          message: {
            message_id: 601,
            from: { id: 53001, first_name: 'KwSpammer' },
            chat: { id: 53001, type: 'private' },
            text: '稳赚不赔 链接 https://scam.test/go 加微信 wx123456',
          },
        },
        env,
        'https://panel.test'
      );

      expect(tg.calls).toHaveLength(0);
      expect(await getBlockedSpamCount(env)).toBe(beforeBlocked + 1);
      expect(await kv.get('user:53001')).toBeNull();
      expect((await getVisitorDetail(env, '53001')).pendingReview).toEqual([]);
      expect((await kv.get('probation:53001', 'json')).left).toBe(3);
    } finally {
      tg.restore();
    }
  });

  it('sends silent DM review alert and handles rv:ban callback in Bot DM mode', async () => {
    const kv = createTrackingKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:PROB_DM', ADMIN_IDS: '10001' });
    await kv.put('verified:54001', 'emoji:v1');
    await kv.put('probation:54001', JSON.stringify({ left: 3, until: Date.now() + 3600 * 1000 }));

    const tg = mockTelegramProbation();
    try {
      await handleTelegramUpdate(
        {
          message: {
            message_id: 801,
            from: { id: 54001, first_name: 'DmSpammer' },
            chat: { id: 54001, type: 'private' },
            text: 'VX: scam_acc88',
          },
        },
        env,
        'https://panel.test'
      );

      expect(tg.calls.filter((c) => c.method === 'copyMessage')).toHaveLength(0);
      const dmAlert = tg.calls.find(
        (c) => c.method === 'sendMessage' && c.body.chat_id === 10001 && String(c.body.text).includes('新访客消息待审核')
      );
      expect(dmAlert).toBeTruthy();
      expect(dmAlert.body.disable_notification).toBe(true);
      expect(dmAlert.body.text).toContain('含联系方式');

      // Admin clicks rv:ban:54001 -> bans visitor, clears pendingReview, counts spam, edits notice
      const beforeBlocked = await getBlockedSpamCount(env);
      tg.calls.length = 0;
      await handleTelegramUpdate(
        {
          callback_query: {
            id: 'cq_dm_ban',
            from: { id: 10001, first_name: 'Owner' },
            data: 'rv:ban:54001',
            message: { message_id: 9001, chat: { id: 10001, type: 'private' } },
          },
        },
        env,
        'https://panel.test'
      );
      expect(await kv.get('banned:54001')).toBe('1');
      expect(await kv.get('probation:54001')).toBeNull();
      expect((await getVisitorDetail(env, '54001')).pendingReview).toEqual([]);
      expect(await getBlockedSpamCount(env)).toBe(beforeBlocked + 1);
      const edited = tg.calls.find((c) => c.method === 'editMessageText');
      expect(edited?.body?.text).toBe('🚫 已拉黑');
      expect(edited?.body?.reply_markup).toBeUndefined();
    } finally {
      tg.restore();
    }
  });
});

describe('Daily blocked spam counter & admin bootstrap status fields (v1.10)', () => {
  it('rolls over daily blocked counts by owner timezone, sets 3-day expirationTtl, and keeps cumulative total accurate', async () => {
    const base = createMemoryKV();
    const putMeta = new Map();
    const kv = {
      ...base,
      async put(key, value, opts) {
        putMeta.set(key, opts || {});
        return base.put(key, value, opts);
      },
    };
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:DAILY_SPAM', ADMIN_IDS: '10001' });
    const cfgUtc8 = { community: { timezoneOffsetHours: 8 } };
    const cfgUtcMinus5 = { community: { timezoneOffsetHours: -5 } };

    // 2025-05-10T15:59:00Z is 2025-05-10 23:59 in UTC+8
    const beforeMidnightUtc8 = new Date('2025-05-10T15:59:00Z');
    // 2025-05-10T16:01:00Z is 2025-05-11 00:01 in UTC+8
    const afterMidnightUtc8 = new Date('2025-05-10T16:01:00Z');

    expect(getBlockedDateKey(beforeMidnightUtc8, 8)).toBe('20250510');
    expect(getBlockedDateKey(afterMidnightUtc8, 8)).toBe('20250511');
    expect(getBlockedDateKey(afterMidnightUtc8, -5)).toBe('20250510');

    await recordBlockedSpam(env, cfgUtc8, beforeMidnightUtc8);
    await recordBlockedSpam(env, cfgUtc8, beforeMidnightUtc8);
    await recordBlockedSpam(env, cfgUtc8, afterMidnightUtc8);

    // Cumulative total increased to 3
    expect(await getBlockedSpamCount(env)).toBe(3);
    // Daily buckets rolled over cleanly at UTC+8 midnight
    expect(await getBlockedSpamToday(env, cfgUtc8, beforeMidnightUtc8)).toBe(2);
    expect(await getBlockedSpamToday(env, cfgUtc8, afterMidnightUtc8)).toBe(1);
    // Same UTC timestamp in UTC-5 is still 20250510 -> reads 20250510 bucket (2)
    expect(await getBlockedSpamToday(env, cfgUtcMinus5, afterMidnightUtc8)).toBe(2);

    // 3-day expirationTtl attached to daily keys
    expect(putMeta.get('stats:blocked:20250510')?.expirationTtl).toBe(BLOCKED_DAILY_TTL_SECONDS);
    expect(putMeta.get('stats:blocked:20250511')?.expirationTtl).toBe(BLOCKED_DAILY_TTL_SECONDS);
    expect(BLOCKED_DAILY_TTL_SECONDS).toBe(3 * 86400);

    // Bootstrap exposes blockedToday & pendingReviewCount to admins only
    await recordBlockedSpam(env, cfgUtc8);
    await kv.put(
      'user:55001',
      JSON.stringify({
        userId: '55001',
        first_name: 'PendingOne',
        pendingReview: [{ pmMessageId: 91, chatId: 55001, preview: 'https://ad.test', reasons: ['link'], at: Date.now() }],
      })
    );
    await kv.put('visitors:index', JSON.stringify(['55001']));

    const adminInit = await signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
      env.BOT_TOKEN
    );
    const guestInit = await signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 55002, first_name: 'Guest' }) },
      env.BOT_TOKEN
    );

    const adminBoot = await (
      await worker.fetch(
        new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': adminInit } }),
        env
      )
    ).json();
    expect(adminBoot.blockedToday).toBe(1);
    expect(adminBoot.blockedSpamCount).toBe(4);
    expect(adminBoot.pendingReviewCount).toBe(1);

    const guestBoot = await (
      await worker.fetch(
        new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': guestInit } }),
        env
      )
    ).json();
    expect(guestBoot.blockedToday).toBeUndefined();
    expect(guestBoot.pendingReviewCount).toBeUndefined();
  });
});

describe('Customizable navigation order (v1.10)', () => {
  it('validates navOrder (drops unknown IDs, deduplicates, appends missing), preserves default for legacy configs, and exposes navOrder in public config', async () => {
    expect(DEFAULT_CONFIG.ui.navOrder).toEqual(['profile', 'sites', 'probe', 'visitors', 'leaderboard']);

    // Drops unknown IDs, deduplicates, fills missing known IDs in default order
    expect(normalizeNavOrder(['visitors', 'bogus', 'probe', 'visitors', 'evil'])).toEqual([
      'visitors',
      'probe',
      'profile',
      'sites',
      'leaderboard',
    ]);
    expect(normalizeNavOrder(null)).toEqual(DEFAULT_NAV_ORDER);
    expect(normalizeNavOrder([])).toEqual(DEFAULT_NAV_ORDER);

    // Legacy KV config without `ui` field upgrades with unchanged default order
    const kv = createMemoryKV();
    const env = makeEnv({ TOPIC_MAP: kv, BOT_TOKEN: '123456:NAV_TEST', ADMIN_IDS: '10001' });
    await kv.put('config:panel', JSON.stringify({ profile: { displayName: 'LegacyOwner' } }));
    const loadedLegacy = await loadPanelConfig(env);
    expect(loadedLegacy.ui.navOrder).toEqual(['profile', 'sites', 'probe', 'visitors', 'leaderboard']);

    // Saving custom order normalizes and persists cleanly
    const saved = await savePanelConfig(env, {
      ui: { navOrder: ['visitors', 'invalid_tab', 'sites', 'visitors'] },
    });
    expect(saved.ui.navOrder).toEqual(['visitors', 'sites', 'profile', 'probe', 'leaderboard']);

    // Public config exposes navOrder for BOTH guests and admins
    const guestPublic = sanitizePublicConfig(saved, env, false);
    const adminPublic = sanitizePublicConfig(saved, env, true);
    expect(guestPublic.ui.navOrder).toEqual(['visitors', 'sites', 'profile', 'probe', 'leaderboard']);
    expect(adminPublic.ui.navOrder).toEqual(['visitors', 'sites', 'profile', 'probe', 'leaderboard']);
  });
});

describe('Blocked keyword presets & normalization matching (v1.10)', () => {
  it('defaults blockedKeywords to empty and contains only ad-specific phrases without generic single words', () => {
    expect(DEFAULT_CONFIG.pmBot.blockedKeywords).toBe('');
    expect(KEYWORD_PRESET_GROUPS).toHaveLength(6);
    expect(ALL_KEYWORD_PRESETS.length).toBe(27);
    for (const riskySingleWord of ['代理', '推广', '投资', '兼职']) {
      expect(ALL_KEYWORD_PRESETS).not.toContain(riskySingleWord);
    }
  });

  it.each(ALL_KEYWORD_PRESETS)(
    'matches preset phrase %j accurately after normalizeAntiSpamText (case-insensitive & de-obfuscated)',
    (preset) => {
      const norm = normalizeAntiSpamText(preset);
      expect(norm.normalized.trim().length).toBeGreaterThan(0);

      // Direct hit (including uppercase variant for ASCII phrases)
      const directMsg = { text: `限时优惠 ${preset.toUpperCase()} 立即参与`, from: { first_name: 'Ad' } };
      const resDirect = assessIncomingRisk(directMsg, { blockedKeywords: preset });
      expect(resDirect.isBlockedKeyword).toBe(true);
      expect(resDirect.matchedKeyword).toBe(norm.normalized.trim());

      // Zero-width obfuscated variant also hits
      const obfuscated = Array.from(preset).join('\u200b');
      const resObf = assessIncomingRisk({ text: `点击 ${obfuscated}`, from: { first_name: 'Ad' } }, { blockedKeywords: preset });
      expect(resObf.isBlockedKeyword).toBe(true);
    }
  );

  it('toggles single presets and adds whole groups while preserving custom keywords and 2000-char cap', () => {
    const start = '自定义词A, 自定义词B';
    const added = toggleBlockedKeyword(start, '刷单');
    expect(added.added).toBe(true);
    expect(added.value).toBe('自定义词A, 自定义词B, 刷单');
    expect(hasBlockedKeyword(added.value, '刷单')).toBe(true);

    const removed = toggleBlockedKeyword(added.value, '刷单');
    expect(removed.added).toBe(false);
    expect(removed.value).toBe('自定义词A, 自定义词B');
    expect(hasBlockedKeyword(removed.value, '刷单')).toBe(false);

    // Whole group add avoids duplicates & preserves custom entries
    const cryptoGroup = KEYWORD_PRESET_GROUPS[0].keywords;
    const partial = '自定义词A, 带单';
    const grouped = addBlockedKeywordGroup(partial, cryptoGroup);
    expect(grouped.addedCount).toBe(cryptoGroup.length - 1);
    expect(grouped.value.startsWith('自定义词A, 带单, ')).toBe(true);
    for (const kw of cryptoGroup) {
      expect(hasBlockedKeyword(grouped.value, kw)).toBe(true);
    }

    // Whole group remove removes only that group's words while preserving custom entries & other groups
    const withSecondGroup = addBlockedKeywordGroup(grouped.value, ['刷单', 'CRYPTO SIGNAL']);
    const removedGroup = removeBlockedKeywordGroup(withSecondGroup.value, cryptoGroup);
    expect(removedGroup.removedCount).toBe(cryptoGroup.length);
    for (const kw of cryptoGroup) {
      expect(hasBlockedKeyword(removedGroup.value, kw)).toBe(false);
    }
    expect(hasBlockedKeyword(removedGroup.value, '自定义词A')).toBe(true);
    expect(hasBlockedKeyword(removedGroup.value, '刷单')).toBe(true);
    expect(hasBlockedKeyword(removedGroup.value, 'crypto signal')).toBe(true);

    // Removing English preset group matches case-insensitively
    const enRemoved = removeBlockedKeywordGroup(removedGroup.value, ['crypto signal', 'forex signal']);
    expect(enRemoved.removedCount).toBe(1);
    expect(enRemoved.value).toBe('自定义词A, 刷单');

    // Respects 2000-char limit
    const nearCap = 'a'.repeat(BLOCKED_KEYWORD_MAX_LENGTH - 2);
    const blockedAdd = toggleBlockedKeyword(nearCap, '稳赚不赔');
    expect(blockedAdd.truncated).toBe(true);
    expect(blockedAdd.value).toBe(nearCap);
  });
});

describe('Komari probe latency & packet loss display (v1.11)', () => {
  const NODE_A = '496c4866-63b6-4025-b90a-bd7b1d0d6fd2';
  const NODE_B = '8f3e9b11-2a0c-4a1d-8e52-7d3e1c9f0011';

  it('attaches Komari public:getPingMetricStats to matching uuids, rounds values, sorts by task weight or name, caps at 6 lines, and passes auth headers', async () => {
    const seenAuthHeaders = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      seenAuthHeaders.push(init?.headers?.Authorization || '');
      const body = JSON.parse(init.body);
      if (body.method === 'common:getNodes') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              [NODE_A]: { name: 'JP-Edge', region: '🇯🇵', mem_total: 2048, disk_total: 40960 },
              [NODE_B]: { name: 'US-NoPing', region: '🇺🇸', mem_total: 2048, disk_total: 40960 },
            },
          }),
          { status: 200 }
        );
      }
      if (body.method === 'common:getNodesLatestStatus') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: {
              [NODE_A]: { cpu: 15, ram: 512, disk: 10240, online: true, uptime: 86400 },
              [NODE_B]: { cpu: 10, ram: 256, disk: 8192, online: true, uptime: 43200 },
            },
          }),
          { status: 200 }
        );
      }
      if (body.method === 'public:getPingMetricStats') {
        expect(body.params).toEqual({ hours: 1 });
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              start: '2026-11-26T16:52:15Z',
              end: '2026-11-26T17:52:15Z',
              interval_seconds: 60,
              stats: [
                {
                  entity_id: NODE_A,
                  task_id: '17',
                  name: '浙江移动',
                  type: 'tcp',
                  interval: 300,
                  total: 12,
                  valid: 12,
                  loss: 0,
                  min: 40.2,
                  max: 65.4,
                  avg: 47.166666666666664,
                  latest: 41.3,
                  p50: 47.17,
                  p99: 47.17,
                  stddev: 0,
                },
                {
                  entity_id: NODE_A,
                  task_id: '8',
                  name: '浙江电信',
                  type: 'tcp',
                  interval: 300,
                  total: 12,
                  valid: 9,
                  loss: 25.04,
                  min: 134.6,
                  max: 310.4,
                  avg: 218.7,
                  latest: 135.2,
                },
                { entity_id: NODE_A, task_id: '21', name: '上海联通', type: 'tcp', loss: 12.56, min: 70, max: 140, avg: 104.6, latest: 99 },
                { entity_id: NODE_A, task_id: '22', name: '广东电信', type: 'icmp', loss: 0, min: 55, max: 90, avg: 68.4, latest: 66 },
                { entity_id: NODE_A, task_id: '23', name: '北京联通', type: 'tcp', loss: 0, min: 80, max: 120, avg: 95.1, latest: 91 },
                { entity_id: NODE_A, task_id: '24', name: '江苏移动', type: 'tcp', loss: 0, min: 50, max: 88, avg: 61.2, latest: 59 },
                {
                  entity_id: NODE_A,
                  task_id: '25',
                  name: '第七条超长线路名称用于验证长度上限以及截断逻辑1234567890',
                  type: 'tcp',
                  loss: 0,
                  min: 10,
                  max: 20,
                  avg: 15,
                  latest: 15,
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (body.method === 'public:getPublicPingTasks') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: [
              { id: 8, name: '浙江电信', type: 'tcp', interval: 300, weight: 1, clients: [NODE_A] },
              { id: 17, name: '浙江移动', type: 'tcp', interval: 300, weight: 2, clients: [NODE_A] },
              { id: 21, name: '上海联通', type: 'tcp', interval: 300, weight: 3, clients: [NODE_A] },
              { id: 22, name: '广东电信', type: 'icmp', interval: 300, weight: 4, clients: [NODE_A] },
              { id: 23, name: '北京联通', type: 'tcp', interval: 300, weight: 5, clients: [NODE_A] },
              { id: 24, name: '江苏移动', type: 'tcp', interval: 300, weight: 6, clients: [NODE_A] },
              { id: 25, name: '第七条', type: 'tcp', interval: 300, weight: 7, clients: [NODE_A] },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    });

    try {
      const env = makeEnv({ TOPIC_MAP: createMemoryKV() });
      const res = await fetchKomariStatus(env, {
        ...DEFAULT_CONFIG.probe,
        url: 'https://komari.example.com',
        apiKey: 'secret-token-123',
      });

      expect(res.protocol).toBe('rpc2');
      expect(res.error).toBeUndefined();
      // Same auth header passed to all Komari requests including ping stats
      expect(seenAuthHeaders.every((h) => h === 'Bearer secret-token-123')).toBe(true);

      const nodeA = res.nodes.find((n) => n.uuid === NODE_A);
      const nodeB = res.nodes.find((n) => n.uuid === NODE_B);

      // Node without ping tasks gets empty array
      expect(nodeB.latency).toEqual([]);

      // Node with 7 tasks is sorted by weight and capped at 6
      expect(nodeA.latency).toHaveLength(6);
      expect(nodeA.latency.map((x) => x.name)).toEqual([
        '浙江电信',
        '浙江移动',
        '上海联通',
        '广东电信',
        '北京联通',
        '江苏移动',
      ]);
      expect(nodeA.latency[0]).toEqual({
        name: '浙江电信',
        type: 'tcp',
        avg: 219,
        min: 135,
        max: 310,
        latest: 135,
        loss: 25,
      });
      expect(nodeA.latency[1]).toEqual({
        name: '浙江移动',
        type: 'tcp',
        avg: 47,
        min: 40,
        max: 65,
        latest: 41,
        loss: 0,
      });
      expect(nodeA.latency[2].loss).toBe(12.6);

      // Fallback sorting by name and 32-char name truncation when tasks/weights are unavailable
      const noWeightMap = normalizeKomariLatencyMap({
        stats: [
          {
            entity_id: NODE_A,
            task_id: '1',
            name: 'B线路超长名称测试123456789012345678901234567890',
            type: 'tcp',
            avg: 80.4,
            min: 70,
            max: 90,
            latest: 79,
            loss: 0,
          },
          {
            entity_id: NODE_A,
            task_id: '2',
            name: 'A线路',
            type: 'tcp',
            avg: 50.6,
            min: 45,
            max: 60,
            latest: 51,
            loss: 0,
          },
        ],
      });
      const sortedByName = noWeightMap.get(NODE_A);
      expect(sortedByName[0].name).toBe('A线路');
      expect(Array.from(sortedByName[1].name).length).toBe(32);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('silently skips latency on JSON-RPC error, HTTP 500, or timeout without turning protocol into error', async () => {
    const scenarios = [
      {
        label: 'jsonrpc-error',
        respondPing: () =>
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
            { status: 200 }
          ),
        expectUnsupported: true,
      },
      {
        label: 'http-500',
        respondPing: () => new Response('Internal Server Error', { status: 500 }),
        expectUnsupported: false,
      },
      {
        label: 'timeout-abort',
        respondPing: () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        },
        expectUnsupported: false,
      },
    ];

    for (const sc of scenarios) {
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === 'common:getNodes') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { [NODE_A]: { name: `Node-${sc.label}`, region: '🇭🇰', mem_total: 1000, disk_total: 2000 } },
            }),
            { status: 200 }
          );
        }
        if (body.method === 'common:getNodesLatestStatus') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: { [NODE_A]: { cpu: 12, ram: 400, disk: 800, online: true, uptime: 600 } },
            }),
            { status: 200 }
          );
        }
        return sc.respondPing();
      });

      try {
        const env = makeEnv({ TOPIC_MAP: createMemoryKV() });
        const res = await fetchKomariStatus(env, { ...DEFAULT_CONFIG.probe, url: 'https://komari.example.com' });
        expect(res.protocol).toBe('rpc2');
        expect(res.error).toBeUndefined();
        expect(res.nodes).toHaveLength(1);
        expect(res.nodes[0].latency).toEqual([]);
        expect(Boolean(res.latencyUnsupported)).toBe(sc.expectUnsupported);
      } finally {
        globalThis.fetch = origFetch;
      }
    }
  });

  it('keeps latency empty and sends zero latency requests for non-Komari providers', async () => {
    const requestedUrls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      requestedUrls.push(String(url));
      return new Response(
        JSON.stringify([{ id: 's1', name: 'GenericNode', online: true, cpu: 18, mem_usage: 45, disk_usage: 30 }]),
        { status: 200 }
      );
    });

    try {
      const env = makeEnv({ TOPIC_MAP: createMemoryKV() });
      const res = await fetchProbeStatus(env, {
        ...DEFAULT_CONFIG.probe,
        provider: 'json',
        url: 'https://probe.example.com/stats.json',
      });
      expect(res.protocol).toBe('json');
      expect(res.nodes).toHaveLength(1);
      expect(res.nodes[0].latency).toEqual([]);
      expect(requestedUrls).toEqual(['https://probe.example.com/stats.json']);
      expect(requestedUrls.some((u) => u.includes('/api/rpc2') || u.includes('ping'))).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('stores latency inside the single existing cache:komari_probe key with zero extra KV writes, and ships demo latency', async () => {
    const kv = createMemoryKV();
    const putSpy = vi.spyOn(kv, 'put');
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'common:getNodes') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { [NODE_A]: { name: 'CachedNode', region: '🇯🇵', mem_total: 1000, disk_total: 2000 } },
          }),
          { status: 200 }
        );
      }
      if (body.method === 'common:getNodesLatestStatus') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { [NODE_A]: { cpu: 20, ram: 300, disk: 500, online: true, uptime: 1200 } },
          }),
          { status: 200 }
        );
      }
      if (body.method === 'public:getPingMetricStats') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              stats: [
                {
                  entity_id: NODE_A,
                  task_id: '17',
                  name: '浙江移动',
                  type: 'tcp',
                  loss: 0,
                  min: 40,
                  max: 65,
                  avg: 47.2,
                  latest: 41,
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: 200 });
    });

    try {
      const env = makeEnv({ TOPIC_MAP: kv });
      const cfg = { ...DEFAULT_CONFIG.probe, url: 'https://komari.example.com', cacheTtlSeconds: 60 };

      const live = await fetchKomariStatus(env, cfg);
      expect(live.cached).toBeUndefined();
      expect(live.nodes[0].latency).toHaveLength(1);
      // Exactly 1 KV write into the existing cache:komari_probe key
      expect(putSpy).toHaveBeenCalledTimes(1);
      expect(putSpy.mock.calls[0][0]).toBe('cache:komari_probe');

      // Second read hits cache with 0 additional KV writes & preserves latency
      const cached = await fetchKomariStatus(env, cfg);
      expect(cached.cached).toBe(true);
      expect(cached.nodes[0].latency).toEqual(live.nodes[0].latency);
      expect(putSpy).toHaveBeenCalledTimes(1);

      // Demo nodes include realistic latency previews
      const demoNodes = getDemoKomariNodes();
      expect(demoNodes.some((n) => Array.isArray(n.latency) && n.latency.length > 0)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

});

describe('Cloudflare D1 storage layer, schema idempotency, map fallback & daily cleanup (v2.0 Stage 1)', () => {
  it('initializes schema idempotently, records schema_version, caches per isolate, and preserves data on forced re-run', async () => {
    const db = createD1Shim();
    const env = { TOPIC_MAP: createMemoryKV(), DB: db };

    const v1 = await ensureSchema(env);
    expect(v1).toBe(SCHEMA_VERSION);
    expect(db._stats.batches).toBe(1);

    const versionVal = await db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first('value');
    expect(versionVal).toBe('1');

    const tablesRes = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all();
    expect(tablesRes.results.map((r) => r.name)).toEqual([
      'dm_map',
      'message_links',
      'messages',
      'meta',
      'migrated_visitors',
      'topic_map',
    ]);

    // Second call on the same DB binding uses the per-isolate Promise cache (0 extra batches)
    await ensureSchema(env);
    expect(db._stats.batches).toBe(1);

    // Insert a message, then force-rerun DDL (simulating a fresh isolate cold start against an existing DB)
    await getStore(env).appendExchange('88001', {
      sender: 'visitor',
      nowMs: 1700000000000,
      nowIso: new Date(1700000000000).toISOString(),
      text: 'hello d1',
      pmMessageId: 101,
    });
    const batchesBeforeForce = db._stats.batches;
    const v2 = await ensureSchema(env, { force: true });
    expect(v2).toBe(SCHEMA_VERSION);
    expect(db._stats.batches).toBe(batchesBeforeForce + 1);

    const hist = await getStore(env).getHistory('88001');
    expect(hist.messages).toHaveLength(1);
    expect(hist.messages[0].text).toBe('hello d1');
    expect(await db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first('value')).toBe('1');
  });

  it('retains >60 messages in D1 without writing history:* to KV while returning newest 60 by default', async () => {
    const kv = createMemoryKV();
    const db = createD1Shim();
    const env = { TOPIC_MAP: kv, DB: db };

    const baseMs = 1700000000000;
    for (let i = 1; i <= 75; i += 1) {
      await recordVisitorExchange(
        env,
        '88002',
        { message_id: i, text: `msg #${i}` },
        { sender: i % 2 === 0 ? 'admin' : 'visitor', pmMessageId: i, preview: `msg #${i}` }
      );
    }

    // D1 mode never writes `history:88002` to KV
    expect(await kv.get('history:88002')).toBeNull();

    // Total rows in D1 `messages` is all 75 (not truncated at 60)
    const countRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE uid = ?`).bind('88002').first();
    expect(countRow.cnt).toBe(75);

    // Default getVisitorHistory returns newest 60 in oldest->newest order (#16 .. #75)
    const defaultHist = await getVisitorHistory(env, '88002');
    expect(defaultHist.messages).toHaveLength(60);
    expect(defaultHist.messages[0].text).toBe('msg #16');
    expect(defaultHist.messages[59].text).toBe('msg #75');

    // Explicit higher limit retrieves all 75
    const fullHist = await getVisitorHistory(env, '88002', { limit: 100 });
    expect(fullHist.messages).toHaveLength(75);
    expect(fullHist.messages[0].text).toBe('msg #1');
    expect(fullHist.messages[74].text).toBe('msg #75');
  });

  it('falls back to KV for legacy tmsg:* and dmmap:* entries on D1 miss and returns null when absent in both', async () => {
    const kv = createMemoryKV();
    const db = createD1Shim();
    const env = { TOPIC_MAP: kv, DB: db };
    const store = getStore(env);

    // Seed pre-upgrade mappings in KV only
    await kv.put(`${TOPIC_MSG_MAP_PREFIX}901`, JSON.stringify({ g: '-100555', u: '70001', p: 42 }));
    await kv.put(`${DM_MAP_PREFIX}801`, JSON.stringify({ u: '70002', p: 55 }));
    await kv.put(`${DM_MAP_PREFIX}802`, '70003');

    // D1 miss -> KV fallback succeeds
    expect(await store.getTopicMap('-100555', 901)).toEqual({ uid: '70001', pmMessageId: 42 });
    // Group mismatch on KV fallback still rejected
    expect(await store.getTopicMap('-100999', 901)).toBeNull();

    expect(await store.getDmMap(801)).toEqual({ uid: '70002', pmMessageId: 55 });
    expect(await store.getDmMap(802)).toEqual({ uid: '70003', pmMessageId: null });

    // Neither D1 nor KV has entry -> returns null cleanly
    expect(await store.getTopicMap('-100555', 9999)).toBeNull();
    expect(await store.getDmMap(9999)).toBeNull();
  });

  it('purges only expired topic_map (>30d) and dm_map (>7d) rows once daily on scheduled cron even with probe alerts off', async () => {
    const kv = createMemoryKV();
    const db = createD1Shim();
    const env = { TOPIC_MAP: kv, DB: db };
    await ensureSchema(env);

    const dayMs = 86400 * 1000;
    const midnightUtc = Date.UTC(2026, 5, 15, 0, 2, 0); // 00:02 UTC -> runs daily cleanup
    const fivePastUtc = Date.UTC(2026, 5, 15, 0, 5, 0); // 00:05 UTC -> skips daily cleanup

    expect(shouldRunDailyCleanup(midnightUtc)).toBe(true);
    expect(shouldRunDailyCleanup(fivePastUtc)).toBe(false);

    // Insert 1 expired (31d) + 1 fresh (29d) topic_map row, and 1 expired (8d) + 1 fresh (6d) dm_map row
    await db.batch([
      db
        .prepare(`INSERT INTO topic_map (group_id, topic_msg_id, uid, pm_message_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind('-1001', 10, '5001', 100, midnightUtc - 31 * dayMs),
      db
        .prepare(`INSERT INTO topic_map (group_id, topic_msg_id, uid, pm_message_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind('-1001', 11, '5001', 101, midnightUtc - 29 * dayMs),
      db
        .prepare(`INSERT INTO dm_map (owner_msg_id, uid, pm_message_id, created_at) VALUES (?, ?, ?, ?)`)
        .bind(20, '5002', 200, midnightUtc - 8 * dayMs),
      db
        .prepare(`INSERT INTO dm_map (owner_msg_id, uid, pm_message_id, created_at) VALUES (?, ?, ?, ?)`)
        .bind(21, '5002', null, midnightUtc - 6 * dayMs),
    ]);

    const kvPutSpy = vi.spyOn(kv, 'put');

    // At 00:05 UTC, scheduled cron skips map cleanup
    await worker.scheduled({ scheduledTime: fivePastUtc }, env, null);
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM topic_map`).first()).cnt).toBe(2);
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM dm_map`).first()).cnt).toBe(2);

    // At 00:02 UTC (with probe alerts disabled by default), scheduled cron deletes ONLY expired rows and writes 0 KV keys
    await worker.scheduled({ scheduledTime: midnightUtc }, env, null);
    const remainingTopics = (await db.prepare(`SELECT topic_msg_id FROM topic_map`).all()).results;
    const remainingDms = (await db.prepare(`SELECT owner_msg_id FROM dm_map`).all()).results;
    expect(remainingTopics.map((r) => r.topic_msg_id)).toEqual([11]);
    expect(remainingDms.map((r) => r.owner_msg_id)).toEqual([21]);
    expect(kvPutSpy).not.toHaveBeenCalled();

    // Without env.DB, scheduled cron & cleanupExpiredMaps skip cleanly
    const noDbRes = await cleanupExpiredMaps({ TOPIC_MAP: kv }, midnightUtc);
    expect(noDbRes).toEqual({ skipped: true, reason: 'no_d1' });
    await expect(worker.scheduled({ scheduledTime: midnightUtc }, { TOPIC_MAP: kv }, null)).resolves.toBeUndefined();
  });

  it('auto-migrates legacy KV history on first read with exact parity, skips KV on subsequent reads, and never deletes KV data', async () => {
    const kv = createMemoryKV();
    const kvOnlyEnv = { TOPIC_MAP: kv };
    const uid = '77001';

    // 1. Build realistic multi-message history in KV-only mode (v1.11.0 format)
    await recordVisitorExchange(
      kvOnlyEnv,
      uid,
      {
        message_id: 11,
        photo: [{ file_id: 'thumb_a' }, { file_id: 'full_a' }],
        caption: '看看这两条链接 https://one.example.com 和 https://two.example.com',
      },
      {
        sender: 'visitor',
        pmMessageId: 11,
        topicCopyId: 301,
        topicThreadId: 88,
        topicChatId: '-100777',
        preview: '[图片]',
      }
    );
    await recordVisitorExchange(
      kvOnlyEnv,
      uid,
      {
        message_id: 12,
        sticker: { file_id: 'CAAC_STICKER_1', emoji: '🌸', is_animated: true },
      },
      {
        sender: 'admin',
        pmMessageId: 212,
        topicMsgId: 302,
        topicChatId: '-100777',
        dmMsgId: 402,
        preview: '[贴纸 🌸]',
      }
    );
    await updateVisitorMessageReaction(kvOnlyEnv, uid, 11, 'owner', '❤️');
    await updateVisitorMessageReaction(kvOnlyEnv, uid, 212, 'visitor', '🔥');

    // Also prepend an archive-only legacy photo (`p_legacy`) and legacy PM entry (`pmId = 5`) into KV
    const seededKvHist = await kv.get(`history:${uid}`, { type: 'json' });
    seededKvHist.photos.push({
      id: 'p_legacy_99',
      fileId: 'legacy_photo_full',
      thumbFileId: 'legacy_photo_thumb',
      caption: '很早以前的图片',
      sender: 'visitor',
      at: '2025-01-02T03:04:05.000Z',
    });
    seededKvHist.pmMessageIds.push({
      id: 5,
      topicMsgId: 205,
      sender: 'admin',
      at: 1735787045000,
    });
    await kv.put(`history:${uid}`, JSON.stringify(seededKvHist));

    const kvSnapshot = await getVisitorHistory(kvOnlyEnv, uid);
    const kvRawBackup = await kv.get(`history:${uid}`);

    // 2. Bind D1 (`env.DB`) — first read triggers lazy migration automatically
    const db = createD1Shim();
    const d1Env = { TOPIC_MAP: kv, DB: db };
    const kvGetSpy = vi.spyOn(kv, 'get');
    const kvDeleteSpy = vi.spyOn(kv, 'delete');

    const d1FirstRead = await getVisitorHistory(d1Env, uid);

    expect(d1FirstRead.messages).toEqual(kvSnapshot.messages);
    expect(
      d1FirstRead.photos.map(({ fileId, thumbFileId, caption, sender, at }) => ({
        fileId,
        thumbFileId,
        caption,
        sender,
        at,
      }))
    ).toEqual(
      kvSnapshot.photos.map(({ fileId, thumbFileId, caption, sender, at }) => ({
        fileId,
        thumbFileId,
        caption,
        sender,
        at,
      }))
    );
    expect(
      d1FirstRead.links.map(({ url, snippet, sender, at }) => ({ url, snippet, sender, at }))
    ).toEqual(
      kvSnapshot.links.map(({ url, snippet, sender, at }) => ({ url, snippet, sender, at }))
    );
    expect(d1FirstRead.pmMessageIds).toEqual(kvSnapshot.pmMessageIds);

    // 3. Second read hits D1 directly with ZERO KV reads
    kvGetSpy.mockClear();
    const d1SecondRead = await getVisitorHistory(d1Env, uid);
    expect(kvGetSpy).not.toHaveBeenCalled();
    expect(d1SecondRead.messages).toEqual(kvSnapshot.messages);

    // 4. Clearing history in D1 mode clears D1 without deleting KV backup and without re-importing on next read
    await clearVisitorHistory(d1Env, uid, 'archive');
    expect(kvDeleteSpy.mock.calls.some(([k]) => k === `history:${uid}`)).toBe(false);
    expect(await kv.get(`history:${uid}`)).toBe(kvRawBackup);
    const afterClear = await getVisitorHistory(d1Env, uid);
    expect(afterClear.messages).toEqual([]);
    expect(afterClear.photos).toEqual([]);
    expect(afterClear.links).toEqual([]);
    expect(afterClear.pmMessageIds).toEqual([]);
  });

  it('migrates visitors in batches via /api/admin/storage/migrate, recovers from mid-batch failures without duplicates, and enforces admin auth', async () => {
    const botToken = '123456:STORAGE_MIGRATE_TEST';
    const kv = createMemoryKV();
    const nowSec = Math.floor(Date.now() / 1000);
    const adminInit = await signInitData(
      { auth_date: String(nowSec), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
      botToken
    );
    const guestInit = await signInitData(
      { auth_date: String(nowSec), user: JSON.stringify({ id: 20002, first_name: 'Guest' }) },
      botToken
    );

    // Seed 45 visitors in KV-only mode (each with 2 messages + 1 photo + 2 links, plus visitor 60025 with 95 messages > chunk size 80)
    const kvOnlyEnv = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' };
    for (let i = 1; i <= 45; i += 1) {
      const uid = String(60000 + i);
      await upsertVisitorProfile(kvOnlyEnv, { id: Number(uid), first_name: `V${i}` });
      if (i === 25) {
        // Seed >80 items so multi-chunk batching inside migrateVisitor is also exercised on failure & retry
        const bigMsgs = [];
        for (let m = 1; m <= 60; m += 1) {
          bigMsgs.push({
            id: `m_big_${m}`,
            sender: m % 2 === 0 ? 'admin' : 'visitor',
            text: `bulk msg ${m}`,
            mediaTag: '',
            photoFileId: '',
            thumbFileId: '',
            pmMessageId: m,
            topicMsgId: null,
            at: new Date(1700000000000 + m * 1000).toISOString(),
          });
        }
        const bigLinks = [];
        for (let l = 1; l <= 35; l += 1) {
          bigLinks.push({
            id: `l_big_${l}`,
            url: `https://example.com/item/${l}`,
            snippet: `link ${l}`,
            sender: 'visitor',
            at: new Date(1700000100000 + l * 1000).toISOString(),
          });
        }
        await kv.put(
          `history:${uid}`,
          JSON.stringify({ photos: [], links: bigLinks, pmMessageIds: [], messages: bigMsgs })
        );
      } else {
        await recordVisitorExchange(
          kvOnlyEnv,
          uid,
          {
            message_id: i * 10 + 1,
            photo: [{ file_id: `th_${i}` }, { file_id: `ph_${i}` }],
            caption: `来自 ${uid} https://site-${i}.test/a https://site-${i}.test/b`,
          },
          { sender: 'visitor', pmMessageId: i * 10 + 1, preview: '[图片]' }
        );
        await recordVisitorExchange(
          kvOnlyEnv,
          uid,
          { message_id: i * 10 + 2, text: `回复 ${uid}` },
          { sender: 'admin', pmMessageId: i * 10 + 2, preview: `回复 ${uid}` }
        );
      }
    }

    // 1. Non-admin is blocked with 403
    const deniedGet = await worker.fetch(
      new Request('https://panel.test/api/admin/storage', { headers: { 'X-Telegram-Init-Data': guestInit } }),
      kvOnlyEnv
    );
    expect(deniedGet.status).toBe(403);
    const deniedPost = await worker.fetch(
      new Request('https://panel.test/api/admin/storage/migrate', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': guestInit },
      }),
      kvOnlyEnv
    );
    expect(deniedPost.status).toBe(403);

    // 2. KV-only mode reports d1Bound: false and rejects /migrate cleanly with 400
    const kvBoot = await (
      await worker.fetch(
        new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': adminInit } }),
        kvOnlyEnv
      )
    ).json();
    expect(kvBoot.adminConfig.d1Bound).toBe(false);

    const kvStatus = await (
      await worker.fetch(
        new Request('https://panel.test/api/admin/storage', { headers: { 'X-Telegram-Init-Data': adminInit } }),
        kvOnlyEnv
      )
    ).json();
    expect(kvStatus).toEqual({ ok: true, mode: 'kv', d1Bound: false, done: 0, total: 0, finished: true });

    const kvMigrateRes = await worker.fetch(
      new Request('https://panel.test/api/admin/storage/migrate', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      kvOnlyEnv
    );
    expect(kvMigrateRes.status).toBe(400);

    // 3. Bind D1 and verify initial status (0 / 45) + bootstrap d1Bound: true
    const db = createD1Shim();
    const d1Env = { ...kvOnlyEnv, DB: db };

    const d1Boot = await (
      await worker.fetch(
        new Request('https://panel.test/api/bootstrap', { headers: { 'X-Telegram-Init-Data': adminInit } }),
        d1Env
      )
    ).json();
    expect(d1Boot.adminConfig.d1Bound).toBe(true);

    const initialStatus = await (
      await worker.fetch(
        new Request('https://panel.test/api/admin/storage', { headers: { 'X-Telegram-Init-Data': adminInit } }),
        d1Env
      )
    ).json();
    expect(initialStatus).toEqual({ ok: true, mode: 'd1', d1Bound: true, done: 0, total: 45, finished: false });

    // 4. Batch 1 on a fresh DB (even when caller requests batchSize: 50) stays strictly <= 50 D1 queries
    const coldDb = createD1Shim();
    const coldEnv = { ...kvOnlyEnv, DB: coldDb };
    coldDb.resetStats();
    const coldFirstBatch = await (
      await worker.fetch(
        new Request('https://panel.test/api/admin/storage/migrate', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchSize: 50 }),
        }),
        coldEnv
      )
    ).json();
    expect(coldFirstBatch.ok).toBe(true);
    expect(coldFirstBatch.batchMigrated).toBeGreaterThanOrEqual(1);
    expect(coldFirstBatch.batchMigrated).toBeLessThan(25);
    expect(coldFirstBatch.finished).toBe(false);
    expect(coldDb._stats.queries).toBeLessThanOrEqual(50);

    // Also verify on `d1Env` that every batch stays <= 50 D1 queries and recovers from mid-batch failures
    db.resetStats();
    const b1 = await (
      await worker.fetch(
        new Request('https://panel.test/api/admin/storage/migrate', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
          body: '{}',
        }),
        d1Env
      )
    ).json();
    expect(b1.ok).toBe(true);
    expect(b1.mode).toBe('d1');
    expect(b1.batchMigrated).toBe(19);
    expect(b1.done).toBe(19);
    expect(b1.total).toBe(45);
    expect(b1.finished).toBe(false);
    expect(db._stats.queries).toBeLessThanOrEqual(50);

    // 5. Simulate mid-batch D1 failure during Batch 2 right on the 2nd chunk of the 95-row visitor (`60025`)
    const origBatch = db.batch.bind(db);
    let sawFirstChunkOfBigVisitor = false;
    db.batch = async (stmts) => {
      const hasBigMsg = stmts.some((s) => Array.isArray(s._args) && s._args[0] === 'm_big_1');
      const hasMigratedMark = stmts.some(
        (s) => String(s._sql).includes('INSERT OR IGNORE INTO migrated_visitors') && s._args?.[0] === '60025'
      );
      if (hasBigMsg) {
        sawFirstChunkOfBigVisitor = true;
      } else if (sawFirstChunkOfBigVisitor && hasMigratedMark) {
        throw new Error('D1 transient network error mid-migration');
      }
      return origBatch(stmts);
    };

    const failedRes = await worker.fetch(
      new Request('https://panel.test/api/admin/storage/migrate', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      d1Env
    );
    expect(failedRes.status).toBe(500);
    expect(sawFirstChunkOfBigVisitor).toBe(true);

    // Restore D1 batch and run remaining batches to completion, verifying <= 50 D1 queries on EVERY request
    db.batch = origBatch;
    let latest = await getStorageStatus(d1Env);
    expect(latest.finished).toBe(false);
    expect(latest.done).toBeGreaterThanOrEqual(19);
    expect(latest.done).toBeLessThan(45);

    let safetyLoops = 0;
    while (!latest.finished && safetyLoops < 10) {
      safetyLoops += 1;
      db.resetStats();
      latest = await (
        await worker.fetch(
          new Request('https://panel.test/api/admin/storage/migrate', {
            method: 'POST',
            headers: { 'X-Telegram-Init-Data': adminInit, 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchSize: 50 }),
          }),
          d1Env
        )
      ).json();
      expect(db._stats.queries).toBeLessThanOrEqual(50);
      expect(latest.batchMigrated).toBeGreaterThanOrEqual(1);
    }
    expect(latest).toMatchObject({ ok: true, done: 45, total: 45, finished: true });

    // 6. Verify ZERO duplicate rows in D1 (44 visitors * 2 msgs + 1 visitor * 60 msgs = 148 msgs;
    //    44 visitors * 2 links + 1 visitor * 35 links = 123 links; 45 migrated_visitors)
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM migrated_visitors`).first()).cnt).toBe(45);
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM messages`).first()).cnt).toBe(44 * 2 + 60);
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM message_links`).first()).cnt).toBe(44 * 2 + 35);

    // Calling migrate again after completion is a clean no-op (`batchMigrated: 0, finished: true`)
    const extraRun = await migrateVisitorsBatch(d1Env);
    expect(extraRun).toMatchObject({ ok: true, batchMigrated: 0, done: 45, total: 45, finished: true });

    // All 45 legacy KV `history:*` keys remain untouched in KV
    const listedKvHist = await kv.list({ prefix: 'history:' });
    expect(listedKvHist.keys).toHaveLength(45);
  });

  it('keeps v1.10 / v1.11 KV data (probation, pendingReview, blockedToday, Komari latency cache) working alongside D1', async () => {
    const kv = createMemoryKV();
    const db = createD1Shim();
    const env = { TOPIC_MAP: kv, DB: db, BOT_TOKEN: '123456:COEXIST', ADMIN_IDS: '10001' };

    const cfg = await savePanelConfig(env, {
      pmBot: { probation: { enabled: true, maxMessages: 2 } },
      probe: { provider: 'komari', url: 'https://komari.example.com', demoMode: true },
    });

    // 1. Probation & pendingReview remain in KV
    await startVisitorProbation(env, '91001', cfg, { prevVerified: null });
    const probState = await kv.get('probation:91001', { type: 'json' });
    expect(probState?.left).toBe(2);

    await addPendingReviewMessage(
      env,
      { id: 91001, first_name: 'ProbUser' },
      { pmMessageId: 76, chatId: 91001, preview: 'https://suspicious.test', reasons: ['link'] }
    );
    const detail = await getVisitorDetail(env, '91001');
    expect(detail.pendingReviewCount).toBe(1);
    expect(detail.pendingReview[0].pmMessageId).toBe(76);

    // 2. Daily blocked spam counter remains in KV
    await recordBlockedSpam(env, cfg, new Date('2026-11-26T08:00:00Z'));
    expect(await getBlockedSpamToday(env, cfg, new Date('2026-11-26T09:00:00Z'))).toBe(1);
    expect(await getBlockedSpamCount(env)).toBe(1);

    // 3. Komari probe live fetch + KV cache (`cache:komari_probe`) with per-line latency still works cleanly
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init?.body || '{}');
      if (body.method === 'common:getNodes') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { n1: { uuid: 'n1', name: 'HK-01', region: '🇭🇰', mem_total: 1024, disk_total: 2048 } },
          }),
          { status: 200 }
        );
      }
      if (body.method === 'common:getNodesLatestStatus') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { n1: { cpu: 15, ram: 256, disk: 512, online: true, uptime: 3600 } },
          }),
          { status: 200 }
        );
      }
      if (body.method === 'public:getPingMetricStats') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              stats: [{ entity_id: 'n1', task_id: '1', name: '上海电信', type: 'tcp', loss: 0, avg: 32.4, latest: 31 }],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: [] }), { status: 200 });
    });
    try {
      const probeRes = await fetchKomariStatus(env, { ...cfg.probe, demoMode: false, cacheTtlSeconds: 60 });
      expect(probeRes.nodes).toHaveLength(1);
      expect(probeRes.nodes[0].latency[0]).toMatchObject({ name: '上海电信', latest: 31 });
      expect(await kv.get('cache:komari_probe')).toBeTruthy();
    } finally {
      globalThis.fetch = origFetch;
    }

    // 4. Visitor chat history simultaneously goes to D1 (0 `history:*` writes in KV)
    await recordVisitorExchange(
      env,
      '91001',
      { message_id: 77, text: 'D1 + KV 协同正常' },
      { sender: 'visitor', pmMessageId: 77, preview: 'D1 + KV 协同正常' }
    );
    expect(await kv.get('history:91001')).toBeNull();
    const hist = await getVisitorHistory(env, '91001');
    expect(hist.messages.map((m) => m.text)).toEqual(['D1 + KV 协同正常']);
  });

  it('isolates composite PRIMARY KEY (uid, id) across visitors on identical message IDs (including p-prefixed IDs) and scopes reactions to uid', async () => {
    const kv = createMemoryKV();
    const db = createD1Shim();
    const d1Env = { TOPIC_MAP: kv, DB: db };

    // Two distinct visitors share identical KV message IDs (`m_1700000000000_42` and `p1`) and identical `pmMessageId: 101`
    await kv.put(
      'history:81001',
      JSON.stringify({
        photos: [],
        links: [],
        pmMessageIds: [{ id: 101, topicMsgId: null, sender: 'visitor', at: 1700000000000 }],
        messages: [
          {
            id: 'm_1700000000000_42',
            sender: 'visitor',
            text: 'Alice 的第一条消息',
            mediaTag: '',
            photoFileId: '',
            thumbFileId: '',
            pmMessageId: 101,
            topicMsgId: null,
            at: '2023-11-14T22:13:20.000Z',
          },
          {
            id: 'p1',
            sender: 'admin',
            text: '以 p 开头但非 p_/p:/pm: 的气泡消息',
            mediaTag: '',
            photoFileId: '',
            thumbFileId: '',
            pmMessageId: 102,
            topicMsgId: null,
            at: '2023-11-14T22:13:21.000Z',
          },
        ],
      })
    );
    await kv.put(
      'history:81002',
      JSON.stringify({
        photos: [],
        links: [],
        pmMessageIds: [{ id: 101, topicMsgId: null, sender: 'visitor', at: 1700000000000 }],
        messages: [
          {
            id: 'm_1700000000000_42',
            sender: 'visitor',
            text: 'Bob 的同名 ID 消息',
            mediaTag: '',
            photoFileId: '',
            thumbFileId: '',
            pmMessageId: 101,
            topicMsgId: null,
            at: '2023-11-14T22:13:20.000Z',
          },
          {
            id: 'p1',
            sender: 'admin',
            text: 'Bob 的 p1 消息',
            mediaTag: '',
            photoFileId: '',
            thumbFileId: '',
            pmMessageId: 102,
            topicMsgId: null,
            at: '2023-11-14T22:13:21.000Z',
          },
        ],
      })
    );

    const histA = await getVisitorHistory(d1Env, '81001');
    const histB = await getVisitorHistory(d1Env, '81002');
    expect(histA.messages.map((m) => ({ id: m.id, text: m.text }))).toEqual([
      { id: 'm_1700000000000_42', text: 'Alice 的第一条消息' },
      { id: 'p1', text: '以 p 开头但非 p_/p:/pm: 的气泡消息' },
    ]);
    expect(histB.messages.map((m) => ({ id: m.id, text: m.text }))).toEqual([
      { id: 'm_1700000000000_42', text: 'Bob 的同名 ID 消息' },
      { id: 'p1', text: 'Bob 的 p1 消息' },
    ]);

    // Reacting on visitor 81001's message (`m_1700000000000_42` and `p1`) MUST NOT leak onto visitor 81002
    expect(await updateVisitorMessageReaction(d1Env, '81001', 101, 'owner', '❤️')).toBe(true);
    expect(await updateVisitorMessageReaction(d1Env, '81001', 102, 'visitor', '👍')).toBe(true);

    const afterA = await getVisitorHistory(d1Env, '81001');
    const afterB = await getVisitorHistory(d1Env, '81002');
    expect(afterA.messages.find((m) => m.id === 'm_1700000000000_42')?.ownerReaction).toBe('❤️');
    expect(afterA.messages.find((m) => m.id === 'p1')?.visitorReaction).toBe('👍');
    expect(afterB.messages.find((m) => m.id === 'm_1700000000000_42')?.ownerReaction).toBeUndefined();
    expect(afterB.messages.find((m) => m.id === 'p1')?.visitorReaction).toBeUndefined();
  });

  it('deduplicates messages and message_links under concurrent migrateVisitor calls and advances at least 1 visitor under tight queryBudget', async () => {
    const kv = createMemoryKV();
    const db = createD1Shim();
    const env = { TOPIC_MAP: kv, DB: db };

    await kv.put(
      'history:82001',
      JSON.stringify({
        photos: [
          {
            id: 'p_old_1',
            fileId: 'old_photo_file',
            thumbFileId: 'old_photo_thumb',
            caption: '旧图',
            sender: 'visitor',
            at: '2024-05-01T00:00:00.000Z',
          },
        ],
        links: [
          {
            id: 'l_100',
            url: 'https://concurrent.example.com/a',
            snippet: '并发测试 A',
            sender: 'visitor',
            at: '2024-06-01T00:00:00.000Z',
          },
          {
            id: 'l_100',
            url: 'https://concurrent.example.com/b',
            snippet: '并发测试 B',
            sender: 'visitor',
            at: '2024-06-01T00:00:00.000Z',
          },
        ],
        pmMessageIds: [{ id: 301, topicMsgId: null, sender: 'visitor', at: 1717200000000 }],
        messages: [
          {
            id: 'm_conc_1',
            sender: 'visitor',
            text: '并发消息 https://concurrent.example.com/a https://concurrent.example.com/b',
            mediaTag: '',
            photoFileId: '',
            thumbFileId: '',
            pmMessageId: 301,
            topicMsgId: null,
            at: '2024-06-01T00:00:00.000Z',
          },
        ],
      })
    );

    // Delay KV get slightly so both concurrent callers pass `SELECT 1 FROM migrated_visitors` before either writes
    const origGet = kv.get.bind(kv);
    kv.get = async (...args) => {
      await new Promise((r) => setTimeout(r, 8));
      return origGet(...args);
    };

    const [r1, r2] = await Promise.all([migrateVisitor(env, '82001'), migrateVisitor(env, '82001')]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Both `messages` (1 bubble + 1 archive photo = 2) and `message_links` (2 URLs) must have ZERO duplicates
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE uid = '82001'`).first()).cnt).toBe(2);
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM message_links WHERE uid = '82001'`).first()).cnt).toBe(2);
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM migrated_visitors WHERE uid = '82001'`).first()).cnt).toBe(1);

    // Also verify `appendExchange` with duplicate URLs in a single message never throws on idx_links_uniq
    await getStore(env).appendExchange('82001', {
      sender: 'visitor',
      nowMs: 1717300000000,
      nowIso: new Date(1717300000000).toISOString(),
      text: 'dup urls',
      urls: ['https://dup.example.com/x', 'https://dup.example.com/x'],
      pmMessageId: 302,
    });
    const linksAfter = (
      await db.prepare(`SELECT url FROM message_links WHERE uid = '82001' AND url = 'https://dup.example.com/x'`).all()
    ).results;
    expect(linksAfter).toHaveLength(1);

    // Seed one more large visitor and verify `migrateVisitorsBatch` still migrates at least 1 visitor even if queryBudget is tiny
    const largeMsgs = Array.from({ length: 60 }, (_, idx) => ({
      id: `m_lg_${idx}`,
      sender: 'visitor',
      text: `msg ${idx}`,
      mediaTag: '',
      photoFileId: '',
      thumbFileId: '',
      pmMessageId: idx + 1,
      topicMsgId: null,
      at: new Date(1718000000000 + idx * 1000).toISOString(),
    }));
    await kv.put('history:82002', JSON.stringify({ photos: [], links: [], pmMessageIds: [], messages: largeMsgs }));
    await kv.put('history:82003', JSON.stringify({ photos: [], links: [], pmMessageIds: [], messages: [] }));

    const tightBatch = await migrateVisitorsBatch(env, { batchSize: 20, queryBudget: 1 });
    expect(tightBatch.ok).toBe(true);
    expect(tightBatch.batchMigrated).toBe(1);
    expect(tightBatch.finished).toBe(false);
  });
});

describe('Cloudflare D1 Stage 2 store: cursor pagination, around jump, LIKE search & batched retention cleanup (v2.1)', () => {
  it('paginates full D1 history with (created_at, rowid) cursors across same-ms ties, supports after & around with graceful fallback', async () => {
    const kv = createMemoryKV();
    const db = createD1Shim();
    const env = { TOPIC_MAP: kv, DB: db };
    const store = getStore(env);
    const uid = '92101';

    // Seed 25 messages including 5 messages sharing the exact same millisecond timestamp (T_TIE)
    const baseMs = 1710000000000;
    const tieMs = baseMs + 10_000;
    const seededIds = [];
    for (let i = 1; i <= 25; i += 1) {
      const ts = i >= 10 && i <= 14 ? tieMs : baseMs + i * 1000;
      const res = await store.appendExchange(uid, {
        sender: i % 2 === 0 ? 'admin' : 'visitor',
        nowMs: ts,
        nowIso: new Date(ts).toISOString(),
        text: `msg-${String(i).padStart(2, '0')}`,
        pmMessageId: i,
      });
      seededIds.push(res.message.id);
    }

    // Walk backwards from newest to oldest in pages of 6 — must visit all 25 with zero skips or duplicates
    const collected = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const res = await store.getHistory(
        uid,
        cursor
          ? { limit: 6, before: cursor.ts, beforeId: cursor.id, messagesOnly: true }
          : { limit: 6 }
      );
      collected.unshift(...res.messages);
      if (page > 0) {
        expect(res.photos).toEqual([]);
        expect(res.links).toEqual([]);
      }
      if (!res.hasMore) break;
      expect(res.oldestCursor).toBeTruthy();
      expect(Number.isSafeInteger(res.oldestCursor.ts)).toBe(true);
      expect(Number.isSafeInteger(res.oldestCursor.id)).toBe(true);
      cursor = res.oldestCursor;
    }

    expect(collected.map((m) => m.text)).toEqual(
      Array.from({ length: 25 }, (_, i) => `msg-${String(i + 1).padStart(2, '0')}`)
    );

    // Jump directly to `msg-12` (in the middle of the same-ms tie!) with limit = 7 -> 3 older + target + 3 newer
    const targetId = seededIds[11]; // msg-12
    const aroundRes = await store.getHistory(uid, { around: targetId, limit: 7 });
    expect(aroundRes.aroundFound).toBe(true);
    expect(aroundRes.hasMore).toBe(true);
    expect(aroundRes.hasNewer).toBe(true);
    expect(aroundRes.messages.map((m) => m.text)).toEqual([
      'msg-09',
      'msg-10',
      'msg-11',
      'msg-12',
      'msg-13',
      'msg-14',
      'msg-15',
    ]);

    // Walk forward from `aroundRes.newestCursor` using `after` + `afterId` -> msg-16..msg-25
    const afterPage1 = await store.getHistory(uid, {
      limit: 6,
      after: aroundRes.newestCursor.ts,
      afterId: aroundRes.newestCursor.id,
      messagesOnly: true,
    });
    expect(afterPage1.hasNewer).toBe(true);
    expect(afterPage1.messages.map((m) => m.text)).toEqual([
      'msg-16',
      'msg-17',
      'msg-18',
      'msg-19',
      'msg-20',
      'msg-21',
    ]);
    const afterPage2 = await store.getHistory(uid, {
      limit: 6,
      after: afterPage1.newestCursor.ts,
      afterId: afterPage1.newestCursor.id,
      messagesOnly: true,
    });
    expect(afterPage2.hasNewer).toBe(false);
    expect(afterPage2.messages.map((m) => m.text)).toEqual(['msg-22', 'msg-23', 'msg-24', 'msg-25']);

    // Missing `around` ID (recalled or deleted) falls back cleanly to latest page with aroundFound: false
    const missingAround = await store.getHistory(uid, { around: 'm_nonexistent_999', limit: 5 });
    expect(missingAround.aroundFound).toBe(false);
    expect(missingAround.hasNewer).toBe(false);
    expect(missingAround.hasMore).toBe(true);
    expect(missingAround.messages.map((m) => m.text)).toEqual(['msg-21', 'msg-22', 'msg-23', 'msg-24', 'msg-25']);

    // KV mode ignores pagination cleanly and always reports hasMore: false, hasNewer: false
    const kvOnlyEnv = { TOPIC_MAP: createMemoryKV() };
    await getStore(kvOnlyEnv).appendExchange(uid, {
      sender: 'visitor',
      nowMs: baseMs,
      nowIso: new Date(baseMs).toISOString(),
      text: 'kv-only-msg',
      pmMessageId: 1,
    });
    const kvHist = await getStore(kvOnlyEnv).getHistory(uid, { before: baseMs + 5000, limit: 10 });
    expect(kvHist.messages).toHaveLength(1);
    expect(kvHist.hasMore).toBe(false);
    expect(kvHist.hasNewer).toBe(false);
    expect(kvHist.oldestCursor).toBeNull();
    expect(kvHist.newestCursor).toBeNull();
  });

  it('escapes %, _, and \\ in LIKE search, filters by uid/time/limit, excludes internal rows, and skips KV in KV mode', async () => {
    expect(escapeLikePattern('100%_test\\path')).toBe('100\\%\\_test\\\\path');

    const kv = createMemoryKV();
    const db = createD1Shim();
    const env = { TOPIC_MAP: kv, DB: db };
    const store = getStore(env);

    const t1 = Date.UTC(2026, 0, 10, 10, 0, 0);
    const t2 = Date.UTC(2026, 1, 15, 10, 0, 0);
    const t3 = Date.UTC(2026, 2, 20, 10, 0, 0);

    await store.appendExchange('92201', {
      sender: 'visitor',
      nowMs: t1,
      nowIso: new Date(t1).toISOString(),
      text: '折扣 50% 优惠券',
      pmMessageId: 1,
    });
    await store.appendExchange('92201', {
      sender: 'admin',
      nowMs: t2,
      nowIso: new Date(t2).toISOString(),
      text: '不要被 500 元和 foo_bar 搞混了',
      pmMessageId: 2,
    });
    await store.appendExchange('92202', {
      sender: 'visitor',
      nowMs: t2,
      nowIso: new Date(t2).toISOString(),
      text: '路径 C:\\Users\\rose 以及 fooXbar',
      pmMessageId: 3,
    });
    await store.appendExchange('92202', {
      sender: 'visitor',
      nowMs: t3,
      nowIso: new Date(t3).toISOString(),
      text: '',
      mediaTag: '[文件 invoice_2026.pdf]',
      pmMessageId: 4,
    });
    // Also insert internal archive-only `p_*` and `pm:*` rows containing the same text to ensure exclusion
    await db.batch([
      db
        .prepare(
          `INSERT INTO messages (id, uid, sender, text, photo_file_id, created_at)
           VALUES ('p_legacy_1', '92201', 'visitor', '折扣 50% 归档图', 'file_old', ?)`
        )
        .bind(t1),
      db
        .prepare(
          `INSERT INTO messages (id, uid, sender, text, pm_message_id, created_at)
           VALUES ('pm:99', '92201', 'visitor', '折扣 50% 内部行', 99, ?)`
        )
        .bind(t1),
    ]);

    // `%` must match literal `%` only (NOT `500`) and must exclude `p_*` / `pm:*`
    const pctRes = await store.searchMessages({ q: '50%' });
    expect(pctRes.items.map((x) => x.text)).toEqual(['折扣 50% 优惠券']);

    // `_` must match literal `_` only (NOT `fooXbar`)
    const underRes = await store.searchMessages({ q: 'foo_bar' });
    expect(underRes.items.map((x) => x.text)).toEqual(['不要被 500 元和 foo_bar 搞混了']);

    // `\` must match literal backslash
    const slashRes = await store.searchMessages({ q: 'C:\\Users' });
    expect(slashRes.items.map((x) => x.text)).toEqual(['路径 C:\\Users\\rose 以及 fooXbar']);

    // Matches `media_tag` filename
    const fileRes = await store.searchMessages({ q: 'invoice_2026' });
    expect(fileRes.items).toHaveLength(1);
    expect(fileRes.items[0].mediaTag).toBe('[文件 invoice_2026.pdf]');

    // `uid`, `from`, `to` filters + `limit` pagination
    const rangeRes = await store.searchMessages({ q: 'foo', from: t2, to: t2, limit: 1 });
    expect(rangeRes.items).toHaveLength(1);
    expect(rangeRes.hasMore).toBe(true);
    expect(rangeRes.nextCursor).toBeTruthy();

    const rangePage2 = await store.searchMessages({
      q: 'foo',
      from: t2,
      to: t2,
      limit: 1,
      before: rangeRes.nextCursor.before,
      beforeId: rangeRes.nextCursor.beforeId,
    });
    expect(rangePage2.items).toHaveLength(1);
    expect(rangePage2.hasMore).toBe(false);
    expect(rangePage2.items[0].id).not.toBe(rangeRes.items[0].id);

    const uidOnlyRes = await store.searchMessages({ q: 'foo', uid: '92201' });
    expect(uidOnlyRes.items).toHaveLength(1);
    expect(uidOnlyRes.items[0].uid).toBe('92201');

    // Overlong query returns empty cleanly
    const overlong = await store.searchMessages({ q: 'a'.repeat(MAX_SEARCH_QUERY_LEN + 1) });
    expect(overlong.items).toEqual([]);

    // KV store searchMessages returns supported: false with ZERO KV reads
    const kvOnly = createMemoryKV();
    const getSpy = vi.spyOn(kvOnly, 'get');
    const listSpy = vi.spyOn(kvOnly, 'list');
    const kvSearch = await getStore({ TOPIC_MAP: kvOnly }).searchMessages({ q: 'test' });
    expect(kvSearch.supported).toBe(false);
    expect(getSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('validates chatRetentionDays whitelist and deletes expired D1 messages + paired message_links in bounded batches without KV writes or re-migration', async () => {
    expect(CHAT_RETENTION_DAYS_OPTIONS).toEqual([0, 180, 365]);
    expect(normalizeChatRetentionDays(0)).toBe(0);
    expect(normalizeChatRetentionDays(180)).toBe(180);
    expect(normalizeChatRetentionDays(365)).toBe(365);
    expect(normalizeChatRetentionDays(1)).toBe(0);
    expect(normalizeChatRetentionDays(30)).toBe(0);
    expect(normalizeChatRetentionDays(-10)).toBe(0);
    expect(normalizeChatRetentionDays('invalid')).toBe(0);

    const kv = createMemoryKV();
    const db = createD1Shim();
    const env = { TOPIC_MAP: kv, DB: db };
    const dayMs = 86400 * 1000;
    const midnightUtc = Date.UTC(2026, 10, 27, 0, 2, 0);

    // Seed legacy KV history for uid 92301 and migrate it into D1 so `migrated_visitors` is recorded
    const oldTs = midnightUtc - 220 * dayMs; // 220 days old (>180d, <365d)
    const recentTs = midnightUtc - 20 * dayMs; // 20 days old (kept under both 180d & 365d)
    await kv.put(
      'history:92301',
      JSON.stringify({
        photos: [],
        links: [
          {
            id: 'l_legacy_old',
            url: 'https://legacy-old.example.com',
            snippet: 'legacy old',
            sender: 'visitor',
            at: new Date(oldTs).toISOString(),
          },
        ],
        pmMessageIds: [],
        messages: [
          {
            id: 'm_legacy_old',
            sender: 'visitor',
            text: '220天前的老消息',
            mediaTag: '',
            photoFileId: '',
            thumbFileId: '',
            pmMessageId: 10,
            topicMsgId: null,
            at: new Date(oldTs).toISOString(),
          },
        ],
      })
    );
    await migrateVisitor(env, '92301');

    // Insert 12 expired messages (each with a linked URL) + 2 recent messages (with a linked URL)
    const store = getStore(env);
    for (let i = 1; i <= 12; i += 1) {
      const ts = midnightUtc - (200 + i) * dayMs;
      await store.appendExchange('92301', {
        sender: 'visitor',
        nowMs: ts,
        nowIso: new Date(ts).toISOString(),
        text: `expired-${i} https://expired-${i}.example.com`,
        urls: [`https://expired-${i}.example.com`],
        pmMessageId: 100 + i,
      });
    }
    // Also attach a slightly timestamp-skewed link directly to `m_legacy_old` to prove paired deletion by (uid, message_id)
    await db
      .prepare(
        `INSERT INTO message_links (message_id, uid, url, snippet, sender, created_at)
         VALUES ('m_legacy_old', '92301', 'https://skewed.example.com', 'skew', 'visitor', ?)`
      )
      .bind(recentTs)
      .run();

    for (let i = 1; i <= 2; i += 1) {
      const ts = recentTs + i * 1000;
      await store.appendExchange('92301', {
        sender: 'admin',
        nowMs: ts,
        nowIso: new Date(ts).toISOString(),
        text: `fresh-${i} https://fresh-${i}.example.com`,
        urls: [`https://fresh-${i}.example.com`],
        pmMessageId: 200 + i,
      });
    }

    // Default config (`chatRetentionDays: 0`, permanent) -> deletes ZERO messages or links
    const permRes = await cleanupExpiredMaps(env, midnightUtc, { retentionDays: 0 });
    expect(permRes.deletedMessages).toBe(0);
    expect(permRes.deletedLinks).toBe(0);
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE uid = '92301'`).first()).cnt).toBe(15);

    // Batched cleanup with retentionDays = 180, batchSize = 5, maxBatches = 2 -> deletes 10 expired messages on Day 1
    // (total expired = 13: m_legacy_old + 12 expired-*), leaving 3 expired + 2 fresh for Day 2
    const day1 = await cleanupExpiredMaps(env, midnightUtc, {
      retentionDays: 180,
      batchSize: 5,
      maxBatches: 2,
    });
    expect(day1.deletedMessages).toBe(10);
    expect(day1.retentionBatches).toBe(2);
    expect(day1.hasMoreExpired).toBe(true);
    expect((await db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE uid = '92301'`).first()).cnt).toBe(5);

    // Day 2 scheduled cron with saved config `chatRetentionDays: 180` finishes the remaining 3 expired messages
    // AND writes 0 KV keys during scheduled execution
    await savePanelConfig(env, { pmBot: { chatRetentionDays: 180 } });
    expect((await loadPanelConfig(env)).pmBot.chatRetentionDays).toBe(180);

    const kvPutSpy = vi.spyOn(kv, 'put');
    const kvDeleteSpy = vi.spyOn(kv, 'delete');
    await worker.scheduled({ scheduledTime: midnightUtc }, env, null);

    expect(kvPutSpy).not.toHaveBeenCalled();
    expect(kvDeleteSpy).not.toHaveBeenCalled();

    // Only the 2 fresh messages and 2 fresh links remain; even the skewed link on `m_legacy_old` is gone
    const remMsgs = (await db.prepare(`SELECT text FROM messages WHERE uid = '92301' ORDER BY created_at ASC`).all())
      .results;
    const remLinks = (
      await db.prepare(`SELECT url FROM message_links WHERE uid = '92301' ORDER BY created_at ASC`).all()
    ).results;
    expect(remMsgs.map((r) => r.text)).toEqual([
      'fresh-1 https://fresh-1.example.com',
      'fresh-2 https://fresh-2.example.com',
    ]);
    expect(remLinks.map((r) => r.url)).toEqual(['https://fresh-1.example.com', 'https://fresh-2.example.com']);

    // KV legacy backup is untouched, AND reading history again does NOT re-import deleted expired messages
    expect(await kv.get('history:92301')).toBeTruthy();
    const afterCleanupHist = await getVisitorHistory(env, '92301');
    expect(afterCleanupHist.messages).toHaveLength(2);
    expect(afterCleanupHist.messages.every((m) => m.text.startsWith('fresh-'))).toBe(true);
    expect(RETENTION_DELETE_BATCH_SIZE).toBe(500);
  });

  it('enforces admin auth, zero KV reads in KV mode, strict cursor validation, and around fallback on /api/admin/search and /history', async () => {
    const botToken = '123456:STAGE2_API_TEST';
    const kv = createMemoryKV();
    const nowSec = Math.floor(Date.now() / 1000);
    const adminInit = await signInitData(
      { auth_date: String(nowSec), user: JSON.stringify({ id: 10001, first_name: 'Owner' }) },
      botToken
    );
    const guestInit = await signInitData(
      { auth_date: String(nowSec), user: JSON.stringify({ id: 20002, first_name: 'Guest' }) },
      botToken
    );

    const kvOnlyEnv = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' };

    // 1. Non-admin gets 403 on /api/admin/search with 0 KV reads
    const kvGetSpy = vi.spyOn(kv, 'get');
    const kvListSpy = vi.spyOn(kv, 'list');
    const guestSearch = await worker.fetch(
      new Request('https://panel.test/api/admin/search?q=hello', {
        headers: { 'X-Telegram-Init-Data': guestInit },
      }),
      kvOnlyEnv
    );
    expect(guestSearch.status).toBe(403);
    expect(kvGetSpy).not.toHaveBeenCalled();
    expect(kvListSpy).not.toHaveBeenCalled();

    // 2. KV-only mode returns 400 on /api/admin/search with ZERO KV reads
    const kvModeSearch = await worker.fetch(
      new Request('https://panel.test/api/admin/search?q=hello', {
        headers: { 'X-Telegram-Init-Data': adminInit },
      }),
      kvOnlyEnv
    );
    expect(kvModeSearch.status).toBe(400);
    const kvModeSearchJson = await kvModeSearch.json();
    expect(kvModeSearchJson).toMatchObject({ ok: false, mode: 'kv', d1Bound: false });
    expect(kvGetSpy).not.toHaveBeenCalled();
    expect(kvListSpy).not.toHaveBeenCalled();

    // 3. Seed D1 data for two visitors
    const db = createD1Shim();
    const d1Env = { ...kvOnlyEnv, DB: db };
    await upsertVisitorProfile(d1Env, { id: 92401, first_name: 'Alice', username: 'alice_tg' });
    await upsertVisitorProfile(d1Env, { id: 92402, first_name: 'Bob', username: 'bob_tg' });

    const baseTs = Date.UTC(2026, 4, 1, 12, 0, 0);
    const aliceIds = [];
    for (let i = 1; i <= 8; i += 1) {
      const ts = baseTs + i * 60_000;
      const res = await getStore(d1Env).appendExchange('92401', {
        sender: i % 2 === 0 ? 'admin' : 'visitor',
        nowMs: ts,
        nowIso: new Date(ts).toISOString(),
        text: i === 3 ? '关于 100% 返现的说明' : `Alice 消息 #${i}`,
        pmMessageId: i,
      });
      aliceIds.push(res.message.id);
    }
    await getStore(d1Env).appendExchange('92402', {
      sender: 'visitor',
      nowMs: baseTs + 9 * 60_000,
      nowIso: new Date(baseTs + 9 * 60_000).toISOString(),
      text: 'Bob 提到 100% 折扣和 1000 元',
      pmMessageId: 1,
    });

    // 4. /api/admin/search validates empty q, overlong q, bad uid, bad cursor ints, and inverted date range
    for (const badUrl of [
      'https://panel.test/api/admin/search?q=',
      `https://panel.test/api/admin/search?q=${'x'.repeat(MAX_SEARCH_QUERY_LEN + 1)}`,
      'https://panel.test/api/admin/search?q=hi&uid=abc',
      'https://panel.test/api/admin/search?q=hi&before=notanint',
      'https://panel.test/api/admin/search?q=hi&beforeId=5',
      'https://panel.test/api/admin/search?q=hi&before=1700000000000&beforeId=3.5',
      'https://panel.test/api/admin/search?q=hi&from=2026-06-02&to=2026-06-01',
    ]) {
      const badRes = await worker.fetch(
        new Request(badUrl, { headers: { 'X-Telegram-Init-Data': adminInit } }),
        d1Env
      );
      expect(badRes.status).toBe(400);
    }

    // 5. Successful search enriches visitor displayName/username, escapes `%`, supports limit + cursor
    const searchRes1 = await (
      await worker.fetch(
        new Request('https://panel.test/api/admin/search?q=100%25&limit=1', {
          headers: { 'X-Telegram-Init-Data': adminInit },
        }),
        d1Env
      )
    ).json();
    expect(searchRes1.ok).toBe(true);
    expect(searchRes1.d1Bound).toBe(true);
    expect(searchRes1.items).toHaveLength(1);
    expect(searchRes1.items[0].uid).toBe('92402');
    expect(searchRes1.items[0].visitor).toMatchObject({ userId: '92402', displayName: 'Bob', username: 'bob_tg' });
    expect(searchRes1.hasMore).toBe(true);
    expect(searchRes1.nextCursor).toBeTruthy();

    const searchRes2 = await (
      await worker.fetch(
        new Request(
          `https://panel.test/api/admin/search?q=100%25&limit=1&before=${searchRes1.nextCursor.before}&beforeId=${searchRes1.nextCursor.beforeId}`,
          { headers: { 'X-Telegram-Init-Data': adminInit } }
        ),
        d1Env
      )
    ).json();
    expect(searchRes2.ok).toBe(true);
    expect(searchRes2.items).toHaveLength(1);
    expect(searchRes2.items[0].uid).toBe('92401');
    expect(searchRes2.items[0].id).toBe(aliceIds[2]);
    expect(searchRes2.items[0].visitor).toMatchObject({ userId: '92401', displayName: 'Alice', username: 'alice_tg' });
    expect(searchRes2.hasMore).toBe(false);

    // 6. /api/admin/visitors/:uid/history validates integer cursor params and mutually exclusive modes
    for (const badHistUrl of [
      'https://panel.test/api/admin/visitors/92401/history?before=abc',
      'https://panel.test/api/admin/visitors/92401/history?before=1700000000000&beforeId=-1',
      'https://panel.test/api/admin/visitors/92401/history?beforeId=12',
      'https://panel.test/api/admin/visitors/92401/history?after=12.34',
      'https://panel.test/api/admin/visitors/92401/history?afterId=12',
      'https://panel.test/api/admin/visitors/92401/history?limit=0',
      'https://panel.test/api/admin/visitors/92401/history?before=1700000000000&after=1700000000000',
      'https://panel.test/api/admin/visitors/92401/history?around=m_1&before=1700000000000',
    ]) {
      const badRes = await worker.fetch(
        new Request(badHistUrl, { headers: { 'X-Telegram-Init-Data': adminInit } }),
        d1Env
      );
      expect(badRes.status).toBe(400);
    }

    // 7. /history pagination + around jump + graceful around fallback
    const page1 = await (
      await worker.fetch(
        new Request('https://panel.test/api/admin/visitors/92401/history?limit=3', {
          headers: { 'X-Telegram-Init-Data': adminInit },
        }),
        d1Env
      )
    ).json();
    expect(page1.ok).toBe(true);
    expect(page1.d1Bound).toBe(true);
    expect(page1.hasMore).toBe(true);
    expect(page1.hasNewer).toBe(false);
    expect(page1.messages.map((m) => m.id)).toEqual(aliceIds.slice(5, 8));
    expect(Number.isSafeInteger(page1.oldestCursor?.ts)).toBe(true);
    expect(Number.isSafeInteger(page1.oldestCursor?.id)).toBe(true);

    const page2 = await (
      await worker.fetch(
        new Request(
          `https://panel.test/api/admin/visitors/92401/history?limit=3&before=${page1.oldestCursor.ts}&beforeId=${page1.oldestCursor.id}&messagesOnly=1`,
          { headers: { 'X-Telegram-Init-Data': adminInit } }
        ),
        d1Env
      )
    ).json();
    expect(page2.ok).toBe(true);
    expect(page2.hasMore).toBe(true);
    expect(page2.messages.map((m) => m.id)).toEqual(aliceIds.slice(2, 5));

    const jumped = await (
      await worker.fetch(
        new Request(
          `https://panel.test/api/admin/visitors/92401/history?around=${encodeURIComponent(aliceIds[2])}&limit=3`,
          { headers: { 'X-Telegram-Init-Data': adminInit } }
        ),
        d1Env
      )
    ).json();
    expect(jumped.ok).toBe(true);
    expect(jumped.aroundFound).toBe(true);
    expect(jumped.hasMore).toBe(true);
    expect(jumped.hasNewer).toBe(true);
    expect(jumped.messages.map((m) => m.id)).toEqual(aliceIds.slice(1, 4));

    const jumpedMissing = await (
      await worker.fetch(
        new Request('https://panel.test/api/admin/visitors/92401/history?around=m_recalled_404&limit=3', {
          headers: { 'X-Telegram-Init-Data': adminInit },
        }),
        d1Env
      )
    ).json();
    expect(jumpedMissing.ok).toBe(true);
    expect(jumpedMissing.aroundFound).toBe(false);
    expect(jumpedMissing.hasNewer).toBe(false);
    expect(jumpedMissing.messages.map((m) => m.id)).toEqual(aliceIds.slice(5, 8));

    // Also direct call to searchVisitorMessages in KV mode stays zero-KV-read
    const directKv = createMemoryKV();
    const directGetSpy = vi.spyOn(directKv, 'get');
    const directSearch = await searchVisitorMessages({ TOPIC_MAP: directKv }, { q: 'anything' });
    expect(directSearch.supported).toBe(false);
    expect(directGetSpy).not.toHaveBeenCalled();
  });

  it('replaces overlapping tail window on live poll (syncing recalls & reactions) while preserving scrolled-up older messages', () => {
    const makeMsg = (n, extra = {}) => ({
      id: `m_${n}`,
      sender: n % 2 === 0 ? 'admin' : 'visitor',
      text: `msg-${n}`,
      at: new Date(1710000000000 + n * 1000).toISOString(),
      ...extra,
    });

    // 1. User scrolled up to load m_1..m_120 (`m_1..m_60` older page + `m_61..m_120` initial tail)
    const olderState = {
      messages: Array.from({ length: 120 }, (_, i) => makeMsg(i + 1)),
      hasMore: true,
      oldestCursor: { ts: 1710000001000, id: 1 },
      newestCursor: { ts: 1710000120000, id: 120 },
    };

    // Next 6s poll fetches newest 60: m_118 was recalled, m_119 gained reactions, m_121 arrived
    const polledTail = [];
    for (let n = 62; n <= 121; n += 1) {
      if (n === 118) continue; // recalled
      if (n === 119) {
        polledTail.push(makeMsg(n, { visitorReaction: '❤️', ownerReaction: '👍' }));
      } else {
        polledTail.push(makeMsg(n));
      }
    }
    const merged = mergeLatestHistoryTail(olderState, {
      messages: polledTail,
      hasMore: true,
      oldestCursor: { ts: 1710000062000, id: 62 },
      newestCursor: { ts: 1710000121000, id: 121 },
    });

    // Older scrolled-up messages m_1..m_61 are untouched, oldestCursor preserved
    expect(merged.messages.slice(0, 61).map((m) => m.id)).toEqual(
      Array.from({ length: 61 }, (_, i) => `m_${i + 1}`)
    );
    expect(merged.hasMore).toBe(true);
    expect(merged.oldestCursor).toEqual({ ts: 1710000001000, id: 1 });
    expect(merged.newestCursor).toEqual({ ts: 1710000121000, id: 121 });

    // Recalled m_118 is gone, m_119 reactions synced, m_121 appended
    expect(merged.messages.some((m) => m.id === 'm_118')).toBe(false);
    expect(merged.messages.find((m) => m.id === 'm_119')).toMatchObject({
      visitorReaction: '❤️',
      ownerReaction: '👍',
    });
    expect(merged.messages.at(-1).id).toBe('m_121');

    // 2. Reaction cleared & boundary message m_61 recalled (latest now starts at m_60)
    const boundaryTail = [makeMsg(60)];
    for (let n = 62; n <= 121; n += 1) {
      if (n === 118) continue;
      boundaryTail.push(makeMsg(n)); // m_119 reactions cleared
    }
    const afterBoundaryRecall = mergeLatestHistoryTail(merged, {
      messages: boundaryTail,
      hasMore: true,
      oldestCursor: { ts: 1710000060000, id: 60 },
      newestCursor: { ts: 1710000121000, id: 121 },
    });
    expect(afterBoundaryRecall.messages.some((m) => m.id === 'm_61')).toBe(false);
    expect(afterBoundaryRecall.messages.find((m) => m.id === 'm_119')?.visitorReaction).toBeUndefined();
    expect(afterBoundaryRecall.messages.slice(0, 60).map((m) => m.id)).toEqual(
      Array.from({ length: 60 }, (_, i) => `m_${i + 1}`)
    );

    // 3. Complete conversation (`hasMore: false`): recall of oldest message m_1 removes it cleanly
    const smallState = {
      messages: [makeMsg(1), makeMsg(2), makeMsg(3)],
      hasMore: false,
      oldestCursor: { ts: 1710000001000, id: 1 },
      newestCursor: { ts: 1710000003000, id: 3 },
    };
    const smallAfter = mergeLatestHistoryTail(smallState, {
      messages: [makeMsg(2), makeMsg(3)],
      hasMore: false,
      oldestCursor: { ts: 1710000002000, id: 2 },
      newestCursor: { ts: 1710000003000, id: 3 },
    });
    expect(smallAfter.messages.map((m) => m.id)).toEqual(['m_2', 'm_3']);

    // 4. Disjoint burst (>60 new messages, zero overlap) resets to latest window without leaving an invisible gap
    const disjoint = mergeLatestHistoryTail(olderState, {
      messages: [makeMsg(201), makeMsg(202)],
      hasMore: true,
      oldestCursor: { ts: 1710000201000, id: 201 },
      newestCursor: { ts: 1710000202000, id: 202 },
    });
    expect(disjoint.messages.map((m) => m.id)).toEqual(['m_201', 'm_202']);
    expect(disjoint.oldestCursor).toEqual({ ts: 1710000201000, id: 201 });

    // 5. History cleared on server -> empty list
    expect(mergeLatestHistoryTail(olderState, { messages: [], hasMore: false }).messages).toEqual([]);

    // 6. Prepend / append dedup, cursor URL formatting & highlight segmentation
    expect(prependOlderHistory([makeMsg(3), makeMsg(4)], [makeMsg(1), makeMsg(2), makeMsg(3)]).map((m) => m.id)).toEqual([
      'm_1',
      'm_2',
      'm_3',
      'm_4',
    ]);
    expect(appendNewerHistory([makeMsg(1), makeMsg(2)], [makeMsg(2), makeMsg(3)]).map((m) => m.id)).toEqual([
      'm_1',
      'm_2',
      'm_3',
    ]);
    expect(buildHistoryUrl('92401', { limit: 60, beforeCursor: { ts: 1710000001000, id: 42 }, messagesOnly: true })).toBe(
      '/api/admin/visitors/92401/history?limit=60&before=1710000001000&beforeId=42&messagesOnly=1'
    );
    expect(buildSearchUrl({ q: '50%', uid: '92401', cursor: { before: 1710000001000, beforeId: 9 } })).toBe(
      '/api/admin/search?q=50%25&uid=92401&before=1710000001000&beforeId=9'
    );
    expect(splitHighlightSegments('Hello Rose hello', 'hello')).toEqual([
      { text: 'Hello', match: true },
      { text: ' Rose ', match: false },
      { text: 'hello', match: true },
    ]);
  });
});
