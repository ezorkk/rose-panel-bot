// Pluggable server-probe module.
// Built-in providers:
//   - komari  : Komari v2 JSON-RPC (/api/rpc2) with v1 REST (/api/nodes) fallback
//   - nezha   : Nezha Dashboard v1 WebSocket (/api/v1/ws/server, works publicly without token),
//               v1 REST (/api/v1/server), and v0 REST (/api/v1/server/details) fallback
//   - nodeget : NodeSeek official probe (NodeGet) via WebSocket JSON-RPC 2.0
//   - json    : Generic JSON adapter for any other probe (极简探针 / CF Workers 探针 / ServerStatus)
//               that exposes a JSON node list; fields are auto-detected.
// To add a dedicated provider: write `async function fetchViaXxx(baseUrl, headers, rawApiKey)`
// returning `{ nodes, protocol }`, then register it in PROBE_PROVIDERS below.

const PROBE_CACHE_KEY = 'cache:komari_probe';
export const KOMARI_LATENCY_TIMEOUT_MS = 4000;
const MAX_LATENCY_LINES = 6;
const MAX_LATENCY_NAME_CHARS = 32;

function normalizeBaseUrl(rawUrl) {
  if (!rawUrl) return '';
  let url = String(rawUrl).trim().replace(/\/+$/, '');
  if (!/^(?:https?|wss?):\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}

function toHttpUrl(rawUrl) {
  return rawUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
}

function toWsUrl(rawUrl) {
  return rawUrl.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}

function countryCodeToFlag(code) {
  const s = String(code || '').trim();
  if (!s) return '';
  if (/^[a-z]{2}$/i.test(s)) {
    const upper = s.toUpperCase();
    return String.fromCodePoint(0x1f1e6 + upper.charCodeAt(0) - 65, 0x1f1e6 + upper.charCodeAt(1) - 65);
  }
  return s;
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/**
 * Opens an outbound WebSocket cleanly in both Cloudflare Workers (`fetch` with Upgrade)
 * and standard Node/Browser runtimes (`globalThis.WebSocket`).
 * Returns `{ ws, accept }` so callers attach `message` listeners BEFORE calling `accept()`
 * — preventing a race where immediate server-push frames (like Nezha v1) fire early.
 */
async function openWebSocket(url, headers = {}, timeoutMs = 6000) {
  const httpUrl = toHttpUrl(url);
  let origin = '';
  try {
    origin = new URL(httpUrl).origin;
  } catch {
    origin = '';
  }

  // 1. Cloudflare Workers outbound WebSocket via fetch({ headers: { Upgrade: 'websocket' } })
  const wsHeaders = { ...headers, Upgrade: 'websocket' };
  if (origin && !wsHeaders.Origin) wsHeaders.Origin = origin;

  let fetchErr = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(httpUrl, {
        method: 'GET',
        headers: wsHeaders,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res?.webSocket) {
      return { ws: res.webSocket, accept: () => res.webSocket.accept() };
    }
    if (res && [401, 403, 404].includes(res.status)) {
      throw new Error(`HTTP ${res.status}`);
    }
    fetchErr = new Error(`WebSocket upgrade failed (HTTP ${res?.status ?? 'unknown'})`);
  } catch (err) {
    if (err?.message && /^HTTP (401|403|404)$/.test(err.message)) {
      throw err;
    }
    fetchErr = err;
  }

  // 2. Standard WebSocket constructor fallback (Node 22+ / local dev / browsers)
  if (typeof globalThis.WebSocket === 'function') {
    const wsUrl = toWsUrl(url);
    const ws = await new Promise((resolve, reject) => {
      let settled = false;
      const sock = new globalThis.WebSocket(wsUrl);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          sock.close();
        } catch {}
        reject(new Error(`WebSocket 连接超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      sock.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(sock);
      });
      sock.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(fetchErr || new Error('WebSocket 连接失败'));
      });
    });
    return { ws, accept: () => {} };
  }

  throw fetchErr || new Error('WebSocket unavailable in this runtime');
}

function buildAuthHeaders(apiKey) {
  const headers = { Accept: 'application/json' };
  const key = String(apiKey || '').trim();
  if (!key) return headers;
  if (key.toLowerCase().startsWith('cookie:')) {
    headers.Cookie = key.slice(7).trim();
  } else if (key.includes('=')) {
    headers.Cookie = key;
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = url;
    let currentOptions = { ...options };
    const visited = new Set([currentUrl]);

    for (let hop = 0; hop <= 3; hop += 1) {
      const res = await fetch(currentUrl, {
        ...currentOptions,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers?.get?.('location');
        if (!location) {
          throw new Error(`HTTP ${res.status}`);
        }
        const nextUrl = new URL(location, currentUrl).toString();
        if (visited.has(nextUrl)) {
          const loopErr = new Error(
            '检测到重定向循环：若探针与面板在同一 Cloudflare 域名下，请为探针子域将 SSL/TLS 模式从 Flexible 改为 Full'
          );
          loopErr.isRedirectLoop = true;
          throw loopErr;
        }
        visited.add(nextUrl);
        currentUrl = nextUrl;
        if (res.status === 301 || res.status === 302 || res.status === 303) {
          const method = String(currentOptions.method || 'GET').toUpperCase();
          if (method !== 'GET' && method !== 'HEAD') {
            currentOptions = { ...currentOptions, method: 'GET', body: undefined };
          }
        }
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    }

    const tooManyErr = new Error('重定向次数过多（超过 3 次）');
    tooManyErr.isRedirectLoop = true;
    throw tooManyErr;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeNodeMetrics(nodeMeta = {}, status = {}) {
  const uuid = String(nodeMeta.uuid || status.uuid || status.client || nodeMeta.id || '');
  const cpuRaw = status?.cpu;
  const cpuUsage = Number(
    typeof cpuRaw === 'number'
      ? cpuRaw
      : cpuRaw?.usage ?? status?.cpu_usage ?? status?.cpu_percent ?? 0
  );

  const ramRaw = status?.ram;
  const ramTotal = Number(
    (typeof ramRaw === 'object' ? ramRaw?.total : undefined) ??
      status?.ram_total ??
      status?.mem?.total ??
      status?.mem_total ??
      nodeMeta?.mem_total ??
      0
  );
  const ramUsed = Number(
    typeof ramRaw === 'number'
      ? ramRaw
      : ramRaw?.used ?? status?.mem?.used ?? status?.ram_used ?? 0
  );
  const ramUsage = Number(
    (typeof ramRaw === 'object' ? ramRaw?.usage : undefined) ??
      (ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0)
  );

  const diskRaw = status?.disk;
  const diskTotal = Number(
    (typeof diskRaw === 'object' ? diskRaw?.total : undefined) ??
      status?.disk_total ??
      nodeMeta?.disk_total ??
      0
  );
  const diskUsed = Number(
    typeof diskRaw === 'number'
      ? diskRaw
      : diskRaw?.used ?? status?.disk_used ?? 0
  );
  const diskUsage = Number(
    (typeof diskRaw === 'object' ? diskRaw?.usage : undefined) ??
      (diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0)
  );

  const net = status?.network || status?.net || {};
  const netUp = Number(net.up ?? net.tx_rate ?? status?.net_out ?? 0);
  const netDown = Number(net.down ?? net.rx_rate ?? status?.net_in ?? 0);
  const totalUp = Number(net.totalUp ?? net.tx_total ?? status?.net_total_up ?? 0);
  const totalDown = Number(net.totalDown ?? net.rx_total ?? status?.net_total_down ?? 0);

  const loadRaw = status?.load;
  const load1 = Number(
    typeof loadRaw === 'number'
      ? loadRaw
      : loadRaw?.load1 ?? status?.cpu?.load1 ?? status?.load1 ?? 0
  );
  const uptime = Number(status?.uptime ?? nodeMeta?.uptime ?? 0);

  const online =
    typeof status?.online === 'boolean'
      ? status.online
      : typeof nodeMeta?.online === 'boolean'
        ? nodeMeta.online
        : uptime > 0 || cpuUsage > 0 || ramUsed > 0;

  const rawTags = nodeMeta.tags || '';
  const tags = Array.isArray(rawTags)
    ? rawTags.filter(Boolean)
    : String(rawTags)
        .split(/[;,|]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  return {
    uuid,
    name: nodeMeta.name || uuid || 'Unnamed Node',
    region: nodeMeta.region || '',
    group: nodeMeta.group || '',
    tags,
    online,
    os: nodeMeta.os || '',
    arch: nodeMeta.arch || '',
    virtualization: nodeMeta.virtualization || '',
    cpuName: nodeMeta.cpu_name || '',
    cpuCores: Number(nodeMeta.cpu_cores || 0),
    cpuUsage: roundPct(cpuUsage),
    ramTotal,
    ramUsed,
    ramUsage: roundPct(ramUsage),
    diskTotal,
    diskUsed,
    diskUsage: roundPct(diskUsage),
    netUp,
    netDown,
    totalUp,
    totalDown,
    load1: Number.isFinite(load1) ? Number(load1.toFixed(2)) : 0,
    uptime,
    updatedAt: status?.updated_at || status?.time || nodeMeta?.updated_at || null,
    latency: [],
  };
}

function roundPct(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100, Number(n.toFixed(1)));
}

function roundLatencyMs(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function roundLossPct(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100, Number(n.toFixed(1)));
}

function truncateChars(str, maxChars) {
  return Array.from(String(str || '').trim())
    .slice(0, maxChars)
    .join('');
}

/**
 * Maps Komari `public:getPingMetricStats` result (and optional `public:getPublicPingTasks`
 * weights) into a `Map<uuid, LatencyLine[]>`, sorted by task weight or name, capped at 6 lines.
 */
export function normalizeKomariLatencyMap(statsResult, tasksResult = null) {
  const rawStats = Array.isArray(statsResult?.stats) ? statsResult.stats : [];
  if (rawStats.length === 0) return new Map();

  const taskWeightMap = new Map();
  const rawTasks = Array.isArray(tasksResult)
    ? tasksResult
    : Array.isArray(tasksResult?.tasks)
      ? tasksResult.tasks
      : [];
  for (const task of rawTasks) {
    if (!task || task.id === undefined || task.id === null) continue;
    const w = Number(task.weight);
    if (Number.isFinite(w)) {
      taskWeightMap.set(String(task.id), w);
    }
  }

  const byEntity = new Map();
  for (const row of rawStats) {
    if (!row || typeof row !== 'object') continue;
    const entityId = String(row.entity_id || '').trim();
    if (!entityId) continue;

    const rawName = row.name || (row.task_id != null ? `Task ${row.task_id}` : '');
    const name = truncateChars(rawName, MAX_LATENCY_NAME_CHARS);
    if (!name) continue;

    const taskKey = row.task_id !== undefined && row.task_id !== null ? String(row.task_id) : '';
    const inlineWeight = row.weight !== undefined && row.weight !== null ? Number(row.weight) : NaN;
    const weight = taskWeightMap.has(taskKey)
      ? taskWeightMap.get(taskKey)
      : Number.isFinite(inlineWeight)
        ? inlineWeight
        : Infinity;

    const item = {
      name,
      type: truncateChars(row.type || '', 16),
      avg: roundLatencyMs(row.avg),
      min: roundLatencyMs(row.min),
      max: roundLatencyMs(row.max),
      latest: roundLatencyMs(row.latest),
      loss: roundLossPct(row.loss),
      _weight: weight,
    };

    if (!byEntity.has(entityId)) byEntity.set(entityId, []);
    byEntity.get(entityId).push(item);
  }

  const result = new Map();
  for (const [entityId, list] of byEntity.entries()) {
    list.sort((a, b) => {
      if (a._weight !== b._weight) return a._weight - b._weight;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    result.set(
      entityId,
      list.slice(0, MAX_LATENCY_LINES).map(({ _weight, ...clean }) => clean)
    );
  }
  return result;
}

async function fetchKomariLatencyStats(rpcUrl, headers) {
  const rpcHeaders = { ...headers, 'Content-Type': 'application/json' };
  const [statsSettled, tasksSettled] = await Promise.allSettled([
    fetchJsonWithTimeout(
      rpcUrl,
      {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'public:getPingMetricStats',
          params: { hours: 1 },
          id: 1,
        }),
      },
      KOMARI_LATENCY_TIMEOUT_MS
    ),
    fetchJsonWithTimeout(
      rpcUrl,
      {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'public:getPublicPingTasks',
          params: {},
          id: 2,
        }),
      },
      KOMARI_LATENCY_TIMEOUT_MS
    ),
  ]);

  if (statsSettled.status !== 'fulfilled' || !statsSettled.value || typeof statsSettled.value !== 'object') {
    return { latencyMap: new Map(), unsupported: false };
  }

  const statsJson = statsSettled.value;
  if (statsJson.error) {
    return { latencyMap: new Map(), unsupported: true };
  }

  const tasksResult =
    tasksSettled.status === 'fulfilled' && tasksSettled.value && !tasksSettled.value.error
      ? tasksSettled.value.result
      : null;

  return {
    latencyMap: normalizeKomariLatencyMap(statsJson.result, tasksResult),
    unsupported: false,
  };
}

/**
 * Komari v2 JSON-RPC 2.0 adapter (/api/rpc2)
 */
async function fetchViaKomariRpc2(baseUrl, headers) {
  const rpcUrl = `${baseUrl}/api/rpc2`;
  const [nodesRes, statusRes] = await Promise.all([
    fetchJsonWithTimeout(rpcUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'common:getNodes', params: {}, id: 1 }),
    }),
    fetchJsonWithTimeout(rpcUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'common:getNodesLatestStatus', params: {}, id: 2 }),
    }),
  ]);

  if (nodesRes?.error) {
    throw new Error(nodesRes.error.message || 'Komari RPC2 error');
  }

  const rawNodes = nodesRes?.result;
  const statusMap = statusRes?.result || {};
  const nodeList = Array.isArray(rawNodes)
    ? rawNodes
    : rawNodes && typeof rawNodes === 'object'
      ? Object.entries(rawNodes).map(([uuid, meta]) => ({ uuid, ...meta }))
      : [];

  let latencyMap = new Map();
  let latencyUnsupported = false;
  if (nodeList.length > 0) {
    try {
      const latRes = await fetchKomariLatencyStats(rpcUrl, headers);
      latencyMap = latRes.latencyMap;
      latencyUnsupported = latRes.unsupported;
    } catch {
      // Latency stats are strictly best-effort and must never fail node fetching
    }
  }

  const nodes = nodeList.map((node) => {
    const latest = statusMap?.[node.uuid] || {};
    const normalized = normalizeNodeMetrics(node, latest);
    const latency = latencyMap.get(normalized.uuid) || [];
    return { ...normalized, latency };
  });

  return { nodes, latencyUnsupported };
}

/**
 * Komari v1 REST adapter (/api/nodes + /api/recent/{uuid})
 */
async function fetchViaKomariRest(baseUrl, headers) {
  const nodesJson = await fetchJsonWithTimeout(`${baseUrl}/api/nodes`, {
    method: 'GET',
    headers,
  });

  const rawNodes = Array.isArray(nodesJson) ? nodesJson : nodesJson?.data || [];
  if (!Array.isArray(rawNodes)) {
    throw new Error('Unexpected /api/nodes response');
  }

  // Fetch recent metrics for up to 24 nodes concurrently to stay well within Worker subrequest limits
  const cappedNodes = rawNodes.slice(0, 24);
  const enriched = await Promise.all(
    cappedNodes.map(async (node) => {
      if (!node.uuid) return normalizeNodeMetrics(node, {});
      try {
        const recentJson = await fetchJsonWithTimeout(
          `${baseUrl}/api/recent/${encodeURIComponent(node.uuid)}`,
          { method: 'GET', headers },
          4000
        );
        const rawData = recentJson?.data ?? recentJson;
        const latest = Array.isArray(rawData) ? rawData[rawData.length - 1] || {} : rawData || {};
        return normalizeNodeMetrics(node, latest);
      } catch {
        return normalizeNodeMetrics(node, {});
      }
    })
  );

  return enriched;
}

export function getDemoKomariNodes() {
  return [
    {
      uuid: 'demo-jp-tyo',
      name: 'Tokyo · Rose Edge',
      region: '🇯🇵',
      group: '亚太节点',
      tags: ['JP', 'BGP'],
      online: true,
      os: 'Debian 12',
      arch: 'amd64',
      virtualization: 'KVM',
      cpuName: 'AMD EPYC 7763',
      cpuCores: 2,
      cpuUsage: 14.8,
      ramTotal: 2 * 1024 ** 3,
      ramUsed: 0.78 * 1024 ** 3,
      ramUsage: 39.0,
      diskTotal: 40 * 1024 ** 3,
      diskUsed: 12.4 * 1024 ** 3,
      diskUsage: 31.0,
      netUp: 420 * 1024,
      netDown: 1.85 * 1024 ** 2,
      totalUp: 486 * 1024 ** 3,
      totalDown: 612 * 1024 ** 3,
      load1: 0.24,
      uptime: 48 * 86400 + 11400,
      updatedAt: new Date().toISOString(),
      latency: [
        { name: '浙江移动', type: 'tcp', avg: 62, min: 56, max: 78, latest: 60, loss: 0 },
        { name: '浙江电信', type: 'tcp', avg: 148, min: 121, max: 192, latest: 144, loss: 1.5 },
      ],
    },
    {
      uuid: 'demo-hk-cmi',
      name: 'HongKong · Media',
      region: '🇭🇰',
      group: '亚太节点',
      tags: ['HK', 'CMI'],
      online: true,
      os: 'Ubuntu 24.04',
      arch: 'amd64',
      virtualization: 'KVM',
      cpuName: 'Intel Xeon Platinum',
      cpuCores: 4,
      cpuUsage: 32.4,
      ramTotal: 4 * 1024 ** 3,
      ramUsed: 2.31 * 1024 ** 3,
      ramUsage: 57.8,
      diskTotal: 80 * 1024 ** 3,
      diskUsed: 41.2 * 1024 ** 3,
      diskUsage: 51.5,
      netUp: 2.6 * 1024 ** 2,
      netDown: 1.1 * 1024 ** 2,
      totalUp: 1.42 * 1024 ** 4,
      totalDown: 980 * 1024 ** 3,
      load1: 0.68,
      uptime: 21 * 86400 + 3600,
      updatedAt: new Date().toISOString(),
      latency: [
        { name: '广东移动', type: 'tcp', avg: 34, min: 29, max: 46, latest: 33, loss: 0 },
        { name: '上海联通', type: 'tcp', avg: 88, min: 76, max: 112, latest: 85, loss: 0 },
      ],
    },
    {
      uuid: 'demo-us-lax',
      name: 'Los Angeles · Vault',
      region: '🇺🇸',
      group: '欧美节点',
      tags: ['US', 'Storage'],
      online: true,
      os: 'Debian 12',
      arch: 'amd64',
      virtualization: 'KVM',
      cpuName: 'AMD Ryzen 9',
      cpuCores: 2,
      cpuUsage: 7.2,
      ramTotal: 2 * 1024 ** 3,
      ramUsed: 0.62 * 1024 ** 3,
      ramUsage: 31.0,
      diskTotal: 120 * 1024 ** 3,
      diskUsed: 54.0 * 1024 ** 3,
      diskUsage: 45.0,
      netUp: 128 * 1024,
      netDown: 310 * 1024,
      totalUp: 220 * 1024 ** 3,
      totalDown: 340 * 1024 ** 3,
      load1: 0.11,
      uptime: 92 * 86400,
      updatedAt: new Date().toISOString(),
      latency: [
        { name: '浙江移动', type: 'tcp', avg: 168, min: 152, max: 204, latest: 165, loss: 0 },
        { name: '浙江电信', type: 'tcp', avg: 224, min: 185, max: 298, latest: 236, loss: 12.5 },
      ],
    },
    {
      uuid: 'demo-de-fra',
      name: 'Frankfurt · Backup',
      region: '🇩🇪',
      group: '欧美节点',
      tags: ['DE', 'Backup'],
      online: false,
      os: 'Alpine Linux',
      arch: 'arm64',
      virtualization: 'KVM',
      cpuName: 'Ampere Altra',
      cpuCores: 2,
      cpuUsage: 0,
      ramTotal: 4 * 1024 ** 3,
      ramUsed: 0,
      ramUsage: 0,
      diskTotal: 60 * 1024 ** 3,
      diskUsed: 18 * 1024 ** 3,
      diskUsage: 30.0,
      netUp: 0,
      netDown: 0,
      totalUp: 88 * 1024 ** 3,
      totalDown: 105 * 1024 ** 3,
      load1: 0,
      uptime: 0,
      updatedAt: null,
      latency: [],
    },
  ];
}

/**
 * Nezha Dashboard adapter (verified against nezhahq/nezha upstream models):
 *   - v1 Public WebSocket : GET /api/v1/ws/server -> { now, online, servers: StreamServer[] }
 *   - v1 Auth REST        : GET /api/v1/server -> { success, data: Server[] }
 *   - v0 Legacy REST      : GET /api/v1/server/details -> { code: 0, result: [...] }
 */
function nezhaToNormalized(server = {}) {
  const host = server.host || server.Host || {};
  const state = server.state || server.status || server.State || server.Status || {};
  const lastActive = server.last_active ?? server.LastActive;
  const lastActiveMs =
    typeof lastActive === 'number'
      ? lastActive * (lastActive < 1e12 ? 1000 : 1)
      : Date.parse(lastActive || '');
  const online = Number.isFinite(lastActiveMs) ? Date.now() - lastActiveMs < 60 * 1000 : undefined;
  const cpuInfo = pick(host, 'cpu', 'CPU');
  const rawCountry =
    server.country_code ||
    server.CountryCode ||
    pick(host, 'country_code', 'CountryCode') ||
    '';

  return normalizeNodeMetrics(
    {
      uuid: String(server.id ?? server.ID ?? server.name ?? ''),
      name: server.name || server.Name,
      group: server.tag || server.Tag || '',
      region: countryCodeToFlag(rawCountry),
      os: pick(host, 'platform', 'Platform') || '',
      arch: pick(host, 'arch', 'Arch') || '',
      virtualization: pick(host, 'virtualization', 'Virtualization') || '',
      cpu_name: Array.isArray(cpuInfo) ? cpuInfo[0] || '' : typeof cpuInfo === 'string' ? cpuInfo : '',
      online,
    },
    {
      cpu: Number(pick(state, 'cpu', 'CPU') ?? 0),
      ram: {
        total: Number(pick(host, 'mem_total', 'MemTotal') ?? 0),
        used: Number(pick(state, 'mem_used', 'MemUsed') ?? 0),
      },
      disk: {
        total: Number(pick(host, 'disk_total', 'DiskTotal') ?? 0),
        used: Number(pick(state, 'disk_used', 'DiskUsed') ?? 0),
      },
      network: {
        up: Number(pick(state, 'net_out_speed', 'NetOutSpeed') ?? 0),
        down: Number(pick(state, 'net_in_speed', 'NetInSpeed') ?? 0),
        totalUp: Number(pick(state, 'net_out_transfer', 'NetOutTransfer') ?? 0),
        totalDown: Number(pick(state, 'net_in_transfer', 'NetInTransfer') ?? 0),
      },
      load: Number(pick(state, 'load_1', 'Load1') ?? 0),
      uptime: Number(pick(state, 'uptime', 'Uptime') ?? 0),
      online,
    }
  );
}

async function fetchViaNezhaWs(baseUrl, headers, timeoutMs = 5500) {
  const { ws, accept } = await openWebSocket(`${baseUrl}/api/v1/ws/server`, headers, timeoutMs);
  try {
    const payload = await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('哪吒 WebSocket 首帧超时'));
      }, timeoutMs);
      ws.addEventListener('message', (ev) => {
        if (done) return;
        try {
          const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
          const json = JSON.parse(text);
          if (Array.isArray(json?.servers)) {
            done = true;
            clearTimeout(timer);
            resolve(json.servers);
          }
        } catch {
          // Ignore non-JSON frames
        }
      });
      ws.addEventListener('close', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('哪吒 WebSocket 连接提前关闭'));
      });
      ws.addEventListener('error', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('哪吒 WebSocket 读取失败'));
      });
      accept();
    });
    return { nodes: payload.map(nezhaToNormalized), protocol: 'nezha-v1-ws' };
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function fetchViaNezha(baseUrl, headers, rawApiKey = '') {
  const httpBase = toHttpUrl(baseUrl);
  const errors = [];
  const hasAuth = Boolean(String(rawApiKey || '').trim());

  const tryV1Rest = async () => {
    const json = await fetchJsonWithTimeout(`${httpBase}/api/v1/server`, { method: 'GET', headers });
    const list = Array.isArray(json) ? json : json?.data;
    if (Array.isArray(list)) return { nodes: list.map(nezhaToNormalized), protocol: 'nezha-v1' };
    throw new Error(json?.error || 'Unexpected Nezha v1 response');
  };

  // 1. If a PAT/Cookie is configured, try authenticated Nezha v1 REST first
  if (hasAuth) {
    try {
      return await tryV1Rest();
    } catch (err) {
      if (err?.isRedirectLoop) throw err;
      errors.push(`v1-rest: ${err.message}`);
    }
  }

  // 2. Nezha v1 public WebSocket stream (works with zero token on public v1 dashboards!)
  try {
    return await fetchViaNezhaWs(httpBase, headers);
  } catch (err) {
    errors.push(`v1-ws: ${err.message}`);
  }

  // 3. Unauthenticated Nezha v1 REST fallback (custom proxies / older v1)
  if (!hasAuth) {
    try {
      return await tryV1Rest();
    } catch (err) {
      if (err?.isRedirectLoop) throw err;
      errors.push(`v1-rest: ${err.message}`);
    }
  }

  // 4. Nezha v0 legacy REST fallback (v0 expects raw API token without "Bearer ")
  const v0Headers = { ...headers };
  if (v0Headers.Authorization?.startsWith('Bearer ')) {
    v0Headers.Authorization = v0Headers.Authorization.slice(7);
  }
  try {
    const json = await fetchJsonWithTimeout(`${httpBase}/api/v1/server/details`, {
      method: 'GET',
      headers: v0Headers,
    });
    const list = json?.result;
    if (!Array.isArray(list)) throw new Error(json?.message || 'Unexpected Nezha v0 response');
    return { nodes: list.map(nezhaToNormalized), protocol: 'nezha-v0' };
  } catch (err) {
    errors.push(`v0: ${err.message}`);
    throw new Error(errors.join(' / '));
  }
}

/**
 * NodeGet (NodeSeek official probe) adapter via WebSocket JSON-RPC 2.0.
 * Protocol verified directly from NodeSeekDev/NodeGet-StatusShow:
 *   1. nodeget-server_list_all_agent_uuid
 *   2. kv_get_multi_value + agent_static_data_multi_last_query + agent_dynamic_summary_multi_last_query
 */
const NODEGET_META_KEYS = [
  'metadata_name',
  'metadata_region',
  'metadata_tags',
  'metadata_hidden',
  'metadata_virtualization',
  'metadata_order',
];
const NODEGET_STATIC_FIELDS = ['cpu', 'system'];
const NODEGET_DYNAMIC_FIELDS = [
  'cpu_usage',
  'used_memory',
  'total_memory',
  'total_space',
  'available_space',
  'receive_speed',
  'transmit_speed',
  'total_received',
  'total_transmitted',
  'load_one',
  'uptime',
];

async function fetchViaNodeGet(baseUrl, _headers, rawApiKey = '') {
  const token = String(rawApiKey || '').trim();
  const { ws, accept } = await openWebSocket(baseUrl, {}, 6500);
  const pending = new Map();
  let seq = 0;

  const failAll = (err) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  };

  ws.addEventListener('message', (ev) => {
    try {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      const msg = JSON.parse(text);
      if (msg?.id == null) return;
      const entry = pending.get(String(msg.id));
      if (!entry) return;
      pending.delete(String(msg.id));
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || 'NodeGet RPC error'));
      } else {
        entry.resolve(msg.result);
      }
    } catch {
      // Ignore malformed frame
    }
  });
  ws.addEventListener('close', () => failAll(new Error('NodeGet WebSocket 连接已关闭')));
  ws.addEventListener('error', () => failAll(new Error('NodeGet WebSocket 通信异常')));
  accept();

  const rpcCall = (method, params = {}, timeoutMs = 5500) =>
    new Promise((resolve, reject) => {
      const id = String(++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`NodeGet RPC ${method} 超时`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: { token, ...params }, id }));
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });

  try {
    const listRes = await rpcCall('nodeget-server_list_all_agent_uuid', {});
    const uuids = Array.isArray(listRes?.uuids) ? listRes.uuids.slice(0, 100) : [];
    if (uuids.length === 0) {
      return { nodes: [], protocol: 'nodeget-rpc' };
    }

    const kvItems = uuids.flatMap((u) => NODEGET_META_KEYS.map((k) => ({ namespace: u, key: k })));
    const [kvRes, staticRes, dynamicRes] = await Promise.allSettled([
      rpcCall('kv_get_multi_value', { namespace_key: kvItems }),
      rpcCall('agent_static_data_multi_last_query', { uuids, fields: NODEGET_STATIC_FIELDS }),
      rpcCall('agent_dynamic_summary_multi_last_query', { uuids, fields: NODEGET_DYNAMIC_FIELDS }),
    ]);

    const metaMap = new Map();
    if (kvRes.status === 'fulfilled' && Array.isArray(kvRes.value)) {
      for (const row of kvRes.value) {
        if (!row?.namespace || row.value == null) continue;
        if (!metaMap.has(row.namespace)) metaMap.set(row.namespace, {});
        metaMap.get(row.namespace)[row.key] = row.value;
      }
    }

    const staticMap = new Map();
    if (staticRes.status === 'fulfilled' && Array.isArray(staticRes.value)) {
      for (const row of staticRes.value) {
        if (row?.uuid) staticMap.set(row.uuid, row);
      }
    }

    const dynamicMap = new Map();
    if (dynamicRes.status === 'fulfilled' && Array.isArray(dynamicRes.value)) {
      for (const row of dynamicRes.value) {
        if (row?.uuid) dynamicMap.set(row.uuid, row);
      }
    }

    const nowMs = Date.now();
    const nodes = [];
    for (const uuid of uuids) {
      const meta = metaMap.get(uuid) || {};
      if (meta.metadata_hidden) continue;
      const stat = staticMap.get(uuid) || {};
      const dyn = dynamicMap.get(uuid) || {};
      const tsRaw = Number(dyn.timestamp || 0);
      const tsMs = tsRaw > 0 ? (tsRaw < 1e12 ? tsRaw * 1000 : tsRaw) : 0;
      const online = tsMs > 0 ? nowMs - tsMs < 30 * 1000 : false;
      const diskTotal = Number(dyn.total_space || 0);
      const diskAvail = dyn.available_space != null ? Number(dyn.available_space) : null;
      const diskUsed = diskTotal > 0 && diskAvail != null ? Math.max(0, diskTotal - diskAvail) : 0;

      nodes.push(
        normalizeNodeMetrics(
          {
            uuid,
            name: String(meta.metadata_name || stat.system?.system_host_name || uuid),
            region: countryCodeToFlag(meta.metadata_region || ''),
            tags: Array.isArray(meta.metadata_tags) ? meta.metadata_tags : [],
            os: stat.system?.distribution_id || stat.system?.system_name || '',
            arch: stat.system?.cpu_arch || stat.system?.arch || '',
            virtualization: String(meta.metadata_virtualization || stat.system?.virtualization || ''),
            cpu_name: stat.cpu?.brand || '',
            cpu_cores: Number(stat.cpu?.logical_cores || stat.cpu?.physical_cores || 0),
            online,
          },
          {
            cpu: Number(dyn.cpu_usage ?? 0),
            ram: {
              total: Number(dyn.total_memory ?? 0),
              used: Number(dyn.used_memory ?? 0),
            },
            disk: {
              total: diskTotal,
              used: diskUsed,
            },
            network: {
              up: Number(dyn.transmit_speed ?? 0),
              down: Number(dyn.receive_speed ?? 0),
              totalUp: Number(dyn.total_transmitted ?? 0),
              totalDown: Number(dyn.total_received ?? 0),
            },
            load: Number(dyn.load_one ?? 0),
            uptime: Number(dyn.uptime ?? 0),
            online,
            updated_at: tsMs > 0 ? new Date(tsMs).toISOString() : null,
          }
        )
      );
    }

    return { nodes, protocol: 'nodeget-rpc' };
  } finally {
    failAll(new Error('closed'));
    try {
      ws.close();
    } catch {}
  }
}

/**
 * Generic JSON adapter: the URL must return a JSON node list directly.
 * Accepts a top-level array, or an array / id-keyed object under one of
 * data | result | servers | nodes | list | items | stats.
 */
const GENERIC_LIST_KEYS = ['data', 'result', 'servers', 'nodes', 'list', 'items', 'stats'];

function findNodeList(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return null;
  for (const key of GENERIC_LIST_KEYS) {
    const v = json[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const nested = findNodeList(v);
      if (nested) return nested;
      const values = Object.entries(v);
      if (values.length && values.every(([, x]) => x && typeof x === 'object')) {
        return values.map(([id, x]) => ({ id, ...x }));
      }
    }
  }
  return null;
}

function toPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n > 0 && n <= 1 ? n * 100 : n; // accept both 0~1 ratios and 0~100 percents
}

function genericToNormalized(raw = {}) {
  const status = raw.status && typeof raw.status === 'object' ? { ...raw, ...raw.status } : raw;
  const memTotal = pick(status, 'memory_total', 'mem_total', 'ram_total', 'memTotal', 'totalMem');
  const memUsed = pick(status, 'memory_used', 'mem_used', 'ram_used', 'memUsed', 'usedMem');
  const diskTotal = pick(status, 'hdd_total', 'disk_total', 'diskTotal');
  const diskUsed = pick(status, 'hdd_used', 'disk_used', 'diskUsed');
  const onlineRaw = pick(status, 'online', 'online4', 'is_online', 'alive');
  const statusText = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
  const online =
    typeof onlineRaw === 'boolean'
      ? onlineRaw
      : statusText
        ? ['online', 'up', 'ok', 'running'].includes(statusText)
        : undefined;
  const cpu = pick(status, 'cpu', 'cpu_usage', 'cpuUsage', 'cpu_percent');
  const memPct = pick(status, 'memory', 'mem', 'ram', 'mem_usage', 'memUsage');
  const diskPct = pick(status, 'disk', 'hdd', 'disk_usage', 'diskUsage');

  return normalizeNodeMetrics(
    {
      uuid: String(pick(raw, 'uuid', 'id', 'name', 'host', 'hostname') ?? ''),
      name: pick(raw, 'alias', 'name', 'hostname', 'host'),
      region: countryCodeToFlag(pick(raw, 'location', 'region', 'country', 'country_code') || ''),
      group: pick(raw, 'group', 'tag', 'type') || '',
      os: pick(raw, 'os', 'platform') || '',
      online,
    },
    {
      cpu: typeof cpu === 'object' ? cpu : toPercent(cpu),
      ram:
        memTotal !== undefined
          ? { total: Number(memTotal), used: Number(memUsed ?? 0) }
          : typeof memPct === 'object'
            ? memPct
            : { total: 0, used: 0, usage: toPercent(memPct) },
      disk:
        diskTotal !== undefined
          ? { total: Number(diskTotal), used: Number(diskUsed ?? 0) }
          : typeof diskPct === 'object'
            ? diskPct
            : { total: 0, used: 0, usage: toPercent(diskPct) },
      network: {
        up: Number(pick(status, 'network_tx', 'net_tx', 'net_out', 'tx_speed', 'upload') ?? 0),
        down: Number(pick(status, 'network_rx', 'net_rx', 'net_in', 'rx_speed', 'download') ?? 0),
        totalUp: Number(pick(status, 'network_out', 'total_tx', 'tx_total', 'net_total_up') ?? 0),
        totalDown: Number(pick(status, 'network_in', 'total_rx', 'rx_total', 'net_total_down') ?? 0),
      },
      load: Number(pick(status, 'load_1', 'load1', 'load') ?? 0),
      uptime: Number(pick(status, 'uptime') ?? 0),
      online,
      updated_at: pick(raw, 'updated_at', 'last_seen', 'lastSeen', 'time') ?? null,
    }
  );
}

async function fetchViaGenericJson(baseUrl, headers) {
  const json = await fetchJsonWithTimeout(toHttpUrl(baseUrl), { method: 'GET', headers });
  const list = findNodeList(json);
  if (!list) {
    throw new Error('未在返回的 JSON 中找到节点列表（支持顶层数组，或 data / servers / nodes 等字段）');
  }
  return { nodes: list.slice(0, 200).map(genericToNormalized), protocol: 'json' };
}

async function fetchViaKomari(baseUrl, headers) {
  const httpBase = toHttpUrl(baseUrl);
  try {
    const { nodes, latencyUnsupported } = await fetchViaKomariRpc2(httpBase, headers);
    return { nodes, protocol: 'rpc2', ...(latencyUnsupported ? { latencyUnsupported: true } : {}) };
  } catch (err) {
    if (err?.isRedirectLoop) throw err;
    try {
      return { nodes: await fetchViaKomariRest(httpBase, headers), protocol: 'rest', latencyUnsupported: true };
    } catch (restErr) {
      throw new Error(`${err?.message || ''} / ${restErr?.message || ''}`);
    }
  }
}

export const PROBE_PROVIDERS = {
  komari: { label: 'Komari 探针', fetch: fetchViaKomari },
  nezha: { label: '哪吒探针', fetch: fetchViaNezha },
  nodeget: { label: 'NodeGet (NodeSeek 探针)', fetch: fetchViaNodeGet },
  json: { label: '通用 JSON 探针', fetch: fetchViaGenericJson },
};

export function resolveProbeProvider(provider) {
  return PROBE_PROVIDERS[provider] ? provider : 'komari';
}

function summarizeNodes(nodes) {
  const total = nodes.length;
  const online = nodes.filter((n) => n.online).length;
  const activeNodes = nodes.filter((n) => n.online);
  const avgCpu =
    activeNodes.length > 0
      ? Number((activeNodes.reduce((s, n) => s + n.cpuUsage, 0) / activeNodes.length).toFixed(1))
      : 0;
  const totalRam = nodes.reduce((s, n) => s + n.ramTotal, 0);
  const usedRam = activeNodes.reduce((s, n) => s + n.ramUsed, 0);
  const totalNetUp = activeNodes.reduce((s, n) => s + n.netUp, 0);
  const totalNetDown = activeNodes.reduce((s, n) => s + n.netDown, 0);

  return {
    total,
    online,
    offline: total - online,
    avgCpu,
    totalRam,
    usedRam,
    ramUsage: totalRam > 0 ? roundPct((usedRam / totalRam) * 100) : 0,
    totalNetUp,
    totalNetDown,
  };
}

export async function fetchProbeStatus(env, probeConfig, options = {}) {
  const { forceRefresh = false, skipCacheWrite = false } = options;

  if (probeConfig.demoMode && !probeConfig.url) {
    const nodes = getDemoKomariNodes();
    return {
      configured: true,
      demo: true,
      protocol: 'demo',
      fetchedAt: new Date().toISOString(),
      publicUrl: probeConfig.publicUrl || '',
      summary: summarizeNodes(nodes),
      nodes,
    };
  }

  const baseUrl = normalizeBaseUrl(probeConfig.url);
  if (!baseUrl) {
    return {
      configured: false,
      demo: false,
      protocol: 'none',
      fetchedAt: new Date().toISOString(),
      publicUrl: probeConfig.publicUrl || '',
      summary: summarizeNodes([]),
      nodes: [],
    };
  }

  const providerId = resolveProbeProvider(probeConfig.provider);
  const provider = PROBE_PROVIDERS[providerId];

  // Short KV cache to avoid hammering the user's probe instance
  if (!forceRefresh && env.TOPIC_MAP) {
    try {
      const cached = await env.TOPIC_MAP.get(PROBE_CACHE_KEY, { type: 'json' });
      if (
        cached &&
        cached.sourceUrl === baseUrl &&
        cached.provider === providerId &&
        Date.now() - cached.cachedAt < (probeConfig.cacheTtlSeconds || 15) * 1000
      ) {
        return { ...cached.payload, cached: true };
      }
    } catch {
      // Ignore cache read failures
    }
  }

  const headers = buildAuthHeaders(probeConfig.apiKey);
  let nodes = null;
  let protocol = providerId;
  let latencyUnsupported = false;

  try {
    const result = await provider.fetch(baseUrl, headers, probeConfig.apiKey);
    nodes = result.nodes;
    protocol = result.protocol || providerId;
    latencyUnsupported = Boolean(result.latencyUnsupported);
  } catch (err) {
    return {
      configured: true,
      demo: false,
      provider: providerId,
      protocol: 'error',
      error: `无法连接${provider.label} (${err?.message || 'unknown error'})`,
      fetchedAt: new Date().toISOString(),
      publicUrl: probeConfig.publicUrl || toHttpUrl(baseUrl),
      summary: summarizeNodes([]),
      nodes: [],
    };
  }

  // Sort online nodes first, then alphabetically
  nodes.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

  const payload = {
    configured: true,
    demo: false,
    provider: providerId,
    protocol,
    ...(latencyUnsupported ? { latencyUnsupported: true } : {}),
    fetchedAt: new Date().toISOString(),
    publicUrl: probeConfig.publicUrl || toHttpUrl(baseUrl),
    summary: summarizeNodes(nodes),
    nodes,
  };

  if (env.TOPIC_MAP && !skipCacheWrite) {
    try {
      await env.TOPIC_MAP.put(
        PROBE_CACHE_KEY,
        JSON.stringify({ sourceUrl: baseUrl, provider: providerId, cachedAt: Date.now(), payload }),
        { expirationTtl: Math.max(60, probeConfig.cacheTtlSeconds || 15) }
      );
    } catch {
      // KV write quota or read-only preview fallback
    }
  }

  return payload;
}

// Backward-compatible alias for existing imports and tests
export const fetchKomariStatus = fetchProbeStatus;
