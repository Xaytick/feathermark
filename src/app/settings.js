// 设置面板：从「声明式 schema」生成 DOM，改一项立即生效并落盘。
import { prefs, savePrefs, resetPrefs } from './store.js';
import * as ipc from './ipc.js';
import { getModels, addModel, removeModel, syncModelsFromConfig, onModelsChange } from './model-list.js';

const SCHEMES = [
  { id: 'ink', color: '#2f6feb' },
  { id: 'forest', color: '#0f8a5f' },
  { id: 'amber', color: '#c2620a' },
  { id: 'violet', color: '#7c4ddb' },
];

export function createSettings({ body, onApply }) {
  let fonts = null; // 系统字体列表，首次打开时才枚举（要解析上百个字体文件头）
  let aiCfg = null;

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

    const baseInput = document.createElement('input');
    baseInput.type = 'text';
    baseInput.placeholder = 'https://你的服务商/v1';
    baseInput.spellcheck = false;

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.id = 'ai-add-model-input';
    modelInput.placeholder = '模型 ID，例如 deepseek-chat';
    modelInput.spellcheck = false;
    modelInput.setAttribute('list', 'ai-model-list');
    const modelList = document.createElement('datalist');
    modelList.id = 'ai-model-list';

    const fetchBtn = document.createElement('button');
    fetchBtn.className = 'mini-btn';
    fetchBtn.textContent = '拉取列表';
    fetchBtn.title = '从接口的 /models 拉取可用模型';

    const extraInput = document.createElement('input');
    extraInput.type = 'text';
    extraInput.placeholder = '{}';
    extraInput.spellcheck = false;
    extraInput.title = 'JSON 对象，合并进请求体，例如 {"reasoning_effort":"none"}';

    const skipCheck = document.createElement('input');
    skipCheck.type = 'checkbox';
    skipCheck.style.width = '14px';
    skipCheck.style.height = '14px';
    skipCheck.style.accentColor = 'var(--accent)';

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

    wrap.appendChild(wideRow('接口地址', 'OpenAI 兼容地址，通常以 /v1 结尾', baseInput));

    // 已添加模型清单：点名称选用，点 × 删除
    const chips = document.createElement('div');
    chips.className = 'ai-model-chips';

    // 添加模型：输入模型 ID 后点「添加」，或从接口拉取后填入
    const addRow = document.createElement('div');
    addRow.className = 'ai-model-add';
    addRow.id = 'ai-add-model';
    const addBtn = document.createElement('button');
    addBtn.className = 'mini-btn';
    addBtn.type = 'button';
    addBtn.textContent = '添加';
    addBtn.title = '把模型 ID 加入清单';
    addRow.appendChild(modelInput);
    addRow.appendChild(addBtn);
    addRow.appendChild(fetchBtn);

    wrap.appendChild(wideRow('模型', '已添加的模型供 Agent 面板切换；点名称选用，点 × 删除', chips));
    wrap.appendChild(wideRow('添加模型', '手填模型 ID 加入清单，或从接口拉取后选择', addRow));
    wrap.appendChild(wideRow('API Key', '只存在本机配置文件里，不写入浏览器存储', keyInput));
    wrap.appendChild(
      wideRow('额外请求参数', 'JSON 对象，合并进请求体，一般不用改', extraInput)
    );
    wrap.appendChild(wideRow('不发送 temperature', '部分推理模型会拒绝这个字段', skipCheck));
    wrap.appendChild(result);
    wrap.appendChild(status);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;padding-top:8px';
    actions.appendChild(saveBtn);
    wrap.appendChild(actions);

    function renderModelChips() {
      const list = getModels();
      const current = modelInput.value.trim();
      chips.innerHTML = '';
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'ai-model-chips-empty';
        empty.textContent = '还没有添加模型';
        chips.appendChild(empty);
      }
      list.forEach((name) => {
        const chip = document.createElement('div');
        chip.className = 'ai-model-chip' + (name === current ? ' on' : '');
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'ai-model-chip-name';
        label.textContent = name;
        label.title = '设为当前模型';
        label.addEventListener('click', () => {
          modelInput.value = name;
          result.textContent = '';
          renderModelChips();
        });
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'ai-model-chip-x';
        x.textContent = '×';
        x.title = '从清单移除';
        x.addEventListener('click', () => removeModel(name));
        chip.appendChild(label);
        chip.appendChild(x);
        chips.appendChild(chip);
      });
      // 候选下拉与清单同步
      modelList.innerHTML = '';
      list.forEach((name) => {
        const o = document.createElement('option');
        o.value = name;
        modelList.appendChild(o);
      });
    }

    onModelsChange(renderModelChips);
    modelInput.addEventListener('input', renderModelChips);

    function addCurrentModel() {
      const name = modelInput.value.trim();
      if (!name) {
        result.style.color = 'var(--text-faint)';
        result.textContent = '先输入模型 ID，再点添加。';
        return;
      }
      const isNew = addModel(name);
      renderModelChips();
      result.style.color = 'var(--accent)';
      result.textContent = isNew ? `已添加：${name}` : '该模型已在清单中。';
    }
    addBtn.addEventListener('click', addCurrentModel);
    modelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCurrentModel();
      }
    });

    async function load() {
      try {
        aiCfg = await ipc.aiConfigGet();
        baseInput.value = aiCfg.base_url || '';
        modelInput.value = aiCfg.model || '';
        keyInput.value = '';
        keyInput.placeholder = aiCfg.has_key ? `已保存 ${aiCfg.key_hint}（留空不修改）` : '粘贴 API Key（本地模型可留空）';
        extraInput.value = aiCfg.extra_body || '{}';
        skipCheck.checked = !!aiCfg.skip_temperature;
        syncModelsFromConfig(aiCfg.model);
        renderModelChips();
        status.textContent = '';
      } catch (e) {
        status.textContent = '读取 AI 配置失败：' + ipc.describeError(e);
      }
    }

    fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = true;
      result.style.color = 'var(--text-faint)';
      result.textContent = '正在拉取模型列表…';
      try {
        // 先落盘当前地址与 Key，Rust 侧才有配置可读
        await ipc.aiConfigSet({
          provider: 'custom',
          baseUrl: baseInput.value,
          model: modelInput.value,
          apiKey: keyInput.value || null,
          temperature: 0.3,
          maxTokens: 4096,
          extraBody: extraInput.value || '{}',
          skipTemperature: skipCheck.checked,
        });
        const list = await ipc.aiModels();
        modelList.innerHTML = '';
        list.forEach((m) => {
          const o = document.createElement('option');
          o.value = m;
          modelList.appendChild(o);
        });
        result.style.color = 'var(--accent)';
        result.textContent = `拉到 ${list.length} 个模型，输入框可下拉选择，点「添加」加入清单。`;
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
          provider: 'custom',
          baseUrl: baseInput.value,
          model: modelInput.value,
          apiKey: keyInput.value || null,
          temperature: 0.3,
          maxTokens: 4096,
          extraBody: extraInput.value || '{}',
          skipTemperature: skipCheck.checked,
        });
        addModel(modelInput.value.trim());
        const r = await ipc.aiTest();
        result.style.color = 'var(--accent)';
        result.textContent = `连接正常 · ${r.model} · ${r.latency_ms}ms`;
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
    const gAi = group('AI 模型与接口');
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
      <div style="margin-top:8px;color:var(--text-faint)">快捷键：⌘N 新建 · ⌘O 打开 · ⌘S 保存 · ⌘P 快速打开 · ⌘F 查找 · ⌘⇧F 工作区搜索 · ⌘J Agent 编辑 · ⌘, 设置</div>`;
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
    open(opts) {
      render();
      loadFontsOnce();
      // 聊天输入框下拉选「添加模型…」时跳到这里，直接聚焦输入框
      if (opts && opts.focus === 'ai-add-model') {
        const input = body.querySelector('#ai-add-model-input');
        const target = body.querySelector('#ai-add-model');
        if (target) target.scrollIntoView({ block: 'center' });
        if (input) {
          input.focus();
          if (input.select) input.select();
        }
      }
    },
    reset() {
      resetPrefs();
      render();
      if (onApply) onApply('__reset__', null);
    },
  };
}
