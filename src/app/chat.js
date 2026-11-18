// Agent 会话侧边栏：与编辑器共享当前文档上下文，但自己管理会话、消息和附件。
//
// 设计取舍：
// - 会话存 localStorage（按工作区隔离），不新建数据库；离线可用、重启可恢复。
// - 附件只保存路径与文本摘要：图片给预览 URL，文本文件读前若干字符作为上下文；
//   不把二进制塞进 localStorage，也不假设模型一定支持 vision。
// - AI 请求复用 ipc.aiChat（密钥仍只在 Rust 侧），失败不静默重试，直接显示可操作错误。
import { listen } from '@tauri-apps/api/event';
import * as ipc from './ipc.js';
import { prefs, savePrefs } from './store.js';
import { showMenu, toast, promptDialog } from './ui.js';
import { EDIT_TEMPLATES } from './edit-templates.js';
import { createAgentEdit } from './agent-edit.js';
import { buildDiffView } from './diff-view.js';
import { getModels, onModelsChange } from './model-list.js';
import { parseEdits, applyEdits } from './agent.js';
import { listSkills, getSkill, upsertSkill, deleteSkill, parseSkillMarkdown, toSkillMarkdown, MAX_SKILLS } from './skills.js';

const SESSION_KEY = 'feathermark.agent.sessions.v1';
const MAX_TEXT_ATTACH = 4000;
const MAX_SESSIONS = 30;
const MAX_MESSAGES = 50;
const MAX_CONTEXT = 6000;
const TEXT_ATTACH_RE = /\.(md|markdown|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|css|html|htm|xml|csv|log|ini|conf|toml|sql|sh|py|rs|go|java|c|h|cpp|hpp|rb|php|swift|kt|scala|vue|svelte)$/i;

// 聊天用问题模板。会修改文档的编辑能力统一放在 EDIT_TEMPLATES，避免重复入口。
// 编辑器自我认知：注入 system prompt，让 Agent 知道这个编辑器支持什么、文档有什么约定。
// 只保留「影响回答正确性」的事实（约 400 字），不写营销性描述，避免白白占用上下文预算。
const EDITOR_KNOWLEDGE = [
  '【编辑器环境】',
  'FeatherMark 是本地 Markdown 编辑器（Tauri + CodeMirror 5 + remark 渲染管线）。Markdown 源码是唯一真相，预览由源码实时渲染。',
  '支持的语法：',
  '- 标准 Markdown + GFM：表格、任务列表 - [ ]、删除线 ~~x~~、自动链接、有序/无序列表',
  '- 数学：行内 $...$、块级 $$...$$（KaTeX 渲染）',
  '- 图表：```mermaid 围栏代码块',
  '- 提示块：> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]，可接自定义标题',
  '- 脚注 [^1]、定义列表（定义行以 ": " 开头）',
  '- 围栏代码块按语言高亮（highlight.js）',
  '文档约定：',
  '- 图片写作 ![说明](assets/文件名.png)；本地图片存放在当前文档同目录的 assets/ 下',
  '- 界面有源码 / 分屏 / 预览三种视图，预览模式可直接编辑；导出支持单文件 HTML、长图 PNG、PDF',
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
  { label: '解释这段代码', prompt: '请解释当前代码块的作用、关键步骤和注意事项。如果有多段代码，优先解释光标附近的代码。' },
  { label: '生成大纲', prompt: '请基于当前文档生成一份简洁的大纲，并标出各章节之间的关系。' },
  { label: '找问题', prompt: '请检查当前文档，指出错别字、语病、逻辑跳跃、事实存疑和结构问题，按严重程度排序。' },
  { label: '续写下一节', prompt: '请根据当前文档的风格和结构，续写下一节内容，不要重复已有结论。' },
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
  const modelSel = $('chat-model');
  const applyDialog = $('apply-dialog');
  const applyScopeEl = $('apply-scope');
  const applyDiffEl = $('apply-diff');
  const applyMetaEl = $('apply-meta');
  const btnApplyAccept = $('apply-accept');
  const btnApplyAll = $('apply-all');
  const applyWarningEl = $('apply-warning');

  // Agent 编辑模板流程由 Agent 模块统一持有；状态栏、快捷键、菜单都通过本模块调用。
  const agentEdit = createAgentEdit({ editor, onNeedConfig: openSettings });

  let allSessions = load(SESSION_KEY, []);
  let activeId = null;
  let attachments = [];
  let includeContext = true;
  let busy = false;
  let dropDepth = 0;
  let applyView = null;
  let applyScope = null;
  let applyMsg = null;
  let applyErrors = [];
  let streamRequestId = null;
  let lastLimitToast = 0;
  let activeModel = '';

  // 持续启用的技能（chip 切换）与单次引用（斜杠命令）分开持有
  let pinnedSkillId = null;
  let onceSkillId = null;
  const workspace = () => getWorkspace() || '__global__';
  const sessions = () => allSessions.filter((s) => s.workspace === workspace());
  const active = () => allSessions.find((s) => s.id === activeId) || null;

  function enforceSessionLimits() {
    let dropped = false;
    if (allSessions.length > MAX_SESSIONS) {
      allSessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      allSessions.length = MAX_SESSIONS;
      dropped = true;
    }
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
      toast(`会话较多，已自动清理到 ${MAX_SESSIONS} 个会话 / 每会话 ${MAX_MESSAGES} 条消息`, { duration: 3200 });
    }
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

function numberedLines(lines, startNo) {
  return lines.map((l, i) => `${startNo + i}|${l}`).join('\n');
}

  function addCodeCopyButtons(container) {
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.type = 'button';
      btn.textContent = '复制';
      btn.addEventListener('click', async () => {
        const code = pre.querySelector('code');
        const clone = (code || pre).cloneNode(true);
        clone.querySelectorAll('.code-lang, .code-copy').forEach((n) => n.remove());
        let text = clone.textContent || '';
        // 部分渲染器会把围栏和语言标记留在 code 文本里，复制时统一剥掉
        text = text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制代码');
        } catch (_) {
          toast('复制失败', { error: true });
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
    who.textContent = msg.role === 'user' ? '你' : msg.role === 'assistant' ? 'Agent' : '系统';
    const time = document.createElement('span');
    time.textContent = shortTime(msg.ts || Date.now());
    const status = document.createElement('span');
    status.className = 'status' + (msg.status === 'error' ? ' error' : '');
    if (msg.status === 'sending') status.innerHTML = '<span class="chat-loading"><i></i><i></i><i></i></span>';
    else if (msg.status === 'thinking') status.textContent = '思考中';
    else if (msg.status === 'streaming') status.textContent = '生成中';
    else if (msg.status === 'stopped') status.textContent = '已停止';
    else if (msg.status === 'error') status.textContent = '失败';
    else if (msg.role === 'user' && msg.status === 'sent') status.textContent = '已发送';
    head.append(who, time, status);

    const body = document.createElement('div');
    body.className = 'chat-msg-body';
    if (msg.status === 'thinking') {
      body.textContent = '正在思考…';
    } else if (msg.status === 'streaming') {
      body.textContent = (msg.content || '') + ' ▌';
    } else if (msg.content) {
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
      if (msg.role === 'assistant') addCodeCopyButtons(body);
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
      if (msg.patch && msg.patch.length) {
        const diffBtn = document.createElement('button');
        diffBtn.textContent = '查看差异';
        diffBtn.title = '比较文档修改前后的差异，再决定是否应用';
        diffBtn.addEventListener('click', () => openApply(msg));
        actions.appendChild(diffBtn);
      }
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
      actions.appendChild(copy);
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

  function updateApplyState() {
    if (!applyView) return;
    const total = applyView.changeCount;
    const accepted = applyView.acceptedCount();
    const partial = total > 0 && accepted < total;
    btnApplyAccept.textContent = total ? `同意修改（${accepted}/${total} 处）` : '没有可应用的改动';
    const needsConfirm = !applyWarningEl.classList.contains('hidden') && !!document.getElementById('apply-confirm');
    const confirmed = !needsConfirm || !!document.getElementById('apply-confirm')?.checked;
    btnApplyAccept.disabled = accepted === 0 || !confirmed || applyErrors.length > 0;
    btnApplyAll.classList.toggle('hidden', !partial || applyErrors.length > 0);
    applyMetaEl.textContent = total ? `${accepted}/${total} 处改动已选` : '模型没有给出改动';
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
    title.innerHTML = '<strong>请注意</strong>';
    const detail = document.createElement('div');
    detail.textContent = warnings.join('；') + '。';
    applyWarningEl.append(title, detail);
    if (warnings.some((w) => /截断|不完整|长度上限/.test(w))) {
      const confirm = document.createElement('label');
      confirm.className = 'apply-confirm';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = 'apply-confirm';
      box.addEventListener('change', updateApplyState);
      confirm.appendChild(box);
      confirm.appendChild(document.createTextNode('我已确认内容完整，仍要继续'));
      applyWarningEl.appendChild(confirm);
    }
  }

  function openApply(msg) {
    if (!msg || !String(msg.content || '').trim()) {
      toast('回复中没有可应用的内容', { error: true });
      return;
    }
    const parsed = msg.patch && msg.patch.length ? { edits: msg.patch } : parseEdits(msg.content);
    if (!parsed.edits.length) {
      toast('这条回复不是编辑指令，没有可应用的修改', { error: true });
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
    applyScopeEl.textContent = `整篇 ${docLines.length} 行 · 修改前 / 修改后`;

    const warnings = [];
    if (applyMsg.finishReason === 'length') warnings.push('模型输出达到长度上限，补丁可能不完整');
    if (applyErrors.length) warnings.push(`补丁有 ${applyErrors.length} 处指令无效：${applyErrors[0]}`);
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
      applyMetaEl.textContent = '补丁中有无效指令，请先重新生成';
      applyMetaEl.classList.add('error');
      return;
    }
    if (editor.cm.getValue() !== applyScope.snapshot) {
      applyMetaEl.textContent = '文档在查看差异期间被改动，请关闭后重新查看差异';
      applyMetaEl.classList.add('error');
      return;
    }
    if (!applyWarningEl.classList.contains('hidden') && !document.getElementById('apply-confirm')?.checked) {
      toast('请先勾选“我已确认内容完整”', { error: true });
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
    const applied = accepted;
    const all = total;
    closeApply();
    pushSystemNote(`已应用修改（${applied}/${all} 处）到当前文档，⌘Z 可撤销。`);
    toast(applied === all ? '已同意修改，⌘Z 可撤销' : `已应用 ${applied}/${all} 处修改，⌘Z 可撤销`);
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
        if (!TEXT_ATTACH_RE.test(path)) {
          a.text = '（二进制或未知格式，未读取内容）';
        } else {
          try {
            const content = await ipc.readFile(path);
            a.text = String(content || '').slice(0, MAX_TEXT_ATTACH);
          } catch (e) {
            a.status = 'error';
            a.text = `（附件读取失败：${ipc.describeError(e)}）`;
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
    const ctx = includeContext ? getContext() : null;
    const parts = [];
    if (ctx) {
      const cm = editor.cm;
      const docLines = String(ctx.doc || cm.getValue()).split('\n');
      const hasSel = cm.somethingSelected();
      const a = cm.getCursor('from');
      const b = cm.getCursor('to');
      const fromLine = hasSel ? Math.min(a.line, b.line) + 1 : 1;
      const toLine = hasSel ? Math.max(a.line, b.line) + 1 : docLines.length;
      const rangeLines = docLines.slice(fromLine - 1, toLine);
      let numbered = numberedLines(rangeLines, fromLine);
      let clipped = false;
      if (numbered.length > MAX_CONTEXT) {
        numbered = numbered.slice(0, MAX_CONTEXT);
        clipped = true;
      }
      const saved = !!ctx.path;
      parts.push(`当前文档：${ctx.path || ctx.name || '未命名'}，共 ${docLines.length} 行${saved ? '' : '（尚未保存到磁盘：无法插入本地图片，需先保存）'}。`);
      parts.push(hasSel ? `可修改范围：第 ${fromLine}–${toLine} 行（其余只读）。` : '可修改范围：全文。');
      const viewName = { editor: '源码', split: '分屏', preview: '预览（所见即所得）' }[prefs.viewMode] || '分屏';
      parts.push(`用户当前视图：${viewName}。`);
      parts.push(`带行号的原文${clipped ? `（截断至 ${MAX_CONTEXT} 字）` : ''}：\n${numbered}`);
    }
    // 附件与文档上下文是两件事：关掉文档上下文时仍然要发送附件
    if (attList.length) {
      const att = attList
        .map((a) => {
          if (a.isImage) return `- 图片附件：${a.name}（路径 ${a.path}；模型是否支持视觉取决于当前服务商）`;
          return `- 文件附件：${a.name}\n${a.text || '（无可用文本）'}`;
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
      toast(`已切换模型：${clean}`);
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
      empty.textContent = '未配置模型';
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
    add.textContent = '添加模型…';
    modelSel.appendChild(add);
    modelSel.value = activeModel || (list[0] || '');
  }

  function estimateTokens(text) {
    return Math.max(1, Math.round(String(text || '').length / 2.2));
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
      const skill = getSkill(onceSkillId || pinnedSkillId);
      const system = [
        '你是 FeatherMark 编辑器内的 Markdown 协作 Agent。回答要简洁、具体、可执行。',
        '默认使用简体中文；用户用英文提问时用英文回答。',
        EDITOR_KNOWLEDGE,
        '当用户要求修改文档/选区时，只输出编辑指令，不要输出解释或整篇文档：',
        'REPLACE 起-止\n新内容（可多行）\nDELETE 起-止\nINSERT N\n新内容（可多行）\nEND',
        '行号必须取自带行号的原文；只输出改动行，没改的行不要重复。只是问问题时正常回答，不要输出编辑指令。',
        skill ? `\n当前启用的技能：${skill.name}\n${skill.prompt}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const ctx = buildContextMessage(usedAttachments);
      const messages = [{ role: 'system', content: system }];
      if (ctx) messages.push({ role: 'user', content: ctx });
      messages.push(...history);

      if (includeContext) {
        const c = getContext();
        const raw = c ? (c.selection && c.selection.trim() ? c.selection : c.doc || '') : '';
        if (raw.length > MAX_CONTEXT) {
          toast(`文档较长，本次上下文只发送前 ${MAX_CONTEXT} 字`, { duration: 3200 });
        }
      }

      const requestId = uid();
      streamRequestId = requestId;
      assistantMsg.status = 'streaming';
      renderMessages();
      const unlisten = await listen('ai-chat-stream', (event) => {
        const p = event.payload || {};
        if (p.request_id !== requestId) return;
        const payload = p.payload || {};
        if (p.type === 'thinking') {
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
        res = await ipc.aiChatStream(requestId, messages, { maxTokens: 2048, temperature: 0.3 });
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
        assistantMsg.content = `${msg}\n\n请到「设置 → AI」填写接口地址和模型。`;
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
      sendBtn.innerHTML = `${sendIcon('i-close')} 停止`;
      hintEl.textContent = streamRequestId ? '正在生成…点击「停止」' : 'Agent 正在回复…';
      return;
    }
    sendBtn.disabled = !hasText;
    sendBtn.innerHTML = `${sendIcon('i-send')} 发送`;
    const ctx = buildContextMessage(attachments);
    const est = estimateTokens(`${inputEl.value || ''}\n${ctx || ''}`);
    hintEl.textContent = `⌘↵ 发送 · 上下文约 ${est} tokens`;
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
    const all = listSkills();
    const items = [];
    if (!all.length) {
      items.push({ title: '还没有技能' });
      items.push({ label: '导入 / 新建技能…', onClick: () => openSkillsManager() });
      showMenu(anchor, items);
      return;
    }
    items.push({ title: '技能（点选切换持续启用，或单次调用）' });
    for (const skill of all) {
      const pinned = pinnedSkillId === skill.id;
      items.push({ title: `${pinned ? '● ' : '○ '}${skill.name} — ${skill.description || '无描述'}` });
      items.push({
        label: pinned ? `取消启用 ${skill.name}` : `持续启用 ${skill.name}`,
        onClick: () => {
          pinnedSkillId = pinned ? null : skill.id;
          updateSkillChip();
          toast(pinned ? `已停用「${skill.name}」` : `已持续启用「${skill.name}」`);
        },
      });
      items.push({ label: `仅本次调用 ${skill.name}`, onClick: () => useSkill(skill.id, true) });
      items.push({ sep: true });
    }
    items.push({ label: '管理技能…', onClick: () => openSkillsManager() });
    showMenu(anchor, items);
  }

  function useSkill(id, once = false) {
    const skill = getSkill(id);
    if (!skill) return;
    if (once) {
      onceSkillId = id;
      toast(`本次请求将使用「${skill.name}」`);
    } else {
      pinnedSkillId = id;
    }
    updateSkillChip();
    if (!inputEl.value.trim()) fillPrompt(`${skill.prompt}\n\n请根据当前文档上下文回答。`);
    inputEl.focus();
  }

  function updateSkillChip() {
    const skill = getSkill(pinnedSkillId) || (onceSkillId ? getSkill(onceSkillId) : null);
    const once = !pinnedSkillId && !!onceSkillId;
    skillChip.textContent = skill ? `${once ? '本次' : '技能'}：${skill.name}` : '技能';
    skillChip.classList.toggle('on', !!skill);
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
    items.push({ sep: true }, { title: 'Esc 取消' });
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
      empty.textContent = '还没有技能。点下方「新建技能」或导入 SKILL.md。';
      skillsListEl.appendChild(empty);
      return;
    }
    all.forEach((sk) => {
      const item = document.createElement('button');
      item.className = 'skills-list-item' + (editingSkillId === sk.id ? ' on' : '');
      const pin = document.createElement('span');
      pin.className = 'skills-list-pin';
      pin.textContent = pinnedSkillId === sk.id ? '●' : '○';
      pin.title = pinnedSkillId === sk.id ? '持续启用中' : '未启用';
      const name = document.createElement('span');
      name.className = 'skills-list-name';
      name.textContent = sk.name;
      const desc = document.createElement('span');
      desc.className = 'skills-list-desc';
      desc.textContent = sk.description || '无描述';
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
    if (pinnedSkillId === editingSkillId) pinnedSkillId = r.skill.id;
    if (onceSkillId === editingSkillId) onceSkillId = r.skill.id;
    editingSkillId = r.skill.id;
    updateSkillChip();
    renderSkillsList();
    formMessage('已保存');
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
    if (count) formMessage(`已导入 ${count} 个技能`);
    else if (lastErr) formMessage(lastErr, true);
  }

  function pasteSkill() {
    showMenu($('skill-paste'), [
      { title: '把 SKILL.md 内容粘贴到下方文本框' },
      { label: '从剪贴板读取并解析', onClick: async () => {
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
          formMessage('已解析，确认后点「保存技能」');
          renderSkillsList();
        } catch (e) {
          formMessage('读取剪贴板失败：' + ((e && e.message) || e), true);
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
    contextBtn.classList.toggle('on', includeContext);
    const ctx = getContext();
    contextBtn.textContent = includeContext
      ? `文档上下文：${ctx ? ctx.name || ctx.path || '当前文档' : '当前文档'}`
      : '文档上下文：关闭（附件仍会发送）';
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
      toast('当前会话还没有内容', { error: true });
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
    const ok = await ipc.confirmDialog('确定清空当前会话？此操作不可撤销。');
    if (!ok) return;
    s.messages = [];
    s.title = '新会话';
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
  contextBtn.addEventListener('click', () => {
    includeContext = !includeContext;
    updateContextChip();
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
      { title: `确认删除「${sk.name}」？` },
      { label: '删除', onClick: () => {
        deleteSkill(sk.id);
        if (pinnedSkillId === sk.id) pinnedSkillId = null;
        if (onceSkillId === sk.id) onceSkillId = null;
        updateSkillChip();
        showSkillEditor(null);
        formMessage('已删除');
      } },
    ]);
  });
  $('skill-export').addEventListener('click', exportCurrentSkill);

  inputEl.addEventListener('input', updateSendState);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // 让字符先落到输入框，再判断是否弹技能菜单
      setTimeout(() => { if (handleSlash()) e.preventDefault(); }, 0);
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
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
    renderModels();
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
