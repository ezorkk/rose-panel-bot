import React, { Suspense, lazy, useState } from 'react';
import {
  Award,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Flame,
  HeartHandshake,
  Link2,
  MessageCircle,
  RefreshCw,
  Share2,
  Sparkles,
  X,
} from 'lucide-react';
import { Avatar, StubEmblem, TicketEmblem } from './Emblems.jsx';
import { apiRequest } from '../lib/api.js';
import { BRAND_SIGNATURE } from '../lib/brand.js';
import {
  STATUS_SCENE_PRESETS,
  STATUS_STICKERS,
  STATUS_TONE_OPTIONS,
  getStatusStickerUrl,
  normalizeStatusSticker,
  normalizeStatusTone,
} from '../lib/statusPresets.js';
import {
  buildSourceLink,
  closeMiniApp,
  copyText,
  getLaunchSource,
  getTelegramInitData,
  getTelegramWebApp,
  haptic,
  isOpenedFromGroup,
  openExternalUrl,
} from '../lib/telegram.js';

const GetSameCardModal = lazy(() => import('./GetSameCardModal.jsx'));

export default function TicketTab({
  data,
  onNavigate,
  onStatusUpdated,
  onCheckin,
  checkinLoading,
  onToast,
}) {
  const [showLevels, setShowLevels] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const {
    config,
    adminConfig = null,
    isAdmin,
    checkin,
    levels = [],
    visitorSummary = null,
    blockedToday = 0,
    pendingReviewCount: bootPendingReview,
    awaitingReplyCount: bootAwaitingReply,
  } = data;
  const pendingReviewCount = Number(bootPendingReview ?? visitorSummary?.pendingReview ?? 0);
  const awaitingReplyCount = Number(bootAwaitingReply ?? visitorSummary?.awaitingReply ?? 0);
  const { profile, community, bot } = config;
  const enableCheckin = Boolean(community.enableCheckin);
  // The top bar already shows displayName, so the card leads with the @handle instead of repeating it.
  // Falls back to displayName when the handle is empty or still the template placeholder.
  const rawHandle = String(profile.handle || '').trim();
  const cardTitle =
    (rawHandle && rawHandle !== '@your_bot' ? rawHandle : '') || String(profile.displayName || '').trim();
  const avatarMode = profile.avatarMode || (profile.avatarUrl ? 'custom' : 'bot');
  const ownerAvatarSrc =
    avatarMode === 'custom' && profile.avatarUrl
      ? profile.avatarUrl
      : `/api/avatar/owner?m=${encodeURIComponent(avatarMode)}`;

  const parsedTags = String(profile.tags || '')
    .split(/[,，、;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);

  const etiquetteLines = String(profile.noteLines || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);

  const statusToneClass =
    profile.statusTone === 'busy'
      ? 'amber'
      : profile.statusTone === 'away'
        ? 'red'
        : 'green';

  const handleCopy = async (value, label) => {
    const ok = await copyText(value);
    onToast(ok ? `已复制 ${label}` : '复制失败');
  };

  const [openingPm, setOpeningPm] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [posterLoading, setPosterLoading] = useState(false);
  const [posterError, setPosterError] = useState('');
  const [posterData, setPosterData] = useState(null);
  const [showPromoLinks, setShowPromoLinks] = useState(false);
  const [showGetSame, setShowGetSame] = useState(false);
  const [statusSheetOpen, setStatusSheetOpen] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusInitial, setStatusInitial] = useState(null);
  const [statusDraft, setStatusDraft] = useState({
    statusTone: 'online',
    statusText: '',
    statusSticker: '',
    autoReplyEnabled: false,
    autoReplyText: '',
  });

  const statusStickerUrl = getStatusStickerUrl(profile.statusSticker);

  const openStatusSheet = () => {
    if (!isAdmin) return;
    haptic('light');
    const initial = {
      statusTone: normalizeStatusTone(profile.statusTone),
      statusText: profile.statusText || '在线营业中',
      statusSticker: normalizeStatusSticker(profile.statusSticker),
      autoReplyEnabled: Boolean(adminConfig?.pmBot?.autoReplyEnabled),
      autoReplyText:
        adminConfig?.pmBot?.autoReplyText || '已收到您的消息 🌸 看到后会第一时间回复，请稍等片刻～',
    };
    setStatusInitial(initial);
    setStatusDraft(initial);
    setStatusSheetOpen(true);
  };

  const applyStatusPreset = (preset) => {
    haptic('light');
    setStatusDraft((prev) => ({
      ...prev,
      statusTone: preset.statusTone,
      statusText: preset.statusText,
      statusSticker: preset.statusSticker,
      autoReplyEnabled: preset.autoReplyEnabled,
      ...(preset.autoReplyEnabled && preset.autoReplyText
        ? { autoReplyText: preset.autoReplyText }
        : {}),
    }));
  };

  const handleSaveStatus = async () => {
    try {
      setStatusSaving(true);
      // Only send auto-reply fields when actually modified in this sheet so changing a sticker
      // or status label never clobbers the owner's saved auto-reply configuration.
      const body = {
        statusTone: statusDraft.statusTone,
        statusText: statusDraft.statusText,
        statusSticker: statusDraft.statusSticker,
      };
      if (!statusInitial || statusDraft.autoReplyEnabled !== statusInitial.autoReplyEnabled) {
        body.autoReplyEnabled = statusDraft.autoReplyEnabled;
      }
      if (
        statusDraft.autoReplyEnabled &&
        (!statusInitial || statusDraft.autoReplyText !== statusInitial.autoReplyText)
      ) {
        body.autoReplyText = statusDraft.autoReplyText;
      }
      const res = await apiRequest('/api/admin/status', {
        method: 'POST',
        body,
      });
      onStatusUpdated?.(res);
      setStatusSheetOpen(false);
      haptic('success');
      onToast(
        statusDraft.autoReplyEnabled
          ? `已切换状态「${statusDraft.statusText || '忙碌'}」并开启自动回复`
          : `已更新状态「${statusDraft.statusText || '在线'}」`
      );
    } catch (err) {
      onToast(err.message);
    } finally {
      setStatusSaving(false);
    }
  };

  const resolvedShareUrl =
    String(config.shareUrl || '').trim() ||
    (typeof window !== 'undefined' ? `${window.location.origin}/` : '');
  const shareLinkKind = /^https:\/\/t\.me\//i.test(resolvedShareUrl) ? 'app' : 'web';
  const posterShareUrl = buildSourceLink(resolvedShareUrl, 'poster', shareLinkKind);
  const copyShareUrl = buildSourceLink(resolvedShareUrl, 'link', shareLinkKind);
  const tgPlatform = getTelegramWebApp()?.platform || '';
  const inTelegramWebView = Boolean(getTelegramInitData() || (tgPlatform && tgPlatform !== 'unknown'));

  const openShareSheet = async () => {
    haptic('light');
    setShareOpen(true);
    setPosterLoading(true);
    setPosterError('');
    setPosterData(null);
    try {
      const { canSharePosterFile, generateSharePoster } = await import('../lib/sharePoster.js');
      const generated = await generateSharePoster({
        displayName: String(profile.displayName || '').trim() || cardTitle,
        handle: rawHandle && rawHandle !== '@your_bot' ? rawHandle : '',
        tagline: profile.tagline || '',
        tags: parsedTags.slice(0, 6),
        avatarSrc: ownerAvatarSrc,
        shareUrl: posterShareUrl,
      });
      setPosterData({
        ...generated,
        canNativeShare: canSharePosterFile(generated.blob),
      });
    } catch (err) {
      setPosterError(err?.message || '生成名片海报失败，请稍后重试');
    } finally {
      setPosterLoading(false);
    }
  };

  const handleNativeSharePoster = async () => {
    if (!posterData?.blob) return;
    try {
      haptic('medium');
      const file = new File([posterData.blob], 'rosepanel-card.png', { type: 'image/png' });
      await navigator.share({
        files: [file],
        title: String(profile.displayName || cardTitle || 'RosePanel'),
      });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        onToast('当前环境不支持系统分享，可长按图片保存或复制链接');
      }
    }
  };

  const handleDownloadPoster = () => {
    if (!posterData?.dataUrl) return;
    haptic('light');
    const a = document.createElement('a');
    a.href = posterData.dataUrl;
    a.download = `${(String(profile.displayName || 'rosepanel').trim() || 'rosepanel').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}-card.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    onToast('已开始保存名片海报');
  };

  const publicMonthlyVisits =
    config?.visitStats && typeof config.visitStats.thisMonth === 'number'
      ? config.visitStats.thisMonth
      : null;

  const showPoweredBy = !isAdmin && profile.showPoweredBy !== false;

  const renderAdminStatusStrip = () => {
    if (!isAdmin) return null;
    return (
      <div className="admin-todo-bar" aria-label="站长待办概览">
        <button
          type="button"
          className={`admin-todo-item ${awaitingReplyCount > 0 ? 'accent' : ''}`}
          onClick={() => onNavigate('visitors', { filter: awaitingReplyCount > 0 ? 'awaiting' : 'all' })}
        >
          <span className="admin-todo-num">{awaitingReplyCount}</span>
          <span className="admin-todo-label">待回复</span>
        </button>
        <button
          type="button"
          className={`admin-todo-item ${pendingReviewCount > 0 ? 'alert' : ''}`}
          onClick={() => onNavigate('visitors', { filter: pendingReviewCount > 0 ? 'pending' : 'all' })}
        >
          <span className="admin-todo-num">{pendingReviewCount}</span>
          <span className="admin-todo-label">待审核</span>
        </button>
        <button
          type="button"
          className="admin-todo-item"
          onClick={() => onNavigate('visitors')}
        >
          <span className="admin-todo-num">{blockedToday || 0}</span>
          <span className="admin-todo-label">今日拦截</span>
        </button>
      </div>
    );
  };

  const renderStatusSheet = () =>
    isAdmin &&
    statusSheetOpen && (
      <div className="sheet-backdrop" onClick={() => setStatusSheetOpen(false)}>
        <div className="sheet-panel" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-handle" />
          <div className="sheet-header">
            <div className="sheet-title">切换状态与场景预设</div>
            <button type="button" className="icon-btn" onClick={() => setStatusSheetOpen(false)}>
              <X size={16} />
            </button>
          </div>

          <div className="field-label" style={{ marginBottom: 6 }}>
            快捷场景（一键联动状态灯与自动回复）
          </div>
          <div className="status-scene-grid">
            {STATUS_SCENE_PRESETS.map((preset) => {
              const active =
                statusDraft.statusTone === preset.statusTone &&
                statusDraft.statusText.trim() === preset.statusText;
              const presetIcon = getStatusStickerUrl(preset.statusSticker);
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`status-scene-card ${active ? 'selected' : ''}`}
                  onClick={() => applyStatusPreset(preset)}
                >
                  <div className="status-scene-head">
                    {presetIcon ? (
                      <img src={presetIcon} alt="" className="status-sticker-icon" />
                    ) : (
                      <span
                        className={`dot ${
                          preset.statusTone === 'busy'
                            ? 'amber'
                            : preset.statusTone === 'away'
                              ? 'red'
                              : 'green'
                        }`}
                        style={{
                          color:
                            preset.statusTone === 'busy'
                              ? 'var(--amber)'
                              : preset.statusTone === 'away'
                                ? 'var(--red)'
                                : 'var(--green)',
                        }}
                      />
                    )}
                    <span className="status-scene-label">{preset.label}</span>
                  </div>
                  <div className="status-scene-hint">{preset.hint}</div>
                </button>
              );
            })}
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">自定义状态文案</label>
            <input
              className="input"
              maxLength={48}
              value={statusDraft.statusText}
              onChange={(e) => setStatusDraft((prev) => ({ ...prev, statusText: e.target.value }))}
              placeholder="例如：写代码中 / 度假中 / 听歌摸鱼"
            />
          </div>

          <div className="field">
            <label className="field-label">状态色阶</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {STATUS_TONE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`pill ${statusDraft.statusTone === opt.id ? opt.dotClass : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    haptic('light');
                    setStatusDraft((prev) => ({ ...prev, statusTone: opt.id }));
                  }}
                >
                  <span className="dot" />
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field-label">状态动态小表情（内置动图，非 TG 会员也能挂）</label>
            <div className="status-sticker-strip">
              <button
                type="button"
                className={`status-sticker-opt ${!statusDraft.statusSticker ? 'selected' : ''}`}
                onClick={() => {
                  haptic('light');
                  setStatusDraft((prev) => ({ ...prev, statusSticker: '' }));
                }}
              >
                <span className="dot" style={{ color: 'var(--accent)' }} />
                <span>圆点</span>
              </button>
              {STATUS_STICKERS.map((st) => (
                <button
                  key={st.id}
                  type="button"
                  className={`status-sticker-opt ${statusDraft.statusSticker === st.id ? 'selected' : ''}`}
                  title={st.label}
                  onClick={() => {
                    haptic('light');
                    setStatusDraft((prev) => ({ ...prev, statusSticker: st.id }));
                  }}
                >
                  <img src={getStatusStickerUrl(st.id)} alt={st.label} className="status-sticker-icon lg" />
                </button>
              ))}
            </div>
          </div>

          <div
            className="list-row"
            style={{ marginTop: 4, paddingTop: 10, borderTop: '1px solid var(--border)' }}
          >
            <div className="row-main">
              <div className="row-title" style={{ fontSize: 13 }}>同步开启私聊自动回复</div>
              <div className="row-desc wrap">访客发消息时自动回一条状态说明，切回「正常营业」时会自动关闭</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={statusDraft.autoReplyEnabled}
              className={`switch ${statusDraft.autoReplyEnabled ? 'on' : ''}`}
              onClick={() =>
                setStatusDraft((prev) => ({ ...prev, autoReplyEnabled: !prev.autoReplyEnabled }))
              }
            >
              <span className="switch-knob" />
            </button>
          </div>

          {statusDraft.autoReplyEnabled && (
            <div className="field" style={{ marginTop: 8, marginBottom: 4 }}>
              <label className="field-label">自动回复话术</label>
              <textarea
                className="textarea"
                rows={2}
                value={statusDraft.autoReplyText}
                onChange={(e) => setStatusDraft((prev) => ({ ...prev, autoReplyText: e.target.value }))}
                placeholder="例如：正在专心写代码，看到消息后会尽快回复你～"
              />
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary btn-block"
            style={{ marginTop: 12 }}
            disabled={statusSaving}
            onClick={handleSaveStatus}
          >
            <Check size={15} /> {statusSaving ? '保存中…' : '保存状态'}
          </button>
        </div>
      </div>
    );

  const renderVisitCounter = () =>
    publicMonthlyVisits !== null && (
      <div className="card-visit-counter">👀 本月访客 {publicMonthlyVisits} 人</div>
    );

  const renderPoweredBy = () =>
    showPoweredBy && (
      <div className="card-powered-by">
        <button
          type="button"
          className="card-powered-by-btn"
          onClick={() => {
            haptic('light');
            setShowGetSame(true);
          }}
        >
          <span>{BRAND_SIGNATURE}</span>
          <span aria-hidden="true">·</span>
          <span className="card-powered-by-cta">想要同款？</span>
        </button>
      </div>
    );

  const renderGetSameModal = () =>
    showGetSame && (
      <Suspense fallback={null}>
        <GetSameCardModal onClose={() => setShowGetSame(false)} onToast={onToast} />
      </Suspense>
    );

  const renderShareSheet = () =>
    shareOpen && (
      <div className="sheet-backdrop" onClick={() => setShareOpen(false)}>
        <div className="sheet-panel" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-handle" />
          <div className="sheet-header">
            <div className="sheet-title">分享个人名片</div>
            <button type="button" className="icon-btn" onClick={() => setShareOpen(false)}>
              <X size={16} />
            </button>
          </div>

          <div className="share-poster-stage">
            {posterLoading ? (
              <div className="share-poster-placeholder">
                <RefreshCw size={22} className="spin" color="var(--accent)" />
                <span>正在绘制高清名片海报…</span>
              </div>
            ) : posterError ? (
              <div className="share-poster-placeholder">
                <span style={{ color: 'var(--red)' }}>⚠️ {posterError}</span>
                <button type="button" className="btn btn-soft btn-sm" onClick={openShareSheet}>
                  重试
                </button>
              </div>
            ) : posterData?.dataUrl ? (
              <img
                className="share-poster-img"
                src={posterData.dataUrl}
                alt={`${profile.displayName || cardTitle} 名片海报`}
              />
            ) : null}
          </div>

          {posterData?.dataUrl && inTelegramWebView && (
            <div className="share-poster-tip">💡 长按上方海报图片即可保存到手机相册</div>
          )}

          <div className="share-poster-actions">
            {posterData?.canNativeShare && (
              <button type="button" className="btn btn-primary btn-sm" onClick={handleNativeSharePoster}>
                <Share2 size={14} /> 系统分享
              </button>
            )}
            {posterData?.dataUrl && !inTelegramWebView && (
              <button
                type="button"
                className={`btn btn-sm ${posterData?.canNativeShare ? 'btn-soft' : 'btn-primary'}`}
                onClick={handleDownloadPoster}
              >
                <Download size={14} /> 保存图片
              </button>
            )}
            {copyShareUrl && (
              <button
                type="button"
                className="btn btn-soft btn-sm"
                onClick={() => handleCopy(copyShareUrl, '名片链接')}
              >
                <Link2 size={14} /> 复制名片链接
              </button>
            )}
          </div>

          {isAdmin && (() => {
            const botUsername = String(bot?.username || '').trim().replace(/^@/, '');
            const appShortName = String(bot?.appShortName || '').trim().replace(/^\/+|\/+$/g, '');
            if (!botUsername) return null;
            const cardShareLink = appShortName
              ? buildSourceLink(`https://t.me/${botUsername}/${appShortName}`, 'link', 'app')
              : copyShareUrl;
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
              ...(cardShareLink && cardShareLink !== copyShareUrl
                ? [{ id: 'card', label: '分享名片直链', url: cardShareLink }]
                : []),
            ];
            return (
              <div
                style={{
                  marginTop: 14,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border)',
                }}
              >
                <button
                  type="button"
                  className="update-collapse-head"
                  aria-expanded={showPromoLinks}
                  onClick={() => {
                    haptic('light');
                    setShowPromoLinks((v) => !v);
                  }}
                >
                  <span className="update-collapse-title">
                    <Link2 size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
                    <span>来源追踪推广链接</span>
                    <span className="update-collapse-badge">仅站长可见</span>
                  </span>
                  {showPromoLinks ? (
                    <ChevronDown size={15} style={{ flexShrink: 0 }} />
                  ) : (
                    <ChevronRight size={15} style={{ flexShrink: 0 }} />
                  )}
                </button>
                {showPromoLinks && (
                  <div className="update-fork-body" style={{ marginTop: 8 }}>
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
                            onClick={() => handleCopy(item.url, item.label)}
                          >
                            <Copy size={12} /> 复制
                          </button>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.55 }}>
                      把 <code>src_</code> 后换成任意英文渠道名（如 <code>src_nodeseek</code>），访客页来源统计就会单独归类。
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    );

  const openBotPm = async () => {
    const rawBot = String(bot?.username || '').replace(/^@/, '').trim();
    const cleanHandle = String(profile.handle || '').replace(/^@/, '').trim();
    const uname = rawBot || (cleanHandle && cleanHandle !== 'your_bot' && /bot$/i.test(cleanHandle) ? cleanHandle : '');
    const launchSource = getLaunchSource();
    const pmDeepLink = uname
      ? launchSource
        ? buildSourceLink(`https://t.me/${uname}`, launchSource, 'bot')
        : `https://t.me/${uname}?start=pm`
      : '';
    haptic('medium');

    // Inside Telegram Mini App:
    // - From a group without source attribution: deep-link straight to `?start=pm` and close WebApp
    // - Otherwise (private chat or referral `src_*` launch): notify backend `/api/chat/start` with `source`
    //   so attribution is saved before collapsing or opening the bot DM.
    if (getTelegramInitData()) {
      const fromGroupOrDirect = isOpenedFromGroup();
      if (fromGroupOrDirect && !launchSource) {
        if (pmDeepLink) {
          openExternalUrl(pmDeepLink);
          closeMiniApp();
        } else {
          onToast('请直接私聊机器人发送消息');
        }
        return;
      }
      try {
        setOpeningPm(true);
        const res = await apiRequest('/api/chat/start', {
          method: 'POST',
          ...(launchSource ? { body: { source: launchSource } } : {}),
        });
        if (res?.needsDeepLink && pmDeepLink) {
          openExternalUrl(pmDeepLink);
        } else if (fromGroupOrDirect && uname) {
          // Opened via Direct Link (e.g. poster QR): jump straight into the bot chat without duplicating /start
          openExternalUrl(`https://t.me/${uname}`);
        }
        closeMiniApp();
      } catch {
        if (pmDeepLink) {
          openExternalUrl(pmDeepLink);
          closeMiniApp();
        } else {
          onToast('请点击右上角关闭面板，直接在下方聊天框打字发消息');
        }
      } finally {
        setOpeningPm(false);
      }
      return;
    }

    if (uname) {
      openExternalUrl(launchSource ? buildSourceLink(`https://t.me/${uname}`, launchSource, 'bot') : `https://t.me/${uname}`);
    } else {
      onToast('直接在机器人私聊窗口打字发消息即可联系');
    }
  };

  // --- Mode B: Community Group Check-in Ticket Stub ---
  if (enableCheckin && checkin) {
    const lvl = checkin.level;
    const emblemVariant =
      lvl.current.level >= 7 ? 'crown' : lvl.current.level <= 2 ? 'petal' : 'bottle';

    return (
      <>
        <div className="ticket-card">
          <div className="ticket-left">
            <div>
              <div className="ticket-user-row">
                <Avatar userId={checkin.userId} name={checkin.displayName} />
                <div style={{ minWidth: 0 }}>
                  <div className="ticket-name">{checkin.displayName}</div>
                  <div className="ticket-handle">
                    {checkin.username ? `@${checkin.username}` : `UID ${checkin.userId}`}
                  </div>
                </div>
              </div>

              <div className="ticket-big-stat">
                <div>
                  <div className="stub-label">连续签到</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 2 }}>
                    <span className="ticket-big-num">{checkin.streak}</span>
                    <span className="ticket-big-unit">天</span>
                  </div>
                </div>

                <button
                  className={`btn btn-sm ${checkin.checkedInToday ? 'btn-soft' : 'btn-primary'}`}
                  disabled={checkin.checkedInToday || checkinLoading}
                  onClick={() => {
                    haptic('medium');
                    onCheckin();
                  }}
                >
                  {checkin.checkedInToday ? (
                    <>
                      <Check size={14} /> 已签
                    </>
                  ) : checkinLoading ? (
                    '签到中…'
                  ) : (
                    <>
                      <Sparkles size={14} /> 立即签到
                    </>
                  )}
                </button>
              </div>

              <div className="ticket-caption">
                累计打卡 {checkin.totalDays} 天 · 最长连签 {checkin.bestStreak} 天
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  marginBottom: 6,
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>
                  {lvl.next ? `距 Lv.${lvl.next.level} ${lvl.next.title}` : '已达满级巅峰'}
                </span>
                <span style={{ fontWeight: 700 }}>
                  {lvl.next ? `${checkin.points} / ${lvl.next.minXp}` : `${checkin.points}`}
                </span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${lvl.progressPct}%` }} />
              </div>

              <button
                type="button"
                onClick={() => setShowLevels(true)}
                style={{
                  marginTop: 10,
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                <span>全部等级与规则</span>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>

          <div className="ticket-right">
            <div className="stub-label">等级</div>
            <StubEmblem variant={emblemVariant} size={58} />
            <div className="stub-rank">
              Lv.{lvl.current.level}
              <br />
              {lvl.current.title}
            </div>
            <div className="stub-sub">
              {community.currencyName} {checkin.points}
              <br />
              徽章 {checkin.unlockedBadgeCount}/{checkin.totalBadgeCount}
            </div>
          </div>
        </div>

        {/* 7-Day Streak Card */}
        <div className="card">
          <div className="card-header" style={{ marginBottom: 4 }}>
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Flame size={15} color="var(--accent)" /> 近 7 日打卡足迹
            </span>
            <span className="pill rose">
              +{community.dailyMinPoints}~{community.dailyMaxPoints} {community.currencyName}/日
            </span>
          </div>
          <div className="week-strip">
            {(checkin.recent7Days || []).map((d) => (
              <div
                key={d.date}
                className={`week-day ${d.checked ? 'checked' : ''} ${d.isToday ? 'today' : ''}`}
              >
                <span>{d.isToday ? '今天' : d.label}</span>
                {d.checked ? <Check size={14} /> : <span style={{ opacity: 0.4 }}>·</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Badges Wall */}
        <div className="card">
          <div className="card-header">
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Award size={15} color="var(--accent)" /> 成就徽章墙
            </span>
            <span className="stub-label">
              已点亮 {checkin.unlockedBadgeCount} / {checkin.totalBadgeCount}
            </span>
          </div>
          <div className="badge-grid">
            {(checkin.badges || []).map((b) => (
              <button
                key={b.id}
                type="button"
                className={`badge-tile ${b.unlocked ? 'unlocked' : 'locked'}`}
                style={{ border: 'none', cursor: 'pointer' }}
                onClick={() => onToast(`${b.icon} ${b.name}：${b.desc}${b.unlocked ? '（已解锁）' : '（未解锁）'}`)}
              >
                <div className="badge-emoji">{b.icon}</div>
                <div className="badge-name">{b.name}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Points Ledger */}
        <div className="card">
          <button
            type="button"
            onClick={() => setShowLogs((v) => !v)}
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
            }}
          >
            <span className="card-title">{community.currencyName}明细</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              {showLogs ? '收起' : `最近 ${checkin.logs?.length || 0} 条`}
              <ChevronRight size={14} style={{ transform: showLogs ? 'rotate(90deg)' : 'none', transition: '0.15s' }} />
            </span>
          </button>

          {showLogs && (
            <div style={{ marginTop: 12 }}>
              {checkin.logs?.length ? (
                checkin.logs.map((log, idx) => (
                  <div className="list-row" key={`${log.at}-${idx}`}>
                    <div className="row-main">
                      <div className="row-title" style={{ fontSize: 13 }}>
                        {log.reason}
                      </div>
                      <div className="row-desc">{log.date} · 余额 {log.balance}</div>
                    </div>
                    <span className="pill rose">+{log.delta}</span>
                  </div>
                ))
              ) : (
                <div className="empty-state" style={{ padding: '14px 0' }}>
                  暂无明细，点击上方「立即签到」领取今日第一笔{community.currencyName}吧 🌸
                </div>
              )}
            </div>
          )}
        </div>

        {/* Compact Owner Card */}
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar src={ownerAvatarSrc} name={cardTitle} size="sm" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{cardTitle}</div>
            <div className="row-desc">{profile.tagline}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button type="button" className="btn btn-soft btn-sm" onClick={openShareSheet}>
              <Share2 size={13} /> 分享
            </button>
            <button type="button" className="btn btn-soft btn-sm" onClick={() => onNavigate('sites')}>
              小站
            </button>
          </div>
        </div>

        {renderAdminStatusStrip()}
        {renderVisitCounter()}
        {renderPoweredBy()}
        {renderShareSheet()}
        {renderGetSameModal()}

        {/* Levels Sheet */}
        {showLevels && (
          <div className="sheet-backdrop" onClick={() => setShowLevels(false)}>
            <div className="sheet-panel" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle" />
              <div className="sheet-header">
                <div className="sheet-title">等级成长体系</div>
                <button className="icon-btn" onClick={() => setShowLevels(false)}>
                  <X size={16} />
                </button>
              </div>
              <div className="card" style={{ marginBottom: 0 }}>
                {levels.map((item) => {
                  const isCurrent = item.level === lvl.current.level;
                  return (
                    <div className="list-row" key={item.level}>
                      <div className="row-main">
                        <div className="row-title">
                          <span>Lv.{item.level} {item.title}</span>
                          {isCurrent && <span className="pill rose">当前等级</span>}
                        </div>
                        <div className="row-desc">
                          达到 {item.minXp} {community.currencyName} 解锁
                        </div>
                      </div>
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          background: item.color,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // --- Mode A: Clean Personal Card Ticket Stub (Default for @Rose202_bot) ---

  return (
    <>
      <div className="ticket-card">
        <div className="ticket-left">
          <div>
            <div className="ticket-user-row">
              <Avatar src={ownerAvatarSrc} name={cardTitle} />
              <div style={{ minWidth: 0 }}>
                <div className="ticket-name">{cardTitle}</div>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              {isAdmin ? (
                <button
                  type="button"
                  className={`pill ${statusToneClass} status-pill-btn`}
                  title="点击快捷切换状态与场景预设"
                  onClick={openStatusSheet}
                >
                  {statusStickerUrl ? (
                    <img src={statusStickerUrl} alt="" className="status-sticker-icon" />
                  ) : (
                    <span className="dot" />
                  )}
                  <span>{profile.statusText || '在线'}</span>
                  <ChevronDown size={11} style={{ opacity: 0.7 }} />
                </button>
              ) : (
                <span className={`pill ${statusToneClass}`}>
                  {statusStickerUrl ? (
                    <img src={statusStickerUrl} alt="" className="status-sticker-icon" />
                  ) : (
                    <span className="dot" />
                  )}
                  <span>{profile.statusText || '在线'}</span>
                </span>
              )}
            </div>

            <div className="ticket-caption" style={{ marginTop: 10 }}>
              {profile.tagline}
            </div>

            {parsedTags.length > 0 && (
              <div className="tag-cloud" style={{ marginTop: 10 }}>
                {parsedTags.map((tag, i) => (
                  <span key={`${tag}-${i}`} className="pill rose" style={{ fontSize: 11, padding: '3px 9px' }}>
                    # {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" disabled={openingPm} onClick={openBotPm}>
              <MessageCircle size={14} /> {openingPm ? '正在打开对话…' : '发私信'}
            </button>
            {rawHandle && rawHandle !== '@your_bot' && (
              <button
                className="btn btn-soft btn-sm"
                onClick={() => handleCopy(rawHandle, '账号')}
              >
                <Copy size={13} /> 复制账号
              </button>
            )}
            <button type="button" className="btn btn-soft btn-sm" onClick={openShareSheet}>
              <Share2 size={13} /> 分享名片
            </button>
          </div>

          {!isAdmin && bot?.pmVerificationRequired && (
            <div className="pm-verify-hint">🛡️ 首次私聊需 3 秒简单人机验证</div>
          )}
        </div>

        <div className="ticket-right">
          {String(profile.ownerTag || '').trim() && (
            <div className="stub-label">{String(profile.ownerTag).trim()}</div>
          )}
          <TicketEmblem emblem={profile.emblem} size={64} />
          {String(profile.badgeTitle || '').trim() && (
            <div className="stub-rank">{String(profile.badgeTitle).trim()}</div>
          )}
          {String(profile.joinedText || '').trim() && (
            <div className="stub-sub">{String(profile.joinedText).trim()}</div>
          )}
        </div>
      </div>

      {profile.notice && (
        <div
          className="card"
          style={{
            background: 'var(--accent-soft)',
            borderColor: 'transparent',
            padding: '12px 14px',
            fontSize: 13,
            color: 'var(--accent)',
            lineHeight: 1.55,
          }}
        >
          🌸 {profile.notice}
        </div>
      )}

      {/* Social Links Card */}
      {profile.socials?.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">联系与社交</span>
          </div>
          {profile.socials.map((item, idx) => (
            <div
              className="list-row"
              key={item.id || idx}
              style={{ cursor: item.url ? 'pointer' : 'default' }}
              onClick={() => {
                if (item.url) openExternalUrl(item.url);
                else handleCopy(item.value, item.label);
              }}
            >
              <div className="row-main">
                <div className="row-title" style={{ fontSize: 14 }}>
                  {item.label}
                </div>
                <div className="row-desc">{item.value}</div>
              </div>
              {item.url ? (
                <ExternalLink size={15} color="var(--accent)" />
              ) : (
                <Copy size={15} color="var(--text-muted)" />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Contact Etiquette Card (Visible to everyone when filled) */}
      {etiquetteLines.length > 0 && (
        <div className="card">
          <div className="card-header" style={{ marginBottom: 10 }}>
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <HeartHandshake size={15} color="var(--accent)" />
              {profile.noteTitle || '来信礼仪'}
            </span>
          </div>

          <div className="etiquette-list">
            {etiquetteLines.map((line, i) => (
              <div className="etiquette-item" key={i}>
                <span className="etiquette-num">{i + 1}</span>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Admin-only single-line protection / pending-review status strip */}
      {renderAdminStatusStrip()}

      {renderVisitCounter()}
      {renderPoweredBy()}
      {renderStatusSheet()}
      {renderShareSheet()}
      {renderGetSameModal()}
    </>
  );
}
