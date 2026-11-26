import React, { useEffect } from 'react';
import { Clock, Copy, ExternalLink, IdCard, Server, ShieldCheck, X } from 'lucide-react';
import { copyText, haptic, openExternalUrl } from '../lib/telegram.js';
import { DEPLOY_GUIDE_URL } from './WhatsNewModal.jsx';

const HIGHLIGHTS = [
  { icon: IdCard, text: '玫瑰瓷风格的个人名片和分享海报' },
  { icon: ShieldCheck, text: '带四层防骚扰的私信助手' },
  { icon: Server, text: '支持 Komari、哪吒等探针的节点面板' },
];

export default function GetSameCardModal({ onClose, onToast }) {
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleOpenGuide = () => {
    haptic('medium');
    openExternalUrl(DEPLOY_GUIDE_URL);
  };

  const handleCopyGuide = async () => {
    const ok = await copyText(DEPLOY_GUIDE_URL);
    onToast?.(ok ? '已复制，可以在电脑上打开' : '复制失败');
  };

  return (
    <div className="whatsnew-backdrop" onClick={onClose}>
      <div
        className="whatsnew-modal"
        role="dialog"
        aria-modal="true"
        aria-label="做一张属于你的名片"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="whatsnew-head get-same-head">
          <div className="whatsnew-title">
            <span>🌹 做一张属于你的名片</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="whatsnew-body get-same-body">
          <p className="get-same-intro">
            在 Telegram 里拥有自己的个人名片、私信助手和节点探针，免费部署在 Cloudflare 上。
          </p>

          <div className="get-same-highlights">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <div className="get-same-highlight-row" key={text}>
                <span className="get-same-icon">
                  <Icon size={15} />
                </span>
                <span>{text}</span>
              </div>
            ))}
          </div>

          <div className="get-same-box">
            <div className="get-same-box-title">需要准备</div>
            <div className="get-same-box-text">
              一个 Telegram 账号、一个免费的 Cloudflare 账号、一个 GitHub 账号。
            </div>
            <div className="get-same-box-bold">不需要服务器，也不用写代码</div>
          </div>

          <div className="get-same-eta">
            <Clock size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
            <span>大概需要：约 10 分钟，建议在电脑上操作。</span>
          </div>
        </div>

        <div className="whatsnew-foot get-same-foot">
          <button
            type="button"
            className="btn btn-soft btn-sm"
            onClick={handleCopyGuide}
          >
            <Copy size={13} /> 复制教程链接
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleOpenGuide}
          >
            查看部署教程 <ExternalLink size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
