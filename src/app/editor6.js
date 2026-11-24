// 编辑器层：CodeMirror 6 封装。
// 对外 API 与旧 CM5 版 editor.js 保持兼容，main.js 只需改 import。
// CM6 全局来自 window.CM6（build.mjs 打好的 iife）。
// 预览模式用 preview-editor.js 的 decoration 架构（Obsidian 式原生编辑）。
import { createPreviewEditor } from './preview-editor.js';
const { State, View, Language, Commands, LangMarkdown, Search, Autocomplete } = window.CM6;
const { EditorState, StateEffect, Compartment } = State;
const { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, ViewPlugin } = View;
const { defaultKeymap, history, historyKeymap, indentWithTab } = Commands;
const { markdown } = LangMarkdown;

const INDENT_UNIT = '  ';

/** CM6 命令：列表 Enter 续写（基础版：当前行标记续写 / 空项退出 / 有序递增）。 */
function continueListCM(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false; // 仅行尾续写
  const text = line.text;
  const m = text.match(/^(\s*)(>[> ]*|[-*+] \[[ xX]\]|[-*+]|(\d+)[.)])(\s+)/);
  if (!m) return false;
  const [indent, marker] = [m[1], m[2]];
  const rest = text.slice(m[0].length);
  if (!rest.trim()) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
    return true;
  }
  let next = marker;
  if (/^\d/.test(marker)) {
    const num = parseInt(m[3], 10);
    next = (num + 1) + marker.slice(String(num).length);
  } else if (/\[[xX]\]/.test(marker)) {
    next = marker.replace(/\[[xX]\]/, '[ ]');
  }
  const insert = '\n' + indent + next + (m[4] || ' ');
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + insert.length },
    scrollIntoView: true,
  });
  return true;
}

/** CM6 命令：Tab/Shift-Tab 缩进行（2 空格）。 */
function indentCM(view, more) {
  const sel = view.state.selection.main;
  const from = view.state.doc.lineAt(sel.from).from;
  const to = view.state.doc.lineAt(sel.to).to;
  const text = view.state.sliceDoc(from, to);
  const changed = more
    ? text.split('\n').map((l) => '  ' + l).join('\n')
    : text.split('\n').map((l) => l.replace(/^  |^\t/, '')).join('\n');
  view.dispatch({
    changes: { from, to, insert: changed },
    selection: { anchor: sel.from + (more ? 2 : -(text.startsWith('  ') ? 2 : 1)), head: sel.to + (changed.length - text.length) },
  });
  return true;
}

// ---- CM5 兼容 shim：把 CM6 EditorView 包装成旧代码期待的 cm 对象 ----
function makeCmShim(view) {
  const doc = () => view.state.doc;
  const lineAt = (n) => {
    const d = doc();
    const line = Math.max(0, Math.min(d.lines - 1, n));
    return d.line(line).text;
  };
  const posOf = (pos) => {
    const d = doc();
    const line = Math.max(0, Math.min(d.lines - 1, pos.line || 0));
    const l = d.line(line);
    return l.from + Math.min(pos.ch || 0, l.length);
  };
  const cursorObj = () => {
    const head = view.state.selection.main.head;
    const line = doc().lineAt(head);
    return { line: line.number, ch: head - line.from };
  };
  return {
    // 直接暴露 view 供高级用法（阶段 2 widget 等）
    cm6: view,
    getValue: () => doc().toString(),
    setValue(text) { view.dispatch({ changes: { from: 0, to: doc().length, insert: text } }); },
    getLine: (n) => lineAt(n),
    lineCount: () => doc().lines,
    getCursor: (which) => cursorObj(),
    getSelection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    setCursor(pos) {
      const p = posOf(pos);
      view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
      view.focus();
    },
    scrollTo(x, y) { view.scrollDOM.scrollTo(x, y); },
    focus: () => view.focus(),
    refresh: () => {}, // CM6 自动测量，无需 refresh
    getWrapperElement: () => view.dom,
    getScrollInfo: () => ({
      top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft,
      clientHeight: view.scrollDOM.clientHeight, height: view.scrollDOM.scrollHeight,
    }),
    scrollIntoView(pos) {
      const p = typeof pos === 'object' ? posOf(pos) : pos;
      view.dispatch({ selection: { anchor: p }, effects: EditorView.scrollIntoView(p, { y: 'center' }) });
    },
    setOption(k, v) { /* 阶段 1：行号/换行等在扩展层处理 */ },
    // 富文本操作占位（阶段 3 完善）
    replaceSelection(text) {
      const sel = view.state.selection.main;
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } });
    },
    execCommand(cmd) {
      if (cmd === 'cut' || cmd === 'copy') {
        const sel = view.state.selection.main;
        const text = view.state.sliceDoc(sel.from, sel.to);
        if (!text) return;
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
        if (cmd === 'cut') view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } });
      }
    },
  };
}

export function createEditor({ textarea, prefs, onTaskToggle, onImageClick, onOpenFile, onChange, onCursor, onScroll, onImage, onContextMenu }) {
  const host = textarea.parentNode;
  const initial = textarea.value || '';

  const previewCompartment = new Compartment();
  const previewEditor = createPreviewEditor({ State, View });
  let wwOn = false;

  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    markdown(),
    keymap.of([
      { key: 'Enter', run: continueListCM },
      { key: 'Tab', run: (v) => indentCM(v, true) },
      { key: 'Shift-Tab', run: (v) => indentCM(v, false) },
      ...defaultKeymap, ...historyKeymap, indentWithTab,
    ]),
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => {
      if (u.docChanged && onChange) onChange(u.state.doc.toString());
      if ((u.docChanged || u.selectionSet) && onCursor) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        onCursor({ line: line.number + 1, ch: head - line.from + 1, selected: u.state.selection.main.to - u.state.selection.main.from });
      }
    }),
    previewCompartment.of([]),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: initial, extensions }),
    parent: host,
  });
  textarea.style.display = 'none';
  const cm = makeCmShim(view);

  // ---- 右键：交给宿主中文菜单（CM6 默认无菜单） ----
  if (onContextMenu) {
    view.contentDOM.addEventListener('contextmenu', (e) => {
      const sel = view.state.selection.main;
      e.preventDefault();
      onContextMenu({ x: e.clientX, y: e.clientY, hasSelection: !sel.empty, editor: cm, actions });
    });
  }
  // ---- 粘贴图片：交给宿主处理（保存文件并插入路径） ----
  if (onImage) {
    view.contentDOM.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.indexOf('image') === 0) {
          const file = item.getAsFile();
          if (file) { e.preventDefault(); onImage(file); return; }
        }
      }
    });
    view.contentDOM.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length && files[0].type && files[0].type.indexOf('image') === 0) {
        e.preventDefault(); onImage(files[0]);
      }
    });
  }
  // ---- 滚动同步：通知宿主 ----
  if (onScroll) view.scrollDOM.addEventListener('scroll', onScroll);

  // ---- 查找替换：regex 扫描文档，用 CM6 selection 定位 ----
  const find = {
    marks: [], hits: [], index: -1, query: '',
    clear() { this.hits = []; this.index = -1; this.query = ''; this.marks = []; },
    search(q) {
      this.query = q; this.hits = []; this.index = -1;
      if (!q) return 0;
      const text = view.state.doc.toString();
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let m;
      while ((m = re.exec(text)) !== null) {
        this.hits.push({ from: m.index, to: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++; // 避免空匹配死循环
      }
      this.index = this.hits.length ? 0 : -1;
      return this.hits.length;
    },
    focusHit(i) {
      if (!this.hits.length) return;
      this.index = (i + this.hits.length) % this.hits.length;
      const h = this.hits[this.index];
      view.dispatch({ selection: { anchor: h.from, head: h.to }, effects: EditorView.scrollIntoView(h.from, { y: 'center' }) });
      view.focus();
    },
    replaceCurrent(replacement) {
      if (this.index < 0 || !this.hits[this.index]) return false;
      const h = this.hits[this.index];
      view.dispatch({ changes: { from: h.from, to: h.to, insert: replacement }, selection: { anchor: h.from + replacement.length } });
      return true;
    },
    replaceAll(replacement) {
      if (!this.hits.length) return 0;
      const changes = this.hits.map((h) => ({ from: h.from, to: h.to, insert: replacement }));
      view.dispatch({ changes });
      const n = this.hits.length;
      this.hits = []; this.index = -1;
      return n;
    },
  };

  // ---- 格式操作：给选区套 Markdown 标记 ----
  const wrapSelection = (before, after, placeholder) => {
    const sel = view.state.selection.main;
    const selected = view.state.sliceDoc(sel.from, sel.to) || placeholder;
    const insert = before + selected + after;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + before.length, head: sel.from + before.length + selected.length },
    });
    view.focus();
  };
  /** 给当前行首加前缀（标题/列表/引用/任务）。 */
  const prefixLine = (prefix) => {
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    view.dispatch({
      changes: { from: line.from, insert: prefix },
      selection: { anchor: sel.from + prefix.length, head: sel.to + prefix.length },
    });
    view.focus();
  };
  const actions = {
    bold() { wrapSelection('**', '**', '粗体文字'); },
    italic() { wrapSelection('*', '*', '斜体文字'); },
    code() { wrapSelection('`', '`', '代码'); },
    link() { wrapSelection('[', '](url)', '链接文字'); },
    h1() { prefixLine('# '); },
    h2() { prefixLine('## '); },
    ul() { prefixLine('- '); },
    task() { prefixLine('- [ ] '); },
    quote() { prefixLine('> '); },
  };

  return {
    cm, actions, find,
    getValue: () => view.state.doc.toString(),
    setDocument(text, cursor) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      if (cursor) cm.setCursor(cursor);
    },
    focus: () => view.focus(),
    refresh: () => {},
    setWrap(on) { /* 阶段 1 默认 wrap */ },
    setLineNumbers(on) { /* 阶段 1 默认开 */ },
    setEditorFont(font, size) {
      const dom = view.dom;
      if (font) dom.style.fontFamily = `"${font}", var(--font-mono)`;
      else dom.style.removeProperty('font-family');
      if (size) dom.style.fontSize = `${size}px`;
    },
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number + 1,
    scrollToLine(line, { center = true } = {}) {
      const ln = Math.max(1, Math.min(view.state.doc.lines, line));
      const pos = view.state.doc.line(ln).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: center ? 'center' : 'start' }) });
    },
    getScrollInfo: cm.getScrollInfo,
    // CM6 坐标 API：documentTop 为视口顶部对应的文档坐标，配合 lineBlockAt 换算
    lineAtHeight(y) {
      // y 是文档内坐标（CM5 lineAtHeight(y,'local') 的语义）。CM6 用坐标转位置。
      const box = view.contentDOM.getBoundingClientRect();
      const pos = view.posAtCoords({ x: box.left + 5, y: box.top + y });
      if (pos == null) return 1;
      return view.state.doc.lineAt(pos).number + 1;
    },
    heightAtLine(line) {
      const ln = Math.max(1, Math.min(view.state.doc.lines, line));
      const pos = view.state.doc.line(ln).from;
      const rect = view.lineBlockAt(pos);
      return rect ? rect.top : 0;
    },
    setModeForPath() {}, // markdown 模式固定，阶段 3 处理非 md 文件
    setSpellcheck(on) { view.contentDOM.spellcheck = !!on; },
    setLivePreview() {}, isLivePreview: () => false,
    setResolveImage() {}, redecorate() {},
    setWysiwyg(on) {
      if (wwOn === !!on) return;
      wwOn = !!on;
      const ext = wwOn
        ? previewEditor.createExtension({ renderer: window.UnifiedRenderer, hooks: {} })
        : [];
      view.dispatch({ effects: previewCompartment.reconfigure(ext) });
      view.dom.classList.toggle('cm-pv-on', wwOn);
    },
    isWysiwyg: () => wwOn,
  };
}
