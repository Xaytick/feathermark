// Agent 会话侧边栏：与编辑器共享当前文档上下文，但自己管理会话、消息和附件。
//
// 设计取舍：
// - 会话存 localStorage（按工作区隔离），不新建数据库；离线可用、重启可恢复。
// - 附件不把二进制塞进 localStorage：图片默认只给路径（省 token），可切到多模态模式
//   把图片以 data URL 随请求发送（需服务商支持 vision）；文本文件读前若干字符作摘要。
// - AI 请求复用 ipc.aiChat（密钥仍只在 Rust 侧），失败不静默重试，直接显示可操作错误。
import { listen } from '@tauri-apps/api/event';
import * as ipc from './ipc.js';
import { prefs, savePrefs } from './store.js';
import { showMenu, toast, promptDialog } from './ui.js';
import { EDIT_TEMPLATES } from './edit-templates.js';
import { createAgentEdit } from './agent-edit.js';
import { buildDiffView } from './diff-view.js';
import { getModels, onModelsChange } from './model-list.js';
import { parseEdits, applyEdits, fencesBalanced, contentSignature } from './agent.js';
import { extractCitations, linkCitationMarks } from './citations.js';
import { estimateTokens, outputBudget, selectHistory } from './token-budget.js';
import { t as tr } from './i18n.js';
import { listSkills, getSkill, upsertSkill, deleteSkill, parseSkillMarkdown, toSkillMarkdown, skillVariables, fillSkillVariables, MAX_SKILLS } from './skills.js';

const SESSION_KEY = 'feathermark.agent.sessions.v1';
const MAX_TEXT_ATTACH = 4000;
const MAX_SESSIONS = 30;          // 每个工作区的会话上限
const MAX_SESSIONS_TOTAL = 120;   // 所有工作区合计的硬上限（防 localStorage 撑爆）
const MAX_MESSAGES = 50;
const MAX_CONTEXT = 6000;
const TEXT_ATTACH_RE = /\.(md|markdown|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|css|html|htm|xml|csv|log|ini|conf|toml|sql|sh|py|rs|go|java|c|h|cpp|hpp|rb|php|swift|kt|scala|vue|svelte)$/i;

// 聊天用问题模板。会修改文档的编辑能力统一放在 EDIT_TEMPLATES，避免重复入口。
// 编辑器自我认知：注入 system prompt，让 Agent 知道这个编辑器支持什么、文档有什么约定。
// 只保留「影响回答正确性」的事实（约 400 字），不写营销性描述，避免白白占用上下文预算。
const EDITOR_KNOWLEDGE = [
  '【编辑器环境】',
  'FeatherMark 是本地 Markdown 编辑器（Tauri + CodeMirror 6 + remark 渲染管线）。Markdown 源码是唯一真相，预览由源码实时渲染。',
  '支持的语法：',
  '- 标准 Markdown + GFM：表格、任务列表 - [ ]、删除线 ~~x~~、自动链接、有序/无序列表',
  '- 数学：行内 $...$、块级 $$...$$（KaTeX 渲染）',
  '- 图表：```mermaid 围栏代码块',
  '- 提示块：> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]，可接自定义标题',
  '- 脚注 [^1]、定义列表（定义行以 ": " 开头）',
  '- 围栏代码块按语言高亮（highlight.js）',
  '文档约定：',
  '- 图片写作 ![说明](assets/文件名.png)；本地图片存放在当前文档同目录的 assets/ 下',
  '- 界面有源码 / 分屏 / 预览三种视图，预览模式是所见即所得：直接在渲染结果上改字，格式保留、实时同步回 Markdown 源码；导出支持单文件 HTML、长图 PNG、PDF',
  '【界面功能与设置路径】（用户问「怎么设置 XX」时据此回答，不要说没有此功能或让用户改配置文件）：',
  '- 设置弹窗左侧导航分四区：外观（主题 · 配色）、编辑器（字体 · 编辑）、AI（模型 · 接口）、关于（版本 · 快捷键）',
  '- 外观 → 主题：6 套内置主题与自定义主题以卡片展示，点选即换整套配色和明暗',
  '- 外观 → 主题 → 当前主题的外观：每个主题各自绑定一套参数——背景画布（纯色/点阵/网格/稿纸/纸纹）与纹理强度、',
  '  背景图片（「选择图片」选取，自动压缩存本地；「清除」移除）、图片透明度、图片模糊度、填充方式（铺满/适应/平铺）、',
  '  行高、字距、正文宽度、光标宽度、当前行高亮。切换主题时这些参数一起切换',
  '- 外观 → 主题 → 新建主题：粘贴 hex / RGB 颜色或让 AI 生成，命名保存后成为一个自定义主题卡片',
  '- 编辑器 → 字体可设编辑器/预览/代码三处字体字号；编辑器 → 编辑可设自动换行、行号、自动配对、软换行',
  '- AI 分区配置接口地址、密钥、模型与额外参数；明暗由主题决定，标题栏按钮可快速切换明暗主题',
  '【改动文档的约定】',
  '- 行号必须严格取自「带行号的原文」，不要自行推算或重排',
  '- 多条指令的先后顺序随意：编辑器会从文档末尾往前依次应用，不会互相影响行号',
  '- 保留原文的缩进、列表符号与空行风格；只输出需要改动的行',
  '- 代码围栏必须成对（``` 开闭各一个），否则后续内容会被当成代码',
].join('\n');

const TEMPLATES = [
  { label: tr('tpl.explain'), prompt: '请解释当前代码块的作用、关键步骤和注意事项。如果有多段代码，优先解释光标附近的代码。' },
  { label: tr('tpl.outline'), prompt: '请基于当前文档生成一份简洁的大纲，并标出各章节之间的关系。' },
  { label: tr('tpl.findIssues'), prompt: '请检查当前文档，指出错别字、语病、逻辑跳跃、事实存疑和结构问题，按严重程度排序。' },
  { label: tr('tpl.continue'), prompt: '请根据当前文档的风格和结构，续写下一节内容，不要重复已有结论。' },
];

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || '') || fallback;
  } catch (_) {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}
const uid = () => 'c' + Math.random().toString(36).slice(2, 9);
const imageMime = (path) => ({ jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp', svg: 'svg+xml' }[
  (path.split('.').pop() || 'png').toLowerCase()
] || 'png');
const shortTime = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export function createChat({ editor, getContext, getWorkspace, openSettings, onLayoutChange, onVersionRecorded }) {
  const $ = (id) => document.getElementById(id);
  const panel = $('chat-panel');
  const splitter = $('splitter-chat');
  const sessionsEl = $('chat-sessions');
  const messagesEl = $('chat-messages');
  const emptyEl = $('chat-empty');
  const inputEl = $('chat-input');
  const attachmentsEl = $('chat-attachments');
  const contextBtn = $('chat-context-btn');
  const skillChip = $('chat-skill-chip');
  const webBtn = $('chat-web-btn');
  const sendBtn = $('chat-send');
  const hintEl = $('chat-hint');
  const modelSel = $('chat-model');
  const applyDialog = $('apply-dialog');
  const applyScopeEl = $('apply-scope');
  const applyDiffEl = $('apply-diff');
  const applyMetaEl = $('apply-meta');
  const btnApplyAccept = $('apply-accept');
  const btnApplyAll = $('apply-all');
  const applyWarningEl = $('apply-warning');

  // Agent 编辑模板流程由 Agent 模块统一持有；状态栏、快捷键、菜单都通过本模块调用。
  const agentEdit = createAgentEdit({ editor, onNeedConfig: openSettings, onVersionRecorded });

  let allSessions = load(SESSION_KEY, []);
  let activeId = null;
  let attachments = [];
  // 上下文模式：doc=整篇文档 | selection=仅选区 | off=不带文档（附件仍发送）
  const CONTEXT_MODE_KEY = 'feathermark.agent.context-mode.v1';
  let contextMode = load(CONTEXT_MODE_KEY, 'doc');
  if (!['doc', 'selection', 'off'].includes(contextMode)) contextMode = 'doc';
  // 联网搜索开关（写作/查证事实时让模型联网并标注来源）
  const WEB_SEARCH_KEY = 'feathermark.agent.web-search.v1';
  let webSearch = !!load(WEB_SEARCH_KEY, false);
  // 输入历史（按工作区隔离，↑/↓ 召回）
  const INPUT_HISTORY_KEY = 'feathermark.agent.input-history.v1';
  let inputHistory = load(INPUT_HISTORY_KEY, []) || [];
  let historyCursor = -1;
  function pushInputHistory(text) {
    const t = String(text || '').trim();
    if (!t || inputHistory[inputHistory.length - 1] === t) return;
    inputHistory.push(t);
    if (inputHistory.length > 60) inputHistory = inputHistory.slice(-60);
    save(INPUT_HISTORY_KEY, inputHistory);
  }
  function historyPrev() {
    if (!inputHistory.length) return null;
    if (historyCursor < 0) historyCursor = inputHistory.length;
    if (historyCursor > 0) historyCursor--;
    return inputHistory[historyCursor] ?? null;
  }
  function historyNext() {
    if (historyCursor < 0 || historyCursor >= inputHistory.length - 1) { historyCursor = -1; return null; }
    historyCursor++;
    return inputHistory[historyCursor] ?? null;
  }
  let busy = false;
  let dropDepth = 0;
  let applyView = null;
  let applyScope = null;
  let applyMsg = null;
  let applyErrors = [];
  let streamRequestId = null;
  let lastLimitToast = 0;
  let activeModel = '';

  // 持续启用的技能（chip 切换，可多个，持久化）与单次引用（斜杠命令）分开持有
  const PINNED_SKILLS_KEY = 'feathermark.agent.pinned-skills.v1';
  let pinnedSkillIds = load(PINNED_SKILLS_KEY, []) || [];
  if (!Array.isArray(pinnedSkillIds)) pinnedSkillIds = [];
  let pinnedSkillId = pinnedSkillIds[0] || null; // 兼容旧逻辑：首个固定的技能
  let onceSkillId = null;
  function savePinnedSkills() {
    pinnedSkillId = pinnedSkillIds[0] || null;
    save(PINNED_SKILLS_KEY, pinnedSkillIds);
  }
  const workspace = () => getWorkspace() || '__global__';
  const sessions = () => allSessions.filter((s) => s.workspace === workspace());
  const active = () => allSessions.find((s) => s.id === activeId) || null;

  function enforceSessionLimits() {
    let dropped = false;
    // 按工作区分别限额：旧实现全局截断，一个工作区会话多时会把别的工作区的会话删掉。
    const groups = new Map();
    for (const s of allSessions) {
      const ws = s.workspace || '__global__';
      if (!groups.has(ws)) groups.set(ws, []);
      groups.get(ws).push(s);
    }
    const kept = [];
    for (const [ws, list] of groups) {
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (list.length > MAX_SESSIONS) dropped = true;
      // 当前工作区优先保留；其余工作区各留 MAX_SESSIONS 个
      for (const s of list.slice(0, MAX_SESSIONS)) kept.push(s);
    }
    // 全局硬上限：按更新时间保留最近的
    if (kept.length > MAX_SESSIONS_TOTAL) {
      dropped = true;
      kept.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      kept.length = MAX_SESSIONS_TOTAL;
    }
    allSessions = kept;
    for (const s of allSessions) {
      if (s.messages && s.messages.length > MAX_MESSAGES) {
        s.messages = s.messages.slice(-MAX_MESSAGES);
        dropped = true;
      }
    }
    return dropped;
  }

  function persist() {
    const dropped = enforceSessionLimits();
    save(SESSION_KEY, allSessions);
    if (dropped && Date.now() - lastLimitToast > 4000) {
      lastLimitToast = Date.now();
      toast(tr('chat.trimmed', { n: MAX_SESSIONS, m: MAX_MESSAGES }), { duration: 3200 });
    }
  }

  function titleFrom(text) {
    const first = String(text || '').trim().split('\n')[0].replace(/^#+\s*/, '');
    return (first || tr('chat.newSession')).slice(0, 24);
  }

  function newSession() {
    const s = {
      id: uid(),
      workspace: workspace(),
      title: tr('chat.newSession'),
      updatedAt: Date.now(),
      messages: [],
    };
    allSessions.unshift(s);
    activeId = s.id;
    persist();
    renderSessions();
    renderMessages();
    inputEl.focus();
    return s;
  }

  function ensureSession() {
    if (active()) return active();
    const list = sessions();
    if (list.length) {
      activeId = list[0].id;
      return active();
    }
    return newSession();
  }

  function deleteSession(id) {
    allSessions = allSessions.filter((s) => s.id !== id);
    if (activeId === id) activeId = sessions()[0] ? sessions()[0].id : null;
    persist();
    renderSessions();
    renderMessages();
  }

  let sessionFilter = '';
  function renderSessions() {
    sessionsEl.innerHTML = '';
    let list = sessions().slice();
    if (sessionFilter) {
      const q = sessionFilter.toLowerCase();
      list = list.filter((s) => String(s.title || '').toLowerCase().includes(q) ||
        (s.messages || []).some((m) => String(m.content || '').toLowerCase().includes(q)));
    }
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
    if (!list.length) {
      sessionsEl.innerHTML = '<div class="tree-empty">' + (sessionFilter ? tr('chat.noSessionMatch') : tr('chat.noSessions')) + '</div>';
      return;
    }
    for (const s of list) {
      const row = document.createElement('div');
      row.className = 'chat-session-item' + (s.id === activeId ? ' active' : '');
      row.title = s.title;
      const title = document.createElement('span');
      title.className = 'cs-title';
      title.textContent = (s.pinned ? '📌 ' : '') + s.title;
      const time = document.createElement('span');
      time.className = 'cs-time';
      time.textContent = shortTime(s.updatedAt);
      const del = document.createElement('button');
      del.className = 'cs-del mini-btn';
      del.title = tr('chat.delSession');
      del.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-trash" /></svg>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(s.id);
      });
      row.addEventListener('dblclick', async () => {
        const name = await promptDialog({ title: tr('chat.renameSession'), value: s.title });
        if (name) {
          s.title = name;
          persist();
          renderSessions();
        }
      });
      row.addEventListener('click', () => {
        activeId = s.id;
        renderSessions();
        renderMessages();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(row, [
          { label: s.pinned ? tr('chat.unpin') : tr('chat.pin'), onClick: () => {
            s.pinned = !s.pinned;
            persist();
            renderSessions();
          } },
          { label: tr('chat.renameSession'), onClick: async () => {
            const name = await promptDialog({ title: tr('chat.renameSession'), value: s.title });
            if (name) { s.title = name; persist(); renderSessions(); }
          } },
        ]);
      });
      row.append(title, time, del);
      sessionsEl.appendChild(row);
    }
  }

function numberedLines(lines, startNo) {
  return lines.map((l, i) => `${startNo + i}|${l}`).join('\n');
}

  function addCodeCopyButtons(container) {
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.type = 'button';
      btn.textContent = tr('copy');
      btn.addEventListener('click', async () => {
        const code = pre.querySelector('code');
        const clone = (code || pre).cloneNode(true);
        clone.querySelectorAll('.code-lang, .code-copy').forEach((n) => n.remove());
        let text = clone.textContent || '';
        // 部分渲染器会把围栏和语言标记留在 code 文本里，复制时统一剥掉
        text = text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
        try {
          await navigator.clipboard.writeText(text);
          toast(tr('chat.codeCopied'));
        } catch (_) {
          toast(tr('copyFailed'), { error: true });
        }
      });
      pre.appendChild(btn);
    });
  }

  function messageNode(msg) {
    const wrap = document.createElement('div');
    wrap.className = `chat-msg ${msg.role}` + (msg.status === 'error' ? ' error' : '');

    const head = document.createElement('div');
    head.className = 'chat-msg-head';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.role === 'user' ? tr('chat.you') : msg.role === 'assistant' ? 'Agent' : tr('chat.system');
    const time = document.createElement('span');
    time.textContent = shortTime(msg.ts || Date.now());
    const status = document.createElement('span');
    status.className = 'status' + (msg.status === 'error' ? ' error' : '');
    if (msg.status === 'sending') status.innerHTML = '<span class="chat-loading"><i></i><i></i><i></i></span>';
    else if (msg.status === 'searching') status.textContent = tr('chat.searching');
    else if (msg.status === 'thinking') status.textContent = tr('chat.thinking');
    else if (msg.status === 'streaming') status.textContent = tr('chat.streaming');
    else if (msg.status === 'stopped') status.textContent = tr('chat.stopped');
    else if (msg.status === 'error') status.textContent = tr('chat.failed');
    else if (msg.role === 'user' && msg.status === 'sent') status.textContent = tr('chat.sent');
    head.append(who, time, status);
    if (msg.role === 'assistant' && msg.searchState === 'failed') {
      const tag = document.createElement('span');
      tag.className = 'chat-search-tag failed';
      tag.textContent = tr('chat.searchFailedTag');
      tag.title = msg.searchError || '';
      head.appendChild(tag);
    } else if (msg.role === 'assistant' && msg.searchState === 'ok' && msg.citations && msg.citations.length) {
      const tag = document.createElement('span');
      tag.className = 'chat-search-tag';
      tag.textContent = tr('chat.searchedTag', { n: msg.citations.length });
      head.appendChild(tag);
    }

    const body = document.createElement('div');
    body.className = 'chat-msg-body';
    if (msg.status === 'searching') {
      body.innerHTML = '<span class="chat-loading"><i></i><i></i><i></i></span> ' + tr('chat.searchingEllipsis');
    } else if (msg.status === 'thinking') {
      body.textContent = tr('chat.thinkingEllipsis');
    } else if (msg.status === 'streaming') {
      // 流式也走 markdown（同步部分），让代码块/列表在生成过程中可读；
      // 异步的公式/Mermaid 留到终态再渲染，避免每个 chunk 重跑。
      if (msg.role === 'assistant' && window.UnifiedRenderer) {
        try {
          body.classList.add('markdown-body');
          body.innerHTML = window.UnifiedRenderer.renderMarkdown(msg.content || '', { softBreaks: false });
          const cursor = document.createElement('span');
          cursor.className = 'stream-cursor';
          cursor.textContent = '▌';
          body.appendChild(cursor);
        } catch (_) {
          body.textContent = (msg.content || '') + ' ▌';
        }
      } else {
        body.textContent = (msg.content || '') + ' ▌';
      }
    } else if (msg.content) {
      if (msg.role === 'assistant' && window.UnifiedRenderer) {
        try {
          body.classList.add('markdown-body');
          body.innerHTML = window.UnifiedRenderer.renderMarkdown(msg.content, { softBreaks: false });
          if (msg.role === 'assistant' && editor && editor.postProcess) {
            try { editor.postProcess(body); } catch (_) {}
          }
        } catch (_) {
          body.textContent = msg.content;
        }
      } else {
        body.textContent = msg.content;
      }
      if (msg.role === 'assistant') addCodeCopyButtons(body);
    } else if (msg.status === 'sending') {
      body.innerHTML = '<span class="chat-loading"><i></i><i></i><i></i></span> ' + tr('chat.thinkingEllipsis');
    }

    if (msg.attachments && msg.attachments.length) {
      const box = document.createElement('div');
      box.className = 'chat-attachments';
      for (const a of msg.attachments) {
        const item = document.createElement('div');
        item.className = 'chat-attach';
        if (a.isImage && a.preview) {
          const img = document.createElement('img');
          img.src = a.preview;
          item.appendChild(img);
        } else {
          const icon = document.createElement('span');
          icon.className = 'ca-icon';
          icon.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-file" /></svg>';
          item.appendChild(icon);
        }
        const name = document.createElement('span');
        name.className = 'ca-name';
        name.textContent = a.name;
        item.appendChild(name);
        box.appendChild(item);
      }
      body.insertBefore(box, body.firstChild);
    }

    // 联网来源：消息下方展示可点击链接（仅终态、有 citations 时）
    if (msg.role === 'assistant' && msg.status !== 'streaming' && msg.status !== 'searching'
        && msg.citations && msg.citations.length) {
      const src = document.createElement('div');
      src.className = 'chat-sources';
      const label = document.createElement('div');
      label.className = 'chat-sources-label';
      label.textContent = tr('chat.sources');
      src.appendChild(label);
      const list = document.createElement('div');
      list.className = 'chat-sources-list';
      msg.citations.forEach((c, i) => {
        const a = document.createElement('a');
        a.className = 'chat-source';
        a.href = c.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = c.url;
        const idx = document.createElement('span');
        idx.className = 'cs-idx';
        idx.textContent = String(i + 1);
        const ttl = document.createElement('span');
        ttl.className = 'cs-title';
        ttl.textContent = c.title || c.url;
        a.append(idx, ttl);
        list.appendChild(a);
      });
      src.appendChild(list);
      body.appendChild(src);
    }

    wrap.append(head, body);

    if (msg.role === 'user' && !busy && msg.status !== 'error') {
      const actions = document.createElement('div');
      actions.className = 'chat-msg-actions';
      const edit = document.createElement('button');
      edit.textContent = tr('chat.editMessage');
      edit.title = tr('chat.editMessageHint');
      edit.addEventListener('click', () => {
        const s = active();
        if (!s) return;
        const idx = s.messages.indexOf(msg);
        const atts = (msg.attachments || []).map((a) => ({ ...a, status: 'ready' }));
        // 把这条及之后的消息移除，内容回填输入框供用户修改后重发
        s.messages = s.messages.slice(0, idx);
        inputEl.value = msg.content;
        attachments = atts;
        renderAttachments();
        persist();
        renderMessages();
        inputEl.focus();
        updateSendState();
      });
      actions.appendChild(edit);
      wrap.appendChild(actions);
    }

    if (msg.role === 'assistant' && !busy) {
      const actions = document.createElement('div');
      actions.className = 'chat-msg-actions';
      if (msg.patch && msg.patch.length) {
        const diffBtn = document.createElement('button');
        diffBtn.textContent = tr('chat.viewDiff');
        diffBtn.title = tr('chat.viewDiffHint');
        diffBtn.addEventListener('click', () => openApply(msg));
        actions.appendChild(diffBtn);
      }
      const copy = document.createElement('button');
      copy.textContent = tr('copy');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(msg.content);
          toast(tr('copied'));
        } catch (_) {
          toast(tr('copyFailed'), { error: true });
        }
      });
      actions.appendChild(copy);
      const regen = document.createElement('button');
      regen.textContent = tr('chat.regenerate');
      regen.title = tr('chat.regenerateHint');
      regen.addEventListener('click', () => {
        const s = active();
        if (!s || busy) return;
        const idx = s.messages.indexOf(msg);
        const prev = idx > 0 ? s.messages[idx - 1] : null;
        if (!prev || prev.role !== 'user') return;
        // 保留附件，删掉当前 assistant 让用户消息回到待发送态
        const atts = (prev.attachments || []).map((a) => ({ ...a, status: 'ready' }));
        s.messages = s.messages.filter((m) => m !== msg && m !== prev);
        persist();
        renderMessages();
        send(prev.content, atts);
      });
      actions.appendChild(regen);
      wrap.appendChild(actions);
    }

    if (msg.status === 'error') {
      const retry = document.createElement('div');
      retry.className = 'chat-msg-actions';
      const btn = document.createElement('button');
      btn.textContent = tr('chat.retry');
      btn.addEventListener('click', () => {
        const s = active();
        if (!s) return;
        const idx = s.messages.indexOf(msg);
        const last = idx > 0 ? s.messages[idx - 1] : null;
        if (!last || last.role !== 'user') return;
        s.messages = s.messages.filter((m) => m !== msg);
        last.status = 'ready';
        last.attachments = (last.attachments || []).map((a) => ({ ...a, status: 'ready' }));
        persist();
        renderMessages();
        send(last.content, last.attachments);
      });
      retry.appendChild(btn);
      wrap.appendChild(retry);
    }
    return wrap;
  }

  function updateApplyState() {
    if (!applyView) return;
    const total = applyView.changeCount;
    const accepted = applyView.acceptedCount();
    const partial = total > 0 && accepted < total;
    btnApplyAccept.textContent = total ? tr('chat.acceptChanges', { a: accepted, t: total }) : tr('chat.noApply');
    const needsConfirm = !applyWarningEl.classList.contains('hidden') && !!document.getElementById('apply-confirm');
    const confirmed = !needsConfirm || !!document.getElementById('apply-confirm')?.checked;
    btnApplyAccept.disabled = accepted === 0 || !confirmed || applyErrors.length > 0;
    btnApplyAll.classList.toggle('hidden', !partial || applyErrors.length > 0);
    applyMetaEl.textContent = total ? tr('chat.selectedChanges', { a: accepted, t: total }) : tr('chat.noChanges');
  }

  function showApplyWarnings(warnings) {
    if (!warnings.length) {
      applyWarningEl.classList.add('hidden');
      applyWarningEl.innerHTML = '';
      return;
    }
    applyWarningEl.classList.remove('hidden');
    applyWarningEl.innerHTML = '';
    const title = document.createElement('div');
    title.innerHTML = '<strong>' + tr('chat.attention') + '</strong>';
    const detail = document.createElement('div');
    detail.textContent = warnings.join('；') + '。';
    applyWarningEl.append(title, detail);
    if (warnings.some((w) => /截断|不完整|长度上限|围栏不成对|改动了正文文字/.test(w))) {
      const confirm = document.createElement('label');
      confirm.className = 'apply-confirm';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = 'apply-confirm';
      box.addEventListener('change', updateApplyState);
      confirm.appendChild(box);
      confirm.appendChild(document.createTextNode(tr('chat.confirmComplete')));
      applyWarningEl.appendChild(confirm);
    }
  }

  function openApply(msg) {
    if (!msg || !String(msg.content || '').trim()) {
      toast(tr('chat.noApplyContent'), { error: true });
      return;
    }
    const parsed = msg.patch && msg.patch.length ? { edits: msg.patch } : parseEdits(msg.content);
    if (!parsed.edits.length) {
      toast(tr('chat.notEditPatch'), { error: true });
      return;
    }

    const docText = editor.cm.getValue();
    const docLines = docText.split('\n');
    const applied = applyEdits(docLines, parsed.edits, 1);
    applyErrors = applied.errors || [];
    applyMsg = msg;
    applyScope = {
      snapshot: docText,
      from: { line: 0, ch: 0 },
      to: { line: docLines.length - 1, ch: (docLines[docLines.length - 1] || '').length },
    };
    applyScopeEl.textContent = tr('chat.applyScope', { n: docLines.length });

    const newText = applied.lines.join('\n');
    const warnings = [];
    if (applyMsg.finishReason === 'length') warnings.push('模型输出达到长度上限，补丁可能不完整');
    if (applyErrors.length) warnings.push(`补丁有 ${applyErrors.length} 处指令无效：${applyErrors[0]}`);
    if (!fencesBalanced(newText)) warnings.push('补丁应用后代码围栏不成对，预览可能显示异常');
    // 若用户意图是「排版/整理格式」，复用 agent.js 的内容不变式，防止模型偷偷改文字
    if (/(排版|整理格式|统一格式|规范标题)/.test(String(msg.content || '')) &&
        contentSignature(docText) !== contentSignature(newText)) {
      warnings.push('这次是排版整理，但补丁改动了正文文字，请仔细核对');
    }
    showApplyWarnings(warnings);

    applyView = buildDiffView(docText, applied.lines.join('\n'));
    if (applyView.onSelectionChange) applyView.onSelectionChange(updateApplyState);
    applyDiffEl.className = 'ai-diff';
    applyDiffEl.innerHTML = '';
    applyDiffEl.appendChild(applyView.node);
    applyMetaEl.classList.remove('error');
    updateApplyState();
    applyDialog.classList.remove('hidden');
  }

  function closeApply() {
    applyDialog.classList.add('hidden');
    applyView = null;
    applyScope = null;
    applyMsg = null;
    applyErrors = [];
  }

  function acceptApply(mode) {
    if (!applyView || !applyScope) return;
    if (applyErrors.length) {
      applyMetaEl.textContent = tr('chat.invalidPatch');
      applyMetaEl.classList.add('error');
      return;
    }
    if (editor.cm.getValue() !== applyScope.snapshot) {
      applyMetaEl.textContent = tr('chat.docChanged');
      applyMetaEl.classList.add('error');
      return;
    }
    if (!applyWarningEl.classList.contains('hidden') && !document.getElementById('apply-confirm')?.checked) {
      toast(tr('chat.needConfirm'), { error: true });
      return;
    }
    const total = applyView.changeCount;
    const accepted = mode === 'all' ? total : applyView.acceptedCount();
    if (!total || !accepted) {
      toast(tr('chat.noSelected'), { error: true });
      return;
    }
    const next = applyView.compose(mode);
    if (onVersionRecorded) {
      onVersionRecorded({
        afterDoc: next,
        label: tr('chat.applyLabel'),
        meta: { source: 'chat', model: applyMsg.model, edits: total },
      });
    }
    editor.cm.operation(() => editor.cm.replaceRange(next, applyScope.from, applyScope.to));
    editor.cm.focus();
    editor.cm.refresh();
    const applied = accepted;
    const all = total;
    closeApply();
    pushSystemNote(tr('chat.appliedNote', { a: applied, t: all }));
    toast(applied === all ? tr('chat.accepted') : tr('chat.appliedPartial', { a: applied, t: all }));
  }

  function pushSystemNote(text) {
    const s = ensureSession();
    s.messages.push({ id: uid(), role: 'system', content: text, ts: Date.now(), status: 'sent' });
    s.updatedAt = Date.now();
    persist();
    renderMessages();
    renderSessions();
  }

  function renderMessages() {
    messagesEl.innerHTML = '';
    const s = active();
    emptyEl.classList.toggle('hidden', !!(s && s.messages.length));
    if (!s || !s.messages.length) {
      messagesEl.appendChild(emptyEl);
      return;
    }
    for (const msg of s.messages) messagesEl.appendChild(messageNode(msg));
    requestAnimationFrame(() => (messagesEl.scrollTop = messagesEl.scrollHeight));
  }

  function renderAttachments() {
    attachmentsEl.innerHTML = '';
    for (const a of attachments) {
      const item = document.createElement('div');
      item.className = 'chat-attach';
      if (a.isImage && a.preview) {
        const img = document.createElement('img');
        img.src = a.preview;
        img.title = a.name;
        item.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.className = 'ca-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-file" /></svg>';
        item.appendChild(icon);
      }
      const name = document.createElement('span');
      name.className = 'ca-name';
      name.title = a.path || a.name;
      name.textContent = a.name;
      const status = document.createElement('span');
      status.className = 'ca-status ' + (a.status || 'ready');
      status.textContent =
        a.status === 'sending' ? tr('chat.sending') : a.status === 'sent' ? tr('chat.sent') : a.status === 'error' ? tr('chat.failed') : tr('chat.ready');
      // 图片附件可切换发送方式：只给路径（省 token）/ 以 data URL 发送（多模态）
      if (a.isImage) {
        const modeBtn = document.createElement('button');
        modeBtn.className = 'ca-mode mini-btn' + (a.mode === 'dataurl' ? ' on' : '');
        modeBtn.title = a.mode === 'dataurl' ? tr('chat.imgModeDataTip') : tr('chat.imgModePathTip');
        modeBtn.textContent = a.mode === 'dataurl' ? tr('chat.imgModeImage') : tr('chat.imgModePath');
        modeBtn.addEventListener('click', async () => {
          if (a.mode === 'path') {
            try {
              a.dataUrl = await imageToCompressedDataUrl(a.path);
              a.mode = 'dataurl';
            } catch (e) {
              toast(tr('chat.readImageFail') + ipc.describeError(e), { error: true });
            }
          } else {
            a.mode = 'path';
          }
          renderAttachments();
          updateSendState();
        });
        item.appendChild(modeBtn);
      }
      const del = document.createElement('button');
      del.className = 'ca-del mini-btn';
      del.title = tr('chat.removeAttach');
      del.textContent = '✕';
      del.addEventListener('click', () => {
        attachments = attachments.filter((x) => x.id !== a.id);
        renderAttachments();
      });
      item.append(name, status, del);
      attachmentsEl.appendChild(item);
    }
  }

  /** 把本地图片读成压缩后的 data URL（长边≤1200，JPEG 0.82），避免大图撑爆 token/请求体。 */
  async function imageToCompressedDataUrl(path) {
    const b64 = await ipc.fetchImageAsBase64(path);
    const raw = `data:image/${imageMime(path)};base64,${b64}`;
    // SVG 无法用 canvas 栅格化时直接回退原值
    if (/svg/i.test(path)) return raw;
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve; img.onerror = reject; img.src = raw;
      });
      const maxSide = 1200;
      const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
      if (scale >= 1 && raw.length < 700_000) return raw;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch (_) {
      return raw; // 压缩失败仍发送原图
    }
  }

  async function addPaths(paths) {
    const list = Array.isArray(paths) ? paths : [paths];
    for (const path of list) {
      if (!path || attachments.some((a) => a.path === path)) continue;
      const name = path.split(/[\\/]/).pop() || path;
      const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
      const a = {
        id: uid(),
        path,
        name,
        isImage,
        preview: isImage ? ipc.convertFileSrc(path) : '',
        // 图片发送模式：path=只给路径（省 token） | dataurl=以 data URL 发送（需模型支持视觉）
        mode: isImage ? 'path' : '',
        dataUrl: '',
        status: 'ready',
        text: '',
      };
      attachments.push(a);
      if (isImage) {
        toast(tr('chat.imgPathHint'), { duration: 3000 });
      }
      if (!isImage) {
        if (!TEXT_ATTACH_RE.test(path)) {
          a.text = tr('chat.binaryAttach');
        } else {
          try {
            const content = String(await ipc.readFile(path) || '');
            a.text = content.slice(0, MAX_TEXT_ATTACH);
            a.truncated = content.length > MAX_TEXT_ATTACH;
          } catch (e) {
            a.status = 'error';
            a.text = tr('chat.attachReadFail', { e: ipc.describeError(e) });
          }
        }
      }
    }
    renderAttachments();
  }

  async function pickAttachments() {
    const paths = await ipc.pickAnyFiles();
    if (paths.length) await addPaths(paths);
  }

  function buildContextMessage(attList = attachments) {
    const ctx = contextMode === 'off' ? null : getContext();
    const parts = [];
    if (ctx) {
      const cm = editor.cm;
      const docLines = String(ctx.doc || cm.getValue()).split('\n');
      const hasSel = cm.somethingSelected();
      const onlySel = contextMode === 'selection' && hasSel;
      const a = cm.getCursor('from');
      const b = cm.getCursor('to');
      const fromLine = onlySel ? Math.min(a.line, b.line) + 1 : 1;
      const toLine = onlySel ? Math.max(a.line, b.line) + 1 : docLines.length;
      const rangeLines = docLines.slice(fromLine - 1, toLine);
      // 按「整行」累积到预算，避免把某一行从中间切断；记录实际可见的最后一行行号
      const kept = [];
      let used = 0;
      for (let i = 0; i < rangeLines.length; i++) {
        const lineWithNo = `${fromLine + i}|${rangeLines[i]}\n`;
        if (used + lineWithNo.length > MAX_CONTEXT && kept.length) break;
        kept.push(lineWithNo);
        used += lineWithNo.length;
      }
      const clipped = kept.length < rangeLines.length;
      const visibleTo = fromLine + kept.length - 1;
      const numbered = kept.join('').replace(/\n$/, '');
      const saved = !!ctx.path;
      const scopeName = onlySel ? '仅选区' : '当前文档';
      parts.push(`${scopeName}：${ctx.path || ctx.name || '未命名'}，共 ${docLines.length} 行${saved ? '' : '（尚未保存到磁盘：无法插入本地图片，需先保存）'}。`);
      parts.push(onlySel ? `可修改范围：第 ${fromLine}–${toLine} 行（其余只读）。` : '可修改范围：全文。');
      if (clipped) {
        parts.push(`注意：原文过长，下面只发送了第 ${fromLine}–${visibleTo} 行；第 ${visibleTo + 1} 行之后的内容你看不到，不要对它们编造行号或内容。`);
      }
      const viewName = { editor: '源码', split: '分屏', preview: '预览（所见即所得）' }[prefs.viewMode] || '分屏';
      parts.push(`用户当前视图：${viewName}。`);
      parts.push(`带行号的原文${clipped ? `（仅第 ${fromLine}–${visibleTo} 行）` : ''}：\n${numbered}`);
    }
    // 附件与文档上下文是两件事：关掉文档上下文时仍然要发送附件
    if (attList.length) {
      const att = attList
        .map((a) => {
          if (a.isImage) {
            return a.mode === 'dataurl'
              ? `- 图片附件：${a.name}（图片内容已作为多模态输入一同发送，请直接观察图片）`
              : `- 图片附件：${a.name}（仅提供路径 ${a.path}，无法看到图片内容）`;
          }
          return `- 文件附件：${a.name}${a.truncated ? `（仅发送前 ${MAX_TEXT_ATTACH} 字，其余不可见）` : ''}\n${a.text || '（无可用文本）'}`;
        })
        .join('\n');
      parts.push(`用户附加的资料：\n${att}`);
    }
    return parts.join('\n\n');
  }

  async function applyModel(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    try {
      const cfg = await ipc.aiConfigGet();
      await ipc.aiConfigSet({
        provider: cfg.provider || 'custom',
        baseUrl: cfg.base_url || '',
        model: clean,
        apiKey: null,
        temperature: cfg.temperature ?? 0.3,
        maxTokens: cfg.max_tokens ?? 4096,
        extraBody: cfg.extra_body || '{}',
        skipTemperature: !!cfg.skip_temperature,
      });
      activeModel = clean;
      toast(tr('chat.modelSwitched', { m: clean }));
    } catch (e) {
      toast(ipc.describeError(e), { error: true });
    }
  }

  async function renderModels() {
    const cfg = await ipc.aiConfigGet().catch(() => ({}));
    activeModel = cfg.model || activeModel || '';
    const list = getModels();
    if (activeModel && !list.includes(activeModel)) list.unshift(activeModel);
    modelSel.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = tr('chat.noModel');
      modelSel.appendChild(empty);
    }
    list.forEach((name) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      modelSel.appendChild(o);
    });
    const add = document.createElement('option');
    add.value = '__add__';
    add.textContent = tr('chat.addModel');
    modelSel.appendChild(add);
    modelSel.value = activeModel || (list[0] || '');
  }

  async function cancelStream() {
    if (!streamRequestId) return;
    try {
      await ipc.aiChatStreamCancel(streamRequestId);
    } catch (_) {}
  }

  async function send(text, overrideAttachments = null) {
    const content = String(text || inputEl.value || '').trim();
    if (!content || busy) return;
    pushInputHistory(content);
    historyCursor = -1;
    const suggested = recommendSkill(content);
    if (suggested) toast(tr('chat.skillSuggest', { n: suggested.name }), { duration: 3500 });
    const s = ensureSession();
    const usedAttachments = overrideAttachments || attachments.map((a) => ({ ...a }));
    if (s.messages.length === 0) s.title = titleFrom(content);

    const userMsg = {
      id: uid(),
      role: 'user',
      content,
      ts: Date.now(),
      status: 'sending',
      attachments: usedAttachments.map((a) => ({ ...a, status: 'sending' })),
    };
    s.messages.push(userMsg);
    const assistantMsg = { id: uid(), role: 'assistant', content: '', ts: Date.now(), status: 'sending' };
    s.messages.push(assistantMsg);
    busy = true;
    inputEl.value = '';
    attachments = [];
    renderAttachments();
    renderMessages();
    persist();
    updateSendState();

    try {
      const rawHistory = s.messages
        .filter((m) => m.status !== 'error' && m !== assistantMsg)
        .map((m) => ({ role: m.role, content: m.content }));
      const history = selectHistory(rawHistory, 6000);
      // 多技能叠加：所有固定技能 + 本次斜杠技能，限制总长度防止 prompt 膨胀
      const activeSkills = [...pinnedSkillIds.map((id) => getSkill(id)), onceSkillId ? getSkill(onceSkillId) : null]
        .filter(Boolean);
      let skillBudget = 6000;
      const skillPrompts = [];
      for (const sk of activeSkills) {
        const promptText = fillSkillVariables(sk.prompt, skillValues[sk.id]);
        const chunk = `\n当前启用的技能：${sk.name}\n${promptText}`.slice(0, skillBudget);
        if (chunk.length < 20) break;
        skillPrompts.push(chunk);
        skillBudget -= chunk.length;
      }
      const skill = skillPrompts.length ? { name: activeSkills[0].name } : null;
      const system = [
        '你是 FeatherMark 编辑器内的 Markdown 协作 Agent。回答要简洁、具体、可执行。',
        '默认使用简体中文；用户用英文提问时用英文回答。',
        EDITOR_KNOWLEDGE,
        '当用户要求修改文档/选区时，只输出编辑指令，不要输出解释或整篇文档：',
        'REPLACE 起-止\n新内容（可多行）\nDELETE 起-止\nINSERT N\n新内容（可多行）\nEND',
        '行号必须取自带行号的原文；只输出改动行，没改的行不要重复。只是问问题时正常回答，不要输出编辑指令。',
        webSearch ? '\n本次已开启联网搜索：事实性、时效性或需要查证的问题请先联网检索再回答，并在相关句子后给出来源链接。' : '',
        skillPrompts.join(''),
      ]
        .filter(Boolean)
        .join('\n');
      const ctx = buildContextMessage(usedAttachments);
      const messages = [{ role: 'system', content: system }];
      if (ctx) messages.push({ role: 'user', content: ctx });
      // 多模态图片：把以 data URL 发送的图片作为独立 content part 附在同一条 user 消息上。
      // 没有图片时保持纯字符串 content，兼容所有 OpenAI 兼容服务商。
      const visionParts = usedAttachments
        .filter((a) => a.isImage && a.mode === 'dataurl' && a.dataUrl)
        .map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } }));
      if (visionParts.length) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'user') {
          last.content = [
            { type: 'text', text: String(last.content || content) },
            ...visionParts,
          ];
        } else {
          messages.push({ role: 'user', content: [{ type: 'text', text: content }, ...visionParts] });
        }
      }
      messages.push(...history);

      if (contextMode !== 'off') {
        const c = getContext();
        const raw = contextMode === 'selection'
          ? (c && c.selection ? c.selection : '')
          : (c ? c.doc || '' : '');
        if (raw.length > MAX_CONTEXT) {
          toast(tr('chat.ctxTruncated', { n: MAX_CONTEXT }), { duration: 3200 });
        }
      }

      const requestId = uid();
      streamRequestId = requestId;
      assistantMsg.status = webSearch ? 'searching' : 'streaming';
      renderMessages();
      let searchState = webSearch ? 'pending' : 'off';
      let searchError = '';
      const unlisten = await listen('ai-chat-stream', (event) => {
        const p = event.payload || {};
        if (p.request_id !== requestId) return;
        const payload = p.payload || {};
        if (p.type === 'searching') {
          if (!assistantMsg.content) {
            assistantMsg.status = 'searching';
            renderMessages();
          }
        } else if (p.type === 'search_error') {
          searchState = 'failed';
          searchError = String(payload.message || '');
          toast(tr('chat.searchFail') + ' ' + searchError, { error: true, duration: 5000 });
        } else if (p.type === 'search_done') {
          searchState = 'ok';
        } else if (p.type === 'thinking') {
          if (!assistantMsg.content) {
            assistantMsg.status = 'thinking';
            renderMessages();
          }
        } else if (p.type === 'chunk') {
          assistantMsg.content += String(payload.delta || '');
          assistantMsg.status = 'streaming';
          renderMessages();
        } else if (p.type === 'cancelled') {
          assistantMsg.status = 'stopped';
        }
      });

      let res;
      try {
        const writeIntent = /(写|创作|扩写|续写|翻译|rewrite|translate|写一篇|起草)/i.test(content);
        const budgetKind = writeIntent ? 'write' : 'chat';
        res = await ipc.aiChatStream(requestId, messages, {
          maxTokens: outputBudget(budgetKind), temperature: 0.3, webSearch,
        });
      } finally {
        unlisten();
        streamRequestId = null;
      }

      assistantMsg.content = String(res.content || assistantMsg.content || '').trim();
      const detected = parseEdits(assistantMsg.content);
      if (detected.edits.length) assistantMsg.patch = detected.edits;
      assistantMsg.status = res.cancelled || res.finish_reason === 'cancelled' ? 'stopped' : 'sent';
      assistantMsg.model = res.model;
      assistantMsg.latency = res.latency_ms;
      assistantMsg.finishReason = res.finish_reason;
      // 联网来源：后端结构化的 url_citation + 正文里的链接标注，去重后随会话持久化
      const cites = extractCitations(assistantMsg.content, res.citations);
      if (cites.length) {
        assistantMsg.citations = cites;
        // 把正文里的 [1] [2] 编号标注转成指向来源的可点击链接
        assistantMsg.content = linkCitationMarks(assistantMsg.content, cites);
      }
      // 固化联网状态：失败或未联网时明确标记，避免用户误以为已查证
      if (webSearch) {
        assistantMsg.searchState = searchState;
        if (searchState === 'failed') assistantMsg.searchError = searchError;
      }
      userMsg.status = res.cancelled ? 'stopped' : 'sent';
      userMsg.attachments.forEach((a) => (a.status = res.cancelled ? 'ready' : 'sent'));
      s.updatedAt = Date.now();
    } catch (e) {
      const msg = ipc.describeError(e);
      assistantMsg.content = msg;
      assistantMsg.status = 'error';
      userMsg.status = 'error';
      userMsg.attachments.forEach((a) => (a.status = 'error'));
      if (/配置|API Key|Base URL|还没/i.test(msg)) {
        assistantMsg.content = `${msg}\n\n` + tr('chat.configureAI');
      }
    } finally {
      busy = false;
      onceSkillId = null; // 斜杠命令只作用于本次请求
      updateSkillChip();
      s.updatedAt = Date.now();
      persist();
      renderMessages();
      renderSessions();
      updateSendState();
    }
  }

  function sendIcon(name) {
    return `<svg viewBox="0 0 24 24"><use href="#${name}" /></svg>`;
  }

  function updateSendState() {
    const hasText = !!inputEl.value.trim();
    if (busy) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = `${sendIcon('i-close')} ` + tr('stop');
      hintEl.textContent = streamRequestId ? tr('chat.generatingStop') : tr('chat.waiting');
      return;
    }
    sendBtn.disabled = !hasText;
    sendBtn.innerHTML = `${sendIcon('i-send')} ` + tr('send');
    const ctx = buildContextMessage(attachments);
    const est = estimateTokens(`${inputEl.value || ''}\n${ctx || ''}`);
    hintEl.textContent = tr('chat.sendHint', { est: est });
  }

  function fillPrompt(text) {
    inputEl.value = text || '';
    inputEl.focus();
    updateSendState();
  }

  function showEditTemplates(anchor) {
    showMenu(anchor, [
      ...EDIT_TEMPLATES.map((t) => ({
        label: `${t.label} · ${t.hint}`,
        onClick: () => agentEdit.open(t.id, { source: 'agent' }),
      })),
      { sep: true },
      { title: tr('chat.tplHint1') },
    ]);
  }

  function showTemplates(anchor) {
    showMenu(anchor, [
      ...TEMPLATES.map((t) => ({
        label: t.label,
        onClick: () => fillPrompt(t.prompt),
      })),
      { sep: true },
      { title: tr('chat.tplHint2') },
    ]);
  }

  function showSkills(anchor) {
    const all = listSkills();
    const items = [];
    if (!all.length) {
      items.push({ title: tr('chat.noSkills') });
      items.push({ label: tr('chat.importSkill'), onClick: () => openSkillsManager() });
      showMenu(anchor, items);
      return;
    }
    items.push({ title: tr('chat.skillsHint') });
    for (const skill of all) {
      const pinned = pinnedSkillIds.includes(skill.id);
      items.push({ title: `${pinned ? '● ' : '○ '}${skill.name} — ${skill.description || tr('noDesc')}` });
      items.push({
        label: pinned ? tr('chat.skillUnpin', { n: skill.name }) : tr('chat.skillPin', { n: skill.name }),
        onClick: () => {
          if (pinned) pinnedSkillIds = pinnedSkillIds.filter((id) => id !== skill.id);
          else if (pinnedSkillIds.length < 5) pinnedSkillIds.push(skill.id); // 最多 5 个，防止 prompt 膨胀
          else { toast(tr('chat.tooManySkills'), { error: true }); return; }
          savePinnedSkills();
          updateSkillChip();
          toast(pinned ? tr('chat.skillDisabled', { n: skill.name }) : tr('chat.skillPinned', { n: skill.name }));
        },
      });
      items.push({ label: tr('chat.skillOnce', { n: skill.name }), onClick: () => useSkill(skill.id, true) });
      items.push({ sep: true });
    }
    items.push({ label: tr('chat.manageSkills'), onClick: () => openSkillsManager() });
    showMenu(anchor, items);
  }

  const skillValues = {}; // 技能 {{变量}} 的取值，按技能 id 存，随会话使用
  async function useSkill(id, once = false) {
    const skill = getSkill(id);
    if (!skill) return;
    // 含 {{变量}} 的技能：逐个询问取值（promptDialog 返回 Promise）
    const vars = skillVariables(skill.prompt);
    if (vars.length) {
      for (const v of vars) {
        const val = await promptDialog({ title: tr('chat.skillVarTitle', { v }), label: skill.name, value: skillValues[id]?.[v] || '' });
        if (val == null) return;
        (skillValues[id] ||= {})[v] = String(val);
      }
    }
    if (once) {
      onceSkillId = id;
      toast(tr('chat.skillThisTime', { n: skill.name }));
    } else {
      if (!pinnedSkillIds.includes(id)) {
        if (pinnedSkillIds.length >= 5) { toast(tr('chat.tooManySkills'), { error: true }); return; }
        pinnedSkillIds.push(id);
        savePinnedSkills();
      }
    }
    updateSkillChip();
    if (!inputEl.value.trim()) fillPrompt(`${fillSkillVariables(skill.prompt, skillValues[id])}\n\n请根据当前文档上下文回答。`);
    inputEl.focus();
  }

  function updateSkillChip() {
    const pinned = pinnedSkillIds.map((id) => getSkill(id)).filter(Boolean);
    const once = onceSkillId ? getSkill(onceSkillId) : null;
    const names = [...pinned.map((s) => s.name), ...(once ? [once.name] : [])];
    skillChip.textContent = names.length
      ? `${once && !pinned.length ? tr('chat.once') : tr('chat.skill')}：${names.join('、')}${names.length > 2 ? ` +${names.length - 2}` : ''}`
      : tr('chat.skill');
    skillChip.classList.toggle('on', names.length > 0);
  }

  // 输入框里敲 "/" 弹出技能列表，选中后带走输入框里的 "/xxx"，技能只作用于本次请求
  function handleSlash() {
    const all = listSkills();
    if (!all.length) return false;
    const val = inputEl.value;
    const pos = inputEl.selectionStart;
    // 只在当前光标位于行首 "/" 后、且后面没有空格时才视为斜杠命令
    const before = val.slice(0, pos);
    if (!/\/(^\s*)$/.test(before)) return false;
    const items = all.map((skill) => ({
      label: `/${skill.name}`,
      hint: skill.description,
      onClick: () => {
        inputEl.value = val.slice(pos) .trimStart();
        inputEl.setSelectionRange(0, 0);
        useSkill(skill.id, true);
        updateSendState();
      },
    }));
    items.push({ sep: true }, { title: tr('escCancel') });
    showMenu(inputEl, items);
    return true;
  }

  /* ---------------------------------------------------------------- 技能管理弹窗 */
  const skillsDialog = $('skills-dialog');
  const skillsListEl = $('skills-list');
  const skillsFormEl = $('skills-editor-form');
  const skillsEmptyEl = $('skills-editor-empty');
  const skillNameEl = $('skill-name');
  const skillDescEl = $('skill-desc');
  const skillPromptEl = $('skill-prompt');
  const skillMsgEl = $('skills-form-msg');
  let editingSkillId = null;

  function openSkillsManager() {
    skillsDialog.classList.remove('hidden');
    editingSkillId = null;
    renderSkillsList();
    showSkillEditor(null);
  }

  function closeSkillsManager() {
    skillsDialog.classList.add('hidden');
  }

  function renderSkillsList() {
    const all = listSkills();
    $('skills-count').textContent = `${all.length} / ${MAX_SKILLS}`;
    skillsListEl.innerHTML = '';
    if (!all.length) {
      const empty = document.createElement('div');
      empty.className = 'skills-list-empty';
      empty.textContent = tr('chat.skillMgrEmpty');
      skillsListEl.appendChild(empty);
      return;
    }
    all.forEach((sk) => {
      const item = document.createElement('button');
      item.className = 'skills-list-item' + (editingSkillId === sk.id ? ' on' : '');
      const pin = document.createElement('span');
      pin.className = 'skills-list-pin';
      pin.textContent = pinnedSkillIds.includes(sk.id) ? '●' : '○';
      pin.title = pinnedSkillIds.includes(sk.id) ? tr('chat.skillEnabled') : tr('chat.skillNotEnabled');
      const name = document.createElement('span');
      name.className = 'skills-list-name';
      name.textContent = sk.name;
      const desc = document.createElement('span');
      desc.className = 'skills-list-desc';
      desc.textContent = sk.description || tr('noDesc');
      item.appendChild(pin); item.appendChild(name); item.appendChild(desc);
      item.addEventListener('click', () => showSkillEditor(sk));
      skillsListEl.appendChild(item);
    });
  }

  function showSkillEditor(skill) {
    editingSkillId = skill ? skill.id : null;
    skillsEmptyEl.classList.toggle('hidden', !!skill);
    skillsFormEl.classList.toggle('hidden', !skill);
    skillMsgEl.textContent = '';
    if (!skill) { renderSkillsList(); return; }
    skillNameEl.value = skill.name;
    skillDescEl.value = skill.description || '';
    skillPromptEl.value = skill.prompt;
    $('skill-delete').classList.toggle('hidden', false);
    $('skill-export').classList.toggle('hidden', false);
    renderSkillsList();
  }

  function formMessage(text, error = false) {
    skillMsgEl.textContent = text;
    skillMsgEl.className = 'skills-form-msg' + (error ? ' err' : ' ok');
  }

  function saveCurrentSkill() {
    const r = upsertSkill(
      { name: skillNameEl.value, description: skillDescEl.value, prompt: skillPromptEl.value },
      editingSkillId
    );
    if (!r.ok) { formMessage(r.error, true); return; }
    pinnedSkillIds = pinnedSkillIds.map((id) => id === editingSkillId ? r.skill.id : id);
    savePinnedSkills();
    if (onceSkillId === editingSkillId) onceSkillId = r.skill.id;
    editingSkillId = r.skill.id;
    updateSkillChip();
    renderSkillsList();
    formMessage(tr('saved'));
  }

  async function importSkillFiles() {
    const files = await ipc.pickAnyFiles();
    if (!files.length) return;
    let count = 0;
    let lastErr = '';
    for (const f of files) {
      if (!/\.(md|markdown|txt)$/i.test(f)) continue;
      try {
        const text = await ipc.readFile(f);
        const r = parseSkillMarkdown(text);
        if (!r.ok) { lastErr = `${f}：${r.error}`; continue; }
        const saved = upsertSkill(r.skill);
        if (!saved.ok) { lastErr = `${f}：${saved.error}`; continue; }
        count++;
      } catch (e) {
        lastErr = `${f}：${(e && e.message) || e}`;
      }
    }
    renderSkillsList();
    if (count) formMessage(tr('chat.skillImported', { n: count }));
    else if (lastErr) formMessage(lastErr, true);
  }

  function pasteSkill() {
    showMenu($('skill-paste'), [
      { title: tr('chat.skillPasteHint') },
      { label: tr('chat.skillFromClipboard'), onClick: async () => {
        try {
          const text = await navigator.clipboard.readText();
          const r = parseSkillMarkdown(text);
          if (!r.ok) { formMessage(r.error, true); return; }
          skillNameEl.value = r.skill.name;
          skillDescEl.value = r.skill.description || '';
          skillPromptEl.value = r.skill.prompt;
          editingSkillId = null;
          skillsEmptyEl.classList.add('hidden');
          skillsFormEl.classList.remove('hidden');
          formMessage(tr('chat.skillParsed'));
          renderSkillsList();
        } catch (e) {
          formMessage(tr('chat.clipboardFail') + ((e && e.message) || e), true);
        }
      } },
    ]);
  }

  function exportCurrentSkill() {
    const sk = getSkill(editingSkillId);
    if (!sk) return;
    const blob = new Blob([toSkillMarkdown(sk)], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${sk.name.replace(/[\\/:*?"<>|]/g, '_')}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function updateContextChip() {
    contextBtn.classList.toggle('on', contextMode !== 'off');
    const labels = { doc: tr('chat.ctxDoc'), selection: tr('chat.ctxSel'), off: tr('chat.ctxOff') };
    contextBtn.textContent = tr('chat.ctxButton', { m: labels[contextMode] || labels.doc });
    contextBtn.title = tr('chat.ctxHint');
  }

  function setContextMode(mode) {
    if (!['doc', 'selection', 'off'].includes(mode)) return;
    contextMode = mode;
    save(CONTEXT_MODE_KEY, mode);
    updateContextChip();
    updateSendState();
  }

  function updateWebChip() {
    webBtn.classList.toggle('on', webSearch);
    webBtn.textContent = (webSearch ? '🌐 ' : '') + tr('chat.webSearch');
    webBtn.setAttribute('aria-pressed', String(webSearch));
    webBtn.title = tr('chat.webSearchHint');
  }

  function toggleWebSearch() {
    webSearch = !webSearch;
    save(WEB_SEARCH_KEY, webSearch);
    updateWebChip();
    toast(tr(webSearch ? 'chat.webOn' : 'chat.webOff'));
  }

  function isOpen() {
    return !panel.classList.contains('hidden');
  }

  function setOpen(open) {
    panel.classList.toggle('hidden', !open);
    splitter.classList.toggle('hidden', !open);
    $('btn-chat').classList.toggle('active', open);
    $('sb-chat').classList.toggle('on', open);
    prefs.chatVisible = open;
    savePrefs();
    if (onLayoutChange) onLayoutChange();
    setTimeout(() => {
      if (editorRefresh) editorRefresh();
      if (open) inputEl.focus();
    }, 30);
  }

  let editorRefresh = null;
  function setRefresh(fn) {
    editorRefresh = fn;
  }

  // 事件绑定
  $('chat-new').addEventListener('click', () => newSession());
  $('chat-search-session').addEventListener('click', async () => {
    const q = await promptDialog({ title: tr('chat.searchSession'), label: tr('chat.searchSessionHint'), value: sessionFilter });
    sessionFilter = String(q || '').trim();
    renderSessions();
  });
  $('chat-close').addEventListener('click', () => setOpen(false));
  $('chat-templates').addEventListener('click', (e) => showTemplates(e.currentTarget));
  $('chat-edit').addEventListener('click', (e) => showEditTemplates(e.currentTarget));
  $('chat-skills').addEventListener('click', (e) => showSkills(e.currentTarget));
  $('chat-attach').addEventListener('click', () => pickAttachments());
  modelSel.addEventListener('change', async () => {
    if (modelSel.value === '__add__') {
      modelSel.value = activeModel || (getModels()[0] || '');
      // 跳到设置里「添加模型」处，统一在设置中维护清单
      openSettings({ focus: 'ai-add-model' });
      return;
    }
    await applyModel(modelSel.value);
  });
  onModelsChange(() => renderModels());
  $('apply-close').addEventListener('click', closeApply);
  $('apply-cancel').addEventListener('click', closeApply);
  $('apply-accept').addEventListener('click', () => acceptApply('accepted'));
  $('apply-all').addEventListener('click', () => acceptApply('all'));
  applyDialog.addEventListener('pointerdown', (e) => {
    if (e.target === applyDialog) closeApply();
  });
  document.addEventListener('keydown', (e) => {
    if (applyDialog.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeApply();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!btnApplyAccept.disabled) acceptApply('accepted');
    }
  });
  $('chat-export').addEventListener('click', () => {
    const s = active();
    if (!s || !s.messages.length) {
      toast(tr('chat.sessionEmpty'), { error: true });
      return;
    }
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `feathermark-chat-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('chat-clear').addEventListener('click', async () => {
    const s = active();
    if (!s || !s.messages.length) return;
    const ok = await ipc.confirmDialog(tr('chat.clearSessionConfirm'));
    if (!ok) return;
    s.messages = [];
    s.title = tr('chat.newSession');
    s.updatedAt = Date.now();
    persist();
    renderSessions();
    renderMessages();
  });
  $('chat-sessions-toggle').addEventListener('click', (e) => {
    sessionsEl.classList.toggle('collapsed');
    e.currentTarget.classList.toggle('collapsed');
  });
  $('chat-skill-chip').addEventListener('click', (e) => showSkills(e.currentTarget));
  webBtn.addEventListener('click', toggleWebSearch);
  contextBtn.addEventListener('click', (e) => {
    showMenu(e.currentTarget, [
      { label: tr('chat.ctxDoc'), hint: contextMode === 'doc' ? '✓' : '', onClick: () => setContextMode('doc') },
      { label: tr('chat.ctxSel'), hint: contextMode === 'selection' ? '✓' : '', onClick: () => setContextMode('selection') },
      { sep: true },
      { label: tr('chat.ctxOffFull'), hint: contextMode === 'off' ? '✓' : '', onClick: () => setContextMode('off') },
    ]);
  });
  // 技能管理弹窗事件
  $('skills-close').addEventListener('click', closeSkillsManager);
  skillsDialog.addEventListener('pointerdown', (e) => { if (e.target === skillsDialog) closeSkillsManager(); });
  $('skill-new').addEventListener('click', () => showSkillEditor(null));
  $('skill-import').addEventListener('click', importSkillFiles);
  $('skill-paste').addEventListener('click', pasteSkill);
  $('skill-save').addEventListener('click', saveCurrentSkill);
  $('skill-cancel').addEventListener('click', () => showSkillEditor(null));
  $('skill-delete').addEventListener('click', () => {
    const sk = getSkill(editingSkillId);
    if (!sk) return;
    showMenu($('skill-delete'), [
      { title: tr('chat.skillDeleteConfirm', { n: sk.name }) },
      { label: tr('delete'), onClick: () => {
        deleteSkill(sk.id);
        pinnedSkillIds = pinnedSkillIds.filter((id) => id !== sk.id);
        savePinnedSkills();
        if (onceSkillId === sk.id) onceSkillId = null;
        updateSkillChip();
        showSkillEditor(null);
        formMessage(tr('deleted'));
      } },
    ]);
  });
  $('skill-export').addEventListener('click', exportCurrentSkill);

  inputEl.addEventListener('input', updateSendState);
  /** 根据用户输入与技能 name/description 的关键词重合度推荐技能（不自动启用，只提示）。 */
  function recommendSkill(text) {
    const q = String(text || '').toLowerCase();
    if (q.length < 4 || pinnedSkillIds.length || onceSkillId) return null;
    let best = null; let bestScore = 0;
    for (const sk of listSkills()) {
      const terms = `${sk.name} ${sk.description || ''}`.toLowerCase().split(/[\s,，、/·]+/).filter((t) => t.length >= 2);
      let score = 0;
      for (const t of terms) if (q.includes(t)) score += t.length;
      if (score > bestScore) { bestScore = score; best = sk; }
    }
    return bestScore >= 4 ? best : null;
  }

  /** 输入 @ 时列出工作区 Markdown 文件供引用，选中后作为附件加入。 */
  async function handleAtMention() {
    const ws = getWorkspace();
    if (!ws || ws === '__global__') return false;
    try {
      const root = await ipc.listDir(ws);
      const files = (root.entries || root || [])
        .filter((e) => !e.is_dir && /\.(md|markdown|txt)$/i.test(e.name))
        .slice(0, 60);
      if (!files.length) return false;
      showMenu(inputEl, files.map((f) => ({
        label: f.name,
        hint: '@引用',
        onClick: () => {
          // 把 @文件名 插到光标处，并把文件作为附件加入
          const pos = inputEl.selectionStart;
          const before = inputEl.value.slice(0, pos).replace(/@[^@\s]*$/, '');
          inputEl.value = before + '@' + f.name + ' ' + inputEl.value.slice(pos);
          inputEl.focus();
          addPaths([f.path]);
        },
      })));
      return true;
    } catch (_) {
      return false;
    }
  }

  let lastAtPos = -1;
  inputEl.addEventListener('input', () => {
    const pos = inputEl.selectionStart;
    const before = inputEl.value.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at >= 0 && pos - at <= 20 && !/\s/.test(before.slice(at + 1)) && at !== lastAtPos) {
      lastAtPos = at;
      handleAtMention();
    } else if (at < 0 || /\s/.test(before.slice(at + 1))) {
      lastAtPos = -1;
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // 让字符先落到输入框，再判断是否弹技能菜单
      setTimeout(() => { if (handleSlash()) e.preventDefault(); }, 0);
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
    // ↑ 在光标位于首行时召回上一条输入历史（不干扰正常编辑）
    if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const pos = inputEl.selectionStart;
      if (pos === 0 || inputEl.value.indexOf('\n', 0, pos) < 0) {
        const next = historyPrev();
        if (next != null) { e.preventDefault(); inputEl.value = next; inputEl.setSelectionRange(next.length, next.length); }
      }
    }
    if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const next = historyNext();
      if (next != null) { e.preventDefault(); inputEl.value = next; inputEl.setSelectionRange(next.length, next.length); }
    }
  });
  sendBtn.addEventListener('click', () => {
    if (busy) {
      cancelStream();
      return;
    }
    send();
  });

  emptyEl.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-template]');
    if (editBtn) {
      agentEdit.open(editBtn.dataset.editTemplate, { source: 'agent' });
      return;
    }
    const btn = e.target.closest('[data-template]');
    if (!btn) return;
    const t = TEMPLATES.find((x) => x.label === btn.textContent);
    if (t) fillPrompt(t.prompt);
  });

  // 拖放事件由 Tauri 的全局路径事件转发进来；这里只维护视觉反馈
  panel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropDepth++;
    panel.classList.add('chat-dropping');
  });
  panel.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropDepth = Math.max(0, dropDepth - 1);
    if (!dropDepth) panel.classList.remove('chat-dropping');
  });
  panel.addEventListener('dragover', (e) => e.preventDefault());
  panel.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropDepth = 0;
    panel.classList.remove('chat-dropping');
    // 文件路径统一交给 Tauri 的 onDragDropEvent 处理（main.js 按落点坐标分流）。
    // 这里若再用 dataTransfer.files 添加一次，两个路径会重复添加同一附件。
    // 浏览器原生 drop 只处理纯文本拖入，用于非 Tauri 环境。
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) return;
    const text = e.dataTransfer?.getData?.('text/plain') || '';
    if (text.trim()) inputEl.value = (inputEl.value ? inputEl.value + '\n' : '') + text;
  });

  function init() {
    setOpen(!!prefs.chatVisible);
    ensureSession();
    renderSessions();
    renderMessages();
    renderAttachments();
    updateContextChip();
    updateSkillChip();
    updateWebChip();
    updateSendState();
    renderModels();
    // 切换界面语言后重绘动态文案（会话/消息/上下文/技能/发送状态）
    document.addEventListener('languagechange', () => {
      renderSessions();
      renderMessages();
      renderAttachments();
      updateContextChip();
      updateSkillChip();
      updateWebChip();
      updateSendState();
    });
  }

  return {
    init,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen()),
    isOpen,
    setRefresh,
    addPaths,
    attachFiles: pickAttachments,
    fillPrompt,
    openEditor: (id = null, opts = {}) =>
      agentEdit.open(id, {
        source: opts.source || 'agent',
        initialInstruction: opts.initialInstruction || '',
      }),
    isEditOpen: () => agentEdit.isOpen(),
    getWorkspace,
    contextRect: () => panel.getBoundingClientRect(),
  };
}
