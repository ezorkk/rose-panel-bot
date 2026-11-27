import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  ExternalLink,
  GitFork,
  Globe,
  Link2,
  Lock,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { apiRequest } from '../lib/api.js';
import { BRAND_SIGNATURE } from '../lib/brand.js';
import {
  BLOCKED_KEYWORD_MAX_LENGTH,
  KEYWORD_PRESET_GROUPS,
  addBlockedKeywordGroup,
  hasBlockedKeyword,
  removeBlockedKeywordGroup,
  toggleBlockedKeyword,
} from '../lib/keywordPresets.js';
import { buildSourceLink, confirmDialog, copyText, haptic, openExternalUrl } from '../lib/telegram.js';
import { TgStickerMedia, TicketEmblem } from './Emblems.jsx';
import {
  CHANGELOG_URL,
  FEEDBACK_URL,
  HIDE_STAR_STRIP_STORAGE_KEY,
  REPO_URL,
  StarSupportBanner,
} from './WhatsNewModal.jsx';

const DEFAULT_NAV_ORDER = ['profile', 'sites', 'probe', 'visitors', 'leaderboard'];

function normalizeNavOrderDraft(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const res = [];
  for (const id of list) {
    if (DEFAULT_NAV_ORDER.includes(id) && !seen.has(id)) {
      seen.add(id);
      res.push(id);
    }
  }
  for (const id of DEFAULT_NAV_ORDER) {
    if (!seen.has(id)) res.push(id);
  }
  return res;
}

const PROBE_PROVIDER_OPTIONS = [
  {
    id: 'komari',
    label: 'Komari 探针',
    urlLabel: 'Komari 探针地址（自动兼容 v2 /api/rpc2 与 v1 /api/nodes）',
    urlPlaceholder: 'https://status.example.com',
    tokenLabel: 'API Token / Cookie（公开 Komari 留空即可）',
    tokenPlaceholder: '公开探针无需填写；私有站点可填 Bearer Token 或 session_token=...',
  },
  {
    id: 'nezha',
    label: '哪吒探针 (Nezha v1 / v0)',
    urlLabel: '哪吒面板地址（自动兼容 v1 公开 WS、v1 REST 与 v0 API）',
    urlPlaceholder: 'https://nezha.example.com',
    tokenLabel: 'API Token / Cookie（公开 v1 留空即可；私有或 v0 填 Token）',
    tokenPlaceholder: '公开哪吒 v1 无需填写；私有 v1/v0 可填 API Token',
  },
  {
    id: 'nodeget',
    label: 'NodeGet (NodeSeek 官方探针)',
    urlLabel: 'NodeGet 后端 WebSocket 地址（支持 wss:// 或 https://）',
    urlPlaceholder: 'wss://nodeget-backend.example.com',
    tokenLabel: 'NodeGet 访问 Token（与 StatusShow 配置中的 token 一致）',
    tokenPlaceholder: '填入 NodeGet site_tokens 中的只读 Token',
  },
  {
    id: 'json',
    label: '其他探针：极简 / CF / ServerStatus 等（通用 JSON）',
    urlLabel: '探针 JSON 接口完整地址（返回节点列表的 URL）',
    urlPlaceholder: 'https://probe.example.com/api/stats.json',
    tokenLabel: 'API Token / Cookie（公开接口留空即可）',
    tokenPlaceholder: '公开接口无需填写；私有接口可填 Token 或 Cookie',
  },
];

export default function SettingsDrawer({
  initialSection = 'profile',
  adminConfig,
  botInfo = null,
  shareUrl = '',
  appVersion = '',
  onOpenWhatsNew,
  onClose,
  onSaved,
  onToast,
}) {
  const [section, setSection] = useState(initialSection === 'storage' ? 'update' : initialSection);
  const [draft, setDraft] = useState(() => structuredClone(adminConfig));
  const [probationDomainsText, setProbationDomainsText] = useState(() =>
    (adminConfig?.pmBot?.probation?.allowDomains || []).join('\n')
  );
  const [saving, setSaving] = useState(false);
  const [testingProbe, setTestingProbe] = useState(false);
  const [probeTestResult, setProbeTestResult] = useState(null);
  const [alertNodes, setAlertNodes] = useState([]);
  const [loadingAlertNodes, setLoadingAlertNodes] = useState(false);
  const [sendingAlertTest, setSendingAlertTest] = useState(false);
  const [hideStarStrip, setHideStarStrip] = useState(() => {
    try {
      return localStorage.getItem(HIDE_STAR_STRIP_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Version check (Scheme A) & optional Fork 1-click sync (Scheme B)
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [syncingFork, setSyncingFork] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [forkCardOpen, setForkCardOpen] = useState(() => Boolean(adminConfig?.updater?.forkRepo?.trim()));
  const [forkAdvancedOpen, setForkAdvancedOpen] = useState(false);

  useEffect(() => {
    if (updateInfo?.hasUpdate) setForkCardOpen(true);
  }, [updateInfo?.hasUpdate]);

  const handleCheckUpdate = async (force = false) => {
    try {
      setCheckingUpdate(true);
      const res = await apiRequest(`/api/admin/update/check${force ? '?force=1' : ''}`);
      setUpdateInfo(res);
      if (force) {
        onToast(res.hasUpdate ? `🎉 发现新版本 v${res.latestVersion}` : `✅ 已是最新版本 v${res.currentVersion}`);
      }
    } catch (err) {
      if (force) onToast(err.message);
      setUpdateInfo((prev) => ({ ...(prev || {}), ok: false, error: err.message }));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleSyncFork = async () => {
    try {
      setSyncingFork(true);
      setSyncResult(null);
      const res = await apiRequest('/api/admin/update/sync', {
        method: 'POST',
        body: draft.updater || {},
      });
      setSyncResult({ ok: true, text: res.message || '🎉 已同步上游代码！' });
      onToast(res.alreadyLatest ? '✅ 仓库已是最新代码' : '🚀 已同步上游，CF 正在自动构建');
    } catch (err) {
      setSyncResult({ ok: false, text: err.message });
    } finally {
      setSyncingFork(false);
    }
  };

  useEffect(() => {
    handleCheckUpdate(false);
  }, []);

  // Storage mode (`kv` vs `d1`) & progressive batched KV -> D1 visitor migration
  const [storageStatus, setStorageStatus] = useState(() => ({
    d1Bound: Boolean(adminConfig?.d1Bound),
    mode: adminConfig?.d1Bound ? 'd1' : 'kv',
    done: 0,
    total: 0,
    finished: !adminConfig?.d1Bound,
    loaded: false,
  }));
  const [loadingStorage, setLoadingStorage] = useState(false);
  const [migratingStorage, setMigratingStorage] = useState(false);
  const [migrationFeedback, setMigrationFeedback] = useState(null);
  const mountedRef = React.useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStorageStatus = async () => {
    try {
      setLoadingStorage(true);
      const res = await apiRequest('/api/admin/storage');
      if (!mountedRef.current) return;
      setStorageStatus({
        d1Bound: Boolean(res.d1Bound),
        mode: res.mode || (res.d1Bound ? 'd1' : 'kv'),
        done: Number(res.done || 0),
        total: Number(res.total || 0),
        finished: Boolean(res.finished),
        loaded: true,
      });
    } catch (err) {
      if (mountedRef.current) {
        setMigrationFeedback({ ok: false, text: err.message });
      }
    } finally {
      if (mountedRef.current) {
        setLoadingStorage(false);
      }
    }
  };

  useEffect(() => {
    if (section === 'update') {
      loadStorageStatus();
    }
  }, [section]);

  const handleMigrateAllVisitors = async () => {
    if (migratingStorage) return;
    try {
      setMigratingStorage(true);
      setMigrationFeedback(null);
      haptic('light');

      let safetyGuard = 0;
      while (mountedRef.current && safetyGuard < 2000) {
        safetyGuard += 1;
        const res = await apiRequest('/api/admin/storage/migrate', {
          method: 'POST',
          body: { batchSize: 20 },
        });
        if (!mountedRef.current) return;
        const done = Number(res.done || 0);
        const total = Number(res.total || 0);
        const finished = Boolean(res.finished);
        setStorageStatus({
          d1Bound: true,
          mode: 'd1',
          done,
          total,
          finished,
          loaded: true,
        });
        if (finished || Number(res.batchMigrated || 0) === 0) {
          setMigrationFeedback({
            ok: true,
            text: `✅ 已完成全部 ${done} / ${total} 位访客聊天记录迁移（KV 旧数据已原样保留作为备份）`,
          });
          onToast('🎉 访客聊天记录已全部迁移至 D1');
          break;
        }
      }
    } catch (err) {
      if (mountedRef.current) {
        setMigrationFeedback({
          ok: false,
          text: `${err.message}（已完成批次不会丢失或重复，可随时点击重试）`,
        });
        onToast(err.message);
      }
    } finally {
      if (mountedRef.current) {
        setMigratingStorage(false);
      }
    }
  };

  // Telegram Sticker / Custom Emoji pack browser state
  const [packInput, setPackInput] = useState('');
  const [loadingPack, setLoadingPack] = useState(false);
  const [loadedPack, setLoadedPack] = useState(null);

  // In-panel Sticker Quiz adder state
  const [showQuizAdder, setShowQuizAdder] = useState(false);
  const [quizPackInput, setQuizPackInput] = useState('');
  const [quizPackLoading, setQuizPackLoading] = useState(false);
  const [quizLoadedPack, setQuizLoadedPack] = useState(null);
  const [quizSelectedSticker, setQuizSelectedSticker] = useState(null);
  const [quizQuestion, setQuizQuestion] = useState('');
  const [quizAnswer, setQuizAnswer] = useState('');
  const [quizWrongText, setQuizWrongText] = useState('');

  // Keyword Auto-Reply rule editor state
  const [showKeywordAdder, setShowKeywordAdder] = useState(false);
  const [editingKeywordId, setEditingKeywordId] = useState('');
  const [kwInput, setKwInput] = useState('');
  const [kwMatchMode, setKwMatchMode] = useState('contains');
  const [kwReply, setKwReply] = useState('');
  const [kwForward, setKwForward] = useState(true);

  const resetKeywordForm = () => {
    setEditingKeywordId('');
    setKwInput('');
    setKwMatchMode('contains');
    setKwReply('');
    setKwForward(true);
  };

  const handleSaveKeywordRule = () => {
    const keywords = kwInput.trim();
    const reply = kwReply.trim();
    const tokens = keywords
      .split(/[,，\n|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      onToast('请至少填写一个触发关键词');
      return;
    }
    if (!reply) {
      onToast('请填写自动回复内容');
      return;
    }
    const current = Array.isArray(draft.pmBot?.keywordReplies) ? draft.pmBot.keywordReplies : [];
    if (!editingKeywordId && current.length >= 50) {
      onToast('最多可添加 50 条关键词回复规则');
      return;
    }
    const nextRule = {
      id: editingKeywordId || `kr-${Date.now()}`,
      keywords,
      matchMode: kwMatchMode === 'exact' ? 'exact' : 'contains',
      reply,
      forwardToAdmin: kwForward,
      enabled: editingKeywordId
        ? current.find((r) => r.id === editingKeywordId)?.enabled !== false
        : true,
    };
    const nextList = editingKeywordId
      ? current.map((r) => (r.id === editingKeywordId ? nextRule : r))
      : [...current, nextRule];
    updateField('pmBot', 'keywordReplies', nextList);
    resetKeywordForm();
    setShowKeywordAdder(false);
    onToast(editingKeywordId ? '已更新规则，别忘了点底部「保存全部设置」' : '已添加关键词规则，点底部「保存全部设置」生效');
  };

  const handleEditKeywordRule = (rule) => {
    setEditingKeywordId(rule.id);
    setKwInput(rule.keywords || '');
    setKwMatchMode(rule.matchMode === 'exact' ? 'exact' : 'contains');
    setKwReply(rule.reply || '');
    setKwForward(rule.forwardToAdmin !== false);
    setShowKeywordAdder(true);
  };

  const handleFetchQuizPack = async () => {
    if (!quizPackInput.trim()) {
      onToast('请粘贴 t.me/addstickers/... 贴纸包链接');
      return;
    }
    try {
      setQuizPackLoading(true);
      const res = await apiRequest('/api/admin/stickers/pack', {
        method: 'POST',
        body: { input: quizPackInput.trim() },
      });
      setQuizLoadedPack(res);
      onToast(`已加载「${res.title}」（共 ${res.stickers?.length || 0} 张贴纸）`);
    } catch (err) {
      onToast(err.message);
    } finally {
      setQuizPackLoading(false);
    }
  };

  const handleAddStickerQuiz = () => {
    if (!quizSelectedSticker?.fileId) {
      onToast('请先从贴纸包或收藏中点选一张贴纸');
      return;
    }
    const q = quizQuestion.trim();
    const a = quizAnswer.trim();
    const wrong = quizWrongText
      .split(/[,，|｜\n]+/)
      .map((s) => s.trim())
      .filter((s) => s && s !== a)
      .slice(0, 3);
    if (!q || !a || wrong.length === 0) {
      onToast('请填写题目、正确答案和至少 1 个干扰项');
      return;
    }
    const nextList = [
      {
        id: `sq_${Date.now()}`,
        ...quizSelectedSticker,
        question: q,
        answer: a,
        wrong,
      },
      ...(draft.pmBot.stickerChallenges || []),
    ].slice(0, 40);
    updateField('pmBot', 'stickerChallenges', nextList);
    setQuizSelectedSticker(null);
    setQuizQuestion('');
    setQuizAnswer('');
    setQuizWrongText('');
    setShowQuizAdder(false);
    onToast('🎉 已加入题库！记得点击底部「保存全部设置」');
  };

  const updateField = (group, key, value) => {
    setDraft((prev) => ({
      ...prev,
      [group]: { ...prev[group], [key]: value },
    }));
  };

  const defaultProbation = {
    enabled: true,
    maxMessages: 3,
    hours: 24,
    allowDomains: [],
  };

  const updateProbation = (patch) => {
    setDraft((prev) => ({
      ...prev,
      pmBot: {
        ...prev.pmBot,
        probation: {
          ...defaultProbation,
          ...(prev.pmBot?.probation || {}),
          ...patch,
        },
      },
    }));
  };

  const defaultProbeAlerts = {
    enabled: false,
    intervalMinutes: 5,
    confirmChecks: 2,
    notifyRecovery: true,
    mutedNodes: [],
    resource: { enabled: false, cpu: 90, ram: 90, disk: 90, sustainChecks: 3 },
  };

  const updateProbeAlerts = (patch) => {
    setDraft((prev) => ({
      ...prev,
      probe: {
        ...prev.probe,
        alerts: {
          ...defaultProbeAlerts,
          ...(prev.probe?.alerts || {}),
          ...patch,
          resource: {
            ...defaultProbeAlerts.resource,
            ...(prev.probe?.alerts?.resource || {}),
            ...(patch?.resource || {}),
          },
        },
      },
    }));
  };

  const toggleMutedNode = (uuid) => {
    const id = String(uuid || '').trim();
    if (!id) return;
    const current = Array.isArray(draft.probe?.alerts?.mutedNodes) ? draft.probe.alerts.mutedNodes : [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    updateProbeAlerts({ mutedNodes: next });
  };

  useEffect(() => {
    if (section !== 'probe' || !draft.probe?.alerts?.enabled || !String(draft.probe?.url || '').trim()) {
      return;
    }
    if (alertNodes.length > 0 || loadingAlertNodes) return;
    let cancelled = false;
    (async () => {
      try {
        setLoadingAlertNodes(true);
        const res = await apiRequest('/api/probe');
        if (!cancelled && Array.isArray(res?.nodes) && !res.demo) {
          setAlertNodes(res.nodes);
        }
      } catch {
        // Non-fatal: user can still click "测试探针连接" to pull nodes
      } finally {
        if (!cancelled) setLoadingAlertNodes(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [section, draft.probe?.alerts?.enabled, draft.probe?.url]);

  const handleTestProbeAlert = async () => {
    try {
      setSendingAlertTest(true);
      const res = await apiRequest('/api/admin/probe/alert-test', { method: 'POST' });
      onToast(res.ok ? `✅ 已发送到 ${res.targetLabel || '通知渠道'}` : res.error || '发送失败');
    } catch (err) {
      onToast(err.message);
    } finally {
      setSendingAlertTest(false);
    }
  };

  const updateEmblem = (patch) => {
    setDraft((prev) => ({
      ...prev,
      profile: {
        ...prev.profile,
        emblem: {
          ...(prev.profile?.emblem || {}),
          ...patch,
        },
      },
    }));
  };

  const updateSplash = (patch) => {
    setDraft((prev) => ({
      ...prev,
      profile: {
        ...prev.profile,
        splash: {
          style: 'emblem',
          text: '正在打开个人面板…',
          emoji: '🌹',
          ...(prev.profile?.splash || {}),
          ...patch,
        },
      },
    }));
  };

  const handleSelectSticker = (sticker) => {
    const existingSaved = Array.isArray(draft.profile?.emblem?.savedStickers)
      ? draft.profile.emblem.savedStickers
      : [];
    const mergedSaved = [sticker, ...existingSaved]
      .filter((item, idx, arr) => item?.fileId && arr.findIndex((x) => x.fileId === item.fileId) === idx)
      .slice(0, 30);

    updateEmblem({
      type: 'tg_sticker',
      fileId: sticker.fileId,
      format: sticker.format || 'webp',
      emoji: sticker.emoji || '',
      setName: sticker.setName || '',
      savedStickers: mergedSaved,
    });
    onToast('✨ 已选中该徽章，点底部「保存全部设置」生效');
  };

  const handleFetchStickerPack = async () => {
    if (!packInput.trim()) {
      onToast('请粘贴 t.me/addstickers/... 或 t.me/addemoji/... 链接');
      return;
    }
    try {
      setLoadingPack(true);
      const res = await apiRequest('/api/admin/stickers/pack', {
        method: 'POST',
        body: { input: packInput.trim() },
      });
      setLoadedPack(res);
      onToast(`已加载「${res.title}」（共 ${res.stickers?.length || 0} 枚）`);
    } catch (err) {
      onToast(err.message);
    } finally {
      setLoadingPack(false);
    }
  };

  const handleAddSite = (visibility = 'public') => {
    setDraft((prev) => ({
      ...prev,
      sites: [
        ...(prev.sites || []),
        {
          id: `site-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name: visibility === 'private' ? '常用私密站点' : '新公开小站',
          url: 'https://',
          description: '',
          category: visibility === 'private' ? '常用' : '工具',
          icon: visibility === 'private' ? '🔐' : '✨',
          badge: '',
          visibility,
        },
      ],
    }));
  };

  const handleUpdateSite = (idx, key, val) => {
    setDraft((prev) => {
      const next = [...prev.sites];
      next[idx] = { ...next[idx], [key]: val };
      return { ...prev, sites: next };
    });
  };

  const handleMoveSite = (idx, delta) => {
    setDraft((prev) => {
      const target = idx + delta;
      if (target < 0 || target >= prev.sites.length) return prev;
      const next = [...prev.sites];
      [next[idx], next[target]] = [next[target], next[idx]];
      return { ...prev, sites: next };
    });
  };

  const handleRemoveSite = (idx) => {
    setDraft((prev) => ({
      ...prev,
      sites: prev.sites.filter((_, i) => i !== idx),
    }));
  };

  const handleAddSocial = () => {
    setDraft((prev) => ({
      ...prev,
      profile: {
        ...prev.profile,
        socials: [
          ...(prev.profile.socials || []),
          { id: `soc-${Date.now()}`, label: '新链接', value: '', url: 'https://', icon: 'link' },
        ],
      },
    }));
  };

  const handleUpdateSocial = (idx, key, val) => {
    setDraft((prev) => {
      const next = [...(prev.profile.socials || [])];
      next[idx] = { ...next[idx], [key]: val };
      return { ...prev, profile: { ...prev.profile, socials: next } };
    });
  };

  const handleRemoveSocial = (idx) => {
    setDraft((prev) => ({
      ...prev,
      profile: {
        ...prev.profile,
        socials: prev.profile.socials.filter((_, i) => i !== idx),
      },
    }));
  };

  const handleTestProbe = async () => {
    try {
      setTestingProbe(true);
      setProbeTestResult(null);
      const res = await apiRequest('/api/admin/probe/test', {
        method: 'POST',
        body: draft.probe,
      });
      const latencyHint = res.latencyUnsupported
        ? '；当前 Komari 版本不支持批量延迟统计，升级 Komari 后可显示延迟'
        : '';
      setProbeTestResult({
        ok: true,
        text: `连接成功 (${res.protocol})！读取到 ${res.summary?.total || 0} 台节点（在线 ${res.summary?.online || 0} 台）${latencyHint}`,
      });
      if (Array.isArray(res.nodes) && !res.demo) {
        setAlertNodes(res.nodes);
      }
    } catch (err) {
      setProbeTestResult({ ok: false, text: err.message });
    } finally {
      setTestingProbe(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const res = await apiRequest('/api/admin/config', {
        method: 'PUT',
        body: draft,
      });
      onToast('✅ 面板配置已实时生效');
      onSaved(res);
      onClose();
    } catch (err) {
      onToast(err.message);
    } finally {
      setSaving(false);
    }
  };

  const emblem = draft.profile?.emblem || { type: 'builtin', variant: 'owner', savedStickers: [] };
  const isDirty = JSON.stringify(draft) !== JSON.stringify(adminConfig);

  const handleRequestClose = async () => {
    if (isDirty && !(await confirmDialog('还有未保存的设置修改，确定直接关闭吗？'))) {
      return;
    }
    onClose();
  };

  return (
    <div className="sheet-backdrop" onClick={handleRequestClose}>
      <div className="sheet-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <div className="sheet-title">面板可视化设置</div>
          <button className="icon-btn" onClick={handleRequestClose}>
            <X size={16} />
          </button>
        </div>

        <div className="chip-row">
          {[
            { id: 'profile', label: '名片与徽章' },
            { id: 'sites', label: '个人小站' },
            { id: 'probe', label: '节点探针' },
            { id: 'modes', label: '防骚扰验证' },
            { id: 'welcome', label: '欢迎与回复' },
            { id: 'update', label: '版本更新', badge: Boolean(updateInfo?.hasUpdate) },
          ].map((tab) => (
            <button
              key={tab.id}
              className={`chip ${section === tab.id ? 'active' : ''}`}
              style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 5 }}
              onClick={() => setSection(tab.id)}
            >
              {tab.label}
              {tab.badge && (
                <span
                  aria-label="有新版本"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--accent)',
                    display: 'inline-block',
                  }}
                />
              )}
            </button>
          ))}
        </div>

        {/* Section 1: Profile & Ticket Emblem (TG Stickers / Custom Emojis!) */}
        {section === 'profile' && (
          <>
            {/* Ticket Stub Emblem Picker Card */}
            <div className="card">
              <div className="card-header" style={{ marginBottom: 10 }}>
                <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Sparkles size={15} color="var(--accent)" /> 名片主徽章（支持 TG 贴纸 / 收藏表情）
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
                <div
                  style={{
                    width: 72,
                    height: 72,
                    borderRadius: 18,
                    background: 'var(--bg-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <TicketEmblem emblem={emblem} size={60} />
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[
                    { id: 'builtin', label: '内置玫瑰' },
                    { id: 'tg_sticker', label: 'TG 贴纸·表情' },
                    { id: 'url', label: '图片链接' },
                  ].map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      className={`pill ${emblem.type === mode.id ? 'rose' : ''}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => updateEmblem({ type: mode.id })}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>

              {emblem.type === 'builtin' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  {[
                    { id: 'owner', label: '玫瑰花瓣' },
                    { id: 'bottle', label: '水晶药水瓶' },
                    { id: 'crown', label: '星辰皇冠' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`sticker-cell ${emblem.variant === opt.id ? 'selected' : ''}`}
                      onClick={() => updateEmblem({ type: 'builtin', variant: opt.id })}
                    >
                      <TicketEmblem emblem={{ type: 'builtin', variant: opt.id }} size={44} />
                      <span style={{ fontSize: 11, marginTop: 4 }}>{opt.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {emblem.type === 'url' && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="field-label">透明底 PNG / WebP / GIF 图片链接</label>
                  <input
                    className="input"
                    value={emblem.url || ''}
                    onChange={(e) => updateEmblem({ type: 'url', url: e.target.value })}
                    placeholder="https://example.com/badge.webp"
                  />
                </div>
              )}

              {emblem.type === 'tg_sticker' && (
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--accent)',
                      background: 'var(--accent-soft)',
                      borderRadius: 12,
                      padding: '8px 10px',
                      marginBottom: 10,
                      lineHeight: 1.5,
                    }}
                  >
                    💡 <b>最快捷方式</b>：直接私聊机器人发 <code>/set</code>，再发任意一张贴纸、收藏的 TG 自定义表情或贴纸包链接即可秒设！也可在下方贴贴纸包链接挑选：
                  </div>

                  <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                    <input
                      className="input"
                      value={packInput}
                      onChange={(e) => setPackInput(e.target.value)}
                      placeholder="粘贴 t.me/addstickers/... 或 addemoji/..."
                    />
                    <button
                      type="button"
                      className="btn btn-soft"
                      style={{ flexShrink: 0 }}
                      disabled={loadingPack}
                      onClick={handleFetchStickerPack}
                    >
                      {loadingPack ? <RefreshCw size={14} className="spin" /> : '拉取'}
                    </button>
                  </div>

                  {loadedPack?.stickers?.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div className="field-label">
                        「{loadedPack.title}」点击选用（支持静态 / 动态）
                      </div>
                      <div className="sticker-grid">
                        {loadedPack.stickers.map((st) => (
                          <button
                            key={st.fileId}
                            type="button"
                            className={`sticker-cell ${emblem.fileId === st.fileId ? 'selected' : ''}`}
                            onClick={() => handleSelectSticker(st)}
                          >
                            <TgStickerMedia
                              fileId={st.thumbFileId || st.fileId}
                              format={st.thumbFileId ? 'webp' : st.format}
                              emoji={st.emoji}
                              size={42}
                              previewOnly
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {emblem.savedStickers?.length > 0 && (
                    <div>
                      <div className="field-label">我的收藏徽章库（点击切换）</div>
                      <div className="sticker-grid">
                        {emblem.savedStickers.map((st) => (
                          <button
                            key={st.fileId}
                            type="button"
                            className={`sticker-cell ${emblem.fileId === st.fileId ? 'selected' : ''}`}
                            onClick={() => handleSelectSticker(st)}
                          >
                            <TgStickerMedia
                              fileId={st.thumbFileId || st.fileId}
                              format={st.thumbFileId ? 'webp' : st.format}
                              emoji={st.emoji}
                              size={42}
                              previewOnly
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="card">
              <div className="field">
                <label className="field-label">显示昵称（顶栏标题）</label>
                <input
                  className="input"
                  value={draft.profile.displayName}
                  onChange={(e) => updateField('profile', 'displayName', e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">Bot / 个人账号标识（名片主标题，留空则显示昵称）</label>
                <input
                  className="input"
                  value={draft.profile.handle}
                  onChange={(e) => updateField('profile', 'handle', e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">当前状态文案</label>
                <input
                  className="input"
                  value={draft.profile.statusText}
                  onChange={(e) => updateField('profile', 'statusText', e.target.value)}
                  placeholder="例如：在线营业中 / 摸鱼中 / 勿扰"
                />
              </div>
              <div className="field">
                <label className="field-label">个人简介</label>
                <textarea
                  className="textarea"
                  value={draft.profile.tagline}
                  onChange={(e) => updateField('profile', 'tagline', e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">名片头像来源（站长与访客看到一致，不暴露数字 UID）</label>
                <select
                  className="input"
                  value={draft.profile.avatarMode || (draft.profile.avatarUrl ? 'custom' : 'bot')}
                  onChange={(e) => updateField('profile', 'avatarMode', e.target.value)}
                >
                  <option value="bot">🤖 自动同步机器人头像（默认推荐，隐藏私人主号）</option>
                  <option value="owner">👤 自动同步站长本人 TG 头像（服务端隐匿代理）</option>
                  <option value="custom">🖼️ 自定义头像图片链接</option>
                </select>
              </div>
              {(draft.profile.avatarMode === 'custom' || (!draft.profile.avatarMode && draft.profile.avatarUrl)) && (
                <div className="field">
                  <label className="field-label">自定义头像图片链接（支持 https:// 图床直链）</label>
                  <input
                    className="input"
                    value={draft.profile.avatarUrl}
                    onChange={(e) => updateField('profile', 'avatarUrl', e.target.value)}
                    placeholder="https://..."
                  />
                </div>
              )}
              <div className="field">
                <label className="field-label">置顶公告（留空则隐藏）</label>
                <input
                  className="input"
                  value={draft.profile.notice}
                  onChange={(e) => updateField('profile', 'notice', e.target.value)}
                  placeholder="可选：向访客展示一条置顶公告"
                />
              </div>
              <div className="field">
                <label className="field-label">个人标签（可选，逗号或空格分隔）</label>
                <input
                  className="input"
                  value={draft.profile.tags || ''}
                  onChange={(e) => updateField('profile', 'tags', e.target.value)}
                  placeholder="例如：VPS 折腾, 自托管, 开源, ACG"
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div className="field">
                  <label className="field-label">右侧票根顶部小标（留空隐藏）</label>
                  <input
                    className="input"
                    value={draft.profile.ownerTag ?? ''}
                    onChange={(e) => updateField('profile', 'ownerTag', e.target.value)}
                    placeholder="例如：个人名片"
                  />
                </div>
                <div className="field">
                  <label className="field-label">右侧票根主头衔（留空隐藏）</label>
                  <input
                    className="input"
                    value={draft.profile.badgeTitle ?? ''}
                    onChange={(e) => updateField('profile', 'badgeTitle', e.target.value)}
                    placeholder="例如：站长 · Owner"
                  />
                </div>
              </div>
              <div className="field">
                <label className="field-label">右侧票根副标（留空隐藏）</label>
                <input
                  className="input"
                  value={draft.profile.joinedText ?? ''}
                  onChange={(e) => updateField('profile', 'joinedText', e.target.value)}
                  placeholder="可选：留空则不显示，也可填写城市或个性短句"
                />
              </div>
              <div className="field">
                <label className="field-label">下方说明卡标题（如「来信礼仪」「关于我」）</label>
                <input
                  className="input"
                  value={draft.profile.noteTitle ?? '来信礼仪'}
                  onChange={(e) => updateField('profile', 'noteTitle', e.target.value)}
                  placeholder="来信礼仪"
                />
              </div>
              <div className="field">
                <label className="field-label">下方说明卡内容（每行一条，全部留空则隐藏）</label>
                <textarea
                  className="textarea"
                  value={draft.profile.noteLines ?? ''}
                  onChange={(e) => updateField('profile', 'noteLines', e.target.value)}
                  placeholder="例如：初次私聊请直接说明来意，不用只发「在吗」"
                />
              </div>

              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>在名片上公开显示本月访客数</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>
                    只统计通过 Telegram 打开名片的访客，每人每月计一次，不含你自己。
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(draft.profile.showVisitCounter)}
                  className={`switch ${draft.profile.showVisitCounter ? 'on' : ''}`}
                  onClick={() => updateField('profile', 'showVisitCounter', !draft.profile.showVisitCounter)}
                >
                  <span className="switch-knob" />
                </button>
              </div>

              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>在名片底部显示 RosePanel 署名</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>
                      署名能帮助更多人发现 RosePanel，感谢你的支持 🌹
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.profile.showPoweredBy !== false}
                    className={`switch ${draft.profile.showPoweredBy !== false ? 'on' : ''}`}
                    onClick={() => updateField('profile', 'showPoweredBy', !(draft.profile.showPoweredBy !== false))}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                {draft.profile.showPoweredBy !== false && (
                  <div className="powered-by-preview">
                    <span className="powered-by-preview-text">
                      {BRAND_SIGNATURE} · <span className="card-powered-by-cta">想要同款？</span>
                    </span>
                    <span className="powered-by-preview-badge">访客可见</span>
                  </div>
                )}
              </div>

              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div className="field-label" style={{ marginBottom: 8 }}>
                  开屏加载页风格（新访客首次打开 0ms 即显）
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {[
                    { id: 'emblem', label: '✨ 徽章呼吸' },
                    { id: 'emoji', label: '🌹 表情跳动' },
                    { id: 'skeleton', label: '🪄 卡片骨架屏' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`pill ${(draft.profile?.splash?.style || 'emblem') === opt.id ? 'rose' : ''}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => updateSplash({ style: opt.id })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(draft.profile?.splash?.style || 'emblem') === 'emoji' && (
                    <input
                      className="input"
                      style={{ width: 64, textAlign: 'center' }}
                      value={draft.profile?.splash?.emoji ?? '🌹'}
                      onChange={(e) => updateSplash({ emoji: e.target.value })}
                      placeholder="🌹"
                    />
                  )}
                  <input
                    className="input"
                    value={draft.profile?.splash?.text ?? '正在打开个人面板…'}
                    onChange={(e) => updateSplash({ text: e.target.value })}
                    placeholder="加载提示文案，如：正在打开个人面板…"
                  />
                </div>
              </div>

              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span className="field-label" style={{ margin: 0 }}>社交与联系方式</span>
                  <button className="btn btn-soft btn-sm" onClick={handleAddSocial}>
                    <Plus size={13} /> 添加
                  </button>
                </div>
                {(draft.profile.socials || []).map((soc, idx) => (
                  <div
                    key={soc.id || idx}
                    style={{
                      background: 'var(--bg-subtle)',
                      borderRadius: 14,
                      padding: 10,
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                      <input
                        className="input"
                        style={{ background: 'var(--bg-elevated)' }}
                        value={soc.label}
                        placeholder="名称"
                        onChange={(e) => handleUpdateSocial(idx, 'label', e.target.value)}
                      />
                      <button className="icon-btn" onClick={() => handleRemoveSocial(idx)}>
                        <Trash2 size={14} color="var(--red)" />
                      </button>
                    </div>
                    <input
                      className="input"
                      style={{ background: 'var(--bg-elevated)', marginBottom: 6 }}
                      value={soc.value}
                      placeholder="展示文字"
                      onChange={(e) => handleUpdateSocial(idx, 'value', e.target.value)}
                    />
                    <input
                      className="input"
                      style={{ background: 'var(--bg-elevated)' }}
                      value={soc.url}
                      placeholder="跳转 URL（留空则点击复制）"
                      onChange={(e) => handleUpdateSocial(idx, 'url', e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Navigation Order Card */}
            {(() => {
              const enableCheckin = Boolean(draft.community?.enableCheckin);
              const fullOrder = normalizeNavOrderDraft(draft.ui?.navOrder);
              const visibleOrder = fullOrder.filter((id) => id !== 'leaderboard' || enableCheckin);
              const navMeta = {
                profile: { label: enableCheckin ? '票根' : '名片', note: '' },
                sites: { label: '小站', note: '' },
                probe: {
                  label: '探针',
                  note:
                    draft.probe?.visibility === 'private'
                      ? '仅自己可见'
                      : !draft.probe?.url && !draft.probe?.demoMode
                        ? '未配置'
                        : '',
                },
                visitors: { label: '访客', note: '仅站长' },
                leaderboard: { label: '榜单', note: '群签到访客可见' },
              };
              const moveNavItem = (idx, delta) => {
                const targetIdx = idx + delta;
                if (targetIdx < 0 || targetIdx >= visibleOrder.length) return;
                const nextVisible = [...visibleOrder];
                [nextVisible[idx], nextVisible[targetIdx]] = [nextVisible[targetIdx], nextVisible[idx]];
                const hidden = fullOrder.filter((id) => !nextVisible.includes(id));
                const nextFull = [...nextVisible, ...hidden];
                setDraft((prev) => ({
                  ...prev,
                  ui: { ...(prev.ui || {}), navOrder: nextFull },
                }));
                haptic('light');
              };

              return (
                <div className="card">
                  <div className="card-header" style={{ marginBottom: 4 }}>
                    <span className="card-title">🧭 导航顺序</span>
                  </div>
                  <div className="row-desc wrap" style={{ marginBottom: 10 }}>
                    第一个是打开面板时的默认页；访客看不到的页面会自动跳过
                  </div>
                  <div className="nav-order-list">
                    {visibleOrder.map((id, idx) => {
                      const info = navMeta[id] || { label: id, note: '' };
                      return (
                        <div className="nav-order-row" key={id}>
                          <div className="nav-order-left">
                            <span className="nav-order-idx">{idx + 1}</span>
                            <span className="nav-order-label">{info.label}</span>
                            {idx === 0 && (
                              <span className="pill rose" style={{ padding: '2px 7px', fontSize: 10 }}>
                                默认页
                              </span>
                            )}
                            {info.note && (
                              <span className="pill" style={{ padding: '2px 7px', fontSize: 10 }}>
                                {info.note}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            <button
                              type="button"
                              className="icon-btn"
                              disabled={idx === 0}
                              title="上移"
                              aria-label={`上移 ${info.label}`}
                              onClick={() => moveNavItem(idx, -1)}
                            >
                              <ArrowUp size={13} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              disabled={idx === visibleOrder.length - 1}
                              title="下移"
                              aria-label={`下移 ${info.label}`}
                              onClick={() => moveNavItem(idx, 1)}
                            >
                              <ArrowDown size={13} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Promo & Referral Links Helper (Section 8) */}
            <div className="card">
              <div className="card-header" style={{ marginBottom: 8 }}>
                <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Link2 size={15} color="var(--accent)" /> 名片分享 · 推广链接
                </span>
              </div>
              {(() => {
                const botUsername = String(botInfo?.username || draft.botUsername || '')
                  .trim()
                  .replace(/^@/, '');
                const appShortName = String(botInfo?.appShortName || '')
                  .trim()
                  .replace(/^\/+|\/+$/g, '');
                if (!botUsername) {
                  return (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                      需要先配置 <code>BOT_USERNAME</code>。
                    </div>
                  );
                }
                const siteShareBase =
                  String(shareUrl || '').trim() ||
                  (typeof window !== 'undefined' ? `${window.location.origin}/` : '');
                const cardShareLink = appShortName
                  ? buildSourceLink(`https://t.me/${botUsername}/${appShortName}`, 'link', 'app')
                  : buildSourceLink(siteShareBase, 'link', 'web');
                const promoLinks = [
                  {
                    id: 'site',
                    label: '放在个人小站的「联系我」按钮',
                    url: buildSourceLink(`https://t.me/${botUsername}`, 'site', 'bot'),
                  },
                  {
                    id: 'channel',
                    label: '放在频道简介',
                    url: buildSourceLink(`https://t.me/${botUsername}`, 'channel', 'bot'),
                  },
                  ...(cardShareLink
                    ? [
                        {
                          id: 'card',
                          label: '分享名片',
                          url: cardShareLink,
                        },
                      ]
                    : []),
                ];
                return (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {promoLinks.map((item) => (
                        <div key={item.id} className="promo-link-row">
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div className="promo-link-label">{item.label}</div>
                            <div className="promo-link-url">{item.url}</div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-soft btn-sm"
                            style={{ flexShrink: 0 }}
                            onClick={async () => {
                              const ok = await copyText(item.url);
                              onToast(ok ? `已复制「${item.label}」链接` : '复制失败');
                            }}
                          >
                            <Copy size={12} /> 复制
                          </button>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.55 }}>
                      也可以把 <code>src_</code> 后面换成任意英文渠道名，例如 <code>src_nodeseek</code>，来源统计里就会单独显示。
                    </div>
                  </>
                );
              })()}
            </div>
          </>
        )}

        {/* Section 2: Sites (Public & Private Bookmarks + Reorder) */}
        {section === 'sites' && (
          <div>
            {(draft.sites || []).map((site, idx) => {
              const isPriv = site.visibility === 'private';
              return (
                <div className="card" key={site.id || idx}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 8,
                      gap: 6,
                    }}
                  >
                    <button
                      type="button"
                      className={`pill ${isPriv ? 'amber' : 'green'}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => handleUpdateSite(idx, 'visibility', isPriv ? 'public' : 'private')}
                    >
                      {isPriv ? <Lock size={11} /> : <Globe size={11} />}
                      {isPriv ? '仅我可见（私密隐藏）' : '公开可见'}
                    </button>

                    <div style={{ display: 'flex', gap: 5 }}>
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={idx === 0}
                        title="上移"
                        onClick={() => handleMoveSite(idx, -1)}
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={idx === draft.sites.length - 1}
                        title="下移"
                        onClick={() => handleMoveSite(idx, 1)}
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="删除"
                        onClick={() => handleRemoveSite(idx)}
                      >
                        <Trash2 size={14} color="var(--red)" />
                      </button>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      className="input"
                      style={{ width: 56, textAlign: 'center' }}
                      value={site.icon}
                      onChange={(e) => handleUpdateSite(idx, 'icon', e.target.value)}
                      placeholder="🌐"
                    />
                    <input
                      className="input"
                      value={site.name}
                      onChange={(e) => handleUpdateSite(idx, 'name', e.target.value)}
                      placeholder="站点名称"
                    />
                  </div>
                  <div className="field">
                    <input
                      className="input"
                      value={site.url}
                      onChange={(e) => handleUpdateSite(idx, 'url', e.target.value)}
                      placeholder="https://your-site.com"
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <input
                      className="input"
                      value={site.category}
                      onChange={(e) => handleUpdateSite(idx, 'category', e.target.value)}
                      placeholder="分类（如 博客 / 常用 / 后台）"
                    />
                    <input
                      className="input"
                      value={site.badge}
                      onChange={(e) => handleUpdateSite(idx, 'badge', e.target.value)}
                      placeholder="角标（可选，如 主站）"
                    />
                  </div>
                  <input
                    className="input"
                    value={site.description}
                    onChange={(e) => handleUpdateSite(idx, 'description', e.target.value)}
                    placeholder="一句话介绍"
                  />
                </div>
              );
            })}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <button className="btn btn-soft btn-block" onClick={() => handleAddSite('public')}>
                <Globe size={15} /> + 公开小站
              </button>
              <button className="btn btn-subtle btn-block" onClick={() => handleAddSite('private')}>
                <Lock size={15} /> + 私密常用站
              </button>
            </div>
          </div>
        )}

        {/* Section 3: Server Probe (Komari / Nezha / NodeGet / Generic JSON) */}
        {section === 'probe' && (() => {
          const activeProvider =
            PROBE_PROVIDER_OPTIONS.find((o) => o.id === (draft.probe.provider || 'komari')) ||
            PROBE_PROVIDER_OPTIONS[0];
          const probeAlerts = {
            ...defaultProbeAlerts,
            ...(draft.probe.alerts || {}),
            resource: {
              ...defaultProbeAlerts.resource,
              ...(draft.probe.alerts?.resource || {}),
            },
          };
          const alertInboxMode = adminConfig?.inboxMode || 'off';
          const alertInboxOff = alertInboxMode === 'off';
          const mutedList = Array.isArray(probeAlerts.mutedNodes) ? probeAlerts.mutedNodes : [];
          const knownUuids = new Set(alertNodes.map((n) => String(n.uuid || '')));
          const extraMutedUuids = mutedList.filter((id) => !knownUuids.has(id));
          return (
          <>
          <div className="card">
            <div className="field">
              <label className="field-label">探针类型</label>
              <select
                className="input"
                value={draft.probe.provider || 'komari'}
                onChange={(e) => {
                  updateField('probe', 'provider', e.target.value);
                  setProbeTestResult(null);
                }}
              >
                {PROBE_PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">{activeProvider.urlLabel}</label>
              <input
                className="input"
                value={draft.probe.url}
                onChange={(e) => updateField('probe', 'url', e.target.value)}
                placeholder={activeProvider.urlPlaceholder}
              />
            </div>
            <div className="field">
              <label className="field-label">对外跳转链接（可选，留空同上）</label>
              <input
                className="input"
                value={draft.probe.publicUrl}
                onChange={(e) => updateField('probe', 'publicUrl', e.target.value)}
                placeholder="https://status.example.com"
              />
            </div>
            <div className="field">
              <label className="field-label">{activeProvider.tokenLabel}</label>
              <input
                className="input"
                type="password"
                value={draft.probe.apiKey}
                onChange={(e) => updateField('probe', 'apiKey', e.target.value)}
                placeholder={activeProvider.tokenPlaceholder}
              />
            </div>

            <div className="list-row">
              <div className="row-main">
                <div className="row-title" style={{ fontSize: 14 }}>仅自己可见（对访客隐藏探针）</div>
                <div className="row-desc wrap">开启后访客看不到「探针」菜单，且服务端会拦截非站长探针请求</div>
              </div>
              <button
                type="button"
                className={`switch ${draft.probe.visibility === 'private' ? 'on' : ''}`}
                onClick={() =>
                  updateField('probe', 'visibility', draft.probe.visibility === 'private' ? 'public' : 'private')
                }
              >
                <span className="switch-knob" />
              </button>
            </div>

            <div className="list-row">
              <div className="row-main">
                <div className="row-title" style={{ fontSize: 14 }}>演示模式（未填地址时展示示例节点）</div>
                <div className="row-desc wrap">便于在未接入探针前预览节点卡片效果</div>
              </div>
              <button
                type="button"
                className={`switch ${draft.probe.demoMode ? 'on' : ''}`}
                onClick={() => updateField('probe', 'demoMode', !draft.probe.demoMode)}
              >
                <span className="switch-knob" />
              </button>
            </div>

            <button
              className="btn btn-soft btn-block"
              style={{ marginTop: 10 }}
              disabled={testingProbe}
              onClick={handleTestProbe}
            >
              <RefreshCw size={15} className={testingProbe ? 'spin' : ''} /> 测试探针连接
            </button>

            {probeTestResult && (
              <div
                style={{
                  marginTop: 10,
                  padding: '9px 12px',
                  borderRadius: 12,
                  fontSize: 12,
                  background: probeTestResult.ok ? 'var(--green-soft)' : 'var(--red-soft)',
                  color: probeTestResult.ok ? 'var(--green)' : 'var(--red)',
                }}
              >
                {probeTestResult.ok ? '✅ ' : '❌ '}
                {probeTestResult.text}
              </div>
            )}
          </div>

          <div className="card">
            <div className="list-row" style={{ paddingTop: 0 }}>
              <div className="row-main">
                <div className="row-title" style={{ fontSize: 14 }}>🔔 掉线告警（默认关闭）</div>
                <div className="row-desc wrap">
                  节点掉线、恢复或持续高负载时由 Bot 主动通知站长（关闭时零探针请求、零 KV 写入）
                </div>
              </div>
              <button
                type="button"
                className={`switch ${probeAlerts.enabled ? 'on' : ''}`}
                disabled={alertInboxOff}
                style={alertInboxOff ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                onClick={() => {
                  if (alertInboxOff) return;
                  updateProbeAlerts({ enabled: !probeAlerts.enabled });
                }}
              >
                <span className="switch-knob" />
              </button>
            </div>

            {alertInboxOff ? (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  padding: '8px 11px',
                  borderRadius: 12,
                  background: 'var(--amber-soft)',
                  color: 'var(--amber)',
                  lineHeight: 1.5,
                }}
              >
                ⚠️ 请先配置 ADMIN_IDS 或绑定通知群
              </div>
            ) : (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  padding: '8px 11px',
                  borderRadius: 12,
                  background: 'var(--bg-subtle)',
                  color: 'var(--text-secondary)',
                  lineHeight: 1.5,
                }}
              >
                通知会发到：
                {alertInboxMode === 'topic' ? '通知群「🔔 探针告警」话题' : 'Bot 私聊'}
              </div>
            )}

            {probeAlerts.enabled && !alertInboxOff && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">检测间隔</label>
                    <select
                      className="input"
                      value={probeAlerts.intervalMinutes}
                      onChange={(e) => updateProbeAlerts({ intervalMinutes: Number(e.target.value) })}
                    >
                      <option value={5}>每 5 分钟</option>
                      <option value={10}>每 10 分钟</option>
                      <option value={15}>每 15 分钟</option>
                      <option value={30}>每 30 分钟</option>
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">确认次数（1–5）</label>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      max="5"
                      value={probeAlerts.confirmChecks}
                      onChange={(e) =>
                        updateProbeAlerts({
                          confirmChecks: e.target.value === '' ? '' : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>

                <div className="list-row">
                  <div className="row-main">
                    <div className="row-title" style={{ fontSize: 13 }}>节点恢复时发送静默通知</div>
                    <div className="row-desc wrap">仅对之前通知过掉线的节点发送恢复提醒（静默不响铃）</div>
                  </div>
                  <button
                    type="button"
                    className={`switch ${probeAlerts.notifyRecovery !== false ? 'on' : ''}`}
                    onClick={() => updateProbeAlerts({ notifyRecovery: probeAlerts.notifyRecovery === false })}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                <div className="list-row" style={{ marginTop: 4, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div className="row-main">
                    <div className="row-title" style={{ fontSize: 13 }}>资源超限告警（CPU / 内存 / 磁盘）</div>
                    <div className="row-desc wrap">连续多次达到阈值时提醒，回落后自动清除（不发恢复通知）</div>
                  </div>
                  <button
                    type="button"
                    className={`switch ${probeAlerts.resource.enabled ? 'on' : ''}`}
                    onClick={() =>
                      updateProbeAlerts({ resource: { enabled: !probeAlerts.resource.enabled } })
                    }
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                {probeAlerts.resource.enabled && (
                  <div
                    style={{
                      background: 'var(--bg-subtle)',
                      borderRadius: 14,
                      padding: 10,
                      marginTop: 8,
                      marginBottom: 10,
                    }}
                  >
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label className="field-label">CPU 阈值（%，0 禁用）</label>
                        <input
                          className="input"
                          type="number"
                          min="0"
                          max="100"
                          value={probeAlerts.resource.cpu}
                          onChange={(e) =>
                            updateProbeAlerts({
                              resource: { cpu: e.target.value === '' ? '' : Number(e.target.value) },
                            })
                          }
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label className="field-label">内存阈值（%，0 禁用）</label>
                        <input
                          className="input"
                          type="number"
                          min="0"
                          max="100"
                          value={probeAlerts.resource.ram}
                          onChange={(e) =>
                            updateProbeAlerts({
                              resource: { ram: e.target.value === '' ? '' : Number(e.target.value) },
                            })
                          }
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label className="field-label">磁盘阈值（%，0 禁用）</label>
                        <input
                          className="input"
                          type="number"
                          min="0"
                          max="100"
                          value={probeAlerts.resource.disk}
                          onChange={(e) =>
                            updateProbeAlerts({
                              resource: { disk: e.target.value === '' ? '' : Number(e.target.value) },
                            })
                          }
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label className="field-label">持续次数（1–10）</label>
                        <input
                          className="input"
                          type="number"
                          min="1"
                          max="10"
                          value={probeAlerts.resource.sustainChecks}
                          onChange={(e) =>
                            updateProbeAlerts({
                              resource: {
                                sustainChecks: e.target.value === '' ? '' : Number(e.target.value),
                              },
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div className="field-label" style={{ marginBottom: 6 }}>
                    静音节点（点击切换，静音后完全跳过检测与通知）
                  </div>
                  {loadingAlertNodes ? (
                    <div className="row-desc">正在加载节点列表…</div>
                  ) : alertNodes.length > 0 || extraMutedUuids.length > 0 ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {alertNodes.map((node) => {
                        const uuid = String(node.uuid || '');
                        const muted = mutedList.includes(uuid);
                        return (
                          <button
                            key={uuid}
                            type="button"
                            className={`pill ${muted ? 'amber' : ''}`}
                            style={{ cursor: 'pointer', fontSize: 11 }}
                            onClick={() => toggleMutedNode(uuid)}
                          >
                            {muted ? '🔇 ' : ''}
                            {node.region ? `${node.region} ` : ''}
                            {node.name}
                          </button>
                        );
                      })}
                      {extraMutedUuids.map((uuid) => (
                        <button
                          key={uuid}
                          type="button"
                          className="pill amber"
                          style={{ cursor: 'pointer', fontSize: 11 }}
                          onClick={() => toggleMutedNode(uuid)}
                        >
                          🔇 {uuid}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="row-desc wrap">
                      暂未拉取到节点列表：请先填写探针地址并点击上方「测试探针连接」或保存后重新打开。
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="btn btn-soft btn-block"
                  style={{ marginTop: 12 }}
                  disabled={sendingAlertTest}
                  onClick={handleTestProbeAlert}
                >
                  {sendingAlertTest ? '发送中…' : '🔔 发送测试告警'}
                </button>
              </div>
            )}
          </div>
          </>
          );
        })()}

        {/* Section 4: PM Anti-Spam & Verification */}
        {section === 'modes' && (
          <div className="card">
            {adminConfig?.inboxMode && (
              <div style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontSize: 12,
                    padding: '8px 11px',
                    borderRadius: 12,
                    background: 'var(--bg-subtle)',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                  }}
                >
                  {adminConfig.inboxMode === 'topic'
                    ? '当前通知方式：话题群'
                    : adminConfig.inboxMode === 'dm'
                      ? '当前通知方式：Bot 私聊推送（绑定话题群后自动切换）'
                      : '当前通知方式：未配置（配置 ADMIN_IDS 或在话题群发送 /bind 开启）'}
                </div>
                {adminConfig.ownerUnreachable && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      padding: '8px 11px',
                      borderRadius: 12,
                      background: 'var(--amber-soft)',
                      color: 'var(--amber)',
                      lineHeight: 1.5,
                    }}
                  >
                    ⚠️ 请先私聊 Bot 发送 /start，否则收不到推送（消息仍可在面板查看）
                  </div>
                )}
                {adminConfig.webhookNeedsResync && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      padding: '8px 11px',
                      borderRadius: 12,
                      background: 'var(--amber-soft)',
                      color: 'var(--amber)',
                      lineHeight: 1.5,
                    }}
                  >
                    💡 请重新运行一次 /setup 以启用表情回应同步
                  </div>
                )}
              </div>
            )}
            <div>
              <label className="field-label">私聊防骚扰人机验证模式（陌生人点 /start 或发消息立即触发）</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {[
                  { id: 'emoji', label: '🎯 Emoji 找茬/点选', desc: '0延迟推荐' },
                  {
                    id: 'sticker_quiz',
                    label: '🎭 表情包看图猜题',
                    desc: `已录 ${(draft.pmBot.stickerChallenges || []).length} 题`,
                  },
                  { id: 'quiz', label: '📝 常识题库', desc: '0延迟四选一' },
                  { id: 'turnstile', label: '🛡️ CF Turnstile', desc: '严格防扫号' },
                  { id: 'off', label: '关闭验证', desc: '直接转发' },
                ].map((opt) => {
                  const active = (draft.pmBot.verificationMode || 'emoji') === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`sticker-cell ${active ? 'selected' : ''}`}
                      style={{ padding: '10px 8px', textAlign: 'center' }}
                      onClick={() => {
                        updateField('pmBot', 'verificationMode', opt.id);
                        updateField('pmBot', 'enableVerification', opt.id !== 'off');
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{opt.label}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        {opt.desc}
                      </span>
                    </button>
                  );
                })}
              </div>

              {(draft.pmBot.verificationMode === 'sticker_quiz' ||
                (draft.pmBot.stickerChallenges || []).length > 0) && (
                <div
                  style={{
                    background: 'var(--bg-subtle)',
                    borderRadius: 16,
                    padding: 12,
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 8,
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 700 }}>
                      🎭 我的表情包验证题库（{(draft.pmBot.stickerChallenges || []).length} 题）
                    </span>
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      onClick={() => setShowQuizAdder((v) => !v)}
                    >
                      <Plus size={13} /> {showQuizAdder ? '收起' : '面板添加'}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 8, lineHeight: 1.5 }}>
                    💡 既可点右上角「面板添加」拉贴纸包选图出题，也可直接私聊机器人发 <code>/add</code> 3 秒直录！
                    {(draft.pmBot.stickerChallenges || []).length === 0 &&
                      '（当前题库为空时会自动回退到 Emoji 模式）'}
                  </div>

                  {showQuizAdder && (
                    <div
                      style={{
                        background: 'var(--bg-elevated)',
                        borderRadius: 14,
                        padding: 10,
                        marginBottom: 10,
                        border: '1px solid var(--accent-line)',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                        <input
                          className="input"
                          value={quizPackInput}
                          onChange={(e) => setQuizPackInput(e.target.value)}
                          placeholder="粘贴贴纸包链接（如 t.me/addstickers/cclovely）"
                        />
                        <button
                          type="button"
                          className="btn btn-soft"
                          style={{ flexShrink: 0 }}
                          disabled={quizPackLoading}
                          onClick={handleFetchQuizPack}
                        >
                          {quizPackLoading ? <RefreshCw size={14} className="spin" /> : '拉取'}
                        </button>
                      </div>

                      {quizLoadedPack?.stickers?.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <div className="field-label">点击选用一张贴纸：</div>
                          <div className="sticker-grid" style={{ maxHeight: 160 }}>
                            {quizLoadedPack.stickers.map((st) => (
                              <button
                                key={st.fileId}
                                type="button"
                                className={`sticker-cell ${quizSelectedSticker?.fileId === st.fileId ? 'selected' : ''}`}
                                onClick={() => setQuizSelectedSticker(st)}
                              >
                                <TgStickerMedia
                                  fileId={st.thumbFileId || st.fileId}
                                  format={st.thumbFileId ? 'webp' : st.format}
                                  emoji={st.emoji}
                                  size={40}
                                  previewOnly
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {quizSelectedSticker && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                          <TgStickerMedia
                            fileId={quizSelectedSticker.thumbFileId || quizSelectedSticker.fileId}
                            format={quizSelectedSticker.thumbFileId ? 'webp' : quizSelectedSticker.format}
                            emoji={quizSelectedSticker.emoji}
                            size={44}
                            previewOnly
                          />
                          <span className="pill green">已选中贴纸</span>
                        </div>
                      )}

                      <div className="field" style={{ marginBottom: 6 }}>
                        <input
                          className="input"
                          value={quizQuestion}
                          onChange={(e) => setQuizQuestion(e.target.value)}
                          placeholder="问题（如：上面这个画面在干嘛？）"
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 6 }}>
                        <input
                          className="input"
                          value={quizAnswer}
                          onChange={(e) => setQuizAnswer(e.target.value)}
                          placeholder="正确答案（如：两条腿在晃）"
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                            3 个干扰项（逗号分隔）
                          </span>
                          <button
                            type="button"
                            className="pill rose"
                            style={{ cursor: 'pointer', fontSize: 10, padding: '2px 7px' }}
                            onClick={() => setQuizWrongText('在开挖掘机, 在写微积分, 在修宇宙飞船')}
                          >
                            🎲 填离谱干扰项
                          </button>
                        </div>
                        <input
                          className="input"
                          value={quizWrongText}
                          onChange={(e) => setQuizWrongText(e.target.value)}
                          placeholder="例如：在开挖掘机, 在写微积分, 在修宇宙飞船"
                        />
                      </div>

                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        onClick={handleAddStickerQuiz}
                      >
                        加入题库
                      </button>
                    </div>
                  )}

                  {(draft.pmBot.stickerChallenges || []).map((item, idx) => (
                    <div
                      key={item.id || idx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        background: 'var(--bg-elevated)',
                        borderRadius: 13,
                        padding: 8,
                        marginBottom: 6,
                      }}
                    >
                      <TgStickerMedia
                        fileId={item.thumbFileId || item.fileId}
                        format={item.thumbFileId ? 'webp' : item.format}
                        emoji={item.emoji || '🎭'}
                        size={42}
                        previewOnly
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.question}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 2 }}>
                          ✅ {item.answer}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          干扰项：{(item.wrong || []).join(' / ')}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="icon-btn"
                        title="删除该题"
                        onClick={() =>
                          updateField(
                            'pmBot',
                            'stickerChallenges',
                            (draft.pmBot.stickerChallenges || []).filter((_, i) => i !== idx)
                          )
                        }
                      >
                        <Trash2 size={14} color="var(--red)" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {draft.pmBot.verificationMode === 'turnstile' && (
                <div
                  style={{
                    fontSize: 12,
                    padding: '8px 10px',
                    borderRadius: 12,
                    marginBottom: 10,
                    background: draft.pmBot.turnstileReady ? 'var(--green-soft)' : 'var(--amber-soft)',
                    color: draft.pmBot.turnstileReady ? 'var(--green)' : 'var(--amber)',
                  }}
                >
                  {draft.pmBot.turnstileReady
                    ? '✅ 已检测到 Cloudflare Turnstile 密钥，严格模式就绪！'
                    : '⚠️ 尚未配置 TURNSTILE_SITE_KEY / TURNSTILE_SECRET，未配置前将自动回退至 Emoji 点选。'}
                </div>
              )}

              {draft.pmBot.verificationMode !== 'off' && (
                <div className="field" style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                    <label className="field-label" style={{ margin: 0 }}>
                      验证通过免重复验证天数（1–3650 天）
                    </label>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {[7, 30, 90, 365].map((d) => (
                        <button
                          key={d}
                          type="button"
                          className={`pill ${Number(draft.pmBot.verifiedDays ?? 30) === d ? 'rose' : ''}`}
                          style={{ cursor: 'pointer', fontSize: 10, padding: '2px 7px' }}
                          onClick={() => updateField('pmBot', 'verifiedDays', d)}
                        >
                          {d}天
                        </button>
                      ))}
                    </div>
                  </div>
                  <input
                    className="input"
                    type="number"
                    min="1"
                    max="3650"
                    value={draft.pmBot.verifiedDays ?? 30}
                    onChange={(e) =>
                      updateField('pmBot', 'verifiedDays', e.target.value === '' ? '' : Number(e.target.value))
                    }
                  />
                </div>
              )}

              {draft.pmBot.verificationMode !== 'off' && draft.pmBot.verificationMode !== 'turnstile' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">最多容错次数</label>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      max="5"
                      value={draft.pmBot.maxVerifyFailures ?? 2}
                      onChange={(e) => updateField('pmBot', 'maxVerifyFailures', Number(e.target.value))}
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">失败冷却（分钟）</label>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      max="1440"
                      value={draft.pmBot.cooldownMinutes ?? 10}
                      onChange={(e) => updateField('pmBot', 'cooldownMinutes', Number(e.target.value))}
                    />
                  </div>
                </div>
              )}

              {/* 4-Layer Anti-Spam Shield Toggles */}
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <div className="field-label" style={{ marginBottom: 6 }}>🛡️ 四层智能反广告护盾</div>

                <div className="list-row">
                  <div className="row-main">
                    <div className="row-title" style={{ fontSize: 13 }}>CAS 全球反垃圾黑名单联防</div>
                    <div className="row-desc wrap">陌生人首次联系查 api.cas.chat（KV 缓存），命中已知协议号直接静默拦截</div>
                  </div>
                  <button
                    type="button"
                    className={`switch ${draft.pmBot.enableCasCheck !== false ? 'on' : ''}`}
                    onClick={() => updateField('pmBot', 'enableCasCheck', draft.pmBot.enableCasCheck === false)}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                <div className="list-row">
                  <div className="row-main">
                    <div className="row-title" style={{ fontSize: 13 }}>拦截未验证首条图片 / 广告海报</div>
                    <div className="row-desc wrap">防 USDT/赌场/机场纯图广告：未验证发图不转发，必须先过验证再发图</div>
                  </div>
                  <button
                    type="button"
                    className={`switch ${draft.pmBot.blockUnverifiedMedia !== false ? 'on' : ''}`}
                    onClick={() =>
                      updateField('pmBot', 'blockUnverifiedMedia', draft.pmBot.blockUnverifiedMedia === false)
                    }
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                <div className="list-row">
                  <div className="row-main">
                    <div className="row-title" style={{ fontSize: 13 }}>高危广告自动升级 CF Turnstile</div>
                    <div className="row-desc wrap">检测到转发、外链、首条图片、零宽混淆或广告昵称自动拉高验证等级</div>
                  </div>
                  <button
                    type="button"
                    className={`switch ${draft.pmBot.smartEscalation !== false ? 'on' : ''}`}
                    onClick={() => updateField('pmBot', 'smartEscalation', draft.pmBot.smartEscalation === false)}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                <div className="list-row">
                  <div className="row-main">
                    <div className="row-title" style={{ fontSize: 13 }}>蜜罐防盲点陷阱</div>
                    <div className="row-desc wrap">
                      在验证题底部埋设「防脚本陷阱」按钮，默认进入冷却锁定（避免真人手滑或眼花被永久失联）
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`switch ${draft.pmBot.enableHoneypot !== false ? 'on' : ''}`}
                    onClick={() => updateField('pmBot', 'enableHoneypot', draft.pmBot.enableHoneypot === false)}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                {draft.pmBot.enableHoneypot !== false && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, marginBottom: 4 }}>
                    {[
                      { id: 'cooldown', label: '⏳ 冷却锁定（推荐 · 防真人误触）' },
                      { id: 'ban', label: '🚫 直接拉黑（可在访客列表解封）' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`pill ${(draft.pmBot.honeypotAction || 'cooldown') === opt.id ? 'rose' : ''}`}
                        style={{ cursor: 'pointer', fontSize: 11 }}
                        onClick={() => updateField('pmBot', 'honeypotAction', opt.id)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}

                {(() => {
                  const prob = {
                    ...defaultProbation,
                    ...(draft.pmBot.probation || {}),
                  };
                  const probEnabled = prob.enabled !== false;
                  return (
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                      <div className="list-row" style={{ paddingTop: 0 }}>
                        <div className="row-main">
                          <div className="row-title" style={{ fontSize: 13 }}>🛡️ 新访客观察期</div>
                          <div className="row-desc wrap">
                            刚通过验证的访客，前几条消息如果带链接、@用户名、联系方式或是转发的，会先扣下等你审核，不会丢失。
                          </div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={probEnabled}
                          className={`switch ${probEnabled ? 'on' : ''}`}
                          onClick={() => updateProbation({ enabled: !probEnabled })}
                        >
                          <span className="switch-knob" />
                        </button>
                      </div>

                      {probEnabled && (
                        <div
                          style={{
                            background: 'var(--bg-subtle)',
                            borderRadius: 14,
                            padding: 10,
                            marginTop: 8,
                          }}
                        >
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                            <div className="field" style={{ marginBottom: 0 }}>
                              <label className="field-label">观察条数（1–20 条）</label>
                              <input
                                className="input"
                                type="number"
                                min="1"
                                max="20"
                                value={prob.maxMessages}
                                onChange={(e) =>
                                  updateProbation({
                                    maxMessages: e.target.value === '' ? '' : Number(e.target.value),
                                  })
                                }
                              />
                            </div>
                            <div className="field" style={{ marginBottom: 0 }}>
                              <label className="field-label">观察时长（1–168 小时）</label>
                              <input
                                className="input"
                                type="number"
                                min="1"
                                max="168"
                                value={prob.hours}
                                onChange={(e) =>
                                  updateProbation({
                                    hours: e.target.value === '' ? '' : Number(e.target.value),
                                  })
                                }
                              />
                            </div>
                          </div>
                          <div className="field" style={{ marginBottom: 0 }}>
                            <label className="field-label">链接白名单域名（每行一个，自动匹配子域名）</label>
                            <textarea
                              className="textarea"
                              rows={2}
                              value={probationDomainsText}
                              onChange={(e) => {
                                const nextText = e.target.value;
                                setProbationDomainsText(nextText);
                                const parsed = nextText
                                  .split(/[\r\n,，;；]+/)
                                  .map((s) => s.trim())
                                  .filter(Boolean);
                                updateProbation({ allowDomains: parsed });
                              }}
                              placeholder={'例如：\ngithub.com\nexample.com'}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="field" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div className="kw-field-head">
                    <label className="field-label" style={{ marginBottom: 0 }}>
                      广告屏蔽关键词（自动去零宽/全角/同形字混淆）
                    </label>
                    {Boolean((draft.pmBot.blockedKeywords || '').trim()) && (
                      <button
                        type="button"
                        className="kw-preset-group-add remove"
                        onClick={() => {
                          updateField('pmBot', 'blockedKeywords', '');
                          haptic('light');
                          onToast('已清空屏蔽关键词（记得点击保存生效）');
                        }}
                      >
                        清空全部
                      </button>
                    )}
                  </div>

                  <div className="kw-preset-box">
                    {KEYWORD_PRESET_GROUPS.map((group) => {
                      const rawKw = draft.pmBot.blockedKeywords || '';
                      const allAdded = group.keywords.every((kw) => hasBlockedKeyword(rawKw, kw));
                      return (
                        <div className="kw-preset-group" key={group.id}>
                          <div className="kw-preset-group-head">
                            <span className="kw-preset-group-label">{group.label}</span>
                            <button
                              type="button"
                              className={`kw-preset-group-add ${allAdded ? 'remove' : ''}`}
                              onClick={() => {
                                if (allAdded) {
                                  const res = removeBlockedKeywordGroup(rawKw, group.keywords);
                                  updateField('pmBot', 'blockedKeywords', res.value);
                                  haptic('light');
                                  if (res.removedCount > 0) {
                                    onToast(`已移除「${group.label}」${res.removedCount} 个词`);
                                  }
                                  return;
                                }
                                const res = addBlockedKeywordGroup(rawKw, group.keywords, BLOCKED_KEYWORD_MAX_LENGTH);
                                updateField('pmBot', 'blockedKeywords', res.value);
                                haptic('light');
                                if (res.truncated) {
                                  onToast(`已达 ${BLOCKED_KEYWORD_MAX_LENGTH} 字符上限，仅添加部分预设词`);
                                } else if (res.addedCount > 0) {
                                  onToast(`已添加「${group.label}」${res.addedCount} 个词`);
                                }
                              }}
                            >
                              {allAdded ? '移除整组' : '+ 整组添加'}
                            </button>
                          </div>
                          <div className="kw-preset-pills">
                            {group.keywords.map((kw) => {
                              const active = hasBlockedKeyword(rawKw, kw);
                              return (
                                <button
                                  key={kw}
                                  type="button"
                                  className={`kw-preset-pill ${active ? 'active' : ''}`}
                                  aria-pressed={active}
                                  onClick={() => {
                                    const res = toggleBlockedKeyword(rawKw, kw, BLOCKED_KEYWORD_MAX_LENGTH);
                                    if (res.truncated) {
                                      onToast(`已达 ${BLOCKED_KEYWORD_MAX_LENGTH} 字符上限，无法继续添加`);
                                      return;
                                    }
                                    updateField('pmBot', 'blockedKeywords', res.value);
                                    haptic('light');
                                  }}
                                >
                                  {active ? '✓ ' : '+ '}
                                  {kw}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <textarea
                    className="textarea"
                    maxLength={BLOCKED_KEYWORD_MAX_LENGTH}
                    value={draft.pmBot.blockedKeywords || ''}
                    onChange={(e) => updateField('pmBot', 'blockedKeywords', e.target.value)}
                    placeholder="逗号或换行分隔，可点上方预设快速加入，或手动填写广告特有短语"
                  />
                  <div className="row-desc wrap" style={{ marginTop: 6 }}>
                    命中的消息会被直接丢弃，你和对方都不会收到提示。建议只添加广告特有的短语；熟人可设为永久信任，不受关键词限制。
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Section 5: Pre-Start Greeting, Panel Entry Visibility, Auto-Reply & Optional Group Check-in */}
        {section === 'welcome' && (
          <>
            <div className="card">
              <div className="field-label" style={{ marginBottom: 8 }}>👋 进门欢迎引导与面板入口</div>

              <div className="field">
                <label className="field-label">主人欢迎 / 引导语</label>
                <textarea
                  className="textarea"
                  value={draft.pmBot.welcomeText}
                  onChange={(e) => updateField('pmBot', 'welcomeText', e.target.value)}
                  placeholder="例如：你好呀 🌸 点击下方「开始」完成简单验证后，即可直接打字联系我。"
                />
              </div>

              <div className="list-row">
                <div className="row-main">
                  <div className="row-title" style={{ fontSize: 13 }}>同步欢迎语到机器人顶部介绍框（推荐）</div>
                  <div className="row-desc wrap">
                    开启后保存设置会自动更新 Telegram 机器人的官方介绍文字，陌生人点开聊天窗、还没按「开始」时就能直接在屏幕中央看到上面的引导语
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch ${draft.pmBot.syncBotDescription !== false ? 'on' : ''}`}
                  onClick={() =>
                    updateField('pmBot', 'syncBotDescription', draft.pmBot.syncBotDescription === false)
                  }
                >
                  <span className="switch-knob" />
                </button>
              </div>

              <div className="field" style={{ marginTop: 10 }}>
                <label className="field-label">可选：/start 欢迎配图链接（https:// 图床直链，留空不发图）</label>
                <input
                  className="input"
                  value={draft.pmBot.welcomeImageUrl || ''}
                  onChange={(e) => updateField('pmBot', 'welcomeImageUrl', e.target.value)}
                  placeholder="https://example.com/welcome.jpg"
                />
                <div className="row-desc wrap" style={{ marginTop: 5 }}>
                  💡 小贴士：若还想在陌生人未按「开始」前的介绍框顶部展示固定封面图，在 <code>@BotFather</code> → <code>Edit Bot</code> → <code>Edit Description Picture</code> 上传一张图片即可永久显示。
                </div>
              </div>

              <div className="list-row" style={{ marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <div className="row-main">
                  <div className="row-title" style={{ fontSize: 13 }}>点 /start 时展示欢迎引导语</div>
                  <div className="row-desc wrap">
                    陌生人点「开始」会立即弹出人机验证（开启本项时验证题上方会附带你的欢迎语；关闭则直接弹出纯净验证题）
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch ${draft.pmBot.enableStartWelcome !== false ? 'on' : ''}`}
                  onClick={() => updateField('pmBot', 'enableStartWelcome', draft.pmBot.enableStartWelcome === false)}
                >
                  <span className="switch-knob" />
                </button>
              </div>

              <div className="list-row">
                <div className="row-main">
                  <div className="row-title" style={{ fontSize: 13 }}>验证通过后附带「查看个人面板」按钮</div>
                  <div className="row-desc wrap">
                    验证通过提示「现在可以打字给主人发消息了」下方是否附带个人面板入口按钮（纯私聊党可关闭）
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch ${draft.pmBot.showPanelButtonInWelcome !== false ? 'on' : ''}`}
                  onClick={() =>
                    updateField('pmBot', 'showPanelButtonInWelcome', draft.pmBot.showPanelButtonInWelcome === false)
                  }
                >
                  <span className="switch-knob" />
                </button>
              </div>

              <div className="list-row">
                <div className="row-main">
                  <div className="row-title" style={{ fontSize: 13 }}>聊天框左下角显示「个人面板」按钮</div>
                  <div className="row-desc wrap">
                    关闭并保存后，左下角将恢复为普通命令菜单（隐藏面板入口；站长随时发 /panel 仍可打开面板后台）
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch ${draft.pmBot.showChatMenuButton !== false ? 'on' : ''}`}
                  onClick={() =>
                    updateField('pmBot', 'showChatMenuButton', draft.pmBot.showChatMenuButton === false)
                  }
                >
                  <span className="switch-knob" />
                </button>
              </div>

              <div className="list-row">
                <div className="row-main">
                  <div className="row-title" style={{ fontSize: 13 }}>话题访客资料卡附带对方头像</div>
                  <div className="row-desc wrap">
                    开启后，新建话题及 /info 资料卡将附带访客 TG 头像大图（点击卡片昵称亦可直达资料页）
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch ${draft.pmBot.showVisitorAvatarInCard ? 'on' : ''}`}
                  onClick={() => updateField('pmBot', 'showVisitorAvatarInCard', !draft.pmBot.showVisitorAvatarInCard)}
                >
                  <span className="switch-knob" />
                </button>
              </div>
            </div>

            <div className="card">
              <div className="field-label" style={{ marginBottom: 6 }}>💬 自动回复与关键词回复</div>

              <div className="list-row">
                <div className="row-main">
                  <div className="row-title" style={{ fontSize: 13 }}>收到消息自动回复（忙碌 / 离线提示）</div>
                  <div className="row-desc wrap">
                    访客通过验证发消息时自动回复一条回执，按冷却间隔防刷屏（命中关键词规则时不会重复触发）
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch ${draft.pmBot.autoReplyEnabled ? 'on' : ''}`}
                  onClick={() => updateField('pmBot', 'autoReplyEnabled', !draft.pmBot.autoReplyEnabled)}
                >
                  <span className="switch-knob" />
                </button>
              </div>

              {draft.pmBot.autoReplyEnabled && (
                <div
                  style={{
                    background: 'var(--bg-subtle)',
                    borderRadius: 14,
                    padding: 10,
                    marginTop: 8,
                    marginBottom: 10,
                  }}
                >
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label className="field-label">自动回复内容</label>
                    <textarea
                      className="textarea"
                      value={draft.pmBot.autoReplyText ?? ''}
                      onChange={(e) => updateField('pmBot', 'autoReplyText', e.target.value)}
                      placeholder="例如：已收到您的消息 🌸 看到后会第一时间回复，请稍等片刻～"
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">同一访客冷却间隔（分钟，1–1440，避免连发消息反复回执）</label>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      max="1440"
                      value={draft.pmBot.autoReplyCooldownMinutes ?? 30}
                      onChange={(e) =>
                        updateField(
                          'pmBot',
                          'autoReplyCooldownMinutes',
                          e.target.value === '' ? '' : Number(e.target.value)
                        )
                      }
                    />
                  </div>
                </div>
              )}

              <div
                style={{
                  background: 'var(--bg-subtle)',
                  borderRadius: 16,
                  padding: 12,
                  marginTop: 10,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 700 }}>
                    🎯 关键词自动回复（{(draft.pmBot.keywordReplies || []).length} / 50 条）
                  </span>
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    onClick={() => {
                      if (showKeywordAdder) {
                        resetKeywordForm();
                        setShowKeywordAdder(false);
                      } else {
                        resetKeywordForm();
                        setShowKeywordAdder(true);
                      }
                    }}
                  >
                    <Plus size={13} /> {showKeywordAdder ? '收起' : '添加规则'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
                  仅对通过验证的访客生效（不区分大小写，多个关键词用逗号或换行分隔，按顺序命中第一条）。
                </div>

                {showKeywordAdder && (
                  <div
                    style={{
                      background: 'var(--bg-elevated)',
                      borderRadius: 14,
                      padding: 10,
                      marginBottom: 10,
                      border: '1px solid var(--accent-line)',
                    }}
                  >
                    <div className="field" style={{ marginBottom: 8 }}>
                      <label className="field-label">触发关键词（逗号 / 换行 / | 分隔）</label>
                      <input
                        className="input"
                        value={kwInput}
                        onChange={(e) => setKwInput(e.target.value)}
                        placeholder="例如：友链, 交换友链, 博客链接"
                      />
                    </div>

                    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                      {[
                        { id: 'contains', label: '包含匹配（推荐）' },
                        { id: 'exact', label: '精确匹配' },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`pill ${kwMatchMode === opt.id ? 'rose' : ''}`}
                          style={{ cursor: 'pointer' }}
                          onClick={() => setKwMatchMode(opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    <div className="field" style={{ marginBottom: 8 }}>
                      <label className="field-label">自动回复内容</label>
                      <textarea
                        className="textarea"
                        value={kwReply}
                        onChange={(e) => setKwReply(e.target.value)}
                        placeholder="例如：欢迎互换友链！请直接发我你的站名、链接和头像～"
                      />
                    </div>

                    <div className="list-row" style={{ marginBottom: 8 }}>
                      <div className="row-main">
                        <div className="row-title" style={{ fontSize: 12 }}>命中后同时转发给站长</div>
                        <div className="row-desc wrap">关闭则仅向访客自动回复，不打扰通知群</div>
                      </div>
                      <button
                        type="button"
                        className={`switch ${kwForward ? 'on' : ''}`}
                        onClick={() => setKwForward((v) => !v)}
                      >
                        <span className="switch-knob" />
                      </button>
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ flex: 1 }}
                        onClick={handleSaveKeywordRule}
                      >
                        {editingKeywordId ? '保存修改' : '加入规则列表'}
                      </button>
                      {editingKeywordId && (
                        <button
                          type="button"
                          className="btn btn-soft"
                          onClick={() => {
                            resetKeywordForm();
                            setShowKeywordAdder(false);
                          }}
                        >
                          取消
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {(draft.pmBot.keywordReplies || []).length === 0 && !showKeywordAdder && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '6px 0' }}>
                    暂无关键词规则，点右上角「添加规则」即可配置常见问题秒回 ✨
                  </div>
                )}

                {(draft.pmBot.keywordReplies || []).map((rule, idx) => (
                  <div
                    key={rule.id || idx}
                    style={{
                      background: 'var(--bg-elevated)',
                      borderRadius: 13,
                      padding: 10,
                      marginBottom: 6,
                      opacity: rule.enabled === false ? 0.55 : 1,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
                        <span className="pill rose" style={{ fontSize: 10, padding: '2px 7px' }}>
                          {rule.matchMode === 'exact' ? '精确' : '包含'}
                        </span>
                        <span className="pill" style={{ fontSize: 10, padding: '2px 7px' }}>
                          {rule.forwardToAdmin !== false ? '转发站长' : '静默直回'}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 700, wordBreak: 'break-all' }}>
                          {rule.keywords}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <button
                          type="button"
                          className="pill"
                          style={{ cursor: 'pointer', fontSize: 10, padding: '2px 7px' }}
                          onClick={() => handleEditKeywordRule(rule)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className={`switch ${rule.enabled !== false ? 'on' : ''}`}
                          style={{ transform: 'scale(0.82)' }}
                          title={rule.enabled !== false ? '已启用' : '已暂停'}
                          onClick={() =>
                            updateField(
                              'pmBot',
                              'keywordReplies',
                              (draft.pmBot.keywordReplies || []).map((r, i) =>
                                i === idx ? { ...r, enabled: r.enabled === false } : r
                              )
                            )
                          }
                        >
                          <span className="switch-knob" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="删除规则"
                          onClick={() => {
                            if (editingKeywordId === rule.id) {
                              resetKeywordForm();
                              setShowKeywordAdder(false);
                            }
                            updateField(
                              'pmBot',
                              'keywordReplies',
                              (draft.pmBot.keywordReplies || []).filter((_, i) => i !== idx)
                            );
                          }}
                        >
                          <Trash2 size={14} color="var(--red)" />
                        </button>
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                        marginTop: 6,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        lineHeight: 1.45,
                      }}
                    >
                      {rule.reply}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="list-row">
                <div className="row-main">
                  <div className="row-title" style={{ fontSize: 13 }}>🎁 群签到与积分徽章模式（社区群可选）</div>
                  <div className="row-desc wrap">
                    个人名片默认关闭；开启后支持群员每日 /checkin 签到、连签奖励、等级与徽章墙
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch ${draft.community.enableCheckin ? 'on' : ''}`}
                  onClick={() => updateField('community', 'enableCheckin', !draft.community.enableCheckin)}
                >
                  <span className="switch-knob" />
                </button>
              </div>

              {draft.community.enableCheckin && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                  <div className="field">
                    <label className="field-label">每日最低积分</label>
                    <input
                      className="input"
                      type="number"
                      value={draft.community.dailyMinPoints}
                      onChange={(e) => updateField('community', 'dailyMinPoints', Number(e.target.value))}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label">每日最高积分</label>
                    <input
                      className="input"
                      type="number"
                      value={draft.community.dailyMaxPoints}
                      onChange={(e) => updateField('community', 'dailyMaxPoints', Number(e.target.value))}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label">连签每日递增奖励</label>
                    <input
                      className="input"
                      type="number"
                      value={draft.community.streakStepBonus}
                      onChange={(e) => updateField('community', 'streakStepBonus', Number(e.target.value))}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label">积分单位名称</label>
                    <input
                      className="input"
                      value={draft.community.currencyName}
                      onChange={(e) => updateField('community', 'currencyName', e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Section 6: Version Checker (Scheme A) & Optional 1-Click Fork Sync (Scheme B) */}
        {section === 'update' && (() => {
          const updater = draft.updater || { forkRepo: '', branch: 'main', githubToken: '' };
          const cleanedFork = String(updater.forkRepo || '')
            .trim()
            .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
            .replace(/\.git$/i, '')
            .replace(/\/+$/, '');
          const manualSyncUrl = cleanedFork
            ? `https://github.com/${cleanedFork}`
            : updateInfo?.releaseUrl || 'https://github.com/mango0114/rose-panel-bot/releases';
          const hasToken = Boolean(updater.githubToken?.trim() || updater.tokenFromEnv);
          const currentVerLabel = updateInfo?.currentVersion || appVersion ? `v${updateInfo?.currentVersion || appVersion}` : '—';

          return (
            <>
              <div className="card update-hero-card">
                <div className="update-hero-head">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span className="row-title" style={{ fontSize: 15 }}>
                        RosePanel {currentVerLabel}
                      </span>
                      <span
                        className={`pill ${updateInfo?.hasUpdate ? 'rose' : ''}`}
                        style={{ fontSize: 11, padding: '2px 8px' }}
                      >
                        {checkingUpdate
                          ? '检查中…'
                          : updateInfo?.hasUpdate
                            ? `🎉 有新版 v${updateInfo.latestVersion}`
                            : updateInfo?.ok
                              ? '✅ 已是最新'
                              : '未检查'}
                      </span>
                    </div>
                    <div className="row-desc wrap" style={{ marginTop: 4 }}>
                      {updateInfo?.hasUpdate
                        ? `新版 v${updateInfo.latestVersion} 已发布，升级保留全部数据`
                        : updateInfo?.ok
                          ? '当前已是 GitHub 官方最新版'
                          : '点击检查 GitHub 官方最新版'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`btn btn-sm ${updateInfo?.hasUpdate ? 'btn-soft' : 'btn-primary'}`}
                    style={{ flexShrink: 0 }}
                    disabled={checkingUpdate}
                    onClick={() => handleCheckUpdate(true)}
                  >
                    <RefreshCw size={13} className={checkingUpdate ? 'spin' : ''} /> 检查新版本
                  </button>
                </div>

                {updateInfo?.error && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '8px 11px',
                      borderRadius: 12,
                      fontSize: 12,
                      background: 'var(--red-soft)',
                      color: 'var(--red)',
                    }}
                  >
                    ⚠️ {updateInfo.error}
                  </div>
                )}

                {updateInfo?.hasUpdate && updateInfo?.notes && (
                  <div className="update-notes-box">{updateInfo.notes}</div>
                )}

                <div className="update-link-bar">
                  <button
                    type="button"
                    className="update-link-item"
                    onClick={() => openExternalUrl(REPO_URL)}
                  >
                    <Globe size={13} /> 项目主页
                  </button>
                  <span className="update-link-sep" aria-hidden="true" />
                  <button
                    type="button"
                    className="update-link-item"
                    onClick={() => (onOpenWhatsNew ? onOpenWhatsNew() : openExternalUrl(CHANGELOG_URL))}
                  >
                    <Sparkles size={13} /> 更新日志
                  </button>
                </div>
              </div>

              <div className="card" style={{ marginBottom: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span className="row-title" style={{ fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Database size={14} /> 数据存储
                      </span>
                      <span
                        className={`pill ${storageStatus.d1Bound ? 'rose' : ''}`}
                        style={{ fontSize: 11, padding: '2px 8px' }}
                      >
                        {storageStatus.d1Bound
                          ? storageStatus.loaded
                            ? `D1 · 已迁移 ${storageStatus.done} / ${storageStatus.total} 个访客`
                            : 'D1 · 读取进度中…'
                          : 'KV（未绑定 D1）'}
                      </span>
                    </div>
                    <div className="row-desc wrap" style={{ marginTop: 5, lineHeight: 1.5 }}>
                      {storageStatus.d1Bound ? (
                        storageStatus.loaded && storageStatus.finished ? (
                          '聊天记录与消息映射已由 Cloudflare D1 承载，KV 旧数据原样保留作为备份。'
                        ) : (
                          '老访客打开聊天记录时会自动按需迁移；也可点击右侧「一键迁移」分批搬完（KV 旧数据保留不删）。'
                        )
                      ) : (
                        <>
                          当前使用 Workers KV 存储，行为与旧版完全一致；绑定 D1 数据库（变量名 <code>DB</code>，库名{' '}
                          <code>rose-panel-bot</code>）后可节省每日 KV 写入配额并保留完整聊天历史。
                        </>
                      )}
                    </div>
                  </div>

                  {storageStatus.d1Bound ? (
                    <button
                      type="button"
                      className={`btn btn-sm ${storageStatus.loaded && storageStatus.finished ? 'btn-subtle' : 'btn-primary'}`}
                      style={{ flexShrink: 0 }}
                      disabled={migratingStorage || loadingStorage || (storageStatus.loaded && storageStatus.finished)}
                      onClick={handleMigrateAllVisitors}
                    >
                      <RefreshCw size={13} className={migratingStorage || loadingStorage ? 'spin' : ''} />{' '}
                      {migratingStorage
                        ? `迁移中 (${storageStatus.done}/${storageStatus.total})…`
                        : storageStatus.loaded && storageStatus.finished
                          ? '已全部迁移'
                          : '一键迁移'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-subtle btn-sm"
                      style={{ flexShrink: 0 }}
                      onClick={() => openExternalUrl(`${REPO_URL}/blob/main/docs/SETUP_GUIDE.md#d1-storage`)}
                    >
                      <ExternalLink size={13} /> 手动绑定步骤
                    </button>
                  )}
                </div>

                {migrationFeedback && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '8px 11px',
                      borderRadius: 12,
                      fontSize: 12,
                      lineHeight: 1.5,
                      background: migrationFeedback.ok ? 'var(--green-soft)' : 'var(--red-soft)',
                      color: migrationFeedback.ok ? 'var(--green)' : 'var(--red)',
                    }}
                  >
                    {migrationFeedback.ok ? '' : '⚠️ '}
                    {migrationFeedback.text}
                  </div>
                )}

                {storageStatus.d1Bound && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                    <label className="field-label" style={{ marginBottom: 6 }}>
                      聊天记录保留时长（D1 自动清理）
                    </label>
                    <div className="chip-row" style={{ marginBottom: 6 }}>
                      {[
                        { days: 0, label: '永久保留' },
                        { days: 365, label: '保留 1 年' },
                        { days: 180, label: '保留 6 个月' },
                      ].map((opt) => {
                        const active = Number(draft.pmBot?.chatRetentionDays || 0) === opt.days;
                        return (
                          <button
                            key={opt.days}
                            type="button"
                            className={`chip ${active ? 'active' : ''}`}
                            onClick={() => {
                              haptic('light');
                              updateField('pmBot', 'chatRetentionDays', opt.days);
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="row-desc wrap" style={{ lineHeight: 1.5 }}>
                      {Number(draft.pmBot?.chatRetentionDays || 0) > 0
                        ? `每日定时任务将分批清理超过 ${
                            Number(draft.pmBot?.chatRetentionDays) === 365 ? '1 年' : '6 个月'
                          } 的 D1 聊天消息与对应链接（0 KV 写入，KV 旧备份不删）。若同账号多实例共用 rose-panel-bot 库，请先为各实例配置独立的 database_name。`
                        : '默认永久保留全部 D1 聊天记录（KV 旧备份始终不删除）；修改后记得点击下方「保存全部设置」。'}
                    </div>
                  </div>
                )}
              </div>

              <div className="card update-fork-card">
                <button
                  type="button"
                  className="update-collapse-head"
                  aria-expanded={forkCardOpen}
                  onClick={() => setForkCardOpen((prev) => !prev)}
                >
                  <span className="update-collapse-title">
                    <GitFork size={14} />
                    <span>Fork 同步更新</span>
                    <span className="update-collapse-badge">
                      {cleanedFork ? cleanedFork : '仅 Fork 部署'}
                    </span>
                  </span>
                  {forkCardOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>

                {forkCardOpen && (
                  <div className="update-fork-body">
                    <div className="row-desc wrap" style={{ marginBottom: 10, lineHeight: 1.5 }}>
                      升级仅同步代码，KV 数据 <b>100% 原样保留</b>；绑定 D1 后聊天数据自动迁移到 D1。
                    </div>

                    <div className="field">
                      <label className="field-label">我 Fork 的 GitHub 仓库（owner/repo）</label>
                      <input
                        className="input"
                        value={updater.forkRepo || ''}
                        onChange={(e) => updateField('updater', 'forkRepo', e.target.value)}
                        placeholder="例如：yourname/rose-panel-bot"
                      />
                    </div>

                    <div className="field">
                      <label className="field-label">GitHub Token（选填 · 仅存自己 KV，留空则手动跳转同步）</label>
                      <input
                        className="input"
                        type="password"
                        value={updater.githubToken || ''}
                        onChange={(e) => updateField('updater', 'githubToken', e.target.value)}
                        placeholder={
                          updater.tokenFromEnv
                            ? '已通过环境变量 GITHUB_UPDATE_TOKEN 配置'
                            : 'github_pat_...（不填即可零密钥更新）'
                        }
                      />
                    </div>

                    <div className="update-fork-actions">
                      {hasToken ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            style={{ flex: 1 }}
                            disabled={syncingFork || !cleanedFork}
                            onClick={handleSyncFork}
                          >
                            <Rocket size={14} /> {syncingFork ? '正在同步…' : '一键同步 Fork 并触发云端更新'}
                          </button>
                          {cleanedFork && (
                            <button
                              type="button"
                              className="btn btn-subtle btn-sm"
                              title="前往我的 Fork 点 Sync fork"
                              onClick={() => openExternalUrl(manualSyncUrl)}
                            >
                              <ExternalLink size={13} /> Fork
                            </button>
                          )}
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-block btn-sm"
                          disabled={!cleanedFork}
                          onClick={() => openExternalUrl(manualSyncUrl)}
                        >
                          <ExternalLink size={14} />{' '}
                          {cleanedFork ? '前往我的 Fork 点 Sync fork' : '请先填写上方的 Fork 仓库名'}
                        </button>
                      )}
                    </div>

                    {syncResult && (
                      <div
                        style={{
                          marginTop: 10,
                          padding: '9px 12px',
                          borderRadius: 12,
                          fontSize: 12,
                          lineHeight: 1.5,
                          background: syncResult.ok ? 'var(--green-soft)' : 'var(--red-soft)',
                          color: syncResult.ok ? 'var(--green)' : 'var(--red)',
                        }}
                      >
                        {syncResult.ok ? '' : '❌ '}
                        {syncResult.text}
                      </div>
                    )}

                    <button
                      type="button"
                      className="update-adv-toggle"
                      aria-expanded={forkAdvancedOpen}
                      onClick={() => setForkAdvancedOpen((prev) => !prev)}
                    >
                      {forkAdvancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <span>高级选项与权限说明</span>
                    </button>

                    {forkAdvancedOpen && (
                      <div className="update-adv-panel">
                        <div className="field" style={{ marginBottom: 8 }}>
                          <label className="field-label">同步分支名（默认 main）</label>
                          <input
                            className="input"
                            value={updater.branch || 'main'}
                            onChange={(e) => updateField('updater', 'branch', e.target.value)}
                            placeholder="main"
                          />
                        </div>
                        <div className="row-desc wrap" style={{ lineHeight: 1.5 }}>
                          • <b>零密钥手动更新</b>：打开 Fork 仓库 → 点 <b>Sync fork → Update branch</b>，Cloudflare 约 30 秒重建。<br />
                          • <b>站内一键同步权限</b>：Fine-grained Token 仅授权当前 Fork 仓库，开启 <code>Contents: Read and write</code>（含 workflow 时再开 <code>Workflows: Read and write</code>）。<br />
                          • <b>非 Fork 独立副本</b>：无 Sync fork 按钮，请按教程 FAQ Q3 合并上游或重新 Fork。
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          );
        })()}

        {(section !== 'update' || isDirty) && (
          <button className="btn btn-primary btn-block" disabled={saving} onClick={handleSave}>
            <Check size={16} /> {saving ? '保存中…' : '保存全部设置'}
          </button>
        )}

        {(section === 'update' || !hideStarStrip) && (
          <StarSupportBanner
            onDismiss={
              section === 'update'
                ? null
                : () => {
                    try {
                      localStorage.setItem(HIDE_STAR_STRIP_STORAGE_KEY, '1');
                    } catch {
                      // Ignore storage errors
                    }
                    setHideStarStrip(true);
                  }
            }
          />
        )}

        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-subtle btn-sm btn-block"
            onClick={() => {
              haptic('light');
              openExternalUrl(FEEDBACK_URL);
            }}
          >
            💬 意见反馈
          </button>
        </div>
      </div>
    </div>
  );
}
