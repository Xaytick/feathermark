import { t as tr } from './i18n.js';
// 侧边栏文件树：懒加载目录、展开状态记忆、右键文件操作。
import * as ipc from './ipc.js';
import { showContextMenu, promptDialog, toast } from './ui.js';

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;
const TEXT_EXT = /\.(txt|json|ya?ml|toml|ini|js|ts|jsx|tsx|css|html?|py|rs|go|java|c|cpp|h|sh|sql|xml|log)$/i;

function iconFor(entry) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ficon');
  svg.innerHTML = `<use href="#${entry.is_dir ? 'i-folder' : 'i-file'}" />`;
  if (!entry.is_dir) {
    if (MD_EXT.test(entry.name)) svg.style.color = 'var(--accent)';
    else if (!TEXT_EXT.test(entry.name)) svg.style.opacity = '0.45';
  } else {
    svg.style.color = 'var(--text-dim)';
  }
  return svg;
}

export function createTree({ el, session, openFile, getActivePath, onWorkspaceChanged }) {
  let root = null;
  const expanded = new Set(session.expanded || []);
  let activePath = null;

  function persist() {
    session.expanded = Array.from(expanded);
    if (session.save) session.save();
  }

  /** 展开状态恢复时推算缩进层级。 */
  const depthOf = (p) => {
    if (!root) return 0;
    const rel = p.slice(root.length).replace(/^[\\/]/, '');
    return rel.split(/[\\/]/).filter(Boolean).length;
  };

  function rowFor(entry, depth) {
    const node = document.createElement('div');
    node.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = entry.path;
    row.dataset.dir = entry.is_dir ? '1' : '0';
    row.style.paddingLeft = `${4 + depth * 2}px`;

    if (entry.is_dir) {
      const twisty = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      twisty.setAttribute('class', 'twisty' + (expanded.has(entry.path) ? ' open' : ''));
      twisty.innerHTML = '<use href="#i-chevron" />';
      row.appendChild(twisty);
    } else {
      const spacer = document.createElement('span');
      spacer.style.width = '14px';
      spacer.style.flex = 'none';
      row.appendChild(spacer);
    }

    row.appendChild(iconFor(entry));

    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = entry.name;
    row.appendChild(name);

    const children = document.createElement('div');
    children.className = 'tree-children';
    children.style.display = expanded.has(entry.path) ? '' : 'none';

    row.addEventListener('click', () => {
      if (entry.is_dir) toggleDir(entry, row, children, depth);
      else openFile(entry.path);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      fileMenu(entry, e.clientX, e.clientY);
    });

    node.appendChild(row);
    if (entry.is_dir) node.appendChild(children);

    if (entry.is_dir && expanded.has(entry.path)) loadChildren(entry.path, children, depth + 1);
    if (!entry.is_dir && entry.path === activePath) row.classList.add('active');

    return node;
  }

  async function loadChildren(dirPath, container, depth = 1) {
    container.innerHTML = '';
    try {
      const listing = await ipc.listDir(dirPath);
      for (const entry of listing.entries) {
        container.appendChild(rowFor(entry, depth));
      }
      if (listing.truncated) {
        const more = document.createElement('div');
        more.className = 'tree-empty';
        more.textContent = tr('tree.truncated');
        container.appendChild(more);
      }
    } catch (e) {
      const err = document.createElement('div');
      err.className = 'tree-empty';
      err.textContent = ipc.describeError(e);
      container.appendChild(err);
    }
  }

  async function toggleDir(entry, row, children, depth) {
    const twisty = row.querySelector('.twisty');
    if (expanded.has(entry.path)) {
      expanded.delete(entry.path);
      children.style.display = 'none';
      if (twisty) twisty.classList.remove('open');
    } else {
      expanded.add(entry.path);
      children.style.display = '';
      if (twisty) twisty.classList.add('open');
      await loadChildren(entry.path, children, depth + 1);
    }
    persist();
  }

  function fileMenu(entry, x, y) {
    const dir = entry.is_dir ? entry.path : entry.path.replace(/[\\/][^\\/]+$/, '');
    showContextMenu(x, y, [
      ...(entry.is_dir
        ? [
            {
              label: tr('tree.newFile'),
              onClick: async () => {
                const name = await promptDialog({ title: tr('tree.newFile'), value: tr('tree.untitledMd') });
                if (!name) return;
                const target = entry.path + '/' + name;
                try {
                  await ipc.writeFile(target, '');
                  await refresh();
                  openFile(target);
                } catch (e) {
                  toast(ipc.describeError(e), { error: true });
                }
              },
            },
            {
              label: tr('tree.newFolder'),
              onClick: async () => {
                const name = await promptDialog({ title: tr('tree.newFolder'), value: tr('tree.newFolder') });
                if (!name) return;
                try {
                  await ipc.ensureDir(entry.path + '/' + name);
                  await refresh();
                } catch (e) {
                  toast(ipc.describeError(e), { error: true });
                }
              },
            },
            { sep: true },
          ]
        : [{ label: tr('tree.open'), onClick: () => openFile(entry.path) }, { sep: true }]),
      {
        label: tr('rename'),
        onClick: async () => {
          const name = await promptDialog({ title: tr('rename'), value: entry.name });
          if (!name || name === entry.name) return;
          const target = entry.path.replace(/[^\\/]+$/, name);
          try {
            await ipc.renamePath(entry.path, target);
            await refresh();
            if (onWorkspaceChanged) onWorkspaceChanged({ renamed: [entry.path, target] });
          } catch (e) {
            toast(ipc.describeError(e), { error: true });
          }
        },
      },
      {
        label: tr('delete'),
        danger: true,
        onClick: async () => {
          const ok = await ipc.confirmDialog(tr('tree.deleteConfirm', { n: entry.name }), {
            title: tr('delete'),
            kind: 'warning',
          });
          if (!ok) return;
          try {
            await ipc.removePath(entry.path);
            await refresh();
            if (onWorkspaceChanged) onWorkspaceChanged({ removed: entry.path });
          } catch (e) {
            toast(ipc.describeError(e), { error: true });
          }
        },
      },
      { sep: true },
      {
        label: tr('tab.reveal'),
        onClick: () => ipc.revealInFolder(entry.path, entry.is_dir).catch(() => {}),
      },
      {
        label: '复制路径',
        onClick: () => navigator.clipboard.writeText(entry.path).then(() => toast('路径已复制')),
      },
      { sep: true },
      { label: dir ? '刷新' : '刷新', onClick: () => refresh() },
    ]);
  }

  async function refresh() {
    if (!root) return;
    const keep = Array.from(expanded);
    el.innerHTML = '';
    await loadChildren(root, el, 0);
    // 恢复展开状态：按路径逐层展开（顺序遍历保证父目录先展开）
    for (const p of keep.sort((a, b) => a.length - b.length)) {
      const row = el.querySelector(`.tree-row[data-path="${CSS.escape(p)}"]`);
      if (!row) continue;
      expanded.add(p);
      row.querySelector('.twisty')?.classList.add('open');
      const children = row.parentElement.querySelector('.tree-children');
      if (children) {
        children.style.display = '';
        await loadChildren(p, children, depthOf(p));
      }
    }
    setActive(activePath);
  }

  async function setRoot(path) {
    root = path || null;
    expanded.clear();
    el.innerHTML = '';
    if (!root) {
      el.innerHTML = '<div class="tree-empty">还没有打开文件夹。<br>点顶部的文件夹按钮，或把目录拖进窗口。</div>';
      return;
    }
    await loadChildren(root, el, 0);
  }

  function setActive(path) {
    activePath = path || null;
    el.querySelectorAll('.tree-row.active').forEach((r) => r.classList.remove('active'));
    if (!activePath) return;
    const row = el.querySelector(`.tree-row[data-path="${CSS.escape(activePath)}"]`);
    if (row) {
      row.classList.add('active');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  return {
    setRoot,
    refresh,
    setActive,
    getRoot: () => root,
    expandAll: () => {},
  };
}
