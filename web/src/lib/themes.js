// Shared Theme Presets & Bottom Dock Styles catalog (used by both Cloudflare Worker & React Mini App)

export const DEFAULT_THEME_PRESET = 'rose';
export const DEFAULT_DOCK_STYLE = 'solid';

export const THEME_PRESETS = [
  {
    id: 'rose',
    name: '玫瑰瓷',
    desc: '经典淡粉瓷白与酒红玫瑰',
    swatch: '#a32952',
    swatchSoft: '#fae9ee',
    lightBg: '#faf4f5',
    darkBg: '#141012',
  },
  {
    id: 'ocean',
    name: '海盐晴蓝',
    desc: '清爽冷淡晴空蓝，技术风首选',
    swatch: '#1d63b8',
    swatchSoft: '#e4f0fd',
    lightBg: '#f3f7fb',
    darkBg: '#0f141a',
  },
  {
    id: 'matcha',
    name: '抹茶青瓷',
    desc: '低饱和温润奶绿，久看不累',
    swatch: '#2c7a56',
    swatchSoft: '#e4f3eb',
    lightBg: '#f4f8f5',
    darkBg: '#101613',
  },
  {
    id: 'lavender',
    name: '暮紫雾灰',
    desc: '柔和薰衣草雾紫，自带夜色氛围',
    swatch: '#6d46b8',
    swatchSoft: '#efe9fb',
    lightBg: '#f6f4fa',
    darkBg: '#131119',
  },
  {
    id: 'mono',
    name: '极简黑白',
    desc: '中性高级冷灰，无明显色调倾向',
    swatch: '#27272c',
    swatchSoft: '#dedee6',
    lightBg: '#f5f5f7',
    darkBg: '#111113',
  },
];

export const THEME_PRESET_IDS = THEME_PRESETS.map((p) => p.id);

export const DOCK_STYLES = [
  {
    id: 'solid',
    name: '瓷感实体',
    desc: '沉稳清晰，滚过图文不透底',
  },
  {
    id: 'glass',
    name: '轻磨砂玻璃',
    desc: '高透液态玻璃 + 边缘高光，滑动时背景柔和透出',
  },
];

export const DOCK_STYLE_IDS = DOCK_STYLES.map((d) => d.id);

export function normalizeThemePreset(raw) {
  const val = String(raw || '').trim().toLowerCase();
  return THEME_PRESET_IDS.includes(val) ? val : DEFAULT_THEME_PRESET;
}

export function normalizeDockStyle(raw) {
  const val = String(raw || '').trim().toLowerCase();
  return DOCK_STYLE_IDS.includes(val) ? val : DEFAULT_DOCK_STYLE;
}

export function getThemePresetMeta(id) {
  const clean = normalizeThemePreset(id);
  return THEME_PRESETS.find((p) => p.id === clean) || THEME_PRESETS[0];
}

export function getDockStyleMeta(id) {
  const clean = normalizeDockStyle(id);
  return DOCK_STYLES.find((d) => d.id === clean) || DOCK_STYLES[0];
}

export function getThemeChromeBg(theme = 'light', presetId = DEFAULT_THEME_PRESET) {
  const meta = getThemePresetMeta(presetId);
  return theme === 'dark' ? meta.darkBg : meta.lightBg;
}
