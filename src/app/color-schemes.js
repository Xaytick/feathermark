// 自定义配色方案：RGB/hex 批量解析、校验、持久化。
// 单一数据源，设置页导入后保存、主题应用时读取，都走这里。

const STORAGE_KEY = 'feathermark.color-schemes.v1';
const HEX6 = /^#?([0-9a-f]{6})$/i;
const HEX3 = /^#?([0-9a-f]{3})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+\s*)?\)$/i;
const TRIPLE = /^(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})$/;
const TRIPLE_SHAPE = /^\d{1,3}\s*[, ]\s*\d{1,3}\s*[, ]\s*\d{1,3}$/;
const RGB_SHAPE = /^rgba?\(/i;

/** 解析单行输入，成功返回 { hex, r, g, b }，失败返回 { error }。 */
export function parseColor(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { error: '空值' };

  let m = s.match(HEX6);
  if (m) return toResult(parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16));

  m = s.match(HEX3);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return toResult(r, g, b);
  }

  m = s.match(RGB);
  if (m) return toResult(+m[1], +m[2], +m[3]);

  m = s.match(TRIPLE);
  if (m) return toResult(+m[1], +m[2], +m[3]);

  return { error: `无法识别：「${s}」` };
}

function toResult(r, g, b) {
  if (![r, g, b].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return { error: `RGB 分量须为 0–255 的整数（收到 ${r}, ${g}, ${b}）` };
  }
  const hex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { hex, r, g, b };
}

/**
 * 批量解析：支持换行、逗号、分号、制表符或空格分隔的一组颜色。
 * 同一 token 内允许 `rgb(1, 2, 3)` 这类自带空格/逗号的写法。
 * 返回 { colors: [{raw, hex, r, g, b}], errors: [{raw, error}], total }。
 */
export function parseColors(text) {
  const str = String(text == null ? '' : text);
  // 用分号与换行作为硬分隔；逗号仅在「不在 rgb() 括号内」时作为分隔
  const tokens = [];
  str.split(/[\n;]+/).forEach((line) => {
    const seg = line.trim();
    if (!seg) return;
    // 单一颜色结构（rgb(...) 或 数字三元组）整体解析，避免越界值被拆散后误判成 hex
    if (RGB_SHAPE.test(seg) || TRIPLE_SHAPE.test(seg)) {
      tokens.push(seg);
    } else if (!parseColor(seg).error) {
      tokens.push(seg);
    } else {
      splitTopLevel(line).forEach((t) => { if (t.trim()) tokens.push(t); });
    }
  });

  const colors = [];
  const errors = [];
  tokens.forEach((raw) => {
    const r = parseColor(raw);
    if (r.error) errors.push({ raw: raw.trim(), error: r.error });
    else colors.push({ raw: raw.trim(), hex: r.hex, r: r.r, g: r.g, b: r.b });
  });
  return { colors, errors, total: tokens.length };
}

/** 在 rgb() 之外的地方按逗号/空格切分，保留括号内的分隔符。 */
function splitTopLevel(line) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of line) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || ch === '\t' || ch === ' ')) {
      if (buf.trim()) out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** 从主色派生 hover 与 soft（强调色套装），供主题应用使用。 */
export function deriveAccent(hex) {
  const r = parseColor(hex);
  if (r.error) return null;
  const mix = (c) => Math.round(c * 0.82);
  return {
    accent: r.hex,
    hover: rgbHex(mix(r.r), mix(r.g), mix(r.b)),
    soft: `rgba(${r.r}, ${r.g}, ${r.b}, 0.14)`,
  };
}

function rgbHex(r, g, b) {
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function readAll() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (_) {
    return false;
  }
}

export function listSchemes() {
  return readAll();
}

export function getScheme(id) {
  return readAll().find((s) => s.id === id) || null;
}

/**
 * 保存配色。colors 为 [{hex, r, g, b}] 或 hex 字符串数组。
 * 返回 { ok, scheme?, error? }；不合法时拒绝写入。
 */
export function saveScheme(name, colors, params) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) return { ok: false, error: '请填写配色名称' };

  const clean = [];
  for (const c of colors || []) {
    const hex = typeof c === 'string' ? c : c && c.hex;
    const r = parseColor(hex);
    if (r.error) return { ok: false, error: `配色含无效颜色，无法保存：${r.error}` };
    clean.push({ hex: r.hex, r: r.r, g: r.g, b: r.b });
  }
  if (!clean.length) return { ok: false, error: '没有可保存的颜色' };
  if (clean.length > 24) return { ok: false, error: '单个配色最多保存 24 个颜色' };
  if (trimmed.length > 40) return { ok: false, error: '配色名称不能超过 40 个字符' };

  const all = readAll();
  if (all.some((s) => s.name === trimmed)) return { ok: false, error: '同名配色已存在，请换一个名称' };

  const scheme = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: trimmed,
    colors: clean,
    params: params ? JSON.parse(JSON.stringify(params)) : null, // 保存时绑定当前主题外观参数
    createdAt: Date.now(),
  };
  if (!writeAll([...all, scheme])) return { ok: false, error: '保存失败：本地存储不可用' };
  return { ok: true, scheme };
}

export function deleteScheme(id) {
  writeAll(readAll().filter((s) => s.id !== id));
}

/**
 * 重命名配色。返回 { ok, scheme?, error? }。
 * 规则与 saveScheme 一致：非空、≤40 字符、不与其它配色重名。
 */
export function renameScheme(id, newName) {
  const trimmed = String(newName == null ? '' : newName).trim();
  if (!trimmed) return { ok: false, error: '请填写配色名称' };
  if (trimmed.length > 40) return { ok: false, error: '配色名称不能超过 40 个字符' };
  const all = readAll();
  const target = all.find((s) => s.id === id);
  if (!target) return { ok: false, error: '配色不存在，可能已被删除' };
  if (target.name === trimmed) return { ok: true, scheme: target }; // 没改名，视为成功
  if (all.some((s) => s.id !== id && s.name === trimmed)) return { ok: false, error: '同名配色已存在，请换一个名称' };
  target.name = trimmed;
  if (!writeAll(all)) return { ok: false, error: '重命名失败：本地存储不可用' };
  return { ok: true, scheme: target };
}

/** 导出配色为可序列化对象（含版本标记，便于后续导入）。 */
export function exportScheme(id) {
  const scheme = getScheme(id);
  if (!scheme) return null;
  return {
    app: 'FeatherMark',
    type: 'color-scheme',
    version: 1,
    name: scheme.name,
    colors: scheme.colors,
    params: scheme.params || null,
    exportedAt: new Date().toISOString(),
  };
}
