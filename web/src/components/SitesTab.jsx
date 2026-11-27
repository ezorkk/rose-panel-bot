import React, { useMemo, useState } from 'react';
import { Copy, ExternalLink, Eye, EyeOff, Globe, Lock, Plus, Search, X } from 'lucide-react';
import { apiRequest } from '../lib/api.js';
import { copyText, haptic, openExternalUrl } from '../lib/telegram.js';

export default function SitesTab({ sites = [], isAdmin, onOpenSettings, onSitesUpdated, onToast }) {
  const [selectedCat, setSelectedCat] = useState('全部');
  const [visFilter, setVisFilter] = useState('all'); // all | public | private (admin only)
  const [search, setSearch] = useState('');
  const [togglingId, setTogglingId] = useState('');

  const counts = useMemo(() => {
    const priv = sites.filter((s) => s.visibility === 'private').length;
    return { total: sites.length, public: sites.length - priv, private: priv };
  }, [sites]);

  const categories = useMemo(() => {
    const cats = new Set();
    sites.forEach((s) => {
      if (isAdmin && visFilter === 'public' && s.visibility === 'private') return;
      if (isAdmin && visFilter === 'private' && s.visibility !== 'private') return;
      if (s.category) cats.add(s.category);
    });
    return ['全部', ...Array.from(cats)];
  }, [sites, isAdmin, visFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sites.filter((s) => {
      const isPriv = s.visibility === 'private';
      if (isAdmin) {
        if (visFilter === 'public' && isPriv) return false;
        if (visFilter === 'private' && !isPriv) return false;
      } else if (isPriv) {
        return false;
      }
      if (selectedCat !== '全部' && s.category !== selectedCat) return false;
      if (q) {
        const hay = `${s.name} ${s.description} ${s.url} ${s.category} ${s.badge}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sites, isAdmin, visFilter, selectedCat, search]);

  const hostnameOf = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };

  const handleToggleVisibility = async (site) => {
    try {
      setTogglingId(site.id);
      haptic('light');
      const nextVis = site.visibility === 'private' ? 'public' : 'private';
      const res = await apiRequest('/api/admin/sites/toggle', {
        method: 'POST',
        body: { id: site.id, visibility: nextVis },
      });
      onSitesUpdated?.(res);
      onToast(nextVis === 'private' ? `🔒「${site.name}」已隐藏（仅你可见）` : `🌐「${site.name}」已设为公开可见`);
    } catch (err) {
      onToast(err.message);
    } finally {
      setTogglingId('');
    }
  };

  return (
    <>
      {/* Search bar when admin manages bookmarks or when there are 4+ sites */}
      {(isAdmin || sites.length >= 4) && (
        <div className="search-box">
          <Search size={15} color="var(--text-muted)" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAdmin ? '搜索公开小站或私密常用书签…' : '搜索站点名称或介绍…'}
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
      )}

      {/* Admin Visibility Filter Bar */}
      {isAdmin && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              className={`pill ${visFilter === 'all' ? 'rose' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setVisFilter('all');
                setSelectedCat('全部');
              }}
            >
              全部 {counts.total}
            </button>
            <button
              className={`pill ${visFilter === 'public' ? 'green' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setVisFilter('public');
                setSelectedCat('全部');
              }}
            >
              <Globe size={11} /> 公开 {counts.public}
            </button>
            <button
              className={`pill ${visFilter === 'private' ? 'amber' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setVisFilter('private');
                setSelectedCat('全部');
              }}
            >
              <Lock size={11} /> 仅我可见 {counts.private}
            </button>
          </div>

          <button
            className="btn btn-soft btn-sm"
            style={{ flexShrink: 0 }}
            onClick={() => onOpenSettings('sites')}
          >
            <Plus size={14} /> 管理
          </button>
        </div>
      )}

      {/* Category Chips */}
      {categories.length > 2 && (
        <div className="chip-row">
          {categories.map((cat) => (
            <button
              key={cat}
              className={`chip ${selectedCat === cat ? 'active' : ''}`}
              onClick={() => setSelectedCat(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card empty-state">
          <div style={{ fontSize: 28, marginBottom: 8 }}>
            {visFilter === 'private' ? '🔒' : '🌐'}
          </div>
          <div>
            {search
              ? '未找到匹配的站点'
              : visFilter === 'private'
                ? '还没有私密隐藏的常用网站'
                : '还没有添加个人小站'}
          </div>
          {isAdmin && !search && (
            <button
              className="btn btn-primary btn-sm"
              style={{ marginTop: 12 }}
              onClick={() => onOpenSettings('sites')}
            >
              去添加站点
            </button>
          )}
        </div>
      ) : (
        <div className="card">
          {filtered.map((site) => {
            const isPriv = site.visibility === 'private';
            return (
              <div className="list-row" key={site.id || site.url}>
                <div className="row-icon-box">{site.icon || '🌐'}</div>
                <div
                  className="row-main"
                  style={{ cursor: 'pointer' }}
                  onClick={() => openExternalUrl(site.url)}
                >
                  <div className="row-title" style={{ flexWrap: 'wrap' }}>
                    <span>{site.name}</span>
                    {site.badge && <span className="pill rose" style={{ padding: '2px 8px', fontSize: 11 }}>{site.badge}</span>}
                    {isAdmin && isPriv && (
                      <span className="pill amber" style={{ padding: '2px 7px', fontSize: 10 }}>
                        <Lock size={10} /> 仅我可见
                      </span>
                    )}
                  </div>
                  {site.description && <div className="row-desc">{site.description}</div>}
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {hostnameOf(site.url)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                  {isAdmin && (
                    <button
                      className={`icon-btn ${isPriv ? 'accent' : ''}`}
                      title={isPriv ? '当前仅自己可见，点击设为公开' : '当前公开可见，点击设为隐藏'}
                      disabled={togglingId === site.id}
                      onClick={() => handleToggleVisibility(site)}
                    >
                      {isPriv ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    title="复制链接"
                    onClick={async () => {
                      const ok = await copyText(site.url);
                      onToast(ok ? '已复制站点链接' : '复制失败');
                    }}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    className="btn btn-soft btn-sm"
                    onClick={() => openExternalUrl(site.url)}
                  >
                    访问 <ExternalLink size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
