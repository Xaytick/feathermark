// 预览层：unified 渲染 + KaTeX/Mermaid/highlight.js 后处理 + 大纲提取 + 滚动位置换算。
//
// 渲染器（UnifiedRenderer）是照搬参考实现的产物：remark-parse + remark-gfm →
// remark-rehype → rehype-raw → rehype-sanitize → rehype-stringify，前面还串了
// 提示块/脚注/定义列表/数学守卫等预处理。这里只负责「渲染完之后」的浏览器侧增强。
import mermaid from 'mermaid';
import hljs from 'highlight.js';
import { convertFileSrc } from './ipc.js';

const EXT_LANG = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'csharp',
  htm: 'html',
  vue: 'xml',
  toml: 'ini',
};

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 路径规整（处理 ./ 与 ../）：同时兼容 POSIX 与 Windows 盘符路径。 */
export function resolvePath(baseDir, rel) {
  if (!rel) return rel;
  if (/^(https?:|data:|asset:|file:|blob:|mailto:|#)/i.test(rel)) return rel;
  const base = baseDir || '';
  const isWin = /^[a-zA-Z]:[\\/]/.test(base) || base.includes('\\');
  const sep = isWin ? '\\' : '/';
  const normalized = rel.replace(/\\/g, '/');
  if (isWin ? /^[a-zA-Z]:/.test(normalized) : normalized.startsWith('/')) return rel;

  const parts = base.split(/[\\/]/).filter(Boolean);
  for (const seg of normalized.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  if (isWin) {
    const root = parts.shift() || '';
    return root + sep + parts.join(sep);
  }
  return '/' + parts.join('/');
}

export function dirname(p) {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? '' : p.slice(0, i);
}

export function createPreview({ el, scrollEl, prefs, onOpenFile, onTaskToggle, onImageClick }) {
  let renderToken = 0;
  let blocks = [];
  let currentDir = '';

  // 光标位置标记层：绝对定位在预览内容上，pointer-events:none 不遮挡点击/选中/任务列表。
  // 光标移动时定位到对应源码行的预览块，左侧竖条 + 整块淡色背景，随滚动自然移动。
  const cursorMark = document.createElement('div');
  cursorMark.className = 'fm-cursor-mark hidden';
  cursorMark.innerHTML = '<span class="fm-cursor-mark-bar"></span>';
  el.appendChild(cursorMark);
  let markedLine = 0;

  // mermaid 单例有内部状态（id 生成器、当前配置）。并发 run 会交错读写它，
  // 表现就是「切主题后图不见了」——所以这里照搬参考实现的两条护栏：
  //   1) 全局串行队列，同一时刻只跑一个 run；
  //   2) 容器 id 单调递增，避免同毫秒内撞上 mermaid 内部 id。
  let initializedMode = null;
  let mermaidQueue = Promise.resolve();
  let mermaidSeq = 0;

  function initMermaid(isDark) {
    const key = isDark ? 'dark' : 'light';
    if (initializedMode === key) return;
    initializedMode = key;
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'strict',
      fontFamily: getComputedStyle(document.body).fontFamily,
      flowchart: { htmlLabels: true, useMaxWidth: true },
      themeVariables: isDark
        ? { background: 'transparent', primaryColor: '#2b313b', primaryTextColor: '#e4e8ef', lineColor: '#5a6577' }
        : { background: 'transparent', primaryColor: '#eef2f9', primaryTextColor: '#1f2430', lineColor: '#8a94a6' },
    });
  }
  initMermaid(document.documentElement.dataset.mode === 'dark');

  /* -------------------------------------------------------------- 后处理 */
  function resolveResources() {
    el.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!src) return;
      if (/^(https?:|data:|asset:|blob:)/i.test(src)) return;
      const abs = resolvePath(currentDir, src);
      img.setAttribute('src', convertFileSrc(abs));
      img.dataset.localPath = abs;
      img.loading = 'lazy';
    });
    el.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!href) return;
      if (/^https?:/i.test(href)) {
        a.dataset.external = '1';
      } else if (/\.(md|markdown|mdown|mkd)(#.*)?$/i.test(href)) {
        a.dataset.mdlink = resolvePath(currentDir, href.split('#')[0]);
      }
    });
  }

  function renderMath() {
    const katex = window.katex;
    if (!katex) return;
    el.querySelectorAll('span.math-display').forEach((span) => {
      const latex = (span.textContent || '').trim();
      if (!latex) return;
      try {
        katex.render(latex, span, { displayMode: true, throwOnError: false, strict: 'ignore' });
      } catch (e) {
        span.textContent = latex;
      }
    });
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false,
          strict: 'ignore',
          ignoredClasses: ['katex-ignore', 'mermaid-container', 'code-lang'],
        });
      } catch (e) {
        console.warn('[math] 公式渲染失败', e);
      }
    }
  }

  async function renderMermaid(token) {
    const codes = Array.from(el.querySelectorAll('pre > code.language-mermaid'));
    if (!codes.length) return;
    const isDark = document.documentElement.dataset.mode === 'dark';

    const jobs = [];
    codes.forEach((code, i) => {
      const pre = code.parentElement;
      const source = code.textContent || '';
      const container = document.createElement('div');
      container.className = 'mermaid-container';
      container.id = `fm-mermaid-${Date.now()}-${++mermaidSeq}-${i}`;
      container.textContent = source; // 必须是原始代码，mermaid.run 从 textContent 取
      pre.replaceWith(container);
      jobs.push({ container, source });
    });

    const runStep = async () => {
      initMermaid(isDark);
      await mermaid.run({ nodes: jobs.map((j) => j.container) });
    };
    const runPromise = mermaidQueue.then(runStep, runStep);
    mermaidQueue = runPromise.catch(() => {});

    try {
      await runPromise;
    } catch (e) {
      if (token !== renderToken) return;
      for (const { container, source } of jobs) {
        if (container.querySelector('svg')) continue;
        container.textContent = '';
        const err = document.createElement('div');
        err.className = 'mermaid-error';
        err.textContent = '图表渲染失败：' + (e && e.message ? e.message : e) + '\n\n' + source;
        container.appendChild(err);
      }
    }
  }

  function highlightCode() {
    el.querySelectorAll('pre > code').forEach((code) => {
      const cls = Array.from(code.classList).find((c) => c.startsWith('language-'));
      if (cls === 'language-mermaid') return;
      const lang = cls ? cls.slice('language-'.length).toLowerCase() : '';
      if (!code.dataset.highlighted) {
        try {
          hljs.highlightElement(code);
          code.dataset.highlighted = '1';
        } catch (_) {}
      }
      const pre = code.parentElement;
      if (pre && lang && !pre.querySelector('.code-lang')) {
        const tag = document.createElement('span');
        tag.className = 'code-lang';
        tag.textContent = lang;
        pre.appendChild(tag);
      }
    });
  }

  function wireTaskLists() {
    el.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.disabled = false;
      box.addEventListener('click', (e) => {
        e.preventDefault();
        const host = box.closest('[data-source-line]');
        const line = host ? parseInt(host.getAttribute('data-source-line'), 10) : 0;
        box.checked = !box.checked;
        if (onTaskToggle && line) onTaskToggle(line, box.checked);
      });
    });
  }

  function indexBlocks() {
    const nodes = el.querySelectorAll('[data-source-line]');
    blocks = [];
    const seen = new Set();
    nodes.forEach((node) => {
      const line = parseInt(node.getAttribute('data-source-line'), 10);
      if (!line || seen.has(node)) return;
      seen.add(node);
      let top = 0;
      let cur = node;
      while (cur && cur !== el) {
        top += cur.offsetTop;
        cur = cur.offsetParent;
        if (cur === el) break;
      }
      blocks.push({ line, top, el: node });
    });
    blocks.sort((a, b) => a.line - b.line || a.top - b.top);
    // 同一行只保留最外层（第一个）
    const dedup = [];
    for (const b of blocks) {
      if (dedup.length && dedup[dedup.length - 1].line === b.line) continue;
      dedup.push(b);
    }
    blocks = dedup;
  }

  /* -------------------------------------------------------------- 主渲染 */
  async function render(markdown, { docPath } = {}) {
    currentDir = dirname(docPath || '');
    const token = ++renderToken;
    let html = '';
    try {
      html = window.UnifiedRenderer.renderMarkdown(markdown || '', {
        softBreaks: !!prefs.softBreaks,
      });
    } catch (e) {
      console.error('[render] 渲染失败', e);
      html = `<pre>${escapeHTML(markdown || '')}</pre>`;
    }
    if (token !== renderToken) return;
    el.innerHTML = html;
    // innerHTML 会清掉标记层，重新挂回去并按上次行号恢复高亮
    el.appendChild(cursorMark);

    resolveResources();
    renderMath();
    highlightCode();
    wireTaskLists();
    indexBlocks();

    // mermaid 是唯一异步的一步，放最后且不阻塞滚动同步的可用性
    await renderMermaid(token);
    if (token === renderToken) indexBlocks();
    return outline();
  }

  function outline() {
    return Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => ({
      level: parseInt(h.tagName.slice(1), 10),
      text: h.textContent.trim(),
      id: h.id || '',
      line: parseInt(h.getAttribute('data-source-line') || '0', 10),
    }));
  }

  /* -------------------------------------------------------------- 滚动换算 */
  function blockAtLine(line) {
    if (!blocks.length) return null;
    let lo = 0;
    let hi = blocks.length - 1;
    let best = blocks[0];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].line <= line) {
        best = blocks[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function nextBlock(block) {
    const idx = blocks.indexOf(block);
    return idx >= 0 && idx + 1 < blocks.length ? blocks[idx + 1] : null;
  }

  /** 编辑器滚动 → 预览滚动：按「当前行落在哪两个块之间」做线性插值，避免整页比例缩放的漂移。 */
  function syncFromLine(line, fraction) {
    const b = blockAtLine(line);
    if (!b) return;
    const nb = nextBlock(b);
    const lineSpan = nb ? nb.line - b.line : 1;
    const into = Math.max(0, Math.min(1, (line - b.line + fraction) / Math.max(1, lineSpan)));
    const topSpan = nb ? nb.top - b.top : 0;
    const target = b.top + topSpan * into;
    scrollEl.scrollTop = Math.max(0, target - 8);
  }

  /** 预览滚动 → 返回最贴近顶部的源码行，供反向同步用。 */
  function topLineInfo() {
    if (!blocks.length) return { line: 1, fraction: 0 };
    const y = scrollEl.scrollTop + 8;
    let cur = blocks[0];
    for (const b of blocks) {
      if (b.top <= y) cur = b;
      else break;
    }
    const nb = nextBlock(cur);
    const span = nb ? Math.max(1, nb.top - cur.top) : 1;
    const fraction = nb ? Math.max(0, Math.min(1, (y - cur.top) / span)) : 0;
    return { line: cur.line, fraction };
  }

  function scrollToLine(line) {
    const b = blockAtLine(line);
    if (!b) return;
    scrollEl.scrollTop = Math.max(0, b.top - 8);
  }

  /**
   * 把光标所在源码行对应的预览块高亮：整块淡背景 + 左侧竖条标记。
   * 只移动覆盖层，不改预览内容 DOM；pointer-events:none 不遮挡交互。
   * @param {number} line 1 基源码行号；传 0/falsy 表示隐藏标记
   */
  function highlightCursorLine(line) {
    markedLine = line || 0;
    const b = markedLine ? blockAtLine(markedLine) : null;
    if (!b || !b.el || !b.el.isConnected) {
      cursorMark.classList.add('hidden');
      return;
    }
    // rect 差值计算相对 el 内容框的位置（块可能在嵌套结构里，比 offsetTop 累加更可靠）
    const hostRect = el.getBoundingClientRect();
    const blockRect = b.el.getBoundingClientRect();
    const top = blockRect.top - hostRect.top;
    const height = blockRect.height;
    if (!(height > 0)) {
      cursorMark.classList.add('hidden');
      return;
    }
    cursorMark.style.top = `${top}px`;
    cursorMark.style.height = `${height}px`;
    cursorMark.classList.remove('hidden');
  }

  return {
    el,
    scrollEl,
    render,
    outline,
    syncFromLine,
    topLineInfo,
    scrollToLine,
    highlightCursorLine,
    refreshMermaidTheme(isDark) {
      initializedMode = null;
      initMermaid(isDark);
    },
    handleClick(e) {
      const img = e.target.closest('img');
      if (img && onImageClick) {
        onImageClick(img.src);
        e.preventDefault();
        return true;
      }
      const a = e.target.closest('a');
      if (a) {
        if (a.dataset.mdlink && onOpenFile) {
          onOpenFile(a.dataset.mdlink, { line: 0 });
          e.preventDefault();
          return true;
        }
        const href = a.getAttribute('href') || '';
        if (/^#/.test(href)) {
          const target = el.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
          if (target) {
            scrollEl.scrollTop = Math.max(0, target.offsetTop - 8);
            e.preventDefault();
            return true;
          }
        }
      }
      return false;
    },
  };
}
