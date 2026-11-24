// wysiwyg.js 单测：渲染态直接编辑 + 源码同步。
// 契约：所有块都挂渲染 widget（含活动块）；活动文本块进入编辑态；
//       input 时 DOM→Markdown 静默写回源码；切换块时旧块退出编辑、新块进入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/app/wysiwyg.js'), 'utf8');
const built = await esbuild.transform(src, { loader: 'js', format: 'esm', platform: 'node' });
const { createWysiwyg } = await import('data:text/javascript;base64,' + Buffer.from(built.code).toString('base64'));

const BLOCKS = [
  { start: 0, end: 1, html: '<h1>标题</h1>' },
  { start: 1, end: 2, html: '<p>段落一</p>' },
  { start: 2, end: 3, html: '<p>段落二</p>' },
  { start: 3, end: 5, html: '<table><tr><td>表格</td></tr></table>' },
];

function makeMockRoot() {
  const attrs = {};
  return {
    nodeType: 1, tagName: 'P',
    getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
    classList: { add() {}, remove() {} }, focus() {},
  };
}

function makeMockCM(linesRef) {
  let cursor = { head: { line: 0, ch: 0 } };
  const marks = new Map();
  let seq = 0;
  return {
    operation: (fn) => fn(),
    addLineClass() {}, removeLineClass() {},
    getViewport: () => ({ from: 0, to: Math.min(linesRef.length - 1, 20) }),
    getValue: () => linesRef.join('\n'),
    getLine: (i) => linesRef[i] || '',
    lineCount: () => linesRef.length,
    getCursor: (which) => (which === 'head' ? cursor.head : cursor),
    setCursor(pos) { cursor = { head: pos }; },
    replaceRange(text, from) { if (from.line === toLine(from)) linesRef[from.line] = text; },
    getOption: () => 'gfm',
    getWrapperElement: () => ({ classList: { add() {}, remove() {} } }),
    markText(from, to, opts) {
      const id = ++seq;
      const mark = { clear() { marks.delete(id); }, _widget: opts.replacedWith, _opts: opts, _from: from, _to: to };
      marks.set(id, mark);
      return mark;
    },
    _marks: marks,
  };
}
function toLine(p) { return p.line; }

global.document = {
  createElement() {
    const listeners = {};
    const attrs = {};
    return {
      className: '', dataset: {}, innerHTML: '', style: {}, listeners,
      nodeType: 1, tagName: 'DIV',
      getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; },
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {},
      focus() {}, closest() { return null; },
      classList: { add() {}, remove() {} },
    };
  },
  createRange: () => ({ selectNodeContents() {}, collapse() {} }),
};
global.window = {
  getSelection: () => null,
  DocToMarkdown: { renderedRoot: (node) => node },
};

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}
function makeWw(cm, blocks = BLOCKS, serialize = () => '段落X') {
  return createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => blocks.map((b) => ({ ...b })) },
    setTimer: (fn) => { fn(); return 1; },
    serializeBlock: serialize,
  });
}
function freshLines() { return ['# 标题', '段落一', '段落二', '| 表格 |', '| --- |']; }

console.log('\n渲染态直接编辑');
test('所有块都挂 widget（含活动块）', () => {
  const cm = makeMockCM(freshLines()); makeWw(cm).enable();
  assert.equal(cm._marks.size, BLOCKS.length);
});
test('活动文本块进入编辑态，复杂块不进入', () => {
  const cm = makeMockCM(freshLines()); const ww = makeWw(cm); ww.enable();
  const dbg = ww._debug();
  assert.ok(dbg.editing.includes(0), '活动标题块应进入编辑态');
  assert.ok(!dbg.editing.includes(3), '表格块不应进入编辑态');
});
test('切块：旧块退出编辑、新块进入，widget 数量不变（无重挂闪烁）', () => {
  const cm = makeMockCM(freshLines()); const ww = makeWw(cm); ww.enable();
  cm.setCursor({ line: 2, ch: 0 }); ww.onCursorChanged();
  const dbg = ww._debug();
  assert.ok(!dbg.editing.includes(0), '旧块退出编辑');
  assert.ok(dbg.editing.includes(2), '新块进入编辑');
  assert.equal(cm._marks.size, BLOCKS.length);
});
test('input → DOM 序列化写回源码', () => {
  const lines = freshLines(); const cm = makeMockCM(lines);
  const ww = makeWw(cm, BLOCKS, () => '**改后的段落**'); ww.enable();
  const w = Array.from(cm._marks.values()).find((m) => m._from.line === 1);
  w._widget.listeners.input[0]();
  assert.equal(lines[1], '**改后的段落**');
});
test('写回源码不重建 widget（保持实例，无闪烁）', () => {
  const lines = freshLines(); const cm = makeMockCM(lines);
  const ww = makeWw(cm, BLOCKS, () => '新内容'); ww.enable();
  const before = new Map(Array.from(cm._marks.values()).map((m) => [m._from.line, m]));
  const w = Array.from(cm._marks.values()).find((m) => m._from.line === 1);
  w._widget.listeners.input[0]();
  for (const m of cm._marks.values()) {
    if (before.has(m._from.line)) assert.equal(m, before.get(m._from.line));
  }
});
test('disable 清空 widget 与编辑态', () => {
  const cm = makeMockCM(freshLines()); const ww = makeWw(cm); ww.enable(); ww.disable();
  assert.equal(cm._marks.size, 0);
  assert.equal(ww._debug().editing.length, 0);
});
test('widget 带 handleMouseEvents', () => {
  const cm = makeMockCM(freshLines()); makeWw(cm).enable();
  for (const m of cm._marks.values()) assert.equal(m._opts.handleMouseEvents, true);
});

console.log(`\n${pass} 项通过`);
