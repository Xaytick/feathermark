// 设置面板：从「声明式 schema」生成 DOM，改一项立即生效并落盘。
import { prefs, savePrefs, resetPrefs } from './store.js';
import * as ipc from './ipc.js';

const SCHEMES = [
  { id: 'ink', color: '#2f6feb' },
  { id: 'forest', color: '#0f8a5f' },
  { id: 'amber', color: '#c2620a' },
  { id: 'violet', color: '#7c4ddb' },
];

export function createSettings({ body, onApply }) {
  let fonts = null; // 系统字体列表，首次打开时才枚举（要解析上百个字体文件头）

  const apply = (key, value, immediate = true) => {
    prefs[key] = value;
    savePrefs();
    if (immediate && onApply) onApply(key, value);
  };

  function row(label, desc, control) {
    const wrap = document.createElement('div');
    wrap.className = 'set-row';
    const left = document.createElement('div');
    left.innerHTML = `<div class="set-label">${label}</div>${desc ? `<div class="set-desc">${desc}</div>` : ''}`;
    const right = document.createElement('div');
    right.className = 'set-control';
    right.appendChild(control);
    wrap.appendChild(left);
    wrap.appendChild(right);
    return wrap;
  }

  function group(title) {
    const g = document.createElement('div');
    g.className = 'set-group';
    const t = document.createElement('div');
    t.className = 'set-group-title';
    t.textContent = title;
    g.appendChild(t);
    return g;
  }

  function segmented(options, value, onPick, { small = false } = {}) {
    const el = document.createElement('div');
    el.className = 'seg';
    options.forEach((opt) => {
      const b = document.createElement('button');
      b.textContent = opt.label;
      if (opt.value === value) b.classList.add('on');
      b.addEventListener('click', () => {
        el.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onPick(opt.value);
      });
      el.appendChild(b);
    });
    return el;
  }

  function toggle(value, onChange) {
    const el = document.createElement('div');
    el.className = 'switch' + (value ? ' on' : '');
    el.addEventListener('click', () => {
      const next = !el.classList.contains('on');
      el.classList.toggle('on', next);
      onChange(next);
    });
    return el;
  }

  function numberInput(value, { min = 10, max = 32, step = 0.5 } = {}, onChange) {
    const el = document.createElement('input');
    el.type = 'number';
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.value = String(value);
    el.addEventListener('change', () => {
      const n = Math.min(max, Math.max(min, Number(el.value) || value));
      el.value = String(n);
      onChange(n);
    });
    return el;
  }

  function fontSelect(current, onChange) {
    const sel = document.createElement('select');
    const def = document.createElement('option');
    def.value = '';
    def.textContent = '跟随界面字体';
    sel.appendChild(def);
    if (fonts) {
      for (const f of fonts) {
        const o = document.createElement('option');
        o.value = f;
        o.textContent = f;
        if (f === current) o.selected = true;
        sel.appendChild(o);
      }
    } else {
      const o = document.createElement('option');
      o.value = current || '';
      o.textContent = current || '加载字体列表…';
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    const wrap = document.createElement('div');
    wrap.className = 'set-control wide';
    wrap.appendChild(sel);
    return wrap;
  }

  function render() {
    body.innerHTML = '';

    /* ---------------------------------------------------------- 外观 */
    const g1 = group('外观');
    g1.appendChild(
      row(
        '主题',
        '跟随系统时随 macOS / Windows 的明暗设置切换',
        segmented(
          [
            { label: '浅色', value: 'light' },
            { label: '深色', value: 'dark' },
            { label: '跟随系统', value: 'system' },
          ],
          prefs.themeMode,
          (v) => apply('themeMode', v)
        )
      )
    );

    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    SCHEMES.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (prefs.scheme === s.id ? ' on' : '');
      b.style.background = s.color;
      b.title = s.id;
      b.addEventListener('click', () => {
        swatches.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        apply('scheme', s.id);
      });
      swatches.appendChild(b);
    });
    g1.appendChild(row('配色', '只换强调色，明暗基调由主题决定', swatches));
    g1.appendChild(
      row(
        '默认分屏',
        '左右或上下对照；也可以用状态栏按钮临时切换',
        segmented(
          [
            { label: '左右', value: 'h' },
            { label: '上下', value: 'v' },
          ],
          prefs.splitDir,
          (v) => apply('splitDir', v)
        )
      )
    );
    body.appendChild(g1);

    /* ---------------------------------------------------------- 字体 */
    const g2 = group('字体');
    g2.appendChild(row('编辑器字体', '', fontSelect(prefs.editorFont, (v) => apply('editorFont', v))));
    g2.appendChild(
      row('编辑器字号', '', numberInput(prefs.editorSize, { min: 11, max: 28 }, (v) => apply('editorSize', v)))
    );
    g2.appendChild(row('预览字体', '', fontSelect(prefs.previewFont, (v) => apply('previewFont', v))));
    g2.appendChild(
      row('预览字号', '', numberInput(prefs.previewSize, { min: 11, max: 28 }, (v) => apply('previewSize', v)))
    );
    g2.appendChild(row('代码字体', '', fontSelect(prefs.codeFont, (v) => apply('codeFont', v))));
    g2.appendChild(
      row('代码字号', '', numberInput(prefs.codeSize, { min: 10, max: 22 }, (v) => apply('codeSize', v)))
    );
    body.appendChild(g2);

    /* ---------------------------------------------------------- 编辑 */
    const g3 = group('编辑');
    g3.appendChild(
      row(
        '自动换行',
        '长段落按窗口宽度折行',
        toggle(prefs.lineWrap, (v) => {
          apply('lineWrap', v);
          document.getElementById('sb-wrap').classList.toggle('on', v);
        })
      )
    );
    g3.appendChild(row('显示行号', '', toggle(prefs.lineNumbers, (v) => apply('lineNumbers', v))));
    g3.appendChild(
      row('自动配对标点', '输入 ( [ " 时自动补全另一半', toggle(prefs.autoPairs, (v) => apply('autoPairs', v)))
    );
    g3.appendChild(
      row(
        '软换行渲染',
        '把单个换行也当成分段（更接近你在源码里看到的断行）',
        toggle(prefs.softBreaks, (v) => apply('softBreaks', v))
      )
    );
    g3.appendChild(row('拼写检查', '依赖系统拼写词典', toggle(prefs.spellcheck, (v) => apply('spellcheck', v))));
    body.appendChild(g3);

    /* ---------------------------------------------------------- 关于 */
    const g4 = group('关于');
    const about = document.createElement('div');
    about.className = 'about-block';
    about.innerHTML = `
      <div><strong>FeatherMark</strong> 0.1.0 · 轻量跨平台 Markdown 编辑器</div>
      <div>技术栈：Tauri v2 + Rust · CodeMirror 5 · unified/remark 渲染管线 · KaTeX · Mermaid</div>
      <div>预览渲染器与文件命令层参考并移植自开源项目
        <a href="#" id="about-tizu">TizuMark</a>（GPL-3.0），本项目同样以 GPL-3.0 发布。</div>
      <div style="margin-top:8px;color:var(--text-faint)">快捷键：⌘N 新建 · ⌘O 打开 · ⌘S 保存 · ⌘P 快速打开 · ⌘F 查找 · ⌘⇧F 工作区搜索 · ⌘, 设置</div>`;
    g4.appendChild(about);
    body.appendChild(g4);

    const link = about.querySelector('#about-tizu');
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        ipc.openPath('https://github.com/tizuio/TizuMark-Markdown-Editor').catch(() => {});
      });
    }
  }

  async function loadFontsOnce() {
    if (fonts) return;
    try {
      fonts = await ipc.listSystemFonts();
      render();
    } catch (_) {
      fonts = [];
    }
  }

  return {
    render,
    open() {
      render();
      loadFontsOnce();
    },
    reset() {
      resetPrefs();
      render();
      if (onApply) onApply('__reset__', null);
    },
  };
}
