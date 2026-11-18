// 设置面板：从「声明式 schema」生成 DOM，改一项立即生效并落盘。
import { prefs, savePrefs, resetPrefs } from './store.js';
import * as ipc from './ipc.js';
import { getModels, addModel, removeModel, syncModelsFromConfig, onModelsChange } from './model-list.js';
import { parseColors, listSchemes, saveScheme, deleteScheme, getScheme } from './color-schemes.js';
import { PRESETS, CANVASES, getPreset, tokensFromColors, resolveParams, defaultParams, luminance } from './theme-presets.js';
import { loadAndCompressImage } from './image-tools.js';

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

  function group(title, section) {
    const g = document.createElement('div');
    g.className = 'set-group';
    if (section) g.dataset.section = section;
    const t = document.createElement('div');
    t.className = 'set-group-title';
    t.textContent = title;
    g.appendChild(t);
    return g;
  }

  // 左侧导航分区：id / 标题 / 说明。各分组通过 group(title, section) 归入对应分区。
  const SECTIONS = [
    { id: 'appearance', label: '外观', hint: '主题 · 配色' },
    { id: 'editor', label: '编辑器', hint: '字体 · 编辑' },
    { id: 'ai', label: 'AI', hint: '模型 · 接口' },
    { id: 'about', label: '关于', hint: '版本 · 快捷键' },
  ];

  function buildNav() {
    const nav = document.getElementById('settings-nav');
    if (!nav) return;
    nav.innerHTML = '';
    SECTIONS.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'settings-nav-item' + (i === 0 ? ' on' : '');
      b.dataset.section = s.id;
      b.innerHTML = `<span class="sn-label">${s.label}</span><span class="sn-hint">${s.hint}</span>`;
      b.addEventListener('click', () => {
        const target = body.querySelector(`.set-group[data-section='${s.id}']`);
        if (!target) return;
        nav.querySelectorAll('.settings-nav-item').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        const y = target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
        body.scrollTo({ top: y, behavior: 'smooth' });
      });
      nav.appendChild(b);
    });

    // 滚动联动：根据滚动位置高亮当前分区
    body.onscroll = () => {
      let current = SECTIONS[0].id;
      const bodyTop = body.getBoundingClientRect().top;
      body.querySelectorAll('.set-group[data-section]').forEach((g) => {
        if (g.getBoundingClientRect().top - bodyTop <= 24) current = g.dataset.section;
      });
      nav.querySelectorAll('.settings-nav-item').forEach((x) => {
        x.classList.toggle('on', x.dataset.section === current);
      });
    };
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

  function slider(value, { min, max, step = 0.01, format } = {}, onChange) {
    const el = document.createElement('input');
    el.type = 'range';
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.value = String(value);
    el.className = 'ts-slider';
    const out = document.createElement('span');
    out.className = 'ts-slider-val';
    const sync = (v) => { out.textContent = format ? format(v) : String(v); };
    sync(value);
    el.addEventListener('input', () => {
      const n = Number(el.value);
      sync(n);
      onChange(n);
    });
    const box = document.createElement('div');
    box.className = 'ts-slider-box';
    box.appendChild(el);
    box.appendChild(out);
    return box;
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


  /* ---------------------------------------------------------- 主题创建工具 */
  function buildColorSchemesSection() {
    const wrap = document.createElement('div');
    wrap.className = 'color-schemes';

    // 0) AI 生成配色
    const aiBox = document.createElement('div');
    aiBox.className = 'cs-ai-box';
    const aiTitle = document.createElement('div');
    aiTitle.className = 'cs-ai-title';
    aiTitle.textContent = 'AI 生成配色';
    const aiHint = document.createElement('div');
    aiHint.className = 'cs-hint';
    aiHint.textContent = '描述你想要的风格，AI 生成一组和谐配色并填入下方配色框。';
    const aiInput = document.createElement('input');
    aiInput.type = 'text';
    aiInput.className = 'cs-ai-input';
    aiInput.id = 'cs-ai-input';
    aiInput.placeholder = '例如：温暖的秋日森林、赛博朋克霓虹、宁静的莫兰迪色';
    aiInput.maxLength = 120;
    const aiBtn = document.createElement('button');
    aiBtn.className = 'btn';
    aiBtn.textContent = '生成配色';
    aiBtn.id = 'cs-ai-btn';
    const aiMsg = document.createElement('div');
    aiMsg.className = 'cs-save-msg';
    aiMsg.id = 'cs-ai-msg';

    aiBtn.addEventListener('click', async () => {
      const prompt = aiInput.value.trim();
      aiMsg.textContent = '';
      if (!prompt) {
        aiMsg.className = 'cs-save-msg err';
        aiMsg.textContent = '请先输入配色描述';
        aiInput.focus();
        return;
      }
      aiBtn.disabled = true;
      aiMsg.className = 'cs-save-msg';
      aiMsg.textContent = '正在生成…';
      try {
        let cfg = {};
        try { cfg = await ipc.aiConfigGet() || {}; } catch (_) {}
        const base = Math.max(1024, Number(cfg.max_tokens) || 0);
        const messages = [
          { role: 'system', content: '你是专业配色设计师。根据用户描述生成一组美观、和谐、有设计感的配色。直接输出结果，不要输出思考过程、推理内容或任何分析。只输出颜色本身，每行一个 hex 值（#RRGGBB），输出 5 到 8 个颜色，不要任何解释、编号、标题、markdown 或多余文字。第一行是主色，其余为辅助色，彼此协调。' },
          { role: 'user', content: prompt },
        ];
        let res = null;
        let lastErr = null;
        for (const budget of [base, Math.max(base * 2, 4096)]) {
          try {
            res = await ipc.aiChat(messages, { maxTokens: budget });
            break;
          } catch (e) {
            const msg = (e && e.message) ? e.message : String(e);
            if (!/模型没有返回内容|max_tokens|reasoning_content|截断/.test(msg)) throw e;
            lastErr = e;
          }
        }
        if (!res) throw lastErr || new Error('AI 没有返回内容，请重试');
        const content = String((res && res.content) || '').trim();
        if (!content) throw new Error('AI 没有返回内容，请重试');
        const hexes = content.match(/#[\da-fA-F]{6}\b|#[\da-fA-F]{3}\b/g);
        const result = parseColors(hexes ? hexes.join('\n') : content);
        if (!result.colors.length) throw new Error('AI 返回的颜色无法识别，请换个描述重试');
        input.value = result.colors.map((c) => c.hex).join('\n');
        renderPreview(result);
        aiMsg.className = 'cs-save-msg ok';
        aiMsg.textContent = `已生成 ${result.colors.length} 个颜色，可在下方调整或保存`;
        input.scrollIntoView({ block: 'nearest' });
      } catch (e) {
        aiMsg.className = 'cs-save-msg err';
        aiMsg.textContent = '生成失败：' + ((e && e.message) ? e.message : String(e));
      } finally {
        aiBtn.disabled = false;
      }
    });
    aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); aiBtn.click(); }
    });
    aiBox.appendChild(aiTitle);
    aiBox.appendChild(aiHint);
    const aiRow = document.createElement('div');
    aiRow.className = 'cs-ai-row';
    aiRow.appendChild(aiInput);
    aiRow.appendChild(aiBtn);
    aiBox.appendChild(aiRow);
    aiBox.appendChild(aiMsg);
    wrap.appendChild(aiBox);

    // 1) 批量导入
    const hint = document.createElement('div');
    hint.className = 'cs-hint';
    hint.textContent = '支持 hex（#fff / #2F6FEB）、rgb(15,138,95)、「255, 0, 0」等格式，换行或逗号分隔多个。';
    wrap.appendChild(hint);

    const input = document.createElement('textarea');
    input.className = 'cs-input';
    input.id = 'cs-input';
    input.rows = 3;
    input.placeholder = '#2F6FEB, rgb(15, 138, 95)\n255, 255, 255\n#0f8a5f';
    input.spellcheck = false;
    wrap.appendChild(input);

    const parseBtn = document.createElement('button');
    parseBtn.className = 'btn cs-parse-btn';
    parseBtn.textContent = '解析预览';
    wrap.appendChild(parseBtn);

    // 2) 解析结果
    const preview = document.createElement('div');
    preview.className = 'cs-preview';
    preview.id = 'cs-preview';
    wrap.appendChild(preview);

    let parsed = [];
    const renderPreview = (result) => {
      parsed = result ? result.colors : [];
      preview.innerHTML = '';
      if (!result) return;
      if (result.colors.length) {
        const list = document.createElement('div');
        list.className = 'cs-swatches';
        result.colors.forEach((c) => {
          const chip = document.createElement('div');
          chip.className = 'cs-chip';
          const dot = document.createElement('span');
          dot.className = 'cs-chip-dot';
          dot.style.background = c.hex;
          const label = document.createElement('span');
          label.className = 'cs-chip-label';
          label.textContent = c.hex;
          chip.appendChild(dot); chip.appendChild(label);
          list.appendChild(chip);
        });
        preview.appendChild(list);
      }
      if (result.errors.length) {
        const errBox = document.createElement('div');
        errBox.className = 'cs-errors';
        result.errors.forEach((e) => {
          const line = document.createElement('div');
          line.className = 'cs-error-line';
          line.textContent = e.error;
          errBox.appendChild(line);
        });
        preview.appendChild(errBox);
      }
      if (!result.colors.length && !result.errors.length) {
        const empty = document.createElement('div');
        empty.className = 'cs-preview-empty';
        empty.textContent = '输入颜色后点「解析预览」';
        preview.appendChild(empty);
      }
      saveRow.style.display = parsed.length ? '' : 'none';
    };

    parseBtn.addEventListener('click', () => renderPreview(parseColors(input.value)));
    input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); renderPreview(parseColors(input.value)); }
    });
    input.addEventListener('input', () => renderPreview(null));

    // 3) 命名保存（存为新的自定义主题，绑定当前外观参数）
    const saveRow = document.createElement('div');
    saveRow.className = 'cs-save-row';
    saveRow.id = 'cs-save-row';
    saveRow.style.display = 'none';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'cs-name-input';
    nameInput.id = 'cs-name-input';
    nameInput.placeholder = '主题名称';
    nameInput.maxLength = 40;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.textContent = '保存为主题';
    const saveMsg = document.createElement('div');
    saveMsg.className = 'cs-save-msg';
    saveBtn.addEventListener('click', () => {
      saveMsg.textContent = '';
      const params = resolveParams(prefs.theme, prefs.theme.active);
      const res = saveScheme(nameInput.value, parsed, params);
      if (!res.ok) {
        saveMsg.className = 'cs-save-msg err';
        saveMsg.textContent = res.error;
        return;
      }
      saveMsg.className = 'cs-save-msg ok';
      saveMsg.textContent = `已保存「${res.scheme.name}」，可在上方主题卡片中选用`;
      nameInput.value = '';
      // 新主题立即生效并重绘设置
      prefs.theme.active = res.scheme.id;
      savePrefs();
      if (onApply) onApply('theme', prefs.theme);
      render();
    });
    saveRow.appendChild(nameInput);
    saveRow.appendChild(saveBtn);
    wrap.appendChild(saveRow);
    wrap.appendChild(saveMsg);

    renderPreview(null);
    return wrap;
  }

  /* ---------------------------------------------------------- Theme Studio */
  function buildThemeStudioSection() {
    const wrap = document.createElement('div');
    const theme = prefs.theme;
    const update = () => {
      savePrefs();
      if (onApply) onApply('theme', theme);
    };
    const activeId = theme.active;

    // 1) 主题卡片网格：内置预设 + 自定义主题（同样式展示）
    const presetLabel = document.createElement('div');
    presetLabel.className = 'set-desc';
    presetLabel.textContent = '主题预设（内置 + 自定义）';
    wrap.appendChild(presetLabel);
    const presetGrid = document.createElement('div');
    presetGrid.className = 'ts-presets';

    const builtins = PRESETS.map((p) => ({
      id: p.id, name: p.name, desc: p.desc, tokens: p.tokens, custom: false,
    }));
    const customs = listSchemes()
      .filter((sc) => sc.colors && sc.colors.length)
      .map((sc) => {
        const tokens = tokensFromColors(sc.colors, sc.tone) || {};
        return {
          id: sc.id, name: sc.name, desc: '自定义主题', tokens, custom: true,
        };
      });
    const allThemes = [...builtins, ...customs];

    allThemes.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'ts-preset-wrap';
      const btn = document.createElement('button');
      btn.className = 'ts-preset' + (activeId === t.id ? ' on' : '');
      btn.dataset.preset = t.id;
      const sw = document.createElement('div');
      sw.className = 'ts-preset-swatch';
      sw.style.background = t.tokens['--ed-bg'] || '#888';
      sw.style.borderColor = t.tokens['--ed-border'] || '#ccc';
      const bar = document.createElement('div');
      bar.className = 'ts-preset-bar';
      ['--ed-fg', '--ed-accent', '--ed-string', '--ed-keyword', '--ed-number'].forEach((k) => {
        const seg = document.createElement('span');
        seg.style.background = t.tokens[k] || '#999';
        bar.appendChild(seg);
      });
      sw.appendChild(bar);
      const name = document.createElement('div');
      name.className = 'ts-preset-name';
      name.textContent = t.name;
      const desc = document.createElement('div');
      desc.className = 'ts-preset-desc';
      desc.textContent = t.desc;
      btn.appendChild(sw); btn.appendChild(name); btn.appendChild(desc);
      btn.addEventListener('click', () => {
        theme.active = t.id;
        update();
        render();
      });
      card.appendChild(btn);
      // 自定义主题带删除角标
      if (t.custom) {
        const del = document.createElement('button');
        del.className = 'ts-preset-del';
        del.textContent = '×';
        del.title = '删除主题';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteScheme(t.id);
          if (theme.params) delete theme.params[t.id];
          if (theme.active === t.id) theme.active = 'ink';
          savePrefs();
          if (onApply) onApply('theme', theme);
          render();
        });
        card.appendChild(del);
      }
      presetGrid.appendChild(card);
    });
    wrap.appendChild(presetGrid);

    // 主题创建工具（AI 生成 / 导入 / 保存为自定义主题）
    const createLabel = document.createElement('div');
    createLabel.className = 'set-desc';
    createLabel.style.marginTop = '14px';
    createLabel.textContent = '新建主题';
    wrap.appendChild(createLabel);
    wrap.appendChild(buildColorSchemesSection());

    // 2) 主题外观参数（绑定当前主题）
    const paramsLabel = document.createElement('div');
    paramsLabel.className = 'set-desc';
    paramsLabel.style.marginTop = '14px';
    paramsLabel.textContent = `「${activeId === 'ink' ? '墨夜' : (allThemes.find((t) => t.id === activeId) || {}).name || activeId}」的外观`;
    wrap.appendChild(paramsLabel);

    if (!theme.params) theme.params = {};
    if (!theme.params[activeId]) theme.params[activeId] = defaultParams();
    const params = theme.params[activeId];
    const setParam = (key, value) => { params[key] = value; update(); };

    // 背景画布
    const canvasRow = document.createElement('div');
    canvasRow.className = 'set-row';
    const canvasLeft = document.createElement('div');
    canvasLeft.innerHTML = '<div class="set-label">背景画布</div><div class="set-desc">叠加在编辑区的纹理</div>';
    const canvasCtrl = document.createElement('div');
    canvasCtrl.className = 'set-control';
    canvasCtrl.appendChild(segmented(
      CANVASES.map((c) => ({ label: c.name, value: c.id })),
      params.canvas,
      (v) => setParam('canvas', v),
      { small: true }
    ));
    canvasRow.appendChild(canvasLeft); canvasRow.appendChild(canvasCtrl);
    wrap.appendChild(canvasRow);

    // 纹理强度
    const strengthRow = document.createElement('div');
    strengthRow.className = 'set-row';
    strengthRow.innerHTML = '<div class="set-label">纹理强度</div>';
    const strengthCtrl = document.createElement('div');
    strengthCtrl.className = 'set-control';
    strengthCtrl.appendChild(slider(params.canvasStrength, {
      min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + '%',
    }, (v) => setParam('canvasStrength', v)));
    strengthRow.appendChild(strengthCtrl);
    wrap.appendChild(strengthRow);

    // 背景图片
    const imgLabel = document.createElement('div');
    imgLabel.className = 'set-desc';
    imgLabel.style.marginTop = '10px';
    imgLabel.textContent = '背景图片';
    wrap.appendChild(imgLabel);

    const imgBox = document.createElement('div');
    imgBox.className = 'ts-img-box';
    const thumb = document.createElement('div');
    thumb.className = 'ts-img-thumb';
    const thumbImg = document.createElement('img');
    thumbImg.alt = '';
    const thumbEmpty = document.createElement('span');
    thumbEmpty.textContent = '无图片';
    thumb.appendChild(thumbImg); thumb.appendChild(thumbEmpty);
    const imgInfo = document.createElement('div');
    imgInfo.className = 'ts-img-info';
    const pickBtn = document.createElement('button');
    pickBtn.className = 'btn ghost';
    pickBtn.textContent = '选择图片';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'mini-btn';
    clearBtn.textContent = '清除';
    const imgMsg = document.createElement('div');
    imgMsg.className = 'cs-save-msg';

    const syncImageThumb = () => {
      if (params.backgroundImage) {
        thumbImg.src = params.backgroundImage;
        thumbImg.style.display = '';
        thumbEmpty.style.display = 'none';
        clearBtn.disabled = false;
      } else {
        thumbImg.removeAttribute('src');
        thumbImg.style.display = 'none';
        thumbEmpty.style.display = '';
        clearBtn.disabled = true;
      }
    };
    pickBtn.addEventListener('click', async () => {
      imgMsg.textContent = '';
      try {
        const files = await ipc.pickAnyFiles();
        const file = files[0];
        if (!file) return;
        imgMsg.className = 'cs-save-msg';
        imgMsg.textContent = '正在处理图片…';
        pickBtn.disabled = true;
        const result = await loadAndCompressImage(file, ipc);
        setParam('backgroundImage', result.dataUrl);
        syncImageThumb(); syncImgControls();
        imgMsg.className = 'cs-save-msg ok';
        imgMsg.textContent = `已设置 · ${result.width}×${result.height} · 约 ${Math.round(result.bytes / 1024)} KB`;
      } catch (e) {
        imgMsg.className = 'cs-save-msg err';
        imgMsg.textContent = '设置失败：' + ((e && e.message) || e);
      } finally {
        pickBtn.disabled = false;
      }
    });
    clearBtn.addEventListener('click', () => {
      setParam('backgroundImage', null);
      syncImageThumb(); syncImgControls();
      imgMsg.className = 'cs-save-msg'; imgMsg.textContent = '';
    });
    imgInfo.appendChild(pickBtn); imgInfo.appendChild(clearBtn);
    imgBox.appendChild(thumb); imgBox.appendChild(imgInfo);
    wrap.appendChild(imgBox); wrap.appendChild(imgMsg);

    const imgControls = document.createElement('div');
    imgControls.className = 'ts-img-controls';
    const syncImgControls = () => { imgControls.style.display = params.backgroundImage ? '' : 'none'; };
    const opRow = document.createElement('div');
    opRow.className = 'set-row';
    opRow.innerHTML = '<div class="set-label">图片透明度</div>';
    const opCtrl = document.createElement('div');
    opCtrl.className = 'set-control';
    opCtrl.appendChild(slider(params.imageOpacity, {
      min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + '%',
    }, (v) => setParam('imageOpacity', v)));
    opRow.appendChild(opCtrl); imgControls.appendChild(opRow);

    const blurRow = document.createElement('div');
    blurRow.className = 'set-row';
    blurRow.innerHTML = '<div class="set-label">图片模糊度</div>';
    const blurCtrl = document.createElement('div');
    blurCtrl.className = 'set-control';
    blurCtrl.appendChild(slider(params.imageBlur, {
      min: 0, max: 20, step: 1, format: (v) => v + 'px',
    }, (v) => setParam('imageBlur', v)));
    blurRow.appendChild(blurCtrl); imgControls.appendChild(blurRow);

    const fitRow = document.createElement('div');
    fitRow.className = 'set-row';
    fitRow.innerHTML = '<div class="set-label">填充方式</div>';
    const fitCtrl = document.createElement('div');
    fitCtrl.className = 'set-control';
    fitCtrl.appendChild(segmented(
      [{ label: '铺满', value: 'cover' }, { label: '适应', value: 'contain' }, { label: '平铺', value: 'repeat' }],
      params.imageSize, (v) => setParam('imageSize', v), { small: true }
    ));
    fitRow.appendChild(fitCtrl); imgControls.appendChild(fitRow);
    wrap.appendChild(imgControls);
    syncImageThumb(); syncImgControls();

    // 3) 排版微调
    const typoLabel = document.createElement('div');
    typoLabel.className = 'set-desc';
    typoLabel.style.marginTop = '10px';
    typoLabel.textContent = '排版';
    wrap.appendChild(typoLabel);
    const t = params.typography;
    const mkTypoRow = (label, control) => {
      const r = document.createElement('div');
      r.className = 'set-row';
      const l = document.createElement('div');
      l.className = 'set-label'; l.textContent = label;
      const c = document.createElement('div');
      c.className = 'set-control'; c.appendChild(control);
      r.appendChild(l); r.appendChild(c); wrap.appendChild(r);
    };
    mkTypoRow('行高', slider(t.lineHeight, { min: 1.3, max: 2.1, step: 0.02, format: (v) => v.toFixed(2) },
      (v) => { t.lineHeight = v; update(); }));
    mkTypoRow('字距', slider(t.letterSpacing, { min: -1, max: 3, step: 0.1, format: (v) => v.toFixed(1) + 'px' },
      (v) => { t.letterSpacing = v; update(); }));
    mkTypoRow('正文宽度', slider(t.maxWidth, { min: 0, max: 1200, step: 20, format: (v) => (v ? v + 'px' : '不限') },
      (v) => { t.maxWidth = v; update(); }));
    mkTypoRow('光标宽度', slider(t.cursorWidth, { min: 1, max: 4, step: 1, format: (v) => v + 'px' },
      (v) => { t.cursorWidth = v; update(); }));

    const activeLineRow = document.createElement('div');
    activeLineRow.className = 'set-row';
    activeLineRow.innerHTML = '<div class="set-label">当前行高亮</div>';
    const activeLineCtrl = document.createElement('div');
    activeLineCtrl.className = 'set-control';
    activeLineCtrl.appendChild(toggle(t.activeLine, (v) => { t.activeLine = v; update(); }));
    activeLineRow.appendChild(activeLineCtrl);
    wrap.appendChild(activeLineRow);

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

    const skipToggle = toggle(false, () => {});

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
    wrap.appendChild(wideRow('不发送 temperature', '部分推理模型会拒绝这个字段', skipToggle));
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
        skipToggle.classList.toggle('on', !!aiCfg.skip_temperature);
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
          skipTemperature: skipToggle.classList.contains('on'),
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
          skipTemperature: skipToggle.classList.contains('on'),
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
    const g1 = group('外观', 'appearance');
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

    /* ---------------------------------------------------------- Theme Studio */
    const gStudio = group('主题', 'appearance');
    gStudio.appendChild(buildThemeStudioSection());
    body.appendChild(gStudio);

    /* ---------------------------------------------------------- 字体 */
    const g2 = group('字体', 'editor');
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
    const g3 = group('编辑', 'editor');
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
    const gAi = group('AI 模型与接口', 'ai');
    gAi.appendChild(buildAiSection());
    body.appendChild(gAi);

    /* ---------------------------------------------------------- 关于 */
    const g4 = group('关于', 'about');
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

    buildNav();
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
