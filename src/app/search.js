import { t as tr } from './i18n.js';
// 跨文件搜索面板。
import * as ipc from './ipc.js';

export function createSearch({ input, caseBox, resultsEl, getWorkspace, onOpen }) {
  let timer = null;
  let seq = 0;

  async function run() {
    const query = input.value.trim();
    const ws = getWorkspace();
    if (!ws) {
      resultsEl.innerHTML = '<div class="tree-empty">'+tr('search.openFolderFirst');
      return;
    }
    if (!query) {
      resultsEl.innerHTML = '';
      return;
    }
    const token = ++seq;
    resultsEl.innerHTML = '<div class="tree-empty">'+tr('search.searching');
    try {
      const groups = await ipc.searchInFiles(ws, query, caseBox.checked, false, []);
      if (token !== seq) return;
      render(groups, query);
    } catch (e) {
      if (token !== seq) return;
      resultsEl.innerHTML = `<div class="tree-empty">${ipc.describeError(e)}</div>`;
    }
  }

  function highlight(text, query) {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(text.slice(0, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + query.length);
    frag.appendChild(mark);
    frag.appendChild(document.createTextNode(text.slice(idx + query.length)));
    return frag;
  }

  function render(groups, query) {
    resultsEl.innerHTML = '';
    if (!groups.length) {
      resultsEl.innerHTML = '<div class="tree-empty">'+tr('search.noResult');
      return;
    }
    for (const group of groups) {
      const box = document.createElement('div');
      box.className = 'search-file';

      const head = document.createElement('div');
      head.className = 'search-file-head';
      const name = document.createElement('span');
      name.textContent = group.path.split(/[\\/]/).pop();
      head.appendChild(name);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(group.matches.length);
      head.appendChild(count);
      head.title = group.path;
      head.addEventListener('click', () => onOpen(group.path, group.matches[0] && group.matches[0].line));
      box.appendChild(head);

      const max = Math.min(group.matches.length, 50);
      for (let i = 0; i < max; i++) {
        const m = group.matches[i];
        const hit = document.createElement('div');
        hit.className = 'search-hit';
        const ln = document.createElement('span');
        ln.className = 'ln';
        ln.textContent = m.line;
        hit.appendChild(ln);
        hit.appendChild(highlight(m.line_text.trim() || ' ', query));
        hit.addEventListener('click', () => onOpen(group.path, m.line));
        box.appendChild(hit);
      }
      if (group.matches.length > max) {
        const more = document.createElement('div');
        more.className = 'search-hit';
        more.style.color = 'var(--text-faint)';
        more.textContent = tr('search.more', { n: group.matches.length - max });
        box.appendChild(more);
      }
      resultsEl.appendChild(box);
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 260);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      run();
    }
  });
  caseBox.addEventListener('change', run);

  return { run, focus: () => input.focus() };
}
