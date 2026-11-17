// 偏好设置与会话状态的持久化。
// 分两份存：prefs 是「用户偏好」（主题、字号、分屏方式…），session 是「上次在做什么」
//（打开的标签、工作区、展开的目录）。分开的好处：重置设置不会把工作现场清掉。
const PREFS_KEY = 'feathermark.prefs.v1';
const SESSION_KEY = 'feathermark.session.v1';

export const DEFAULT_PREFS = {
  themeMode: 'light', // light | dark | system
  scheme: 'ink', // ink | forest | amber | violet
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

export const prefs = Object.assign({}, DEFAULT_PREFS, read(PREFS_KEY) || {});

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
