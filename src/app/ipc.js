// 唯一的后端边界：所有 invoke 只出现在这里（照搬参考实现的 ADR-1）。
// 这一层保持「语义空操作」——resolve 原样返回、reject 原样抛出，不做包装，
// 否则上层对结构化错误（文件不存在/无权限/被占用）的判断会失效。
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog, save as saveDialog, message as showMessage, ask as showAsk } from '@tauri-apps/plugin-dialog';

export { convertFileSrc, getCurrentWindow };

const call = (cmd, args) => invoke(cmd, args);

/* ------------------------------------------------------------------ 文件 */
export const readFile = (path) => call('read_file', { path });
export const readBundledFile = (filename) => call('read_bundled_file', { filename });
export const writeFile = (path, content) => call('write_file', { path, content });
export const saveBase64File = (path, base64Data) => call('save_base64_file', { path, base64Data });
export const ensureDir = (path) => call('ensure_dir', { path });
export const fileMeta = (path) => call('file_meta', { path });
export const isDirectory = (path) => call('is_directory', { path });
export const listDir = (path) => call('list_dir', { path });
export const renamePath = (from, to) => call('rename_path', { from, to });
export const removePath = (path) => call('remove_path', { path });
export const copyPath = (from, to) => call('copy_path', { from, to });
export const movePath = (from, to) => call('move_path', { from, to });
export const revealInFolder = (path, isDir) => call('reveal_in_folder', { path, isDir });
export const openPath = (target) => call('open_path', { target });

/* ------------------------------------------------------------------ 监听 */
export const watchFolder = (path) => call('watch_folder', { path });
export const stopWatch = () => call('stop_watch');

/* ------------------------------------------------------------------ 图片 */
export const saveImageToAssets = (bytes, ext, assetsDir) =>
  call('save_image_to_assets', { bytes: Array.from(bytes), ext, assetsDir });
export const fetchImageAsBase64 = (url) => call('fetch_image_as_base64', { url });

/* ------------------------------------------------------------------ 搜索 */
export const searchInFiles = (dir, pattern, caseSensitive, useRegex, extensions = []) =>
  call('search_in_files', { dir, pattern, caseSensitive, useRegex, extensions });
export const searchFiles = (path, extensions = null, maxResults = 20000) =>
  call('search_files', { path, extensions, maxResults });

/* ------------------------------------------------------------------ 其他 */
export const appDataDir = () => call('app_data_dir');
export const listSystemFonts = () => call('list_system_fonts');
export const getPlatform = () => call('platform');
export const getCliArgs = () => call('get_cli_args');
export const windowAction = (action) => call('window_action', { action });
export const quitApp = () => call('quit_app');
export const openDevtools = () => call('open_devtools');

/* ------------------------------------------------------------------ AI */
// 所有 AI 请求都经 Rust 转发：密钥只留在 Rust 侧的配置文件里，前端拿不到明文。
export const aiConfigGet = () => call('ai_config_get');
export const aiConfigSet = (cfg) => call('ai_config_set', cfg);
export const aiConfigClearKey = () => call('ai_config_clear_key');
export const aiChat = (messages) => call('ai_chat', { messages });
export const aiTest = () => call('ai_test');
export const aiModels = () => call('ai_models');

/* ------------------------------------------------------------------ 对话框 */
const MD_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
  { name: '所有文件', extensions: ['*'] },
];

export async function pickFiles({ multiple = true } = {}) {
  const res = await openDialog({ multiple, directory: false, filters: MD_FILTERS });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

export async function pickFolder() {
  const res = await openDialog({ directory: true, multiple: false });
  return res || null;
}

export async function pickSavePath(defaultPath, filters = MD_FILTERS) {
  return saveDialog({ defaultPath, filters });
}

export async function pickExportPath(defaultPath, filters) {
  return saveDialog({ defaultPath, filters });
}

export async function confirmDialog(text, { title = 'FeatherMark', kind = 'warning' } = {}) {
  return showAsk(text, { title, kind });
}

export async function alertDialog(text, { title = 'FeatherMark', kind = 'info' } = {}) {
  return showMessage(text, { title, kind });
}

/* ------------------------------------------------------------------ 错误映射 */
const ERROR_TEXT = {
  E_NOT_FOUND: '文件不存在或已被移动',
  E_PERMISSION: '没有访问权限',
  E_LOCKED: '文件被其他程序占用',
  E_IO: '读写失败',
};

/** 把 Rust 侧的结构化错误（JSON 字符串）翻译成一句人话。 */
export function describeError(err) {
  const raw = typeof err === 'string' ? err : err && err.message ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw);
    const code = {
      NotFound: 'E_NOT_FOUND',
      PermissionDenied: 'E_PERMISSION',
      Locked: 'E_LOCKED',
      Io: 'E_IO',
    }[parsed.kind];
    if (code) {
      const base = ERROR_TEXT[code];
      return parsed.path ? `${base}：${parsed.path}` : base;
    }
    return parsed.message || raw;
  } catch (_) {
    return raw;
  }
}
