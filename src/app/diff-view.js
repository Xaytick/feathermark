import { t as tr } from './i18n.js';
// 可交互 diff 视图：把「原文 / 建议」按行聚成改动块，支持逐块接受。
// 从原 AI 编辑弹窗抽出，供 Agent 编辑模板流程复用。

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

function lineNode(text, kind, segments, onEdit) {
  const row = document.createElement('div');
  row.className = 'dl ' + (kind === 'del' ? 'del' : kind === 'add' ? 'add' : '');
  const sign = document.createElement('span');
  sign.className = 'dl-sign';
  sign.textContent = kind === 'del' ? '−' : kind === 'add' ? '+' : ' ';
  const body = document.createElement('span');
  body.className = 'dl-text';
  // 建议的新增行可就地编辑：用户能在应用前微调 AI 的措辞。
  if (kind === 'add') {
    body.contentEditable = 'true';
    body.spellcheck = false;
    body.title = tr('diff.editable');
    if (onEdit) {
      let currentText = text;
      const commit = () => {
        const next = body.innerText.replace(/\n/g, '');
        currentText = next;
        onEdit(next);
      };
      body.addEventListener('blur', commit);
      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); body.blur(); }
        if (e.key === 'Escape') { body.textContent = currentText; body.blur(); }
      });
    }
  }
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
      onSelectionChange: () => {},
      compose: () => text,
    };
  };

  // 改动规模过大（O(n·m) 表会太占内存）时退化为纯文本对照
  if (!rows) return plainFallback(tr('diff.tooLarge'), newText);

  const hunks = buildHunks(rows);
  if (!hunks.length) return plainFallback(null, tr('diff.noChanges'));

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
    barText.textContent = tr('diff.summary', { t: hunks.length, a: accepted });
    barBtn.textContent = accepted === hunks.length ? tr('diff.skipAll') : tr('diff.acceptAll');
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
      gap.textContent = tr('diff.skipped', { n: skipped });
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
      label.appendChild(document.createTextNode(tr('diff.accept')));
      const tag = document.createElement('span');
      tag.className = 'dh-tag';
      tag.textContent = tr('diff.changeNo', { n: at.index + 1 });
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
      const addIdx = idx + 1;
      const n2 = lineNode(rows[addIdx].text, 'add', { pre: seg.newPre, mid: seg.newMid, post: seg.newPost },
        (next) => { rows[addIdx].text = next; });
      node.appendChild(n1);
      node.appendChild(n2);
      current.rowNodes.push(n1, n2);
      idx++;
      continue;
    }

    const kind = row.type === 'same' ? '' : row.type;
    const thisIdx = idx;
    const n = lineNode(row.text, kind, kind ? { pre: '', mid: row.text, post: '' } : null,
      kind === 'add' ? (next) => { rows[thisIdx].text = next; } : null);
    node.appendChild(n);
    if (current) current.rowNodes.push(n);
  }

  if (skipped) {
    const gap = document.createElement('div');
    gap.className = 'dl-head';
    gap.textContent = tr('diff.skipped', { n: skipped });
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

