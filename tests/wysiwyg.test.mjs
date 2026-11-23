// wysiwyg.js 逻辑单测：用 mock CM 验证块挂载/切换/文档变化的行为。
// 重点验证：活动块露出源码（不挂 widget）、非活动块挂 widget、切换只影响两个块。
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

// 构造 mock 块数据（模拟 renderMarkdownBlocks 输出）
const BLOCKS = [
  { start: 0, end: 1, html: '<h1>标题</h1>' },
  { start: 1, end: 2, html: '<p>段落一</p>' },
  { start: 2, end: 3, html: '<p>段落二</p>' },
  { start: 4, end: 6, html: '<table>表格</table>' },
];

function makeMockCM(lines) {
  let cursor = { head: { line: 0, ch: 0 } };
  const marks = new Map();
  let seq = 0;
  return {
    operation: (fn) => fn(),
    addLineClass() {}, removeLineClass() {},
    getValue: () => lines.join('\n'),
    getLine: (i) => lines[i] || '',
    lineCount: () => lines.length,
    getCursor: (which) => (which === 'head' ? cursor.head : cursor),
    setCursor(pos) { cursor = { head: pos }; },
    getOption: () => 'gfm',
    markText(from, to, opts) {
      const id = ++seq;
      const mark = { clear() { marks.delete(id); }, _widget: opts.replacedWith, _opts: opts, _from: from, _to: to };
      marks.set(id, mark);
      return mark;
    },
    _marks: marks,
    _setLine(line) { cursor = { head: { line, ch: 0 } }; },
  };
}

// mock document（wysiwyg 里创建 div 节点）
global.document = {
  createElement: () => ({
    className: '', dataset: {}, innerHTML: '',
    addEventListener() {},
    querySelectorAll: () => [],
  }),
};

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.stack); process.exitCode = 1; }
}

console.log('\nWYSIWYG 块级渲染逻辑');
const lines = ['# 标题', '段落一', '段落二', '', '| a |', '| b |'];

test('enable 后：活动块=第0块，其余块挂 widget', () => {
  const cm = makeMockCM(lines);
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => BLOCKS.map((b) => ({ ...b })) },
    setTimer: (fn) => { fn(); return 1; }, // 测试用同步定时器
  });
  ww.enable();
  assert.equal(ww.activeBlock().start, 0);
  const mounted = ww._debug().mounted;
  // 活动块 0 不挂，其余 1/2/3 挂
  assert.deepEqual(mounted.slice().sort((a,b)=>a-b), [1, 2, 3]);
});

test('光标移到第2块：只切换块0和块2的 widget', () => {
  const cm = makeMockCM(lines);
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => BLOCKS.map((b) => ({ ...b })) },
    setTimer: (fn) => { fn(); return 1; }, // 测试用同步定时器
  });
  ww.enable();
  assert.deepEqual(ww._debug().mounted.slice().sort((a,b)=>a-b), [1, 2, 3]);
  cm._setLine(2); // 移到"段落二"（块2）
  ww.onCursorChanged();
  // 块0挂回 widget，块2摘掉；块1/3 不动
  assert.deepEqual(ww._debug().mounted.slice().sort((a,b)=>a-b), [0, 1, 3]);
});

test('光标在块外（空行）：所有块挂 widget', () => {
  const cm = makeMockCM(lines);
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => BLOCKS.map((b) => ({ ...b })) },
    setTimer: (fn) => { fn(); return 1; }, // 测试用同步定时器
  });
  ww.enable();
  cm._setLine(3); // 空行
  ww.onCursorChanged();
  assert.deepEqual(ww._debug().mounted.slice().sort((a,b)=>a-b), [0, 1, 2, 3]); // 块0 也挂回：光标不在任何块，全部渲染
  assert.equal(ww.activeBlock(), null);
});

test('文档变化：重新切块并重建 widget', () => {
  const cm = makeMockCM(lines);
  let callCount = 0;
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => { callCount++; return BLOCKS.map((b) => ({ ...b })); } },
    setTimer: (fn) => { fn(); return 1; },
  });
  ww.enable();
  assert.equal(callCount, 1);
  ww.onDocChanged();
  assert.equal(callCount, 2);
  assert.deepEqual(ww._debug().mounted.slice().sort((a,b)=>a-b), [1, 2, 3]);
});

test('disable 后清空所有 widget', () => {
  const cm = makeMockCM(lines);
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => BLOCKS.map((b) => ({ ...b })) },
    setTimer: (fn) => { fn(); return 1; }, // 测试用同步定时器
  });
  ww.enable();
  ww.disable();
  assert.deepEqual(ww._debug().mounted, []);
  assert.equal(ww.isOn(), false);
});

test('skipped 块不挂 widget（大文档降级）', () => {
  const cm = makeMockCM(lines);
  const skippedBlocks = BLOCKS.map((b, i) => ({ ...b, skipped: i === 1 }));
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => skippedBlocks },
    setTimer: (fn) => { fn(); return 1; },
  });
  ww.enable();
  assert.deepEqual(ww._debug().mounted.slice().sort((a,b)=>a-b), [2, 3]); // 块1 skipped
});


test('widget 挂 handleMouseEvents，保证块内点击生效', () => {
  const cm = makeMockCM(lines);
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => BLOCKS.map((b) => ({ ...b })) },
    setTimer: (fn) => { fn(); return 1; },
  });
  ww.enable();
  const marksWithWidget = Array.from(cm._marks.values()).filter((m) => m._widget);
  assert.ok(marksWithWidget.length > 0);
  for (const m of marksWithWidget) assert.equal(m._opts.handleMouseEvents, true);
});

test('渲染为空的块保持源码（不挂 widget）', () => {
  const cm = makeMockCM(lines);
  const blocksWithEmpty = BLOCKS.map((b, i) => i === 1 ? { ...b, html: '' } : { ...b });
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => blocksWithEmpty },
    setTimer: (fn) => { fn(); return 1; },
  });
  ww.enable();
  assert.deepEqual(ww._debug().mounted.slice().sort((a,b)=>a-b), [2, 3]);
});


test('rebuild 时签名未变的 widget 实例保持复用（不跳动）', () => {
  const cm = makeMockCM(lines);
  const ww = createWysiwyg({
    cm,
    renderer: { renderMarkdownBlocks: () => BLOCKS.map((b) => ({ ...b })) },
    setTimer: (fn) => { fn(); return 1; },
  });
  ww.enable();
  const before = new Map();
  for (const [i, m] of cm._marks) before.set(i, m);
  // 文档"变化"但块内容实际相同 → 再次 rebuild
  ww.onDocChanged();
  const after = ww._debug().mounted.slice().sort((a,b)=>a-b);
  assert.deepEqual(after, [1, 2, 3]);
  // 关键：未变块的 mark 实例是同一个（没被 clear 重建）
  for (const i of [1, 2, 3]) {
    const cur = Array.from(cm._marks.values()).find((m) => m._from.line === BLOCKS[i].start);
    assert.equal(cur, before.get(i), '块 ' + i + ' 的 widget 被重建了（会跳动）');
  }
});

console.log(`\n${pass} 项通过`);
