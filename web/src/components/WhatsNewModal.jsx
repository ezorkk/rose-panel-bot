import React from 'react';
import { ExternalLink, Sparkles, Star, X } from 'lucide-react';
import { haptic, openExternalUrl } from '../lib/telegram.js';

export const REPO_URL = 'https://github.com/mango0114/rose-panel-bot';
// Verified against live GitHub README heading anchor: 🚀 极简部署（5 分钟免费上线）
export const DEPLOY_GUIDE_URL = `${REPO_URL}#${encodeURIComponent('-极简部署5-分钟免费上线')}`;
export const CHANGELOG_URL = 'https://github.com/mango0114/rose-panel-bot/blob/main/CHANGELOG.md';
export const SEEN_VERSION_STORAGE_KEY = 'rose_seen_version';
export const HIDE_STAR_STRIP_STORAGE_KEY = 'rose_hide_star_strip';

export const RECENT_RELEASES = [
  {
    version: '1.9.0',
    url: 'https://github.com/mango0114/rose-panel-bot/releases/tag/v1.9.0',
    items: [
      {
        tag: '新增',
        tone: 'new',
        text: 'Telegram 表情回应双向同步（访客私聊 ↔ 话题群 / Bot 私聊推送，取消同步消失），并在面板气泡下方展示双方回应',
      },
    ],
  },
  {
    version: '1.8.0',
    url: 'https://github.com/mango0114/rose-panel-bot/releases/tag/v1.8.0',
    items: [
      {
        tag: '新增',
        tone: 'new',
        text: '探针掉线 / 恢复与 CPU·内存·磁盘超限告警（默认关闭，在「设置 → 节点探针」一键开启，支持静音节点与测试告警）',
      },
      {
        tag: '新增',
        tone: 'new',
        text: '名片页新增「分享名片」一键生成浅/深色二维码海报与社交平台链接预览（仅含公开名片信息）',
      },
      {
        tag: '新增',
        tone: 'new',
        text: '访客来源追踪（src_<渠道名>）与设置页推广链接助手，在访客卡片与访客列表顶部查看各渠道来源统计',
      },
      {
        tag: '新增',
        tone: 'new',
        text: '按人去重的「本月访客数」统计（站长在访客页查看本月/上月人数，可按需开启在名片底部公开显示，默认关闭）',
      },
      {
        tag: '新增',
        tone: 'new',
        text: '名片底部新增 RosePanel 小字署名和「想要同款？」引导，可在设置里关闭',
      },
    ],
  },
  {
    version: '1.7.0',
    url: 'https://github.com/mango0114/rose-panel-bot/releases/tag/v1.7.0',
    items: [
      {
        tag: '新增',
        tone: 'new',
        text: '未绑定通知群时自动启用「Bot 私聊直推」，配好 ADMIN_IDS 即可收发私信、引用回复与使用管理指令，四层防骚扰与人机验证照常生效',
      },
      {
        tag: '改进',
        tone: 'imp',
        text: '随时在话题群发送 /bind 自动切回话题模式；在设置「防骚扰验证」顶部新增通知方式状态与未 /start 提醒',
      },
    ],
  },
  {
    version: '1.6.0',
    url: 'https://github.com/mango0114/rose-panel-bot/releases/tag/v1.6.0',
    items: [
      {
        tag: '新增',
        tone: 'new',
        text: '访客资料卡点开「聊过」直接在面板内看记录、打字、发图与撤回，自动同步通知群话题',
      },
      {
        tag: '新增',
        tone: 'new',
        text: '陌生人点 /start 或名片「发私信」立即触发人机验证，通过后直通私聊',
      },
      {
        tag: '新增',
        tone: 'new',
        text: '顶栏全新玫瑰瓷像素风「昼夜气泡放大镜滑块」，可拖动切换夜晚 / 跟随 TG / 白天主题',
      },
      {
        tag: '改进',
        tone: 'imp',
        text: '自动同步未点开始前介绍框与左下角面板菜单开关，开放免验证天数与话题 /del 撤回',
      },
      {
        tag: '修复',
        tone: 'fix',
        text: '加固验证刷新防刷上限、发图真实文件头校验，未保存退出改用原生确认框',
      },
    ],
  },
  {
    version: '1.5.4',
    url: 'https://github.com/mango0114/rose-panel-bot/releases/tag/v1.5.4',
    items: [
      {
        tag: '改进',
        tone: 'imp',
        text: '重写防脚本陷阱按钮文案，默认改为短暂冷却锁定防真人误触失联',
      },
      {
        tag: '修复',
        tone: 'fix',
        text: '自动找回早期版本拉黑记录支持一键解封，手动解封后豁免 CAS 重复拦截',
      },
    ],
  },
  {
    version: '1.5.0',
    url: 'https://github.com/mango0114/rose-panel-bot/releases/tag/v1.5.0',
    items: [
      {
        tag: '新增',
        tone: 'new',
        text: '免会员收到消息自动回复（防刷冷却）与最多 50 条关键词自动回复规则',
      },
      {
        tag: '改进',
        tone: 'imp',
        text: '通知群访客资料卡昵称支持一键直达主页，可选附带访客头像大图',
      },
    ],
  },
];

function compareSemver(a, b) {
  const pa = String(a || '')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => Number(n) || 0);
  const pb = String(b || '')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export function StarSupportBanner({ onDismiss = null, style = undefined }) {
  return (
    <div className="star-support-strip" style={style}>
      <div className="star-support-text">
        <Star size={16} fill="#F59E0B" color="#F59E0B" style={{ flexShrink: 0, marginTop: 1 }} />
        <span>如果 RosePanel 帮到了你，请在 GitHub 点个 Star，这对我们意义重大</span>
      </div>
      <div className="star-support-actions">
        <button
          type="button"
          className="star-support-btn"
          onClick={() => {
            haptic('light');
            openExternalUrl(REPO_URL);
          }}
        >
          <Star size={12.5} /> 去点 Star
        </button>
        {onDismiss && (
          <button
            type="button"
            className="star-support-close"
            title="不再提示"
            aria-label="关闭提示"
            onClick={onDismiss}
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export default function WhatsNewModal({
  appVersion = '1.8.0',
  previousVersion = '',
  mode = 'auto',
  onClose,
}) {
  const currentVer = String(appVersion || RECENT_RELEASES[0].version).replace(/^v/i, '');
  const hasOlderPrev =
    Boolean(previousVersion) && compareSemver(currentVer, previousVersion) > 0;

  let releasesToShow = RECENT_RELEASES;
  if (mode === 'auto' && hasOlderPrev) {
    const newer = RECENT_RELEASES.filter((r) => compareSemver(r.version, previousVersion) > 0);
    releasesToShow = newer.length > 0 ? newer : RECENT_RELEASES.slice(0, 2);
  } else if (mode === 'auto') {
    releasesToShow = RECENT_RELEASES.slice(0, 2);
  }

  return (
    <div className="whatsnew-backdrop" onClick={onClose}>
      <div
        className="whatsnew-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`已更新到 v${currentVer}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="whatsnew-head">
          <div className="whatsnew-title">
            <Sparkles size={18} color="var(--accent)" style={{ flexShrink: 0 }} />
            <span>{mode === 'manual' ? `近期更新 · v${currentVer}` : `已更新到 v${currentVer}`}</span>
          </div>
          <div className="whatsnew-sub">
            {hasOlderPrev ? `自 v${previousVersion.replace(/^v/i, '')} 以来的更新` : '近期版本核心更新一览'}
          </div>
        </div>

        <div className="whatsnew-body">
          {releasesToShow.map((rel) => (
            <div className="whatsnew-ver-block" key={rel.version}>
              <div className="whatsnew-ver-head">
                <span className="whatsnew-ver-name">v{rel.version}</span>
                <button
                  type="button"
                  className="whatsnew-ver-link"
                  onClick={() => openExternalUrl(rel.url)}
                >
                  详情 <ExternalLink size={11} />
                </button>
              </div>
              <div className="whatsnew-items">
                {rel.items.map((it, idx) => (
                  <div className="whatsnew-item" key={idx}>
                    <span className={`whatsnew-tag ${it.tone || ''}`}>{it.tag}</span>
                    <span className="whatsnew-item-text">{it.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="whatsnew-foot">
          <button
            type="button"
            className="btn btn-subtle btn-sm"
            onClick={() => openExternalUrl(CHANGELOG_URL)}
          >
            查看完整更新内容
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              haptic('light');
              onClose();
            }}
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
