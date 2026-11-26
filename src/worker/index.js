// Main Cloudflare Worker Entrypoint for RosePanel Bot

import { BRAND_NAME } from '../../web/src/lib/brand.js';
import { runProbeAlerts } from './alerts.js';
import { handleApiRequest } from './api.js';
import { parseAdminIds } from './auth.js';
import {
  WEBHOOK_UPDATES_REV,
  WEBHOOK_UPDATES_REV_KEY,
  completeTurnstileVerification,
  handleTelegramUpdate,
  syncTelegramBotSurface,
} from './bot.js';
import { loadPanelConfig, resolveSupergroupId, safeGetJSON, savePanelConfig } from './config.js';
import { serveEmbeddedAsset } from './embedded-assets.js';
import { WEBHOOK_ALLOWED_UPDATES, escapeHtml, tgCall } from './telegram.js';
import { renderTurnstileVerifyPage, verifyTurnstileToken } from './turnstile.js';

export { WEBHOOK_ALLOWED_UPDATES };

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function handleSetup(request, env, url) {
  if (!env.WEBHOOK_SECRET) {
    return jsonResponse(
      { ok: false, error: 'WEBHOOK_SECRET is not configured. Add it as a Secret first, then open /setup?secret=YOUR_WEBHOOK_SECRET' },
      500
    );
  }
  const provided = url.searchParams.get('secret') || '';
  if (!timingSafeEqualStr(provided, env.WEBHOOK_SECRET)) {
    return jsonResponse({ ok: false, error: 'Invalid setup secret. Pass ?secret=YOUR_WEBHOOK_SECRET' }, 403);
  }

  if (!env.BOT_TOKEN) {
    return jsonResponse({ ok: false, error: 'BOT_TOKEN secret is not configured' }, 500);
  }

  const origin = url.origin;
  const webhookUrl = `${origin}/webhook`;
  const config = await loadPanelConfig(env);

  const results = {};

  // 1. Register Webhook (with secret_token header validation, edited_message guard & message_reaction sync)
  const webhookPayload = {
    url: webhookUrl,
    allowed_updates: WEBHOOK_ALLOWED_UPDATES,
  };
  if (env.WEBHOOK_SECRET) {
    webhookPayload.secret_token = env.WEBHOOK_SECRET;
  }
  results.setWebhook = await tgCall(env, 'setWebhook', webhookPayload);
  if (env.TOPIC_MAP) {
    await env.TOPIC_MAP.put(WEBHOOK_UPDATES_REV_KEY, WEBHOOK_UPDATES_REV).catch(() => {});
  }

  // 2. Sync commands, pre-Start description, cached @username & bottom-left menu button
  if (/^https:\/\//i.test(origin) && config.siteOrigin !== origin && env.TOPIC_MAP) {
    await savePanelConfig(env, { siteOrigin: origin }).catch(() => {});
  }
  const synced = await syncTelegramBotSurface(env, origin, config);
  Object.assign(results, synced.results || {});

  return jsonResponse({
    ok: true,
    webhookUrl,
    miniAppUrl: `${origin}/`,
    results,
  });
}

function serializeSafeInlineJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function resolveOgImageUrl(config, requestOrigin = '') {
  const profile = config?.profile || {};
  const avatarMode = profile.avatarMode || (profile.avatarUrl ? 'custom' : 'bot');
  if (avatarMode === 'custom') {
    const raw = String(profile.avatarUrl || '').trim();
    return /^https:\/\/[^\s"'<>]+$/i.test(raw) ? raw : '';
  }
  const cleanOrigin = String(requestOrigin || '').trim().replace(/\/+$/, '');
  if (!cleanOrigin) return '';
  // Both 'owner' and 'bot' modes use the existing privacy-safe /api/avatar/owner proxy,
  // which strictly follows server-stored config.profile.avatarMode without leaking owner UID.
  return `${cleanOrigin}/api/avatar/owner`;
}

async function injectSplashIntoHtml(response, env, requestOrigin = '') {
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html') || !response.ok) return response;
  try {
    const config = await loadPanelConfig(env);
    const displayName = String(config.profile?.displayName || '').trim() || BRAND_NAME;
    const rawTagline = String(config.profile?.tagline || '').replace(/\s+/g, ' ').trim();
    const taglineChars = Array.from(rawTagline);
    const description = taglineChars.length > 160 ? `${taglineChars.slice(0, 159).join('')}…` : rawTagline;
    const ogImage = resolveOgImageUrl(config, requestOrigin);

    const splashPayload = {
      displayName,
      style: config.profile?.splash?.style || 'emblem',
      text: config.profile?.splash?.text || '正在打开个人面板…',
      emoji: config.profile?.splash?.emoji || '🌹',
      emblem: {
        type: config.profile?.emblem?.type || 'builtin',
        variant: config.profile?.emblem?.variant || 'owner',
        fileId: config.profile?.emblem?.fileId || '',
        format: config.profile?.emblem?.format || 'webp',
        url: config.profile?.emblem?.url || '',
      },
    };

    const titleText = displayName === BRAND_NAME ? BRAND_NAME : `${displayName} · ${BRAND_NAME}`;
    const titleTag = `<title>${escapeHtml(titleText)}</title>`;
    const ogTags = [
      `<meta property="og:site_name" content="${escapeHtml(BRAND_NAME)}" />`,
      `<meta property="og:type" content="profile" />`,
      `<meta property="og:title" content="${escapeHtml(displayName)}" />`,
      ...(description ? [`<meta property="og:description" content="${escapeHtml(description)}" />`] : []),
      ...(ogImage ? [`<meta property="og:image" content="${escapeHtml(ogImage)}" />`] : []),
      `<meta name="twitter:card" content="summary" />`,
    ].join('\n    ');

    const html = await response.text();
    let injected = html;
    if (/<title>[\s\S]*?<\/title>/i.test(injected)) {
      injected = injected.replace(/<title>[\s\S]*?<\/title>/i, () => titleTag);
    } else if (injected.includes('</head>')) {
      injected = injected.replace('</head>', () => `    ${titleTag}\n  </head>`);
    }

    const headBlock = `    ${ogTags}\n    <script>window.__ROSE_SPLASH__=${serializeSafeInlineJson(splashPayload)};</script>\n  </head>`;
    if (injected.includes('</head>')) {
      injected = injected.replace('</head>', () => headBlock);
    }

    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-cache');
    headers.delete('content-length');
    return new Response(injected, { status: response.status, headers });
  } catch {
    return response;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      const supergroupId = await resolveSupergroupId(env);
      return jsonResponse({
        ok: true,
        service: 'rose-panel-bot',
        hasToken: Boolean(env.BOT_TOKEN),
        hasKv: Boolean(env.TOPIC_MAP),
        hasSupergroup: Boolean(supergroupId),
      });
    }

    // One-click Webhook & Menu Button setup
    if (url.pathname === '/setup') {
      try {
        return await handleSetup(request, env, url);
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // Cloudflare Turnstile strict verification page (opens cleanly inside Telegram WebView)
    if (url.pathname === '/verify' && request.method === 'GET') {
      const vid = url.searchParams.get('vid') || '';
      if (!env.TURNSTILE_SITE_KEY || !vid) {
        return new Response('Turnstile verification is not configured or link expired.', { status: 400 });
      }
      const state = await safeGetJSON(env.TOPIC_MAP, `chal:${vid}`, null);
      if (!state) {
        return new Response('验证链接已过期，请回到私聊重新发送消息触发新验证。', {
          status: 410,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      return renderTurnstileVerifyPage(env.TURNSTILE_SITE_KEY, vid);
    }

    // Cloudflare Turnstile server-side token verification
    if (url.pathname === '/verify-submit' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: '无效请求' }, 400);
      }
      const vid = String(body?.verifyId || '');
      const token = String(body?.token || '');
      if (!vid || !token || !env.TURNSTILE_SECRET) {
        return jsonResponse({ ok: false, error: '验证参数缺失' }, 400);
      }
      const remoteIp = request.headers.get('CF-Connecting-IP') || '';
      const check = await verifyTurnstileToken(env.TURNSTILE_SECRET, token, remoteIp);
      if (!check.success) {
        return jsonResponse({ ok: false, error: 'Cloudflare 人机核验未通过，请重试' }, 403);
      }
      const result = await completeTurnstileVerification(env, url.origin, vid);
      if (!result.ok) {
        return jsonResponse({ ok: false, error: result.error || '验证会话已过期' }, 410);
      }
      return jsonResponse({ ok: true });
    }

    // Telegram Bot Webhook: supports BOTH `/webhook` and legacy root `POST /`
    // for zero-downtime upgrade from telegram_private_chatbot.
    if ((url.pathname === '/webhook' || url.pathname === '/') && request.method === 'POST') {
      // Always verify the secret token on BOTH paths so legacy root `POST /`
      // can never be abused as an unauthenticated side door for forged updates.
      if (env.WEBHOOK_SECRET) {
        const tokenHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
        if (!timingSafeEqualStr(tokenHeader, env.WEBHOOK_SECRET)) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      if (!update || typeof update !== 'object') {
        return new Response('OK', { status: 200 });
      }

      const work = handleTelegramUpdate(update, env, url.origin).catch((err) => {
        console.error('Webhook handling error:', err);
      });
      if (ctx?.waitUntil) {
        ctx.waitUntil(work);
      } else {
        await work;
      }
      return new Response('OK', { status: 200 });
    }

    // Mini App API routes
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApiRequest(request, env, url, ctx);
      } catch (err) {
        console.error('API error:', err);
        return jsonResponse({ ok: false, error: err.message || 'Internal Server Error' }, 500);
      }
    }

    // Static Mini App frontend served via Cloudflare Workers Assets binding
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return injectSplashIntoHtml(assetRes, env, url.origin);
      }
      return assetRes;
    }

    // Fallback: embedded static assets (used for single-module Cloudflare API uploads)
    const embedded = serveEmbeddedAsset(url.pathname);
    if (embedded) {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return injectSplashIntoHtml(embedded, env, url.origin);
      }
      return embedded;
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const work = runProbeAlerts(env, event?.scheduledTime ?? Date.now()).catch((err) => {
      console.error('Probe alerts cron error:', err);
    });
    if (ctx?.waitUntil) {
      ctx.waitUntil(work);
    } else {
      await work;
    }
  },
};
