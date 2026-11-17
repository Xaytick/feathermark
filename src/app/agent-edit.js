// Agent 编辑模板流程。
//
// 这是原「AI 编辑」弹窗的收敛版：动作来自共享编辑模板，参数按模板动态渲染，
// 执行仍走补丁式 agent + 逐块 diff，交互习惯保持不变（先看差异、逐块接受、⌘Z 可撤销）。
import * as ipc from './ipc.js';
import { toast } from './ui.js';
import { runAgent } from './agent.js';
import { EDIT_TEMPLATES, templateById, defaultParams, buildEditTask } from './edit-templates.js';
import { buildDiffView } from './diff-view.js';

export function createAgentEdit({ editor, onNeedConfig }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('ai-dialog');
  const chipsEl = $('ai-chips');
  const paramsEl = $('ai-params');
  const sourceEl = $('ai-source');
  const scopeEl = $('ai-scope');
  const hintEl = $('ai-hint');
  const diffEl = $('ai-diff');
  const metaEl = $('ai-meta');
  const btnGen = $('ai-generate');
  const btnRegen = $('ai-regen');
  const btnApply = $('ai-apply');
  const btnApplyAll = $('ai-apply-all');
  const btnCancel = $('ai-cancel');

  let template = templateById('polish');
  let params = defaultParams(template);
  let scope = null;
  let result = null;
  let view = null;
  let busy = false;

  function renderChips() {
    chipsEl.innerHTML = '';
    for (const t of EDIT_TEMPLATES) {
      const b = document.createElement('button');
      b.className = 'chip' + (t.id === template.id ? ' active' : '');
      b.dataset.act = t.id;
      b.textContent = t.label;
      b.title = t.hint || '';
      b.addEventListener('click', () => {
        template = t;
        params = defaultParams(t);
        renderChips();
        renderParams();
        const first = paramsEl.querySelector('input,select,textarea');
        if (first) setTimeout(() => first.focus(), 0);
      });
      chipsEl.appendChild(b);
    }
  }

  function makeControl(p) {
    let control;
    if (p.type === 'select') {
      control = document.createElement('select');
      for (const opt of p.options || []) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        control.appendChild(o);
      }
      control.value = params[p.key] || p.default || (p.options || [])[0] || '';
    } else if (p.type === 'textarea') {
      control = document.createElement('textarea');
      control.rows = 2;
      control.value = params[p.key] || '';
      control.placeholder = p.placeholder || '';
    } else {
      control = document.createElement('input');
      control.type = 'text';
      control.value = params[p.key] || '';
      control.placeholder = p.placeholder || '';
      control.spellcheck = false;
    }
    control.addEventListener('input', () => (params[p.key] = control.value));
    control.addEventListener('change', () => (params[p.key] = control.value));
    control.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && p.type !== 'textarea') {
        e.preventDefault();
        generate();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        generate();
      }
    });
    return control;
  }

  function renderParams() {
    paramsEl.innerHTML = '';
    if (!template.params || !template.params.length) {
      const note = document.createElement('div');
      note.className = 'ai-param-note';
      note.textContent = `「${template.label}」没有额外参数：${template.hint}`;
      paramsEl.appendChild(note);
      return;
    }
    for (const p of template.params) {
      const row = document.createElement('div');
      row.className = 'ai-param';
      const label = document.createElement('label');
      label.textContent = p.label + (p.required ? ' *' : '');
      if (p.hint) label.title = p.hint;
      row.appendChild(label);
      row.appendChild(makeControl(p));
      paramsEl.appendChild(row);
    }
  }

  function captureScope() {
    const cm = editor.cm;
    const docText = cm.getValue();
    const docLines = docText.split('\n');
    const hasSel = cm.somethingSelected();

    let fromLine = 1;
    let toLine = docLines.length;
    if (hasSel) {
      const a = cm.getCursor('from');
      const b = cm.getCursor('to');
      fromLine = Math.min(a.line, b.line) + 1;
      toLine = Math.max(a.line, b.line) + 1;
    }

    const baseLines = docLines.slice(fromLine - 1, toLine);
    scope = {
      mode: hasSel ? 'selection' : 'doc',
      isSelection: hasSel,
      fromLine,
      toLine,
      docLines,
      text: baseLines.join('\n'),
      snapshot: docText,
      from: { line: fromLine - 1, ch: 0 },
      to: { line: toLine - 1, ch: (docLines[toLine - 1] || '').length },
    };
    scopeEl.textContent = hasSel
      ? `选中 ${toLine - fromLine + 1} 行 · 只替换这几行`
      : `整篇 ${docLines.length} 行 · 会替换全文`;
    return scope;
  }

  function setBusy(on) {
    busy = on;
    btnGen.disabled = on;
    btnRegen.disabled = on;
    btnApply.disabled = on;
    btnApplyAll.disabled = on;
  }

  function showHint(text) {
    diffEl.classList.add('hidden');
    hintEl.classList.remove('hidden');
    hintEl.textContent = text;
  }

  function resetResult() {
    result = null;
    view = null;
    metaEl.textContent = '';
    metaEl.classList.remove('error');
    btnApply.classList.add('hidden');
    btnApplyAll.classList.add('hidden');
    btnGen.classList.remove('hidden');
    showHint('选择模板并配置参数后点「生成」。先看逐块差异，再决定应用哪些改动。');
  }

  const took = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

  function refreshApplyState() {
    if (!view || !result) return;
    const total = view.changeCount;
    const accepted = view.acceptedCount();
    const partial = total > 0 && accepted < total;
    btnApply.textContent = partial ? `只应用已选 ${accepted} 处` : '应用替换';
    btnApply.disabled = accepted === 0;
    btnApplyAll.classList.toggle('hidden', !partial);
    metaEl.classList.remove('error');
    const parts = [result.model || '模型'];
    parts.push(`补丁 ${result.edits || total} 处`);
    if (result.promptTokens || result.completionTokens) {
      parts.push(`入 ${result.promptTokens} / 出 ${result.completionTokens} tokens`);
    }
    parts.push(took(result.latency));
    if (result.rounds > 1) parts.push(`修正 ${result.rounds - 1} 次`);
    parts.push(`${total} 处改动`);
    metaEl.textContent = parts.join(' · ');
  }

  function validateParams() {
    for (const p of template.params || []) {
      if (p.required && !String(params[p.key] || '').trim()) {
        metaEl.textContent = `「${template.label}」需要填写：${p.label}`;
        metaEl.classList.add('error');
        const first = paramsEl.querySelector('textarea,input,select');
        if (first) first.focus();
        return false;
      }
    }
    return true;
  }

  async function generate() {
    if (busy) return;
    captureScope();
    if (!scope.text.trim()) {
      toast('没有可处理的内容', { error: true });
      return;
    }
    if (!validateParams()) return;

    setBusy(true);
    btnApply.classList.add('hidden');
    btnApplyAll.classList.add('hidden');
    hintEl.classList.add('hidden');
    diffEl.classList.remove('hidden');
    diffEl.className = 'ai-diff loading';
    diffEl.textContent = '正在生成编辑指令…';
    metaEl.classList.remove('error');
    metaEl.textContent = '';

    try {
      const res = await runAgent({
        task: buildEditTask(template, params),
        actionId: template.id,
        docLines: scope.docLines,
        fromLine: scope.fromLine,
        toLine: scope.toLine,
        isSelection: scope.isSelection,
        onStage: (msg) => {
          if (diffEl.className.includes('loading')) diffEl.textContent = msg;
        },
      });

      result = {
        text: res.text,
        model: res.stats.model,
        latency: res.stats.latency,
        promptTokens: res.stats.promptTokens,
        completionTokens: res.stats.completionTokens,
        mode: res.mode,
        rounds: res.rounds,
        edits: res.edits,
        warnings: res.warnings || [],
      };
      view = buildDiffView(scope.text, res.text);
      view.onSelectionChange(refreshApplyState);

      diffEl.className = 'ai-diff';
      diffEl.innerHTML = '';
      diffEl.appendChild(view.node);

      if (result.warnings.length) toast(result.warnings[0], { duration: 3200 });
      btnApply.classList.remove('hidden');
      btnGen.classList.add('hidden');
      refreshApplyState();
    } catch (e) {
      const msg = ipc.describeError(e);
      diffEl.className = 'ai-diff';
      diffEl.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'ai-plain';
      err.style.color = '#e5484d';
      err.textContent = msg;
      diffEl.appendChild(err);
      metaEl.textContent = '请求失败';
      metaEl.classList.add('error');
      if (/配置|API Key|Base URL/i.test(msg) && onNeedConfig) {
        const go = document.createElement('button');
        go.className = 'btn ghost';
        go.style.margin = '0 14px 14px';
        go.textContent = '打开设置配置 AI';
        go.addEventListener('click', () => {
          close();
          onNeedConfig();
        });
        diffEl.appendChild(go);
      }
    } finally {
      setBusy(false);
    }
  }

  function applyChanges(mode) {
    if (!view || !scope) return;
    const cm = editor.cm;
    if (cm.getValue() !== scope.snapshot) {
      metaEl.textContent = '文档在生成期间被改动，为避免覆盖你的编辑，请重新生成';
      metaEl.classList.add('error');
      return;
    }
    const total = view.changeCount;
    const accepted = mode === 'all' ? total : view.acceptedCount();
    if (total === 0) {
      toast('模型没有给出改动', { error: true });
      return;
    }
    if (accepted === 0) {
      toast('没有勾选任何改动，先勾选要接受的部分', { error: true });
      return;
    }
    const next = view.compose(mode);
    cm.operation(() => cm.replaceRange(next, scope.from, scope.to));
    cm.focus();
    close();
    toast(accepted === total ? '已应用全部修改，⌘Z 可撤销' : `已应用 ${accepted}/${total} 处修改，⌘Z 可撤销`);
  }

  function open(templateId = null, { source = 'agent', initialInstruction = '' } = {}) {
    const s = captureScope();
    if (!s.text.trim()) {
      toast('文档还是空的，先写点东西', { error: true });
      return;
    }
    template = templateById(templateId || 'polish');
    params = defaultParams(template);
    if (initialInstruction && template.params.some((p) => p.key === 'instruction')) {
      params.instruction = initialInstruction;
    }
    sourceEl.textContent =
      source === 'agent' ? '由 Agent 面板发起 · 使用编辑模板' : '快捷入口 · 使用编辑模板';
    renderChips();
    renderParams();
    resetResult();
    dialog.classList.remove('hidden');
    setTimeout(() => {
      const first = paramsEl.querySelector('textarea,input,select') || btnGen;
      first.focus();
    }, 30);
  }

  function close() {
    dialog.classList.add('hidden');
    result = null;
    view = null;
  }

  btnGen.addEventListener('click', generate);
  btnRegen.addEventListener('click', generate);
  btnApply.addEventListener('click', () => applyChanges('accepted'));
  btnApplyAll.addEventListener('click', () => applyChanges('all'));
  btnCancel.addEventListener('click', close);
  $('ai-close').addEventListener('click', close);
  dialog.addEventListener('pointerdown', (e) => {
    if (e.target === dialog) close();
  });
  document.addEventListener('keydown', (e) => {
    if (dialog.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!btnApply.classList.contains('hidden')) applyChanges('accepted');
      else generate();
    }
  });

  return { open, close, isOpen: () => !dialog.classList.contains('hidden'), generate };
}
