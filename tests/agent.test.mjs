// agent.js 纯函数单测（Node 原生断言，无需测试框架）。
// 把 agent.js 里的 ipc 依赖换成 mock，再用 esbuild 打成 CJS 后加载真实函数。
// 运行：npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let src = fs.readFileSync(path.join(root, 'src/app/agent.js'), 'utf8');
src = src.replace(
  "import * as ipc from './ipc.js';",
  `const ipc = { aiChat: async () => { throw new Error('no mock'); }, describeError: (e) => String(e) };`
);
const built = await esbuild.transform(src, { loader: 'js', format: 'cjs', platform: 'node' });
const module_ = { exports: {} };
new Function('module', 'exports', 'require', built.code)(module_, module_.exports, (id) => {
  throw new Error('unexpected require: ' + id);
});
const { contentSignature, parseEdits, applyEdits, fencesBalanced, cleanOutput } = module_.exports;

// citations.js 纯函数模块：同样用 esbuild transform 加载，避免 ESM 警告
const citeSrc = fs.readFileSync(path.join(root, 'src/app/citations.js'), 'utf8');
const citeBuilt = await esbuild.transform(citeSrc, { loader: 'js', format: 'cjs', platform: 'node' });
const citeModule = { exports: {} };
new Function('module', 'exports', 'require', citeBuilt.code)(citeModule, citeModule.exports, () => {
  throw new Error('unexpected require');
});
const { extractCitations, linkCitationMarks } = citeModule.exports;
const tokenSrc = fs.readFileSync(path.join(root, 'src/app/token-budget.js'), 'utf8');
const tokenBuilt = await esbuild.transform(tokenSrc, { loader: 'js', format: 'cjs', platform: 'node' });
const tokenModule = { exports: {} };
new Function('module', 'exports', 'require', tokenBuilt.code)(tokenModule, tokenModule.exports, () => { throw new Error('unexpected require'); });
const { estimateTokens, outputBudget, selectHistory } = tokenModule.exports;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\ncontentSignature — 排版整理的内容不变式');

// 核心回归：排版整理补空格是纯格式改动，签名必须相等（此前 \s+ 会误判为改字）
test('标题补空格 #标题 → # 标题', () => {
  assert.equal(contentSignature('#标题'), contentSignature('# 标题'));
});
test('多级标题补空格 ##小节 → ## 小节', () => {
  assert.equal(contentSignature('##小节'), contentSignature('## 小节'));
});
test('无序列表补空格 -a → - a', () => {
  assert.equal(contentSignature('-a'), contentSignature('- a'));
});
test('有序列表补空格 1.项目 → 1. 项目', () => {
  assert.equal(contentSignature('1.项目'), contentSignature('1. 项目'));
});
test('引用补空格 >引用 → > 引用', () => {
  assert.equal(contentSignature('>引用'), contentSignature('> 引用'));
});
test('整篇排版整理（混合标记补空格）签名相等', () => {
  const before = ['#标题', '-a', '- b', '>引用', '##小节', '正文。'].join('\n');
  const after = ['# 标题', '- a', '- b', '> 引用', '## 小节', '正文。'].join('\n');
  assert.equal(contentSignature(before), contentSignature(after));
});

// 反例：真的改了文字必须判不等，护栏不能失效
test('真的改字 #标题 → # 标提 判不等', () => {
  assert.notEqual(contentSignature('#标题'), contentSignature('# 标提'));
});
test('列表真的改字 -苹果 → - 香蕉 判不等', () => {
  assert.notEqual(contentSignature('-苹果'), contentSignature('- 香蕉'));
});
test('强调符号变化 **粗体** → __粗体__ 判等价', () => {
  assert.equal(contentSignature('**粗体**'), contentSignature('__粗体__'));
});

console.log('\nparseEdits / applyEdits — 补丁协议');
test('解析 REPLACE / DELETE / INSERT + END', () => {
  const { edits, sawEnd } = parseEdits('REPLACE 2-2\n新\nDELETE 3-3\nINSERT 0\n头\nEND');
  assert.equal(sawEnd, true);
  assert.equal(edits.length, 3);
  assert.deepEqual(edits.map((e) => e.op), ['REPLACE', 'DELETE', 'INSERT']);
});
test('从后往前打补丁，行号不错位', () => {
  const { edits } = parseEdits('REPLACE 2-2\n二新\nREPLACE 4-4\n四新\nEND');
  const { lines, errors } = applyEdits(['一', '二', '三', '四'], edits, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(lines, ['一', '二新', '三', '四新']);
});
test('越界指令报错且不改文档', () => {
  const { edits } = parseEdits('REPLACE 99-99\n不存在\nEND');
  const { errors } = applyEdits(['一', '二'], edits, 1);
  assert.equal(errors.length, 1);
});

console.log('\nfencesBalanced / cleanOutput — 输出兜底');
test('代码围栏不成对被识别', () => {
  assert.equal(fencesBalanced('```js\ncode'), false);
  assert.equal(fencesBalanced('```js\ncode\n```'), true);
});
test('cleanOutput 去掉整体围栏', () => {
  assert.equal(cleanOutput('```markdown\n# 标题\n```'), '# 标题');
});
test('cleanOutput 去掉「改写后如下：」前缀', () => {
  assert.equal(cleanOutput('改写后如下：\n# 标题'), '# 标题');
});

console.log('\nextractCitations — 联网搜索来源解析');
test('结构化 url_citation 归一化并按 URL 去重', () => {
  const cites = extractCitations('', [
    { url: 'https://a.com/x', title: 'A' },
    { url: 'https://a.com/x', title: '重复' },
    { url: 'ftp://bad.com', title: '非 http' },
  ]);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].title, 'A');
});
test('正文 markdown 链接与裸链接提取，结构化在前', () => {
  const cites = extractCitations(
    '详见 [官方文档](https://docs.example.com/guide)，也可访问 https://extra.org/page。',
    [{ url: 'https://primary.dev', title: 'Primary' }]
  );
  assert.deepEqual(cites.map((c) => c.url), [
    'https://primary.dev', 'https://docs.example.com/guide', 'https://extra.org/page',
  ]);
});
test('无来源时返回空数组', () => {
  assert.deepEqual(extractCitations('普通回答，没有链接。', null), []);
});
test('超过 12 个来源时截断', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://x.com/${i}` }));
  assert.equal(extractCitations('', many).length, 12);
});

console.log('\nskillVariables — 技能变量');
const skillsSrc = fs.readFileSync(path.join(root, 'src/app/skills.js'), 'utf8');
const skillsBuilt = await esbuild.transform(skillsSrc, { loader: 'js', format: 'cjs', platform: 'node' });
const skillsModule = { exports: {} };
new Function('module', 'exports', 'require', skillsBuilt.code)(skillsModule, skillsModule.exports, () => { throw new Error('unexpected require'); });
test('提取并填充 {{变量}}', () => {
  const vars = skillsModule.exports.skillVariables('用{{语言}}写一段关于{{主题}}的介绍，{{主题}}要具体');
  assert.deepEqual(vars, ['语言', '主题']);
  const filled = skillsModule.exports.fillSkillVariables('用{{语言}}写{{主题}}', { 语言: '中文', 主题: 'AI' });
  assert.equal(filled, '用中文写AI');
});

console.log('\nlinkCitationMarks — 编号转可点击来源');
test('[n] 转成指向对应来源的链接', () => {
  const cites = [{ url: 'https://a.com', title: 'A' }, { url: 'https://b.com', title: 'B' }];
  const out = linkCitationMarks('结论[1]另有说法[2]。', cites);
  assert.equal(out, '结论[1](https://a.com)另有说法[2](https://b.com)。');
});
test('无效编号与已链接编号不重复处理', () => {
  const cites = [{ url: 'https://a.com', title: 'A' }];
  assert.equal(linkCitationMarks('无效[9]与已有[1](https://x.com)', cites), '无效[9]与已有[1](https://x.com)');
});

console.log('\nestimateTokens / selectHistory — token 预算');
test('中文估算约为英文的 3-4 倍', () => {
  const zh = estimateTokens('这是一段中文文本');
  const en = estimateTokens('this is english text');
  assert.ok(zh > en, `zh=${zh} en=${en}`);
});
test('写作预算高于问答预算', () => {
  assert.ok(outputBudget('write') > outputBudget('chat'));
});
test('历史按预算保留最近消息', () => {
  const history = [
    { role: 'user', content: '一'.repeat(5000) },
    { role: 'assistant', content: '旧回答' },
    { role: 'user', content: '新问题' },
  ];
  const kept = selectHistory(history, 100);
  assert.ok(kept.length >= 1);
  assert.equal(kept[kept.length - 1].content, '新问题');
});

console.log(`\n${passed} 项通过` + (process.exitCode ? '（有失败）' : ''));
