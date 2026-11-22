import { t as tr } from './i18n.js';
// 通用 UI 零件：toast、弹出菜单、右键菜单、拖拽分隔条、图片查看器。
import { convertFileSrc } from './ipc.js';

/* ------------------------------------------------------------------ toast */
const toastHost = () => document.getElementById('toast-host');

export function toast(message, { error = false, duration = 2200 } = {}) {
  const host = toastHost();
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, duration);
}

/* ------------------------------------------------------------------ 菜单 */
const menuEl = () => document.getElementById('menu-popover');
const ctxEl = () => document.getElementById('ctx-menu');

function fillMenu(host, items) {
  host.innerHTML = '';
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      host.appendChild(sep);
      continue;
    }
    if (item.title) {
      const t = document.createElement('div');
      t.className = 'set-group-title';
      t.style.padding = '6px 10px 2px';
      t.textContent = item.title;
      host.appendChild(t);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'menu-item' + (item.danger ? ' danger' : '');
    if (item.disabled) {
      btn.disabled = true;
      btn.style.opacity = '0.45';
      btn.style.cursor = 'default';
    }
    const label = document.createElement('span');
    label.className = 'mi-label';
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'mi-hint';
      hint.textContent = item.hint;
      btn.appendChild(hint);
    }
    if (!item.disabled && item.onClick) {
      btn.addEventListener('click', () => {
        hideMenus();
        item.onClick();
      });
    }
    host.appendChild(btn);
  }
}

/** 锚定某个按钮弹出下拉菜单。 */
export function showMenu(anchor, items) {
  const host = menuEl();
  fillMenu(host, items);
  host.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  const w = host.offsetWidth;
  host.style.top = `${rect.bottom + 6}px`;
  host.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, rect.right - w))}px`;
}

/** 在鼠标位置弹出右键菜单。 */
export function showContextMenu(x, y, items) {
  const host = ctxEl();
  fillMenu(host, items);
  host.classList.remove('hidden');
  const rect = host.getBoundingClientRect();
  host.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  host.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

export function hideMenus() {
  menuEl().classList.add('hidden');
  ctxEl().classList.add('hidden');
}

document.addEventListener(
  'pointerdown',
  (e) => {
    const m = menuEl();
    const c = ctxEl();
    if (!m.classList.contains('hidden') && !m.contains(e.target)) m.classList.add('hidden');
    if (!c.classList.contains('hidden') && !c.contains(e.target)) c.classList.add('hidden');
  },
  true
);
window.addEventListener('blur', hideMenus);
window.addEventListener('resize', hideMenus);

/* ------------------------------------------------------------------ 输入对话框 */
/** 轻量输入框（WebView 里 window.prompt 不可用，重命名/新建都得靠它）。 */
export function promptDialog({ title = tr('ui.input'), label = '', value = '', confirmText = tr('ok'), placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    wrap.style.paddingTop = '26vh';
    wrap.innerHTML = `
      <div class="quickopen-box" style="width:min(420px,86vw)">
        <div style="padding:14px 16px 8px">
          <div style="font-size:13px;font-weight:600;margin-bottom:${label ? '4px' : '10px'}">${title}</div>
          ${label ? `<div style="font-size:11.5px;color:var(--text-faint);margin-bottom:8px">${label}</div>` : ''}
          <input id="pd-input" type="text" style="width:100%;height:32px;padding:0 10px;border-radius:7px;border:1px solid var(--border-strong);background:var(--bg);outline:none;font-size:13px" placeholder="${placeholder}" />
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px 14px">
          <button class="btn ghost" id="pd-cancel">${tr('cancel')}</button>
          <button class="btn" id="pd-ok">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('#pd-input');
    input.value = value || '';
    setTimeout(() => {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }, 20);

    const close = (result) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        close(input.value.trim() || null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    wrap.querySelector('#pd-ok').addEventListener('click', () => close(input.value.trim() || null));
    wrap.querySelector('#pd-cancel').addEventListener('click', () => close(null));
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target === wrap) close(null);
    });
  });
}

/* ------------------------------------------------------------------ 分隔条 */
/** 水平/垂直拖拽，回调给出像素位置与总长。 */
export function dragSplitter(el, { onStart, onMove, onEnd } = {}) {
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    if (onStart) onStart();
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (onMove) onMove(e.clientX, e.clientY);
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    try {
      el.releasePointerCapture(e.pointerId);
    } catch (_) {}
    if (onEnd) onEnd();
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
}

/* ------------------------------------------------------------------ 图片查看器 */
let lbState = null;

export function initLightbox() {
  const host = document.createElement('div');
  host.id = 'lightbox';
  host.className = 'hidden';
  host.innerHTML = '<img alt="" /><div class="lb-hint">' + tr('ui.lightboxHint') + '</div>';
  document.body.appendChild(host);

  const img = host.querySelector('img');
  const st = { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0 };
  lbState = { host, img, st };

  const apply = () => {
    img.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.scale})`;
  };
  const reset = () => {
    st.scale = 1;
    st.x = 0;
    st.y = 0;
    apply();
  };

  host.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0016;
    const next = Math.min(8, Math.max(0.15, st.scale * (1 + delta)));
    // 以光标为锚点缩放：先把光标位置换算成图片坐标，缩放后补偿位移
    const rect = img.getBoundingClientRect();
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    st.x -= cx * (next / st.scale - 1);
    st.y -= cy * (next / st.scale - 1);
    st.scale = next;
    apply();
  });
  host.addEventListener('pointerdown', (e) => {
    st.dragging = true;
    st.sx = e.clientX - st.x;
    st.sy = e.clientY - st.y;
    host.style.cursor = 'grabbing';
  });
  host.addEventListener('pointermove', (e) => {
    if (!st.dragging) return;
    st.x = e.clientX - st.sx;
    st.y = e.clientY - st.sy;
    apply();
  });
  host.addEventListener('pointerup', () => {
    st.dragging = false;
    host.style.cursor = 'grab';
  });
  host.addEventListener('dblclick', reset);
  host.addEventListener('click', (e) => {
    if (e.target === host) closeLightbox();
  });
  return { host, img, reset };
}

export function openLightbox(src) {
  if (!lbState) initLightbox();
  const { host, img, st } = lbState;
  img.src = src;
  st.scale = 1;
  st.x = 0;
  st.y = 0;
  img.style.transform = '';
  host.classList.remove('hidden');
}

export function closeLightbox() {
  if (lbState) lbState.host.classList.add('hidden');
}

export function lightboxOpen() {
  return !!lbState && !lbState.host.classList.contains('hidden');
}

/** 把本地绝对路径转成 webview 能加载的 asset URL。 */
export function fileUrl(path) {
  return convertFileSrc(path);
}
