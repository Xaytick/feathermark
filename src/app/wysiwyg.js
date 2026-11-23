// 块级所见即所得编辑（Typora 式）。
//
// 原理：用 CodeMirror 的 replacedWith widget 把「非活动块」整体替换成 unified 渲染后的
// HTML；「活动块」（光标所在的块）保持源码可编辑。光标在 CM 里，位置天然稳定；
// 切换块时只更新旧/新两个块的 widget，其他渲染区域完全不动。
//
// 高度对齐：widget 自身 DOM 高度撑开 CM 对应行段——无需手工计算等高。
// 数据真相：始终是 CM 的源码；本模块只读源码渲染，不改写文档。
//
// 依赖注入（便于单测）：cm、renderer（window.UnifiedRenderer）、postProcess（后处理钩子）、
// blockKey（块 → 缓存键），其余走默认实现。
export function createWysiwyg({ cm, renderer, resolveImage, onBlockClick, onTaskToggle, onImageClick, postProcess, softBreaks, debounceMs = 220, setTimer = null }) {
  const htmlCache = new Map();   // 块源文本 → 渲染后的 HTML（跨切换复用）
  const blockMarks = new Map();  // 块索引 → TextMarker（当前挂了 widget 的非活动块）
  const markSig = new Map();     // 块索引 → 签名（源文本+位置），用于 rebuild 时复用未变的 widget
  let blocks = [];               // 当前块列表 [{start,end,html,skipped,listItem,...}]
  let activeIdx = -1;            // 当前活动块索引（-1 = 光标不在任何块）
  let on = false;                // 是否启用
  let suppress = false;          // 重入保护：程序化改光标时不重算
  let rebuildTimer = null;       // 文档变化防抖（打字时不整篇重解析，避免卡顿）
  const timer = setTimer || ((fn, ms) => setTimeout(fn, ms));

  function mdMode() {
    const m = cm.getOption('mode') || '';
    return m.indexOf('gfm') >= 0 || /markdown/.test(m);
  }

  /** 块签名：源文本 + 起止行 + 列表项标记。签名不变则 widget 可原样复用，避免跳动。 */
  function blockSig(b, i) {
    if (!b) return '';
    let text = '';
    for (let ln = b.start; ln < b.end && ln < cm.lineCount(); ln++) text += cm.getLine(ln) + '\n';
    return i + '|' + b.start + '-' + b.end + '|' + (b.listItem ? 'li' : '') + '|' + text;
  }

  /** 从 CM 全文重新切块并渲染（文档变化时调用）。
   *  用 cm.operation 批量提交 + 复用签名未变的 widget，避免整屏闪烁跳动。 */
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
      // 摘掉：索引越界、签名变了、或新成为活动块的 widget
      for (const i of Array.from(blockMarks.keys())) {
        if (i >= next.length || nextSig[i] !== markSig.get(i) || i === nextIdx) unmountWidget(i);
      }
      blocks = next;
      activeIdx = nextIdx;
      // 挂上：非活动块里尚未挂 widget 的（签名变了的已在上面摘掉）；签名未变的原样保留
      blocks.forEach((_, i) => {
        if (i === nextIdx || blockMarks.has(i)) return;
        mountWidget(i); // 内部会记录 markSig
      });
      for (const key of Array.from(markSig.keys())) if (key >= blocks.length) markSig.delete(key);
    });
    applyEditClasses(nextIdx);
  }

  /** 在给定块列表里找光标所在块（rebuild 时 blocks 还是旧的，需传入新列表）。 */
  function blockAtCursorFor(list) {
    const line = cm.getCursor('head').line;
    for (let i = 0; i < list.length; i++) {
      if (list[i].start <= line && line < list[i].end) return i;
    }
    return -1;
  }

  /** 光标所在块索引。块范围 [start,end) 是 0-based 行号。 */
  function blockAtCursor() {
    const line = cm.getCursor('head').line;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].start <= line && line < blocks[i].end) return i;
    }
    return -1;
  }

  /** 给单个块挂渲染 widget。 */
  function mountWidget(i) {
    const b = blocks[i];
    if (!b || !b.html || b.skipped || blockMarks.has(i)) return;
    // 注：渲染为空（html===''）的块保持源码可见——可能是渲染失败，隐藏会让用户丢失可编辑内容。
    // 设计上不可见的块（链接定义等）由 unified 返回 <div class="wysiwyg-block-hidden">，走正常路径。
    const last = Math.max(b.start, b.end - 1);
    const lineLen = (cm.getLine(last) || '').length;
    if (b.start > last || (b.start === last && lineLen === 0)) return;

    const node = document.createElement('div');
    // markdown-body 让渲染块套用与预览一致的排版（表格/引用/标题等全局样式类）
    node.className = 'markdown-body fm-wysiwyg-block' + (b.listItem ? ' fm-wysiwyg-li-' + b.listItemPos : '');
    node.dataset.ws = String(b.start);
    node.innerHTML = b.html;
    // unified 渲染的列表是 <ul>\n<li>…</li>\n</ul>，标签间的换行文本节点在 block 上下文里
    // 会渲染成一个空行，把 li 挤下整整一行（实测列表块 85px vs li 28px）。
    // 清掉纯空白文本节点，既消除空行又保留 li 的项目符号（font-size:0 方案会让符号消失）。
    node.querySelectorAll('ul, ol').forEach((list) => {
      Array.from(list.childNodes).forEach((n) => {
        if (n.nodeType === 3 && !n.textContent.trim()) n.remove();
      });
    });
    // 本地图片路径解析（渲染管线给的是相对路径）
    if (resolveImage) {
      node.querySelectorAll('img[src]').forEach((img) => {
        const src = img.getAttribute('src') || '';
        if (src && !/^(data:|https?:|asset:|file:)/i.test(src)) img.src = resolveImage(src);
      });
    }
    // 后处理（KaTeX / Mermaid / hljs 等），复用 preview 的能力
    if (postProcess) {
      try { postProcess(node, b.finalHtml); } catch (e) { console.warn('[wysiwyg] 后处理失败:', e); }
    }
    // 任务勾选：data-source-line 是块内相对行号，还原为全文行号后回写源码
    node.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.disabled = false;
      box.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const host = box.closest('[data-source-line]');
        const rel = host ? parseInt(host.getAttribute('data-source-line'), 10) : 1;
        const line = b.start + Math.max(0, rel - 1);
        box.checked = !box.checked;
        if (onTaskToggle) onTaskToggle(line, box.checked);
      });
    });
    // 图片点击 → 开大图
    node.querySelectorAll('img').forEach((img) => {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onImageClick) onImageClick(img.src);
      });
    });
    // 点击渲染块 → 把光标放进对应源码行，让该块切回源码编辑
    node.addEventListener('mousedown', (e) => {
      // 让块内的交互元素（checkbox / 链接 / 图片）先有机会处理
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
        { line: b.start, ch: 0 },
        { line: last, ch: lineLen },
        {
          replacedWith: node,
          inclusiveLeft: false,
          inclusiveRight: false,
          handleMouseEvents: true, // 否则 CM5 给 widget 加 cm-ignore-events，块内点击/勾选全部失效
        }
      );
      cm.addLineClass(b.start, 'wrap', 'cm-ww-rendered');
      blockMarks.set(i, mark);
      markSig.set(i, blockSig(blocks[i], i));
    } catch (e) {
      console.warn('[wysiwyg] 挂 widget 失败:', e);
    }
  }

  /** 摘掉单个块的 widget（切回源码）。 */
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

  /** 从渲染 HTML 首标签推断块类型，用于给编辑态源码行套对应的字号/行高。 */
  function blockKind(b) {
    if (!b) return '';
    const m = (b.html || '').match(/^<(h[1-6]|p|ul|ol|blockquote|pre|table)\b/i);
    return m ? m[1].toLowerCase() : '';
  }

  let editLineClasses = []; // 当前活动块加过编辑样式类的行号

  /** 清除上一次活动块的编辑样式类。 */
  function clearEditClasses() {
    for (const ln of editLineClasses) {
      cm.removeLineClass(ln, 'wrap', 'cm-ww-edit-h1');
      cm.removeLineClass(ln, 'wrap', 'cm-ww-edit-h2');
      cm.removeLineClass(ln, 'wrap', 'cm-ww-edit-h3');
      cm.removeLineClass(ln, 'wrap', 'cm-ww-edit-h4');
      cm.removeLineClass(ln, 'wrap', 'cm-ww-edit-head');
      cm.removeLineClass(ln, 'wrap', 'cm-ww-edit-body');
    }
    editLineClasses = [];
  }

  /** 给活动块源码行套渲染态尺寸，使编辑/预览切换时高度一致、不挤在一起。 */
  function applyEditClasses(i) {
    clearEditClasses();
    const b = blocks[i];
    if (!b) return;
    const kind = blockKind(b);
    let cls = '';
    if (/^h[1-3]$/.test(kind)) cls = 'cm-ww-edit-' + kind;
    else if (/^h[4-6]$/.test(kind)) cls = 'cm-ww-edit-h4';
    // 正文/列表块不需要特殊字号：源码行已由 CSS 统一为 24px，与渲染 widget 一致
    if (!cls) return;
    for (let ln = b.start; ln < b.end; ln++) {
      cm.addLineClass(ln, 'wrap', cls);
      editLineClasses.push(ln);
    }
  }

  /** 根据当前光标刷新活动块；force=true 时全量重建 widget。 */
  function refreshActive(force = false) {
    if (!on || !mdMode()) return;
    const next = blockAtCursor();
    if (!force && next === activeIdx) return;

    if (force) {
      clearAllWidgets();
      blocks.forEach((_, i) => { if (i !== next) mountWidget(i); });
    } else {
      // 旧活动块 → 盖回渲染 widget；新活动块 → 摘掉 widget 露出源码
      if (activeIdx >= 0 && activeIdx !== next) mountWidget(activeIdx);
      if (next >= 0) unmountWidget(next);
    }
    activeIdx = next;
    applyEditClasses(next);
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
    clearEditClasses();
    clearAllWidgets();
    blocks = [];
    activeIdx = -1;
    htmlCache.clear();
  }

  /** 文档内容变了：防抖后重算块（打字流畅），期间 widget 保持不动。
   *  光标移动：立即切活动块；若有待处理的文档变更则先冲掉定时器立即重建。 */
  function onDocChanged() {
    if (!on) return;
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = timer(() => { rebuildTimer = null; rebuild(); }, debounceMs);
  }
  function onCursorChanged() {
    if (!on || suppress) return;
    // 光标换块时若文档刚改过，先同步块结构，避免用旧块范围误判
    if (rebuildTimer) {
      clearTimeout(rebuildTimer); rebuildTimer = null;
      rebuild();
    }
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
    // 供测试/诊断
    _debug: () => ({ blocks: blocks.map((b) => ({ start: b.start, end: b.end })), activeIdx, mounted: Array.from(blockMarks.keys()) }),
  };
}
