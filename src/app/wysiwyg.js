// 块级所见即所得编辑（真·渲染态直接编辑）。
//
// 所有块始终以 unified 渲染后的真 HTML widget 呈现——包括光标所在的活动块。
// 用户在渲染 DOM 上直接改字（contenteditable），input 时把 DOM 序列化回 Markdown，
// 静默写回 CM 源码。源码仍是唯一真相；写回时不重挂 widget、不重建 DOM，
// 因此没有源码闪烁、没有视图跳变，光标与选区由浏览器天然保持。
//
// CM5 的 replacedWith widget 默认不接收键盘输入（输入会跑进 CM 的隐藏 textarea）。
// 实测验证：在 mousedown 里主动 focus 渲染根后，键盘输入进入 widget 且格式标签被保留。
//
// 复杂块（表格/公式/代码/Mermaid）内容不可直接编辑内容（结构由语法控制），
// 仍保持渲染展示；用户想改这些可切到源码视图。文本类块（标题/段落/引用/列表）可直接改。
//
// 依赖注入（便于单测）：cm、renderer、postProcess、serializeBlock，其余走默认实现。
export function createWysiwyg({ cm, renderer, resolveImage, onBlockClick, onTaskToggle, onImageClick, postProcess, softBreaks, debounceMs = 220, setTimer = null, serializeBlock = null }) {
  const htmlCache = new Map();   // 块源文本 → 渲染后的 HTML
  const blockMarks = new Map();  // 块索引 → TextMarker（所有块的 widget，含活动块）
  const markSig = new Map();     // 块索引 → 签名
  const editableBlocks = new Map(); // 块索引 → {root, node, lastMd} 当前处于编辑态的块
  let blocks = [];
  let activeIdx = -1;
  let on = false;
  let suppress = false;          // 静默写回源码时抑制 change→rebuild 重入
  let writingBack = false;
  let rebuildTimer = null;
  const timer = setTimer || ((fn, ms) => setTimeout(fn, ms));
  const d2m = (typeof window !== 'undefined' && window.DocToMarkdown) || null;
  const serialize = serializeBlock || ((node) => {
    if (!d2m || !d2m.domToMarkdown) return null;
    const root = d2m.renderedRoot ? d2m.renderedRoot(node) : node;
    return d2m.domToMarkdown(root);
  });

  function mdMode() {
    const m = cm.getOption('mode') || '';
    return m.indexOf('gfm') >= 0 || /markdown/.test(m);
  }

  /** 是否文本类块（可在渲染态直接编辑）。 */
  function isTextBlock(b) {
    if (!b) return false;
    const m = (b.html || '').match(/^<([\w-]+)/i);
    if (!m) return false;
    const tag = m[1].toLowerCase();
    return /^h[1-6]$/.test(tag) || tag === 'p' || tag === 'ul' || tag === 'ol' || tag === 'blockquote';
  }

  // ---- 块签名：源文本 + 起止行。签名变 → 该块需重渲染 ----
  function blockSig(b, i) {
    if (!b) return '';
    let text = '';
    for (let ln = b.start; ln < b.end && ln < cm.lineCount(); ln++) text += cm.getLine(ln) + '\n';
    return i + '|' + b.start + '-' + b.end + '|' + (b.listItem ? 'li' : '') + '|' + text;
  }

  function blockAtCursorFor(list) {
    const line = cm.getCursor('head').line;
    for (let i = 0; i < list.length; i++) {
      if (list[i].start <= line && line < list[i].end) return i;
    }
    return -1;
  }
  function blockAtCursor() { return blockAtCursorFor(blocks); }

  /** 把某块的源码行范围替换为新 Markdown（静默，不触发 widget 重挂）。 */
  function writeBackSource(i, md) {
    const b = blocks[i];
    if (!b || typeof md !== 'string') return;
    if (md === currentBlockSource(b)) return; // 无变化
    const from = { line: b.start, ch: 0 };
    const to = { line: Math.min(b.end - 1, cm.lineCount() - 1), ch: (cm.getLine(Math.min(b.end - 1, cm.lineCount() - 1)) || '').length };
    const oldLines = b.end - b.start;
    const newLines = md.split('\n').length;
    writingBack = true;
    try {
      cm.replaceRange(md, from, to);
    } finally {
      writingBack = false;
    }
    // 签名已变但不能重挂当前编辑块——更新记录即可，离开时再统一重渲染
    markSig.set(i, blockSig(blocks[i], i));
    // 行数变化（用户按了 Enter / 删空行）：块边界已变，必须重建，否则后续写回范围错乱。
    // 这是用户主动换行，重建一次可接受；光标由 CM 保留在原行。
    if (oldLines !== newLines) {
      const head = cm.getCursor('head');
      refreshActive(true);
      cm.setCursor(head);
    }
  }

  function currentBlockSource(b) {
    let text = '';
    for (let ln = b.start; ln < b.end && ln < cm.lineCount(); ln++) {
      text += (cm.getLine(ln) || '') + (ln < b.end - 1 ? '\n' : '');
    }
    return text;
  }

  /** 让某块进入可编辑态：渲染根 contenteditable + focus。 */
  function enterEdit(i) {
    const b = blocks[i];
    const rec = editableBlocks.get(i);
    if (!b || !rec || !isTextBlock(b)) return;
    if (rec.root.getAttribute('contenteditable') !== 'true') {
      rec.root.setAttribute('contenteditable', 'true');
      rec.root.classList.add('fm-wysiwyg-editing');
    }
    // 键盘输入要进 widget 而非 CM 隐藏 textarea：mousedown 时主动 focus
    if (rec._focusPending) {
      rec._focusPending = false;
      try { rec.root.focus(); placeCaretStart(rec.root); } catch (_) {}
    }
  }

  /** 退出某块编辑态：把 DOM 按最新源码重新渲染，恢复不可编辑。 */
  function leaveEdit(i) {
    const rec = editableBlocks.get(i);
    if (!rec) return;
    editableBlocks.delete(i);
    const b = blocks[i];
    if (!b || !rec.node) return;
    try { rec.root.removeAttribute('contenteditable'); rec.root.classList.remove('fm-wysiwyg-editing'); } catch (_) {}
    // 更新 widget DOM 为最新源码的渲染结果（源码可能刚被编辑改过）
    if (rec.node.innerHTML !== b.html) {
      try { rec.node.innerHTML = b.html; } catch (_) {}
    }
  }

  function placeCaretStart(root) {
    try {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  /** 给单个块挂渲染 widget（所有块都挂，含活动块）。 */
  function mountWidget(i, opts = {}) {
    const b = blocks[i];
    if (!b || !b.html || b.skipped || blockMarks.has(i)) return;
    const last = Math.max(b.start, b.end - 1);
    const lineLen = (cm.getLine(last) || '').length;
    if (b.start > last || (b.start === last && lineLen === 0)) return;

    const node = document.createElement('div');
    node.className = 'markdown-body fm-wysiwyg-block' + (b.listItem ? ' fm-wysiwyg-li-' + b.listItemPos : '');
    node.dataset.ws = String(b.start);
    node.innerHTML = b.html;
    // 清 ul/ol 内纯空白文本节点（换行会被渲染成空行，把 li 挤下一行）
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

    const root = (d2m && d2m.renderedRoot)
      ? d2m.renderedRoot(node)
      : (node.firstElementChild || node);

    // 编辑态：mousedown 主动 focus 渲染根，避免 CM 抢焦点；然后 input 序列化回源码
    if (isTextBlock(b)) {
      node.addEventListener('mousedown', (e) => {
        if (e.target.closest('input, a, img, [data-wysiwyg-interactive]')) return;
        if (editableBlocks.has(i)) return; // 已在该块编辑，让浏览器正常处理选区
        e.preventDefault();
        if (onBlockClick) onBlockClick(b.start, e);
        suppress = true;
        cm.setCursor({ line: b.start, ch: 0 });
        refreshActive();
        // 标记待 focus，refreshActive 里 enterEdit 会执行 focus
        const rec = editableBlocks.get(i);
        if (rec) { rec._focusPending = true; enterEdit(i); }
        suppress = false;
      });
      node.addEventListener('input', () => {
        if (writingBack) return;
        const md = serialize(root);
        if (md == null) return;
        writeBackSource(i, md);
        const rec = editableBlocks.get(i);
        if (rec) rec.lastMd = md;
      });
    }

    try {
      const mark = cm.markText(
        { line: b.start, ch: 0 }, { line: last, ch: lineLen },
        { replacedWith: node, inclusiveLeft: false, inclusiveRight: false, handleMouseEvents: true }
      );
      cm.addLineClass(b.start, 'wrap', 'cm-ww-rendered');
      blockMarks.set(i, mark);
      markSig.set(i, blockSig(blocks[i], i));
      if (isTextBlock(b)) {
        editableBlocks.set(i, { root, node, lastMd: currentBlockSource(b), _focusPending: false });
        if (opts.editing) enterEdit(i);
      }
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
    editableBlocks.delete(i);
  }

  function clearAllWidgets() {
    for (const i of Array.from(blockMarks.keys())) unmountWidget(i);
    markSig.clear();
  }

  /** 重新切块。正在编辑的活动块跳过重挂（避免闪烁），仅在必要时更新 Others。 */
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
        const editingHere = editableBlocks.has(i) && i === activeIdx;
        if (editingHere) {
          // 正在编辑：只更新块范围记录，不摘 widget（DOM 保留，光标不丢）
          const b = next[i];
          if (b) blocks[i] = b;
          continue;
        }
        if (i >= next.length || nextSig[i] !== markSig.get(i)) unmountWidget(i);
      }
      const oldBlocks = blocks;
      blocks = next;
      activeIdx = nextIdx;
      blocks.forEach((_, i) => {
        if (blockMarks.has(i)) return; // 含正在编辑的活动块
        mountWidget(i, { editing: i === nextIdx });
      });
      for (const key of Array.from(markSig.keys())) if (key >= blocks.length) markSig.delete(key);
    });
  }

  /** 光标换块：旧块退出编辑并恢复渲染，新块进入编辑态；其他块不动。 */
  function refreshActive(force = false) {
    if (!on || !mdMode()) return;
    const next = blockAtCursor();
    if (!force && next === activeIdx) return;

    if (force) {
      clearAllWidgets();
      blocks.forEach((_, i) => mountWidget(i, { editing: i === next }));
    } else {
      // 旧活动块退出编辑态（按最新源码重渲染）；新活动块进入编辑态
      if (activeIdx >= 0 && editableBlocks.has(activeIdx)) leaveEdit(activeIdx);
      if (next >= 0 && isTextBlock(blocks[next]) && blockMarks.has(next)) {
        const rec = editableBlocks.get(next);
        if (rec) { rec._focusPending = true; enterEdit(next); }
      }
    }
    activeIdx = next;
  }

  function enable() {
    if (on) return;
    on = true;
    rebuild();
  }
  function disable() {
    if (!on) return;
    on = false;
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
    clearAllWidgets();
    blocks = [];
    activeIdx = -1;
    htmlCache.clear();
  }

  function onDocChanged() {
    if (!on || writingBack) return; // 自己写回源码引起的 change 不再触发重建
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = timer(() => { rebuildTimer = null; rebuild(); }, debounceMs);
  }
  function onCursorChanged() {
    if (!on || suppress) return;
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; rebuild(); }
    refreshActive();
  }

  return {
    enable, disable,
    isOn: () => on,
    rebuild,
    onDocChanged,
    onCursorChanged,
    activeBlock: () => (activeIdx >= 0 ? blocks[activeIdx] : null),
    blockCount: () => blocks.length,
    _debug: () => ({ blocks: blocks.map((b) => ({ start: b.start, end: b.end })), activeIdx, mounted: Array.from(blockMarks.keys()), editing: Array.from(editableBlocks.keys()) }),
  };
}
