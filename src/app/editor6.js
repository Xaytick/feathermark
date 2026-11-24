// 编辑器层：CodeMirror 6 封装（阶段 1）。
// 对外 API 与旧 CM5 版 editor.js 保持兼容，main.js 只需改 import。
// CM6 全局来自 window.CM6（build.mjs 打好的 iife）。
//
// 阶段 1 目标：源码视图可正常编辑、保存、滚动、光标、查找、格式操作。
// 阶段 2 会在此之上用 ViewPlugin + widget 实现预览模式真渲染直接编辑。
const { State, View, Language, Commands, LangMarkdown, Search, Autocomplete } = window.CM6;
const { EditorState, StateEffect } = State;
const { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, ViewPlugin } = View;
const { defaultKeymap, history, historyKeymap, indentWithTab } = Commands;
const { markdown } = LangMarkdown;

const INDENT_UNIT = '  ';

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
  };
}

export function createEditor({ textarea, prefs, onTaskToggle, onImageClick, onOpenFile, onChange, onCursor, onScroll, onImage, onContextMenu }) {
  const host = textarea.parentNode;
  const initial = textarea.value || '';

  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    markdown(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => {
      if (u.docChanged && onChange) onChange(u.state.doc.toString());
      if ((u.docChanged || u.selectionSet) && onCursor) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        onCursor({ line: line.number + 1, ch: head - line.from + 1, selected: u.state.selection.main.to - u.state.selection.main.from });
      }
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: initial, extensions }),
    parent: host,
  });
  textarea.style.display = 'none';
  const cm = makeCmShim(view);

  // 阶段 1 占位：find / actions / 富文本在阶段 3 用 CM6 原生实现
  const find = {
    marks: [], hits: [], index: -1, query: '',
    clear() { this.hits = []; this.index = -1; this.query = ''; },
    search(q) { this.query = q; this.hits = []; this.index = q ? 0 : -1; return this.hits.length; },
    focusHit(i) { this.index = i; },
    replaceCurrent() { return false; },
    replaceAll() { return 0; },
  };
  const actions = {
    bold() {}, italic() {}, link() {},
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
    setWysiwyg() {}, isWysiwyg: () => false, // 阶段 2 实现
  };
}
