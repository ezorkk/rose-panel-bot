import React, { useState } from 'react';
import {
  Award,
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Flame,
  HeartHandshake,
  Link2,
  Lock,
  MessageCircle,
  RefreshCw,
  Share2,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { Avatar, StubEmblem, TicketEmblem } from './Emblems.jsx';
import { apiRequest, formatTimeAgo } from '../lib/api.js';
import {
  closeMiniApp,
  copyText,
  getTelegramInitData,
  getTelegramWebApp,
  haptic,
  isOpenedFromGroup,
  openExternalUrl,
} from '../lib/telegram.js';

export default function TicketTab({
  data,
  onNavigate,
  onOpenVisitor,
  onCheckin,
  checkinLoading,
  onOpenWhatsNew,
  onToast,
}) {
  const [showLevels, setShowLevels] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const {
    config,
    user,
    isAdmin,
    checkin,
    levels = [],
    visitorSummary = null,
    recentVisitors = [],
    blockedSpamCount = 0,
  } = data;
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

  const resolvedShareUrl =
    String(config.shareUrl || '').trim() ||
    (typeof window !== 'undefined' ? `${window.location.origin}/` : '');
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
        shareUrl: resolvedShareUrl,
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
            {resolvedShareUrl && (
              <button
                type="button"
                className="btn btn-soft btn-sm"
                onClick={() => handleCopy(resolvedShareUrl, '名片链接')}
              >
                <Link2 size={14} /> 复制名片链接
              </button>
            )}
          </div>
        </div>
      </div>
    );

  const openBotPm = async () => {
    const rawBot = String(bot?.username || '').replace(/^@/, '').trim();
    const cleanHandle = String(profile.handle || '').replace(/^@/, '').trim();
    const uname = rawBot || (cleanHandle && cleanHandle !== 'your_bot' && /bot$/i.test(cleanHandle) ? cleanHandle : '');
    haptic('medium');

    // Inside Telegram Mini App:
    // - From a group: deep-link straight to `?start=pm` (auto-triggers verification!) and close WebApp
    // - From private chat: ask backend to pop verification/prompt into the chat & collapse the WebApp sheet!
    if (getTelegramInitData()) {
      if (isOpenedFromGroup()) {
        if (uname) {
          openExternalUrl(`https://t.me/${uname}?start=pm`);
          closeMiniApp();
        } else {
          onToast('请直接私聊机器人发送消息');
        }
        return;
      }
      try {
        setOpeningPm(true);
        const res = await apiRequest('/api/chat/start', { method: 'POST' });
        if (res?.needsDeepLink && uname) {
          openExternalUrl(`https://t.me/${uname}?start=pm`);
        }
        closeMiniApp();
      } catch {
        if (uname) {
          openExternalUrl(`https://t.me/${uname}?start=pm`);
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
      openExternalUrl(`https://t.me/${uname}`);
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

        {renderShareSheet()}

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
              <span className={`pill ${statusToneClass}`}>
                <span className="dot" />
                {profile.statusText || '在线'}
              </span>
            </div>

            <div className="ticket-caption" style={{ marginTop: 10 }}>
              {profile.tagline}
            </div>
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

      {/* Personal Tags & Contact Etiquette Card (Visible to everyone when filled) */}
      {(parsedTags.length > 0 || etiquetteLines.length > 0) && (
        <div className="card">
          <div className="card-header" style={{ marginBottom: 10 }}>
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <HeartHandshake size={15} color="var(--accent)" />
              {profile.noteTitle || '来信礼仪'}
            </span>
          </div>

          {parsedTags.length > 0 && (
            <div className="tag-cloud" style={{ marginBottom: etiquetteLines.length > 0 ? 12 : 0 }}>
              {parsedTags.map((tag, i) => (
                <span key={`${tag}-${i}`} className="pill rose">
                  # {tag}
                </span>
              ))}
            </div>
          )}

          {etiquetteLines.length > 0 && (
            <div className="etiquette-list">
              {etiquetteLines.map((line, i) => (
                <div className="etiquette-item" key={i}>
                  <span className="etiquette-num">{i + 1}</span>
                  <span>{line}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Admin-Only Owner Overview: Blocked Spam, Active Visitors & Recent Contacts */}
      {isAdmin && visitorSummary && (
        <div className="card">
          <div className="card-header" style={{ marginBottom: 10 }}>
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <ShieldCheck size={15} color="var(--accent)" /> 站长速览
              <span className="pill" style={{ padding: '2px 8px', fontSize: 10 }}>
                <Lock size={10} /> 仅自己可见
              </span>
              {onOpenWhatsNew && (
                <button
                  type="button"
                  className="pill rose"
                  style={{ padding: '2px 8px', fontSize: 10, border: 'none', cursor: 'pointer' }}
                  onClick={() => {
                    haptic('light');
                    onOpenWhatsNew();
                  }}
                >
                  <Sparkles size={10} /> 近期更新
                </button>
              )}
            </span>
            <button
              type="button"
              onClick={() => onNavigate('visitors')}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--accent)',
                cursor: 'pointer',
              }}
            >
              全部 {visitorSummary.total || 0} <ChevronRight size={14} />
            </button>
          </div>

          <div className="owner-stat-grid">
            <button
              type="button"
              className="owner-stat-tile rose"
              onClick={() => onNavigate('visitors')}
            >
              <div className="owner-stat-label">
                <ShieldCheck size={13} /> 已拦截广告
              </div>
              <div className="owner-stat-value">
                <span className="owner-stat-num">{blockedSpamCount || 0}</span>
                <span className="owner-stat-unit">次</span>
              </div>
              <div className="owner-stat-sub">四层防骚扰实时守护</div>
            </button>

            <button
              type="button"
              className="owner-stat-tile"
              onClick={() => onNavigate('visitors')}
            >
              <div className="owner-stat-label">
                <Users size={13} /> 活跃访客
              </div>
              <div className="owner-stat-value">
                <span className="owner-stat-num">{visitorSummary.active ?? visitorSummary.total ?? 0}</span>
                <span className="owner-stat-unit">位</span>
              </div>
              <div className="owner-stat-sub">
                信任 {visitorSummary.trusted || 0} · 封禁 {visitorSummary.banned || 0}
              </div>
            </button>
          </div>

          <div className="recent-subhead">
            <span>最近联系</span>
            <span>点击查看记录</span>
          </div>

          {recentVisitors.length > 0 ? (
            recentVisitors.slice(0, 4).map((v) => (
              <div
                className="list-row"
                key={v.userId}
                style={{ cursor: 'pointer' }}
                onClick={() => (onOpenVisitor ? onOpenVisitor(v.userId) : onNavigate('visitors'))}
              >
                <Avatar userId={v.userId} name={v.displayName} size="sm" />
                <div className="row-main">
                  <div className="row-title" style={{ fontSize: 14 }}>
                    <span
                      style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {v.displayName}
                    </span>
                    {v.isBanned && (
                      <span className="pill red" style={{ padding: '1px 6px', fontSize: 10 }}>
                        封禁
                      </span>
                    )}
                    {!v.isBanned && v.isTrusted && (
                      <span className="pill green" style={{ padding: '1px 6px', fontSize: 10 }}>
                        信任
                      </span>
                    )}
                  </div>
                  <div className="row-desc">
                    {v.last_preview || (v.username ? `@${v.username}` : `UID ${v.userId}`)}
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 3,
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {formatTimeAgo(v.last_seen_at)}
                  </span>
                  {v.msg_count > 0 && (
                    <span className="pill" style={{ padding: '1px 7px', fontSize: 10 }}>
                      {v.msg_count} 条
                    </span>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state" style={{ padding: '12px 0' }}>
              暂无访客来信记录
            </div>
          )}
        </div>
      )}

      {renderShareSheet()}
    </>
  );
}
