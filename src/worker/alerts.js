// Scheduled probe offline / recovery / resource threshold alerting service.
// Default OFF; zero probe requests and zero KV writes when disabled or steady-state healthy.

import {
  DEFAULT_PROBE_ALERTS,
  loadPanelConfig,
  normalizeProbeAlerts,
  resolveSupergroupId,
  safeGetJSON,
  safePutJSON,
} from './config.js';
import { getOwnerChatId, resolveInboxMode } from './inbox.js';
import { fetchProbeStatus } from './komari.js';
import { buildPanelButton, escapeHtml, tgCall } from './telegram.js';

export const ALERT_STATE_KEY = 'alert:state';
export const ALERT_TOPIC_ID_KEY = 'alert:topic_id';
const ALERT_TOPIC_NAME = '🔔 探针告警';
const MAX_ALERT_LINES = 10;
// Forget a node 24h after the probe stops returning it (treated as deleted from the probe).
export const ABSENT_PRUNE_MS = 24 * 60 * 60 * 1000;

const RESOURCE_METRICS = [
  { key: 'cpu', label: 'CPU', field: 'cpuUsage' },
  { key: 'ram', label: '内存', field: 'ramUsage' },
  { key: 'disk', label: '磁盘', field: 'diskUsage' },
];

function createEmptyAlertState() {
  return {
    probeDown: { misses: 0, notified: false, since: null },
    nodes: {},
  };
}

function normalizePrevState(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyAlertState();
  const pd = raw.probeDown && typeof raw.probeDown === 'object' ? raw.probeDown : {};
  return {
    probeDown: {
      misses: Number(pd.misses) || 0,
      notified: Boolean(pd.notified),
      since: Number.isFinite(Number(pd.since)) && Number(pd.since) > 0 ? Number(pd.since) : null,
    },
    nodes: raw.nodes && typeof raw.nodes === 'object' ? raw.nodes : {},
  };
}

function formatDuration(ms) {
  const totalMins = Math.max(1, Math.round(Math.max(0, Number(ms) || 0) / 60000));
  if (totalMins < 60) return `${totalMins} 分钟`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
}

function formatPercent(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '0';
  return Number(n.toFixed(1)).toString();
}

function zeroBreach() {
  return { cpu: 0, ram: 0, disk: 0 };
}

function zeroNotifiedBreach() {
  return { cpu: false, ram: false, disk: false };
}

/**
 * Pure state-transition evaluator: compares previous `alert:state` against the latest
 * `fetchProbeStatus` payload and returns `{ nextState, events }`.
 */
export function evaluateProbeAlerts(prevRaw, probeStatus, rawAlertsConfig, nowMs = Date.now()) {
  const prevState = normalizePrevState(prevRaw);
  const alerts = normalizeProbeAlerts(DEFAULT_PROBE_ALERTS, rawAlertsConfig);
  const confirmChecks = alerts.confirmChecks;
  const events = [];

  const liveNodes = Array.isArray(probeStatus?.nodes) ? probeStatus.nodes : [];
  const hadKnownNodes = Object.keys(prevState.nodes).length > 0;

  // 1. Probe endpoint itself is unreachable — or suddenly reports zero nodes after previously
  //    reporting some (auth expiry, broken API) — track probeDown only; do NOT evaluate any nodes,
  //    so one probe outage never fans out into "every node is offline".
  const probeErrorText =
    probeStatus?.protocol === 'error'
      ? String(probeStatus.error || '连接失败')
      : liveNodes.length === 0 && hadKnownNodes
        ? '探针未返回任何节点'
        : '';
  if (probeErrorText) {
    const prevPd = prevState.probeDown;
    const misses = Math.min(prevPd.misses + 1, confirmChecks);
    const since = prevPd.since ?? nowMs;
    let notified = prevPd.notified;

    if (!notified && misses >= confirmChecks) {
      notified = true;
      const errDetail = probeErrorText.slice(0, 240);
      events.push({
        kind: 'probe_down',
        silent: false,
        text: `⚠️ 探针连接失败：${errDetail}`,
      });
    }

    return {
      nextState: {
        probeDown: { misses, notified, since },
        nodes: prevState.nodes,
      },
      events,
    };
  }

  // 2. Probe is reachable -> clear probeDown and notify recovery if previously notified
  if (prevState.probeDown.notified) {
    events.push({
      kind: 'probe_recovered',
      silent: true,
      text: '✅ 探针已恢复连接',
    });
  }

  const nextNodes = {};
  const mutedSet = new Set(alerts.mutedNodes || []);
  const resCfg = alerts.resource || DEFAULT_PROBE_ALERTS.resource;
  const resEnabled = Boolean(resCfg.enabled);
  const sustainChecks = resCfg.sustainChecks;
  const seenUuids = new Set();

  for (const node of liveNodes) {
    const uuid = String(node?.uuid || '').trim();
    if (uuid) seenUuids.add(uuid);
    if (!uuid || mutedSet.has(uuid)) continue;

    const name = String(node.name || uuid);
    const online = Boolean(node.online);
    const prev = prevState.nodes[uuid] || null;

    // First time seeing this node -> record baseline only, never alert.
    // An already-offline node starts with { online: false, misses: 0, notifiedOffline: false }
    // so it neither alerts on the next check nor sends a spurious recovery when it comes up.
    if (!prev) {
      nextNodes[uuid] = {
        name,
        online,
        misses: 0,
        notifiedOffline: false,
        offlineSince: null,
        breach: zeroBreach(),
        notifiedBreach: zeroNotifiedBreach(),
      };
      continue;
    }

    let misses = 0;
    let notifiedOffline = Boolean(prev.notifiedOffline);
    let offlineSince = prev.offlineSince ?? null;
    const breach = zeroBreach();
    const notifiedBreach = zeroNotifiedBreach();

    if (!online) {
      const wasBaselineOffline = !prev.online && Number(prev.misses || 0) === 0 && !prev.notifiedOffline;
      if (wasBaselineOffline) {
        misses = 0;
        notifiedOffline = false;
        offlineSince = null;
      } else {
        misses = Math.min((Number(prev.misses) || 0) + 1, confirmChecks);
        offlineSince = prev.offlineSince ?? nowMs;
        if (!notifiedOffline && misses >= confirmChecks) {
          notifiedOffline = true;
          const dur = formatDuration(nowMs - offlineSince);
          events.push({
            kind: 'node_offline',
            silent: false,
            text: `🔴 节点掉线：${name}（已离线约 ${dur}）`,
          });
        }
      }
    } else {
      if (prev.notifiedOffline && alerts.notifyRecovery !== false) {
        const dur = formatDuration(nowMs - (prev.offlineSince ?? nowMs));
        events.push({
          kind: 'node_recovered',
          silent: true,
          text: `🟢 节点恢复：${name}（离线 ${dur}）`,
        });
      }
      misses = 0;
      notifiedOffline = false;
      offlineSince = null;

      // Resource threshold monitoring (only for online, non-first-seen nodes)
      if (resEnabled) {
        for (const m of RESOURCE_METRICS) {
          const threshold = Number(resCfg[m.key] ?? 0);
          if (threshold <= 0) {
            breach[m.key] = 0;
            notifiedBreach[m.key] = false;
            continue;
          }
          const value = Number(node[m.field] ?? 0);
          if (Number.isFinite(value) && value >= threshold) {
            const prevCount = Number(prev.breach?.[m.key] || 0);
            const prevNotified = Boolean(prev.notifiedBreach?.[m.key]);
            const nextCount = Math.min(prevCount + 1, sustainChecks);
            breach[m.key] = nextCount;
            if (!prevNotified && nextCount >= sustainChecks) {
              notifiedBreach[m.key] = true;
              events.push({
                kind: 'resource_breach',
                silent: false,
                text: `🟠 ${name} ${m.label} 持续 ≥ ${threshold}%（当前 ${formatPercent(value)}%）`,
              });
            } else {
              notifiedBreach[m.key] = prevNotified;
            }
          } else {
            breach[m.key] = 0;
            notifiedBreach[m.key] = false;
          }
        }
      }
    }

    nextNodes[uuid] = {
      name,
      online,
      misses,
      notifiedOffline,
      offlineSince,
      breach,
      notifiedBreach,
    };
  }

  // 3. Known nodes the probe no longer returns. Some probes (e.g. ServerStatus-style JSON) drop
  //    offline machines from the list instead of reporting online:false, so absence counts as
  //    offline. State is pruned only after ABSENT_PRUNE_MS. `absentSince` is fixed when the node
  //    first disappears, so a steady absent node causes no further KV writes.
  for (const [uuid, prev] of Object.entries(prevState.nodes)) {
    if (seenUuids.has(uuid) || mutedSet.has(uuid) || !prev || typeof prev !== 'object') continue;
    const absentSince = Number.isFinite(Number(prev.absentSince)) && Number(prev.absentSince) > 0
      ? Number(prev.absentSince)
      : nowMs;
    if (nowMs - absentSince >= ABSENT_PRUNE_MS) continue;

    const name = String(prev.name || uuid);
    const wasBaselineOffline = !prev.online && Number(prev.misses || 0) === 0 && !prev.notifiedOffline;
    let misses = Number(prev.misses) || 0;
    let notifiedOffline = Boolean(prev.notifiedOffline);
    let offlineSince = prev.offlineSince ?? null;

    if (!wasBaselineOffline) {
      misses = Math.min(misses + 1, confirmChecks);
      offlineSince = offlineSince ?? nowMs;
      if (!notifiedOffline && misses >= confirmChecks) {
        notifiedOffline = true;
        events.push({
          kind: 'node_offline',
          silent: false,
          text: `🔴 节点掉线：${name}（探针已不再返回该节点，约 ${formatDuration(nowMs - offlineSince)}）`,
        });
      }
    }

    nextNodes[uuid] = {
      name,
      online: false,
      misses,
      notifiedOffline,
      offlineSince,
      breach: zeroBreach(),
      notifiedBreach: zeroNotifiedBreach(),
      absentSince,
    };
  }

  return {
    nextState: {
      probeDown: { misses: 0, notified: false, since: null },
      nodes: nextNodes,
    },
    events,
  };
}

/**
 * Formats one or more alert events into a single HTML message (max 10 lines + overflow summary).
 */
export function formatAlertMessage(events = []) {
  if (!Array.isArray(events) || events.length === 0) return { text: '', disableNotification: true };
  // Urgent alerts first so overflow truncation never hides outages behind recoveries
  const sorted = [...events].sort((a, b) => Number(Boolean(a.silent)) - Number(Boolean(b.silent)));
  const shown = sorted.slice(0, MAX_ALERT_LINES).map((e) => escapeHtml(e.text));
  const extra = sorted.length - shown.length;
  if (extra > 0) {
    shown.push(`<i>…另有 ${extra} 个</i>`);
  }
  const disableNotification = sorted.every((e) => e.silent === true);
  const title = sorted.length === 1 ? '🔔 <b>探针告警</b>' : `🔔 <b>探针告警（共 ${sorted.length} 项）</b>`;
  return {
    text: `${title}\n\n${shown.join('\n')}`,
    disableNotification,
  };
}

function buildAlertPanelMarkup(env, origin, config, isGroup) {
  const cleanOrigin = String(origin || config?.siteOrigin || '').trim().replace(/\/+$/, '');
  const hasHttpsOrigin = /^https:\/\//i.test(cleanOrigin);
  const botUsername = String(env?.BOT_USERNAME || config?.botUsername || '').trim().replace(/^@/, '');
  const envWithBot = botUsername && !env?.BOT_USERNAME ? { ...env, BOT_USERNAME: botUsername } : env;

  if (isGroup) {
    if (!botUsername && !hasHttpsOrigin) return undefined;
    const btn = buildPanelButton(envWithBot, cleanOrigin, '📡 打开探针面板', {
      isGroup: true,
      startParam: 'probe',
    });
    if (!btn?.url || !/^https:\/\//i.test(btn.url)) return undefined;
    return { inline_keyboard: [[btn]] };
  }

  if (hasHttpsOrigin) {
    const btn = buildPanelButton(envWithBot, cleanOrigin, '📡 打开探针面板', {
      isGroup: false,
      query: 'tab=probe',
    });
    return { inline_keyboard: [[btn]] };
  }
  if (botUsername) {
    const btn = buildPanelButton(envWithBot, '', '📡 打开探针面板', {
      isGroup: true,
      startParam: 'probe',
    });
    if (btn?.url && /^https:\/\//i.test(btn.url)) {
      return { inline_keyboard: [[btn]] };
    }
  }
  return undefined;
}

// The cache stores `{ chatId, threadId }`. Forum thread IDs are per-chat message IDs, so a thread ID
// cached for one group can exist in another group as an unrelated (e.g. visitor) topic; only reuse
// it when it belongs to the currently bound group.
async function ensureAlertTopic(env, supergroupId) {
  const chatId = String(supergroupId);
  if (env?.TOPIC_MAP) {
    const cached = await safeGetJSON(env.TOPIC_MAP, ALERT_TOPIC_ID_KEY, null);
    const cachedThread = Number(cached?.threadId);
    if (cached && String(cached.chatId) === chatId && Number.isInteger(cachedThread) && cachedThread > 0) {
      return cachedThread;
    }
  }
  const created = await tgCall(env, 'createForumTopic', {
    chat_id: supergroupId,
    name: ALERT_TOPIC_NAME,
    icon_color: 16478047,
  });
  const threadId = Number(created?.result?.message_thread_id);
  if (env?.TOPIC_MAP && Number.isFinite(threadId) && threadId > 0) {
    await safePutJSON(env.TOPIC_MAP, ALERT_TOPIC_ID_KEY, { chatId, threadId });
  }
  return threadId;
}

/**
 * Delivers an HTML alert message via the active inbox channel (`topic` or `dm`).
 */
export async function sendAlertNotification(env, text, options = {}) {
  const { origin = '', config = null, disableNotification = false } = options;
  const supergroupId = await resolveSupergroupId(env);
  const mode = await resolveInboxMode(env, supergroupId);

  if (mode === 'off') {
    return { ok: false, mode: 'off', error: '请先配置 ADMIN_IDS 或绑定通知群' };
  }
  if (!env?.BOT_TOKEN) {
    return { ok: false, mode, error: '尚未配置 BOT_TOKEN' };
  }

  if (mode === 'topic') {
    const replyMarkup = buildAlertPanelMarkup(env, origin, config, true);
    let threadId = await ensureAlertTopic(env, supergroupId);
    const payload = (tid) => ({
      chat_id: supergroupId,
      message_thread_id: tid,
      text,
      parse_mode: 'HTML',
      disable_notification: Boolean(disableNotification),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    try {
      await tgCall(env, 'sendMessage', payload(threadId));
    } catch (err) {
      if (/thread not found|topic_deleted|message thread not found/i.test(String(err?.message || ''))) {
        if (env?.TOPIC_MAP) {
          await env.TOPIC_MAP.delete(ALERT_TOPIC_ID_KEY).catch(() => {});
        }
        threadId = await ensureAlertTopic(env, supergroupId);
        await tgCall(env, 'sendMessage', payload(threadId));
      } else {
        throw err;
      }
    }
    return { ok: true, mode: 'topic', targetLabel: `通知群「${ALERT_TOPIC_NAME}」话题`, threadId };
  }

  const ownerId = getOwnerChatId(env);
  if (!ownerId) {
    return { ok: false, mode: 'off', error: '请先配置 ADMIN_IDS 或绑定通知群' };
  }
  const replyMarkup = buildAlertPanelMarkup(env, origin, config, false);
  await tgCall(env, 'sendMessage', {
    chat_id: Number(ownerId),
    text,
    parse_mode: 'HTML',
    disable_notification: Boolean(disableNotification),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return { ok: true, mode: 'dm', targetLabel: 'Bot 私聊' };
}

/**
 * Sends a one-off test alert from Settings (`POST /api/admin/probe/alert-test`).
 */
export async function sendTestProbeAlert(env, origin = '', config = null) {
  const cfg = config || (await loadPanelConfig(env));
  const text = '🔔 <b>探针告警测试</b>\n\n这是一条测试告警通知，当前通知渠道工作正常 🌸';
  try {
    return await sendAlertNotification(env, text, {
      origin,
      config: cfg,
      disableNotification: false,
    });
  } catch (err) {
    const mode = await resolveInboxMode(env);
    return {
      ok: false,
      mode,
      error: `发送测试告警失败：${err?.message || '未知错误'}`,
    };
  }
}

/**
 * Scheduled Cloudflare Cron handler (triggered every 5 minutes).
 */
export async function runProbeAlerts(env, scheduledTime = Date.now(), options = {}) {
  if (!env?.TOPIC_MAP) {
    return { skipped: true, reason: 'no_kv', events: [] };
  }

  const config = await loadPanelConfig(env);
  const probe = config.probe || {};
  const alerts = normalizeProbeAlerts(DEFAULT_PROBE_ALERTS, probe.alerts);

  if (alerts.enabled !== true) {
    return { skipped: true, reason: 'disabled', events: [] };
  }
  if (probe.demoMode || !String(probe.url || '').trim()) {
    return { skipped: true, reason: 'unconfigured_or_demo', events: [] };
  }

  const nowMs = Number.isFinite(Number(scheduledTime)) ? Number(scheduledTime) : Date.now();
  const minuteIndex = Math.floor(nowMs / 60000);
  if (!options.ignoreInterval && minuteIndex % alerts.intervalMinutes !== 0) {
    return { skipped: true, reason: 'interval', events: [] };
  }

  // Always bypass probe cache writes so cron checks never burn KV free-tier write quota
  const probeStatus = await fetchProbeStatus(env, probe, {
    forceRefresh: true,
    skipCacheWrite: true,
  });
  if (probeStatus.demo || !probeStatus.configured) {
    return { skipped: true, reason: 'unconfigured_or_demo', events: [] };
  }

  const prevRaw = await safeGetJSON(env.TOPIC_MAP, ALERT_STATE_KEY, null);
  const prevSerialized = prevRaw ? JSON.stringify(prevRaw) : null;
  const { nextState, events } = evaluateProbeAlerts(prevRaw, probeStatus, alerts, nowMs);
  const nextSerialized = JSON.stringify(nextState);

  let stateWritten = false;
  if (nextSerialized !== prevSerialized) {
    await safePutJSON(env.TOPIC_MAP, ALERT_STATE_KEY, nextState);
    stateWritten = true;
  }

  let notified = false;
  let notifyResult = null;
  if (events.length > 0) {
    const { text, disableNotification } = formatAlertMessage(events);
    try {
      notifyResult = await sendAlertNotification(env, text, {
        origin: options.origin || config.siteOrigin || '',
        config,
        disableNotification,
      });
      notified = Boolean(notifyResult?.ok);
    } catch {
      // Swallow notification errors so alert state persistence is unaffected
      notified = false;
    }
  }

  return {
    skipped: false,
    stateWritten,
    notified,
    notifyResult,
    events,
  };
}
