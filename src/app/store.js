// 偏好设置与会话状态的持久化。
// 分两份存：prefs 是「用户偏好」（主题、字号、分屏方式…），session 是「上次在做什么」
//（打开的标签、工作区、展开的目录）。分开的好处：重置设置不会把工作现场清掉。
const PREFS_KEY = 'feathermark.prefs.v1';
const SESSION_KEY = 'feathermark.session.v1';

// Theme Studio 的默认配置（与 theme-presets.js 的 DEFAULT_THEME 保持一致，
// 内联在此避免 store 依赖预设模块；新增字段时两处同步）。
export const DEFAULT_THEME = {
  enabled: false,
  preset: 'ink',
  canvas: 'solid',
  canvasStrength: 0.5,
  backgroundImage: null,   // data URL（压缩后的背景图）
  imageOpacity: 0.35,      // 图片不透明度 0..1
  imageBlur: 0,            // 图片模糊度 0..20 px
  imageSize: 'cover',       // cover | contain | repeat
  typography: { lineHeight: 1.68, letterSpacing: 0, maxWidth: 860, activeLine: true, cursorWidth: 2 },
};

export const DEFAULT_PREFS = {
  themeMode: 'light', // light | dark | system
  scheme: 'ink', // ink | forest | amber | violet
  theme: JSON.parse(JSON.stringify(DEFAULT_THEME)), // Theme Studio 配置
  editorFont: '',
  editorSize: 15,
  previewFont: '',
  previewSize: 15.5,
  codeFont: '',
  codeSize: 13,
  viewMode: 'split', // editor | split | preview
  splitDir: 'h', // h=左右 | v=上下
  splitRatio: 50,
  sidebarVisible: true,
  sidebarWidth: 248,
  sidebarPane: 'files',
  chatVisible: false,
  chatWidth: 380,
  lineWrap: true,
  lineNumbers: false,
  autoSave: false,
  autoPairs: true,
  softBreaks: false,
  spellcheck: false,
};

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch (_) {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    /* 隐私模式等场景写不进去：忽略，不影响使用 */
  }
}

const stored = read(PREFS_KEY) || {};
export const prefs = Object.assign({}, DEFAULT_PREFS, stored);
// 深合并 theme：旧配置缺字段时逐项补默认值，避免 undefined
prefs.theme = Object.assign({}, DEFAULT_THEME, stored.theme || {});
prefs.theme.typography = Object.assign({}, DEFAULT_THEME.typography, (stored.theme && stored.theme.typography) || {});

export function savePrefs() {
  write(PREFS_KEY, prefs);
}

export function resetPrefs() {
  Object.assign(prefs, DEFAULT_PREFS);
  savePrefs();
}

/* ------------------------------------------------------------------ 会话 */
export const session = Object.assign(
  { tabs: [], activeIndex: 0, workspace: null, expanded: [], recent: [] },
  read(SESSION_KEY) || {}
);

export function saveSession(patch) {
  Object.assign(session, patch);
  // 会话不需要实时落盘到每个字节，节流一下避免输入时频繁写 localStorage
  if (session._timer) return;
  session._timer = setTimeout(() => {
    session._timer = null;
    const { _timer, ...rest } = session;
    write(SESSION_KEY, rest);
  }, 400);
}

export function pushRecent(path) {
  if (!path) return;
  const list = (session.recent || []).filter((p) => p !== path);
  list.unshift(path);
  session.recent = list.slice(0, 8);
  saveSession({});
}
