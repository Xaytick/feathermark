// 编辑器层：CodeMirror 5 的封装。
// 只用 CM5（与参考实现一致）——CM6 的 markdown 支持要靠一堆扩展拼，而这个项目的
// 交互重心在「编辑 + 即时预览」，CM5 的模式/快捷键/查找光标 API 更直接。
const CM = window.CodeMirror;

export function createEditor({ textarea, prefs, onChange, onCursor, onScroll, onImage }) {
  const cm = CM.fromTextArea(textarea, {
    mode: 'gfm',
    theme: 'default',
    lineNumbers: prefs.lineNumbers,
    lineWrapping: prefs.lineWrap,
    styleActiveLine: true,
    indentUnit: 2,
    tabSize: 2,
    smartIndent: true,
    indentWithTabs: false,
    electricChars: false,
    autoCloseBrackets: prefs.autoPairs,
    matchBrackets: true,
    viewportMargin: 24,
    cursorBlinkRate: 530,
    spellcheck: !!prefs.spellcheck,
    extraKeys: {
      Tab: (editor) => {
        if (editor.somethingSelected()) editor.indentSelection('add');
        else editor.replaceSelection(' '.repeat(editor.getOption('tabSize')));
      },
      'Shift-Tab': (editor) => editor.indentSelection('subtract'),
      'Cmd-/': 'toggleComment',
      'Ctrl-/': 'toggleComment',
    },
  });

  cm.on('change', () => onChange && onChange(cm.getValue()));
  cm.on('cursorActivity', () => {
    if (!onCursor) return;
    const pos = cm.getCursor();
    const sel = cm.getSelection();
    onCursor({ line: pos.line + 1, ch: pos.ch + 1, selected: sel.length });
  });
  cm.on('scroll', () => onScroll && onScroll());
  cm.on('paste', (_, e) => handlePaste(e));
  cm.on('drop', (_, e) => handleDrop(e));

  async function bytesFromBlob(blob) {
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }

  function mimeToExt(mime) {
    const map = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'image/bmp': 'bmp',
    };
    return map[mime] || (mime.split('/')[1] || 'png').replace('+xml', '');
  }

  async function handlePaste(e) {
    if (!e.clipboardData) return;
    const items = Array.from(e.clipboardData.items || []);
    const imgItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!imgItem) return;
    e.preventDefault();
    const file = imgItem.getAsFile();
    if (!file) return;
    const bytes = await bytesFromBlob(file);
    const markdown = await onImage({ bytes, ext: mimeToExt(file.type), name: file.name });
    if (markdown) cm.replaceSelection(markdown);
  }

  async function handleDrop(_, e) {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const img = files.find((f) => f.type.startsWith('image/'));
    if (!img) return;
    e.preventDefault();
    const bytes = await bytesFromBlob(img);
    const markdown = await onImage({ bytes, ext: mimeToExt(img.type), name: img.name });
    if (markdown) cm.replaceSelection(markdown);
  }

  /* ---------------------------------------------------------------- 文本操作 */
  function wrapInline(before, after, placeholder) {
    const sel = cm.getSelection();
    if (sel) {
      cm.replaceSelection(before + sel + after);
      return;
    }
    const pos = cm.getCursor();
    const text = placeholder || '文本';
    cm.replaceSelection(before + text + after);
    cm.setSelection(
      { line: pos.line, ch: pos.ch + before.length },
      { line: pos.line, ch: pos.ch + before.length + text.length }
    );
    cm.focus();
  }

  function linePrefix(prefix, { toggle = true, ordered = false } = {}) {
    const from = cm.getCursor('from').line;
    const to = cm.getCursor('to').line;
    const lines = [];
    for (let i = from; i <= to; i++) lines.push(cm.getLine(i) || '');

    const matches = (text) => {
      if (ordered) return /^\s*\d+\.\s/.test(text);
      const trimmed = text.replace(/^\s+/, '');
      return trimmed.startsWith(prefix);
    };
    const allHave = lines.every((l) => matches(l));

    cm.operation(() => {
      for (let i = from; i <= to; i++) {
        const text = cm.getLine(i) || '';
        let next;
        if (allHave) {
          next = ordered ? text.replace(/^(\s*)\d+\.\s/, '$1') : text.replace(new RegExp(`^(\\s*)${escapeRe(prefix)}`), '$1');
        } else if (ordered) {
          next = text.replace(/^(\s*)/, `$1${i - from + 1}. `);
        } else {
          next = prefix + text;
        }
        cm.replaceRange(next, { line: i, ch: 0 }, { line: i, ch: text.length });
      }
    });
    cm.focus();
  }

  function wrapBlock(fence) {
    const sel = cm.getSelection();
    const pos = cm.getCursor();
    const block = fence + '\n' + (sel || '') + '\n' + fence;
    cm.replaceSelection(block);
    if (!sel) {
      cm.setCursor({ line: pos.line + 1, ch: 0 });
    }
    cm.focus();
  }

  function insertText(text, cursorOffset = 0) {
    cm.replaceSelection(text);
    if (cursorOffset) {
      const pos = cm.getCursor();
      cm.setCursor({ line: pos.line, ch: pos.ch + cursorOffset });
    }
    cm.focus();
  }

  const actions = {
    bold: () => wrapInline('**', '**', '粗体'),
    italic: () => wrapInline('*', '*', '斜体'),
    strike: () => wrapInline('~~', '~~', '删除线'),
    code: () => wrapInline('`', '`', '代码'),
    codeBlock: () => wrapBlock('```'),
    h1: () => linePrefix('# ', { toggle: true }),
    h2: () => linePrefix('## ', { toggle: true }),
    h3: () => linePrefix('### ', { toggle: true }),
    quote: () => linePrefix('> ', { toggle: true }),
    ul: () => linePrefix('- ', { toggle: true }),
    ol: () => linePrefix('1. ', { toggle: true, ordered: true }),
    task: () => linePrefix('- [ ] ', { toggle: true }),
    hr: () => insertText('\n\n---\n\n'),
    table: () =>
      insertText('\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n\n'),
    math: () => insertText('\n$$\n\n$$\n\n', 3),
    link: () => {
      const sel = cm.getSelection() || '链接文字';
      cm.replaceSelection(`[${sel}](url)`);
      const pos = cm.getCursor();
      cm.setSelection({ line: pos.line, ch: pos.ch - 4 }, { line: pos.line, ch: pos.ch - 1 });
      cm.focus();
    },
    image: () => insertText('![图片](assets/图片.png)'),
  };

  /* ---------------------------------------------------------------- 文档切换 */
  function setDocument(text, cursor) {
    cm.operation(() => {
      cm.setValue(text);
      cm.clearHistory();
      if (cursor) cm.setCursor(cursor);
      cm.setCursor(cursor || { line: 0, ch: 0 });
    });
  }

  /* ---------------------------------------------------------------- 查找替换 */
  const find = {
    marks: [],
    hits: [],
    index: -1,
    query: '',
    clear() {
      this.marks.forEach((m) => m.clear());
      this.marks = [];
      this.hits = [];
      this.index = -1;
    },
    search(query) {
      this.clear();
      this.query = query;
      if (!query) return 0;
      const cursor = cm.getSearchCursor(query, { line: 0, ch: 0 }, { caseFold: true });
      while (cursor.findNext()) {
        const from = cursor.from();
        const to = cursor.to();
        this.hits.push({ from, to });
        this.marks.push(cm.markText(from, to, { className: 'cm-search-hit' }));
        if (this.hits.length > 5000) break;
      }
      return this.hits.length;
    },
    focusHit(i) {
      if (!this.hits.length) return;
      this.index = ((i % this.hits.length) + this.hits.length) % this.hits.length;
      this.marks.forEach((m, idx) => {
        const hit = this.hits[idx];
        m.clear();
        const el = cm.markText(hit.from, hit.to, {
          className: idx === this.index ? 'cm-search-hit-active' : 'cm-search-hit',
        });
        this.marks[idx] = el;
      });
      const hit = this.hits[this.index];
      cm.setSelection(hit.from, hit.to);
      cm.scrollIntoView({ from: hit.from, to: hit.to }, 80);
      cm.focus();
    },
    replaceCurrent(replacement) {
      if (this.index < 0 || !this.hits[this.index]) return false;
      const hit = this.hits[this.index];
      cm.replaceRange(replacement, hit.from, hit.to);
      return true;
    },
    replaceAll(replacement) {
      if (!this.hits.length) return 0;
      const hits = this.hits.slice();
      cm.operation(() => {
        for (let i = hits.length - 1; i >= 0; i--) {
          cm.replaceRange(replacement, hits[i].from, hits[i].to);
        }
      });
      const n = hits.length;
      this.clear();
      return n;
    },
  };

  return {
    cm,
    actions,
    find,
    getValue: () => cm.getValue(),
    setDocument,
    focus: () => cm.focus(),
    refresh: () => cm.refresh(),
    setWrap(on) {
      cm.setOption('lineWrapping', on);
      cm.refresh();
    },
    setLineNumbers(on) {
      cm.setOption('lineNumbers', on);
      cm.refresh();
    },
    setEditorFont(font, size) {
      const host = cm.getWrapperElement();
      if (font) host.style.fontFamily = `"${font}", var(--font-mono)`;
      else host.style.removeProperty('font-family');
      if (size) host.style.fontSize = `${size}px`;
    },
    cursorLine: () => cm.getCursor().line + 1,
    scrollToLine(line, { center = true } = {}) {
      const target = Math.max(0, Math.min(cm.lineCount() - 1, line - 1));
      cm.scrollIntoView({ line: target, ch: 0 }, center ? cm.getScrollInfo().clientHeight / 2 : 0);
      cm.setCursor({ line: target, ch: 0 });
    },
    getScrollInfo: () => cm.getScrollInfo(),
    lineAtHeight: (y) => cm.lineAtHeight(y, 'local'),
    heightAtLine: (line) => cm.heightAtLine(line, 'local'),
    setModeForPath(path) {
      const ext = (path || '').split('.').pop().toLowerCase();
      const mode = ext === 'md' || ext === 'markdown' || ext === 'mdown' || ext === 'mkd' ? 'gfm' : CM.findModeByExtension(ext) ? CM.findModeByExtension(ext).mode : 'text/plain';
      cm.setOption('mode', mode);
    },
    setSpellcheck(on) {
      cm.setOption('spellcheck', !!on);
    },
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
