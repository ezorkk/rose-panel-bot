// Mini App REST API router (/api/*)

import { sendTestProbeAlert } from './alerts.js';
import { getBlockedSpamCount } from './antispam.js';
import { authenticateRequest, parseAdminIds, signMediaToken, verifyMediaToken } from './auth.js';
import {
  checkRateLimit,
  initiateChatFromMiniApp,
  resolveBotUsername,
  sendAdminDirectVisitorReply,
  syncTelegramBotSurface,
} from './bot.js';
import { getLeaderboard, getMemberTicket, performCheckin } from './checkin.js';
import {
  BADGE_CATALOG,
  LEVELS,
  loadPanelConfig,
  sanitizeAdminConfig,
  sanitizePublicConfig,
  savePanelConfig,
} from './config.js';
import { fetchProbeStatus } from './komari.js';
import { isOwnerUnreachable, resolveInboxMode } from './inbox.js';
import { checkLatestRelease, syncForkWithUpstream } from './updater.js';
import { APP_VERSION } from './version.js';
import {
  handleAvatarProxy,
  handleSignedMediaProxy,
  handleStickerProxy,
  normalizeStickerObject,
  parseStickerPackName,
  tgCall,
} from './telegram.js';
import {
  applyVisitorAction,
  clearVisitorHistory,
  getVisitorDetail,
  getVisitorHistory,
  getVisitorOverview,
  listVisitors,
  recallAdminVisitorMessage,
} from './visitors.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function loadAdminInboxStatus(env) {
  const inboxMode = await resolveInboxMode(env);
  const ownerUnreachable = inboxMode === 'dm' ? await isOwnerUnreachable(env) : false;
  return { inboxMode, ownerUnreachable };
}

export async function handleApiRequest(request, env, url, ctx = null) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // Privacy-safe owner/bot card avatar proxy (never leaks numeric owner UID or BOT_TOKEN)
  // Strictly obeys server-stored config.profile.avatarMode; ignores any client query override.
  if (path === '/api/avatar/owner' && method === 'GET') {
    const cfg = await loadPanelConfig(env);
    const botUid = String(env.BOT_TOKEN || '').split(':')[0];
    if (cfg.profile.avatarMode === 'owner') {
      const ownerUid = Array.from(parseAdminIds(env))[0] || '';
      if (ownerUid) {
        const ownerRes = await handleAvatarProxy(env, ownerUid);
        if (ownerRes.ok) return ownerRes;
      }
    }
    return handleAvatarProxy(env, botUid);
  }

  // Avatar proxy (safe public cache, never leaks BOT_TOKEN)
  const avatarMatch = path.match(/^\/api\/avatar\/(\d+)$/);
  if (avatarMatch && method === 'GET') {
    return handleAvatarProxy(env, avatarMatch[1]);
  }

  // Telegram Sticker / Custom Emoji proxy (supports .webp, .webm, and auto-decompressed .tgs Lottie JSON)
  const stickerMatch = path.match(/^\/api\/sticker\/([^/]+)$/);
  if (stickerMatch && method === 'GET') {
    return handleStickerProxy(env, stickerMatch[1]);
  }

  // HMAC-signed private media proxy for visitor chat photos (admin-issued short-lived token)
  const mediaMatch = path.match(/^\/api\/media\/([^/]+)$/);
  if (mediaMatch && method === 'GET') {
    const fileId = decodeURIComponent(mediaMatch[1]);
    const exp = url.searchParams.get('exp');
    const sig = url.searchParams.get('sig');
    const valid = await verifyMediaToken(fileId, exp, sig, env.BOT_TOKEN);
    if (!valid) {
      return json({ ok: false, error: 'Invalid or expired media signature' }, 403);
    }
    return handleSignedMediaProxy(env, fileId);
  }

  // Authenticate all other API endpoints via Telegram initData HMAC-SHA256
  const auth = await authenticateRequest(request, env, tgCall);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error || 'Unauthorized' }, auth.status || 401);
  }

  const config = await loadPanelConfig(env);

  // GET /api/bootstrap
  if (path === '/api/bootstrap' && method === 'GET') {
    let checkin = null;
    if (config.community.enableCheckin && auth.user) {
      checkin = await getMemberTicket(env, auth.user, config.community);
    }

    let visitorSummary = null;
    let recentVisitors = [];
    let blockedSpamCount = 0;
    let inboxStatus = null;
    if (auth.isAdmin) {
      const [overview, spamCount, status] = await Promise.all([
        getVisitorOverview(env),
        getBlockedSpamCount(env),
        loadAdminInboxStatus(env),
      ]);
      visitorSummary = overview.stats;
      recentVisitors = overview.recent;
      blockedSpamCount = spamCount;
      inboxStatus = status;
    }

    return json({
      ok: true,
      user: auth.user,
      isAdmin: auth.isAdmin,
      isPreview: auth.isPreview,
      startParam: auth.startParam,
      config: sanitizePublicConfig(config, env, auth.isAdmin, url.origin),
      adminConfig: auth.isAdmin ? sanitizeAdminConfig(config, env, inboxStatus) : null,
      checkin,
      levels: LEVELS,
      badges: BADGE_CATALOG,
      visitorSummary,
      recentVisitors,
      blockedSpamCount,
      appVersion: auth.isAdmin ? APP_VERSION : undefined,
    });
  }

  // POST /api/chat/start — wakes up private verification or chat prompt when user taps `[发私信]` inside Mini App
  if (path === '/api/chat/start' && method === 'POST') {
    if (!auth.user?.id) {
      return json({ ok: true, needsDeepLink: true });
    }
    const body = await readJsonBody(request);
    const source = typeof body?.source === 'string' ? body.source : '';
    const chatRes = await initiateChatFromMiniApp(env, url.origin, auth.user, config, { source });
    return json({ ok: true, ...chatRes });
  }

  // POST /api/checkin
  if (path === '/api/checkin' && method === 'POST') {
    if (!config.community.enableCheckin) {
      return json({ ok: false, error: '当前未开启群签到积分功能' }, 403);
    }
    if (!auth.user) {
      return json({ ok: false, error: '请在 Telegram 内打开小程序以进行签到' }, 401);
    }
    const result = await performCheckin(env, auth.user, config.community);
    return json({ ok: true, ...result });
  }

  // GET /api/checkin/leaderboard
  if (path === '/api/checkin/leaderboard' && method === 'GET') {
    if (!config.community.enableCheckin) {
      return json({ ok: false, error: '当前未开启群签到积分功能' }, 403);
    }
    const board = await getLeaderboard(env, 30);
    return json({ ok: true, ...board });
  }

  // GET /api/probe
  if (path === '/api/probe' && method === 'GET') {
    if (config.probe.visibility === 'private' && !auth.isAdmin) {
      return json({ ok: false, error: '探针已设为仅站长可见' }, 403);
    }
    const force = url.searchParams.get('force') === '1' && auth.isAdmin;
    const probeData = await fetchProbeStatus(env, config.probe, { forceRefresh: force });
    return json({ ok: true, ...probeData });
  }

  // --- Admin-only endpoints ---
  if (path.startsWith('/api/admin/')) {
    if (!auth.isAdmin) {
      return json({ ok: false, error: '仅管理员有权访问此接口' }, 403);
    }

    // GET /api/admin/visitors
    if (path === '/api/admin/visitors' && method === 'GET') {
      const search = url.searchParams.get('q') || '';
      const filter = url.searchParams.get('filter') || 'all';
      const [data, blockedSpamCount] = await Promise.all([
        listVisitors(env, { search, filter, limit: 80 }),
        getBlockedSpamCount(env),
      ]);
      return json({ ok: true, ...data, blockedSpamCount });
    }

    // GET /api/admin/visitors/:userId
    const visitorMatch = path.match(/^\/api\/admin\/visitors\/(\d+)$/);
    if (visitorMatch && method === 'GET') {
      const detail = await getVisitorDetail(env, visitorMatch[1]);
      if (!detail) return json({ ok: false, error: '未找到该访客记录' }, 404);
      return json({ ok: true, visitor: detail });
    }

    // GET /api/admin/visitors/:userId/history — archived messages, photos (with signed URLs) & links
    const historyMatch = path.match(/^\/api\/admin\/visitors\/(\d+)\/history$/);
    if (historyMatch && method === 'GET') {
      const uid = historyMatch[1];
      const [detail, history] = await Promise.all([
        getVisitorDetail(env, uid),
        getVisitorHistory(env, uid),
      ]);
      if (!detail) return json({ ok: false, error: '未找到该访客记录' }, 404);

      const signPhotoIds = async (fileId, thumbIdInput) => {
        if (!fileId || !env.BOT_TOKEN) return { url: '', thumbUrl: '' };
        const fullToken = await signMediaToken(fileId, env.BOT_TOKEN, 1800);
        const thumbId = thumbIdInput || fileId;
        const thumbToken =
          thumbId === fileId ? fullToken : await signMediaToken(thumbId, env.BOT_TOKEN, 1800);
        return {
          url: `/api/media/${encodeURIComponent(fileId)}?exp=${fullToken.exp}&sig=${fullToken.sig}`,
          thumbUrl: `/api/media/${encodeURIComponent(thumbId)}?exp=${thumbToken.exp}&sig=${thumbToken.sig}`,
        };
      };

      const [signedPhotos, signedMessages] = await Promise.all([
        Promise.all(
          history.photos.map(async (p) => {
            const urls = await signPhotoIds(p.fileId, p.thumbFileId);
            return {
              id: p.id,
              caption: p.caption || '',
              sender: p.sender || 'visitor',
              at: p.at,
              url: urls.url,
              thumbUrl: urls.thumbUrl,
            };
          })
        ),
        Promise.all(
          (history.messages || []).map(async (m) => {
            const urls = m.photoFileId ? await signPhotoIds(m.photoFileId, m.thumbFileId) : { url: '', thumbUrl: '' };
            return {
              id: m.id,
              sender: m.sender || 'visitor',
              text: m.text || '',
              mediaTag: m.mediaTag || '',
              pmMessageId: m.pmMessageId || null,
              at: m.at,
              photoUrl: urls.url,
              thumbUrl: urls.thumbUrl,
            };
          })
        ),
      ]);

      return json({
        ok: true,
        visitor: detail,
        photos: signedPhotos,
        links: history.links,
        messages: signedMessages,
      });
    }

    // POST /api/admin/visitors/:userId/reply — send direct text or photo reply from inside Mini App
    const replyMatch = path.match(/^\/api\/admin\/visitors\/(\d+)\/reply$/);
    if (replyMatch && method === 'POST') {
      const uid = replyMatch[1];
      const existingVisitor = await getVisitorDetail(env, uid);
      if (!existingVisitor) return json({ ok: false, error: '未找到该访客记录' }, 404);

      const ct = String(request.headers.get('content-type') || '').toLowerCase();
      // Reject oversized uploads before buffering the multipart body (10 MB photo + form overhead)
      const declaredLen = Number(request.headers.get('content-length') || 0);
      if (declaredLen > 11 * 1024 * 1024) {
        return json({ ok: false, error: '单张图片大小需在 10 MB 以内' }, 413);
      }
      let text = '';
      let photoFile = null;

      if (ct.includes('multipart/form-data')) {
        try {
          const form = await request.formData();
          text = String(form.get('text') || form.get('caption') || '').trim();
          const f = form.get('photo');
          if (f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && Number(f.size) > 0) {
            photoFile = f;
          }
        } catch {
          return json({ ok: false, error: '无法解析上传的图片表单' }, 400);
        }
      } else {
        const body = await readJsonBody(request);
        text = String(body?.text || '').trim();
      }

      try {
        const sent = await sendAdminDirectVisitorReply(env, url.origin, uid, { text, photoFile });
        let signedMessage = sent.message;
        if (signedMessage?.photoFileId && env.BOT_TOKEN) {
          const fullToken = await signMediaToken(signedMessage.photoFileId, env.BOT_TOKEN, 1800);
          const thumbId = signedMessage.thumbFileId || signedMessage.photoFileId;
          const thumbToken =
            thumbId === signedMessage.photoFileId
              ? fullToken
              : await signMediaToken(thumbId, env.BOT_TOKEN, 1800);
          signedMessage = {
            ...signedMessage,
            photoUrl: `/api/media/${encodeURIComponent(signedMessage.photoFileId)}?exp=${fullToken.exp}&sig=${fullToken.sig}`,
            thumbUrl: `/api/media/${encodeURIComponent(thumbId)}?exp=${thumbToken.exp}&sig=${thumbToken.sig}`,
          };
        }
        return json({ ok: true, visitor: sent.visitor, message: signedMessage });
      } catch (err) {
        return json({ ok: false, error: err.message || '发送失败' }, 400);
      }
    }

    // POST /api/admin/visitors/:userId/recall — recall a sent admin message from inside Mini App chat
    const recallMatch = path.match(/^\/api\/admin\/visitors\/(\d+)\/recall$/);
    if (recallMatch && method === 'POST') {
      const body = await readJsonBody(request);
      const pmMessageId = Number(body?.pmMessageId);
      // Never fall back to "most recent admin reply": a missing/garbled id must not recall the wrong message.
      if (!Number.isSafeInteger(pmMessageId) || pmMessageId <= 0) {
        return json({ ok: false, error: '缺少有效的 pmMessageId' }, 400);
      }
      const res = await recallAdminVisitorMessage(env, recallMatch[1], null, tgCall, pmMessageId);
      if (!res.ok) return json({ ok: false, error: res.error }, 400);
      return json({ ok: true, deletedPmMessageId: res.deletedPmMessageId });
    }

    // POST /api/admin/visitors/:userId/clear — clear archive or full topic + <48h PM history
    const clearMatch = path.match(/^\/api\/admin\/visitors\/(\d+)\/clear$/);
    if (clearMatch && method === 'POST') {
      const body = await readJsonBody(request);
      const mode = body?.mode === 'full' ? 'full' : 'archive';
      try {
        const result = await clearVisitorHistory(env, clearMatch[1], mode, tgCall);
        return json({ ok: true, mode, ...result });
      } catch (err) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    // POST /api/admin/visitors/:userId/action
    const actionMatch = path.match(/^\/api\/admin\/visitors\/(\d+)\/action$/);
    if (actionMatch && method === 'POST') {
      const body = await readJsonBody(request);
      if (!body?.action) return json({ ok: false, error: '缺少 action 参数' }, 400);
      try {
        const visitor = await applyVisitorAction(env, actionMatch[1], body.action, body);
        if (body.notifyUser && env.BOT_TOKEN) {
          if (body.action === 'close') {
            await tgCall(env, 'sendMessage', {
              chat_id: Number(actionMatch[1]),
              text: '🔒 当前对话已由站长关闭，感谢您的联系。',
            }).catch(() => {});
          } else if (body.action === 'open') {
            await tgCall(env, 'sendMessage', {
              chat_id: Number(actionMatch[1]),
              text: '🔓 站长已重新开启对话，您可以继续发送消息。',
            }).catch(() => {});
          }
        }
        return json({ ok: true, visitor });
      } catch (err) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    // POST /api/admin/sites/toggle — instant public/private toggle for a single site
    if (path === '/api/admin/sites/toggle' && method === 'POST') {
      const body = await readJsonBody(request);
      const siteId = String(body?.id || '');
      if (!siteId) return json({ ok: false, error: '缺少站点 ID' }, 400);

      let found = false;
      const nextSites = config.sites.map((s) => {
        if (String(s.id) !== siteId) return s;
        found = true;
        const nextVis =
          body.visibility === 'private' || body.visibility === 'public'
            ? body.visibility
            : s.visibility === 'private'
              ? 'public'
              : 'private';
        return { ...s, visibility: nextVis };
      });
      if (!found) return json({ ok: false, error: '未找到该站点' }, 404);

      const [saved, inboxStatus] = await Promise.all([
        savePanelConfig(env, { sites: nextSites }),
        loadAdminInboxStatus(env),
      ]);
      return json({
        ok: true,
        config: sanitizePublicConfig(saved, env, true, url.origin),
        adminConfig: sanitizeAdminConfig(saved, env, inboxStatus),
      });
    }

    // POST /api/admin/stickers/pack — fetch a Telegram Sticker or Custom Emoji pack by URL or name
    if (path === '/api/admin/stickers/pack' && method === 'POST') {
      const body = await readJsonBody(request);
      const packName = parseStickerPackName(body?.input || body?.name || '');
      if (!packName) {
        return json(
          { ok: false, error: '请输入有效的 Telegram 贴纸包/表情包链接（如 https://t.me/addstickers/... 或 https://t.me/addemoji/...）' },
          400
        );
      }
      try {
        const res = await tgCall(env, 'getStickerSet', { name: packName });
        const set = res?.result;
        const stickers = (set?.stickers || [])
          .slice(0, 60)
          .map(normalizeStickerObject)
          .filter(Boolean);
        return json({
          ok: true,
          name: set?.name || packName,
          title: set?.title || packName,
          stickerType: set?.sticker_type || 'regular',
          total: set?.stickers?.length || stickers.length,
          stickers,
        });
      } catch (err) {
        return json({ ok: false, error: `拉取贴纸包失败：${err.message}` }, 400);
      }
    }

    // GET /api/admin/config
    if (path === '/api/admin/config' && method === 'GET') {
      const inboxStatus = await loadAdminInboxStatus(env);
      return json({ ok: true, config: sanitizeAdminConfig(config, env, inboxStatus) });
    }

    // PUT /api/admin/config
    if (path === '/api/admin/config' && method === 'PUT') {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object') {
        return json({ ok: false, error: '无效的配置内容' }, 400);
      }
      const prevSurfaceSig = JSON.stringify({
        wt: config.pmBot?.welcomeText,
        sd: config.pmBot?.syncBotDescription,
        mb: config.pmBot?.showChatMenuButton,
        ck: config.community?.enableCheckin,
        bu: Boolean(env.BOT_USERNAME || config.botUsername),
      });
      // Cache @username & HTTPS siteOrigin in the same write as the owner's settings
      if (env.BOT_TOKEN && !env.BOT_USERNAME && !config.botUsername) {
        const uname = await resolveBotUsername(env, config);
        if (uname) body.botUsername = uname;
      }
      if (/^https:\/\//i.test(url.origin) && config.siteOrigin !== url.origin) {
        body.siteOrigin = url.origin;
      }
      const saved = await savePanelConfig(env, body);
      const nextSurfaceSig = JSON.stringify({
        wt: saved.pmBot?.welcomeText,
        sd: saved.pmBot?.syncBotDescription,
        mb: saved.pmBot?.showChatMenuButton,
        ck: saved.community?.enableCheckin,
        bu: Boolean(env.BOT_USERNAME || saved.botUsername),
      });

      // Sync Telegram description, menu button & commands only when Bot-surface fields changed (or @username uncached)
      if (env.BOT_TOKEN && /^https:\/\//i.test(url.origin) && prevSurfaceSig !== nextSurfaceSig) {
        const syncPromise = syncTelegramBotSurface(env, url.origin, saved, { persistUsername: false }).catch(
          () => {}
        );
        if (ctx?.waitUntil) {
          ctx.waitUntil(syncPromise);
        } else {
          await syncPromise;
        }
      }
      const [latestCfg, inboxStatus] = await Promise.all([
        loadPanelConfig(env),
        loadAdminInboxStatus(env),
      ]);
      return json({
        ok: true,
        config: sanitizePublicConfig(latestCfg, env, true, url.origin),
        adminConfig: sanitizeAdminConfig(latestCfg, env, inboxStatus),
      });
    }

    // POST /api/admin/probe/test
    if (path === '/api/admin/probe/test' && method === 'POST') {
      const body = await readJsonBody(request);
      const testProbeConfig = {
        ...config.probe,
        ...(body || {}),
        apiKey: body?.apiKey === '********' ? config.probe.apiKey : body?.apiKey ?? config.probe.apiKey,
      };
      if (!String(testProbeConfig.url || '').trim() && !testProbeConfig.demoMode) {
        return json({ ok: false, error: '请先填写探针地址再测试连接' }, 400);
      }
      const result = await fetchProbeStatus(env, testProbeConfig, { forceRefresh: true });
      return json({ ok: !result.error, ...result }, result.error ? 400 : 200);
    }

    // POST /api/admin/probe/alert-test — send a test probe alert via the active inbox mode (3/min)
    if (path === '/api/admin/probe/alert-test' && method === 'POST') {
      const uid = String(auth.user?.id || 'admin');
      if (!(await checkRateLimit(env, `rl:alert_test:${uid}`, 3, 60))) {
        return json({ ok: false, error: '发送过于频繁，每分钟最多测试 3 次' }, 429);
      }
      const result = await sendTestProbeAlert(env, url.origin, config);
      return json(result, result.ok ? 200 : 400);
    }

    // GET /api/admin/update/check — Scheme A: check latest GitHub release (KV-cached 6h)
    if (path === '/api/admin/update/check' && method === 'GET') {
      const forceRefresh = url.searchParams.get('force') === '1';
      const result = await checkLatestRelease(env, { forceRefresh });
      return json(result, result.ok ? 200 : 502);
    }

    // POST /api/admin/update/sync — Scheme B (Optional): sync owner's Fork with upstream via GitHub API
    if (path === '/api/admin/update/sync' && method === 'POST') {
      const body = await readJsonBody(request);
      const rawBodyToken = body?.githubToken;
      const resolvedToken =
        rawBodyToken === '********' || rawBodyToken === undefined
          ? config.updater?.githubToken || env.GITHUB_UPDATE_TOKEN || ''
          : String(rawBodyToken || '').trim() || env.GITHUB_UPDATE_TOKEN || '';
      const syncConfig = {
        ...config.updater,
        ...(body || {}),
        githubToken: resolvedToken,
      };
      const result = await syncForkWithUpstream(env, syncConfig);
      return json(result, result.status || (result.ok ? 200 : 400));
    }
  }

  return json({ ok: false, error: 'Not Found' }, 404);
}
