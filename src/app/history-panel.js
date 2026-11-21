// 编辑历史面板：列出当前文档在**应用私有 git 仓库**里的版本，
// 选中版本与当前文档做 diff，支持恢复 / 另存 / 清空。
// 关闭历史开关时：数据仍可见、可另存，但恢复禁用（恢复会写入新版本）。
import * as ipc from './ipc.js';
import { toast } from './ui.js';
import { buildDiffView } from './diff-view.js';
import { t as tr } from './i18n.js';

export function createHistoryPanel({ editor, getDocKey, getDoc, isEnabled }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('history-dialog');
  const listEl = $('history-list');
  const diffEl = $('history-diff');
  const scopeEl = $('history-scope');
  const metaEl = $('history-meta');
  const btnRestore = $('history-restore');
  const btnSaveAs = $('history-saveas');
  const btnClear = $('history-clear');
  const btnClearAll = $('history-clear-all');
  const hintEl = $('history-hint');

  let versions = [];
  let selected = null;
  let selectedDoc = null;
  let lastError = '';

  function invalidate() {
    if (!dialog.classList.contains('hidden')) load();
  }
  function notifyError(msg) {
    lastError = msg || '';
    if (!dialog.classList.contains('hidden') && msg) metaEl.textContent = tr('hist.writeFailed') + msg;
  }

  function relativeTime(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  function updateEnabledUI() {
    const on = isEnabled();
    btnRestore.disabled = !on || !selectedDoc;
    hintEl.textContent = on ? tr('hist.hint') : tr('hist.disabledHint');
    hintEl.classList.toggle('history-hint-off', !on);
  }

  async function load() {
    const key = getDocKey();
    listEl.innerHTML = '';
    diffEl.innerHTML = '';
    selected = null;
    selectedDoc = null;
    updateEnabledUI();
    if (!key) {
      metaEl.textContent = tr('hist.noFile');
      return;
    }
    scopeEl.textContent = key;
    metaEl.textContent = tr('hist.loading');
    try {
      const p = await ipc.historyStoragePath();
      scopeEl.title = tr('hist.storagePath') + ': ' + p;
    } catch (_) {}
    try {
      versions = await ipc.historyList(key);
    } catch (e) {
      metaEl.textContent = ipc.describeError(e);
      return;
    }
    if (!versions.length) {
      metaEl.textContent = lastError ? tr('hist.writeFailed') + lastError : tr('hist.empty');
      listEl.innerHTML = '<div class="history-empty">' + tr('hist.emptyHint') + '</div>';
      return;
    }
    metaEl.textContent = tr('hist.count').replace('{n}', versions.length);
    for (const v of versions) {
      const row = document.createElement('div');
      row.className = 'history-item';
      const label = document.createElement('span');
      label.className = 'hi-label';
      label.textContent = v.label || '编辑';
      const time = document.createElement('span');
      time.className = 'hi-time';
      time.textContent = relativeTime(v.time);
      const id = document.createElement('span');
      id.className = 'hi-id';
      id.textContent = v.id;
      row.append(label, time, id);
      row.addEventListener('click', () => selectVersion(v, row));
      listEl.appendChild(row);
    }
    selectVersion(versions[0], listEl.firstChild);
  }

  async function selectVersion(v, row) {
    for (const el of listEl.children) el.classList.remove('active');
    if (row) row.classList.add('active');
    selected = v;
    selectedDoc = null;
    metaEl.textContent = tr('hist.loadingDoc');
    try {
      selectedDoc = await ipc.historyDoc(v.full_id);
      const view = buildDiffView(selectedDoc, getDoc());
      diffEl.innerHTML = '';
      diffEl.appendChild(view.node);
      metaEl.textContent = `${v.label} · ${v.id} · ${new Date(v.time * 1000).toLocaleString()}`;
    } catch (e) {
      metaEl.textContent = ipc.describeError(e);
    }
    updateEnabledUI();
  }

  async function restore() {
    if (!isEnabled() || !selected || selectedDoc == null) return;
    const ok = await ipc.confirmDialog(
      tr('hist.restoreConfirm').replace('{label}', selected.label),
      { title: tr('hist.restoreTitle') }
    );
    if (!ok) return;
    // 恢复前先把「当前状态」存成版本，双向可回溯
    try {
      await ipc.historyRecord(getDocKey(), getDoc(), '恢复点（之前）', { source: 'restore-before' });
    } catch (_) {}
    editor.cm.operation(() => editor.cm.replaceRange(selectedDoc, { line: 0, ch: 0 }, {
      line: editor.cm.lineCount() - 1,
      ch: editor.cm.getLine(editor.cm.lineCount() - 1).length,
    }));
    editor.cm.focus();
    editor.cm.refresh();
    toast(tr('hist.restored'));
    close();
  }

  async function saveAs() {
    if (!selected || selectedDoc == null) return;
    const name = await ipc.pickSavePath((getDocKey() || 'document').split('/').pop(), [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
    ]);
    if (!name) return;
    try {
      await ipc.writeFile(name, selectedDoc);
      toast(tr('hist.saved'));
    } catch (e) {
      toast(ipc.describeError(e), { error: true });
    }
  }

  async function clear() {
    if (!getDocKey()) return;
    const ok = await ipc.confirmDialog(tr('hist.clearConfirm'), { title: tr('hist.clearTitle') });
    if (!ok) return;
    try {
      await ipc.historyClear(getDocKey());
      toast(tr('hist.cleared'));
      load();
    } catch (e) {
      toast(ipc.describeError(e), { error: true });
    }
  }

  async function clearAll() {
    const ok = await ipc.confirmDialog(tr('hist.clearAllConfirm'), { title: tr('hist.clearAllTitle') });
    if (!ok) return;
    try {
      const n = await ipc.historyClearAll();
      toast(tr('hist.clearedAll').replace('{n}', n));
      load();
    } catch (e) {
      toast(ipc.describeError(e), { error: true });
    }
  }

  function open() {
    dialog.classList.remove('hidden');
    lastError = '';
    load();
  }
  function close() { dialog.classList.add('hidden'); }
  function isOpen() { return !dialog.classList.contains('hidden'); }

  $('history-close').addEventListener('click', close);
  dialog.addEventListener('pointerdown', (e) => { if (e.target === dialog) close(); });
  btnRestore.addEventListener('click', restore);
  btnSaveAs.addEventListener('click', saveAs);
  btnClear.addEventListener('click', clear);
  if (btnClearAll) btnClearAll.addEventListener('click', clearAll);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close(); }
  });

  return { open, close, isOpen, invalidate, notifyError };
}
