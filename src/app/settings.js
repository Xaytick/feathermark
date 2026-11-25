// 设置面板：从「声明式 schema」生成 DOM，改一项立即生效并落盘。
import { prefs, savePrefs, resetPrefs } from './store.js';
import * as ipc from './ipc.js';
import { getModels, addModel, removeModel, syncModelsFromConfig, onModelsChange } from './model-list.js';
import { parseColors, listSchemes, saveScheme, deleteScheme, getScheme, renameScheme, exportScheme } from './color-schemes.js';
import { PRESETS, CANVASES, getPreset, tokensFromColors, resolveParams, defaultParams, luminance } from './theme-presets.js';
import { loadAndCompressImage } from './image-tools.js';
import { locale, setLocale, t as tr } from './i18n.js';

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
    { id: 'appearance', label: tr('set.appearance'), hint: tr('set.theme') },
    { id: 'editor', label: tr('set.editor'), hint: tr('set.editorHint') },
    { id: 'ai', label: tr('set.ai'), hint: tr('set.ai') },
    { id: 'about', label: tr('set.about'), hint: tr('set.aboutHint') },
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
    def.textContent = tr('set.followUiFont');
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
      o.textContent = current || tr('set.loadingFonts');
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
    aiTitle.textContent = tr('set.aiColors');
    const aiHint = document.createElement('div');
    aiHint.className = 'cs-hint';
    aiHint.textContent = tr('set.aiColorsHint');
    const aiInput = document.createElement('input');
    aiInput.type = 'text';
    aiInput.className = 'cs-ai-input';
    aiInput.id = 'cs-ai-input';
    aiInput.placeholder = tr('set.aiColorsPlaceholder');
    aiInput.maxLength = 120;
    const aiBtn = document.createElement('button');
    aiBtn.className = 'btn';
    aiBtn.textContent = tr('set.aiColorsGen');
    aiBtn.id = 'cs-ai-btn';
    const aiMsg = document.createElement('div');
    aiMsg.className = 'cs-save-msg';
    aiMsg.id = 'cs-ai-msg';

    aiBtn.addEventListener('click', async () => {
      const prompt = aiInput.value.trim();
      aiMsg.textContent = '';
      if (!prompt) {
        aiMsg.className = 'cs-save-msg err';
        aiMsg.textContent = tr('set.aiColorsNeedDesc');
        aiInput.focus();
        return;
      }
      aiBtn.disabled = true;
      aiMsg.className = 'cs-save-msg';
      aiMsg.textContent = tr('generating');
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
        if (!res) throw lastErr || new Error(tr('set.aiNoContent'));
        const content = String((res && res.content) || '').trim();
        if (!content) throw new Error(tr('set.aiNoContent'));
        const hexes = content.match(/#[\da-fA-F]{6}\b|#[\da-fA-F]{3}\b/g);
        const result = parseColors(hexes ? hexes.join('\n') : content);
        if (!result.colors.length) throw new Error(tr('set.aiBadColors'));
        input.value = result.colors.map((c) => c.hex).join('\n');
        renderPreview(result);
        // 把用户的风格描述自动填入配色名（nameInput 上限 40 字符，JS 赋值不受 maxLength 约束，需手动截断）
        nameInput.value = prompt.slice(0, nameInput.maxLength || 40);
        aiMsg.className = 'cs-save-msg ok';
        aiMsg.textContent = tr('set.aiColorsDone', { n: result.colors.length });
        input.scrollIntoView({ block: 'nearest' });
      } catch (e) {
        aiMsg.className = 'cs-save-msg err';
        aiMsg.textContent = tr('set.aiColorsFail') + ((e && e.message) ? e.message : String(e));
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
    hint.textContent = tr('set.colorFormats');
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
    parseBtn.textContent = tr('set.parsePreview');
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
        empty.textContent = tr('set.colorEmpty');
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
    nameInput.placeholder = tr('set.themeName');
    nameInput.maxLength = 40;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.textContent = tr('set.saveAsTheme');
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
      saveMsg.textContent = tr('set.themeSaved', { n: res.scheme.name });
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
    presetLabel.textContent = tr('set.themePresets');
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
          id: sc.id, name: sc.name, desc: tr('set.customTheme'), tokens, custom: true,
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
      // 自定义主题带操作角标：重命名 / 导出 / 删除
      if (t.custom) {
        const tools = document.createElement('div');
        tools.className = 'ts-preset-tools';

        const ren = document.createElement('button');
        ren.className = 'ts-preset-tool ts-preset-rename';
        ren.textContent = '✎';
        ren.title = tr('set.renameTheme');
        ren.addEventListener('click', (e) => {
          e.stopPropagation();
          const next = window.prompt(tr('set.renameTheme') + '：', t.name);
          if (next === null) return; // 取消
          const res = renameScheme(t.id, next);
          if (!res.ok) { window.alert(res.error); return; }
          render();
        });
        tools.appendChild(ren);

        const exp = document.createElement('button');
        exp.className = 'ts-preset-tool ts-preset-export';
        exp.textContent = '⇩';
        exp.title = tr('set.exportTheme');
        exp.addEventListener('click', (e) => {
          e.stopPropagation();
          const data = exportScheme(t.id);
          if (!data) { window.alert(tr('set.delTheme')); return; }
          try {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `feathermark-theme-${data.name.replace(/[\\/:*?"<>|\s]+/g, '-')}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (err) {
            window.alert(String(err));
          }
        });
        tools.appendChild(exp);

        const del = document.createElement('button');
        del.className = 'ts-preset-tool ts-preset-del';
        del.textContent = '×';
        del.title = tr('set.delTheme');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteScheme(t.id);
          if (theme.params) delete theme.params[t.id];
          if (theme.active === t.id) theme.active = 'ink';
          savePrefs();
          if (onApply) onApply('theme', theme);
          render();
        });
        tools.appendChild(del);
        card.appendChild(tools);
      }
      presetGrid.appendChild(card);
    });
    wrap.appendChild(presetGrid);

    // 主题创建工具（AI 生成 / 导入 / 保存为自定义主题）
    const createLabel = document.createElement('div');
    createLabel.className = 'set-desc';
    createLabel.style.marginTop = '14px';
    createLabel.textContent = tr('set.newTheme');
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
    canvasLeft.innerHTML = tr('set.canvasHtml');
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
    strengthRow.innerHTML = '<div class="set-label">' + tr('set.strength') + '</div>';
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
    imgLabel.textContent = tr('set.bgImage');
    wrap.appendChild(imgLabel);

    const imgBox = document.createElement('div');
    imgBox.className = 'ts-img-box';
    const thumb = document.createElement('div');
    thumb.className = 'ts-img-thumb';
    const thumbImg = document.createElement('img');
    thumbImg.alt = '';
    const thumbEmpty = document.createElement('span');
    thumbEmpty.textContent = tr('set.noImage');
    thumb.appendChild(thumbImg); thumb.appendChild(thumbEmpty);
    const imgInfo = document.createElement('div');
    imgInfo.className = 'ts-img-info';
    const pickBtn = document.createElement('button');
    pickBtn.className = 'btn ghost';
    pickBtn.textContent = tr('set.pickImage');
    const clearBtn = document.createElement('button');
    clearBtn.className = 'mini-btn';
    clearBtn.textContent = tr('clear');
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
        imgMsg.textContent = tr('set.processingImage');
        pickBtn.disabled = true;
        const result = await loadAndCompressImage(file, ipc);
        setParam('backgroundImage', result.dataUrl);
        syncImageThumb(); syncImgControls();
        imgMsg.className = 'cs-save-msg ok';
        imgMsg.textContent = tr('set.imageSet', { w: result.width, h: result.height, k: Math.round(result.bytes / 1024) });
      } catch (e) {
        imgMsg.className = 'cs-save-msg err';
        imgMsg.textContent = tr('set.imageFail') + ((e && e.message) || e);
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
    opRow.innerHTML = '<div class="set-label">' + tr('set.opacity') + '</div>';
    const opCtrl = document.createElement('div');
    opCtrl.className = 'set-control';
    opCtrl.appendChild(slider(params.imageOpacity, {
      min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + '%',
    }, (v) => setParam('imageOpacity', v)));
    opRow.appendChild(opCtrl); imgControls.appendChild(opRow);

    const blurRow = document.createElement('div');
    blurRow.className = 'set-row';
    blurRow.innerHTML = '<div class="set-label">' + tr('set.blur') + '</div>';
    const blurCtrl = document.createElement('div');
    blurCtrl.className = 'set-control';
    blurCtrl.appendChild(slider(params.imageBlur, {
      min: 0, max: 20, step: 1, format: (v) => v + 'px',
    }, (v) => setParam('imageBlur', v)));
    blurRow.appendChild(blurCtrl); imgControls.appendChild(blurRow);

    const fitRow = document.createElement('div');
    fitRow.className = 'set-row';
    fitRow.innerHTML = '<div class="set-label">' + tr('set.fit') + '</div>';
    const fitCtrl = document.createElement('div');
    fitCtrl.className = 'set-control';
    fitCtrl.appendChild(segmented(
      [{ label: tr('set.fitCover'), value: 'cover' }, { label: tr('set.fitContain'), value: 'contain' }, { label: tr('set.fitRepeat'), value: 'repeat' }],
      params.imageSize, (v) => setParam('imageSize', v), { small: true }
    ));
    fitRow.appendChild(fitCtrl); imgControls.appendChild(fitRow);
    wrap.appendChild(imgControls);
    syncImageThumb(); syncImgControls();

    // 3) 排版微调
    const typoLabel = document.createElement('div');
    typoLabel.className = 'set-desc';
    typoLabel.style.marginTop = '10px';
    typoLabel.textContent = tr('set.typography');
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
    mkTypoRow(tr('set.lineHeight'), slider(t.lineHeight, { min: 1.3, max: 2.1, step: 0.02, format: (v) => v.toFixed(2) },
      (v) => { t.lineHeight = v; update(); }));
    mkTypoRow(tr('set.letterSpacing'), slider(t.letterSpacing, { min: -1, max: 3, step: 0.1, format: (v) => v.toFixed(1) + 'px' },
      (v) => { t.letterSpacing = v; update(); }));
    mkTypoRow(tr('set.bodyWidth'), slider(t.maxWidth, { min: 0, max: 1200, step: 20, format: (v) => (v ? v + 'px' : tr('set.unlimited')) },
      (v) => { t.maxWidth = v; update(); }));
    mkTypoRow(tr('set.cursorWidth'), slider(t.cursorWidth, { min: 1, max: 4, step: 1, format: (v) => v + 'px' },
      (v) => { t.cursorWidth = v; update(); }));

    const activeLineRow = document.createElement('div');
    activeLineRow.className = 'set-row';
    activeLineRow.innerHTML = '<div class="set-label">' + tr('set.activeLine') + '</div>';
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
    baseInput.placeholder = tr('set.baseUrlPlaceholder');
    baseInput.spellcheck = false;

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.id = 'ai-add-model-input';
    modelInput.placeholder = tr('set.modelPlaceholder');
    modelInput.spellcheck = false;
    modelInput.setAttribute('list', 'ai-model-list');
    const modelList = document.createElement('datalist');
    modelList.id = 'ai-model-list';

    const fetchBtn = document.createElement('button');
    fetchBtn.className = 'mini-btn';
    fetchBtn.textContent = tr('set.fetchModels');
    fetchBtn.title = tr('set.fetchModelsHint');

    const extraInput = document.createElement('input');
    extraInput.type = 'text';
    extraInput.placeholder = '{}';
    extraInput.spellcheck = false;
    extraInput.title = tr('set.extraBodyHint');

    const skipToggle = toggle(false, () => {});

    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = tr('set.keyPlaceholder');
    keyInput.spellcheck = false;

    // 联网搜索（Tavily）API Key：空白表示保持原 key 不变
    const searchKeyInput = document.createElement('input');
    searchKeyInput.type = 'password';
    searchKeyInput.placeholder = tr('set.searchKeyPlaceholder');
    searchKeyInput.spellcheck = false;
    searchKeyInput.title = tr('set.searchKeyHint');

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.textContent = tr('set.saveAndTest');

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

    wrap.appendChild(wideRow(tr('set.baseUrl'), tr('set.baseUrlDesc'), baseInput));

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
    addBtn.textContent = tr('add');
    addBtn.title = tr('set.addModelHint');
    addRow.appendChild(modelInput);
    addRow.appendChild(addBtn);
    addRow.appendChild(fetchBtn);

    wrap.appendChild(wideRow(tr('set.model'), tr('set.modelDesc'), chips));
    wrap.appendChild(wideRow(tr('set.addModelRow'), tr('set.addModelRowDesc'), addRow));
    wrap.appendChild(wideRow('API Key', tr('set.keyDesc'), keyInput));
    wrap.appendChild(wideRow(tr('set.searchKey'), tr('set.searchKeyDesc'), searchKeyInput));
    wrap.appendChild(
      wideRow(tr('set.extraBody'), tr('set.extraBodyDesc'), extraInput)
    );
    wrap.appendChild(wideRow(tr('set.skipTemp'), tr('set.skipTempDesc'), skipToggle));
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
        empty.textContent = tr('set.noModels');
        chips.appendChild(empty);
      }
      list.forEach((name) => {
        const chip = document.createElement('div');
        chip.className = 'ai-model-chip' + (name === current ? ' on' : '');
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'ai-model-chip-name';
        label.textContent = name;
        label.title = tr('set.setCurrentModel');
        label.addEventListener('click', () => {
          modelInput.value = name;
          result.textContent = '';
          renderModelChips();
        });
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'ai-model-chip-x';
        x.textContent = '×';
        x.title = tr('set.removeFromList');
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
        result.textContent = tr('set.addFirst');
        return;
      }
      const isNew = addModel(name);
      renderModelChips();
      result.style.color = 'var(--accent)';
      result.textContent = isNew ? tr('set.modelAdded', { n: name }) : tr('set.modelExists');
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
        keyInput.placeholder = aiCfg.has_key ? tr('set.keySaved', { k: aiCfg.key_hint }) : tr('set.keyPlaceholder2');
        searchKeyInput.value = '';
        searchKeyInput.placeholder = aiCfg.has_search_key
          ? tr('set.keySaved', { k: aiCfg.search_key_hint }) : tr('set.searchKeyPlaceholder');
        extraInput.value = aiCfg.extra_body || '{}';
        skipToggle.classList.toggle('on', !!aiCfg.skip_temperature);
        syncModelsFromConfig(aiCfg.model);
        renderModelChips();
        status.textContent = '';
      } catch (e) {
        status.textContent = tr('set.readConfigFail') + ipc.describeError(e);
      }
    }

    fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = true;
      result.style.color = 'var(--text-faint)';
      result.textContent = tr('set.fetchingModels');
      try {
        // 先落盘当前地址与 Key，Rust 侧才有配置可读
        await ipc.aiConfigSet({
          provider: 'custom',
          baseUrl: baseInput.value,
          model: modelInput.value,
          apiKey: keyInput.value || null,
          searchApiKey: searchKeyInput.value || null,
          searchApiUrl: 'https://api.tavily.com/search',
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
        result.textContent = tr('set.fetchedModels', { n: list.length });
        if (!modelInput.value) modelInput.value = list[0];
      } catch (e) {
        result.style.color = '#e5484d';
        result.textContent = tr('set.fetchFail') + ipc.describeError(e);
      } finally {
        fetchBtn.disabled = false;
      }
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      result.style.color = 'var(--text-faint)';
      result.textContent = tr('set.testingConnection');
      try {
        await ipc.aiConfigSet({
          provider: 'custom',
          baseUrl: baseInput.value,
          model: modelInput.value,
          apiKey: keyInput.value || null,
          searchApiKey: searchKeyInput.value || null,
          searchApiUrl: 'https://api.tavily.com/search',
          temperature: 0.3,
          maxTokens: 4096,
          extraBody: extraInput.value || '{}',
          skipTemperature: skipToggle.classList.contains('on'),
        });
        addModel(modelInput.value.trim());
        const r = await ipc.aiTest();
        result.style.color = 'var(--accent)';
        result.textContent = tr('set.connectionOk', { m: r.model, ms: r.latency_ms });
        keyInput.value = '';
        searchKeyInput.value = '';
        load();
      } catch (e) {
        result.style.color = '#e5484d';
        result.textContent = tr('set.testFail') + ipc.describeError(e);
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
    const g1 = group(tr('set.appearance'), 'appearance');
    g1.appendChild(
      row(
        tr('set.splitDefault'),
        tr('set.splitDefaultDesc'),
        segmented(
          [
            { label: tr('set.horizontal'), value: 'h' },
            { label: tr('set.vertical'), value: 'v' },
          ],
          prefs.splitDir,
          (v) => apply('splitDir', v)
        )
      )
    );
    body.appendChild(g1);

    /* ---------------------------------------------------------- Theme Studio */
    const gStudio = group(tr('set.themeGroup'), 'appearance');
    gStudio.appendChild(buildThemeStudioSection());
    body.appendChild(gStudio);

    /* ---------------------------------------------------------- 字体 */
    const g2 = group(tr('set.fonts'), 'editor');
    g2.appendChild(row(tr('set.editorFont'), '', fontSelect(prefs.editorFont, (v) => apply('editorFont', v))));
    g2.appendChild(
      row(tr('set.editorSize'), '', numberInput(prefs.editorSize, { min: 11, max: 28 }, (v) => apply('editorSize', v)))
    );
    g2.appendChild(row(tr('set.previewFont'), '', fontSelect(prefs.previewFont, (v) => apply('previewFont', v))));
    g2.appendChild(
      row(tr('set.previewSize'), '', numberInput(prefs.previewSize, { min: 11, max: 28 }, (v) => apply('previewSize', v)))
    );
    g2.appendChild(row(tr('set.codeFont'), '', fontSelect(prefs.codeFont, (v) => apply('codeFont', v))));
    g2.appendChild(
      row(tr('set.codeSize'), '', numberInput(prefs.codeSize, { min: 10, max: 22 }, (v) => apply('codeSize', v)))
    );
    body.appendChild(g2);

    /* ---------------------------------------------------------- 编辑 */
    const g3 = group(tr('set.editor'), 'editor');
    // 界面语言：切换后原生菜单栏与 UI 文案同时更新
    g3.appendChild(
      row(
        tr('set.language'),
        tr('set.languageDesc'),
        segmented(
          [{ label: tr('set.zh'), value: 'zh' }, { label: 'English', value: 'en' }],
          locale(),
          (v) => { setLocale(v).then(() => render()).catch(() => {}); }
        )
      )
    );
    g3.appendChild(
      row(
        tr('set.lineWrap'),
        tr('set.lineWrapDesc'),
        toggle(prefs.lineWrap, (v) => {
          apply('lineWrap', v);
          document.getElementById('sb-wrap').classList.toggle('on', v);
        })
      )
    );
    g3.appendChild(row(tr('set.lineNumbers'), '', toggle(prefs.lineNumbers, (v) => apply('lineNumbers', v))));
    g3.appendChild(row(
      tr('set.autoSave'),
      tr('set.autoSaveDesc'),
      toggle(prefs.autoSave, (v) => apply('autoSave', v))
    ));
    g3.appendChild(row(
      tr('hist.settingLabel'),
      tr('hist.settingDesc'),
      toggle(prefs.historyEnabled, (v) => apply('historyEnabled', v))
    ));
    g3.appendChild(
      row(tr('set.autoPairs'), tr('set.autoPairsDesc'), toggle(prefs.autoPairs, (v) => apply('autoPairs', v)))
    );
    g3.appendChild(
      row(
        tr('set.softBreaks'),
        tr('set.softBreaksDesc'),
        toggle(prefs.softBreaks, (v) => apply('softBreaks', v))
      )
    );
    g3.appendChild(row(tr('set.spellcheck'), tr('set.spellcheckDesc'), toggle(prefs.spellcheck, (v) => apply('spellcheck', v))));
    body.appendChild(g3);

    /* ---------------------------------------------------------- AI */
    const gAi = group(tr('set.aiGroup'), 'ai');
    gAi.appendChild(buildAiSection());
    body.appendChild(gAi);

    /* ---------------------------------------------------------- 关于 */
    const g4 = group(tr('set.aboutGroup'), 'about');
    const about = document.createElement('div');
    about.className = 'about-block';
    about.innerHTML = tr('set.aboutHtml');
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
