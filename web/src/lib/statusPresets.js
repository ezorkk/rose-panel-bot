// Shared Profile Status Tones, Built-in Animated Pixel Status Stickers & Quick Scene Presets
// Used by both Cloudflare Worker (`config.js`, `api.js`) and React Mini App (`TicketTab`, `SettingsDrawer`).

export const STATUS_TONES = ['online', 'busy', 'away'];

export const STATUS_TONE_OPTIONS = [
  { id: 'online', label: '在线', dotClass: 'green' },
  { id: 'busy', label: '忙碌', dotClass: 'amber' },
  { id: 'away', label: '离开', dotClass: 'red' },
];

export const STATUS_STICKERS = [
  { id: 'sparkle', label: '闪亮' },
  { id: 'rose', label: '玫瑰' },
  { id: 'sakura', label: '樱花' },
  { id: 'star', label: '星星' },
  { id: 'heart', label: '爱心' },
  { id: 'flower', label: '小花' },
  { id: 'butterfly', label: '蝴蝶' },
  { id: 'comet', label: '流星' },
  { id: 'tulip', label: '郁金香' },
  { id: 'mail', label: '信封' },
  { id: 'lock', label: '勿扰锁' },
  { id: 'ok', label: 'OK' },
];

export const STATUS_STICKER_IDS = STATUS_STICKERS.map((s) => s.id);

export const STATUS_SCENE_PRESETS = [
  {
    id: 'online',
    label: '正常营业',
    hint: '绿灯 · 关闭自动回复',
    statusTone: 'online',
    statusText: '在线营业中',
    statusSticker: '',
    autoReplyEnabled: false,
    autoReplyText: '',
  },
  {
    id: 'coding',
    label: '写代码中',
    hint: '黄灯 · 开启自动回复',
    statusTone: 'busy',
    statusText: '写代码中',
    statusSticker: 'sparkle',
    autoReplyEnabled: true,
    autoReplyText: '正在专心写代码，看到消息后会尽快回复你～',
  },
  {
    id: 'vacation',
    label: '度假中',
    hint: '红灯 · 开启自动回复',
    statusTone: 'away',
    statusText: '度假中',
    statusSticker: 'sakura',
    autoReplyEnabled: true,
    autoReplyText: '正在休假中，回复会慢一点，有急事请直接说明来意～',
  },
  {
    id: 'dnd',
    label: '勿扰休息',
    hint: '红灯 · 开启自动回复',
    statusTone: 'away',
    statusText: '勿扰休息中',
    statusSticker: 'lock',
    autoReplyEnabled: true,
    autoReplyText: '暂时勿扰休息中，方便时会第一时间回复你～',
  },
];

export function normalizeStatusTone(raw) {
  const val = String(raw || '').trim().toLowerCase();
  return STATUS_TONES.includes(val) ? val : 'online';
}

export function normalizeStatusSticker(raw) {
  const val = String(raw || '').trim().toLowerCase();
  return STATUS_STICKER_IDS.includes(val) ? val : '';
}

export function getStatusStickerUrl(id) {
  const clean = normalizeStatusSticker(id);
  return clean ? `/status-stickers/${clean}.webp` : '';
}
