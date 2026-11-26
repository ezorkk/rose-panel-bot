import { describe, expect, it, vi } from 'vitest';
import {
  ALERT_STATE_KEY,
  ALERT_TOPIC_ID_KEY,
  evaluateProbeAlerts,
  formatAlertMessage,
  runProbeAlerts,
  sendAlertNotification,
} from '../src/worker/alerts.js';
import { assessIncomingRisk, checkCasBlacklist, normalizeAntiSpamText } from '../src/worker/antispam.js';
import { signMediaToken, verifyMediaToken, verifyTelegramInitData } from '../src/worker/auth.js';
import {
  buildVisitorCardCaption,
  buildVisitorCardText,
  completeTurnstileVerification,
  generateInlineChallenge,
  generateStickerChallenge,
  handleTelegramUpdate,
  initiateChatFromMiniApp,
  matchKeywordReply,
  parseStickerQuizInput,
} from '../src/worker/bot.js';
import { getLeaderboard, getMemberTicket, performCheckin, resolveLevel } from '../src/worker/checkin.js';
import {
  DEFAULT_CONFIG,
  loadPanelConfig,
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
  resolveInboxMode,
} from '../src/worker/inbox.js';
import worker from '../src/worker/index.js';
import { fetchKomariStatus, normalizeNodeMetrics } from '../src/worker/komari.js';
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
import pkg from '../package.json' with { type: 'json' };
import {
  applyVisitorAction,
  buildSourceLink,
  clearVisitorHistory,
  computeSourceStats,
  extractLinksFromMessage,
  extractPhotoFromMessage,
  getVisitorDetail,
  getVisitorHistory,
  getVisitorOverview,
  listVisitors,
  normalizeSourceParam,
  recordVisitorExchange,
  rememberPendingSource,
  upsertVisitorProfile,
} from '../src/worker/visitors.js';
import {
  buildSourceLink as buildClientSourceLink,
  normalizeSourceParam as normalizeClientSourceParam,
} from '../web/src/lib/telegram.js';

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
    const env = { TOPIC_MAP: createMemoryKV() };
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
    const env = { TOPIC_MAP: kv, SUPERGROUP_ID: '-1001234567890' };

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
      const env = { TOPIC_MAP: createMemoryKV() };
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
    const env = { TOPIC_MAP: createMemoryKV() };
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
      const env = { TOPIC_MAP: createMemoryKV() };
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
    const env = {
      TOPIC_MAP: createMemoryKV(),
      BOT_TOKEN: token,
      ADMIN_IDS: '10001',
    };

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
    const env = {
      TOPIC_MAP: createMemoryKV(),
      BOT_TOKEN: token,
      ADMIN_IDS: '10001',
    };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '111222:MEDIA_TEST_SECRET',
      SUPERGROUP_ID: '-100999888',
      ADMIN_IDS: '10001',
    };

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
    const env = { TOPIC_MAP: kv };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '123456:BIND_TEST_TOKEN',
      ADMIN_IDS: '10001',
    };

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
  const baseEnv = () => ({
    TOPIC_MAP: createMemoryKV(),
    BOT_TOKEN: '987654:UNIT_TEST_BOT_TOKEN',
    ADMIN_IDS: '10001',
    WEBHOOK_SECRET: 'unit-test-secret',
  });
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
  const env = () => ({ TOPIC_MAP: createMemoryKV() });

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
    const testEnv = { TOPIC_MAP: kv, BOT_TOKEN: '123:ABC', ADMIN_IDS: '10001', DEV_PREVIEW: 'true' };
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
    const env = { TOPIC_MAP: kv };
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
    const env = { TOPIC_MAP: kv };
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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '123:ENV_TOK_TEST',
      ADMIN_IDS: '10001',
      DEV_PREVIEW: 'true',
      GITHUB_UPDATE_TOKEN: 'env_super_secret_pat',
    };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '123:UPD_TEST',
      ADMIN_IDS: '10001',
      DEV_PREVIEW: 'true',
    };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '555000:AVATAR_TEST_TOKEN',
      ADMIN_IDS: '999888',
    };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '777000:CARD_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100999888',
    };
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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '777000:CARD_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100999888',
    };
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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '888000:WELCOME_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100999888',
    };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '999000:AUTOREPLY_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100777666',
    };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '999000:AUTOREPLY_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100777666',
    };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '999000:EDGE', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '999000:EDGE', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '999000:EDGE' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '999000:EDGE', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100777' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:LABELS', ADMIN_IDS: '10001' };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '555111:HONEYPOT_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100888999',
    };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '555111:HONEYPOT_TEST_TOKEN',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100888999',
    };

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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:SOC', ADMIN_IDS: '10001' };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100555666',
    };

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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '555:REFRESH',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100123',
      TURNSTILE_SITE_KEY: 'site',
      TURNSTILE_SECRET: 'secret',
    };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001', SUPERGROUP_ID: '-100124' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' };
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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100888777',
    };

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
    expect(await resolveInboxMode({ TOPIC_MAP: kv })).toBe('off');
    expect(getOwnerChatId({ TOPIC_MAP: kv })).toBe('');

    expect(await resolveInboxMode({ TOPIC_MAP: kv, ADMIN_IDS: '10001, 10002' })).toBe('dm');
    expect(getOwnerChatId({ TOPIC_MAP: kv, ADMIN_IDS: '10001, 10002' })).toBe('10001');

    expect(await resolveInboxMode({ TOPIC_MAP: kv, ADMIN_IDS: '10001', SUPERGROUP_ID: '-100123' })).toBe('topic');

    // KV-bound supergroup also selects topic mode immediately
    await kv.put('config:supergroup_id', '-100456');
    expect(await resolveInboxMode({ TOPIC_MAP: kv, ADMIN_IDS: '10001' })).toBe('topic');
  });

  it('pushes visitor card on demand (10min / visitor switch), copies message verbatim, and records dmmap & archive', async () => {
    const kv = createMemoryKV();
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:DM_PUSH', ADMIN_IDS: '10001,10002' };
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
      // Both header card and copied message mapped to visitor 20001
      expect(await kv.get(`${DM_MAP_PREFIX}501`)).toBe('20001');
      expect(await kv.get(`${DM_MAP_PREFIX}502`)).toBe('20001');

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
      expect(await kv.get(`${DM_MAP_PREFIX}503`)).toBe('20001');

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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:DM_REPLY', ADMIN_IDS: '10001' };
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
      expect(await kv.get(`${DM_MAP_PREFIX}601`)).toBe('20001');

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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:DM_HINT', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:DM_CMD', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001' };
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
    const dmEnv = { TOPIC_MAP: dmKv, BOT_TOKEN: '123:DM_KW', ADMIN_IDS: '10001' };
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
    const topicEnv = {
      TOPIC_MAP: topicKv,
      BOT_TOKEN: '123:TOPIC_REG',
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100999111',
    };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:DM_COADMIN', ADMIN_IDS: '10001,10002' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:DM_400', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:DM_UNKNOWN_CMD', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:INBOX_OFF' };

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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:ALERT', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:ALERT_OFF', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:PROBE_DOWN', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:FIRST_MUTE', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:RES', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:ZERO_WRITE', ADMIN_IDS: '10001' };
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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '10001',
      SUPERGROUP_ID: '-100555999',
      BOT_USERNAME: 'RoseTest_bot',
      APP_SHORT_NAME: 'panel',
    };
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
    const env = { TOPIC_MAP: kv, ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:REBIND', ADMIN_IDS: '10001', SUPERGROUP_ID: '-100111' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: '123:EMPTY', ADMIN_IDS: '10001' };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '10001', BOT_USERNAME: 'RoseTest_bot' };
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
    return {
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
    };
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
    const config = await loadPanelConfig({ TOPIC_MAP: kv });

    const withDirect = sanitizePublicConfig(
      config,
      { TOPIC_MAP: kv, BOT_USERNAME: '@Rose202_bot', APP_SHORT_NAME: 'panel' },
      false,
      'https://panel.example.com'
    );
    expect(withDirect.shareUrl).toBe('https://t.me/Rose202_bot/panel');

    const withoutAppShort = sanitizePublicConfig(
      config,
      { TOPIC_MAP: kv, BOT_USERNAME: 'Rose202_bot' },
      false,
      'https://panel.example.com'
    );
    expect(withoutAppShort.shareUrl).toBe('https://panel.example.com/');

    const withoutBot = sanitizePublicConfig(config, { TOPIC_MAP: kv }, false, 'https://panel.example.com');
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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '123456:TEST_TOKEN',
      ADMIN_IDS: '999001',
    };
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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '123456:TEST_TOKEN',
      ADMIN_IDS: '999001',
    };
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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: '123456:TEST_TOKEN',
      ADMIN_IDS: '999001',
    };
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
    const env = {
      TOPIC_MAP: kv,
      BOT_TOKEN: botToken,
      ADMIN_IDS: '999001',
    };
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
    const env = { TOPIC_MAP: kv, ADMIN_IDS: '999001' };

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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '900001' };

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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '900001', DEV_PREVIEW: 'true' };

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
    const env = { TOPIC_MAP: kv };
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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '900001' };

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
    const env = { TOPIC_MAP: kv, BOT_TOKEN: botToken, ADMIN_IDS: '900001' };

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
    const env = { TOPIC_MAP: kv };
    const cfg = await loadPanelConfig(env);
    expect(cfg.profile.showPoweredBy).toBe(true);

    const pub = sanitizePublicConfig(cfg, env, false);
    expect(pub.profile.showPoweredBy).toBe(true);
  });

  it('persists showPoweredBy: false and normalizes non-boolean values to strict booleans', async () => {
    const kv = createMemoryKV();
    const env = { TOPIC_MAP: kv };

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
    const env = { TOPIC_MAP: kv };
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
