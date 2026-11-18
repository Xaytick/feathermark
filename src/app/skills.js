// Agent 技能：WorkBuddy 风格的 SKILL.md（YAML frontmatter + Markdown 正文）。
// 技能在 FeatherMark 里是「可复用的 prompt 片段」，不含脚本；正文即注入 system prompt 的内容。
// 单一数据源：localStorage，chat.js 只通过这里读写，不直接碰存储。

const STORAGE_KEY = 'feathermark.agent.skills.v2';
const LEGACY_KEY = 'feathermark.agent.skills.v1'; // 旧结构是 { [id]: boolean } 开关表，无技能内容

export const MAX_SKILLS = 60;
export const MAX_NAME = 40;
export const MAX_DESC = 120;
export const MAX_PROMPT = 6000;

function load(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function save(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (_) {
    return false;
  }
}

const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** 解析 frontmatter：只取 name / description，其余键忽略；正文即 prompt。 */
function parseFrontmatter(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const meta = {};
  let body = src;
  if (src.startsWith('---')) {
    const end = src.indexOf('\n---', 3);
    if (end > 0) {
      const head = src.slice(4, end);
      body = src.slice(end + 4).replace(/^\n/, '');
      head.split('\n').forEach((line) => {
        const m = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
        if (!m) return;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        meta[m[1].toLowerCase()] = v;
      });
    }
  }
  return { meta, body: body.trim() };
}

/** 校验并规范化技能字段。返回 { ok, skill?, error? } */
function normalize({ name, description, prompt }, id) {
  const n = String(name == null ? '' : name).trim();
  const d = String(description == null ? '' : description).trim();
  const p = String(prompt == null ? '' : prompt).trim();
  if (!n) return { ok: false, error: '技能名称不能为空' };
  if (n.length > MAX_NAME) return { ok: false, error: `名称不能超过 ${MAX_NAME} 字` };
  if (d.length > MAX_DESC) return { ok: false, error: `描述不能超过 ${MAX_DESC} 字` };
  if (!p) return { ok: false, error: '技能正文（prompt）不能为空' };
  if (p.length > MAX_PROMPT) return { ok: false, error: `正文不能超过 ${MAX_PROMPT} 字` };
  return { ok: true, skill: { id: id || uid(), name: n, description: d, prompt: p } };
}

/** 把 SKILL.md 文本解析成技能对象（不落库）。 */
export function parseSkillMarkdown(text) {
  const { meta, body } = parseFrontmatter(text);
  // 有 frontmatter 但没写 name 时，回落到正文首个标题，方便直接贴裸 Markdown
  let name = meta.name || meta.display_name || '';
  if (!name) {
    const h = body.match(/^#\s+(.+)$/m);
    if (h) name = h[1].trim();
  }
  return normalize({ name, description: meta.description || meta.desc || '', prompt: body });
}

/** 导出为 SKILL.md 文本。 */
export function toSkillMarkdown(skill) {
  const q = (s) => String(s || '').replace(/"/g, '\\"');
  return `---\nname: "${q(skill.name)}"\ndescription: "${q(skill.description)}"\n---\n\n${skill.prompt}\n`;
}

/** 读取全部技能（含旧结构迁移：旧 v1 只存了内置技能的开关，丢弃即可）。 */
export function listSkills() {
  const stored = load(STORAGE_KEY);
  if (Array.isArray(stored)) return stored;
  // 首次升级：旧键是布尔开关表，没有用户技能内容，直接初始化为空
  const legacy = load(LEGACY_KEY);
  if (legacy && typeof legacy === 'object') {
    save([]);
    try { localStorage.removeItem(LEGACY_KEY); } catch (_) {}
  }
  return [];
}

export function getSkill(id) {
  return listSkills().find((s) => s.id === id) || null;
}

/** 新建或更新技能：有 id 则更新，无 id 则新建。 */
export function upsertSkill(data, id) {
  const r = normalize(data, id);
  if (!r.ok) return r;
  const all = listSkills();
  const idx = r.skill.id && all.findIndex((s) => s.id === r.skill.id);
  // 同名检查（排除自身）
  if (all.some((s) => s.name === r.skill.name && s.id !== r.skill.id)) {
    return { ok: false, error: '已有同名技能，请换一个名称' };
  }
  if (idx >= 0) all[idx] = r.skill;
  else {
    if (all.length >= MAX_SKILLS) return { ok: false, error: `最多保存 ${MAX_SKILLS} 个技能` };
    all.unshift(r.skill);
  }
  if (!save(all)) return { ok: false, error: '保存失败：本地存储不可用' };
  return { ok: true, skill: r.skill };
}

export function deleteSkill(id) {
  save(listSkills().filter((s) => s.id !== id));
}
