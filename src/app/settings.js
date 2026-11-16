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
  let aiCfg = null;

  // 常见的 OpenAI 兼容服务：选预设只填「地址 + 常用模型」，密钥仍需自己粘贴
  const AI_PRESETS = [
    { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'moonshot', name: 'Moonshot', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: 'zhipu', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'ollama', name: 'Ollama（本地）', base: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
    { id: 'custom', name: '自定义（OpenAI 兼容）', base: '', model: '' },
  ];

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


  /* ---------------------------------------------------------- AI 配置 */
  function buildAiSection() {
    const wrap = document.createElement('div');

    const presetSel = document.createElement('select');
    for (const p of AI_PRESETS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      presetSel.appendChild(o);
    }

    const baseInput = document.createElement('input');
    baseInput.type = 'text';
    baseInput.placeholder = 'https://api.deepseek.com/v1';
    baseInput.spellcheck = false;

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.placeholder = 'deepseek-chat';
    modelInput.spellcheck = false;
    modelInput.setAttribute('list', 'ai-model-list');
    const modelList = document.createElement('datalist');
    modelList.id = 'ai-model-list';

    const fetchBtn = document.createElement('button');
    fetchBtn.className = 'mini-btn';
    fetchBtn.textContent = '拉取列表';
    fetchBtn.title = '从接口的 /models 拉取可用模型';

    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = '粘贴 API Key';
    keyInput.spellcheck = false;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.textContent = '保存并测试';

    const status = document.createElement('div');
    status.className = 'ai-config-note';
    const result = document.createElement('div');
    result.className = 'ai-config-note';

    const wideRow = (label, desc, ...nodes) => {
      const holder = document.createElement('div');
      holder.style.cssText = 'display:flex;align-items:center;gap:8px;width:320px';
      nodes.forEach((n) => holder.appendChild(n));
      const r = row(label, desc, holder);
      r.querySelector('.set-control').style.width = '320px';
      return r;
    };

    wrap.appendChild(row('服务商', '选预设会自动填好接口地址与常用模型', wrapSelect(presetSel)));
    wrap.appendChild(wideRow('接口地址', 'OpenAI 兼容地址，通常以 /v1 结尾', baseInput));
    wrap.appendChild(wideRow('模型', '可手填，也可点「拉取列表」从接口取', modelInput, fetchBtn, modelList));
    wrap.appendChild(wideRow('API Key', '只存在本机配置文件里，不写入浏览器存储', keyInput));
    wrap.appendChild(
      result
    );
    wrap.appendChild(status);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;padding-top:8px';
    actions.appendChild(saveBtn);
    wrap.appendChild(actions);

    function wrapSelect(sel) {
      const holder = document.createElement('div');
      holder.className = 'set-control wide';
      holder.appendChild(sel);
      return holder;
    }

    async function load() {
      try {
        aiCfg = await ipc.aiConfigGet();
        presetSel.value = AI_PRESETS.some((p) => p.id === aiCfg.provider) ? aiCfg.provider : 'custom';
        baseInput.value = aiCfg.base_url || '';
        modelInput.value = aiCfg.model || '';
        keyInput.value = '';
        keyInput.placeholder = aiCfg.has_key ? `已保存 ${aiCfg.key_hint}（留空不修改）` : '粘贴 API Key（本地模型可留空）';
        status.innerHTML =
          `密钥存在本机：<code>${aiCfg.config_dir || ''}</code>，文件权限 600，仅当前用户可读。` +
          `<br>快捷键 <code>⌘J</code> 打开 AI 编辑；生成后先看差异，点「应用替换」才写入文档。`;
      } catch (e) {
        status.textContent = '读取 AI 配置失败：' + ipc.describeError(e);
      }
    }

    presetSel.addEventListener('change', () => {
      const p = AI_PRESETS.find((x) => x.id === presetSel.value);
      if (p && p.id !== 'custom') {
        baseInput.value = p.base;
        modelInput.value = p.model;
      }
      baseInput.focus();
    });

    fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = true;
      result.style.color = 'var(--text-faint)';
      result.textContent = '正在拉取模型列表…';
      try {
        // 先落盘当前地址与 Key，Rust 侧才有配置可读
        await ipc.aiConfigSet({
          provider: presetSel.value,
          baseUrl: baseInput.value,
          model: modelInput.value,
          apiKey: keyInput.value || null,
          temperature: 0.3,
          maxTokens: 4096,
        });
        const list = await ipc.aiModels();
        modelList.innerHTML = '';
        list.forEach((m) => {
          const o = document.createElement('option');
          o.value = m;
          modelList.appendChild(o);
        });
        result.style.color = 'var(--accent)';
        result.textContent = `拉到 ${list.length} 个模型，点模型输入框可下拉选择。`;
        if (!modelInput.value) modelInput.value = list[0];
      } catch (e) {
        result.style.color = '#e5484d';
        result.textContent = '拉取失败：' + ipc.describeError(e);
      } finally {
        fetchBtn.disabled = false;
      }
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      result.style.color = 'var(--text-faint)';
      result.textContent = '正在保存并测试连接…';
      try {
        await ipc.aiConfigSet({
          provider: presetSel.value,
          baseUrl: baseInput.value,
          model: modelInput.value,
          apiKey: keyInput.value || null,
          temperature: 0.3,
          maxTokens: 4096,
        });
        const r = await ipc.aiTest();
        result.style.color = 'var(--accent)';
        result.textContent = `连接正常 · ${r.model} · ${r.latency_ms}ms · 回复「${String(r.reply || '').trim().slice(0, 12)}」`;
        keyInput.value = '';
        load();
      } catch (e) {
        result.style.color = '#e5484d';
        result.textContent = '测试失败：' + ipc.describeError(e);
      } finally {
        saveBtn.disabled = false;
      }
    });

    load();
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

    /* ---------------------------------------------------------- AI */
    const gAi = group('AI 编辑');
    gAi.appendChild(buildAiSection());
    body.appendChild(gAi);

    /* ---------------------------------------------------------- 关于 */
    const g4 = group('关于');
    const about = document.createElement('div');
    about.className = 'about-block';
    about.innerHTML = `
      <div><strong>FeatherMark</strong> 0.1.0 · 轻量跨平台 Markdown 编辑器</div>
      <div>技术栈：Tauri v2 + Rust · CodeMirror 5 · unified/remark 渲染管线 · KaTeX · Mermaid</div>
      <div>预览渲染器与文件命令层参考并移植自开源项目
        <a href="#" id="about-tizu">TizuMark</a>（GPL-3.0），本项目同样以 GPL-3.0 发布。</div>
      <div style="margin-top:8px;color:var(--text-faint)">快捷键：⌘N 新建 · ⌘O 打开 · ⌘S 保存 · ⌘P 快速打开 · ⌘F 查找 · ⌘⇧F 工作区搜索 · ⌘J AI 编辑 · ⌘, 设置</div>`;
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
