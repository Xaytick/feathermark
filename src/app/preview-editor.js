// 预览模式编辑器（Obsidian 式 Live Preview，阶段 2）。
//
// 核心：所有文字始终是 CM6 文档内容，用 Decoration.mark 隐藏 Markdown 标记并套样式。
// 因此编辑、光标、选区、撤销全部由 CM6 原生管理——没有 CM5 widget hack 的闪烁/丢光标问题。
// 复杂块（表格/公式/代码围栏）无法靠样式呈现，用 Decoration.replace widget 真渲染展示。
//
// 视觉：标题分级、粗体、斜体、删除线、行内代码、链接、引用、列表标记隐藏，所见即所得。
export function createPreviewEditor({ State, View }) {
  const { StateField, RangeSetBuilder } = State;
  const { Decoration, WidgetType, EditorView } = View;
  const MARK = Decoration.mark;

  // 标记符号（隐藏）的 class
  const CLS_MARK = 'cm-pv-mark';

  // ---- 复杂块 widget（只读渲染） ----
  class RenderedBlockWidget extends WidgetType {
    constructor(html, startLine, hooks) {
      super();
      this.html = html; this.startLine = startLine; this.hooks = hooks;
    }
    eq(other) { return other.html === this.html && other.startLine === this.startLine; }
    toDOM() {
      const node = document.createElement('div');
      node.className = 'markdown-body cm-pv-block';
      node.innerHTML = this.html;
      if (this.hooks && this.hooks.postProcess) {
        try { this.hooks.postProcess(node); } catch (_) {}
      }
      return node;
    }
    ignoreEvent() { return false; }
  }

  /** 扫描文档生成 decorations。renderer 可选（用于复杂块真渲染）。 */
  function buildDecorations(state, renderer, hooks) {
    const decos = [];
    const add = (from, to, cls) => { if (to > from) decos.push({ from, to, cls, widget: null }); };
    const addWidget = (from, to, widget) => { if (to > from) decos.push({ from, to, cls: null, widget }); };
    const doc = state.doc;

    // 预扫描复杂块（围栏代码 / 表格），记录其行范围与渲染结果，整段用 replace widget
    const complexLines = new Set();
    if (renderer && renderer.renderMarkdownBlocks) {
      try {
        const blocks = renderer.renderMarkdownBlocks(doc.toString(), { softBreaks: false }) || [];
        for (const b of blocks) {
          const first = (b.html || '').match(/^<([\w-]+)/i);
          const tag = first ? first[1].toLowerCase() : '';
          if (tag === 'pre' || tag === 'table' || tag === 'span' || tag === 'div') {
            const from = doc.line(Math.max(1, b.start + 1)).from;
            const toLine = Math.min(doc.lines, b.end);
            const to = doc.line(toLine).to;
            addWidget(from, to, new RenderedBlockWidget(b.html, b.start, hooks));
            for (let l = b.start + 1; l <= toLine; l++) complexLines.add(l);
          }
        }
      } catch (_) {}
    }

    for (let ln = 0; ln < doc.lines; ln++) {
      if (complexLines.has(ln + 1)) continue;
      const line = doc.line(ln + 1);
      const text = line.text;
      const base = line.from;
      const fullFrom = base, fullTo = base + text.length;
      const trimmed = text.trim();

      // 标题：隐藏 # 标记 + 分级样式
      const hm = text.match(/^(#{1,6})(\s+)(.*)$/);
      if (hm) {
        const skip = hm[1].length + hm[2].length;
        add(base, base + skip, CLS_MARK);
        add(base + skip, fullTo, 'cm-pv-h' + hm[1].length);
        continue;
      }
      // 引用：隐藏 > 标记 + 样式
      const qm = text.match(/^(\s*(?:>\s?)+)(.*)$/);
      if (qm) {
        add(base, base + qm[1].length, CLS_MARK);
        add(base + qm[1].length, fullTo, 'cm-pv-quote');
        continue;
      }
      // 分割线：整行隐藏标记、用伪元素画线
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) {
        add(fullFrom, fullTo, 'cm-pv-hr');
        continue;
      }
      // 列表标记：隐藏 - / 1. / checkbox 符号
      const lm = text.match(/^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)(.*)$/);
      if (lm) {
        const from = base + lm[1].length;
        const to = from + lm[2].length;
        add(from, to, CLS_MARK);
      }

      // 行内语法（在去掉块标记后的内容区扫描）
      const off = lm ? lm[1].length + lm[2].length : (qm ? qm[1].length : (hm ? hm[1].length + hm[2].length : 0));
      const seg = text.slice(off);
      const addInline = (s, e, markCls, hideLen) => {
        const a = base + off + s, b = base + off + e;
        add(a, a + hideLen, CLS_MARK);
        add(a + hideLen, b - hideLen, markCls);
        add(b - hideLen, b, CLS_MARK);
      };
      // 行内代码 `code`
      let m; const codeRe = /`([^`\n]+)`/g;
      while ((m = codeRe.exec(seg))) addInline(m.index, m.index + m[0].length, 'cm-pv-code', 1);
      // 粗体 **x** / __x__
      const strongRe = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g;
      while ((m = strongRe.exec(seg))) addInline(m.index, m.index + m[0].length, 'cm-pv-strong', m[1].length);
      // 斜体 *x* / _x_
      const emRe = /(?<![*_`])([*_])(?![*_\s])([\s\S]*?\S)\1(?![*_])/g;
      while ((m = emRe.exec(seg))) addInline(m.index, m.index + m[0].length, 'cm-pv-em', 1);
      // 删除线 ~~x~~
      const delRe = /~~(?=\S)([\s\S]*?\S)~~/g;
      while ((m = delRe.exec(seg))) addInline(m.index, m.index + m[0].length, 'cm-pv-del', 2);
      // 链接 [文字](url)：只隐藏 []( url)，保留文字 + 链接色
      const linkRe = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
      while ((m = linkRe.exec(seg))) {
        const a = base + off + m.index;
        const textStart = a + 1, textEnd = textStart + m[1].length;
        add(a, textStart, CLS_MARK);
        add(textStart, textEnd, 'cm-pv-link');
        add(textEnd, a + m[0].length, CLS_MARK);
      }
    }
    // CM6 RangeSetBuilder 要求按 from 排序。同位置时用 startSide 区分（标记在前）。
    decos.sort((x, y) => x.from - y.from || x.to - y.to);
    const builder = new RangeSetBuilder();
    for (const d of decos) {
      if (d.widget) builder.add(d.from, d.to, Decoration.replace({ widget: d.widget, block: true }));
      else builder.add(d.from, d.to, MARK({ class: d.cls }));
    }
    return builder.finish();
  }

  /** 创建 CM6 扩展：StateField 管理 decorations，文档变化时重建。 */
  function createExtension({ renderer, hooks }) {
    const field = StateField.define({
      create(state) { return buildDecorations(state, renderer, hooks); },
      update(decos, tr) {
        if (tr.docChanged) return buildDecorations(tr.state, renderer, hooks);
        return decos.map(tr.changes);
      },
      provide: (f) => EditorView.decorations.from(f),
    });
    return field;
  }

  return { createExtension, RenderedBlockWidget, buildDecorations, CLS_MARK };
}
