// AI 编辑面板：负责交互与展示，真正的「怎么让模型少说话」在 agent.js 里。
//
// 设计原则：
// - 永不自动改写：必须先点「生成」，再逐块或整篇应用；应用走 CodeMirror 的替换操作，⌘Z 可撤销。
// - 先看再改：结果按「改动块（hunk）」呈现，每块可单独勾选；改动行内标出字符级差异。
// - 补丁式生成：模型只输出要改的行（见 agent.js），输出 token 通常只有整篇改写的十分之一。
// - 只发必要内容：选区模式只发选区与两行上下文；整篇会提示行数。
// - 密钥不出现在这里：所有请求都经 Rust 侧转发，前端拿不到 API Key。
import * as ipc from './ipc.js';
import { toast } from './ui.js';
import { runAgent } from './agent.js';

const ACTIONS = [
  {
    id: 'polish',
    label: '润色',
    hint: '更通顺，不改意思',
    prompt:
      '在不改变事实、结构与信息量的前提下润色文字：去掉啰嗦和生硬的表达，让句子更通顺自然。不要新增内容，不要删掉要点。',
  },
  {
    id: 'concise',
    label: '精简',
    hint: '删冗余，留要点',
    prompt:
      '压缩冗余：删除重复表述、口水话、没有信息量的过渡句，保留全部关键信息、结论和例子。宁可短，也不要漏。',
  },
  {
    id: 'expand',
    label: '扩写',
    hint: '补细节，不编造',
    prompt:
      '在原有骨架上补充细节、必要的过渡和具体例子，让表达更完整。严禁编造事实、数据、引用或链接。',
  },
  {
    id: 'layout',
    label: '排版整理',
    hint: '只动格式，一个字不改',
    prompt:
      '只调整 Markdown 排版，一个字都不要改：规范标题层级（不跳级）、统一列表符号与缩进、调整段落空行、表格对齐、给代码块补语言标注、修正引用块与分割线格式。原文的错别字也不要改。',
  },
  {
    id: 'proof',
    label: '纠错',
    hint: '错别字与标点',
    prompt:
      '只修正错别字、标点误用和明显的语病，保持原文的行文风格与用词习惯，不要重写句子，不要润色。',
  },
  {
    id: 'translate',
    label: '翻译',
    hint: '中英互译，保留结构',
    prompt:
      '自动判断翻译方向：原文以中文为主就译成英文，原文以英文为主就译成中文；中英混排时以正文主要语言为准，界面里出现的专有名词保留原文。译文要自然、符合技术写作习惯。保留全部 Markdown 结构、链接、图片、代码块、行内代码、术语与专有名词原样不变，不要翻译代码和 URL。',
  },
  { id: 'custom', label: '自定义', hint: '只用下面那句要求', prompt: '' },
];

/* ------------------------------------------------------------------ diff */
/** 行级 LCS。规模过大时返回 null，调用方退化成纯文本对照。 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: 'add', text }));
  if (m === 0) return a.map((text) => ({ type: 'del', text }));
  if (n * m > 600000) return null;

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] });
  while (j < m) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

/** 把连续的增删行聚成一个「改动块」——块是逐块接受的最小单位。 */
function buildHunks(rows) {
  const hunks = [];
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'same') {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { start: i, end: i, accepted: true };
      hunks.push(cur);
    } else {
      cur.end = i;
    }
  }
  return hunks;
}

/** 成对改写的行：截掉公共前后缀，只高亮真正变化的中段。 */
function splitCommon(oldText, newText) {
  const a = Array.from(oldText);
  const b = Array.from(newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return {
    oldPre: a.slice(0, p).join(''),
    oldMid: a.slice(p, a.length - s).join(''),
    oldPost: a.slice(a.length - s).join(''),
    newPre: b.slice(0, p).join(''),
    newMid: b.slice(p, b.length - s).join(''),
    newPost: b.slice(b.length - s).join(''),
  };
}

function lineNode(text, kind, segments) {
  const row = document.createElement('div');
  row.className = 'dl ' + (kind === 'del' ? 'del' : kind === 'add' ? 'add' : '');
  const sign = document.createElement('span');
  sign.className = 'dl-sign';
  sign.textContent = kind === 'del' ? '−' : kind === 'add' ? '+' : ' ';
  const body = document.createElement('span');
  body.className = 'dl-text';
  if (segments) {
    body.appendChild(document.createTextNode(segments.pre));
    if (segments.mid) {
      const mark = document.createElement('mark');
      mark.className = kind === 'del' ? 'del-hl' : 'add-hl';
      mark.textContent = segments.mid;
      body.appendChild(mark);
    }
    body.appendChild(document.createTextNode(segments.post));
  } else {
    body.textContent = text || ' ';
  }
  row.appendChild(sign);
  row.appendChild(body);
  return row;
}

/**
 * 构建可交互的差异视图。
 * compose() 按「各块是否勾选」重组最终文本：接受某块就取新增行、丢弃删除行；
 * 跳过某块则保留原行——所以「只应用其中几处」在文本层面是逐块拼接出来的。
 */
export function buildDiffView(oldText, newText) {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  const rows = diffLines(a, b);

  const plainFallback = (message, text) => {
    const node = document.createElement('div');
    if (message) {
      const bar = document.createElement('div');
      bar.className = 'ai-diff-bar';
      bar.textContent = message;
      node.appendChild(bar);
    }
    const plain = document.createElement('div');
    plain.className = 'ai-plain';
    plain.textContent = text;
    node.appendChild(plain);
    return {
      node,
      changeCount: 0,
      acceptedCount: () => 0,
      allAccepted: () => true,
      setAll: () => {},
      compose: () => text,
    };
  };

  // 改动规模过大（O(n·m) 表会太占内存）时退化为纯文本对照
  if (!rows) return plainFallback('改动太多，已切换为纯文本对照（无法逐块选择）', newText);

  const hunks = buildHunks(rows);
  if (!hunks.length) return plainFallback(null, '模型认为不需要修改。');

  const hunkAt = new Map(hunks.map((h, i) => [h.start, { hunk: h, index: i }]));
  const node = document.createElement('div');

  const bar = document.createElement('div');
  bar.className = 'ai-diff-bar';
  const barText = document.createElement('span');
  barText.className = 'ai-diff-count';
  const barBtn = document.createElement('button');
  barBtn.className = 'mini-btn';
  bar.appendChild(barText);
  bar.appendChild(barBtn);
  node.appendChild(bar);

  const itemNodes = []; // [{ hunk, head, check, rowNodes }]

  function paint() {
    const accepted = hunks.filter((h) => h.accepted).length;
    barText.textContent = `${hunks.length} 处改动 · 已选 ${accepted} 处`;
    barBtn.textContent = accepted === hunks.length ? '全部跳过' : '全部接受';
    for (const item of itemNodes) {
      item.check.checked = item.hunk.accepted;
      item.head.classList.toggle('off', !item.hunk.accepted);
      item.rowNodes.forEach((n) => n.classList.toggle('off', !item.hunk.accepted));
    }
  }

  // 上下文：每块前后各留 2 行，其余折叠
  const CONTEXT = 2;
  const visible = new Set();
  for (const h of hunks) {
    for (let k = h.start - CONTEXT; k <= h.end + CONTEXT; k++) {
      if (k >= 0 && k < rows.length) visible.add(k);
    }
  }

  let skipped = 0;
  for (let idx = 0; idx < rows.length; idx++) {
    if (!visible.has(idx)) {
      skipped++;
      continue;
    }
    if (skipped) {
      const gap = document.createElement('div');
      gap.className = 'dl-head';
      gap.textContent = `… 跳过 ${skipped} 行未改动 …`;
      node.appendChild(gap);
      skipped = 0;
    }

    const at = hunkAt.get(idx);
    let current = null;
    if (at) {
      const head = document.createElement('div');
      head.className = 'dh';
      const label = document.createElement('label');
      label.className = 'dh-check';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = at.hunk.accepted;
      check.addEventListener('change', () => {
        at.hunk.accepted = check.checked;
        paint();
        if (typeof onChange === 'function') onChange();
      });
      label.appendChild(check);
      label.appendChild(document.createTextNode('接受'));
      const tag = document.createElement('span');
      tag.className = 'dh-tag';
      tag.textContent = `第 ${at.index + 1} 处`;
      head.appendChild(label);
      head.appendChild(tag);
      node.appendChild(head);
      current = { hunk: at.hunk, head, check, rowNodes: [] };
      itemNodes.push(current);
    }

    const row = rows[idx];

    // 同一块内相邻的 删除+新增 → 字符级高亮
    if (row.type === 'del' && rows[idx + 1] && rows[idx + 1].type === 'add' && current && idx + 1 <= current.hunk.end) {
      const seg = splitCommon(row.text, rows[idx + 1].text);
      const n1 = lineNode(row.text, 'del', { pre: seg.oldPre, mid: seg.oldMid, post: seg.oldPost });
      const n2 = lineNode(rows[idx + 1].text, 'add', { pre: seg.newPre, mid: seg.newMid, post: seg.newPost });
      node.appendChild(n1);
      node.appendChild(n2);
      current.rowNodes.push(n1, n2);
      idx++;
      continue;
    }

    const kind = row.type === 'same' ? '' : row.type;
    const n = lineNode(row.text, kind, kind ? { pre: '', mid: row.text, post: '' } : null);
    node.appendChild(n);
    if (current) current.rowNodes.push(n);
  }

  if (skipped) {
    const gap = document.createElement('div');
    gap.className = 'dl-head';
    gap.textContent = `… 跳过 ${skipped} 行未改动 …`;
    node.appendChild(gap);
  }

  paint();

  // 勾选状态变化时通知外部（用于同步底部按钮文案）
  let onChange = null;
  barBtn.addEventListener('click', () => {
    const all = hunks.every((h) => h.accepted);
    hunks.forEach((h) => (h.accepted = !all));
    paint();
    if (onChange) onChange();
  });

  return {
    node,
    changeCount: hunks.length,
    acceptedCount: () => hunks.filter((h) => h.accepted).length,
    allAccepted: () => hunks.every((h) => h.accepted),
    setAll(accepted) {
      hunks.forEach((h) => (h.accepted = accepted));
      paint();
      if (onChange) onChange();
    },
    onSelectionChange(fn) {
      onChange = fn;
    },
    /** 按当前勾选重组文本；mode='all' 表示忽略勾选、全部接受。 */
    compose(mode = 'accepted') {
      const byStart = new Map(hunks.map((h) => [h.start, h]));
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const h = byStart.get(i);
        if (!h) {
          if (rows[i].type === 'same') out.push(rows[i].text);
          continue;
        }
        const take = mode === 'all' ? true : h.accepted;
        for (let k = h.start; k <= h.end; k++) {
          const r = rows[k];
          if (take ? r.type === 'add' : r.type === 'del') out.push(r.text);
        }
        i = h.end;
      }
      return out.join('\n');
    },
  };
}

/* ------------------------------------------------------------------ 面板 */
export function createAi({ editor, onNeedConfig }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('ai-dialog');
  const chipsEl = $('ai-chips');
  const scopeEl = $('ai-scope');
  const hintEl = $('ai-hint');
  const diffEl = $('ai-diff');
  const metaEl = $('ai-meta');
  const instructionEl = $('ai-instruction');
  const btnGen = $('ai-generate');
  const btnRegen = $('ai-regen');
  const btnApply = $('ai-apply');
  const btnApplyAll = $('ai-apply-all');
  const btnCancel = $('ai-cancel');

  let action = 'polish';
  let scope = null;
  let result = null;
  let view = null;
  let busy = false;

  chipsEl.innerHTML = '';
  for (const act of ACTIONS) {
    const b = document.createElement('button');
    b.className = 'chip' + (act.id === action ? ' active' : '');
    b.dataset.act = act.id;
    b.textContent = act.label;
    b.title = act.hint || '';
    b.addEventListener('click', () => {
      action = act.id;
      chipsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.act === action));
      if (act.id === 'custom') instructionEl.focus();
    });
    chipsEl.appendChild(b);
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
      // 行级补丁：选区落在行中间时按整行处理，模型看到的是整行，没改的部分会原样保留
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
    showHint(
      '选好动作后点「生成」。模型只回编辑指令（改哪几行、改成什么），本地打补丁后再给你看差异——每一处都能单独勾选。'
    );
  }

  const took = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

  /** 按钮与说明随勾选状态更新：全接受时只留主按钮，有跳过时出现「只应用已选」。 */
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
    parts.push(result.mode === 'patch' ? `补丁 ${result.edits || total} 处` : '整篇改写');
    if (result.promptTokens || result.completionTokens) {
      parts.push(`入 ${result.promptTokens} / 出 ${result.completionTokens} tokens`);
    }
    parts.push(took(result.latency));
    if (result.rounds > 1) parts.push(`修正 ${result.rounds - 1} 次`);
    parts.push(`${total} 处改动`);
    metaEl.textContent = parts.join(' · ');
  }

  /** 任务描述：动作内置的约束 + 用户补充要求。 */
  function buildTask() {
    const act = ACTIONS.find((a) => a.id === action) || ACTIONS[0];
    const instruction = instructionEl.value.trim();
    if (!act.prompt) return instruction;
    return instruction ? `${act.prompt}\n补充要求：${instruction}` : act.prompt;
  }

  async function generate() {
    if (busy) return;
    captureScope();
    if (!scope.text.trim()) {
      toast('没有可处理的内容', { error: true });
      return;
    }
    const instruction = instructionEl.value.trim();
    if (action === 'custom' && !instruction) {
      metaEl.textContent = '「自定义」需要先在输入框写清楚要改什么';
      metaEl.classList.add('error');
      instructionEl.focus();
      return;
    }

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
        task: buildTask(),
        actionId: action,
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
    const next = total ? view.compose(mode) : result.text;
    cm.operation(() => {
      cm.replaceRange(next, scope.from, scope.to);
    });
    cm.focus();
    close();
    toast(
      accepted === total ? '已应用全部修改，⌘Z 可撤销' : `已应用 ${accepted}/${total} 处修改，⌘Z 可撤销`
    );
  }

  function open() {
    const s = captureScope();
    if (!s.text.trim()) {
      toast('文档还是空的，先写点东西', { error: true });
      return;
    }
    resetResult();
    dialog.classList.remove('hidden');
    instructionEl.value = '';
    setTimeout(() => (action === 'custom' ? instructionEl : btnGen).focus(), 30);
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
  instructionEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      generate();
    }
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
