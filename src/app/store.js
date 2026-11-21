// 偏好设置与会话状态的持久化。
// 分两份存：prefs 是「用户偏好」（主题、字号、分屏方式…），session 是「上次在做什么」
//（打开的标签、工作区、展开的目录）。分开的好处：重置设置不会把工作现场清掉。
const PREFS_KEY = 'feathermark.prefs.v1';
const SESSION_KEY = 'feathermark.session.v1';

// Theme Studio 的默认配置（与 theme-presets.js 的 DEFAULT_THEME 保持一致，
// 内联在此避免 store 依赖预设模块；新增字段时两处同步）。
// 常驻生效：active 为当前主题 id，params 按主题 id 存各自的外观参数。
export const DEFAULT_THEME = {
  active: 'ink',
  params: {},              // { [themeId]: { canvas, canvasStrength, backgroundImage, ... } }
};

export const DEFAULT_PREFS = {
  language: 'zh', // 界面语言：zh | en（原生菜单栏随之切换）
  scheme: 'ink', // 兼容旧字段：自定义强调色 id（新主题模型下不再作为入口）
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
  historyEnabled: true, // 记录编辑历史（存应用私有 git 仓库，不影响用户仓库）
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

// theme 深合并 + 旧结构迁移：旧版是 { enabled, preset, canvas, canvasStrength, ..., typography }
// 全局单一参数；新版是 { active, params: { [id]: 参数 } } 每个主题各带一套。
const oldTheme = stored.theme || {};
if (oldTheme && (oldTheme.enabled !== undefined || oldTheme.preset !== undefined || oldTheme.canvas !== undefined)) {
  // 旧结构：把全局参数迁移为旧 preset 的专属参数
  const legacyId = oldTheme.preset || 'ink';
  const legacyParams = {};
  ['canvas', 'canvasStrength', 'backgroundImage', 'imageOpacity', 'imageBlur', 'imageSize'].forEach((k) => {
    if (oldTheme[k] !== undefined) legacyParams[k] = oldTheme[k];
  });
  if (oldTheme.typography) legacyParams.typography = oldTheme.typography;
  prefs.theme = { active: legacyId, params: { [legacyId]: legacyParams } };
} else {
  prefs.theme = {
    active: oldTheme.active || DEFAULT_THEME.active,
    params: oldTheme.params || {},
  };
  // 逐主题补全参数里的 typography（旧 params 可能缺字段）
  Object.keys(prefs.theme.params).forEach((id) => {
    const p = prefs.theme.params[id] || {};
    prefs.theme.params[id] = { ...p, typography: { lineHeight: 1.68, letterSpacing: 0, maxWidth: 860, activeLine: true, cursorWidth: 2, ...(p.typography || {}) } };
  });
}

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
