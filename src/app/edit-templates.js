import { t as tr } from './i18n.js';
// 编辑模板：AI 编辑能力的唯一清单。
//
// 一个模板 = 约束提示词 + 可配置参数。Agent 面板、状态栏 ⌘J、聊天模板都从这里取，
// 避免「同一件事在两处各写一遍」。新增编辑能力只需在这里加一条。

/**
 * @typedef {{key:string,label:string,type:'text'|'textarea'|'select',
 *            placeholder?:string,options?:string[],default?:string,
 *            required?:boolean,hint?:string}} ParamSpec
 * @typedef {{id:string,label:string,hint:string,prompt:string,
 *            params:ParamSpec[]}} EditTemplate
 */

/** @type {EditTemplate[]} */
export const EDIT_TEMPLATES = [
  {
    id: 'polish',
    label: tr('tpl.polish'),
    hint: tr('tpl.polishHint'),
    prompt:
      '在不改变事实、结构与信息量的前提下润色文字：去掉啰嗦和生硬的表达，让句子更通顺自然。不要新增内容，不要删掉要点。',
    params: [{ key: 'instruction', label: tr('tpl.extra'), type: 'textarea', placeholder: tr('tpl.academicTone'), hint: tr('optional') }],
  },
  {
    id: 'concise',
    label: tr('tpl.concise'),
    hint: tr('tpl.conciseHint'),
    prompt:
      '压缩冗余：删除重复表述、口水话、没有信息量的过渡句，保留全部关键信息、结论和例子。宁可短，也不要漏。',
    params: [{ key: 'instruction', label: tr('tpl.extra'), type: 'textarea', placeholder: tr('tpl.keepData'), hint: tr('optional') }],
  },
  {
    id: 'expand',
    label: tr('tpl.expand'),
    hint: tr('tpl.expandHint'),
    prompt:
      '在原有骨架上补充细节、必要的过渡和具体例子，让表达更完整。严禁编造事实、数据、引用或链接。',
    params: [{ key: 'instruction', label: tr('tpl.extra'), type: 'textarea', placeholder: tr('tpl.eachExample'), hint: tr('optional') }],
  },
  {
    id: 'layout',
    label: tr('tpl.layout'),
    hint: tr('tpl.layoutHint'),
    prompt:
      '只调整 Markdown 排版，一个字都不要改：规范标题层级（不跳级）、统一列表符号与缩进、调整段落空行、表格对齐、给代码块补语言标注、修正引用块与分割线格式。原文的错别字也不要改。',
    params: [],
  },
  {
    id: 'proof',
    label: tr('tpl.proof'),
    hint: tr('tpl.proofHint'),
    prompt:
      '只修正错别字、标点误用和明显的语病，保持原文的行文风格与用词习惯，不要重写句子，不要润色。',
    params: [{ key: 'instruction', label: tr('tpl.extra'), type: 'textarea', placeholder: tr('tpl.onlySure'), hint: tr('optional') }],
  },
  {
    id: 'translate',
    label: tr('tpl.translate'),
    hint: tr('tpl.translateHint'),
    prompt:
      '自动判断翻译方向：原文以中文为主就译成英文，原文以英文为主就译成中文；中英混排时以正文主要语言为准，界面里出现的专有名词保留原文。译文要自然、符合技术写作习惯。保留全部 Markdown 结构、链接、图片、代码块、行内代码、术语与专有名词原样不变，不要翻译代码和 URL。',
    params: [
      {
        key: 'direction',
        label: tr('tpl.direction'),
        type: 'select',
        options: [
          { value: '自动互译', label: tr('tpl.auto') },
          { value: '中文 → 英文', label: tr('tpl.zh2en') },
          { value: '英文 → 中文', label: tr('tpl.en2zh') },
        ],
        default: '自动互译',
      },
      { key: 'instruction', label: tr('tpl.extra'), type: 'textarea', placeholder: tr('tpl.termsUnchanged'), hint: tr('optional') },
    ],
  },
  {
    id: 'custom',
    label: tr('tpl.custom'),
    hint: tr('tpl.customHint'),
    prompt: '',
    params: [
      {
        key: 'instruction',
        label: tr('tpl.requirement'),
        type: 'textarea',
        placeholder: tr('tpl.requirementPlaceholder'),
        required: true,
        hint: tr('required'),
      },
    ],
  },
];

export function templateById(id) {
  return EDIT_TEMPLATES.find((t) => t.id === id) || EDIT_TEMPLATES[0];
}

export function defaultParams(template) {
  const out = {};
  for (const p of template.params || []) out[p.key] = p.default || '';
  return out;
}

/** 把模板约束与用户参数合成 agent.js 需要的 task 文本。 */
export function buildEditTask(template, params = {}) {
  let task = template.prompt || '';

  if (template.id === 'translate') {
    const dir = params.direction || '自动互译';
    if (dir === '中文 → 英文') {
      task = '把原文统一翻译成英文。保留全部 Markdown 结构、链接、图片、代码块、行内代码、术语与专有名词原样不变，不要翻译代码和 URL。';
    } else if (dir === '英文 → 中文') {
      task = '把原文统一翻译成简体中文。保留全部 Markdown 结构、链接、图片、代码块、行内代码、术语与专有名词原样不变，不要翻译代码和 URL。';
    }
  }

  const extra = String(params.instruction || '').trim();
  if (extra) task = task ? `${task}\n补充要求：${extra}` : extra;
  return task;
}
