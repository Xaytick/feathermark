// 把渲染后的块 DOM 序列化回 Markdown 源码。
// 只处理本项目 unified 管线会渲染出的标签集合；未知标签按纯文本处理（保守，不丢内容）。
// 设计目标：用户在渲染块上直接编辑后，格式（粗斜体/代码/链接/标题/列表/引用）能还原。

function escapeText(s) {
  // 正文里的特殊字符需要转义，避免被重新解析成语法
  return s.replace(/([\\`*_\[\]])/g, '\\$1');
}

function inline(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.nodeType === 3) { out += escapeText(n.nodeValue || ''); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName.toLowerCase();
    const kids = inline(Array.from(n.childNodes));
    switch (tag) {
      case 'strong': case 'b': out += '**' + kids + '**'; break;
      case 'em': case 'i': out += '*' + kids + '*'; break;
      case 'del': case 's': out += '~~' + kids + '~~'; break;
      case 'code': out += '`' + kids + '`'; break;
      case 'a': {
        const href = n.getAttribute('href') || '';
        out += '[' + kids + '](' + href + ')';
        break;
      }
      case 'img': {
        const src = n.getAttribute('src') || '';
        const alt = n.getAttribute('alt') || '';
        out += '![' + alt + '](' + src + ')';
        break;
      }
      case 'br': out += '  \n'; break;
      case 'span': {
        // KaTeX 渲染后的公式：用原始 LaTeX（data-latex 或 katex 内部）还原
        const latex = n.getAttribute('data-latex');
        if (latex) { out += '$' + latex + '$'; break; }
        if (n.classList && n.classList.contains('katex')) {
          const ann = n.querySelector('.katex-mathml annotation');
          if (ann) { out += '$' + (ann.textContent || '') + '$'; break; }
        }
        out += kids; break;
      }
      default: out += kids;
    }
  }
  return out;
}

/** 把块渲染 DOM 的根元素序列化为一行或多行 Markdown。
 *  @param {HTMLElement} root 块 widget 内的渲染根（p/h1/li/blockquote/pre/table 等）
 *  @returns {string} Markdown 源码（不含块间空行）
 */
export function domToMarkdown(root) {
  if (!root) return '';
  const tag = root.tagName ? root.tagName.toLowerCase() : '';

  // 标题
  const hm = tag.match(/^h([1-6])$/);
  if (hm) return '#'.repeat(+hm[1]) + ' ' + inline(Array.from(root.childNodes));

  // 段落
  if (tag === 'p') return inline(Array.from(root.childNodes));

  // 列表：逐项输出，保留层级（嵌套 ul/ol 缩进）
  if (tag === 'ul' || tag === 'ol') return serializeList(root, 0).join('\n');

  // 引用：每行加 >
  if (tag === 'blockquote') {
    const lines = [];
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType !== 1) continue;
      const t = domToMarkdown(child);
      t.split('\n').forEach((l) => lines.push('> ' + l));
    }
    return lines.join('\n');
  }

  // 代码块：从 <code> 取纯文本
  if (tag === 'pre') {
    const code = root.querySelector('code') || root;
    const lang = (code.className || '').match(/language-([\w+-]+)/);
    const text = code.textContent || '';
    return '```' + (lang ? lang[1] : '') + '\n' + text.replace(/\n$/, '') + '\n```';
  }

  // 表格：还原 GFM 管道表
  if (tag === 'table') return serializeTable(root);

  // 分割线
  if (tag === 'hr') return '---';

  // 其他容器：递归子节点
  return Array.from(root.childNodes).map((n) => (n.nodeType === 1 ? domToMarkdown(n) : inline([n]))).join('\n');
}

function serializeList(list, depth) {
  const ordered = list.tagName.toLowerCase() === 'ol';
  const out = [];
  let idx = 0;
  for (const li of Array.from(list.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    idx++;
    const indent = '  '.repeat(depth);
    const marker = ordered ? idx + '. ' : '- ';
    // li 里可能混有文本 + 嵌套列表，分别处理
    let text = '';
    const sub = [];
    for (const n of Array.from(li.childNodes)) {
      if (n.nodeType === 1 && /^(ul|ol)$/i.test(n.tagName)) sub.push(n);
      else text += n.nodeType === 3 ? escapeText(n.nodeValue || '') : inline([n]);
    }
    // 任务列表 checkbox
    const box = li.querySelector(':scope > input[type="checkbox"]');
    let line = marker;
    if (box) line += (box.checked ? '[x] ' : '[ ] ');
    line += text.trim();
    out.push(indent + line);
    for (const s of sub) out.push.apply(out, serializeList(s, depth + 1));
  }
  return out;
}

function serializeTable(table) {
  const rows = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(tr.children).map((c) => inline(Array.from(c.childNodes)).trim());
    rows.push('| ' + cells.join(' | ') + ' |');
    // 表头后插分隔行
    if (tr.parentElement && tr.parentElement.tagName.toLowerCase() === 'thead') {
      rows.push('| ' + cells.map(() => '---').join(' | ') + ' |');
    }
  }
  return rows.join('\n');
}

/** 找块 widget 内真正的渲染根（跳过包装 div.markdown-body 等）。 */
export function renderedRoot(node) {
  if (!node) return null;
  const c = node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > p, :scope > ul, :scope > ol, :scope > blockquote, :scope > pre, :scope > table, :scope > hr, :scope > span.math-display');
  return c || node.firstElementChild || node;
}
