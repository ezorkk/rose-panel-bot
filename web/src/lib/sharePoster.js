// Client-side Canvas 2D share poster generator (1080px wide; height follows the card content,
// about 1120px for a sparse card up to about 1370px with handle, 3-line tagline and 2 tag rows).
// Uses dynamic import('qrcode-generator') so QR code generation never bloats the initial bundle.

import { BRAND_NAME, BRAND_SIGNATURE } from './brand.js';

export const POSTER_WIDTH = 1080;
// Canvas height used only while measuring; the final height is computed from the content.
const MEASURE_HEIGHT = 1350;
const SIGNATURE_FONT_PX = 22;
const SIGNATURE_ALPHA = 0.55;
const SIGNATURE_BOTTOM_OFFSET = 40;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

function readThemePalette() {
  const isDark =
    typeof document !== 'undefined' &&
    document.documentElement?.getAttribute('data-theme') === 'dark';

  const fallback = isDark
    ? {
        bg: '#141012',
        bgElevated: '#1f181b',
        bgSubtle: '#2a2024',
        text: '#f7eef1',
        textSecondary: '#b9a6ae',
        textMuted: '#84727a',
        accent: '#e56b92',
        accentSoft: 'rgba(229, 107, 146, 0.15)',
        accentLine: 'rgba(229, 107, 146, 0.24)',
        border: 'rgba(255, 224, 235, 0.10)',
      }
    : {
        bg: '#faf4f5',
        bgElevated: '#ffffff',
        bgSubtle: '#f6ecef',
        text: '#1e1619',
        textSecondary: '#6f5f66',
        textMuted: '#9f8f96',
        accent: '#a32952',
        accentSoft: '#fae9ee',
        accentLine: 'rgba(163, 41, 82, 0.16)',
        border: 'rgba(163, 41, 82, 0.09)',
      };

  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return { ...fallback, isDark };
  }

  const cs = getComputedStyle(document.documentElement);
  const pickVar = (name, fb) => cs.getPropertyValue(name)?.trim() || fb;

  return {
    isDark,
    bg: pickVar('--bg', fallback.bg),
    bgElevated: pickVar('--bg-elevated', fallback.bgElevated),
    bgSubtle: pickVar('--bg-subtle', fallback.bgSubtle),
    text: pickVar('--text', fallback.text),
    textSecondary: pickVar('--text-secondary', fallback.textSecondary),
    textMuted: pickVar('--text-muted', fallback.textMuted),
    accent: pickVar('--accent', fallback.accent),
    accentSoft: pickVar('--accent-soft', fallback.accentSoft),
    accentLine: pickVar('--accent-line', fallback.accentLine),
    border: pickVar('--border', fallback.border),
  };
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function truncateLine(ctx, text, maxWidth) {
  const clean = String(text || '');
  if (ctx.measureText(clean).width <= maxWidth) return clean;
  const chars = Array.from(clean);
  let out = '';
  for (const ch of chars) {
    if (ctx.measureText(`${out}${ch}…`).width > maxWidth) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

function wrapTextLines(ctx, text, maxWidth, maxLines = 3) {
  const clean = String(text || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const chars = Array.from(clean);
  const lines = [];
  let current = '';

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const next = current + ch;
    if (ctx.measureText(next).width <= maxWidth) {
      current = next;
      continue;
    }

    if (lines.length === maxLines - 1) {
      lines.push(truncateLine(ctx, current + chars.slice(i).join(''), maxWidth));
      return lines;
    }

    // Prefer breaking at last ASCII space for English phrases without splitting mid-word
    const lastSpace = current.lastIndexOf(' ');
    if (lastSpace > 0 && /[A-Za-z0-9]/.test(ch)) {
      lines.push(current.slice(0, lastSpace).trimEnd());
      current = current.slice(lastSpace + 1) + ch;
    } else {
      lines.push(current.trimEnd());
      current = ch === ' ' ? '' : ch;
    }
  }

  if (current.trim()) {
    lines.push(current.trim());
  }
  return lines.slice(0, maxLines);
}

function isSameOriginUrl(url) {
  if (!url) return false;
  if (url.startsWith('/')) return true;
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Loads an avatar image safely for canvas export.
 * Cross-origin images are requested with `crossOrigin = 'anonymous'` and verified against
 * a 1x1 scratch canvas so a CORS-restricted external host never taints the poster canvas.
 */
async function loadSafeAvatarImage(src) {
  const cleanSrc = String(src || '').trim();
  if (!cleanSrc || typeof Image === 'undefined') return null;

  return new Promise((resolve) => {
    const img = new Image();
    const sameOrigin = isSameOriginUrl(cleanSrc);
    if (!sameOrigin) {
      img.crossOrigin = 'anonymous';
    }
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), 5000);

    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        finish(null);
        return;
      }
      if (!sameOrigin) {
        try {
          const probe = document.createElement('canvas');
          probe.width = 1;
          probe.height = 1;
          const pctx = probe.getContext('2d');
          pctx.drawImage(img, 0, 0, 1, 1);
          probe.toDataURL('image/png');
        } catch {
          finish(null);
          return;
        }
      }
      finish(img);
    };
    img.onerror = () => finish(null);
    img.src = cleanSrc;
  });
}

function drawAvatar(ctx, img, cx, cy, radius, initialChar, palette) {
  // Soft outer accent halo
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
  ctx.fillStyle = palette.accentSoft;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = palette.accentLine;
  ctx.stroke();
  ctx.restore();

  // Clip circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  if (img) {
    const scale = Math.max((radius * 2) / img.naturalWidth, (radius * 2) / img.naturalHeight);
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    ctx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
  } else {
    const grad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    if (palette.isDark) {
      grad.addColorStop(0, '#5a2338');
      grad.addColorStop(1, '#2f1520');
    } else {
      grad.addColorStop(0, '#f7d5e1');
      grad.addColorStop(1, '#e89ab6');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    ctx.fillStyle = palette.isDark ? '#f7eef1' : '#871d41';
    ctx.font = `700 ${Math.round(radius * 0.92)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initialChar || 'R', cx, cy + 4);
  }
  ctx.restore();
}

const TAG_PILL_H = 46;
const TAG_GAP_Y = 14;

/**
 * Packs tag pills into centered rows (up to 2). Used both to measure the tag block height before
 * the canvas is sized and to draw it.
 */
function layoutTagRows(ctx, tags, maxWidth) {
  if (!tags.length) return [];
  ctx.save();
  ctx.font = `600 24px ${FONT_STACK}`;
  const padX = 22;
  const gapX = 14;

  const items = tags.slice(0, 6).map((raw) => {
    const label = `# ${truncateLine(ctx, String(raw).trim(), 240)}`;
    const width = Math.ceil(ctx.measureText(label).width) + padX * 2;
    return { label, width };
  });

  // Pack pills into centered rows (up to 2 rows)
  const rows = [];
  let row = [];
  let rowW = 0;
  for (const item of items) {
    const nextW = row.length ? rowW + gapX + item.width : item.width;
    if (row.length > 0 && nextW > maxWidth) {
      rows.push({ items: row, width: rowW });
      if (rows.length >= 2) {
        row = [];
        break;
      }
      row = [item];
      rowW = item.width;
    } else {
      row.push(item);
      rowW = nextW;
    }
  }
  if (row.length > 0 && rows.length < 2) {
    rows.push({ items: row, width: rowW });
  }
  ctx.restore();
  return rows;
}

function tagBlockHeight(rows) {
  return rows.length ? rows.length * TAG_PILL_H + (rows.length - 1) * TAG_GAP_Y : 0;
}

function drawTagPills(ctx, rows, centerX, startY, palette) {
  if (!rows.length) return startY;

  ctx.save();
  ctx.font = `600 24px ${FONT_STACK}`;
  const pillH = TAG_PILL_H;
  const gapX = 14;
  const gapY = TAG_GAP_Y;

  let y = startY;
  for (const r of rows) {
    let x = centerX - r.width / 2;
    for (const item of r.items) {
      drawRoundedRectPath(ctx, x, y, item.width, pillH, pillH / 2);
      ctx.fillStyle = palette.accentSoft;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = palette.accentLine;
      ctx.stroke();

      ctx.fillStyle = palette.accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.label, x + item.width / 2, y + pillH / 2 + 1);
      x += item.width + gapX;
    }
    y += pillH + gapY;
  }

  ctx.restore();
  return y - gapY;
}

function drawQrCode(ctx, qr, cx, topY, boxSize, palette) {
  const count = qr.getModuleCount();
  const quietPadding = 24;
  const innerSize = boxSize - quietPadding * 2;
  const cellSize = innerSize / count;
  const left = cx - boxSize / 2;

  ctx.save();
  // Pure white quiet-zone card guarantees reliable camera scanning in both light & dark themes
  ctx.shadowColor = palette.isDark ? 'rgba(0, 0, 0, 0.32)' : 'rgba(140, 38, 72, 0.10)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  drawRoundedRectPath(ctx, left, topY, boxSize, boxSize, 28);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2;
  ctx.strokeStyle = palette.accentLine;
  ctx.stroke();

  const qrOriginX = left + quietPadding;
  const qrOriginY = topY + quietPadding;
  ctx.fillStyle = '#1e1619';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        const rx = qrOriginX + col * cellSize;
        const ry = qrOriginY + row * cellSize;
        // Slight overlap (+0.35px) prevents hairline anti-aliasing gaps between adjacent modules
        ctx.fillRect(rx, ry, cellSize + 0.35, cellSize + 0.35);
      }
    }
  }
  ctx.restore();
}

function compactUrlLabel(rawUrl) {
  return String(rawUrl || '')
    .trim()
    .split(/[?#]/)[0]
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * Checks whether the browser supports native file sharing (`navigator.share({ files })`).
 */
export function canSharePosterFile(blob) {
  if (!blob || typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || typeof File !== 'function') {
    return false;
  }
  try {
    const file = new File([blob], 'rosepanel-card.png', { type: 'image/png' });
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Generates a 1080px-wide PNG share poster (content-fitted height) using only public card information.
 * Never draws private bookmarks, visitor statistics, or transient online status.
 */
export async function generateSharePoster({
  displayName = BRAND_NAME,
  handle = '',
  tagline = '',
  tags = [],
  avatarSrc = '',
  shareUrl = '',
} = {}) {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // Proceed even if font readiness rejects in constrained WebViews
    }
  }

  const targetUrl = String(shareUrl || (typeof window !== 'undefined' ? `${window.location.origin}/` : '')).trim();
  const [qrMod, avatarImg] = await Promise.all([
    import('qrcode-generator'),
    loadSafeAvatarImage(avatarSrc),
  ]);
  const qrcodeFactory = qrMod.default || qrMod;

  const qr = qrcodeFactory(0, 'M');
  qr.addData(targetUrl || 'https://telegram.org');
  qr.make();

  const palette = readThemePalette();
  const canvas = document.createElement('canvas');
  canvas.width = POSTER_WIDTH;
  canvas.height = MEASURE_HEIGHT;
  const ctx = canvas.getContext('2d');

  // 0. Measure the upper (profile) section first so the ticket divider sits right under the
  //    content. A card with no handle / short tagline / no tags would otherwise leave a large
  //    empty gap above a fixed divider. The poster height then follows the content.
  const cx = POSTER_WIDTH / 2;
  const cardX = 72;
  const cardW = POSTER_WIDTH - cardX * 2;
  const textMaxW = cardW - 120;
  const cleanName = String(displayName || '').trim() || BRAND_NAME;
  const rawHandle = String(handle || '').trim();
  const cleanHandle = rawHandle && rawHandle !== '@your_bot' ? rawHandle : '';
  const showHandle = Boolean(cleanHandle) && cleanHandle.toLowerCase() !== cleanName.toLowerCase();

  ctx.font = `400 31px ${FONT_STACK}`;
  const bioLines = wrapTextLines(ctx, tagline, textMaxW, 3);
  const validTags = (Array.isArray(tags) ? tags : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 6);
  const tagRows = layoutTagRows(ctx, validTags, textMaxW);

  const NAME_BASELINE = 382;
  const BIO_LINE_H = 48;
  let contentBottom = NAME_BASELINE + 14;
  const handleBaseline = 434;
  if (showHandle) contentBottom = handleBaseline + 12;
  const bioStartBaseline = showHandle ? handleBaseline + 56 : 446;
  if (bioLines.length > 0) {
    contentBottom = bioStartBaseline + (bioLines.length - 1) * BIO_LINE_H + 12;
  }
  const tagStartY = contentBottom + 30;
  if (tagRows.length > 0) {
    contentBottom = tagStartY + tagBlockHeight(tagRows);
  }

  // Divider sits a fixed gap under the content, never higher than MIN_DIVIDER_Y so very sparse
  // cards still look like a ticket. Everything below the divider keeps its original spacing.
  const MIN_DIVIDER_Y = 540;
  const dividerY = Math.max(MIN_DIVIDER_Y, Math.round(contentBottom + 64));
  const cardY = 68;
  const cardH = dividerY + 474 - cardY;
  const posterHeight = cardY + cardH + 104;
  canvas.height = posterHeight; // resizing resets context state; everything below sets its own styles

  // 1. Background canvas + subtle rose ambient glows
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, POSTER_WIDTH, posterHeight);

  const glowTop = ctx.createRadialGradient(890, 140, 20, 890, 140, 520);
  glowTop.addColorStop(0, palette.isDark ? 'rgba(229, 107, 146, 0.16)' : 'rgba(163, 41, 82, 0.10)');
  glowTop.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glowTop;
  ctx.fillRect(0, 0, POSTER_WIDTH, posterHeight);

  const glowBottomY = posterHeight - 170;
  const glowBottom = ctx.createRadialGradient(180, glowBottomY, 20, 180, glowBottomY, 480);
  glowBottom.addColorStop(0, palette.isDark ? 'rgba(229, 107, 146, 0.12)' : 'rgba(217, 107, 144, 0.09)');
  glowBottom.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glowBottom;
  ctx.fillRect(0, 0, POSTER_WIDTH, posterHeight);

  // 2. Elevated main rose-porcelain ticket card
  const notchR = 22;

  ctx.save();
  ctx.shadowColor = palette.isDark ? 'rgba(0, 0, 0, 0.48)' : 'rgba(140, 38, 72, 0.10)';
  ctx.shadowBlur = 44;
  ctx.shadowOffsetY = 18;
  drawRoundedRectPath(ctx, cardX, cardY, cardW, cardH, 46);
  ctx.fillStyle = palette.bgElevated;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2;
  ctx.strokeStyle = palette.border;
  ctx.stroke();
  ctx.restore();

  // Top subtle accent strip inside card
  ctx.save();
  drawRoundedRectPath(ctx, cardX, cardY, cardW, cardH, 46);
  ctx.clip();
  const topTint = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY + 220);
  topTint.addColorStop(0, palette.isDark ? 'rgba(229, 107, 146, 0.10)' : 'rgba(250, 233, 238, 0.65)');
  topTint.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = topTint;
  ctx.fillRect(cardX, cardY, cardW, 240);
  ctx.restore();

  // 3. Circular avatar
  const initialSource = cleanName.replace(/^@+/, '') || cleanHandle.replace(/^@+/, '') || 'R';
  const initialChar = Array.from(initialSource)[0]?.toUpperCase() || 'R';
  drawAvatar(ctx, avatarImg, cx, 224, 86, initialChar, palette);

  // 4. Display name
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  let nameFontSize = 54;
  ctx.font = `700 ${nameFontSize}px ${FONT_STACK}`;
  if (ctx.measureText(cleanName).width > textMaxW) {
    nameFontSize = 44;
    ctx.font = `700 ${nameFontSize}px ${FONT_STACK}`;
  }
  ctx.fillStyle = palette.text;
  ctx.fillText(truncateLine(ctx, cleanName, textMaxW), cx, NAME_BASELINE);

  // 5. Handle (below displayName when distinct)
  if (showHandle) {
    ctx.font = `500 28px ${FONT_STACK}`;
    ctx.fillStyle = palette.accent;
    ctx.fillText(truncateLine(ctx, cleanHandle, textMaxW), cx, handleBaseline);
  }

  // 6. Tagline (max 3 lines with ellipsis; wrapped during measurement above)
  ctx.font = `400 31px ${FONT_STACK}`;
  ctx.fillStyle = palette.textSecondary;
  bioLines.forEach((line, i) => {
    ctx.fillText(line, cx, bioStartBaseline + i * BIO_LINE_H);
  });
  ctx.restore();

  // 7. Personal tags (max 6 capsules)
  if (tagRows.length > 0) {
    drawTagPills(ctx, tagRows, cx, tagStartY, palette);
  }

  // 8. Dashed ticket perforation divider + side cutouts
  ctx.save();
  ctx.beginPath();
  ctx.setLineDash([12, 12]);
  ctx.moveTo(cardX + notchR + 18, dividerY);
  ctx.lineTo(cardX + cardW - notchR - 18, dividerY);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = palette.accentLine;
  ctx.stroke();
  ctx.setLineDash([]);

  for (const notchX of [cardX, cardX + cardW]) {
    ctx.beginPath();
    ctx.arc(notchX, dividerY, notchR, 0, Math.PI * 2);
    ctx.fillStyle = palette.bg;
    ctx.fill();
  }
  ctx.restore();

  // 9. QR Code & caption
  const qrBoxSize = 278;
  const qrTopY = dividerY + 56;
  drawQrCode(ctx, qr, cx, qrTopY, qrBoxSize, palette);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 26px ${FONT_STACK}`;
  ctx.fillStyle = palette.text;
  ctx.fillText('扫码打开个人名片', cx, qrTopY + qrBoxSize + 52);

  const shortLink = compactUrlLabel(targetUrl);
  if (shortLink) {
    ctx.font = `400 22px ${FONT_STACK}`;
    ctx.fillStyle = palette.textMuted;
    ctx.fillText(truncateLine(ctx, shortLink, textMaxW), cx, qrTopY + qrBoxSize + 92);
  }
  ctx.restore();

  // 10. Subtle bottom brand signature ("Made with RosePanel 🌹")
  // Spec: centered, 22px at 1080px width (~2%), secondary text color, 55% opacity, 40px from bottom.
  ctx.save();
  ctx.globalAlpha = SIGNATURE_ALPHA;
  ctx.fillStyle = palette.textSecondary;
  ctx.font = `500 ${SIGNATURE_FONT_PX}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(BRAND_SIGNATURE, cx, posterHeight - SIGNATURE_BOTTOM_OFFSET);
  ctx.restore();

  const dataUrl = canvas.toDataURL('image/png');
  const blob = await new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } else {
      resolve(null);
    }
  });

  return {
    blob,
    dataUrl,
    width: POSTER_WIDTH,
    height: posterHeight,
  };
}
