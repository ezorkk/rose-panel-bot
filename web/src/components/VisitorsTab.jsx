import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Ban,
  Calendar,
  CheckCircle2,
  Copy,
  Database,
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
  ShieldCheck,
  Star,
  Trash2,
  Unlock,
  Users,
  X,
} from 'lucide-react';
import { apiRequest, formatTimeAgo } from '../lib/api.js';
import {
  HISTORY_PAGE_SIZE,
  appendNewerHistory,
  buildHistoryUrl,
  buildSearchUrl,
  mergeLatestHistoryTail,
  prependOlderHistory,
  splitHighlightSegments,
} from '../lib/chatHistory.js';
import {
  confirmDialog,
  copyText,
  formatSourceLabel,
  getTelegramWebApp,
  haptic,
  openExternalUrl,
} from '../lib/telegram.js';
import { Avatar, TgStickerMedia } from './Emblems.jsx';

const EMPTY_HISTORY = {
  photos: [],
  links: [],
  messages: [],
  hasMore: false,
  hasNewer: false,
  oldestCursor: null,
  newestCursor: null,
};

function renderHighlightedText(text, query) {
  const segments = splitHighlightSegments(text, query);
  return segments.map((seg, idx) =>
    seg.match ? (
      <mark key={idx} className="search-hl">
        {seg.text}
      </mark>
    ) : (
      <React.Fragment key={idx}>{seg.text}</React.Fragment>
    )
  );
}

const MAX_REPLY_PHOTO_BYTES = 10 * 1024 * 1024;
// A history request that takes longer than this is abandoned so later polls aren't blocked
const HISTORY_TIMEOUT_MS = 10000;
const REPLY_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const STATUS_META = {
  banned: { label: '已拉黑', tone: 'red' },
  trusted: { label: '永久信任', tone: 'rose' },
  verified: { label: '已验证', tone: 'green' },
  closed: { label: '已结单', tone: 'amber' },
  pending: { label: '待验证', tone: '' },
};

const PROBATION_REASON_LABELS = {
  link: '含链接',
  forwarded: '转发消息',
  mention: '含 @用户名',
  contact: '含联系方式',
};

export default function VisitorsTab({
  d1Bound = false,
  initialVisitorId = '',
  initialFilter = '',
  initialVisitStats = null,
  initialBlockedSpamCount = 0,
  initialBlockedToday = 0,
  onOpenSettings = null,
  onClearInitial,
  onClearInitialFilter,
  onStatsSync,
  onToast,
}) {
  const [visitors, setVisitors] = useState([]);
  const [stats, setStats] = useState({ total: 0, active: 0, trusted: 0, banned: 0, closed: 0, pendingReview: 0 });
  const [sourceStats, setSourceStats] = useState([]);
  const [visitStats, setVisitStats] = useState(initialVisitStats);
  const [blockedSpamCount, setBlockedSpamCount] = useState(initialBlockedSpamCount);
  const [blockedToday, setBlockedToday] = useState(initialBlockedToday);
  const [filter, setFilter] = useState(() => initialFilter || 'all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // D1 full-history message search state (strictly disabled & hidden when d1Bound === false)
  // Defaults to last 30 days so LIKE scans stay bounded by `idx_messages_time`, and triggers only on
  // explicit Enter/Search click (never mid-keystroke or mid-IME composition) to protect D1 row-read quota.
  const [searchMode, setSearchMode] = useState('visitors'); // 'visitors' | 'messages'
  const [msgQuery, setMsgQuery] = useState('');
  const [submittedMsgQuery, setSubmittedMsgQuery] = useState('');
  const [msgUidFilter, setMsgUidFilter] = useState('');
  const [msgUidLabel, setMsgUidLabel] = useState('');
  const [msgTimeRange, setMsgTimeRange] = useState('30d'); // '30d' | '7d' | 'all' | 'custom'
  const [msgDateFrom, setMsgDateFrom] = useState('');
  const [msgDateTo, setMsgDateTo] = useState('');
  const [msgResults, setMsgResults] = useState([]);
  const [msgHasMore, setMsgHasMore] = useState(false);
  const [msgNextCursor, setMsgNextCursor] = useState(null);
  const [msgSearching, setMsgSearching] = useState(false);
  const [msgLoadingMore, setMsgLoadingMore] = useState(false);
  const [msgSearchError, setMsgSearchError] = useState('');
  const [msgHasSearched, setMsgHasSearched] = useState(false);
  const [unmigratedVisitorsCount, setUnmigratedVisitorsCount] = useState(0);
  const storageCheckedRef = useRef(false);
  const searchSeqRef = useRef(0);
  const msgSearchInputRef = useRef(null);

  const [activeVisitor, setActiveVisitor] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  // Sub-views inside Visitor Sheet: 'profile' | 'chat' | 'photos' | 'links'
  const [drawerView, setDrawerView] = useState('profile');
  const [historyData, setHistoryData] = useState(EMPTY_HISTORY);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [highlightMsgId, setHighlightMsgId] = useState('');
  const [highlightQuery, setHighlightQuery] = useState('');
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
  const chatStreamRef = useRef(null);
  const chatEndRef = useRef(null);
  const fileInputRef = useRef(null);
  // Race guards: the uid the drawer currently shows, a monotonically increasing history request
  // sequence (stale responses are dropped), an in-flight counter so polls never stack up,
  // scroll preservation intent, and whether the chat view is currently inspecting a historical `around` window.
  const activeUidRef = useRef('');
  const historySeqRef = useRef(0);
  const historyInFlightRef = useRef(0);
  const hasNewerRef = useRef(false);
  const historyStateRef = useRef(EMPTY_HISTORY);
  const scrollIntentRef = useRef({ type: 'none' });
  const highlightTimerRef = useRef(null);

  useEffect(() => {
    hasNewerRef.current = Boolean(historyData.hasNewer);
    historyStateRef.current = historyData;
  }, [historyData]);

  useEffect(() => {
    if (!d1Bound && searchMode === 'messages') {
      setSearchMode('visitors');
    }
  }, [d1Bound, searchMode]);

  useEffect(() => {
    if (!d1Bound || searchMode !== 'messages' || storageCheckedRef.current) return undefined;
    storageCheckedRef.current = true;
    let cancelled = false;
    apiRequest('/api/admin/storage')
      .then((res) => {
        if (cancelled) return;
        const pending = Math.max(0, Number(res?.total || 0) - Number(res?.done || 0));
        setUnmigratedVisitorsCount(pending);
      })
      .catch(() => {
        storageCheckedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [d1Bound, searchMode]);

  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    []
  );

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
      if (typeof res.blockedToday === 'number') {
        setBlockedToday(res.blockedToday);
      }
      onStatsSync?.({
        visitorSummary: res.stats || null,
        pendingReviewCount: Number(res.stats?.pendingReview || 0),
        blockedSpamCount: typeof res.blockedSpamCount === 'number' ? res.blockedSpamCount : undefined,
        blockedToday: typeof res.blockedToday === 'number' ? res.blockedToday : undefined,
      });
    } catch (err) {
      onToast(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initialFilter) return;
    setFilter(initialFilter);
    onClearInitialFilter?.();
  }, [initialFilter]);

  useEffect(() => {
    const timer = setTimeout(() => loadList(search, filter), 160);
    return () => clearTimeout(timer);
  }, [search, filter]);

  const runMessageSearch = async ({
    append = false,
    cursor = null,
    queryOverride = undefined,
    uidOverride = undefined,
    timeRangeOverride = undefined,
    dateFromOverride = undefined,
    dateToOverride = undefined,
  } = {}) => {
    // Strictly never call `/api/admin/search` when D1 is not bound
    if (!d1Bound) return;
    const rawQuery = queryOverride !== undefined ? queryOverride : msgQuery;
    const trimmed = String(rawQuery || '').trim();
    if (!trimmed) {
      searchSeqRef.current += 1;
      setSubmittedMsgQuery('');
      setMsgResults([]);
      setMsgHasMore(false);
      setMsgNextCursor(null);
      setMsgSearchError('');
      setMsgHasSearched(false);
      return;
    }

    const activeUid = uidOverride !== undefined ? uidOverride : msgUidFilter;
    const activeRange = timeRangeOverride !== undefined ? timeRangeOverride : msgTimeRange;
    const activeFromDate = dateFromOverride !== undefined ? dateFromOverride : msgDateFrom;
    const activeToDate = dateToOverride !== undefined ? dateToOverride : msgDateTo;

    const now = Date.now();
    let from = null;
    let to = null;
    if (activeRange === '7d') {
      from = now - 7 * 86400 * 1000;
    } else if (activeRange === '30d') {
      from = now - 30 * 86400 * 1000;
    } else if (activeRange === 'custom') {
      const f = activeFromDate ? new Date(`${activeFromDate}T00:00:00`).getTime() : null;
      const t = activeToDate ? new Date(`${activeToDate}T23:59:59.999`).getTime() : null;
      from = Number.isFinite(f) && f > 0 ? Math.trunc(f) : null;
      to = Number.isFinite(t) && t > 0 ? Math.trunc(t) : null;
    }

    if (from && to && from > to) {
      setMsgSearchError('开始日期不能晚于结束日期');
      return;
    }

    const seq = ++searchSeqRef.current;
    try {
      setMsgSearchError('');
      if (append) {
        setMsgLoadingMore(true);
      } else {
        setMsgSearching(true);
        setSubmittedMsgQuery(trimmed);
      }
      const url = buildSearchUrl({
        q: trimmed,
        uid: activeUid,
        from,
        to,
        limit: 30,
        cursor: append ? cursor : null,
      });
      const res = await apiRequest(url, { timeoutMs: HISTORY_TIMEOUT_MS });
      if (seq !== searchSeqRef.current) return;
      const nextItems = Array.isArray(res.items) ? res.items : [];
      if (append) {
        setMsgResults((prev) => {
          const seen = new Set(prev.map((x) => `${x.uid}:${x.id}`));
          return [...prev, ...nextItems.filter((x) => !seen.has(`${x.uid}:${x.id}`))];
        });
      } else {
        setMsgResults(nextItems);
      }
      setMsgHasMore(Boolean(res.hasMore));
      setMsgNextCursor(res.nextCursor || null);
      setMsgHasSearched(true);
    } catch (err) {
      if (seq !== searchSeqRef.current) return;
      setMsgSearchError(err.message || '搜索失败');
    } finally {
      if (seq === searchSeqRef.current) {
        setMsgSearching(false);
        setMsgLoadingMore(false);
      }
    }
  };

  // Only clear results when input is emptied; NEVER auto-search on every keystroke or during IME
  // composition so `LIKE '%q%'` never burns D1 free-tier row reads while typing.
  useEffect(() => {
    if (!d1Bound || searchMode !== 'messages') return;
    if (!msgQuery.trim()) {
      searchSeqRef.current += 1;
      setSubmittedMsgQuery('');
      setMsgResults([]);
      setMsgHasMore(false);
      setMsgNextCursor(null);
      setMsgSearchError('');
      setMsgHasSearched(false);
    }
  }, [d1Bound, searchMode, msgQuery]);

  const loadVisitorHistory = async (uid, { silent = false, force = false } = {}) => {
    const targetUid = String(uid);
    // Pause background tail polls while inspecting a historical `around` window
    if (silent && hasNewerRef.current) return;
    // Background polls never stack; `force` (returning to the app) may overlap an older poll —
    // the sequence check below drops whichever response is stale.
    if (silent && !force && historyInFlightRef.current > 0) return;
    const seq = ++historySeqRef.current;
    historyInFlightRef.current += 1;
    try {
      if (!silent) setHistoryLoading(true);
      const res = await apiRequest(buildHistoryUrl(targetUid, { limit: HISTORY_PAGE_SIZE }), {
        timeoutMs: HISTORY_TIMEOUT_MS,
      });
      // Drop responses for a visitor the admin already switched away from, or superseded by a newer load/mutation
      if (seq !== historySeqRef.current || activeUidRef.current !== targetUid) return;

      if (silent) {
        const el = chatStreamRef.current;
        const wasNearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        const currentSnapshot = historyStateRef.current;
        const currentMessages = Array.isArray(currentSnapshot?.messages) ? currentSnapshot.messages : [];
        const incomingLastId = res.messages?.[res.messages.length - 1]?.id || '';
        const hasNewTailMsg = Boolean(
          incomingLastId && !currentMessages.some((m) => m.id === incomingLastId)
        );
        const previewMerged = mergeLatestHistoryTail(currentSnapshot, res);
        if (wasNearBottom && hasNewTailMsg) {
          scrollIntentRef.current = { type: 'bottom' };
        } else if (previewMerged.prepended && el) {
          // If the polled latest window expanded upward (e.g. after jumping via `around` to a recent
          // message within the last 30 items), preserve visual scrollTop so the highlighted bubble stays put.
          scrollIntentRef.current = {
            type: 'preserve-top',
            prevScrollHeight: el.scrollHeight,
            prevScrollTop: el.scrollTop,
          };
        }
        setHistoryData((prev) => {
          const merged = mergeLatestHistoryTail(prev, res);
          return {
            photos: res.photos || prev.photos || [],
            links: res.links || prev.links || [],
            messages: merged.messages,
            hasMore: merged.hasMore,
            hasNewer: false,
            oldestCursor: merged.oldestCursor,
            newestCursor: merged.newestCursor,
          };
        });
      } else {
        scrollIntentRef.current = { type: 'bottom' };
        setHighlightMsgId('');
        setHistoryData({
          photos: res.photos || [],
          links: res.links || [],
          messages: res.messages || [],
          hasMore: Boolean(res.hasMore),
          hasNewer: false,
          oldestCursor: res.oldestCursor || null,
          newestCursor: res.newestCursor || null,
        });
      }
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

  const loadOlderMessages = async () => {
    if (!d1Bound || !activeVisitor || loadingOlder || historyLoading || !historyData.hasMore || !historyData.oldestCursor) {
      return;
    }
    const targetUid = String(activeVisitor.userId);
    const cursor = historyData.oldestCursor;
    const el = chatStreamRef.current;
    const prevScrollHeight = el ? el.scrollHeight : 0;
    const prevScrollTop = el ? el.scrollTop : 0;
    const seq = ++historySeqRef.current;
    historyInFlightRef.current += 1;

    try {
      setLoadingOlder(true);
      const res = await apiRequest(
        buildHistoryUrl(targetUid, {
          limit: HISTORY_PAGE_SIZE,
          beforeCursor: cursor,
          messagesOnly: true,
        }),
        { timeoutMs: HISTORY_TIMEOUT_MS }
      );
      if (seq !== historySeqRef.current || activeUidRef.current !== targetUid) return;
      scrollIntentRef.current = { type: 'preserve-top', prevScrollHeight, prevScrollTop };
      setHistoryData((prev) => ({
        ...prev,
        messages: prependOlderHistory(prev.messages, res.messages || []),
        hasMore: Boolean(res.hasMore),
        oldestCursor: res.oldestCursor || prev.oldestCursor,
      }));
    } catch (err) {
      if (seq === historySeqRef.current && activeUidRef.current === targetUid) {
        onToast(err.message || '加载更早消息失败');
      }
    } finally {
      historyInFlightRef.current -= 1;
      setLoadingOlder(false);
    }
  };

  const loadNewerMessages = async () => {
    if (!d1Bound || !activeVisitor || loadingNewer || historyLoading || !historyData.hasNewer || !historyData.newestCursor) {
      return;
    }
    const targetUid = String(activeVisitor.userId);
    const cursor = historyData.newestCursor;
    const seq = ++historySeqRef.current;
    historyInFlightRef.current += 1;

    try {
      setLoadingNewer(true);
      const res = await apiRequest(
        buildHistoryUrl(targetUid, {
          limit: HISTORY_PAGE_SIZE,
          afterCursor: cursor,
          messagesOnly: true,
        }),
        { timeoutMs: HISTORY_TIMEOUT_MS }
      );
      if (seq !== historySeqRef.current || activeUidRef.current !== targetUid) return;
      scrollIntentRef.current = { type: 'none' };
      setHistoryData((prev) => ({
        ...prev,
        messages: appendNewerHistory(prev.messages, res.messages || []),
        hasNewer: Boolean(res.hasNewer),
        newestCursor: res.newestCursor || prev.newestCursor,
      }));
    } catch (err) {
      if (seq === historySeqRef.current && activeUidRef.current === targetUid) {
        onToast(err.message || '加载更新消息失败');
      }
    } finally {
      historyInFlightRef.current -= 1;
      setLoadingNewer(false);
    }
  };

  const openMessageInChat = async (item) => {
    if (!d1Bound || !item?.uid) return;
    const targetUid = String(item.uid);
    const knownVisitor =
      visitors.find((v) => String(v.userId) === targetUid) ||
      item.visitor || {
        userId: targetUid,
        displayName: `用户 ${targetUid}`,
        username: '',
        status: 'pending',
      };

    activeUidRef.current = targetUid;
    const seq = ++historySeqRef.current;
    hasNewerRef.current = false;
    setActiveVisitor(knownVisitor);
    setNoteDraft(knownVisitor.note || '');
    setDrawerView('chat');
    setSenderFilter('all');
    setShowClearConfirm(false);
    setReplyText('');
    setReplyPhoto(null);
    setHighlightMsgId('');
    setHighlightQuery(submittedMsgQuery || msgQuery.trim());
    setHistoryData(EMPTY_HISTORY);
    setHistoryLoading(true);
    haptic('light');

    try {
      const res = await apiRequest(
        buildHistoryUrl(targetUid, { around: item.id, limit: HISTORY_PAGE_SIZE }),
        { timeoutMs: HISTORY_TIMEOUT_MS }
      );
      if (seq !== historySeqRef.current || activeUidRef.current !== targetUid) return;

      if (res.visitor) {
        setActiveVisitor(res.visitor);
        setNoteDraft(res.visitor.note || '');
      }
      setHistoryData({
        photos: res.photos || [],
        links: res.links || [],
        messages: res.messages || [],
        hasMore: Boolean(res.hasMore),
        hasNewer: Boolean(res.hasNewer),
        oldestCursor: res.oldestCursor || null,
        newestCursor: res.newestCursor || null,
      });

      if (res.aroundFound === false) {
        scrollIntentRef.current = { type: 'bottom' };
        onToast('该条消息已撤回或已清理，已为你展示最新对话');
      } else {
        setHighlightMsgId(item.id);
        scrollIntentRef.current = { type: 'target', msgId: item.id };
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => {
          setHighlightMsgId((cur) => (cur === item.id ? '' : cur));
        }, 4500);
      }
    } catch (err) {
      if (seq === historySeqRef.current && activeUidRef.current === targetUid) {
        onToast(err.message || '定位消息失败');
      }
    } finally {
      if (seq === historySeqRef.current) {
        setHistoryLoading(false);
      }
    }
  };

  const openDetail = (v) => {
    activeUidRef.current = String(v?.userId || '');
    historySeqRef.current += 1;
    hasNewerRef.current = false;
    setActiveVisitor(v);
    setNoteDraft(v.note || '');
    setDrawerView('profile');
    setSenderFilter('all');
    setShowClearConfirm(false);
    setReplyText('');
    setReplyPhoto(null);
    setHighlightMsgId('');
    setHighlightQuery('');
    setHistoryData(EMPTY_HISTORY);
    haptic('light');
  };

  const clearReplyPhoto = () => {
    setReplyPhoto(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const closeDetail = () => {
    activeUidRef.current = '';
    historySeqRef.current += 1;
    hasNewerRef.current = false;
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setActiveVisitor(null);
    setDrawerView('profile');
    setShowClearConfirm(false);
    setLightboxPhoto(null);
    setReplyText('');
    setReplyPhoto(null);
    setHighlightMsgId('');
    setHighlightQuery('');
  };

  // Controlled scroll positioning:
  //   - 'bottom': snap to newest message (initial open, send reply, return to latest, or new tail arrival near bottom)
  //   - 'preserve-top': keep exact visual position when older messages are prepended above
  //   - 'target': smoothly center the jumped-to search hit bubble
  useLayoutEffect(() => {
    if (drawerView !== 'chat') return;
    const intent = scrollIntentRef.current;
    const el = chatStreamRef.current;
    if (!el || !intent || intent.type === 'none') return;

    if (intent.type === 'preserve-top') {
      const delta = el.scrollHeight - (intent.prevScrollHeight || 0);
      el.scrollTop = Math.max(0, (intent.prevScrollTop || 0) + delta);
      scrollIntentRef.current = { type: 'none' };
      return;
    }

    if (intent.type === 'target' && intent.msgId) {
      const targetNode = Array.from(el.querySelectorAll('[data-msg-id]')).find(
        (node) => node.getAttribute('data-msg-id') === intent.msgId
      );
      if (targetNode) {
        targetNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
        scrollIntentRef.current = { type: 'none' };
      }
      return;
    }

    if (intent.type === 'bottom') {
      el.scrollTop = el.scrollHeight;
      scrollIntentRef.current = { type: 'none' };
    }
  }, [drawerView, historyData.messages, pendingReplies.length, highlightMsgId]);

  const handleChatScroll = (e) => {
    if (!d1Bound) return;
    const el = e.currentTarget;
    if (el.scrollTop <= 48 && historyData.hasMore && !loadingOlder && !historyLoading) {
      loadOlderMessages();
    }
  };

  useEffect(() => {
    if (drawerView !== 'chat' || !activeVisitor?.userId || historyData.hasNewer) return undefined;
    const uid = activeVisitor.userId;
    const iv = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        loadVisitorHistory(uid, { silent: true });
      }
    }, 6000);
    // Coming back from Telegram (e.g. after reading the visitor's reply in a notification):
    // refresh right away instead of waiting for the next poll tick.
    const refreshOnResume = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        loadVisitorHistory(uid, { silent: true, force: true });
      }
    };
    const tg = getTelegramWebApp();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refreshOnResume);
    tg?.onEvent?.('activated', refreshOnResume);
    return () => {
      clearInterval(iv);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refreshOnResume);
      tg?.offEvent?.('activated', refreshOnResume);
    };
  }, [drawerView, activeVisitor?.userId, historyData.hasNewer]);

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
        if (hasNewerRef.current) {
          // Owner replied while viewing an older `around` window: jump back to the latest page
          await loadVisitorHistory(uid, { silent: false });
        } else if (res.message) {
          scrollIntentRef.current = { type: 'bottom' };
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
    scrollIntentRef.current = { type: 'bottom' };
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

  const handleReview = async (action) => {
    if (!activeVisitor) return;
    try {
      setActionBusy(true);
      haptic(action === 'ban' ? 'warning' : 'success');
      const res = await apiRequest(`/api/admin/visitors/${encodeURIComponent(activeVisitor.userId)}/review`, {
        method: 'POST',
        body: { action },
      });
      if (res.visitor) {
        setActiveVisitor(res.visitor);
      }
      if (res.alreadyHandled) {
        onToast('该访客的待审核消息已处理');
      } else if (action === 'approve') {
        onToast(`✅ 已放行并补发 ${res.deliveredCount || 0} 条消息`);
      } else {
        onToast('🚫 已拉黑该访客');
      }
      loadList(search, filter);
    } catch (err) {
      onToast(err.message);
    } finally {
      setActionBusy(false);
    }
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
      setHistoryData(EMPTY_HISTORY);
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
      <div className="owner-stat-grid" style={{ marginBottom: 12 }}>
        <div className="owner-stat-tile rose" style={{ cursor: 'default' }}>
          <div className="owner-stat-label">
            <ShieldCheck size={13} /> 已拦截广告
          </div>
          <div className="owner-stat-value">
            <span className="owner-stat-num">{blockedSpamCount || 0}</span>
            <span className="owner-stat-unit">次（累计）</span>
          </div>
          <div className="owner-stat-sub">今日拦截 {blockedToday || 0} 次</div>
        </div>

        <div className="owner-stat-tile" style={{ cursor: 'default' }}>
          <div className="owner-stat-label">
            <Users size={13} /> 活跃访客
          </div>
          <div className="owner-stat-value">
            <span className="owner-stat-num">{stats.active || 0}</span>
            <span className="owner-stat-unit">位</span>
          </div>
          <div className="owner-stat-sub">
            信任 {stats.trusted || 0} · 封禁 {stats.banned || 0}
          </div>
        </div>
      </div>

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

      {d1Bound && (
        <div className="search-mode-bar" role="tablist" aria-label="访客视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={searchMode === 'visitors'}
            className={`search-mode-btn ${searchMode === 'visitors' ? 'active' : ''}`}
            onClick={() => {
              haptic('light');
              setSearchMode('visitors');
            }}
          >
            <Users size={14} /> 访客列表
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={searchMode === 'messages'}
            className={`search-mode-btn ${searchMode === 'messages' ? 'active' : ''}`}
            onClick={() => {
              haptic('light');
              setSearchMode('messages');
              setTimeout(() => msgSearchInputRef.current?.focus(), 40);
            }}
          >
            <Search size={14} /> 搜聊天记录
          </button>
        </div>
      )}

      {d1Bound && searchMode === 'messages' ? (
        <>
          <div className="search-box">
            <Search size={16} color="var(--text-muted)" />
            <input
              ref={msgSearchInputRef}
              value={msgQuery}
              maxLength={100}
              onChange={(e) => setMsgQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  runMessageSearch({ append: false });
                }
              }}
              placeholder="输入关键词按回车或点搜索…"
            />
            {msgQuery && (
              <button
                type="button"
                aria-label="清空搜索词"
                onClick={() => setMsgQuery('')}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              >
                <X size={15} />
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ padding: '4px 11px', height: 28, fontSize: 12, flexShrink: 0 }}
              disabled={msgSearching || !msgQuery.trim()}
              onClick={() => runMessageSearch({ append: false })}
            >
              搜索
            </button>
          </div>

          <div className="chip-row" style={{ marginBottom: msgTimeRange === 'custom' || msgUidFilter ? 8 : 10 }}>
            {[
              { id: '30d', label: '近 30 天' },
              { id: '7d', label: '近 7 天' },
              { id: 'all', label: '全部时间' },
              { id: 'custom', label: '自定义日期' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chip ${msgTimeRange === item.id ? 'active' : ''}`}
                onClick={() => {
                  setMsgTimeRange(item.id);
                  if (item.id !== 'custom' && msgHasSearched && msgQuery.trim()) {
                    runMessageSearch({ append: false, timeRangeOverride: item.id });
                  }
                }}
              >
                {item.id === 'custom' && <Calendar size={12} style={{ marginRight: 4, verticalAlign: -1 }} />}
                {item.label}
              </button>
            ))}
          </div>

          {msgTimeRange === 'custom' && (
            <div className="search-date-row">
              <input
                type="date"
                className="input search-date-input"
                aria-label="开始日期"
                value={msgDateFrom}
                onChange={(e) => setMsgDateFrom(e.target.value)}
              />
              <span className="search-date-sep">至</span>
              <input
                type="date"
                className="input search-date-input"
                aria-label="结束日期"
                value={msgDateTo}
                onChange={(e) => setMsgDateTo(e.target.value)}
              />
            </div>
          )}

          <div className="search-filter-row">
            <select
              className="input search-visitor-select"
              aria-label="按访客筛选"
              value={msgUidFilter}
              onChange={(e) => {
                const nextUid = e.target.value;
                setMsgUidFilter(nextUid);
                const found = visitors.find((v) => String(v.userId) === nextUid);
                setMsgUidLabel(found ? found.displayName : '');
                if (msgHasSearched && msgQuery.trim()) {
                  runMessageSearch({ append: false, uidOverride: nextUid });
                }
              }}
            >
              <option value="">全部访客</option>
              {msgUidFilter && !visitors.some((v) => String(v.userId) === msgUidFilter) && (
                <option value={msgUidFilter}>{msgUidLabel || `UID ${msgUidFilter}`}</option>
              )}
              {visitors.map((v) => (
                <option key={v.userId} value={v.userId}>
                  {v.displayName}
                  {v.username ? ` (@${v.username})` : ''}
                </option>
              ))}
            </select>
            {msgUidFilter && (
              <button
                type="button"
                className="btn btn-subtle btn-sm"
                style={{ flexShrink: 0 }}
                onClick={() => {
                  setMsgUidFilter('');
                  setMsgUidLabel('');
                  if (msgHasSearched && msgQuery.trim()) {
                    runMessageSearch({ append: false, uidOverride: '' });
                  }
                }}
              >
                <X size={13} /> 清除访客
              </button>
            )}
          </div>

          {!msgUidFilter && unmigratedVisitorsCount > 0 && (
            <div className="search-migrate-hint">
              <span>
                尚有 <b>{unmigratedVisitorsCount}</b> 位老访客未迁入 D1，暂不参与跨访客全局搜索
              </span>
              {onOpenSettings && (
                <button
                  type="button"
                  className="search-inline-link"
                  onClick={() => onOpenSettings('update')}
                >
                  <Database size={11} /> 去一键迁移
                </button>
              )}
            </div>
          )}

          {msgSearchError && (
            <div className="card" style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>
              ⚠️ {msgSearchError}
            </div>
          )}

          {!msgHasSearched && !msgSearching ? (
            <div className="card empty-state">
              <div style={{ fontSize: 26, marginBottom: 6 }}>🔍</div>
              <div style={{ fontWeight: 600, color: 'var(--text)' }}>检索 D1 聊天记录</div>
              <div style={{ marginTop: 6, lineHeight: 1.55 }}>
                输入关键词后按回车或点「搜索」即可查询（默认先搜近 30 天，可切换全部时间），点击结果直接定位到对应气泡。
              </div>
              {onOpenSettings && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-muted)' }}>
                  老访客需打开过聊天或在{' '}
                  <button
                    type="button"
                    className="search-inline-link"
                    onClick={() => onOpenSettings('update')}
                  >
                    <Database size={11} /> 数据存储
                  </button>{' '}
                  点过「一键迁移」才会被检索到
                </div>
              )}
            </div>
          ) : msgSearching ? (
            <div className="card empty-state">
              <RefreshCw size={20} className="spin" color="var(--accent)" />
              <div style={{ marginTop: 8 }}>正在搜索聊天记录…</div>
            </div>
          ) : msgHasSearched && msgResults.length === 0 ? (
            <div className="card empty-state">
              <div style={{ fontSize: 26, marginBottom: 6 }}>🪹</div>
              <div>未找到包含「{submittedMsgQuery || msgQuery.trim()}」的聊天记录</div>
              <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
                可尝试切换到「全部时间」或清除访客筛选；若部分老访客尚未迁移到 D1，可前往{' '}
                {onOpenSettings ? (
                  <button
                    type="button"
                    className="search-inline-link"
                    onClick={() => onOpenSettings('update')}
                  >
                    数据存储一键迁移
                  </button>
                ) : (
                  '设置 → 版本更新 → 数据存储'
                )}
                。
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="search-result-head">
                <span>
                  找到 {msgResults.length}
                  {msgHasMore ? '+' : ''} 条匹配消息
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>点击跳转定位</span>
              </div>
              {msgResults.map((item) => {
                const vInfo = item.visitor || { userId: item.uid, displayName: `用户 ${item.uid}` };
                const snippetText = item.text || item.mediaTag || (item.hasPhoto ? '[图片]' : item.hasSticker ? '[贴纸]' : '[消息]');
                return (
                  <div
                    key={`${item.uid}:${item.id}`}
                    className="list-row search-hit-row"
                    style={{ cursor: 'pointer' }}
                    onClick={() => openMessageInChat(item)}
                  >
                    <Avatar userId={vInfo.userId} name={vInfo.displayName} size="sm" />
                    <div className="row-main">
                      <div className="row-title" style={{ fontSize: 13 }}>
                        <span
                          style={{
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {vInfo.displayName}
                        </span>
                        <span
                          className={`pill ${item.sender === 'admin' ? 'rose' : ''}`}
                          style={{ padding: '1px 7px', fontSize: 10 }}
                        >
                          {item.sender === 'admin' ? '我' : '对方'}
                        </span>
                        {item.hasPhoto && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>🖼️</span>
                        )}
                      </div>
                      <div className="search-hit-snippet">
                        {renderHighlightedText(snippetText, submittedMsgQuery || msgQuery.trim())}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 11, color: 'var(--text-muted)' }}>
                      {formatTimeAgo(item.at)}
                    </div>
                  </div>
                );
              })}

              {msgHasMore && msgNextCursor && (
                <div style={{ paddingTop: 10 }}>
                  <button
                    type="button"
                    className="btn btn-subtle btn-sm btn-block"
                    disabled={msgLoadingMore}
                    onClick={() =>
                      runMessageSearch({
                        append: true,
                        cursor: msgNextCursor,
                        queryOverride: submittedMsgQuery || msgQuery,
                      })
                    }
                  >
                    {msgLoadingMore ? (
                      <>
                        <RefreshCw size={13} className="spin" /> 加载更多结果…
                      </>
                    ) : (
                      '加载更多搜索结果'
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
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
              { id: 'pending', label: '待审核', count: stats.pendingReview || 0, isPending: true },
              { id: 'active', label: `活跃 ${stats.active}` },
              { id: 'trusted', label: `信任 ${stats.trusted}` },
              { id: 'banned', label: `已拉黑 ${stats.banned}` },
              { id: 'closed', label: `已结单 ${stats.closed}` },
            ].map((item) => (
              <button
                key={item.id}
                className={`chip ${filter === item.id ? 'active' : ''}`}
                style={item.isPending ? { display: 'inline-flex', alignItems: 'center', gap: 5 } : undefined}
                onClick={() => setFilter(item.id)}
              >
                <span>{item.label}</span>
                {item.isPending && (
                  <span className={`chip-badge ${item.count > 0 ? 'alert' : ''}`}>
                    {item.count}
                  </span>
                )}
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
                        {v.pendingReview?.length > 0 && (
                          <span className="pill red" style={{ padding: '2px 7px', fontSize: 10 }}>
                            待审核 {v.pendingReview.length}
                          </span>
                        )}
                      </div>
                      <div className="row-desc">
                        {v.note
                          ? `📝 ${v.note}`
                          : v.last_preview ||
                            v.pendingReview?.[v.pendingReview.length - 1]?.preview ||
                            (v.username ? `@${v.username}` : `UID ${v.userId}`)}
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
        </>
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
                {drawerView === 'chat' && d1Bound && (
                  <button
                    className="icon-btn"
                    title="搜索与 TA 的聊天记录"
                    onClick={() => {
                      const targetUid = String(activeVisitor.userId);
                      const targetName = activeVisitor.displayName;
                      closeDetail();
                      setSearchMode('messages');
                      setMsgUidFilter(targetUid);
                      setMsgUidLabel(targetName);
                      setTimeout(() => msgSearchInputRef.current?.focus(), 60);
                    }}
                  >
                    <Search size={14} />
                  </button>
                )}
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
                <div className="chat-stream" ref={chatStreamRef} onScroll={handleChatScroll}>
                  {d1Bound && historyData.messages.length > 0 && (
                    <div className="chat-history-top">
                      {historyData.hasMore ? (
                        <button
                          type="button"
                          className="chat-history-pill"
                          disabled={loadingOlder || historyLoading}
                          onClick={loadOlderMessages}
                        >
                          {loadingOlder ? (
                            <>
                              <RefreshCw size={12} className="spin" /> 正在加载更早消息…
                            </>
                          ) : (
                            <>
                              <ArrowUp size={12} /> 加载更早消息
                            </>
                          )}
                        </button>
                      ) : (
                        <span className="chat-history-end">已显示全部历史消息</span>
                      )}
                    </div>
                  )}

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
                      const isStickerBubble = Boolean(m.stickerUrl && !m.text && !m.thumbUrl && !m.photoUrl);
                      const isHighlighted = Boolean(highlightMsgId && m.id === highlightMsgId);
                      return (
                        <div
                          key={m.id}
                          data-msg-id={m.id}
                          className={`chat-row ${isMe ? 'me' : 'them'} ${isHighlighted ? 'highlighted' : ''}`}
                        >
                          <div className={`chat-bubble ${isStickerBubble ? 'sticker-bubble' : ''}`}>
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
                            {m.stickerUrl ? (
                              <TgStickerMedia
                                src={m.stickerUrl}
                                format={m.stickerFormat || 'webp'}
                                size={120}
                                fallback={<div className="chat-sticker-fallback">{m.mediaTag || '[贴纸]'}</div>}
                              />
                            ) : m.text ? (
                              <div>
                                {isHighlighted && highlightQuery
                                  ? renderHighlightedText(m.text, highlightQuery)
                                  : m.text}
                              </div>
                            ) : m.mediaTag ? (
                              <div style={{ opacity: 0.85 }}>
                                {isHighlighted && highlightQuery
                                  ? renderHighlightedText(m.mediaTag, highlightQuery)
                                  : m.mediaTag}
                              </div>
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

                  {d1Bound && historyData.hasNewer && (
                    <div className="chat-history-bottom">
                      <button
                        type="button"
                        className="chat-history-pill"
                        disabled={loadingNewer || historyLoading}
                        onClick={loadNewerMessages}
                      >
                        {loadingNewer ? (
                          <>
                            <RefreshCw size={12} className="spin" /> 加载更新消息…
                          </>
                        ) : (
                          <>
                            <ArrowDown size={12} /> 加载更新消息
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        className="chat-history-pill primary"
                        disabled={historyLoading}
                        onClick={() => loadVisitorHistory(activeVisitor.userId, { silent: false })}
                      >
                        回到最新消息
                      </button>
                    </div>
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
                {Array.isArray(activeVisitor.pendingReview) && activeVisitor.pendingReview.length > 0 && (
                  <div className="card review-card">
                    <div className="review-card-head">
                      <span>🛡️ 新访客消息待审核（{activeVisitor.pendingReview.length} 条）</span>
                      <span className="review-card-hint">放行后按顺序补发</span>
                    </div>
                    <div className="review-item-list">
                      {activeVisitor.pendingReview.map((item, idx) => (
                        <div className="review-item" key={`${item.pmMessageId || idx}-${idx}`}>
                          <div className="review-item-meta">
                            <div className="review-reason-tags">
                              {(item.reasons || []).map((r) => (
                                <span key={r} className="pill amber" style={{ padding: '1px 7px', fontSize: 10 }}>
                                  {PROBATION_REASON_LABELS[r] || r}
                                </span>
                              ))}
                            </div>
                            <span className="review-item-time">
                              {formatTimeAgo(typeof item.at === 'number' ? new Date(item.at).toISOString() : item.at)}
                            </span>
                          </div>
                          <div className="review-item-text">{item.preview || '[消息]'}</div>
                        </div>
                      ))}
                    </div>
                    <div className="review-actions">
                      <button
                        type="button"
                        className="btn btn-success btn-block"
                        disabled={actionBusy}
                        onClick={() => handleReview('approve')}
                      >
                        ✅ 放行
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-block"
                        disabled={actionBusy}
                        onClick={() => handleReview('ban')}
                      >
                        🚫 拉黑
                      </button>
                    </div>
                  </div>
                )}

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
