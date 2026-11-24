// 混合式 Live Preview（Obsidian 式）。
//
// 核心原则：源码是唯一真相，编辑器始终是同一个 CodeMirror 实例。
// 两类块走两条渲染路径：
//   ① 正文类（标题/段落/引用/列表/分割线/行内语法）——用 markText 装饰源码文字，
//      语法标记（#、**、[]() 等）在光标所在行显示、其余行弱化。文字始终是源码字符，
//      行高由源码决定 → 切换时零跳动。这就是 Obsidian 的 Decoration.mark + replace。
//   ② 复杂块（表格 / 围栏代码 / Mermaid / 数学公式）——用 replacedWith widget 挂
//      unified 渲染的真 HTML。这些块无法靠 CSS 装饰呈现，切换时才变高度。
//
// 数据真相：本模块只读源码渲染，从不改写文档。
// 依赖注入（便于单测）：cm、renderer、postProcess、各类回调。
export function createWysiwyg({ cm, renderer, resolveImage, onBlockClick, onTaskToggle, onImageClick, postProcess, softBreaks, debounceMs = 220, setTimer = null }) {
  const LP = 'cm-lp-';           // 复用 editor.js 既有的装饰样式类
  const htmlCache = new Map();   // 复杂块源文本 → 渲染后的 HTML
  const blockMarks = new Map();  // 块索引 → TextMarker（复杂块的 widget）
  const markSig = new Map();     // 块索引 → 签名，rebuild 时复用未变 widget
  let inlineMarks = [];          // 正文装饰产生的 mark（逐行重建）
  let blocks = [];
  let activeIdx = -1;
  let on = false;
  let suppress = false;
  let rebuildTimer = null;
  const timer = setTimer || ((fn, ms) => setTimeout(fn, ms));

  function mdMode() {
    const m = cm.getOption('mode') || '';
    return m.indexOf('gfm') >= 0 || /markdown/.test(m);
  }

  // ---- 块分类：正文（装饰） vs 复杂（widget） ----
  /** 从渲染 HTML 首标签判定是否复杂块。 */
  function isComplexBlock(b) {
    if (!b) return false;
    const m = (b.html || '').match(/^<([\w-]+)/i);
    if (!m) return false;
    const tag = m[1].toLowerCase();
    // 表格、代码块、数学公式必须真渲染；其余（h1-h6/p/ul/ol/blockquote/hr）装饰即可
    return tag === 'table' || tag === 'pre' || tag === 'span' || tag === 'div' || tag === 'math';
  }

  // ---- 正文装饰（Obsidian 式 Decoration.mark / replace） ----
  function paint(from, to, cls) {
    if (from.line === to.line && from.ch === to.ch) return;
    inlineMarks.push(cm.markText(from, to, { className: LP + cls, inclusiveLeft: false, inclusiveRight: false }));
  }

  /** 行内语法装饰：代码 → 图片 → 粗体 → 斜体 → 删除线 → 链接。
   *  active=光标所在行：标记完整显示；否则标记弱化（CSS .cm-lp-mark）。 */
  function paintInline(ln, off, end, active) {
    const line = cm.getLine(ln) || '';
    const seg = line.slice(off, end);
    const mk = (s, e, cls) => paint({ line: ln, ch: off + s }, { line: ln, ch: off + e }, cls);
    let m;
    const codeRe = /`([^`\n]+)`/g;
    while ((m = codeRe.exec(seg))) {
      const s = m.index, e = s + m[0].length;
      mk(s, e, 'code');
      if (!active) { mk(s, s + 1, 'mark'); mk(e - 1, e, 'mark'); }
    }
    const imgRe = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    while ((m = imgRe.exec(seg))) {
      const s = m.index, e = s + m[0].length;
      if (active || !resolveImage) { mk(s, e, 'imgsrc'); continue; }
      const box = document.createElement('span');
      box.className = LP + 'img';
      const img = document.createElement('img');
      img.alt = m[1] || '';
      img.src = resolveImage(m[2]);
      img.onerror = () => { box.classList.add('err'); box.textContent = '（图片未能加载）'; };
      box.appendChild(img);
      inlineMarks.push(cm.markText({ line: ln, ch: off + s }, { line: ln, ch: off + e },
        { replacedWith: box, inclusiveLeft: true, inclusiveRight: true }));
    }
    const strongRe = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g;
    while ((m = strongRe.exec(seg))) {
      const s = m.index, e = s + m[0].length, d = m[1].length;
      mk(s, e, 'strong');
      if (!active) { mk(s, s + d, 'mark'); mk(e - d, e, 'mark'); }
    }
    const emRe = /(?<![*_])([*_])(?![*_\s])([\s\S]*?\S)\1(?![*_])/g;
    while ((m = emRe.exec(seg))) {
      const s = m.index, e = s + m[0].length;
      mk(s, e, 'em');
      if (!active) { mk(s, s + 1, 'mark'); mk(e - 1, e, 'mark'); }
    }
    const delRe = /~~(?=\S)([\s\S]*?\S)~~/g;
    while ((m = delRe.exec(seg))) {
      const s = m.index, e = s + m[0].length;
      mk(s, e, 'del');
      if (!active) { mk(s, s + 2, 'mark'); mk(e - 2, e, 'mark'); }
    }
    const linkRe = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    while ((m = linkRe.exec(seg))) {
      const s = m.index, e = s + m[0].length;
      const textLen = m[1].length;
      mk(s + 1, s + 1 + textLen, 'link');
      if (!active) { mk(s, s + 1, 'mark'); mk(s + 1 + textLen, e, 'mark'); }
    }
  }

  /** 装饰视口内的正文行（标题/引用/列表/行内），跳过复杂块占用的行。 */
  function decorateVisible() {
    if (!on || !mdMode()) return;
    inlineMarks.forEach((m) => { try { m.clear(); } catch (_) {} });
    inlineMarks = [];
    cm.operation(() => {
      const vp = cm.getViewport();
      const cursorLine = cm.getCursor('head').line;
      const last = Math.min(vp.to, cm.lineCount() - 1);
      // 复杂块占用的行不装饰（它们已被 widget 替换）
      const complexLines = new Set();
      blocks.forEach((b, i) => {
        if (isComplexBlock(b) && i !== activeIdx && blockMarks.has(i)) {
          for (let ln = b.start; ln < b.end; ln++) complexLines.add(ln);
        }
      });
      for (let ln = vp.from; ln <= last; ln++) {
        if (complexLines.has(ln)) continue;
        const text = cm.getLine(ln) || '';
        if (!text.trim()) continue;
        const active = ln === cursorLine;
        const fullFrom = { line: ln, ch: 0 }, fullTo = { line: ln, ch: text.length };
        // 标题：字号恒定（行高不随光标跳），标记符号随光标显隐
        const hm = text.match(/^(#{1,6})(\s+)(.*)$/);
        if (hm) {
          paint(fullFrom, fullTo, 'h' + hm[1].length);
          const skip = hm[1].length + hm[2].length;
          if (!active) paint(fullFrom, { line: ln, ch: skip }, 'mark');
          paintInline(ln, skip, text.length, active);
          continue;
        }
        const qm = text.match(/^(\s*(?:>\s?)+)(.*)$/);
        if (qm) {
          paint(fullFrom, fullTo, 'quote');
          if (!active) paint(fullFrom, { line: ln, ch: qm[1].length }, 'mark');
          paintInline(ln, qm[1].length, text.length, active);
          continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) { paint(fullFrom, fullTo, 'hr'); continue; }
        const lm = text.match(/^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)(.*)$/);
        if (lm) {
          const bulletEnd = lm[1].length + lm[2].length;
          paint(fullFrom, fullTo, 'list');
          if (!active) paint({ line: ln, ch: lm[1].length }, { line: ln, ch: bulletEnd }, 'mark');
          paintInline(ln, bulletEnd, text.length, active);
          continue;
        }
        paintInline(ln, 0, text.length, active);
      }
    });
  }

  // ---- 复杂块 widget（只在必要时替换） ----
  function blockSig(b, i) {
    if (!b) return '';
    let text = '';
    for (let ln = b.start; ln < b.end && ln < cm.lineCount(); ln++) text += cm.getLine(ln) + '\n';
    return i + '|' + b.start + '-' + b.end + '|' + text;
  }

  function blockAtCursorFor(list) {
    const line = cm.getCursor('head').line;
    for (let i = 0; i < list.length; i++) {
      if (list[i].start <= line && line < list[i].end) return i;
    }
    return -1;
  }
  function blockAtCursor() { return blockAtCursorFor(blocks); }

  function mountWidget(i) {
    const b = blocks[i];
    if (!b || !b.html || b.skipped || !isComplexBlock(b) || blockMarks.has(i)) return;
    const last = Math.max(b.start, b.end - 1);
    const lineLen = (cm.getLine(last) || '').length;
    if (b.start > last || (b.start === last && lineLen === 0)) return;

    const node = document.createElement('div');
    node.className = 'markdown-body fm-wysiwyg-block';
    node.dataset.ws = String(b.start);
    node.innerHTML = b.html;
    node.querySelectorAll('ul, ol').forEach((list) => {
      Array.from(list.childNodes).forEach((n) => { if (n.nodeType === 3 && !n.textContent.trim()) n.remove(); });
    });
    if (resolveImage) {
      node.querySelectorAll('img[src]').forEach((img) => {
        const src = img.getAttribute('src') || '';
        if (src && !/^(data:|https?:|asset:|file:)/i.test(src)) img.src = resolveImage(src);
      });
    }
    if (postProcess) {
      try { postProcess(node, b.finalHtml); } catch (e) { console.warn('[wysiwyg] 后处理失败:', e); }
    }
    node.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.disabled = false;
      box.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const host = box.closest('[data-source-line]');
        const rel = host ? parseInt(host.getAttribute('data-source-line'), 10) : 1;
        const line = b.start + Math.max(0, rel - 1);
        box.checked = !box.checked;
        if (onTaskToggle) onTaskToggle(line, box.checked);
      });
    });
    node.querySelectorAll('img').forEach((img) => {
      img.addEventListener('click', (e) => { e.stopPropagation(); if (onImageClick) onImageClick(img.src); });
    });
    node.addEventListener('mousedown', (e) => {
      if (e.target.closest('input, a, img, [data-wysiwyg-interactive]')) return;
      e.preventDefault();
      if (onBlockClick) onBlockClick(b.start, e);
      suppress = true;
      cm.setCursor({ line: b.start, ch: 0 });
      cm.focus();
      refreshActive();
      suppress = false;
    });
    try {
      const mark = cm.markText(
        { line: b.start, ch: 0 }, { line: last, ch: lineLen },
        { replacedWith: node, inclusiveLeft: false, inclusiveRight: false, handleMouseEvents: true }
      );
      cm.addLineClass(b.start, 'wrap', 'cm-ww-rendered');
      blockMarks.set(i, mark);
      markSig.set(i, blockSig(blocks[i], i));
    } catch (e) {
      console.warn('[wysiwyg] 挂 widget 失败:', e);
    }
  }

  function unmountWidget(i) {
    const mark = blockMarks.get(i);
    if (mark) {
      try { mark.clear(); } catch (_) {}
      if (blocks[i]) cm.removeLineClass(blocks[i].start, 'wrap', 'cm-ww-rendered');
      blockMarks.delete(i);
    }
  }
  function clearAllWidgets() {
    for (const i of Array.from(blockMarks.keys())) unmountWidget(i);
    markSig.clear();
  }
  function clearInline() {
    inlineMarks.forEach((m) => { try { m.clear(); } catch (_) {} });
    inlineMarks = [];
  }

  /** 重新切块 + 同步复杂块 widget + 重绘正文装饰。 */
  function rebuild() {
    if (!on || !mdMode() || !renderer) return;
    const doc = cm.getValue();
    let next;
    try {
      next = renderer.renderMarkdownBlocks(doc, { softBreaks: !!softBreaks, htmlCache }) || [];
    } catch (e) {
      console.error('[wysiwyg] 切块失败，退回纯源码:', e);
      next = [];
    }
    const nextSig = next.map(blockSig);
    const nextIdx = blockAtCursorFor(next);
    cm.operation(() => {
      for (const i of Array.from(blockMarks.keys())) {
        if (i >= next.length || nextSig[i] !== markSig.get(i) || i === nextIdx) unmountWidget(i);
      }
      blocks = next;
      activeIdx = nextIdx;
      blocks.forEach((_, i) => {
        if (i === nextIdx || blockMarks.has(i) || !isComplexBlock(blocks[i])) return;
        mountWidget(i);
      });
      for (const key of Array.from(markSig.keys())) if (key >= blocks.length) markSig.delete(key);
    });
    decorateVisible();
  }

  /** 光标换块：复杂块 widget 只切旧/新两块；正文块只需重绘装饰（标记显隐）。 */
  function refreshActive(force = false) {
    if (!on || !mdMode()) return;
    const next = blockAtCursor();
    if (!force && next === activeIdx) {
      // 同一块内换行：仍需刷新标记显隐（光标行 vs 非光标行）
      decorateVisible();
      return;
    }
    if (force) {
      clearAllWidgets();
      blocks.forEach((_, i) => { if (i !== next && isComplexBlock(blocks[i])) mountWidget(i); });
    } else {
      // 旧活动块若是复杂块 → 盖回 widget；新活动块若是复杂块 → 摘掉露出源码
      if (activeIdx >= 0 && activeIdx !== next && isComplexBlock(blocks[activeIdx])) mountWidget(activeIdx);
      if (next >= 0 && isComplexBlock(blocks[next])) unmountWidget(next);
    }
    activeIdx = next;
    decorateVisible();
  }

  function enable() {
    if (on) return;
    on = true;
    cm.getWrapperElement().classList.add(LP + 'on'); // 复用 .cm-lp-* 样式
    rebuild();
  }
  function disable() {
    if (!on) return;
    on = false;
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
    cm.getWrapperElement().classList.remove(LP + 'on');
    clearInline();
    clearAllWidgets();
    blocks = [];
    activeIdx = -1;
    htmlCache.clear();
  }

  function onDocChanged() {
    if (!on) return;
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = timer(() => { rebuildTimer = null; rebuild(); }, debounceMs);
  }
  function onCursorChanged() {
    if (!on || suppress) return;
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; rebuild(); return; }
    refreshActive();
  }
  /** 视口滚动时只需重绘正文装饰（widget 由 CM 自己管理）。 */
  function onViewportChanged() { if (on) decorateVisible(); }

  return {
    enable, disable,
    isOn: () => on,
    rebuild,
    onDocChanged,
    onCursorChanged,
    onViewportChanged,
    activeBlock: () => (activeIdx >= 0 ? blocks[activeIdx] : null),
    blockCount: () => blocks.length,
    _debug: () => ({ blocks: blocks.map((b) => ({ start: b.start, end: b.end })), activeIdx, mounted: Array.from(blockMarks.keys()) }),
  };
}
