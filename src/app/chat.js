// Agent 会话侧边栏：与编辑器共享当前文档上下文，但自己管理会话、消息和附件。
//
// 设计取舍：
// - 会话存 localStorage（按工作区隔离），不新建数据库；离线可用、重启可恢复。
// - 附件只保存路径与文本摘要：图片给预览 URL，文本文件读前若干字符作为上下文；
//   不把二进制塞进 localStorage，也不假设模型一定支持 vision。
// - AI 请求复用 ipc.aiChat（密钥仍只在 Rust 侧），失败不静默重试，直接显示可操作错误。
import * as ipc from './ipc.js';
import { prefs, savePrefs } from './store.js';
import { showMenu, toast, promptDialog } from './ui.js';
import { EDIT_TEMPLATES } from './edit-templates.js';
import { createAgentEdit } from './agent-edit.js';
import { buildDiffView } from './diff-view.js';

const SESSION_KEY = 'feathermark.agent.sessions.v1';
const SKILL_KEY = 'feathermark.agent.skills.v1';
const MAX_TEXT_ATTACH = 4000;
const MAX_CONTEXT = 6000;

// 聊天用问题模板。会修改文档的编辑能力统一放在 EDIT_TEMPLATES，避免重复入口。
const TEMPLATES = [
  { label: '解释这段代码', prompt: '请解释当前代码块的作用、关键步骤和注意事项。如果有多段代码，优先解释光标附近的代码。' },
  { label: '生成大纲', prompt: '请基于当前文档生成一份简洁的大纲，并标出各章节之间的关系。' },
  { label: '找问题', prompt: '请检查当前文档，指出错别字、语病、逻辑跳跃、事实存疑和结构问题，按严重程度排序。' },
  { label: '续写下一节', prompt: '请根据当前文档的风格和结构，续写下一节内容，不要重复已有结论。' },
];

const BUILTIN_SKILLS = [
  {
    id: 'md-editor',
    name: 'Markdown 编辑',
    desc: '默认技能：理解 Markdown 结构，回答简洁，可直接给出可粘贴的正文',
    prompt: '你是 Markdown 编辑助手。回答要简洁、可执行；需要给出正文时，直接输出可粘贴到编辑器的 Markdown。',
    enabled: true,
  },
  {
    id: 'tech-writer',
    name: '技术写作',
    desc: '强调准确性、术语一致和段落逻辑，适合文档与 README',
    prompt: '以资深技术写作者身份回答：先给结论，再给依据；术语保持一致；避免空泛表述。',
    enabled: false,
  },
  {
    id: 'proofreader',
    name: '校对纠错',
    desc: '只关注错别字、标点、语病与格式一致性',
    prompt: '你是严格但克制的技术校对员：只指出确定的问题，给出原文与建议改法，不重写整段。',
    enabled: false,
  },
  {
    id: 'explainer',
    name: '代码解释',
    desc: '把代码讲清楚，标注关键行和风险点',
    prompt: '请解释代码意图、输入输出、关键步骤和潜在问题；涉及行号时标明行号。',
    enabled: false,
  },
  {
    id: 'outline',
    name: '大纲规划',
    desc: '把想法整理成层级清晰的大纲',
    prompt: '请把内容组织成层级清晰的大纲：先给主干，再补子项；避免交叉包含。',
    enabled: false,
  },
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
const shortTime = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export function createChat({ editor, getContext, getWorkspace, openSettings, onLayoutChange }) {
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
  const sendBtn = $('chat-send');
  const hintEl = $('chat-hint');
  const applyDialog = $('apply-dialog');
  const applyScopeEl = $('apply-scope');
  const applyDiffEl = $('apply-diff');
  const applyMetaEl = $('apply-meta');
  const btnApplyAccept = $('apply-accept');
  const btnApplyAll = $('apply-all');

  // Agent 编辑模板流程由 Agent 模块统一持有；状态栏、快捷键、菜单都通过本模块调用。
  const agentEdit = createAgentEdit({ editor, onNeedConfig: openSettings });

  let allSessions = load(SESSION_KEY, []);
  let activeId = null;
  let attachments = [];
  let includeContext = true;
  let activeSkill = null;
  let busy = false;
  let dropDepth = 0;
  let applyView = null;
  let applyScope = null;

  const skills = Object.assign(
    {},
    ...BUILTIN_SKILLS.map((s) => ({ [s.id]: s.enabled })),
    load(SKILL_KEY, {})
  );
  const workspace = () => getWorkspace() || '__global__';
  const sessions = () => allSessions.filter((s) => s.workspace === workspace());
  const active = () => allSessions.find((s) => s.id === activeId) || null;
  const enabledSkills = () => BUILTIN_SKILLS.filter((s) => skills[s.id]);

  function persist() {
    save(SESSION_KEY, allSessions);
    save(SKILL_KEY, skills);
  }

  function titleFrom(text) {
    const first = String(text || '').trim().split('\n')[0].replace(/^#+\s*/, '');
    return (first || '新会话').slice(0, 24);
  }

  function newSession() {
    const s = {
      id: uid(),
      workspace: workspace(),
      title: '新会话',
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

  function renderSessions() {
    sessionsEl.innerHTML = '';
    const list = sessions().sort((a, b) => b.updatedAt - a.updatedAt);
    if (!list.length) {
      sessionsEl.innerHTML = '<div class="tree-empty">还没有会话。点「+」开始。</div>';
      return;
    }
    for (const s of list) {
      const row = document.createElement('div');
      row.className = 'chat-session-item' + (s.id === activeId ? ' active' : '');
      row.title = s.title;
      const title = document.createElement('span');
      title.className = 'cs-title';
      title.textContent = s.title;
      const time = document.createElement('span');
      time.className = 'cs-time';
      time.textContent = shortTime(s.updatedAt);
      const del = document.createElement('button');
      del.className = 'cs-del mini-btn';
      del.title = '删除会话';
      del.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-trash" /></svg>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(s.id);
      });
      row.addEventListener('dblclick', async () => {
        const name = await promptDialog({ title: '重命名会话', value: s.title });
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
      row.append(title, time, del);
      sessionsEl.appendChild(row);
    }
  }

/** 从回复里提取可应用正文：优先 Markdown 代码块，其次最后一个代码块，最后才用整条回复。 */
function extractProposal(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const fences = [...text.matchAll(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g)];
  if (!fences.length) return text;
  const preferred = fences.find((m) => /^(md|markdown)$/i.test(m[1] || '')) || fences[fences.length - 1];
  return preferred[2].replace(/\n+$/, '');
}

  function messageNode(msg) {
    const wrap = document.createElement('div');
    wrap.className = `chat-msg ${msg.role}` + (msg.status === 'error' ? ' error' : '');

    const head = document.createElement('div');
    head.className = 'chat-msg-head';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.role === 'user' ? '你' : msg.role === 'assistant' ? 'Agent' : '系统';
    const time = document.createElement('span');
    time.textContent = shortTime(msg.ts || Date.now());
    const status = document.createElement('span');
    status.className = 'status' + (msg.status === 'error' ? ' error' : '');
    if (msg.status === 'sending') status.innerHTML = '<span class="chat-loading"><i></i><i></i><i></i></span>';
    else if (msg.status === 'error') status.textContent = '失败';
    else if (msg.role === 'user' && msg.status === 'sent') status.textContent = '已发送';
    head.append(who, time, status);

    const body = document.createElement('div');
    body.className = 'chat-msg-body';
    if (msg.content) {
      if (msg.role === 'assistant' && window.UnifiedRenderer) {
        try {
          body.classList.add('markdown-body');
          body.innerHTML = window.UnifiedRenderer.renderMarkdown(msg.content, { softBreaks: false });
        } catch (_) {
          body.textContent = msg.content;
        }
      } else {
        body.textContent = msg.content;
      }
    } else if (msg.status === 'sending') {
      body.innerHTML = '<span class="chat-loading"><i></i><i></i><i></i></span> 正在思考…';
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

    wrap.append(head, body);

    if (msg.role === 'assistant' && !busy) {
      const actions = document.createElement('div');
      actions.className = 'chat-msg-actions';
      const diffBtn = document.createElement('button');
      diffBtn.textContent = '查看差异';
      diffBtn.title = '先在差异中确认，再同意修改文档';
      diffBtn.addEventListener('click', () => openApply(extractProposal(msg.content)));
      const copy = document.createElement('button');
      copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(msg.content);
          toast('已复制');
        } catch (_) {
          toast('复制失败', { error: true });
        }
      });
      actions.append(diffBtn, copy);
      wrap.appendChild(actions);
    }

    if (msg.status === 'error') {
      const retry = document.createElement('div');
      retry.className = 'chat-msg-actions';
      const btn = document.createElement('button');
      btn.textContent = '重试上一条';
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

  function captureReplaceScope() {
    const cm = editor.cm;
    const docText = cm.getValue();
    const docLines = docText.split('\n');
    const hasSel = cm.somethingSelected();
    let fromLine = 1;
    let toLine = docLines.length;
    if (hasSel) {
      const a = cm.getCursor('from');
      const b = cm.getCursor('to');
      fromLine = Math.min(a.line, b.line) + 1;
      toLine = Math.max(a.line, b.line) + 1;
    }
    const baseLines = docLines.slice(fromLine - 1, toLine);
    return {
      text: baseLines.join('\n'),
      snapshot: docText,
      from: { line: fromLine - 1, ch: 0 },
      to: { line: toLine - 1, ch: (docLines[toLine - 1] || '').length },
      lines: toLine - fromLine + 1,
      isSelection: hasSel,
    };
  }

  function updateApplyState() {
    if (!applyView) return;
    const total = applyView.changeCount;
    const accepted = applyView.acceptedCount();
    const partial = total > 0 && accepted < total;
    btnApplyAccept.textContent = total ? `同意修改（${accepted}/${total} 处）` : '没有可应用的改动';
    btnApplyAccept.disabled = accepted === 0;
    btnApplyAll.classList.toggle('hidden', !partial);
    applyMetaEl.textContent = total ? `${accepted}/${total} 处改动已选` : '模型没有给出改动';
  }

  function openApply(proposal) {
    if (!proposal || !proposal.trim()) {
      toast('回复中没有可应用的内容', { error: true });
      return;
    }
    applyScope = captureReplaceScope();
    if (!applyScope.text.trim()) {
      toast('文档还是空的，没有可比较的内容', { error: true });
      return;
    }
    applyScopeEl.textContent = applyScope.isSelection
      ? `选中 ${applyScope.lines} 行 · 用回复替换这几行`
      : `整篇 ${applyScope.lines} 行 · 用回复替换全文`;
    applyView = buildDiffView(applyScope.text, proposal);
    applyView.onSelectionChange(updateApplyState);
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
  }

  function acceptApply(mode) {
    if (!applyView || !applyScope) return;
    if (editor.cm.getValue() !== applyScope.snapshot) {
      applyMetaEl.textContent = '文档在查看差异期间被改动，请关闭后重新查看差异';
      applyMetaEl.classList.add('error');
      return;
    }
    const total = applyView.changeCount;
    const accepted = mode === 'all' ? total : applyView.acceptedCount();
    if (!total || !accepted) {
      toast('没有勾选要应用的改动', { error: true });
      return;
    }
    const next = applyView.compose(mode);
    editor.cm.operation(() => editor.cm.replaceRange(next, applyScope.from, applyScope.to));
    editor.cm.focus();
    editor.cm.refresh();
    closeApply();
    toast(accepted === total ? '已同意修改，⌘Z 可撤销' : `已应用 ${accepted}/${total} 处修改，⌘Z 可撤销`);
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
        a.status === 'sending' ? '发送中' : a.status === 'sent' ? '已发送' : a.status === 'error' ? '失败' : '就绪';
      const del = document.createElement('button');
      del.className = 'ca-del mini-btn';
      del.title = '移除附件';
      del.textContent = '✕';
      del.addEventListener('click', () => {
        attachments = attachments.filter((x) => x.id !== a.id);
        renderAttachments();
      });
      item.append(name, status, del);
      attachmentsEl.appendChild(item);
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
        status: 'ready',
        text: '',
      };
      attachments.push(a);
      if (!isImage) {
        try {
          const content = await ipc.readFile(path);
          a.text = String(content || '').slice(0, MAX_TEXT_ATTACH);
        } catch (e) {
          a.status = 'error';
          a.text = `（附件读取失败：${ipc.describeError(e)}）`;
        }
      }
    }
    renderAttachments();
  }

  async function pickAttachments() {
    const paths = await ipc.pickAnyFiles();
    if (paths.length) await addPaths(paths);
  }

  function buildContextMessage() {
    if (!includeContext) return '';
    const ctx = getContext();
    if (!ctx) return '';
    const parts = [];
    parts.push(`当前文档：${ctx.path || ctx.name || '未命名'}`);
    const selected = ctx.selection && ctx.selection.trim();
    if (selected) {
      parts.push(`当前选中内容（${ctx.selection.length} 字）：\n${selected.slice(0, MAX_CONTEXT)}`);
    } else if (ctx.doc) {
      parts.push(`当前文档内容（截断至 ${MAX_CONTEXT} 字）：\n${ctx.doc.slice(0, MAX_CONTEXT)}`);
    }
    if (attachments.length) {
      const att = attachments
        .map((a) => {
          if (a.isImage) return `- 图片附件：${a.name}（路径 ${a.path}；模型是否支持视觉取决于当前服务商）`;
          return `- 文件附件：${a.name}\n${a.text || '（无可用文本）'}`;
        })
        .join('\n');
      parts.push(`用户附加的资料：\n${att}`);
    }
    return parts.join('\n\n');
  }

  async function send(text, overrideAttachments = null) {
    const content = String(text || inputEl.value || '').trim();
    if (!content || busy) return;
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
      const history = s.messages
        .filter((m) => m.status !== 'error' && m !== assistantMsg)
        .slice(-9)
        .map((m) => ({ role: m.role, content: m.content }));
      const skill = BUILTIN_SKILLS.find((k) => k.id === activeSkill && skills[k.id]);
      const system = [
        '你是 FeatherMark 编辑器内的 Markdown 协作 Agent。回答要简洁、具体、可执行。',
        '默认使用简体中文；用户用英文提问时用英文回答。需要给出正文时直接给可粘贴的 Markdown，不要加无意义的说明。',
        skill ? `\n当前启用的技能：${skill.name}\n${skill.prompt}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const ctx = buildContextMessage();
      const messages = [{ role: 'system', content: system }];
      if (ctx) messages.push({ role: 'user', content: ctx });
      messages.push(...history);

      const res = await ipc.aiChat(messages, { maxTokens: 2048, temperature: 0.3 });
      assistantMsg.content = String(res.content || '').trim();
      assistantMsg.status = 'sent';
      assistantMsg.model = res.model;
      assistantMsg.latency = res.latency_ms;
      userMsg.status = 'sent';
      userMsg.attachments.forEach((a) => (a.status = 'sent'));
      s.updatedAt = Date.now();
    } catch (e) {
      const msg = ipc.describeError(e);
      assistantMsg.content = msg;
      assistantMsg.status = 'error';
      userMsg.status = 'error';
      userMsg.attachments.forEach((a) => (a.status = 'error'));
      if (/配置|API Key|Base URL|还没/i.test(msg)) {
        assistantMsg.content = `${msg}\n\n请到「设置 → AI」填写接口地址和模型。`;
      }
    } finally {
      busy = false;
      s.updatedAt = Date.now();
      persist();
      renderMessages();
      renderSessions();
      updateSendState();
    }
  }

  function updateSendState() {
    const hasText = !!inputEl.value.trim();
    sendBtn.disabled = busy || !hasText;
    hintEl.textContent = busy ? 'Agent 正在回复…' : '⌘↵ 发送';
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
      { title: '选择模板后可配置范围与参数，执行前仍可先看逐块差异' },
    ]);
  }

  function showTemplates(anchor) {
    showMenu(anchor, [
      ...TEMPLATES.map((t) => ({
        label: t.label,
        onClick: () => fillPrompt(t.prompt),
      })),
      { sep: true },
      { title: '提示：模板只填入输入框，你仍可继续编辑后再发送' },
    ]);
  }

  function showSkills(anchor) {
    const items = [];
    for (const skill of BUILTIN_SKILLS) {
      items.push({
        title: `${skills[skill.id] ? '✓ ' : '○ '}${skill.name} — ${skill.desc}`,
      });
      items.push({
        label: skills[skill.id] ? `停用 ${skill.name}` : `启用 ${skill.name}`,
        onClick: () => {
          skills[skill.id] = !skills[skill.id];
          if (!skills[skill.id] && activeSkill === skill.id) activeSkill = null;
          persist();
          updateSkillChip();
          showSkills(anchor);
        },
      });
      if (skills[skill.id]) {
        items.push({ label: `调用 ${skill.name}`, onClick: () => useSkill(skill.id) });
      }
      items.push({ sep: true });
    }
    showMenu(anchor, items);
  }

  function useSkill(id) {
    activeSkill = id;
    updateSkillChip();
    const skill = BUILTIN_SKILLS.find((s) => s.id === id);
    if (skill && !inputEl.value.trim()) fillPrompt(`${skill.prompt}\n\n请根据当前文档上下文回答。`);
    inputEl.focus();
  }

  function updateSkillChip() {
    const skill = BUILTIN_SKILLS.find((s) => s.id === activeSkill && skills[s.id]);
    skillChip.textContent = skill ? `技能：${skill.name}` : '无技能';
    skillChip.classList.toggle('on', !!skill);
  }

  function updateContextChip() {
    contextBtn.classList.toggle('on', includeContext);
    const ctx = getContext();
    contextBtn.textContent = includeContext
      ? `上下文：${ctx ? ctx.name || ctx.path || '当前文档' : '当前文档'}`
      : '上下文：关闭';
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
  $('chat-close').addEventListener('click', () => setOpen(false));
  $('chat-templates').addEventListener('click', (e) => showTemplates(e.currentTarget));
  $('chat-edit').addEventListener('click', (e) => showEditTemplates(e.currentTarget));
  $('chat-skills').addEventListener('click', (e) => showSkills(e.currentTarget));
  $('chat-attach').addEventListener('click', () => pickAttachments());
  $('apply-close').addEventListener('click', closeApply);
  $('apply-cancel').addEventListener('click', closeApply);
  $('apply-accept').addEventListener('click', () => acceptApply('accepted'));
  $('apply-all').addEventListener('click', () => acceptApply('all'));
  applyDialog.addEventListener('pointerdown', (e) => {
    if (e.target === applyDialog) closeApply();
  });
  $('chat-sessions-toggle').addEventListener('click', (e) => {
    sessionsEl.classList.toggle('collapsed');
    e.currentTarget.classList.toggle('collapsed');
  });
  $('chat-skill-chip').addEventListener('click', (e) => showSkills(e.currentTarget));
  contextBtn.addEventListener('click', () => {
    includeContext = !includeContext;
    updateContextChip();
  });
  inputEl.addEventListener('input', updateSendState);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', () => send());

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
    const files = Array.from(e.dataTransfer?.files || []);
    const paths = files.map((f) => f.path).filter(Boolean);
    if (paths.length) await addPaths(paths);
  });

  function init() {
    setOpen(!!prefs.chatVisible);
    ensureSession();
    renderSessions();
    renderMessages();
    renderAttachments();
    updateContextChip();
    updateSkillChip();
    updateSendState();
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
