// 已配置模型清单：聊天输入框下方的模型选择器与设置页共用。
// 只存模型 ID；接口地址、密钥和额外参数仍由设置页统一管理，避免密钥散落。

const KEY = 'feathermark.ai.models.v1';
let models = null;
const listeners = new Set();

function ensure() {
  if (models) return models;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    models = Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string' && m.trim()) : [];
  } catch (_) {
    models = [];
  }
  return models;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(models));
  } catch (_) {}
  listeners.forEach((fn) => {
    try { fn(getModels()); } catch (_) {}
  });
}

export function getModels() {
  return [...ensure()];
}

export function addModel(name) {
  const clean = String(name || '').trim();
  if (!clean) return false;
  const list = ensure();
  if (!list.includes(clean)) {
    list.push(clean);
    persist();
    return true;
  }
  return false;
}

export function removeModel(name) {
  const list = ensure();
  const idx = list.indexOf(String(name || '').trim());
  if (idx < 0) return false;
  list.splice(idx, 1);
  persist();
  return true;
}

export function syncModelsFromConfig(model) {
  addModel(model);
  return getModels();
}

export function onModelsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
