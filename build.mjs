// FeatherMark 资源构建：把 node_modules 里的重型前端依赖 + 应用自身代码打成 webview 可直接
// <script> 加载的 iife bundle，并把 CodeMirror / KaTeX 的静态资源拷进 src/lib。
//
// 为什么要这一步：Tauri 的 webview 里没有 Node 的 require，而 unified 渲染链、mermaid、
// highlight.js 都是 npm 模块。这里统一用 esbuild 打成 iife，前端保持「经典 <script> +
// window 全局」形态（参考实现 TizuMark 的 ADR-4：dev 与 release 跑同一份源码，不需要 dev server）。
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const lib = path.join(src, 'lib');
const nm = path.join(root, 'node_modules');
const minify = process.env.FM_MINIFY === '1';

const copy = async (from, to) => {
  if (!existsSync(from)) throw new Error(`缺少依赖资源：${from}（先跑 npm install）`);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
};

async function main() {
  if (!existsSync(nm)) throw new Error('node_modules 不存在，请先执行 npm install');
  await mkdir(lib, { recursive: true });

  // 1) unified 渲染管线（单一真相源 src/unified-renderer.js → 全局 UnifiedRenderer）
  await build({
    entryPoints: [path.join(src, 'unified-renderer.js')],
    outfile: path.join(lib, 'unified-bundle.js'),
    bundle: true,
    format: 'iife',
    globalName: 'UnifiedRenderer',
    platform: 'browser',
    target: ['es2020'],
    legalComments: 'none',
    logLevel: 'warning',
  });
  console.log('✓ lib/unified-bundle.js');

  // 1b) CodeMirror 6（纯 ESM → iife，导出 window.CM6）
  await build({
    entryPoints: [path.join(src, 'cm6-vendor.js')],
    outfile: path.join(lib, 'cm6-bundle.js'),
    bundle: true,
    format: 'iife',
    globalName: 'CM6',
    platform: 'browser',
    target: ['es2020'],
    legalComments: 'none',
    logLevel: 'warning',
  });
  console.log('✓ lib/cm6-bundle.js');

  // 2) 应用主程序（含 @tauri-apps/api、对话框插件、mermaid、highlight.js、html2canvas、jsPDF）
  await build({
    entryPoints: [path.join(src, 'app/main.js')],
    outfile: path.join(lib, 'app-bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify,
    sourcemap: minify ? false : 'inline',
    legalComments: 'none',
    logLevel: 'warning',
  });
  console.log('✓ lib/app-bundle.js');

  // 3) CodeMirror 5 运行时（lib + 用到的 mode/addon）
  const cm = path.join(nm, 'codemirror');
  await copy(path.join(cm, 'lib/codemirror.js'), path.join(lib, 'codemirror/codemirror.js'));
  await copy(path.join(cm, 'lib/codemirror.css'), path.join(lib, 'codemirror/codemirror.css'));
  for (const m of ['markdown/markdown', 'xml/xml', 'javascript/javascript', 'css/css', 'htmlmixed/htmlmixed', 'yaml/yaml', 'meta']) {
    await copy(path.join(cm, `mode/${m}.js`), path.join(lib, `codemirror/mode/${path.basename(m)}.js`));
  }
  for (const a of [
    'edit/continuelist',
    'edit/closebrackets',
    'selection/active-line',
    'search/searchcursor',
    'fold/foldcode',
    'fold/foldgutter',
    'fold/markdown-fold',
    'comment/comment',
    'display/placeholder',
  ]) {
    await copy(path.join(cm, `addon/${a}.js`), path.join(lib, `codemirror/addon/${path.basename(a)}.js`));
  }
  console.log('✓ lib/codemirror/');

  // 4) KaTeX（js + 样式 + 字体目录）
  const katex = path.join(nm, 'katex/dist');
  await copy(path.join(katex, 'katex.min.js'), path.join(lib, 'katex/katex.min.js'));
  await copy(path.join(katex, 'katex.min.css'), path.join(lib, 'katex/katex.min.css'));
  await copy(path.join(katex, 'fonts'), path.join(lib, 'katex/fonts'));
  await copy(path.join(katex, 'contrib/auto-render.min.js'), path.join(lib, 'katex/auto-render.min.js'));
  console.log('✓ lib/katex/');

  // 5) 代码高亮主题（亮/暗各一份）
  await copy(path.join(nm, 'highlight.js/styles/github.css'), path.join(lib, 'hljs-github.css'));
  await copy(path.join(nm, 'highlight.js/styles/github-dark.css'), path.join(lib, 'hljs-github-dark.css'));
  console.log('✓ lib/hljs-*.css');

  console.log('\n构建完成：src/lib 已就绪');
}

main().catch((e) => {
  console.error('构建失败：', e.message);
  process.exit(1);
});
