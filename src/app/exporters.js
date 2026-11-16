// 导出：单文件 HTML、长图 PNG、PDF。全部离线完成，不依赖 Pandoc 之类的外部工具。
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import * as ipc from './ipc.js';
import { toast } from './ui.js';

const KATEX_WOFF2 = [
  'KaTeX_AMS-Regular',
  'KaTeX_Caligraphic-Bold',
  'KaTeX_Caligraphic-Regular',
  'KaTeX_Fraktur-Bold',
  'KaTeX_Fraktur-Regular',
  'KaTeX_Main-Bold',
  'KaTeX_Main-BoldItalic',
  'KaTeX_Main-Italic',
  'KaTeX_Main-Regular',
  'KaTeX_Math-BoldItalic',
  'KaTeX_Math-Italic',
  'KaTeX_SansSerif-Bold',
  'KaTeX_SansSerif-Italic',
  'KaTeX_SansSerif-Regular',
  'KaTeX_Script-Regular',
  'KaTeX_Size1-Regular',
  'KaTeX_Size2-Regular',
  'KaTeX_Size3-Regular',
  'KaTeX_Size4-Regular',
  'KaTeX_Typewriter-Regular',
];

const text = async (url) => (await fetch(url)).text();

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** KaTeX 样式里把 woff2 字体全部内联成 base64，导出的 HTML 才能脱离本机字体目录。 */
async function katexCss() {
  let css = await text('lib/katex/katex.min.css');
  const map = new Map();
  await Promise.all(
    KATEX_WOFF2.map(async (name) => {
      try {
        const buf = await fetch(`lib/katex/fonts/${name}.woff2`).then((r) => r.arrayBuffer());
        map.set(name, toBase64(buf));
      } catch (_) {
        /* 缺一个字体不影响大局，浏览器会回退 */
      }
    })
  );
  css = css.replace(/url\(fonts\/([\w-]+)\.woff2\)/g, (m, name) =>
    map.has(name) ? `url(data:font/woff2;base64,${map.get(name)})` : m
  );
  // woff / ttf 是给老浏览器的备份源，单文件导出里去掉，避免指向不存在的文件
  css = css.replace(/,\s*url\(fonts\/[\w-]+\.(woff|ttf)\)\s*format\("(woff|truetype)"\)/g, '');
  return css;
}

const hljsCss = (mode) => text(mode === 'dark' ? 'lib/hljs-github-dark.css' : 'lib/hljs-github.css');

function guessMime(p) {
  const ext = (String(p).split('.').pop() || 'png').toLowerCase();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
  };
  return map[ext] || 'image/png';
}

/** 把预览里的图片换成 data URL，导出的 HTML 才能单文件离线打开。 */
async function inlineImages(root) {
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      const local = img.dataset.localPath;
      const src = img.getAttribute('src') || '';
      try {
        if (local) {
          const b64 = await ipc.fetchImageAsBase64(local);
          img.setAttribute('src', `data:${guessMime(local)};base64,${b64}`);
        } else if (/^https?:/i.test(src)) {
          const b64 = await ipc.fetchImageAsBase64(src);
          img.setAttribute('src', `data:${guessMime(src)};base64,${b64}`);
        }
      } catch (_) {
        /* 单张图片失败就保留原地址 */
      }
      img.removeAttribute('loading');
      img.removeAttribute('data-local-path');
    })
  );
}

/** 克隆预览 DOM 到屏幕外，用于导出一致的内容（不影响当前视图）。 */
function mountExportNode(previewEl, { width = 860 } = {}) {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;background:${getComputedStyle(document.body).backgroundColor}`;
  const article = previewEl.cloneNode(true);
  article.classList.add('markdown-body');
  article.style.padding = '32px 6px';
  article.style.maxWidth = 'none';
  article.style.margin = '0';
  host.appendChild(article);
  document.body.appendChild(host);
  return { host, article };
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function buildStandaloneHTML({ previewEl, title }) {
  const mode = document.documentElement.dataset.mode;
  const scheme = document.documentElement.dataset.scheme;
  const [base, katex, hljs] = await Promise.all([text('styles.css'), katexCss(), hljsCss(mode)]);

  const article = previewEl.cloneNode(true);
  await inlineImages(article);
  article.querySelectorAll('.code-lang').forEach((n) => n.remove()); // 语言角标是交互产物，导出用不上

  return `<!DOCTYPE html>
<html lang="zh-CN" data-mode="${mode}" data-scheme="${scheme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(title)}</title>
<style>${base}</style>
<style>${katex}</style>
<style>${hljs}</style>
<style>
  body { margin: 0; background: var(--bg); color: var(--text); }
  .export-doc { max-width: 860px; margin: 0 auto; padding: 48px 28px 96px; user-select: text; }
  .export-doc img { max-width: 100%; }
  @media print { .export-doc { padding: 0; max-width: none; } }
</style>
</head>
<body>
<article class="markdown-body export-doc">${article.innerHTML}</article>
</body>
</html>`;
}

export async function exportHTML({ previewEl, title, defaultPath }) {
  const html = await buildStandaloneHTML({ previewEl, title });
  const target = await ipc.pickExportPath(defaultPath, [{ name: 'HTML', extensions: ['html', 'htm'] }]);
  if (!target) return false;
  await ipc.writeFile(target, html);
  toast('HTML 已导出');
  return target;
}

export async function exportPNG({ previewEl, defaultPath }) {
  const { host, article } = mountExportNode(previewEl, { width: 860 });
  try {
    // html2canvas 读不了 asset:// 协议，先把图片转成 data URL，否则导出的长图里图片是空白
    await inlineImages(article);
    const canvas = await html2canvas(article, {
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: 900,
    });
    const target = await ipc.pickExportPath(defaultPath, [{ name: 'PNG 图片', extensions: ['png'] }]);
    if (!target) return false;
    await ipc.saveBase64File(target, canvas.toDataURL('image/png'));
    toast('长图已导出');
    return target;
  } finally {
    host.remove();
  }
}

export async function exportPDF({ previewEl, defaultPath }) {
  const { host, article } = mountExportNode(previewEl, { width: 820 });
  try {
    await inlineImages(article);
    const canvas = await html2canvas(article, {
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: 860,
    });
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 28;
    const drawW = pageW - margin * 2;

    // 按 A4 高度切片：把长画布逐段画到临时 canvas 上，避免一次性缩放导致糊
    const scale = canvas.width / drawW; // 1pt 对应多少像素
    const sliceH = Math.floor((pageH - margin * 2) * scale);
    let offset = 0;
    let page = 0;
    while (offset < canvas.height) {
      const h = Math.min(sliceH, canvas.height - offset);
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = h;
      const ctx = slice.getContext('2d');
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, offset, canvas.width, h, 0, 0, canvas.width, h);
      if (page > 0) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, drawW, h / scale, undefined, 'FAST');
      offset += h;
      page++;
    }

    const target = await ipc.pickExportPath(defaultPath, [{ name: 'PDF', extensions: ['pdf'] }]);
    if (!target) return false;
    const dataUri = pdf.output('datauristring');
    await ipc.saveBase64File(target, dataUri);
    toast('PDF 已导出');
    return target;
  } finally {
    host.remove();
  }
}

export async function copyRichHTML(previewEl) {
  const article = previewEl.cloneNode(true);
  await inlineImages(article);
  const html = article.innerHTML;
  const plain = article.innerText;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    toast('已复制为富文本');
  } catch (_) {
    await navigator.clipboard.writeText(plain);
    toast('已复制为纯文本');
  }
}
