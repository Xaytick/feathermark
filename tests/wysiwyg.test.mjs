// wysiwyg.js 混合式 Live Preview 逻辑单测。
// 契约：正文块（h/p/ul/blockquote）用 markText 装饰、不挂 widget；
//      复杂块（table/pre/math）用 replacedWith widget；活动复杂块露出源码。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/app/wysiwyg.js'), 'utf8');
const built = await esbuild.transform(src, { loader: 'js', format: 'esm', platform: 'node' });
const blobUrl = 'data:text/javascript;base64,' + Buffer.from(built.code).toString('base64');
const { createWysiwyg } = await import(blobUrl);

// 混合块：0标题 1段落 2表格(复杂) 3代码块(复杂) 4列表
const BLOCKS = [
  { start: 0, end: 1, html: '<h1>标题</h1>' },
  { start: 1, end: 2, html: '<p>段落一</p>' },
  { start: 2, end: 4, html: '<table>表格</table>' },
  { start: 4, end: 6, html: '<pre><code>代码</code></pre>' },
  { start: 6, end: 7, html: '<ul><li>列表</li></ul>' },
];

function makeMockCM(lines) {
  let cursor = { head: { line: 0, ch: 0 } };
  const marks = new Map();
  let seq = 0;
  return {
    operation: (fn) => fn(),
    addLineClass() {}, removeLineClass() {},
    getViewport: () => ({ from: 0, to: Math.min(lines.length - 1, 20) }),
    getValue: () => lines.join('\n'),
    getLine: (i) => lines[i] || '',
    lineCount: () => lines.length,
    getCursor: (which) => (which === 'head' ? cursor.head : cursor),
    setCursor(pos) { cursor = { head: pos }; },
    getOption: () => 'gfm',
    getWrapperElement: () => ({ classList: { add() {}, remove() {} } }),
    markText(from, to, opts) {
      const id = ++seq;
      const mark = { clear() { marks.delete(id); }, _widget: opts.replacedWith, _opts: opts, _from: from, _to: to, _class: opts.className };
      marks.set(id, mark);
      return mark;
    },
    _marks: marks,
    _setLine(line) { cursor = { head: pos(line) }; },
  };
}
function pos(line) { return { line, ch: 0 }; }

// mock document（装饰里创建 img widget 才用到；此处无图）
global.document = {
  createElement: () => ({ className: '', dataset: {}, innerHTML: '', style: {},
    addEventListener() {}, querySelectorAll: () => [], appendChild() {} }),
};

const lines = ['# 标题', '段落一', '| a |', '| b |', '```', 'code', '- 列表'];

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.stack); process.exitCode = 1; }
}
function makeWw(cm, blocks = BLOCKS) {
  return createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => blocks.map((b) => ({ ...b })) },
    setTimer: (fn) => { fn(); return 1; },
  });
}
function mountedWidgetLines(cm) {
  return Array.from(cm._marks.values()).filter((m) => m._widget).map((m) => m._from.line).sort((a, b) => a - b);
}

console.log('\n混合式 Live Preview');
test('正文块不挂 widget，复杂块挂 widget（活动块除外）', () => {
  const cm = makeMockCM(lines);
  const ww = makeWw(cm);
  ww.enable();
  // 活动块=0(标题，正文)。复杂块2(表格)/3(代码)应挂 widget
  assert.deepEqual(mountedWidgetLines(cm), [2, 4]);
});

test('活动块是复杂块时：露出源码、不挂 widget', () => {
  const cm = makeMockCM(lines);
  const ww = makeWw(cm);
  ww.enable();
  cm.setCursor(pos(2)); // 光标进表格块
  ww.onCursorChanged();
  // 表格块(2)露出源码；代码块(4)仍挂 widget
  assert.deepEqual(mountedWidgetLines(cm), [4]);
  assert.equal(ww.activeBlock().start, 2);
});

test('光标离开复杂块：widget 盖回，其他块不动', () => {
  const cm = makeMockCM(lines);
  const ww = makeWw(cm);
  ww.enable();
  cm.setCursor(pos(2)); ww.onCursorChanged();
  assert.deepEqual(mountedWidgetLines(cm), [4]);
  cm.setCursor(pos(0)); ww.onCursorChanged();
  assert.deepEqual(mountedWidgetLines(cm), [2, 4]);
});

test('正文块切换只重绘装饰，不产生 widget', () => {
  const cm = makeMockCM(lines);
  const ww = makeWw(cm);
  ww.enable();
  cm.setCursor(pos(1)); ww.onCursorChanged(); // 段落块
  assert.deepEqual(mountedWidgetLines(cm), [2, 4]);
  assert.equal(ww.activeBlock().start, 1);
});

test('文档变化后 widget 按新块重建', () => {
  const cm = makeMockCM(lines);
  let calls = 0;
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => { calls++; return BLOCKS.map((b) => ({ ...b })); } },
    setTimer: (fn) => { fn(); return 1; },
  });
  ww.enable();
  assert.equal(calls, 1);
  ww.onDocChanged();
  assert.equal(calls, 2);
  assert.deepEqual(mountedWidgetLines(cm), [2, 4]);
});

test('disable 清空所有 widget 与装饰', () => {
  const cm = makeMockCM(lines);
  const ww = makeWw(cm);
  ww.enable();
  ww.disable();
  assert.deepEqual(mountedWidgetLines(cm), []);
  assert.equal(ww.isOn(), false);
});

test('widget 带 handleMouseEvents 且签名未变时复用实例', () => {
  const cm = makeMockCM(lines);
  const ww = makeWw(cm);
  ww.enable();
  const widgets = Array.from(cm._marks.values()).filter((m) => m._widget);
  for (const m of widgets) assert.equal(m._opts.handleMouseEvents, true);
  const before = new Map(widgets.map((m) => [m._from.line, m]));
  ww.onDocChanged();
  for (const m of Array.from(cm._marks.values()).filter((m) => m._widget)) {
    if (before.has(m._from.line)) assert.equal(m, before.get(m._from.line));
  }
});

test('正文装饰带 cm-lp- 类（标题/标记）', () => {
  const cm = makeMockCM(lines);
  const ww = makeWw(cm);
  ww.enable();
  const decorated = Array.from(cm._marks.values()).filter((m) => m._class && !m._widget);
  assert.ok(decorated.length > 0, '应有正文装饰 mark');
  assert.ok(decorated.some((m) => m._class.startsWith('cm-lp-')));
});

console.log(`\n${pass} 项通过`);
