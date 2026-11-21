// 界面语言：中文 / English。
// 设计：字典以稳定 key 索引；DOM 里需要翻译的静态元素标 data-i18n="key"，
// 可选 data-i18n-attr="title|placeholder" 指定翻译属性（默认 textContent）。
// 运行时文案用 t(key) 取，切换语言后已渲染的动态区域由各模块按需重绘。
import { prefs, savePrefs } from './store.js';

const DICT = {
  zh: {
    // 标题栏 / 工具栏
    'tb.new': '新建 (⌘N)', 'tb.open': '打开文件 (⌘O)', 'tb.folder': '打开文件夹',
    'tb.editor': '仅编辑', 'tb.split': '分屏', 'tb.preview': '仅预览',
    'tb.chat': 'Agent 对话 (⌘L)', 'tb.more': '更多',
    'tb.minimize': '最小化', 'tb.maximize': '最大化', 'tb.close': '关闭',
    // 侧栏
    'side.files': '文件', 'side.outline': '大纲', 'side.search': '搜索',
    'side.noFolder': '未打开文件夹', 'side.refresh': '刷新',
    'side.workspaceSearch': '工作区搜索', 'side.searchPlaceholder': '搜索内容…',
    'side.caseSensitive': '区分大小写',
    // 空状态
    'empty.new': '新建文档', 'empty.open': '打开文件', 'empty.folder': '打开文件夹',
    'empty.tagline': '轻量 · 跨平台 · Markdown',
    // 更多菜单
    'menu.new': '新建', 'menu.openFile': '打开文件…', 'menu.openFolder': '打开文件夹…',
    'menu.chatTemplate': 'Agent 编辑模板…', 'menu.save': '保存', 'menu.saveAs': '另存为…',
    'menu.export': '导出', 'menu.exportHtml': '导出 HTML', 'menu.exportPng': '导出长图 PNG',
    'menu.exportPdf': '导出 PDF', 'menu.copyRich': '复制为富文本',
    'menu.settings': '设置…', 'menu.quickOpen': '快速打开…',
    'menu.devtools': '开发者工具', 'menu.quit': '退出',
    'menu.history': '编辑历史…',
    // 编辑历史
    'hist.title': '编辑历史', 'hist.hint': '这些版本存在当前 git 仓库的独立 ref 中，不影响你的提交历史。',
    'hist.clear': '清空历史', 'hist.saveAs': '另存为文件', 'hist.restore': '恢复到编辑器',
    'hist.noFile': '当前文档未保存到工作区', 'hist.loading': '正在读取历史…', 'hist.loadingDoc': '正在读取版本内容…',
    'hist.empty': '还没有历史版本', 'hist.emptyHint': '用 Agent 编辑文档后，版本会出现在这里。',
    'hist.count': '共 {n} 个版本',
    'hist.restoreTitle': '恢复版本', 'hist.restoreConfirm': '确定恢复到「{label}」吗？当前未保存的内容会先存成一个版本。',
    'hist.restored': '已恢复，⌘Z 可撤销', 'hist.saved': '已另存',
    'hist.clearTitle': '清空历史', 'hist.clearConfirm': '确定清空当前文档的全部历史版本吗？此操作不可撤销。', 'hist.cleared': '历史已清空',
    // 标签右键
    'tab.close': '关闭', 'tab.closeOthers': '关闭其他',
    'tab.copyPath': '复制路径', 'tab.reveal': '在文件管理器中显示',
    // 右键编辑
    'edit.undo': '撤销', 'edit.redo': '重做', 'edit.cut': '剪切', 'edit.copy': '复制',
    'edit.paste': '粘贴', 'edit.selectAll': '全选', 'edit.format': '格式',
    'edit.bold': '粗体', 'edit.italic': '斜体', 'edit.strike': '删除线',
    'edit.inlineCode': '行内代码', 'edit.codeBlock': '代码块', 'edit.link': '链接',
    'edit.image': '图片', 'edit.quote': '引用', 'edit.viewImage': '查看图片',
    'edit.insertLink': '插入链接', 'edit.h1': '标题 1', 'edit.h2': '标题 2',
    'edit.ul': '无序列表', 'edit.task': '任务列表', 'edit.pasteFail': '无法读取剪贴板，请用 ⌘V 粘贴',
    'edit.copyLink': '复制链接', 'edit.copyPath': '复制路径',
    // 查找
    'find.find': '查找', 'find.replace': '替换', 'find.next': '下一个', 'find.prev': '上一个',
    'find.close': '关闭', 'find.matchCase': '区分大小写', 'find.wholeWord': '全词匹配',
    'find.regex': '正则', 'find.replaceOne': '替换', 'find.replaceAll': '全部替换',
    // 设置
    'set.title': '设置', 'set.appearance': '外观', 'set.editor': '编辑器',
    'set.ai': 'AI', 'set.about': '关于', 'set.theme': '主题 · 配色',
    'set.editorHint': '字体 · 编辑', 'set.aboutHint': '版本 · 快捷键',
    'set.language': '界面语言', 'set.languageDesc': '设置菜单栏与应用界面的显示语言，重启后依然生效',
    // 通用提示
    'toast.saved': '已保存', 'toast.noDoc': '先打开一个文档', 'toast.pathCopied': '路径已复制',
  },
  en: {
    'tb.new': 'New (⌘N)', 'tb.open': 'Open File (⌘O)', 'tb.folder': 'Open Folder',
    'tb.editor': 'Editor Only', 'tb.split': 'Split View', 'tb.preview': 'Preview Only',
    'tb.chat': 'Agent Chat (⌘L)', 'tb.more': 'More',
    'tb.minimize': 'Minimize', 'tb.maximize': 'Maximize', 'tb.close': 'Close',
    'side.files': 'Files', 'side.outline': 'Outline', 'side.search': 'Search',
    'side.noFolder': 'No folder opened', 'side.refresh': 'Refresh',
    'side.workspaceSearch': 'Search in Workspace', 'side.searchPlaceholder': 'Search content…',
    'side.caseSensitive': 'Match case',
    'empty.new': 'New Document', 'empty.open': 'Open File', 'empty.folder': 'Open Folder',
    'empty.tagline': 'Lightweight · Cross-platform · Markdown',
    'menu.new': 'New', 'menu.openFile': 'Open File…', 'menu.openFolder': 'Open Folder…',
    'menu.chatTemplate': 'Agent Edit Template…', 'menu.save': 'Save', 'menu.saveAs': 'Save As…',
    'menu.export': 'Export', 'menu.exportHtml': 'Export HTML', 'menu.exportPng': 'Export PNG',
    'menu.exportPdf': 'Export PDF', 'menu.copyRich': 'Copy as Rich Text',
    'menu.settings': 'Settings…', 'menu.quickOpen': 'Quick Open…',
    'menu.devtools': 'Developer Tools', 'menu.quit': 'Quit',
    'menu.history': 'Edit History…',
    'hist.title': 'Edit History', 'hist.hint': 'Versions live in a separate ref of the current git repo; your commit history stays untouched.',
    'hist.clear': 'Clear History', 'hist.saveAs': 'Save as File', 'hist.restore': 'Restore to Editor',
    'hist.noFile': 'Current document is not saved in workspace', 'hist.loading': 'Loading history…', 'hist.loadingDoc': 'Loading version…',
    'hist.empty': 'No versions yet', 'hist.emptyHint': 'After an Agent edit, versions will appear here.',
    'hist.count': '{n} versions',
    'hist.restoreTitle': 'Restore Version', 'hist.restoreConfirm': 'Restore to "{label}"? Current unsaved content will be saved as a version first.',
    'hist.restored': 'Restored, ⌘Z to undo', 'hist.saved': 'Saved',
    'hist.clearTitle': 'Clear History', 'hist.clearConfirm': 'Clear all history for this document? This cannot be undone.', 'hist.cleared': 'History cleared',
    'tab.close': 'Close', 'tab.closeOthers': 'Close Others',
    'tab.copyPath': 'Copy Path', 'tab.reveal': 'Reveal in File Manager',
    'edit.undo': 'Undo', 'edit.redo': 'Redo', 'edit.cut': 'Cut', 'edit.copy': 'Copy',
    'edit.paste': 'Paste', 'edit.selectAll': 'Select All', 'edit.format': 'Format',
    'edit.bold': 'Bold', 'edit.italic': 'Italic', 'edit.strike': 'Strikethrough',
    'edit.inlineCode': 'Inline Code', 'edit.codeBlock': 'Code Block', 'edit.link': 'Link',
    'edit.image': 'Image', 'edit.quote': 'Quote', 'edit.viewImage': 'View Image',
    'edit.insertLink': 'Insert Link', 'edit.h1': 'Heading 1', 'edit.h2': 'Heading 2',
    'edit.ul': 'Bullet List', 'edit.task': 'Task List', 'edit.pasteFail': 'Cannot read clipboard, paste with ⌘V',
    'edit.copyLink': 'Copy Link', 'edit.copyPath': 'Copy Path',
    'find.find': 'Find', 'find.replace': 'Replace', 'find.next': 'Next', 'find.prev': 'Previous',
    'find.close': 'Close', 'find.matchCase': 'Match Case', 'find.wholeWord': 'Whole Word',
    'find.regex': 'Regex', 'find.replaceOne': 'Replace', 'find.replaceAll': 'Replace All',
    'set.title': 'Settings', 'set.appearance': 'Appearance', 'set.editor': 'Editor',
    'set.ai': 'AI', 'set.about': 'About', 'set.theme': 'Theme · Colors',
    'set.editorHint': 'Font · Editing', 'set.aboutHint': 'Version · Shortcuts',
    'set.language': 'Language', 'set.languageDesc': 'Choose the display language for menus and UI. Takes effect immediately.',
    'toast.saved': 'Saved', 'toast.noDoc': 'Open a document first', 'toast.pathCopied': 'Path copied',
  },
};

let current = normalize(prefs.language);

function normalize(lang) {
  const s = typeof lang === 'string' ? lang.toLowerCase() : '';
  return s.startsWith('zh') ? 'zh' : 'en';
}

export function locale() { return current; }

export function t(key) {
  const d = DICT[current] || DICT.zh;
  return d[key] !== undefined ? d[key] : (DICT.zh[key] !== undefined ? DICT.zh[key] : key);
}

/** 切换语言：更新字典 + 保存偏好 + 刷新所有 data-i18n 元素 + 通知原生菜单。 */
export async function setLocale(lang) {
  current = lang === 'en' ? 'en' : 'zh';
  prefs.language = current;
  savePrefs();
  applyStatic();
  // 原生菜单由 Rust 端按语言重建（失败不影响界面切换）
  try {
    const ipc = await import('./ipc.js');
    await ipc.setLanguage(current);
  } catch (_) {}
  document.dispatchEvent(new CustomEvent('languagechange', { detail: { locale: current } }));
}

/** 把带 data-i18n 标记的静态元素翻成当前语言。 */
export function applyStatic() {
  const nodes = document.querySelectorAll('[data-i18n]');
  nodes.forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const attr = el.getAttribute('data-i18n-attr');
    const value = t(key);
    if (attr) el.setAttribute(attr, value);
    else el.textContent = value;
  });
}

// 初始化：页面加载后应用一次静态文案
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStatic);
  } else {
    applyStatic();
  }
}
