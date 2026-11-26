import React, { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Globe,
  IdCard,
  RefreshCw,
  Server,
  Settings,
  Ticket,
  Trophy,
  Users,
} from 'lucide-react';
import DayNightSlider, { THEME_MODES } from './components/DayNightSlider.jsx';
import { TicketEmblem } from './components/Emblems.jsx';
import LeaderboardTab from './components/LeaderboardTab.jsx';
import ProbeTab from './components/ProbeTab.jsx';
import SettingsDrawer from './components/SettingsDrawer.jsx';
import SitesTab from './components/SitesTab.jsx';
import TicketTab from './components/TicketTab.jsx';
import VisitorsTab from './components/VisitorsTab.jsx';
import WhatsNewModal, { SEEN_VERSION_STORAGE_KEY } from './components/WhatsNewModal.jsx';
import { apiRequest, getDevRole, setDevRole } from './lib/api.js';
import {
  getLaunchTarget,
  getTelegramColorScheme,
  getTelegramUserId,
  haptic,
  initTelegramWebApp,
  onColorSchemeChange,
  syncTelegramChrome,
} from './lib/telegram.js';

const BOOT_CACHE_PREFIX = 'rose_panel_boot_v1:';
const THEME_MODE_STORAGE_KEY = 'rose_panel_theme_mode';

function readThemeMode() {
  try {
    const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (THEME_MODES.includes(saved)) return saved;
  } catch {
    // Storage may be unavailable in some WebViews
  }
  return 'auto';
}
const BOOT_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function readSplashMeta() {
  if (typeof window !== 'undefined' && window.__ROSE_SPLASH__) {
    return window.__ROSE_SPLASH__;
  }
  return {
    displayName: 'RosePanel',
    style: 'emblem',
    text: '正在打开个人面板…',
    emoji: '🌹',
    emblem: { type: 'builtin', variant: 'owner' },
  };
}

function getBootCacheKey() {
  const uid = getTelegramUserId();
  return `${BOOT_CACHE_PREFIX}${uid || `dev_${getDevRole()}`}`;
}

function loadCachedBootstrap() {
  try {
    const raw = localStorage.getItem(getBootCacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data?.ok || Date.now() - Number(parsed.savedAt || 0) > BOOT_CACHE_MAX_AGE_MS) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function saveCachedBootstrap(data) {
  try {
    if (!data?.ok) return;
    localStorage.setItem(getBootCacheKey(), JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // Ignore storage quota / private mode errors
  }
}

function SplashScreen({ splash }) {
  const style = splash?.style || 'emblem';
  const text = splash?.text || '正在打开个人面板…';
  const displayName = splash?.displayName || 'RosePanel';

  if (style === 'skeleton') {
    return (
      <div className="app-shell">
        <div className="top-bar" style={{ marginBottom: 14 }}>
          <div className="skeleton-pill" style={{ width: 120, height: 22 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="skeleton-circle" style={{ width: 34, height: 34 }} />
          </div>
        </div>
        <div className="card skeleton-card" style={{ height: 196, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="skeleton-circle" style={{ width: 46, height: 46 }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton-line" style={{ width: '52%', height: 16 }} />
              <div className="skeleton-line" style={{ width: '34%', height: 11, marginTop: 8 }} />
            </div>
          </div>
          <div className="skeleton-pill" style={{ width: 92, height: 22, marginTop: 16 }} />
          <div className="skeleton-line" style={{ width: '88%', height: 12, marginTop: 14 }} />
          <div className="skeleton-line" style={{ width: '64%', height: 12, marginTop: 8 }} />
        </div>
        <div className="card skeleton-card" style={{ padding: 16 }}>
          <div className="skeleton-line" style={{ width: '32%', height: 13, marginBottom: 14 }} />
          <div className="skeleton-line" style={{ width: '78%', height: 14, marginBottom: 12 }} />
          <div className="skeleton-line" style={{ width: '68%', height: 14 }} />
        </div>
        <div className="splash-caption" style={{ textAlign: 'center', marginTop: 8 }}>
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell splash-shell">
      <div className="splash-stage">
        <div className="splash-halo">
          <div className="splash-core">
            {style === 'emoji' ? (
              <span className="splash-emoji" aria-hidden="true">
                {splash?.emoji || '🌹'}
              </span>
            ) : (
              <TicketEmblem emblem={splash?.emblem} size={62} />
            )}
          </div>
        </div>

        <div className="splash-brand">{displayName}</div>
        <div className="splash-caption">{text}</div>

        <div className="splash-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [themeMode, setThemeMode] = useState(readThemeMode);
  const [systemTheme, setSystemTheme] = useState(() => getTelegramColorScheme());
  const theme = themeMode === 'auto' ? systemTheme : themeMode;
  const [bootstrap, setBootstrap] = useState(() => loadCachedBootstrap());
  const [loading, setLoading] = useState(() => !loadCachedBootstrap());
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('profile');
  const [deepVisitorId, setDeepVisitorId] = useState('');
  const [settingsSection, setSettingsSection] = useState(null);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [previewRole, setPreviewRole] = useState(() => getDevRole());
  const [whatsNewState, setWhatsNewState] = useState({
    open: false,
    mode: 'auto',
    previousVersion: '',
  });
  const splashMeta = readSplashMeta();

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => {
      setToast((curr) => (curr === msg ? '' : curr));
    }, 2600);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    syncTelegramChrome(theme);
  }, [theme]);

  useEffect(() => onColorSchemeChange(setSystemTheme), []);

  // Switch theme mode; when the visible theme flips, reveal it as a circle growing out of the slider bubble.
  const changeThemeMode = useCallback(
    (nextMode, origin) => {
      try {
        localStorage.setItem(THEME_MODE_STORAGE_KEY, nextMode);
      } catch {
        // Ignore storage failures
      }
      const nextTheme = nextMode === 'auto' ? systemTheme : nextMode;
      const canAnimate =
        nextTheme !== theme &&
        origin &&
        typeof document !== 'undefined' &&
        typeof document.startViewTransition === 'function' &&
        !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!canAnimate) {
        setThemeMode(nextMode);
        return;
      }
      const transition = document.startViewTransition(() => {
        flushSync(() => setThemeMode(nextMode));
        document.documentElement.setAttribute('data-theme', nextTheme);
      });
      transition.ready
        .then(() => {
          const radius = Math.hypot(
            Math.max(origin.x, window.innerWidth - origin.x),
            Math.max(origin.y, window.innerHeight - origin.y),
          );
          document.documentElement.animate(
            { clipPath: [`circle(16px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
            { duration: 560, easing: 'cubic-bezier(0.22, 0.8, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
          );
        })
        .catch(() => {});
    },
    [systemTheme, theme],
  );

  const loadBootstrap = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      setError('');
      const res = await apiRequest('/api/bootstrap');
      setBootstrap(res);
      saveCachedBootstrap(res);

      // Handle Telegram start_param / query deep links (e.g. visitor_123456 or settings=modes)
      const target = getLaunchTarget();
      if (target.settings && res.isAdmin) {
        setSettingsSection(target.settings);
      }
      if (target.tab === 'visitors' && res.isAdmin) {
        setActiveTab('visitors');
        if (target.visitorId) setDeepVisitorId(target.visitorId);
      } else if (['profile', 'sites', 'probe'].includes(target.tab)) {
        setActiveTab(target.tab);
      }

      if (
        res.isAdmin &&
        res.appVersion &&
        !res.isPreview &&
        !(typeof navigator !== 'undefined' && navigator.webdriver) &&
        !target.settings &&
        !target.visitorId
      ) {
        try {
          const seenVer = localStorage.getItem(SEEN_VERSION_STORAGE_KEY) || '';
          if (seenVer !== String(res.appVersion)) {
            setWhatsNewState({ open: true, mode: 'auto', previousVersion: seenVer });
          }
        } catch {
          // Ignore storage errors
        }
      }
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    initTelegramWebApp();
    const hasWarmCache = Boolean(loadCachedBootstrap());
    loadBootstrap({ silent: hasWarmCache });
  }, [loadBootstrap]);

  const handleCheckin = async () => {
    try {
      setCheckinLoading(true);
      const res = await apiRequest('/api/checkin', { method: 'POST' });
      setBootstrap((prev) => (prev ? { ...prev, checkin: res.ticket } : prev));
      if (res.alreadyCheckedIn) {
        showToast('今日已经签过啦 🌸');
      } else {
        haptic('success');
        const badgeMsg =
          res.newlyUnlocked?.length > 0
            ? ` · 解锁徽章「${res.newlyUnlocked.map((b) => b.name).join('、')}」`
            : '';
        showToast(
          `🎉 签到成功 +${res.gained} ${bootstrap?.config?.community?.currencyName || '积分'}${badgeMsg}`
        );
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setCheckinLoading(false);
    }
  };

  const handleSwitchPreviewRole = () => {
    const next = previewRole === 'admin' ? 'guest' : 'admin';
    setDevRole(next);
    setPreviewRole(next);
    if (next === 'guest' && activeTab === 'visitors') {
      setActiveTab('profile');
    }
    loadBootstrap();
  };

  if (loading && !bootstrap) {
    return <SplashScreen splash={splashMeta} />;
  }

  if (error && !bootstrap) {
    return (
      <div className="app-shell">
        <div className="card empty-state">
          <div style={{ fontSize: 28, marginBottom: 8 }}>🥀</div>
          <div style={{ fontWeight: 700, color: 'var(--text)' }}>无法连接到面板服务</div>
          <div style={{ marginTop: 6 }}>{error}</div>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} onClick={loadBootstrap}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const isAdmin = Boolean(bootstrap?.isAdmin);
  const enableCheckin = Boolean(bootstrap?.config?.community?.enableCheckin);
  const showSitesTab = isAdmin || (bootstrap?.config?.sites || []).length > 0;
  const showProbeTab = isAdmin || Boolean(bootstrap?.config?.probe?.configured);

  const navItems = [
    {
      id: 'profile',
      label: enableCheckin ? '票根' : '名片',
      icon: enableCheckin ? Ticket : IdCard,
    },
  ];

  if (showSitesTab) {
    navItems.push({ id: 'sites', label: '小站', icon: Globe });
  }

  if (showProbeTab) {
    navItems.push({ id: 'probe', label: '探针', icon: Server });
  }

  if (isAdmin) {
    navItems.push({
      id: 'visitors',
      label: '访客',
      icon: Users,
      badge: bootstrap?.visitorSummary?.active || 0,
    });
  } else if (enableCheckin) {
    navItems.push({ id: 'leaderboard', label: '榜单', icon: Trophy });
  }

  const effectiveTab = navItems.some((item) => item.id === activeTab) ? activeTab : 'profile';

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      {bootstrap?.isPreview && (
        <div className="preview-banner">
          <span>🧪 本地预览模式（当前视角：{isAdmin ? '站长' : '访客'}）</span>
          <button
            className="btn btn-sm"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text)', padding: '4px 10px' }}
            onClick={handleSwitchPreviewRole}
          >
            切换视角
          </button>
        </div>
      )}

      {/* Top Bar */}
      <header className="top-bar">
        <div className="top-brand">
          <span className="top-brand-dot" />
          <span className="top-title">{bootstrap?.config?.profile?.displayName || 'RosePanel'}</span>
        </div>

        <div className="top-actions">
          <DayNightSlider mode={themeMode} onChange={changeThemeMode} />
          {isAdmin && (
            <button
              className="icon-btn accent"
              title="面板可视化设置"
              onClick={() => {
                haptic('light');
                setSettingsSection('profile');
              }}
            >
              <Settings size={16} />
            </button>
          )}
        </div>
      </header>

      {/* Main View */}
      <main>
        {effectiveTab === 'profile' && (
          <TicketTab
            data={bootstrap}
            onNavigate={(tab) => {
              haptic('light');
              setActiveTab(tab);
            }}
            onOpenVisitor={(visitorId) => {
              haptic('light');
              setDeepVisitorId(String(visitorId || ''));
              setActiveTab('visitors');
            }}
            onCheckin={handleCheckin}
            checkinLoading={checkinLoading}
            onOpenWhatsNew={() =>
              setWhatsNewState({ open: true, mode: 'manual', previousVersion: '' })
            }
            onToast={showToast}
          />
        )}

        {effectiveTab === 'sites' && (
          <SitesTab
            sites={bootstrap?.config?.sites || []}
            isAdmin={isAdmin}
            onOpenSettings={(sec) => setSettingsSection(sec)}
            onSitesUpdated={(updatedRes) =>
              setBootstrap((prev) =>
                prev
                  ? {
                      ...prev,
                      config: updatedRes.config,
                      adminConfig: updatedRes.adminConfig,
                    }
                  : prev
              )
            }
            onToast={showToast}
          />
        )}

        {effectiveTab === 'probe' && (
          <ProbeTab
            probeConfig={bootstrap?.config?.probe}
            isAdmin={isAdmin}
            onOpenSettings={(sec) => setSettingsSection(sec)}
            onToast={showToast}
          />
        )}

        {effectiveTab === 'visitors' && isAdmin && (
          <VisitorsTab
            initialVisitorId={deepVisitorId}
            onClearInitial={() => setDeepVisitorId('')}
            onToast={showToast}
          />
        )}

        {effectiveTab === 'leaderboard' && enableCheckin && (
          <LeaderboardTab
            currencyName={bootstrap?.config?.community?.currencyName || '积分'}
            onToast={showToast}
          />
        )}
      </main>

      {/* Floating Glass Pill Bottom Dock — auto-hides when only 1 tab is visible */}
      {navItems.length > 1 && (
        <nav className="bottom-dock-wrap" aria-label="主导航">
          <div className="bottom-dock">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = effectiveTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`dock-item ${active ? 'active' : ''}`}
                  onClick={() => {
                    haptic('light');
                    setActiveTab(item.id);
                  }}
                >
                  <Icon size={20} strokeWidth={active ? 2.2 : 1.9} />
                  <span>{item.label}</span>
                  {item.badge > 0 && <span className="dock-badge">{item.badge > 99 ? '99+' : item.badge}</span>}
                </button>
              );
            })}
          </div>
        </nav>
      )}

      {/* Admin Visual Settings Drawer */}
      {isAdmin && settingsSection && bootstrap?.adminConfig && (
        <SettingsDrawer
          initialSection={settingsSection}
          adminConfig={bootstrap.adminConfig}
          botInfo={bootstrap.config?.bot}
          shareUrl={bootstrap.config?.shareUrl}
          appVersion={bootstrap.appVersion}
          onOpenWhatsNew={() =>
            setWhatsNewState({ open: true, mode: 'manual', previousVersion: '' })
          }
          onClose={() => setSettingsSection(null)}
          onSaved={(savedRes) => {
            setBootstrap((prev) =>
              prev
                ? {
                    ...prev,
                    config: savedRes.config,
                    adminConfig: savedRes.adminConfig,
                  }
                : prev
            );
            loadBootstrap();
          }}
          onToast={showToast}
        />
      )}

      {isAdmin && whatsNewState.open && (
        <WhatsNewModal
          appVersion={bootstrap?.appVersion}
          previousVersion={whatsNewState.previousVersion}
          mode={whatsNewState.mode}
          onClose={() => {
            try {
              if (bootstrap?.appVersion) {
                localStorage.setItem(SEEN_VERSION_STORAGE_KEY, String(bootstrap.appVersion));
              }
            } catch {
              // Ignore storage errors
            }
            setWhatsNewState((prev) => ({ ...prev, open: false }));
          }}
        />
      )}
    </div>
  );
}
