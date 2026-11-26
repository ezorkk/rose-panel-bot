import React, { useEffect, useRef, useState } from 'react';

export function Avatar({ src, userId, name = 'R', size = '' }) {
  const [failed, setFailed] = useState(false);
  const resolvedSrc = src || (userId ? `/api/avatar/${userId}` : '');
  const initials = (String(name || '').trim().replace(/^@+/, '') || 'R').slice(0, 1).toUpperCase();

  useEffect(() => {
    setFailed(false);
  }, [resolvedSrc]);

  return (
    <div className={`avatar-circle ${size}`}>
      {resolvedSrc && !failed ? (
        <img src={resolvedSrc} alt={name} onError={() => setFailed(true)} />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}

/**
 * Renders a Telegram animated vector sticker (.tgs decompressed to Lottie JSON by Worker edge)
 */
export function LottieSticker({ src, size = 60, fallback = '🌸' }) {
  const containerRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let anim = null;
    let cancelled = false;
    setFailed(false);

    (async () => {
      try {
        const [res, lottieMod] = await Promise.all([
          fetch(src),
          import('lottie-web/build/player/lottie_light'),
        ]);
        if (!res.ok) throw new Error('load failed');
        const animationData = await res.json();
        if (cancelled || !containerRef.current) return;
        const lottie = lottieMod.default || lottieMod;
        anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData,
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      anim?.destroy?.();
    };
  }, [src]);

  if (failed) {
    if (React.isValidElement(fallback)) {
      return fallback;
    }
    return (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.round(size * 0.52),
        }}
      >
        {fallback}
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: size, height: size, flexShrink: 0 }} />;
}

/**
 * Renders any single Telegram Sticker (static WebP, video WebM, or animated TGS Lottie).
 * Accepts either a public `fileId` (for badge emblems) or an explicit signed `src` URL (for private chat stickers).
 */
export function TgStickerMedia({
  fileId = '',
  src: explicitSrc = '',
  format = 'webp',
  size = 60,
  emoji = '🌸',
  fallback = null,
  previewOnly = false,
}) {
  const [failed, setFailed] = useState(false);
  const src = explicitSrc || (fileId ? `/api/sticker/${encodeURIComponent(fileId)}` : '');

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    if (fallback !== null) {
      return fallback;
    }
    return (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.round(size * 0.5),
        }}
      >
        {emoji || '🌸'}
      </div>
    );
  }

  if (format === 'tgs') {
    return <LottieSticker src={src} size={size} fallback={fallback !== null ? fallback : emoji || '✨'} />;
  }

  if (format === 'webm') {
    return (
      <video
        src={src}
        autoPlay={!previewOnly}
        loop
        muted
        playsInline
        onError={() => setFailed(true)}
        style={{ width: size, height: size, objectFit: 'contain', display: 'block', borderRadius: 10 }}
      />
    );
  }

  return (
    <img
      src={src}
      alt={emoji || 'badge'}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: size, height: size, objectFit: 'contain', display: 'block' }}
    />
  );
}

/**
 * Universal Ticket Emblem renderer: supports Built-in Rose SVGs, Telegram Stickers/Custom Emojis, and Image URLs
 */
export function TicketEmblem({ emblem, size = 62 }) {
  const [urlFailed, setUrlFailed] = useState(false);

  if (emblem?.type === 'tg_sticker' && emblem?.fileId) {
    return (
      <TgStickerMedia
        fileId={emblem.fileId}
        format={emblem.format || 'webp'}
        emoji={emblem.emoji || '🌸'}
        size={size}
      />
    );
  }

  if (emblem?.type === 'url' && emblem?.url && !urlFailed) {
    return (
      <img
        src={emblem.url}
        alt="emblem"
        onError={() => setUrlFailed(true)}
        style={{ width: size, height: size, objectFit: 'contain', display: 'block', borderRadius: 12 }}
      />
    );
  }

  return <StubEmblem variant={emblem?.variant || 'owner'} size={size} />;
}

/**
 * Hand-crafted rose-crystal emblem inspired by RoseveilBot's right ticket-stub illustration
 */
export function StubEmblem({ variant = 'bottle', size = 56 }) {
  if (variant === 'crown') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="roseCrown" x1="10" y1="12" x2="54" y2="54" gradientUnits="userSpaceOnUse">
            <stop stopColor="#F7C2D5" />
            <stop offset="0.55" stopColor="#D7608B" />
            <stop offset="1" stopColor="#8F2248" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="28" fill="#A32952" fillOpacity="0.08" />
        <path
          d="M14 44L18 22L28 31L32 17L36 31L46 22L50 44H14Z"
          fill="url(#roseCrown)"
          stroke="#9B264F"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <rect x="15" y="45" width="34" height="5" rx="2.5" fill="#B53864" />
        <circle cx="32" cy="14" r="3" fill="#F5A4C0" />
        <circle cx="17" cy="19" r="2.5" fill="#F5A4C0" />
        <circle cx="47" cy="19" r="2.5" fill="#F5A4C0" />
      </svg>
    );
  }

  if (variant === 'petal' || variant === 'owner') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="rosePetalA" x1="16" y1="10" x2="50" y2="52" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FFD9E6" />
            <stop offset="0.5" stopColor="#DF6D96" />
            <stop offset="1" stopColor="#9A244D" />
          </linearGradient>
          <linearGradient id="rosePetalB" x1="48" y1="14" x2="20" y2="50" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FFF0F5" />
            <stop offset="1" stopColor="#C84673" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="27" fill="#A32952" fillOpacity="0.08" />
        <path
          d="M32 13C40 13 48 21 48 31C48 41 40 49 32 49C24 49 16 41 16 31C16 21 24 13 32 13Z"
          fill="url(#rosePetalA)"
          fillOpacity="0.26"
        />
        <path
          d="M32 15C37 21 40 27 38 35C36 42 32 47 32 47C32 47 28 42 26 35C24 27 27 21 32 15Z"
          fill="url(#rosePetalA)"
        />
        <path
          d="M21 24C28 24 34 29 36 37C30 39 24 37 21 31C19 28 19 25 21 24Z"
          fill="url(#rosePetalB)"
          fillOpacity="0.9"
        />
        <path
          d="M43 24C36 24 30 29 28 37C34 39 40 37 43 31C45 28 45 25 43 24Z"
          fill="url(#rosePetalB)"
          fillOpacity="0.82"
        />
        <path d="M46 15L47.2 18.2L50.5 19.5L47.2 20.8L46 24L44.8 20.8L41.5 19.5L44.8 18.2L46 15Z" fill="#E892B0" />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="bottleGlass" x1="18" y1="20" x2="46" y2="54" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFF5F8" />
          <stop offset="0.45" stopColor="#F5C3D6" />
          <stop offset="1" stopColor="#B94B75" />
        </linearGradient>
        <linearGradient id="bottleLiquid" x1="22" y1="32" x2="42" y2="50" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F8D8B0" />
          <stop offset="0.55" stopColor="#E67FA3" />
          <stop offset="1" stopColor="#9C2650" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="34" r="26" fill="#A32952" fillOpacity="0.08" />
      <rect x="26" y="11" width="12" height="6" rx="2.5" fill="#C48AB5" />
      <rect x="24" y="17" width="16" height="4" rx="2" fill="#E5B7D1" />
      <path
        d="M27 21H37L44 31C46.5 34.5 46.5 40 43.5 44.5C40.5 49 36.5 51 32 51C27.5 51 23.5 49 20.5 44.5C17.5 40 17.5 34.5 20 31L27 21Z"
        fill="url(#bottleGlass)"
        stroke="#B04870"
        strokeWidth="1.4"
      />
      <path
        d="M21.5 36C25 34 29 37 33 35.5C37 34 40 35 42.5 36.5C43 40 41.5 43.5 39 46C36.8 48.2 34.5 49 32 49C29.5 49 27.2 48.2 25 46C22.5 43.5 21 40 21.5 36Z"
        fill="url(#bottleLiquid)"
      />
      <path d="M32 32L33.5 36L37.5 37.5L33.5 39L32 43L30.5 39L26.5 37.5L30.5 36L32 32Z" fill="#FFF8E8" />
      <path d="M16 18L17 20.5L19.5 21.5L17 22.5L16 25L15 22.5L12.5 21.5L15 20.5L16 18Z" fill="#DDA0BD" />
    </svg>
  );
}
