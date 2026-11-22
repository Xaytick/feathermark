import { t as tr } from './i18n.js';
// 快速打开（⌘P）：按路径模糊匹配工作区文件，键盘上下选择。
import * as ipc from './ipc.js';

export function createQuickOpen({ overlay, input, list, getWorkspace, onOpen }) {
  let files = [];
  let filtered = [];
  let cursor = 0;
  let cacheRoot = null;

  const isOpen = () => !overlay.classList.contains('hidden');

  function fuzzyScore(haystack, needle) {
    // 子序列匹配 + 连续命中加权：hello-world 里搜 "hw" 也能命中
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();
    if (!n) return 1;
    let score = 0;
    let hi = 0;
    let streak = 0;
    for (const ch of n) {
      const found = h.indexOf(ch, hi);
      if (found === -1) return -1;
      streak = found === hi ? streak + 1 : 0;
      score += 1 + streak * 2 + (found === 0 || h[found - 1] === '/' ? 3 : 0);
      hi = found + 1;
    }
    score -= Math.max(0, h.length - n.length) * 0.02;
    return score;
  }

  function filter(query) {
    if (!query.trim()) {
      filtered = files.slice(0, 60);
    } else {
      filtered = files
        .map((f) => ({ f, s: fuzzyScore(f.relative_path, query.trim()) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 60)
        .map((x) => x.f);
    }
    cursor = 0;
    paint();
  }

  function paint() {
    list.innerHTML = '';
    if (!filtered.length) {
      list.innerHTML = '<div class="tree-empty">'+tr('quick.noMatch');
      return;
    }
    filtered.forEach((f, i) => {
      const item = document.createElement('div');
      item.className = 'qo-item' + (i === cursor ? ' sel' : '');
      const name = document.createElement('span');
      name.className = 'qo-name';
      name.textContent = f.name;
      const dir = document.createElement('span');
      dir.className = 'qo-dir';
      dir.textContent = f.relative_path.replace(/[^\\/]+$/, '').replace(/[\\/]$/, '');
      item.appendChild(name);
      item.appendChild(dir);
      item.addEventListener('click', () => choose(i));
      list.appendChild(item);
    });
    const active = list.children[cursor];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const f = filtered[i];
    if (!f) return;
    close();
    onOpen(f.path);
  }

  async function open() {
    const ws = getWorkspace();
    overlay.classList.remove('hidden');
    input.value = '';
    list.innerHTML = '<div class="tree-empty">'+tr('quick.indexing');
    input.focus();
    if (!ws) {
      list.innerHTML = '<div class="tree-empty">'+tr('quick.noFolder');
      return;
    }
    if (cacheRoot !== ws) {
      files = await ipc.searchFiles(ws, null, 20000);
      cacheRoot = ws;
    }
    filter('');
  }

  function close() {
    overlay.classList.add('hidden');
  }

  input.addEventListener('input', () => filter(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      cursor = Math.min(filtered.length - 1, cursor + 1);
      paint();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      cursor = Math.max(0, cursor - 1);
      paint();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      choose(cursor);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      close();
      e.preventDefault();
    }
  });
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });

  return { open, close, isOpen, invalidate: () => (cacheRoot = null) };
}
