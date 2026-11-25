// FeatherMark 主程序：把编辑器、预览、标签、文件树、搜索、导出串起来。
// 结构上刻意保持「一个状态对象 + 若干纯模块」，模块之间不互相 import，
// 全部由这里注入回调，避免出现循环依赖。
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import * as ipc from './ipc.js';
import { prefs, savePrefs, session, saveSession, pushRecent } from './store.js';
import { getScheme } from './color-schemes.js';
import { themeVars, getPreset, tokensFromColors, resolveParams, luminance, PRESETS } from './theme-presets.js';
import { createEditor } from './editor6.js';
import { createPreview, dirname, resolvePath } from './preview.js';
import { createTabs } from './tabs.js';
import { createTree } from './tree.js';
import { createSearch } from './search.js';
import { createQuickOpen } from './quickopen.js';
import { createSettings } from './settings.js';
import { createChat } from './chat.js';
import { createHistoryPanel } from './history-panel.js';
import * as exporters from './exporters.js';
import * as ui from './ui.js';
import { t as tr, locale as uiLocale, setLocale, applyStatic } from './i18n.js';

const $ = (id) => document.getElementById(id);
const basename = (p) => (p || '').split(/[\\/]/).pop() || p;

const state = {
  tabs: [],
  activeId: null,
  workspace: session.workspace || null,
  untitledSeq: 1,
  syncLock: 0,
  renderTimer: null,
  os: 'linux',
};

let editor = null;
let preview = null;
let tabs = null;
let tree = null;
let search = null;
let quickopen = null;
let settings = null;
let chat = null;
let historyPanel = null;

const activeTab = () => state.tabs.find((t) => t.id === state.activeId) || null;
const uid = () => 't' + Math.random().toString(36).slice(2, 9);

/* ================================================================= 编辑历史 */
// 文档键：已保存用规范化绝对路径，未保存用 untitled/<name>。
// 私有仓库按此键 hash 出独立 ref；不需要文档所在目录是 git 仓库。
function versionDocKey(tab = activeTab()) {
  if (!tab) return null;
  if (tab.path) return tab.path.replace(/\\/g, '/');
  return 'untitled/' + (tab.name || 'document');
}

// 写回前记录历史版本。受 prefs.historyEnabled 控制；失败只告警不阻塞编辑。
async function recordVersion({ afterDoc, label, meta }) {
  if (!prefs.historyEnabled) return;
  const tab = activeTab();
  if (!tab || !afterDoc) return;
  const docKey = versionDocKey(tab);
  if (!docKey) return;
  try {
    await ipc.historyRecord(docKey, afterDoc, label, meta);
    if (historyPanel) historyPanel.invalidate();
  } catch (e) {
    console.warn('记录编辑历史失败（不影响编辑）:', e);
    if (historyPanel) historyPanel.notifyError(ipc.describeError(e));
  }
}

/* ================================================================= 主题与布局 */
// 当前主题的统一解析：内置预设取 PRESETS，自定义配色（p 开头）从颜色派生完整 token。
// 返回 { id, tokens, tone }；找不到时回落到 ink。
function resolveActiveTheme() {
  const id = (prefs.theme && prefs.theme.active) || 'ink';
  const preset = getPreset(id);
  if (preset) return { id, tokens: preset.tokens, tone: preset.tone };
  const scheme = getScheme(id);
  if (scheme && scheme.colors && scheme.colors.length) {
    const tokens = tokensFromColors(scheme.colors);
    if (tokens) return { id, tokens, tone: scheme.tone || (luminance(scheme.colors[0].hex) < 128 ? 'dark' : 'light') };
  }
  const ink = getPreset('ink');
  return { id: 'ink', tokens: ink.tokens, tone: ink.tone };
}

function resolvedMode() {
  // 明暗完全由当前主题决定（主题工作台常驻）
  return resolveActiveTheme().tone;
}

// Theme Studio 常驻：把当前主题的 token + 该主题的外观参数写成 inline 变量，
// 覆盖整个界面。data-theme-studio 标记当前主题 id，供 CSS 作用域使用。
function applyThemeStudio(root) {
  const active = resolveActiveTheme();
  const params = resolveParams(prefs.theme, active.id);
  const vars = themeVars(active.tokens, active.tone, params);
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
  root.dataset.themeStudio = active.id;
}

function applyTheme() {
  const mode = resolvedMode();
  const root = document.documentElement;
  const changed = root.dataset.mode !== mode;
  root.dataset.mode = mode;
  const active = resolveActiveTheme();
  root.dataset.scheme = active.id;
  applyThemeStudio(root);
  $('hljs-light').disabled = mode === 'dark';
  $('hljs-dark').disabled = mode !== 'dark';
  if (changed) {
    if (preview) preview.refreshMermaidTheme(mode === 'dark');
    if (preview && activeTab()) scheduleRender(true);
  }
}

function applyFonts() {
  const root = document.documentElement.style;
  root.setProperty('--editor-font', prefs.editorFont ? `"${prefs.editorFont}", var(--font-ui)` : 'var(--font-ui)');
  root.setProperty('--editor-size', `${prefs.editorSize}px`);
  root.setProperty('--preview-font', prefs.previewFont ? `"${prefs.previewFont}", var(--font-ui)` : 'var(--font-ui)');
  root.setProperty('--preview-size', `${prefs.previewSize}px`);
  root.setProperty('--code-font', prefs.codeFont ? `"${prefs.codeFont}", var(--font-mono)` : 'var(--font-mono)');
  root.setProperty('--code-size', `${prefs.codeSize}px`);
  if (editor) editor.refresh();
}

function applyLayout() {
  const ws = $('workspace');
  ws.classList.remove('mode-editor', 'mode-split', 'mode-preview', 'dir-h', 'dir-v');
  ws.classList.add('mode-' + prefs.viewMode, 'dir-' + (prefs.splitDir === 'v' ? 'v' : 'h'));
  ws.style.setProperty('--split', `${prefs.splitRatio}%`);
  $('sidebar').classList.toggle('hidden', !prefs.sidebarVisible);
  document.documentElement.style.setProperty('--sidebar-w', `${prefs.sidebarWidth}px`);
  document.documentElement.style.setProperty('--chat-w', `${prefs.chatWidth || 380}px`);
  $('chat-panel').classList.toggle('hidden', !prefs.chatVisible);
  $('splitter-chat').classList.toggle('hidden', !prefs.chatVisible);
  $('btn-chat').classList.toggle('active', !!prefs.chatVisible);
  $('sb-chat').classList.toggle('on', !!prefs.chatVisible);

  $('btn-mode-editor').classList.toggle('active', prefs.viewMode === 'editor');
  $('btn-mode-split').classList.toggle('active', prefs.viewMode === 'split');
  $('btn-mode-preview').classList.toggle('active', prefs.viewMode === 'preview');
  $('sb-split-dir').textContent = prefs.splitDir === 'v' ? tr('set.vertical') : tr('set.horizontal');
  $('sb-wrap').classList.toggle('on', prefs.lineWrap);
  $('sb-sidebar').classList.toggle('on', prefs.sidebarVisible);
  if (editor) {
    editor.setWrap(prefs.lineWrap);
    editor.setLineNumbers(prefs.lineNumbers);
    // 预览模式：块级 WYSIWYG（非活动块真渲染，活动块源码编辑）
    editor.setWysiwyg(prefs.viewMode === 'preview');
  }
  // 分屏模式的右侧 preview-pane 需要渲染；预览模式走编辑器内 WYSIWYG，不需要
  // 分屏切换后 CM 尺寸变了要 refresh，否则光标定位会漂
  if (prefs.viewMode === 'split') scheduleRender();
  setTimeout(() => editor && editor.refresh(), 30);
}

// 编辑器右键：用应用自己的中文菜单替代 WebView 原生（英文）菜单
function editorContextMenu({ x, y, hasSelection, editor: cm, actions }) {
  const cut = async () => {
    const text = cm.getSelection();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); cm.replaceSelection(''); } catch (_) { cm.execCommand('cut'); }
  };
  const copy = async () => {
    const text = cm.getSelection();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch (_) { cm.execCommand('copy'); }
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) cm.replaceSelection(text);
    } catch (_) {
      toast(tr('edit.pasteFail'), { error: true });
    }
  };
  const items = [
    { label: tr('edit.undo'), hint: '⌘Z', onClick: () => cm.execCommand('undo') },
    { label: tr('edit.redo'), hint: '⇧⌘Z', onClick: () => cm.execCommand('redo') },
    { sep: true },
    { label: tr('edit.cut'), hint: '⌘X', disabled: !hasSelection, onClick: cut },
    { label: tr('edit.copy'), hint: '⌘C', disabled: !hasSelection, onClick: copy },
    { label: tr('edit.paste'), hint: '⌘V', onClick: paste },
    { label: tr('edit.selectAll'), hint: '⌘A', onClick: () => cm.execCommand('selectAll') },
    { sep: true },
    { label: tr('edit.bold'), hint: '⌘B', onClick: () => actions.bold() },
    { label: tr('edit.italic'), hint: '⌘I', onClick: () => actions.italic() },
    { label: tr('edit.inlineCode'), onClick: () => actions.code() },
    { label: tr('edit.insertLink'), onClick: () => actions.link() },
    { sep: true },
    { label: tr('edit.h1'), onClick: () => actions.h1() },
    { label: tr('edit.h2'), onClick: () => actions.h2() },
    { label: tr('edit.ul'), onClick: () => actions.ul() },
    { label: tr('edit.task'), onClick: () => actions.task() },
    { label: tr('edit.quote'), onClick: () => actions.quote() },
  ];
  ui.showContextMenu(x, y, items);
}

function setViewMode(mode) {
  prefs.viewMode = mode;
  savePrefs();
  applyLayout();
}

function switchSplitDir() {
  prefs.splitDir = prefs.splitDir === 'v' ? 'h' : 'v';
  savePrefs();
  applyLayout();
}

/* ================================================================= 标签 */
function createTab({ path = null, name, doc = '' }) {
  const tab = {
    id: uid(),
    path,
    name: name || (path ? basename(path) : tr('untitledDoc', { n: state.untitledSeq++ })),
    doc,
    savedDoc: doc,
    dirty: false,
    cursor: null,
    mtime: 0,
  };
  state.tabs.push(tab);
  return tab;
}

function renderTabs() {
  tabs.render(state.tabs, state.activeId);
  updateEmpty();
}

async function activateTab(id, { line = 0 } = {}) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  const prev = activeTab();
  if (prev) prev.cursor = editor.cm.getCursor();
  state.activeId = id;
  editor.find.clear();
  editor.setDocument(tab.doc, tab.cursor);
  editor.setModeForPath(tab.path || 'untitled.md');
  editor.redecorate();
  renderTabs();
  updateStatusbar();
  tree.setActive(tab.path);
  scheduleRender(true);
  if (line) {
    setTimeout(() => {
      editor.scrollToLine(line);
      preview.scrollToLine(line);
    }, 80);
  }
  saveSessionNow();
  if (prefs.viewMode !== 'preview') editor.focus();
}

async function openPath(path, { line = 0 } = {}) {
  if (!path) return;
  try {
    if (await ipc.isDirectory(path)) {
      await setWorkspace(path);
      return;
    }
    const existing = state.tabs.find((t) => t.path === path);
    if (existing) {
      await activateTab(existing.id, { line });
      return;
    }
    const content = await ipc.readFile(path);
    const meta = await ipc.fileMeta(path);
    const tab = createTab({ path, name: basename(path), doc: content });
    tab.mtime = meta ? meta.mtime : 0;
    await activateTab(tab.id, { line });
    pushRecent(path);
  } catch (e) {
    ui.toast(ipc.describeError(e), { error: true });
  }
}

function newFile() {
  const tab = createTab({ doc: '' });
  activateTab(tab.id);
  renderTabs();
}

async function saveTab(tab = activeTab(), { as = false } = {}) {
  if (!tab) return false;
  let path = tab.path;
  try {
    if (!path || as) {
      const suggested = path || `${tab.name}`;
      path = await ipc.pickSavePath(suggested, [{ name: 'Markdown', extensions: ['md', 'markdown'] }]);
      if (!path) return false;
    }
    await ipc.writeFile(path, tab.doc);
    tab.path = path;
    tab.name = basename(path);
    tab.savedDoc = tab.doc;
    tab.dirty = false;
    const meta = await ipc.fileMeta(path);
    tab.mtime = meta ? meta.mtime : 0;
    pushRecent(path);
    renderTabs();
    updateStatusbar();
    tree.setActive(path);
    if (state.workspace && path.startsWith(state.workspace)) tree.refresh();
    saveSessionNow();
    clearTimeout(autoSaveTimer); // 手动已保存，取消待执行的自动保存
    autoSaveSeq++;
    ui.toast(tr('saved'));
    return true;
  } catch (e) {
    ui.toast(ipc.describeError(e), { error: true });
    return false;
  }
}

/* ================================================================= 自动保存 */
// 设计：静默写盘（不弹框/不弹 toast），只处理已保存到磁盘的标签。
// 护栏：写前校验 tab.doc 仍是触发时的内容（避免覆盖期间的新编辑）；
//       写后更新 tab.mtime 与 savedDoc，防止文件监听误报「被其他程序修改」。
let autoSaveTimer = null;
let autoSaveSeq = 0;

async function autoSaveTab(tab, expectedDoc) {
  if (!tab || !tab.path || tab.doc !== expectedDoc || !tab.dirty) return;
  // 外部程序刚改过磁盘且我们还没同步：不覆盖（mtime 与已知值不符）
  try {
    const meta = await ipc.fileMeta(tab.path).catch(() => null);
    if (meta && tab.mtime && meta.mtime !== tab.mtime) return;
  } catch (_) {}
  try {
    const snapshot = tab.doc;
    await ipc.writeFile(tab.path, snapshot);
    // 校验：写盘期间用户又编辑了 → 不更新脏标记，让下一轮自动保存接手
    if (tab.doc !== snapshot) return;
    tab.savedDoc = snapshot;
    tab.dirty = false;
    const m = await ipc.fileMeta(tab.path).catch(() => null);
    tab.mtime = m ? m.mtime : 0;
    renderTabs();
    updateStatusbar();
    if (tab.id === state.activeId) showSavedHint();
  } catch (e) {
    console.warn('自动保存失败:', e);
  }
}

function scheduleAutoSave() {
  if (!prefs.autoSave) return;
  clearTimeout(autoSaveTimer);
  const seq = ++autoSaveSeq;
  const tab = activeTab();
  if (!tab || !tab.path || !tab.dirty) return;
  const expectedDoc = tab.doc;
  autoSaveTimer = setTimeout(() => {
    if (seq === autoSaveSeq) autoSaveTab(tab, expectedDoc);
  }, 1500);
}

let savedHintTimer = null;
function showSavedHint() {
  const el = $('sb-dirty');
  if (!el) return;
  el.textContent = tr('status.autoSaved');
  el.classList.remove('hidden');
  el.classList.remove('dirty');
  clearTimeout(savedHintTimer);
  savedHintTimer = setTimeout(() => {
    el.textContent = tr('status.dirty');
    el.classList.add('dirty');
    updateStatusbar();
  }, 1600);
}

async function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  if (tab.dirty) {
    const ok = await ipc.confirmDialog(tr('main.closeUnsaved', { n: tab.name }), {
      title: tr('main.closeTabTitle'),
      kind: 'warning',
    });
    if (!ok) return;
  }
  state.tabs.splice(idx, 1);
  if (state.activeId === id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    if (next) {
      state.activeId = null;
      await activateTab(next.id);
    } else {
      state.activeId = null;
      editor.setDocument('', { line: 0, ch: 0 });
      $('preview').innerHTML = '';
      renderTabs();
      updateStatusbar();
    }
  } else {
    renderTabs();
  }
  saveSessionNow();
}

function reorderTabs(fromId, toId) {
  const from = state.tabs.findIndex((t) => t.id === fromId);
  const to = state.tabs.findIndex((t) => t.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = state.tabs.splice(from, 1);
  state.tabs.splice(to, 0, moved);
  renderTabs();
  saveSessionNow();
}

/* ================================================================= 渲染与同步 */
function scheduleRender(immediate = false) {
  clearTimeout(state.renderTimer);
  const run = async () => {
    const tab = activeTab();
    if (!tab) {
      $('preview').innerHTML = '';
      buildOutline([]);
      return;
    }
    const snapshot = tab.id;
    const outline = await preview.render(tab.doc, { docPath: tab.path });
    if (state.activeId !== snapshot) return;
    buildOutline(outline || []);
  };
  if (immediate) run();
  else state.renderTimer = setTimeout(run, 170);
}

function buildOutline(items) {
  const host = $('outline');
  host.innerHTML = '';
  if (!items.length) {
    host.innerHTML = tr('main.outlineEmpty');
    return;
  }
  for (const item of items) {
    const a = document.createElement('div');
    a.className = 'outline-item';
    a.dataset.level = String(item.level);
    a.dataset.line = String(item.line);
    a.textContent = item.text || tr('main.emptyHeading');
    a.title = item.text;
    a.addEventListener('click', () => {
      editor.scrollToLine(item.line);
      preview.scrollToLine(item.line);
      host.querySelectorAll('.outline-item.active').forEach((n) => n.classList.remove('active'));
      a.classList.add('active');
    });
    host.appendChild(a);
  }
}

function lockSync(ms = 120) {
  state.syncLock = Date.now() + ms;
}

function onEditorScroll() {
  if (Date.now() < state.syncLock) return;
  if (prefs.viewMode !== 'split') return;
  lockSync();
  const info = editor.getScrollInfo();
  const line = editor.lineAtHeight(info.top, 'local') + 1;
  const lineTop = editor.heightAtLine(line - 1, 'local');
  const lineBottom = editor.heightAtLine(line, 'local');
  const frac = lineBottom > lineTop ? (info.top - lineTop) / (lineBottom - lineTop) : 0;
  preview.syncFromLine(line, Math.max(0, Math.min(1, frac)));
  highlightOutline(line);
}

function onPreviewScroll() {
  if (Date.now() < state.syncLock) return;
  if (prefs.viewMode !== 'split') return;
  if ($('findbar').classList.contains('hidden') === false) return; // 查找时别抢焦点
  lockSync();
  const { line, fraction } = preview.topLineInfo();
  const top = editor.heightAtLine(Math.max(0, line - 1), 'local');
  const bottom = editor.heightAtLine(line, 'local');
  editor.cm.scrollTo(null, top + (bottom - top) * fraction);
  highlightOutline(line);
}

function highlightOutline(line) {
  const items = $('outline').querySelectorAll('.outline-item');
  let best = null;
  for (const item of items) {
    if (Number(item.dataset.line) <= line) best = item;
    else break;
  }
  items.forEach((i) => i.classList.remove('active'));
  if (best) best.classList.add('active');
}

/* ================================================================= 状态栏 */
function updateStatusbar() {
  const tab = activeTab();
  const pathEl = $('sb-path');
  if (!tab) {
    pathEl.textContent = tr('untitled');
    $('sb-words').textContent = tr('main.words', { n: 0 });
    $('sb-cursor').textContent = tr('main.cursor', { l: 1, c: 1 });
    $('sb-dirty').classList.add('hidden');
    return;
  }
  pathEl.textContent = tab.path || tab.name;
  pathEl.title = tab.path || tab.name;
  const dirtyEl = $('sb-dirty');
  dirtyEl.textContent = tr('status.dirty');
  dirtyEl.classList.add('dirty');
  dirtyEl.classList.toggle('hidden', !tab.dirty);
  const chars = tab.doc.replace(/\s/g, '').length;
  $('sb-words').textContent = tr('main.words', { n: chars.toLocaleString() });
}

function updateCursor({ line, ch, selected }) {
  $('sb-cursor').textContent = selected ? tr('main.cursorSel', { l: line, c: ch, s: selected }) : tr('main.cursor', { l: line, c: ch });
}

function updateEmpty() {
  const has = state.tabs.length > 0;
  $('empty-state').classList.toggle('hidden', has);
  $('workspace').classList.toggle('no-doc', !has);
  // CodeMirror 在隐藏容器里初始化时量不到高度，一旦显示必须重新测量，
  // 否则会「文档有内容但编辑区一片空白」。
  if (has) setTimeout(() => editor && editor.refresh(), 20);
  if (has) return;
  const recent = (session.recent || []).slice(0, 5);
  const host = $('recent-list');
  host.innerHTML = '';
  if (!recent.length) return;
  const title = document.createElement('div');
  title.className = 'recent-title';
  title.textContent = tr('main.recent');
  host.appendChild(title);
  for (const p of recent) {
    const b = document.createElement('button');
    b.className = 'recent-item';
    b.textContent = p;
    b.title = p;
    b.addEventListener('click', () => openPath(p));
    host.appendChild(b);
  }
}

/* ================================================================= 工作区 */
async function setWorkspace(dir) {
  state.workspace = dir;
  $('workspace-name').textContent = basename(dir) || dir;
  $('workspace-name').title = dir || '';
  await tree.setRoot(dir);
  if (quickopen) quickopen.invalidate();
  try {
    await ipc.stopWatch();
    if (dir) await ipc.watchFolder(dir);
  } catch (e) {
    /* 监听失败不影响编辑，只是文件树不会自动刷新 */
    console.warn('监听目录失败', e);
  }
  saveSessionNow();
}

/* ================================================================= 会话 */
function saveSessionNow() {
  saveSession({
    workspace: state.workspace,
    activeIndex: Math.max(0, state.tabs.findIndex((t) => t.id === state.activeId)),
    tabs: state.tabs.map((t) => ({
      path: t.path,
      name: t.name,
      dirty: t.dirty,
      doc: t.dirty || !t.path ? t.doc : '',
    })),
  });
}

async function restoreSession() {
  const saved = session.tabs || [];
  for (const entry of saved) {
    if (entry.path) {
      try {
        const content = await ipc.readFile(entry.path);
        const meta = await ipc.fileMeta(entry.path);
        let doc = content;
        if (entry.doc) doc = entry.doc; // 上次退出时有未保存改动：保留工作现场
        const tab = createTab({ path: entry.path, name: entry.name, doc });
        tab.mtime = meta ? meta.mtime : 0;
        tab.dirty = doc !== content;
        tab.savedDoc = content;
      } catch (_) {
        /* 上次的文件可能已被移走：跳过 */
      }
    } else if (entry.doc) {
      createTab({ name: entry.name, doc: entry.doc });
    }
  }
  if (state.workspace) await setWorkspace(state.workspace);
  renderTabs();
  if (state.tabs.length) {
    const idx = Math.min(session.activeIndex || 0, state.tabs.length - 1);
    await activateTab(state.tabs[idx].id);
  } else {
    updateStatusbar();
  }
}

/* ================================================================= 图片 */
async function handleImageInsert({ bytes, ext }) {
  const tab = activeTab();
  if (!tab) return '';
  if (!tab.path) {
    ui.toast(tr('main.saveBeforeImage'), { error: true });
    return '';
  }
  try {
    const dir = dirname(tab.path) + '/assets';
    const info = await ipc.saveImageToAssets(bytes, ext, dir);
    return `![${info.filename}](assets/${info.filename})`;
  } catch (e) {
    ui.toast(ipc.describeError(e), { error: true });
    return '';
  }
}

/* ================================================================= 查找替换 */
function setupFind() {
  const bar = $('findbar');
  const input = $('find-input');
  const replaceInput = $('replace-input');
  const count = $('find-count');

  const run = (focusFirst = true) => {
    const n = editor.find.search(input.value);
    count.textContent = input.value ? (n ? `${Math.max(1, editor.find.index + 1)}/${n}` : tr('noResult')) : '';
    if (n && focusFirst) editor.find.focusHit(0);
  };

  const open = (withReplace = false) => {
    bar.classList.remove('hidden');
    const tab = activeTab();
    if (tab) {
      const sel = editor.cm.getSelection();
      if (sel && !sel.includes('\n')) input.value = sel;
    }
    run(false);
    (withReplace ? replaceInput : input).focus();
    (withReplace ? replaceInput : input).select();
  };
  const close = () => {
    bar.classList.add('hidden');
    editor.find.clear();
    editor.focus();
  };

  input.addEventListener('input', () => run(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      next(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  const next = (dir) => {
    const n = editor.find.hits.length;
    if (!n) return;
    editor.find.focusHit(editor.find.index + dir);
    count.textContent = `${editor.find.index + 1}/${n}`;
  };
  $('find-next').addEventListener('click', () => next(1));
  $('find-prev').addEventListener('click', () => next(-1));
  $('find-close').addEventListener('click', close);
  $('find-replace').addEventListener('click', () => {
    if (!input.value) return;
    if (editor.find.replaceCurrent(replaceInput.value)) {
      run(true);
    }
  });
  $('find-replace-all').addEventListener('click', () => {
    if (!input.value) return;
    const n = editor.find.replaceAll(replaceInput.value);
    ui.toast(tr('main.replaced', { n: n }));
    run(true);
  });

  return { open, close, isOpen: () => !bar.classList.contains('hidden') };
}

/* ================================================================= 菜单 */
/** 焦点是否在「非编辑器」的文本输入控件里（Agent 对话栏 / 设置输入框 / 其它 contenteditable）。
 *  原生菜单快捷键（⌘V/⌘C/⌘A 等）在 WebView 里全局触发；前端 document keydown 也是全局的。
 *  若焦点在这些控件里，编辑器快捷键必须让位，否则会误写到文档或误触发应用动作。
 *  CM6 编辑器自身（.cm-editor / .cm-content）不算——它里面的 ⌘B/I/K 应正常作用于文档。 */
function focusInTextField() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.closest && el.closest('.cm-editor')) return false; // 编辑器内，快捷键照常作用于文档
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return false;
}

/** 原生菜单项点击分发：菜单 id → 应用动作（与工具栏/快捷键共用同一批函数）。
 *  菜单不再绑定 accelerator，事件只来自用户主动点击，直接执行即可；
 *  ⌘ 快捷键统一由 setupShortcuts 的前端 keydown 处理。 */
function handleMenuAction(id) {
  const cm = editor && editor.cm;
  switch (id) {
    case 'file.new': return newFile();
    case 'file.open': return pickAndOpen();
    case 'file.open_folder': return pickFolderAndOpen();
    case 'file.save': return saveTab();
    case 'file.save_as': return saveTab(activeTab(), { as: true });
    case 'file.export_html': return doExport('html');
    case 'file.export_png': return doExport('png');
    case 'file.export_pdf': return doExport('pdf');
    case 'file.close': return state.activeId && closeTab(state.activeId);
    case 'edit.undo': return cm && cm.execCommand('undo');
    case 'edit.redo': return cm && cm.execCommand('redo');
    case 'edit.cut': return cm && navigator.clipboard.writeText(cm.getSelection()).then(() => cm.replaceSelection(''));
    case 'edit.copy': return cm && navigator.clipboard.writeText(cm.getSelection());
    case 'edit.paste': return cm && navigator.clipboard.readText().then((t) => cm.replaceSelection(t)).catch(() => {});
    case 'edit.select_all': return cm && cm.execCommand('selectAll');
    case 'edit.find': return find && find.open(false);
    case 'edit.find_in_files': return selectPane('search');
    case 'edit.settings': return openSettings();
    case 'view.editor': return setViewMode('editor');
    case 'view.split': return setViewMode('split');
    case 'view.preview': return setViewMode('preview');
    case 'view.sidebar':
      prefs.sidebarVisible = !prefs.sidebarVisible;
      savePrefs();
      applyLayout();
      return;
    case 'view.outline': return selectPane('outline');
    case 'view.devtools': return ipc.openDevtools().catch(() => {});
    case 'help.shortcuts': return openSettings({ section: 'about' });
    default: return undefined;
  }
}

function openMoreMenu() {
  const anchor = $('btn-menu');
  ui.showMenu(anchor, [
    { label: tr('menu.new'), hint: '⌘N', onClick: () => newFile() },
    { label: tr('menu.openFile'), hint: '⌘O', onClick: () => pickAndOpen() },
    { label: tr('menu.openFolder'), onClick: () => pickFolderAndOpen() },
    { label: tr('menu.chatTemplate'), hint: '⌘J', onClick: () => chat && chat.openEditor(null, { source: 'shortcut' }) },
    { sep: true },
    { label: tr('menu.save'), hint: '⌘S', onClick: () => saveTab() },
    { label: tr('menu.saveAs'), hint: '⇧⌘S', onClick: () => saveTab(activeTab(), { as: true }) },
    { label: tr('menu.history'), onClick: () => historyPanel && historyPanel.open() },
    { sep: true },
    { title: tr('menu.export') },
    { label: tr('menu.exportHtml'), onClick: () => doExport('html') },
    { label: tr('menu.exportPng'), onClick: () => doExport('png') },
    { label: tr('menu.exportPdf'), onClick: () => doExport('pdf') },
    { label: tr('menu.copyRich'), onClick: () => exporters.copyRichHTML($('preview')) },
    { sep: true },
    { label: tr('menu.settings'), hint: '⌘,', onClick: () => openSettings() },
    { label: tr('menu.quickOpen'), hint: '⌘P', onClick: () => quickopen.open() },
    { sep: true },
    { label: tr('menu.devtools'), onClick: () => ipc.openDevtools().catch(() => {}) },
    { label: tr('menu.quit'), danger: true, onClick: () => ipc.quitApp().catch(() => {}) },
  ]);
}

function tabMenu(tab, x, y) {
  ui.showContextMenu(x, y, [
    { label: tr('tab.close'), hint: '⌘W', onClick: () => closeTab(tab.id) },
    {
      label: tr('tab.closeOthers'),
      onClick: () => {
        const keep = tab.id;
        state.tabs.filter((t) => t.id !== keep).forEach((t) => {
          if (!t.dirty) state.tabs.splice(state.tabs.indexOf(t), 1);
        });
        activateTab(keep);
        renderTabs();
        saveSessionNow();
      },
    },
    { sep: true },
    {
      label: tr('tab.copyPath'),
      onClick: () => tab.path && navigator.clipboard.writeText(tab.path).then(() => ui.toast(tr('toast.pathCopied'))),
    },
    {
      label: tr('tab.reveal'),
      onClick: () => tab.path && ipc.revealInFolder(tab.path, false).catch(() => {}),
    },
  ]);
}

async function pickAndOpen() {
  const files = await ipc.pickFiles();
  for (const f of files) await openPath(f);
}

async function pickFolderAndOpen() {
  const dir = await ipc.pickFolder();
  if (dir) await setWorkspace(dir);
}

async function doExport(kind) {
  const tab = activeTab();
  if (!tab) {
    ui.toast(tr('toast.noDoc'), { error: true });
    return;
  }
  const base = (tab.path || tab.name).replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');
  try {
    if (kind === 'html') await exporters.exportHTML({ previewEl: $('preview'), title: tab.name, defaultPath: `${base}.html` });
    else if (kind === 'png') await exporters.exportPNG({ previewEl: $('preview'), defaultPath: `${base}.png` });
    else if (kind === 'pdf') await exporters.exportPDF({ previewEl: $('preview'), defaultPath: `${base}.pdf` });
  } catch (e) {
    console.error(e);
    ui.toast(tr('main.exportFail') + (e && e.message ? e.message : e), { error: true });
  }
}

/* ================================================================= 设置 */
function openSettings(opts) {
  $('settings').classList.remove('hidden');
  settings.open(opts);
}

function onPrefChange(key, value) {
  if (key === '__reset__') {
    // 语言重置为中文：同步 i18n 与原生菜单
    if (uiLocale() !== prefs.language) setLocale(prefs.language).catch(() => {});
    applyTheme();
    applyFonts();
    applyLayout();
    scheduleRender(true);
    return;
  }
  if (key === 'theme') {
    applyTheme();
    if (preview && activeTab()) scheduleRender(true);
  }
  else if (['editorFont', 'editorSize', 'previewFont', 'previewSize', 'codeFont', 'codeSize'].includes(key)) applyFonts();
  else if (['viewMode', 'splitDir', 'sidebarVisible'].includes(key)) applyLayout();
  else if (key === 'lineWrap' || key === 'lineNumbers') applyLayout();
  else if (key === 'autoPairs') editor.cm.setOption('autoCloseBrackets', value);
  else if (key === 'autoSave') {
    if (!value) {
      clearTimeout(autoSaveTimer);
      autoSaveSeq++;
    } else {
      scheduleAutoSave();
    }
  }
  else if (key === 'spellcheck') editor.setSpellcheck(value);
  else if (key === 'softBreaks') scheduleRender(true);
}

/* ================================================================= 快捷键 */
function setupShortcuts() {
  const mod = (e) => (state.os === 'macos' ? e.metaKey : e.ctrlKey);

  document.addEventListener('keydown', (e) => {
    if (ui.lightboxOpen()) {
      if (e.key === 'Escape') {
        ui.closeLightbox();
        e.preventDefault();
      }
      return;
    }
    if (!$('settings').classList.contains('hidden')) {
      if (e.key === 'Escape') {
        $('settings').classList.add('hidden');
        e.preventDefault();
      }
      return;
    }
    if (quickopen.isOpen()) return;

    // 焦点在 Agent 对话栏 / 设置输入框等文本控件时，编辑器/视图类 ⌘ 快捷键要跳过
    // （否则在输入框里按 ⌘B 会加粗文档、⌘= 会改字号）；应用级动作（新建/打开/保存/
    // 设置）保留全局可用。
    const skipEditorKeys = mod(e) && focusInTextField();
    // 这些键只作用于编辑器/视图，焦点在文本输入控件时必须让位给控件原生行为
    const EDITOR_ONLY_KEYS = ['b', 'i', 'k', '=', '+', '-', '\\', 'j', 'l'];
    if (skipEditorKeys && EDITOR_ONLY_KEYS.includes(e.key.toLowerCase())) return;

    if (mod(e) && !e.shiftKey) {
      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          newFile();
          return;
        case 'o':
          e.preventDefault();
          pickAndOpen();
          return;
        case 's':
          e.preventDefault();
          saveTab();
          return;
        case 'w':
          e.preventDefault();
          if (state.activeId) closeTab(state.activeId);
          return;
        case 'p':
          e.preventDefault();
          quickopen.open();
          return;
        case 'f':
          e.preventDefault();
          find.open(false);
          return;
        case 'b':
          e.preventDefault();
          editor.actions.bold();
          return;
        case 'i':
          e.preventDefault();
          editor.actions.italic();
          return;
        case 'k':
          e.preventDefault();
          editor.actions.link();
          return;
        case ',':
          e.preventDefault();
          openSettings();
          return;
        case 'j':
          e.preventDefault();
          if (chat) chat.openEditor(null, { source: 'shortcut' });
          return;
        case 'l':
          e.preventDefault();
          if (chat) chat.toggle();
          return;
        case '=':
        case '+':
          e.preventDefault();
          prefs.editorSize = Math.min(28, prefs.editorSize + 1);
          prefs.previewSize = Math.min(28, prefs.previewSize + 1);
          savePrefs();
          applyFonts();
          return;
        case '-':
          e.preventDefault();
          prefs.editorSize = Math.max(11, prefs.editorSize - 1);
          prefs.previewSize = Math.max(11, prefs.previewSize - 1);
          savePrefs();
          applyFonts();
          return;
        case '\\':
          e.preventDefault();
          switchSplitDir();
          return;
        default:
          break;
      }
    }

    if (mod(e) && e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        saveTab(activeTab(), { as: true });
        return;
      }
      if (k === 'f') {
        e.preventDefault();
        selectPane('search');
        search.focus();
        return;
      }
      if (k === 'p') {
        e.preventDefault();
        openMoreMenu();
        return;
      }
      if (k === 'e') {
        e.preventDefault();
        doExport('html');
        return;
      }
    }

    if (e.key === 'Escape') {
      if (!$('findbar').classList.contains('hidden')) findByCtl.close();
    }
  });
}

let findByCtl = null;

/* ================================================================= 侧栏 */
function selectPane(name) {
  prefs.sidebarPane = name;
  prefs.sidebarVisible = true;
  savePrefs();
  document.querySelectorAll('.side-tab').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  document.querySelectorAll('.side-body .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  applyLayout();
}

/* ================================================================= 启动 */
async function boot() {
  state.os = await ipc.getPlatform().catch(() => 'linux');
  document.documentElement.dataset.os = state.os;

  applyTheme();
  applyFonts();

  // 编辑器
  editor = createEditor({
    textarea: $('editor'),
    prefs,
    onTaskToggle: (line, checked) => toggleTask(line, checked),
    onImageClick: (src) => ui.openLightbox(src),
    onOpenFile: (path, opts) => openPath(path, opts || {}),
    onChange: (doc) => {
      const tab = activeTab();
      if (!tab) return;
      const wasDirty = tab.dirty;
      tab.doc = doc;
      tab.dirty = doc !== tab.savedDoc;
      if (wasDirty !== tab.dirty) {
        renderTabs();
        updateStatusbar();
      } else {
        updateStatusbar();
      }
      saveSessionNow();
      scheduleAutoSave();
      scheduleRender(false);
    },
    onCursor: updateCursor,
    onScroll: onEditorScroll,
    onImage: handleImageInsert,
    onContextMenu: editorContextMenu,
  });

  // 即时渲染里内嵌图片：把 Markdown 里的相对路径解析成本地文件，交给 Tauri 的 asset 协议加载
  editor.setResolveImage((src) => {
    if (/^(https?:|data:|asset:|blob:)/i.test(src)) return src;
    const tab = activeTab();
    const base = tab && tab.path ? dirname(tab.path) : '';
    return ipc.convertFileSrc(resolvePath(base, src));
  });

  // 预览
  preview = createPreview({
    el: $('preview'),
    scrollEl: $('preview-scroll'),
    prefs,
    onOpenFile: (path, opts) => openPath(path, opts || {}),
    onTaskToggle: (line, checked) => toggleTask(line, checked),
    onImageClick: (src) => ui.openLightbox(src),
  });
  $('preview').addEventListener('click', (e) => preview.handleClick(e));
  $('preview-scroll').addEventListener('scroll', onPreviewScroll, { passive: true });

  // 预览区右键：同样用中文菜单替代 WebView 原生英文菜单
  $('preview').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const img = e.target.closest('img');
    const link = e.target.closest('a');
    const selected = String(window.getSelection() || '').trim();
    const items = [];
    if (selected) {
      items.push({ label: tr('main.copySelection'), onClick: () => navigator.clipboard.writeText(selected).catch(() => {}) });
      items.push({ sep: true });
    }
    if (img) {
      const src = img.dataset.localPath || img.src;
      items.push({ label: tr('edit.viewImage'), onClick: () => ui.openLightbox(img.src) });
      items.push({ label: tr('main.copyImagePath'), onClick: () => navigator.clipboard.writeText(src).catch(() => {}) });
      items.push({ sep: true });
    }
    if (link) {
      const href = link.getAttribute('href') || '';
      if (href) {
        items.push({ label: tr('edit.copyLink'), onClick: () => navigator.clipboard.writeText(href).catch(() => {}) });
        if (/^https?:/i.test(href)) {
          items.push({ label: tr('main.openInBrowser'), onClick: () => ipc.openPath(href).catch(() => {}) });
        }
        items.push({ sep: true });
      }
    }
    items.push({ label: tr('main.selectAllPreview'), onClick: () => {
      const range = document.createRange();
      range.selectNodeContents($('preview'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } });
    ui.showContextMenu(e.clientX, e.clientY, items);
  });

  // 标签
  tabs = createTabs({
    el: $('tabstrip'),
    onSelect: (id) => {
      if (id !== state.activeId) activateTab(id);
    },
    onClose: (id) => closeTab(id),
    onMenu: (tab, x, y) => tabMenu(tab, x, y),
    onReorder: reorderTabs,
  });

  // 文件树
  session.save = () => saveSessionNow();
  tree = createTree({
    el: $('tree'),
    session,
    openFile: (p) => openPath(p),
    getActivePath: () => (activeTab() ? activeTab().path : null),
    onWorkspaceChanged: ({ removed, renamed }) => {
      if (removed) {
        const tab = state.tabs.find((t) => t.path === removed);
        if (tab) closeTab(tab.id);
      }
      if (renamed) {
        const [from, to] = renamed;
        for (const tab of state.tabs) {
          if (tab.path && tab.path.startsWith(from)) tab.path = to + tab.path.slice(from.length);
        }
        renderTabs();
      }
    },
  });

  // 搜索
  search = createSearch({
    input: $('search-input'),
    caseBox: $('search-case'),
    resultsEl: $('search-results'),
    getWorkspace: () => state.workspace,
    onOpen: (path, line) => openPath(path, { line }),
  });

  // 快速打开
  quickopen = createQuickOpen({
    overlay: $('quickopen'),
    input: $('quickopen-input'),
    list: $('quickopen-list'),
    getWorkspace: () => state.workspace,
    onOpen: (path) => openPath(path),
  });

  // 设置
  settings = createSettings({ body: $('settings-body'), onApply: onPrefChange });

  chat = createChat({
    editor,
    getContext: () => {
      const tab = activeTab();
      if (!tab) return null;
      return {
        path: tab.path,
        name: tab.name,
        doc: editor.getValue(),
        selection: editor.cm.getSelection(),
      };
    },
    getWorkspace: () => state.workspace,
    openSettings: (o) => openSettings(o),
    onVersionRecorded: recordVersion,
  });
  chat.setRefresh(() => editor && editor.refresh());
  chat.init();

  historyPanel = createHistoryPanel({
    editor,
    getDocKey: () => versionDocKey(),
    getDoc: () => editor.getValue(),
    isEnabled: () => !!prefs.historyEnabled,
  });

  $('editor-pane').appendChild($('findbar'));
  findByCtl = setupFind();

  // 按钮
  $('btn-new').addEventListener('click', () => newFile());
  $('btn-open').addEventListener('click', () => pickAndOpen());
  $('btn-folder').addEventListener('click', () => pickFolderAndOpen());
  $('btn-mode-editor').addEventListener('click', () => setViewMode('editor'));
  $('btn-mode-split').addEventListener('click', () => setViewMode('split'));
  $('btn-mode-preview').addEventListener('click', () => setViewMode('preview'));
  $('btn-chat').addEventListener('click', () => chat.toggle());
  $('sb-chat').addEventListener('click', () => chat.toggle());
  $('btn-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    openMoreMenu();
  });
  $('btn-tree-refresh').addEventListener('click', () => tree.refresh());
  $('empty-new').addEventListener('click', () => newFile());
  $('empty-open').addEventListener('click', () => pickAndOpen());
  $('empty-folder').addEventListener('click', () => pickFolderAndOpen());
  $('settings-close').addEventListener('click', () => $('settings').classList.add('hidden'));
  $('settings-reset').addEventListener('click', () => settings.reset());
  $('settings').addEventListener('pointerdown', (e) => {
    if (e.target === $('settings')) $('settings').classList.add('hidden');
  });

  document.querySelectorAll('.win-controls button').forEach((b) => {
    b.addEventListener('click', () => ipc.windowAction(b.dataset.win).catch(() => {}));
  });

  document.querySelectorAll('.side-tab').forEach((b) => {
    b.addEventListener('click', () => {
      selectPane(b.dataset.pane);
      if (b.dataset.pane === 'search') $('search-input').focus();
    });
  });

  $('sb-wrap').addEventListener('click', () => {
    prefs.lineWrap = !prefs.lineWrap;
    savePrefs();
    applyLayout();
  });
  $('sb-split-dir').addEventListener('click', () => switchSplitDir());
  $('sb-sidebar').addEventListener('click', () => {
    prefs.sidebarVisible = !prefs.sidebarVisible;
    savePrefs();
    applyLayout();
  });

  // 分隔条
  ui.dragSplitter($('splitter-side'), {
    onMove: (x) => {
      const w = Math.max(170, Math.min(460, x));
      prefs.sidebarWidth = w;
      document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
      editor.refresh();
    },
    onEnd: () => savePrefs(),
  });

  ui.dragSplitter($('splitter-chat'), {
    onMove: (x) => {
      const w = Math.max(300, Math.min(720, window.innerWidth - x));
      prefs.chatWidth = w;
      document.documentElement.style.setProperty('--chat-w', `${w}px`);
      if (editor) editor.refresh();
    },
    onEnd: () => savePrefs(),
  });

  ui.dragSplitter($('splitter-main'), {
    onMove: (x, y) => {
      const ws = $('workspace').getBoundingClientRect();
      const ratio = prefs.splitDir === 'v'
        ? ((y - ws.top) / ws.height) * 100
        : ((x - ws.left) / ws.width) * 100;
      prefs.splitRatio = Math.max(18, Math.min(86, ratio));
      $('workspace').style.setProperty('--split', `${prefs.splitRatio}%`);
      editor.refresh();
    },
    onEnd: () => savePrefs(),
  });

  setupShortcuts();
  ui.initLightbox();

  applyLayout();
  selectPane(prefs.sidebarPane || 'files');

  // 窗口/容器尺寸变化后 CM 需要重新测量（缩放窗口、切换分屏都会踩到）
  const ro = new ResizeObserver(() => editor && editor.refresh());
  ro.observe($('editor-host'));
  window.addEventListener('resize', () => editor && editor.refresh());

  // 拖入文件
  try {
    getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== 'drop') return;
      const paths = event.payload.paths || [];
      const pos = event.payload.position;
      if (chat && chat.isOpen() && pos) {
        const r = chat.contextRect();
        if (pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom) {
          await chat.addPaths(paths);
          return;
        }
      }
      for (const p of paths) await openPath(p);
    });
  } catch (_) {}

  // 原生菜单栏点击（Rust 端 emit 的 menu-action）
  listen('menu-action', (e) => handleMenuAction(String(e.payload || '')));

  // 单实例转交的文件
  listen('open-files', async (e) => {
    for (const p of e.payload || []) await openPath(p);
  });

  // 目录变化
  let fsTimer = null;
  listen('fs-changed', () => {
    clearTimeout(fsTimer);
    fsTimer = setTimeout(async () => {
      if (state.workspace) tree.refresh();
      await checkExternalChanges();
    }, 350);
  });

  await restoreSession();

  // 命令行/文件关联带进来的文件
  const args = await ipc.getCliArgs().catch(() => []);
  for (const a of args) await openPath(a);

  // 首次启动没有任何文档：打开内置的 welcome.md（跟参考实现一样，让人一上手就有东西可看）
  if (!state.tabs.length && !localStorage.getItem('feathermark.welcomed')) {
    localStorage.setItem('feathermark.welcomed', '1');
    try {
      const bundled = await ipc.readBundledFile('welcome.md');
      const tab = createTab({ path: bundled.path, name: 'welcome.md', doc: bundled.content });
      await activateTab(tab.id);
    } catch (e) {
      console.warn('内置示例文档未能打开', e);
    }
  }

  document.body.classList.remove('booting');
  try {
    await ipc.getCurrentWindow().show();
  } catch (_) {}

  if (!state.tabs.length) updateStatusbar();
  updateEmpty();
}

async function checkExternalChanges() {
  for (const tab of state.tabs) {
    if (!tab.path) continue;
    const meta = await ipc.fileMeta(tab.path).catch(() => null);
    if (!meta) continue;
    if (meta.mtime === tab.mtime) continue;
    if (tab.dirty) {
      ui.toast(tr('main.externalModified', { n: tab.name }), { error: true, duration: 3200 });
      tab.mtime = meta.mtime;
      continue;
    }
    try {
      const content = await ipc.readFile(tab.path);
      tab.doc = content;
      tab.savedDoc = content;
      tab.mtime = meta.mtime;
      if (tab.id === state.activeId) {
        const cursor = editor.cm.getCursor();
        editor.setDocument(content, cursor);
        scheduleRender(true);
      }
      ui.toast(tr('main.reloaded', { n: tab.name }));
    } catch (_) {}
  }
}

/** 点预览里的复选框，回写源码那一行的 [ ] / [x]。 */
function toggleTask(line, checked) {
  const tab = activeTab();
  if (!tab) return;
  const lines = tab.doc.split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return;
  const next = checked
    ? lines[idx].replace(/\[(\s*)\]/, '[x]')
    : lines[idx].replace(/\[[xX]\]/, '[ ]');
  if (next === lines[idx]) return;
  lines[idx] = next;
  const doc = lines.join('\n');
  const cursor = editor.cm.getCursor();
  editor.setDocument(doc, cursor);
  tab.doc = doc;
  tab.dirty = doc !== tab.savedDoc;
  updateStatusbar();
  renderTabs();
  scheduleRender(true);
}

boot().catch((e) => {
  console.error('启动失败', e);
  document.body.classList.remove('booting');
  ui.toast(tr('main.bootFail') + (e && e.message ? e.message : e), { error: true, duration: 5000 });
});
