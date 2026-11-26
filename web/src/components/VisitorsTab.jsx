import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  ImagePlus,
  Link2,
  Lock,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Star,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import { apiRequest, formatTimeAgo } from '../lib/api.js';
import { confirmDialog, copyText, formatSourceLabel, haptic, openExternalUrl } from '../lib/telegram.js';
import { Avatar } from './Emblems.jsx';

const MAX_REPLY_PHOTO_BYTES = 10 * 1024 * 1024;
const REPLY_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const STATUS_META = {
  banned: { label: '已拉黑', tone: 'red' },
  trusted: { label: '永久信任', tone: 'rose' },
  verified: { label: '已验证', tone: 'green' },
  closed: { label: '已结单', tone: 'amber' },
  pending: { label: '待验证', tone: '' },
};

export default function VisitorsTab({
  initialVisitorId = '',
  initialVisitStats = null,
  onClearInitial,
  onToast,
}) {
  const [visitors, setVisitors] = useState([]);
  const [stats, setStats] = useState({ total: 0, active: 0, trusted: 0, banned: 0, closed: 0 });
  const [sourceStats, setSourceStats] = useState([]);
  const [visitStats, setVisitStats] = useState(initialVisitStats);
  const [blockedSpamCount, setBlockedSpamCount] = useState(0);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const [activeVisitor, setActiveVisitor] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  // Sub-views inside Visitor Sheet: 'profile' | 'chat' | 'photos' | 'links'
  const [drawerView, setDrawerView] = useState('profile');
  const [historyData, setHistoryData] = useState({ photos: [], links: [], messages: [] });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [senderFilter, setSenderFilter] = useState('all'); // all | visitor | admin
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // In-panel direct chat composer state
  const [replyText, setReplyText] = useState('');
  const [replyPhoto, setReplyPhoto] = useState(null);
  // Optimistic outgoing bubbles: shown the moment the owner taps Send while the request (deliver to
  // visitor -> mirror to topic -> archive) runs in the background. Kept outside `historyData` so the
  // 6-second history poll can't wipe them; sends go through a queue so the visitor receives them in order.
  const [pendingReplies, setPendingReplies] = useState([]);
  const sendQueueRef = useRef(Promise.resolve());
  const pendingSeqRef = useRef(0);
  // Optimistic recall: bubbles being recalled are hidden at once (by pmMessageId) and only come back
  // if the request fails. Kept as a set so the 6-second history poll can't resurrect them meanwhile.
  const [recallingIds, setRecallingIds] = useState(() => new Set());
  const chatEndRef = useRef(null);
  const fileInputRef = useRef(null);
  // Race guards: the uid the drawer currently shows, a monotonically increasing history request
  // sequence (stale responses are dropped), and an in-flight counter so polls never stack up.
  const activeUidRef = useRef('');
  const historySeqRef = useRef(0);
  const historyInFlightRef = useRef(0);

  const loadList = async (q = search, f = filter) => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (f && f !== 'all') params.set('filter', f);
      const res = await apiRequest(`/api/admin/visitors?${params.toString()}`);
      setVisitors(res.items || []);
      setStats(res.stats || stats);
      if (Array.isArray(res.sourceStats)) {
        setSourceStats(res.sourceStats);
      }
      if (res.visitStats && typeof res.visitStats.thisMonth === 'number') {
        setVisitStats(res.visitStats);
      }
      if (typeof res.blockedSpamCount === 'number') {
        setBlockedSpamCount(res.blockedSpamCount);
      }
    } catch (err) {
      onToast(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => loadList(search, filter), 160);
    return () => clearTimeout(timer);
  }, [search, filter]);

  const loadVisitorHistory = async (uid, { silent = false } = {}) => {
    const targetUid = String(uid);
    if (silent && historyInFlightRef.current > 0) return;
    const seq = ++historySeqRef.current;
    historyInFlightRef.current += 1;
    try {
      if (!silent) setHistoryLoading(true);
      const res = await apiRequest(`/api/admin/visitors/${encodeURIComponent(targetUid)}/history`);
      // Drop responses for a visitor the admin already switched away from, or superseded by a newer load/mutation
      if (seq !== historySeqRef.current || activeUidRef.current !== targetUid) return;
      setHistoryData({
        photos: res.photos || [],
        links: res.links || [],
        messages: res.messages || [],
      });
      if (res.visitor) {
        setActiveVisitor(res.visitor);
      }
    } catch (err) {
      if (!silent && seq === historySeqRef.current && activeUidRef.current === targetUid) onToast(err.message);
    } finally {
      historyInFlightRef.current -= 1;
      if (!silent) setHistoryLoading(false);
    }
  };

  const openDetail = (v) => {
    activeUidRef.current = String(v?.userId || '');
    historySeqRef.current += 1;
    setActiveVisitor(v);
    setNoteDraft(v.note || '');
    setDrawerView('profile');
    setSenderFilter('all');
    setShowClearConfirm(false);
    setReplyText('');
    setReplyPhoto(null);
    setHistoryData({ photos: [], links: [], messages: [] });
    haptic('light');
  };

  const clearReplyPhoto = () => {
    setReplyPhoto(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const closeDetail = () => {
    activeUidRef.current = '';
    historySeqRef.current += 1;
    setActiveVisitor(null);
    setDrawerView('profile');
    setShowClearConfirm(false);
    setLightboxPhoto(null);
    setReplyText('');
    setReplyPhoto(null);
  };

  // Auto-scroll chat to newest message & lightweight live refresh while chat view is open
  useEffect(() => {
    if (drawerView === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [drawerView, historyData.messages.length, pendingReplies.length]);

  useEffect(() => {
    if (drawerView !== 'chat' || !activeVisitor?.userId) return undefined;
    const iv = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        loadVisitorHistory(activeVisitor.userId, { silent: true });
      }
    }, 6000);
    return () => clearInterval(iv);
  }, [drawerView, activeVisitor?.userId]);

  const sendReplyRequest = async (pending) => {
    const { uid, text, photo, localId } = pending;
    try {
      let body;
      if (photo) {
        body = new FormData();
        body.append('photo', photo, photo.name || 'photo.jpg');
        if (text) body.append('text', text);
      } else {
        body = { text };
      }
      // Invalidate any poll already in flight: its snapshot predates this message
      historySeqRef.current += 1;
      const res = await apiRequest(`/api/admin/visitors/${encodeURIComponent(uid)}/reply`, {
        method: 'POST',
        body,
      });
      historySeqRef.current += 1;
      loadList(search, filter);
      // Admin switched to another visitor while the request was in flight: leave that drawer alone
      if (activeUidRef.current === uid) {
        if (res.visitor) setActiveVisitor(res.visitor);
        if (res.message) {
          setHistoryData((prev) => {
            const list = prev.messages || [];
            if (list.some((m) => m.id === res.message.id)) return prev;
            return { ...prev, messages: [...list, res.message] };
          });
        } else {
          await loadVisitorHistory(uid, { silent: true });
        }
      }
    } catch (err) {
      // Put the text back (unless the owner already typed something new) and explain why it failed
      if (activeUidRef.current === uid) {
        if (text) setReplyText((cur) => (cur.trim() ? cur : text));
        onToast(err.message || '发送失败');
      }
    } finally {
      setPendingReplies((list) => list.filter((p) => p.localId !== localId));
      if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
    }
  };

  const handleSendReply = () => {
    if (!activeVisitor) return;
    const uid = String(activeVisitor.userId);
    const trimmed = replyText.trim();
    const photo = replyPhoto;
    if (!trimmed && !photo) return;

    haptic('light');
    pendingSeqRef.current += 1;
    const pending = {
      localId: `pending-${Date.now()}-${pendingSeqRef.current}`,
      uid,
      text: trimmed,
      photo,
      previewUrl: photo && typeof URL !== 'undefined' ? URL.createObjectURL(photo) : '',
      at: new Date().toISOString(),
    };
    setPendingReplies((list) => [...list, pending]);
    setReplyText('');
    clearReplyPhoto();

    sendQueueRef.current = sendQueueRef.current.then(() => sendReplyRequest(pending));
  };

  const handleRecallBubble = async (pmMessageId) => {
    const id = Number(pmMessageId);
    if (!activeVisitor || !id || recallingIds.has(id)) return;
    const uid = String(activeVisitor.userId);
    const ok = await confirmDialog('撤回后对方私聊与通知群话题中的这条消息都会被删除，确定撤回吗？');
    if (!ok || activeUidRef.current !== uid) return;
    const unhide = () =>
      setRecallingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    haptic('warning');
    setRecallingIds((prev) => new Set(prev).add(id));
    try {
      historySeqRef.current += 1;
      await apiRequest(`/api/admin/visitors/${encodeURIComponent(uid)}/recall`, {
        method: 'POST',
        body: { pmMessageId: id },
      });
      historySeqRef.current += 1;
      if (activeUidRef.current === uid) {
        setHistoryData((prev) => ({
          ...prev,
          messages: (prev.messages || []).filter(
            (m) => !(m.sender === 'admin' && Number(m.pmMessageId) === id)
          ),
        }));
        loadVisitorHistory(uid, { silent: true });
        onToast('🗑️ 已撤回发给对方的该条消息');
      }
      loadList(search, filter);
      unhide();
    } catch (err) {
      // Bring the bubble back and say why (e.g. past Telegram's 48-hour limit)
      unhide();
      if (activeUidRef.current === uid) onToast(err.message || '撤回失败');
    }
  };

  const handlePickReplyPhoto = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const type = String(f.type || '').toLowerCase();
    if (type && !REPLY_PHOTO_TYPES.has(type)) {
      onToast('仅支持发送 JPG / PNG / WebP / GIF 图片');
      e.target.value = '';
      return;
    }
    if (f.size <= 0 || f.size > MAX_REPLY_PHOTO_BYTES) {
      onToast('单张图片不能超过 10 MB');
      e.target.value = '';
      return;
    }
    setReplyPhoto(f);
  };

  // Deep-link directly from Telegram Forum Topic button (?startapp=visitor_<uid>)
  useEffect(() => {
    if (!initialVisitorId) return;
    (async () => {
      try {
        const res = await apiRequest(`/api/admin/visitors/${encodeURIComponent(initialVisitorId)}`);
        if (res.visitor) {
          openDetail(res.visitor);
        }
      } catch (err) {
        onToast(err.message);
      } finally {
        onClearInitial?.();
      }
    })();
  }, [initialVisitorId]);

  const openHistorySubView = (view) => {
    if (!activeVisitor) return;
    haptic('light');
    setSenderFilter('all');
    setDrawerView(view);
    loadVisitorHistory(activeVisitor.userId);
  };

  const runAction = async (action, extra = {}) => {
    if (!activeVisitor) return;
    try {
      setActionBusy(true);
      haptic(action === 'ban' ? 'warning' : 'medium');
      const res = await apiRequest(`/api/admin/visitors/${activeVisitor.userId}/action`, {
        method: 'POST',
        body: { action, ...extra },
      });
      setActiveVisitor(res.visitor);
      setNoteDraft(res.visitor.note || '');
      const labels = {
        ban: '🚫 已拉黑该访客',
        unban: '✅ 已解除拉黑',
        trust: '⭐ 已设为永久信任',
        reset: '🔄 已重置人机验证',
        close: '🔒 已关闭对话',
        open: '🔓 已重新开启对话',
        note: '📝 备注已保存',
      };
      onToast(labels[action] || '操作完成');
      loadList(search, filter);
    } catch (err) {
      onToast(err.message);
    } finally {
      setActionBusy(false);
    }
  };

  const handleClearHistory = async (mode) => {
    if (!activeVisitor) return;
    try {
      setActionBusy(true);
      haptic('warning');
      const res = await apiRequest(`/api/admin/visitors/${activeVisitor.userId}/clear`, {
        method: 'POST',
        body: { mode },
      });
      setActiveVisitor(res.visitor);
      setHistoryData({ photos: [], links: [], messages: [] });
      setShowClearConfirm(false);
      setDrawerView('profile');
      if (mode === 'full') {
        const parts = ['🧹 已清空归档记录'];
        if (res.deletedTopic) parts.push('已删除管理群话题');
        if (res.deletedPmCount > 0) parts.push(`已撤回 ${res.deletedPmCount} 条近48h私聊`);
        onToast(parts.join(' · '));
      } else {
        onToast('🧹 已清空该访客的图片、链接与统计');
      }
      loadList(search, filter);
    } catch (err) {
      onToast(err.message);
    } finally {
      setActionBusy(false);
    }
  };

  const hostnameOf = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };

  const filteredPhotos = historyData.photos.filter(
    (p) => senderFilter === 'all' || p.sender === senderFilter
  );
  const filteredLinks = historyData.links.filter(
    (l) => senderFilter === 'all' || l.sender === senderFilter
  );

  return (
    <>
      {blockedSpamCount > 0 && (
        <div
          className="card"
          style={{
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--accent-soft)',
            borderColor: 'transparent',
            fontSize: 12,
            color: 'var(--accent)',
            fontWeight: 600,
          }}
        >
          <span>🛡️ 四层反广告护盾运行中</span>
          <span>已累计拦截 {blockedSpamCount} 次骚扰/广告</span>
        </div>
      )}

      {(visitStats || sourceStats.length > 0) && (
        <div className="card visitor-insight-bar">
          {visitStats && typeof visitStats.thisMonth === 'number' && (
            <div className="visitor-insight-line">
              <span className="visitor-insight-label">名片访问</span>
              <span className="visitor-insight-val">
                本月访客 {visitStats.thisMonth} 人（上月 {visitStats.lastMonth ?? 0} 人）
              </span>
            </div>
          )}
          {sourceStats.length > 0 && (
            <div className="visitor-insight-line">
              <span className="visitor-insight-label">来源统计</span>
              <span className="visitor-insight-val">
                {sourceStats.map((s) => `${s.label} ${s.count}`).join(' · ')}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="search-box">
        <Search size={16} color="var(--text-muted)" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索昵称 / @用户名 / UID / 备注"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
          >
            <X size={15} />
          </button>
        )}
      </div>

      <div className="chip-row">
        {[
          { id: 'all', label: `全部 ${stats.total}` },
          { id: 'active', label: `活跃 ${stats.active}` },
          { id: 'trusted', label: `信任 ${stats.trusted}` },
          { id: 'banned', label: `已拉黑 ${stats.banned}` },
          { id: 'closed', label: `已结单 ${stats.closed}` },
        ].map((item) => (
          <button
            key={item.id}
            className={`chip ${filter === item.id ? 'active' : ''}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card empty-state">
          <RefreshCw size={20} className="spin" color="var(--accent)" />
          <div style={{ marginTop: 8 }}>加载访客记录中…</div>
        </div>
      ) : visitors.length === 0 ? (
        <div className="card empty-state">
          <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
          <div>暂无符合条件的私聊访客</div>
          <div style={{ marginTop: 6 }}>当有人私聊你的机器人时，资料与聊天媒体会自动记录在这里。</div>
        </div>
      ) : (
        <div className="card">
          {visitors.map((v) => {
            const meta = STATUS_META[v.status] || STATUS_META.pending;
            return (
              <div
                className="list-row"
                key={v.userId}
                style={{ cursor: 'pointer' }}
                onClick={() => openDetail(v)}
              >
                <Avatar userId={v.userId} name={v.displayName} size="sm" />
                <div className="row-main">
                  <div className="row-title">
                    <span
                      style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {v.displayName}
                    </span>
                    <span className={`pill ${meta.tone}`} style={{ padding: '2px 8px', fontSize: 11 }}>
                      {meta.label}
                    </span>
                  </div>
                  <div className="row-desc">
                    {v.note ? `📝 ${v.note}` : v.last_preview || (v.username ? `@${v.username}` : `UID ${v.userId}`)}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {formatTimeAgo(v.last_seen_at)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, marginTop: 3 }}>
                    共 {v.msg_count} 条
                    {(v.photo_count > 0 || v.link_count > 0) && (
                      <span style={{ color: 'var(--text-muted)', fontWeight: 500, marginLeft: 4 }}>
                        {v.photo_count > 0 ? `🖼${v.photo_count}` : ''}
                        {v.link_count > 0 ? ` 🔗${v.link_count}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Visitor Profile, Photos Gallery, Links List & Moderation Bottom Sheet */}
      {activeVisitor && (
        <div className="sheet-backdrop" onClick={closeDetail}>
          <div className="sheet-panel" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />

            {/* Sheet Header */}
            <div className="sheet-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {drawerView !== 'profile' && (
                  <button className="icon-btn" onClick={() => setDrawerView('profile')}>
                    <ArrowLeft size={16} />
                  </button>
                )}
                <div className="sheet-title">
                  {drawerView === 'chat'
                    ? `与 ${activeVisitor.displayName} 对话`
                    : drawerView === 'photos'
                      ? `往来图片 (${historyData.photos.length})`
                      : drawerView === 'links'
                        ? `往来链接 (${historyData.links.length})`
                        : '访客资料与聊天记录'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {drawerView === 'chat' && (
                  <button
                    className="icon-btn"
                    title="刷新对话"
                    onClick={() => loadVisitorHistory(activeVisitor.userId)}
                  >
                    <RefreshCw size={14} className={historyLoading ? 'spin' : ''} />
                  </button>
                )}
                <button className="icon-btn" onClick={closeDetail}>
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* SUB-VIEW 3: DIRECT IN-PANEL CHAT & MESSAGE LOG */}
            {drawerView === 'chat' && (
              <div className="chat-box">
                <div className="chat-stream">
                  {historyLoading && historyData.messages.length === 0 ? (
                    <div className="empty-state" style={{ margin: 'auto 0' }}>
                      <RefreshCw size={20} className="spin" color="var(--accent)" />
                      <div style={{ marginTop: 8 }}>正在加载最近对话…</div>
                    </div>
                  ) : historyData.messages.length === 0 && !pendingReplies.some((p) => p.uid === String(activeVisitor.userId)) ? (
                    <div className="empty-state" style={{ margin: 'auto 0' }}>
                      <div style={{ fontSize: 26, marginBottom: 6 }}>💬</div>
                      <div style={{ fontWeight: 600, color: 'var(--text)' }}>直接在下方打字或发图给 TA</div>
                      <div style={{ marginTop: 6, lineHeight: 1.5 }}>
                        {activeVisitor.last_preview
                          ? `最近一条摘要：「${activeVisitor.last_preview}」· 新收发的消息会实时保存在这里（同步抄送通知群话题）`
                          : '发出的消息会通过机器人立即送达对方，并自动同步到你的通知群话题'}
                      </div>
                    </div>
                  ) : (
                    historyData.messages
                      .filter((m) => !(m.sender === 'admin' && recallingIds.has(Number(m.pmMessageId))))
                      .map((m) => {
                      const isMe = m.sender === 'admin';
                      return (
                        <div key={m.id} className={`chat-row ${isMe ? 'me' : 'them'}`}>
                          <div className="chat-bubble">
                            {(m.thumbUrl || m.photoUrl) && (
                              <img
                                className="chat-photo"
                                src={m.thumbUrl || m.photoUrl}
                                alt={m.text || 'chat photo'}
                                onClick={() =>
                                  setLightboxPhoto({
                                    url: m.photoUrl || m.thumbUrl,
                                    caption: m.text || '',
                                    sender: m.sender,
                                    at: m.at,
                                  })
                                }
                              />
                            )}
                            {m.text ? (
                              <div>{m.text}</div>
                            ) : m.mediaTag ? (
                              <div style={{ opacity: 0.85 }}>{m.mediaTag}</div>
                            ) : null}
                          </div>
                          <div className="chat-meta">
                            {m.visitorReaction && (
                              <span
                                className="chat-reaction-pill"
                                title="对方的回应"
                                aria-label={`对方的回应：${m.visitorReaction}`}
                              >
                                {m.visitorReaction}
                              </span>
                            )}
                            {m.ownerReaction && (
                              <span
                                className="chat-reaction-pill mine"
                                title="我的回应"
                                aria-label={`我的回应：${m.ownerReaction}`}
                              >
                                {m.ownerReaction}
                              </span>
                            )}
                            <span>{formatTimeAgo(m.at)}</span>
                            {isMe && m.pmMessageId && (
                              <button
                                type="button"
                                className="chat-recall-btn"
                                onClick={() => handleRecallBubble(m.pmMessageId)}
                              >
                                撤回
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                  {pendingReplies
                    .filter((p) => p.uid === String(activeVisitor.userId))
                    .map((p) => (
                      <div key={p.localId} className="chat-row me pending">
                        <div className="chat-bubble">
                          {p.previewUrl && <img className="chat-photo" src={p.previewUrl} alt={p.text || 'chat photo'} />}
                          {p.text ? <div>{p.text}</div> : null}
                        </div>
                        <div className="chat-meta">
                          <span>发送中…</span>
                        </div>
                      </div>
                    ))}
                  <div ref={chatEndRef} />
                </div>

                <div className="chat-composer-wrap">
                  {replyPhoto && (
                    <div className="chat-pending-img">
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        🖼️ 已选图片：{replyPhoto.name || '相册图片'}
                      </span>
                      <button
                        type="button"
                        onClick={clearReplyPhoto}
                        style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer' }}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}

                  <div className="chat-composer">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      style={{ display: 'none' }}
                      onChange={handlePickReplyPhoto}
                    />
                    <button
                      type="button"
                      className="icon-btn accent"
                      title="发送图片"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <ImagePlus size={16} />
                    </button>

                    <textarea
                      className="chat-input"
                      rows={1}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => {
                        // Don't send while a CJK IME is still composing (Enter confirms the candidate)
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                          e.preventDefault();
                          handleSendReply();
                        }
                      }}
                      placeholder={replyPhoto ? '可选：添加图片说明…' : `回复 ${activeVisitor.displayName}…`}
                    />

                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ height: 36, padding: '0 14px', flexShrink: 0 }}
                      disabled={!replyText.trim() && !replyPhoto}
                      onClick={handleSendReply}
                    >
                      <Send size={14} /> 发送
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* SUB-VIEW 1: PHOTOS GALLERY */}
            {drawerView === 'photos' && (
              <div>
                <div className="chip-row">
                  {[
                    { id: 'all', label: `全部 ${historyData.photos.length}` },
                    {
                      id: 'visitor',
                      label: `对方发来 ${historyData.photos.filter((p) => p.sender === 'visitor').length}`,
                    },
                    {
                      id: 'admin',
                      label: `我发出的 ${historyData.photos.filter((p) => p.sender === 'admin').length}`,
                    },
                  ].map((f) => (
                    <button
                      key={f.id}
                      className={`chip ${senderFilter === f.id ? 'active' : ''}`}
                      onClick={() => setSenderFilter(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {historyLoading ? (
                  <div className="card empty-state">
                    <RefreshCw size={20} className="spin" color="var(--accent)" />
                    <div style={{ marginTop: 8 }}>正在加载往来图片…</div>
                  </div>
                ) : filteredPhotos.length === 0 ? (
                  <div className="card empty-state">
                    <div style={{ fontSize: 28, marginBottom: 8 }}>🖼️</div>
                    <div>暂无归档图片</div>
                    <div style={{ marginTop: 6 }}>今后双方发送的图片都会自动归档在此处</div>
                  </div>
                ) : (
                  <div className="photo-grid">
                    {filteredPhotos.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="photo-tile"
                        onClick={() => setLightboxPhoto(p)}
                      >
                        <img src={p.thumbUrl} alt={p.caption || 'chat photo'} loading="lazy" />
                        <span className={`photo-sender-tag ${p.sender === 'admin' ? 'me' : ''}`}>
                          {p.sender === 'admin' ? '我' : '对方'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* SUB-VIEW 2: LINKS LIST */}
            {drawerView === 'links' && (
              <div>
                <div className="chip-row">
                  {[
                    { id: 'all', label: `全部 ${historyData.links.length}` },
                    {
                      id: 'visitor',
                      label: `对方发来 ${historyData.links.filter((l) => l.sender === 'visitor').length}`,
                    },
                    {
                      id: 'admin',
                      label: `我发出的 ${historyData.links.filter((l) => l.sender === 'admin').length}`,
                    },
                  ].map((f) => (
                    <button
                      key={f.id}
                      className={`chip ${senderFilter === f.id ? 'active' : ''}`}
                      onClick={() => setSenderFilter(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {historyLoading ? (
                  <div className="card empty-state">
                    <RefreshCw size={20} className="spin" color="var(--accent)" />
                    <div style={{ marginTop: 8 }}>正在加载往来链接…</div>
                  </div>
                ) : filteredLinks.length === 0 ? (
                  <div className="card empty-state">
                    <div style={{ fontSize: 28, marginBottom: 8 }}>🔗</div>
                    <div>暂无归档链接</div>
                    <div style={{ marginTop: 6 }}>今后双方发送的网址和 TG 链接会自动归档在此处</div>
                  </div>
                ) : (
                  <div className="card">
                    {filteredLinks.map((item) => (
                      <div className="list-row" key={item.id}>
                        <div className="row-main" style={{ cursor: 'pointer' }} onClick={() => openExternalUrl(item.url)}>
                          <div className="row-title" style={{ fontSize: 13 }}>
                            <span className={`pill ${item.sender === 'admin' ? 'rose' : ''}`} style={{ padding: '2px 7px', fontSize: 10 }}>
                              {item.sender === 'admin' ? '我' : '对方'}
                            </span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {hostnameOf(item.url)}
                            </span>
                          </div>
                          <div className="row-desc" style={{ color: 'var(--accent)' }}>
                            {item.url}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            {formatTimeAgo(item.at)}
                            {item.snippet && item.snippet !== item.url ? ` · ${item.snippet}` : ''}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                          <button
                            className="icon-btn"
                            title="复制链接"
                            onClick={async () => {
                              await copyText(item.url);
                              onToast('已复制链接');
                            }}
                          >
                            <Copy size={14} />
                          </button>
                          <button
                            className="btn btn-soft btn-sm"
                            onClick={() => openExternalUrl(item.url)}
                          >
                            打开 <ExternalLink size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* SUB-VIEW 0: PROFILE & MODERATION */}
            {drawerView === 'profile' && (
              <>
                <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <Avatar userId={activeVisitor.userId} name={activeVisitor.displayName} size="lg" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 18, fontWeight: 700 }}>{activeVisitor.displayName}</span>
                      <span
                        className={`pill ${(STATUS_META[activeVisitor.status] || STATUS_META.pending).tone}`}
                      >
                        {(STATUS_META[activeVisitor.status] || STATUS_META.pending).label}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                      {activeVisitor.username ? `@${activeVisitor.username}` : '未设置用户名'} · UID{' '}
                      {activeVisitor.userId}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-subtle btn-sm"
                        onClick={async () => {
                          await copyText(activeVisitor.userId);
                          onToast('已复制 UID');
                        }}
                      >
                        <Copy size={12} /> 复制 UID
                      </button>
                      {activeVisitor.username && (
                        <button
                          className="btn btn-soft btn-sm"
                          onClick={() => openExternalUrl(`https://t.me/${activeVisitor.username}`)}
                        >
                          TG 主页 <ExternalLink size={12} />
                        </button>
                      )}
                      {activeVisitor.topicLink && (
                        <button
                          className="btn btn-soft btn-sm"
                          onClick={() => openExternalUrl(activeVisitor.topicLink)}
                        >
                          去话题 <ExternalLink size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Bidirectional Chat Stats + Quick Chat / Photos / Links Buttons */}
                <div className="stat-action-grid">
                  <button
                    type="button"
                    className="stat-action-card clickable"
                    onClick={() => openHistorySubView('chat')}
                  >
                    <div className="stat-action-top">
                      <MessageSquare size={15} color="var(--accent)" />
                      <span>聊过</span>
                    </div>
                    <div className="stat-action-num">{activeVisitor.msg_count} 条</div>
                    <div className="stat-action-sub" style={{ color: 'var(--accent)' }}>
                      查看 / 回复 →
                    </div>
                  </button>

                  <button
                    type="button"
                    className="stat-action-card clickable"
                    onClick={() => openHistorySubView('photos')}
                  >
                    <div className="stat-action-top">
                      <ImageIcon size={15} color="var(--accent)" />
                      <span>图片</span>
                    </div>
                    <div className="stat-action-num">{activeVisitor.photo_count || 0} 张</div>
                    <div className="stat-action-sub" style={{ color: 'var(--accent)' }}>
                      查看全部 →
                    </div>
                  </button>

                  <button
                    type="button"
                    className="stat-action-card clickable"
                    onClick={() => openHistorySubView('links')}
                  >
                    <div className="stat-action-top">
                      <Link2 size={15} color="var(--accent)" />
                      <span>链接</span>
                    </div>
                    <div className="stat-action-num">{activeVisitor.link_count || 0} 条</div>
                    <div className="stat-action-sub" style={{ color: 'var(--accent)' }}>
                      查看全部 →
                    </div>
                  </button>
                </div>

                <div className="card" style={{ fontSize: 13 }}>
                  <div className="list-row">
                    <span style={{ color: 'var(--text-secondary)' }}>首次私聊</span>
                    <span>{formatTimeAgo(activeVisitor.first_seen_at)}</span>
                  </div>
                  <div className="list-row">
                    <span style={{ color: 'var(--text-secondary)' }}>最近活跃</span>
                    <span>{formatTimeAgo(activeVisitor.last_seen_at)}</span>
                  </div>
                  {activeVisitor.source && (
                    <div className="list-row">
                      <span style={{ color: 'var(--text-secondary)' }}>访客来源</span>
                      <span>
                        {formatSourceLabel(activeVisitor.source)}
                        {activeVisitor.source_at ? ` · ${formatTimeAgo(activeVisitor.source_at)}` : ''}
                      </span>
                    </div>
                  )}
                  {activeVisitor.last_preview && (
                    <div className="list-row">
                      <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>最近消息</span>
                      <span
                        style={{
                          textAlign: 'right',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {activeVisitor.last_preview}
                      </span>
                    </div>
                  )}
                </div>

                {/* Admin Private Note */}
                <div className="card">
                  <label className="field-label">站长私密备注（仅你可见）</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="input"
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder="例如：老朋友 / 商务合作 / 广告营销号"
                    />
                    <button
                      className="btn btn-soft"
                      style={{ flexShrink: 0 }}
                      disabled={actionBusy}
                      onClick={() => runAction('note', { note: noteDraft })}
                    >
                      <Save size={14} /> 保存
                    </button>
                  </div>
                </div>

                {/* Clear Chat History Control */}
                <div className="card" style={{ padding: 12 }}>
                  {!showClearConfirm ? (
                    <button
                      type="button"
                      className="btn btn-subtle btn-block"
                      disabled={actionBusy}
                      onClick={() => setShowClearConfirm(true)}
                    >
                      <Trash2 size={15} /> 快速清空与 TA 的聊天记录
                    </button>
                  ) : (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                        选择清空范围：
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn-soft btn-block"
                          disabled={actionBusy}
                          onClick={() => handleClearHistory('archive')}
                        >
                          仅清空面板统计与图片/链接归档
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-block"
                          disabled={actionBusy}
                          onClick={() => handleClearHistory('full')}
                        >
                          彻底清空（删除管理群话题 + 撤回48h内私聊）
                        </button>
                        <button
                          type="button"
                          className="btn btn-subtle btn-block"
                          disabled={actionBusy}
                          onClick={() => setShowClearConfirm(false)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* One-Tap Moderation Buttons */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {activeVisitor.isBanned ? (
                    <button
                      className="btn btn-success btn-block"
                      disabled={actionBusy}
                      onClick={() => runAction('unban')}
                    >
                      <CheckCircle2 size={16} /> 解除拉黑
                    </button>
                  ) : (
                    <button
                      className="btn btn-danger btn-block"
                      disabled={actionBusy}
                      onClick={() => runAction('ban')}
                    >
                      <Ban size={16} /> 一键拉黑
                    </button>
                  )}

                  {activeVisitor.isTrusted ? (
                    <button
                      className="btn btn-subtle btn-block"
                      disabled={actionBusy}
                      onClick={() => runAction('reset')}
                    >
                      <RotateCcw size={16} /> 重置验证
                    </button>
                  ) : (
                    <button
                      className="btn btn-soft btn-block"
                      disabled={actionBusy}
                      onClick={() => runAction('trust')}
                    >
                      <Star size={16} /> 永久信任
                    </button>
                  )}

                  {activeVisitor.isClosed ? (
                    <button
                      className="btn btn-soft btn-block"
                      style={{ gridColumn: 'span 2' }}
                      disabled={actionBusy}
                      onClick={() => runAction('open', { notifyUser: true })}
                    >
                      <Unlock size={16} /> 恢复对话并通知对方
                    </button>
                  ) : (
                    <button
                      className="btn btn-subtle btn-block"
                      style={{ gridColumn: 'span 2' }}
                      disabled={actionBusy}
                      onClick={() => runAction('close', { notifyUser: true })}
                    >
                      <Lock size={16} /> 结束本次对话并通知对方
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Fullscreen Photo Lightbox */}
      {lightboxPhoto && (
        <div className="lightbox-backdrop" onClick={() => setLightboxPhoto(null)}>
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button className="lightbox-close" onClick={() => setLightboxPhoto(null)}>
              <X size={20} />
            </button>
            <img src={lightboxPhoto.url} alt={lightboxPhoto.caption || 'photo'} />
            <div className="lightbox-meta">
              <span className="pill rose" style={{ padding: '2px 8px', fontSize: 11 }}>
                {lightboxPhoto.sender === 'admin' ? '我发出的' : '对方发来'}
              </span>
              <span>{formatTimeAgo(lightboxPhoto.at)}</span>
              {lightboxPhoto.caption && <div style={{ width: '100%', marginTop: 4 }}>{lightboxPhoto.caption}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
