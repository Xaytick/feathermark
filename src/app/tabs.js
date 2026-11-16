// 标签栏：渲染、切换、关闭、拖拽排序、右键菜单。
export function createTabs({ el, onSelect, onClose, onMenu, onReorder }) {
  let dragId = null;

  function render(tabs, activeId) {
    el.innerHTML = '';
    for (const tab of tabs) {
      const node = document.createElement('div');
      node.className = 'tab' + (tab.id === activeId ? ' active' : '');
      node.dataset.id = tab.id;
      node.draggable = true;
      node.title = tab.path || tab.name;

      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tab.name;
      node.appendChild(name);

      if (tab.dirty) {
        const dot = document.createElement('span');
        dot.className = 'tab-dot';
        node.appendChild(dot);
      }

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-close" /></svg>';
      close.title = '关闭';
      close.addEventListener('pointerdown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        onClose(tab.id);
      });
      node.appendChild(close);

      node.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
          return;
        }
        if (e.button === 0) onSelect(tab.id);
      });
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        onSelect(tab.id);
        onMenu(tab, e.clientX, e.clientY);
      });

      node.addEventListener('dragstart', (e) => {
        dragId = tab.id;
        node.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', tab.id);
        } catch (_) {}
      });
      node.addEventListener('dragend', () => {
        dragId = null;
        node.classList.remove('dragging');
      });
      node.addEventListener('dragover', (e) => {
        if (!dragId || dragId === tab.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      node.addEventListener('drop', (e) => {
        if (!dragId || dragId === tab.id) return;
        e.preventDefault();
        onReorder(dragId, tab.id);
      });

      el.appendChild(node);
    }
  }

  // 中键滚轮横向滚动标签栏
  el.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false }
  );

  return { render };
}
