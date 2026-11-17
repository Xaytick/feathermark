// Theme Studio：编辑区主题预设、背景画布与排版参数。
// 每套预设是一组 --ed-* token；应用时写到 documentElement 的 inline style，
// 覆盖 styles.css 里的默认值。未启用时编辑区完全沿用原有 --text/--bg 变量。

// 6 套预设的完整 token。value 均为合法 CSS 颜色。
// 分组：画布 / 正文 / 交互 / 结构 / 语法高亮
export const PRESETS = [
  {
    id: 'paper', name: '纸白', desc: '暖白护眼 · 浅色', tone: 'light',
    tokens: {
      '--ed-bg': '#FCFCFA', '--ed-fg': '#2E3440', '--ed-fg-muted': '#6B7280', '--ed-fg-faint': '#9AA1AC',
      '--ed-accent': '#2F6FEB', '--ed-selection': 'rgba(47,111,235,0.16)', '--ed-cursor': '#2F6FEB',
      '--ed-activeline': 'rgba(15,23,42,0.045)', '--ed-border': '#E5E7EB', '--ed-quote-bg': '#F5F6F9',
      '--ed-code-bg': '#F3F4F7', '--ed-code-border': '#E5E8EE',
      '--ed-h': '#1F2937', '--ed-strong': '#111827', '--ed-em': '#111827', '--ed-link': '#2F6FEB',
      '--ed-quote': '#6B7280', '--ed-string': '#B45309', '--ed-keyword': '#7C3AED',
      '--ed-number': '#0F8A5F', '--ed-tag': '#0F8A5F', '--ed-attribute': '#B45309', '--ed-type': '#7C3AED',
    },
  },
  {
    id: 'ink', name: '墨夜', desc: '经典蓝灰 · 深色', tone: 'dark',
    tokens: {
      '--ed-bg': '#191C22', '--ed-fg': '#E4E8EF', '--ed-fg-muted': '#9AA5B5', '--ed-fg-faint': '#7B8493',
      '--ed-accent': '#5C92F7', '--ed-selection': 'rgba(92,146,247,0.22)', '--ed-cursor': '#5C92F7',
      '--ed-activeline': 'rgba(255,255,255,0.055)', '--ed-border': '#2B313B', '--ed-quote-bg': '#1C2027',
      '--ed-code-bg': '#21262E', '--ed-code-border': '#2E3540',
      '--ed-h': '#F0F3F8', '--ed-strong': '#FFFFFF', '--ed-em': '#F0F3F8', '--ed-link': '#5C92F7',
      '--ed-quote': '#9AA5B5', '--ed-string': '#E0A75F', '--ed-keyword': '#B79BF5',
      '--ed-number': '#6CD3A5', '--ed-tag': '#6CD3A5', '--ed-attribute': '#E0A75F', '--ed-type': '#B79BF5',
    },
  },
  {
    id: 'sepia', name: '羊皮', desc: '复古米黄 · 浅色', tone: 'light',
    tokens: {
      '--ed-bg': '#F5EFE3', '--ed-fg': '#4A3F32', '--ed-fg-muted': '#8A7A64', '--ed-fg-faint': '#A8997F',
      '--ed-accent': '#9A6B3F', '--ed-selection': 'rgba(154,107,63,0.18)', '--ed-cursor': '#9A6B3F',
      '--ed-activeline': 'rgba(120,90,50,0.05)', '--ed-border': '#E4D9C3', '--ed-quote-bg': '#EFE5D0',
      '--ed-code-bg': '#EBDDBF', '--ed-code-border': '#DCCBAB',
      '--ed-h': '#4A3F32', '--ed-strong': '#3A2F24', '--ed-em': '#4A3F32', '--ed-link': '#9A6B3F',
      '--ed-quote': '#8A7A64', '--ed-string': '#A15C37', '--ed-keyword': '#8C4B6B',
      '--ed-number': '#6E7A46', '--ed-tag': '#6E7A46', '--ed-attribute': '#A15C37', '--ed-type': '#8C4B6B',
    },
  },
  {
    id: 'forest', name: '森林', desc: '低饱和绿 · 深色', tone: 'dark',
    tokens: {
      '--ed-bg': '#16211C', '--ed-fg': '#DCE8DF', '--ed-fg-muted': '#8FA89A', '--ed-fg-faint': '#718778',
      '--ed-accent': '#3FBB8B', '--ed-selection': 'rgba(63,187,139,0.2)', '--ed-cursor': '#3FBB8B',
      '--ed-activeline': 'rgba(255,255,255,0.045)', '--ed-border': '#25342C', '--ed-quote-bg': '#1E2D26',
      '--ed-code-bg': '#1B2A22', '--ed-code-border': '#2A3D31',
      '--ed-h': '#E8F2EB', '--ed-strong': '#FFFFFF', '--ed-em': '#E8F2EB', '--ed-link': '#3FBB8B',
      '--ed-quote': '#8FA89A', '--ed-string': '#A8C97F', '--ed-keyword': '#C9A0DC',
      '--ed-number': '#E0B87A', '--ed-tag': '#7FC9A5', '--ed-attribute': '#A8C97F', '--ed-type': '#C9A0DC',
    },
  },
  {
    id: 'dusk', name: '暮紫', desc: '柔和紫调 · 深色', tone: 'dark',
    tokens: {
      '--ed-bg': '#1E1B2E', '--ed-fg': '#E6E1F0', '--ed-fg-muted': '#9A92B5', '--ed-fg-faint': '#7B7396',
      '--ed-accent': '#A583F0', '--ed-selection': 'rgba(165,131,240,0.22)', '--ed-cursor': '#A583F0',
      '--ed-activeline': 'rgba(255,255,255,0.05)', '--ed-border': '#312B49', '--ed-quote-bg': '#241F3A',
      '--ed-code-bg': '#282341', '--ed-code-border': '#3A3357',
      '--ed-h': '#F0ECFA', '--ed-strong': '#FFFFFF', '--ed-em': '#F0ECFA', '--ed-link': '#A583F0',
      '--ed-quote': '#9A92B5', '--ed-string': '#E0A75F', '--ed-keyword': '#C9A0F5',
      '--ed-number': '#7FD4B0', '--ed-tag': '#7FD4B0', '--ed-attribute': '#E0A75F', '--ed-type': '#C9A0F5',
    },
  },
  {
    id: 'terminal', name: '终端', desc: '高对比极客 · 深色', tone: 'dark',
    tokens: {
      '--ed-bg': '#0D1117', '--ed-fg': '#E6EDF3', '--ed-fg-muted': '#8B949E', '--ed-fg-faint': '#6E7681',
      '--ed-accent': '#58A6FF', '--ed-selection': 'rgba(88,166,255,0.24)', '--ed-cursor': '#58A6FF',
      '--ed-activeline': 'rgba(255,255,255,0.05)', '--ed-border': '#21262D', '--ed-quote-bg': '#161B22',
      '--ed-code-bg': '#161B22', '--ed-code-border': '#30363D',
      '--ed-h': '#F0F6FC', '--ed-strong': '#FFFFFF', '--ed-em': '#F0F6FC', '--ed-link': '#58A6FF',
      '--ed-quote': '#8B949E', '--ed-string': '#A5D6FF', '--ed-keyword': '#FF7B72',
      '--ed-number': '#79C0FF', '--ed-tag': '#7EE787', '--ed-attribute': '#A5D6FF', '--ed-type': '#FFA657',
    },
  },
];

// 全部 --ed-* 变量键：关闭 Theme Studio 时逐个移除，恢复 styles.css 默认值
export const ED_VAR_KEYS = [
  ...Object.keys(PRESETS[0].tokens),
  '--ed-canvas-image', '--ed-canvas-size', '--ed-canvas-position',
  '--ed-line-height', '--ed-letter-spacing', '--ed-max-width',
  '--ed-cursor-width', '--ed-active-line',
  '--ed-bg-image', '--ed-bg-opacity', '--ed-bg-blur', '--ed-bg-size', '--ed-bg-repeat',
];

// 全组件换色时覆盖的 UI 变量键（这些变量原本由 data-mode/data-scheme 的 CSS 规则提供）
export const UI_VAR_KEYS = [
  '--bg', '--bg-app', '--bg-panel', '--bg-hover', '--bg-active',
  '--border', '--border-strong',
  '--text', '--text-dim', '--text-faint',
  '--code-bg', '--code-border',
  '--accent', '--accent-hover', '--accent-soft',
  '--shadow-pop', '--shadow-sm', '--mark', '--scroll-thumb',
];

export const CANVASES = [
  { id: 'solid', name: '纯色', desc: '零干扰' },
  { id: 'dot', name: '点阵', desc: '细圆点' },
  { id: 'grid', name: '网格', desc: '淡线方格' },
  { id: 'rule', name: '稿纸', desc: '横向行线' },
  { id: 'grain', name: '纸纹', desc: '颗粒质感' },
];

export const DEFAULT_THEME = {
  enabled: false,          // 是否启用 Theme Studio；关闭则完全沿用原有主题
  preset: 'ink',           // 当前预设 id
  canvas: 'solid',         // 背景画布 id
  canvasStrength: 0.5,     // 纹理强度 0..1
  backgroundImage: null,   // 背景图 data URL（已压缩）
  imageOpacity: 0.35,      // 图片不透明度 0..1
  imageBlur: 0,            // 图片模糊度 0..20 px
  imageSize: 'cover',      // cover | contain | repeat
  typography: {
    lineHeight: 1.68,      // 编辑区行高
    letterSpacing: 0,      // 编辑区字距（px）
    maxWidth: 860,         // 正文最大宽度（px），0 表示不限
    activeLine: true,      // 当前行高亮
    cursorWidth: 2,        // 光标宽度（px）
  },
};

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/** 把 hex（#RRGGBB）转成 rgb 三元组字符串，用于构造带透明度的纹理。 */
function hexToRgb(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return { r: 255, g: 255, b: 255, str: '255, 255, 255' };
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return { r, g, b, str: `${r}, ${g}, ${b}` };
}

/** 两色按 t 混合（t=0 取 a，t=1 取 b），返回 hex。 */
function mixHex(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return '#' + c(ca.r, cb.r) + c(ca.g, cb.g) + c(ca.b, cb.b);
}

/** rgb 三元组转 rgba 字符串。 */
function rgba(hex, alpha) {
  return `rgba(${hexToRgb(hex).str}, ${alpha})`;
}

/**
 * 从预设派生整站 UI 配色变量，让标题栏/侧栏/状态栏/Agent 面板/弹窗全部跟随预设。
 * 深色预设让整个应用变深色——data-mode 由 main.js 据 preset.tone 强制切换，
 * 这里再叠加预设自身的色相，实现「整个界面换色」。
 */
function deriveUiVars(preset, mode) {
  const T = preset.tokens;
  const bg = T['--ed-bg'];
  const fg = T['--ed-fg'];
  const dim = T['--ed-fg-muted'];
  const faint = T['--ed-fg-faint'];
  const border = T['--ed-border'];
  const accent = T['--ed-accent'];
  const dark = mode === 'dark' || preset.tone === 'dark';

  return {
    '--bg': bg,
    '--bg-app': mixHex(bg, dark ? '#000000' : '#9aa5b5', dark ? 0.35 : 0.07),
    '--bg-panel': mixHex(bg, fg, dark ? 0.055 : 0.022),
    '--bg-hover': rgba(fg, dark ? 0.07 : 0.05),
    '--bg-active': rgba(fg, dark ? 0.11 : 0.085),
    '--border': border,
    '--border-strong': mixHex(border, fg, dark ? 0.18 : 0.12),
    '--text': fg,
    '--text-dim': dim,
    '--text-faint': faint,
    '--code-bg': T['--ed-code-bg'],
    '--code-border': T['--ed-code-border'],
    '--accent': accent,
    '--accent-hover': mixHex(accent, dark ? '#ffffff' : '#000000', dark ? 0.16 : 0.14),
    '--accent-soft': rgba(accent, dark ? 0.18 : 0.12),
    '--shadow-pop': dark ? '0 14px 38px rgba(0, 0, 0, 0.5)' : '0 12px 32px rgba(15, 23, 42, 0.14)',
    '--shadow-sm': dark ? '0 1px 2px rgba(0, 0, 0, 0.3)' : '0 1px 2px rgba(15, 23, 42, 0.06)',
    '--mark': T['--ed-string'],
    '--scroll-thumb': rgba(fg, dark ? 0.2 : 0.18),
  };
}

/** 生成画布纹理的 CSS background-image 值；solid 返回 'none'。 */
export function canvasImage(canvasId, hex, strength) {
  const rgb = hexToRgb(hex).str;
  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  const alpha = (a) => (a * s).toFixed(3);
  switch (canvasId) {
    case 'dot':
      return `radial-gradient(rgba(${rgb}, ${alpha(0.28)}) 1px, transparent 1px)`;
    case 'grid':
      return `linear-gradient(rgba(${rgb}, ${alpha(0.16)}) 1px, transparent 1px), linear-gradient(90deg, rgba(${rgb}, ${alpha(0.16)}) 1px, transparent 1px)`;
    case 'rule':
      return `repeating-linear-gradient(transparent, transparent 27px, rgba(${rgb}, ${alpha(0.2)}) 27px, rgba(${rgb}, ${alpha(0.2)}) 28px)`;
    case 'grain':
      return `radial-gradient(rgba(${rgb}, ${alpha(0.12)}) 0.5px, transparent 0.5px), radial-gradient(rgba(${rgb}, ${alpha(0.09)}) 0.5px, transparent 0.5px)`;
    default:
      return 'none';
  }
}

/** 生成画布纹理的 background-size（与 canvasImage 配套）。 */
export function canvasSize(canvasId) {
  switch (canvasId) {
    case 'dot': return '20px 20px';
    case 'grid': return '22px 22px';
    case 'rule': return 'auto';
    case 'grain': return '7px 7px, 11px 11px';
    default: return 'auto';
  }
}

/** 把主题配置 + 当前明暗模式，转换成要写入 documentElement 的 CSS 变量映射。 */
export function themeVars(theme, mode) {
  const preset = getPreset(theme.preset);
  if (!preset) return {};
  const vars = {};
  Object.entries(preset.tokens).forEach(([k, v]) => { vars[k] = v; });
  // 全组件换色：把 UI 变量也覆盖成预设色板（深色预设 → 整个界面深色）
  Object.assign(vars, deriveUiVars(preset, mode));

  const fg = preset.tokens['--ed-fg'];
  const isGrain = theme.canvas === 'grain';
  vars['--ed-canvas-image'] = canvasImage(theme.canvas, fg, theme.canvasStrength);
  vars['--ed-canvas-size'] = canvasSize(theme.canvas);
  // 纸纹需要双层错位定位
  vars['--ed-canvas-position'] = isGrain ? '0 0, 3px 4px' : '0 0';

  const t = theme.typography || DEFAULT_THEME.typography;
  vars['--ed-line-height'] = String(t.lineHeight);
  vars['--ed-letter-spacing'] = `${t.letterSpacing}px`;
  vars['--ed-max-width'] = t.maxWidth ? `${t.maxWidth}px` : 'none';
  vars['--ed-cursor-width'] = `${t.cursorWidth}px`;
  vars['--ed-active-line'] = t.activeLine ? preset.tokens['--ed-activeline'] : 'transparent';

  // 背景图片层：仅在配置了图片时输出有效值，否则 opacity=0 隐藏
  const dataUrl = theme.backgroundImage;
  vars['--ed-bg-image'] = dataUrl ? `url("${dataUrl}")` : 'none';
  vars['--ed-bg-opacity'] = dataUrl ? String(Math.max(0, Math.min(1, Number(theme.imageOpacity) || 0))) : '0';
  vars['--ed-bg-blur'] = `${Math.max(0, Math.min(20, Number(theme.imageBlur) || 0))}px`;
  const size = theme.imageSize || 'cover';
  vars['--ed-bg-size'] = size === 'repeat' ? 'auto' : size;
  vars['--ed-bg-repeat'] = size === 'repeat' ? 'repeat' : 'no-repeat';
  return vars;
}
