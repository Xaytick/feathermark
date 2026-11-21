// 轻量 Markdown 编辑 agent。
//
// 和「把整段发给模型、让它把整段重写回来」相比，这里换了个更省的做法：
// 让模型只输出**编辑指令**（改哪几行、改成什么），本地按行号打补丁。
//
// 为什么这样更快更省：
// - 输出只包含真正变化的行。改 3 行就是 3 行，哪怕原文有 200 行；输出 token 通常降到 1/10，
//   而输出 token 是延迟的主要来源（逐 token 生成），所以墙钟时间也跟着降。
// - 指令比 JSON 短：没有字段名、没有转义、没有换行转义。
// - 系统提示保持逐字节稳定，配合各家服务端的 prompt cache（DeepSeek / OpenAI 都有），
//   重复调用时前缀命中缓存，输入侧也省。
//
// agent 的成分（不是为了「像 agent」而加，是为了让弱一点的模型也能稳稳改对）：
// 1) 协议：REPLACE / DELETE / INSERT + 行号，带转义规则；
// 2) 本地校验：行号越界、代码围栏不成对、以及「排版整理」这类动作的内容不变式——
//    这个动作要求一个字都不改，光靠提示词不可靠，本地比对字符序列能真正卡住；
// 3) 自愈：校验没过就把具体问题回喂给模型，只重试一轮（多轮会拖慢，得不偿失）；
// 4) 回退：模型不遵守协议、直接给了整段改写时，自动按整篇改写处理，不让用户卡住。
import * as ipc from './ipc.js';

/** 稳定的前缀，利于服务端 prompt cache 命中。改动要谨慎——一改缓存全失效。 */
const AGENT_SYSTEM = `你是 Markdown 编辑执行器。你只输出编辑指令，绝不重复原文。

指令语法（行号从 1 开始，含两端）：
REPLACE 起-止
<替换后的内容，可多行>
DELETE 起-止
INSERT N
<插入的内容，可多行>

说明：INSERT N 表示插到第 N 行之后，N=0 表示文首；下一条指令以行首的 REPLACE/DELETE/INSERT 开始；
最后用 END 收尾；内容行若恰好以这三个词开头，行首加一个反斜杠转义。

规则：
1. 只输出改动的行，没改的行不要出现在输出里。
2. 保持 Markdown 结构：标题层级、列表、表格、代码块围栏、链接、图片。
3. 除任务要求外不要改变语言与措辞；不确定的地方不要动。
4. 不要输出解释、前言、代码围栏包裹。

示例（把第 12 行改短）：
REPLACE 12-12
这句话更短了。
END`;

const HEADER_RE = /^(REPLACE|DELETE|INSERT)\s+(\d+)(?:\s*[-–~]\s*(\d+))?\s*$/i;
const ESCAPED_RE = /^\\(REPLACE|DELETE|INSERT)\b/i;

/** 去掉模型爱加的整体代码围栏与「改写后如下：」这类前缀。 */
export function cleanOutput(raw) {
  let text = String(raw || '').replace(/\r\n/g, '\n').trim();
  const fenced = text.match(/^```(?:markdown|md|diff)?\n([\s\S]*?)\n?```$/i);
  if (fenced) text = fenced[1].trim();
  const lines = text.split('\n');
  if (lines.length > 1 && /[：:]\s*$/.test(lines[0]) && lines[0].length <= 24 && !/^[#>\-*|`]/.test(lines[0])) {
    lines.shift();
    text = lines.join('\n').trim();
  }
  return text;
}

/** 解析指令流。容忍整体代码围栏、行尾空白、全角破折号。 */
export function parseEdits(raw) {
  const text = String(raw || '').replace(/\r/g, '').replace(/^```[a-z]*\n([\s\S]*?)\n?```$/i, '$1');
  const lines = text.split('\n');
  const edits = [];
  let cur = null;
  let sawEnd = false;

  for (const rawLine of lines) {
    const escaped = ESCAPED_RE.test(rawLine);
    const candidate = escaped ? rawLine.slice(1) : rawLine;
    const header = escaped ? null : HEADER_RE.exec(candidate);

    if (header) {
      if (cur) edits.push(cur);
      const op = header[1].toUpperCase();
      const start = Number(header[2]);
      const end = header[3] ? Number(header[3]) : start;
      cur = { op, start: Math.min(start, end), end: Math.max(start, end), lines: [] };
      continue;
    }
    if (!escaped && /^END\b\.?$/i.test(candidate.trim())) {
      if (cur) edits.push(cur);
      cur = null;
      sawEnd = true;
      continue;
    }
    if (cur) cur.lines.push(candidate);
  }
  if (cur) edits.push(cur);

  return { edits: edits.filter((e) => e.op === 'INSERT' || e.end > 0), sawEnd, text };
}

/**
 * 把指令打到 baseLines 上。absStart 是这个切片在文档中的起始行号（1 基），
 * 用来把绝对行号换算成切片内下标并做越界检查。
 */
export function applyEdits(baseLines, edits, absStart) {
  const offset = absStart - 1;
  const errors = [];
  const ops = [];

  for (const e of edits) {
    const start = e.start - offset;
    const end = e.end - offset;
    if (e.op === 'INSERT') {
      // INSERT N = 插在第 N 行之后，N 可以是 0（文首）或总行数（文末）
      if (start < 0 || start > baseLines.length) {
        errors.push(`指令 INSERT ${e.start} 越界（可编辑范围共 ${baseLines.length} 行）`);
        continue;
      }
    } else if (start < 1 || end > baseLines.length || end < start) {
      errors.push(`指令 ${e.op} ${e.start}-${e.end} 超出可编辑范围（共 ${baseLines.length} 行）`);
      continue;
    }
    ops.push({ ...e, start, end });
  }

  // 从后往前打补丁，前面的行号才不会失效
  ops.sort((a, b) => b.start - a.start || b.end - a.end);
  const out = baseLines.slice();
  for (const op of ops) {
    if (op.op === 'REPLACE') {
      out.splice(op.start - 1, op.end - op.start + 1, ...op.lines);
    } else if (op.op === 'DELETE') {
      out.splice(op.start - 1, op.end - op.start + 1);
    } else {
      out.splice(op.start, 0, ...op.lines);
    }
  }
  return { lines: out, errors };
}

/** 代码围栏必须成对，否则预览会把后面所有内容当代码。 */
export function fencesBalanced(text) {
  const fences = String(text).split('\n').filter((l) => /^\s*(```|~~~)/.test(l));
  return fences.length % 2 === 0;
}

/**
 * 「排版整理」的内容不变式：把纯格式性的东西（缩进、列表符号、标题标记、引用符、表格竖线、
 * 空白）剥掉后，两侧的字符序列必须一致。不一致就说明模型动了文字，让用户自己判断风险太大。
 */
export function contentSignature(text) {
  return String(text)
    .split('\n')
    .map((l) =>
      l
        // 标记后的空白用 \s*（可选）：排版整理常做「#标题 → # 标题」「-a → - a」这类补空格，
        // 若要求必须有空格，补空格前后签名会不等，导致纯格式改动被误判成「改了文字」。
        .replace(/^\s*([-*+]|\d+[.)])\s*/, '') // 列表标记（空格可选）
        .replace(/^#{1,6}\s*/, '') // 标题标记（空格可选）
        .replace(/^>\s?/, '') // 引用
        .replace(/\s+/g, '') // 空白
    )
    .join('')
    .replace(/[*_`~|]/g, ''); // 强调/代码/表格符号
}

/** 找出两段文字第一个不一致的位置，用于给模型的修复提示。 */
function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return { at: i, a: a.slice(Math.max(0, i - 12), i + 12), b: b.slice(Math.max(0, i - 12), i + 12) };
    }
  }
  if (a.length !== b.length) {
    const at = n;
    return { at, a: a.slice(Math.max(0, at - 12), at + 12), b: b.slice(Math.max(0, at - 12), at + 12) };
  }
  return null;
}

function numbered(lines, startNo) {
  return lines.map((l, i) => `${startNo + i}|${l}`).join('\n');
}

function buildUserMessage({ task, docLines, fromLine, toLine, isSelection }) {
  const parts = [];
  if (isSelection) {
    parts.push(
      `【文档】共 ${docLines.length} 行。你只能修改第 ${fromLine}–${toLine} 行，其余行是只读上下文。`
    );
    const ctxFrom = Math.max(1, fromLine - 2);
    const ctxTo = Math.min(docLines.length, toLine + 2);
    parts.push(`【带行号的原文】\n${numbered(docLines.slice(ctxFrom - 1, ctxTo), ctxFrom)}`);
  } else {
    parts.push(`【文档】共 ${docLines.length} 行，全部可编辑。`);
    parts.push(`【带行号的原文】\n${numbered(docLines, 1)}`);
  }
  parts.push(`【任务】${task}`);
  parts.push('按约定格式输出编辑指令，最后写 END。');
  return parts.join('\n\n');
}

function readUsage(res) {
  const u = res.usage || {};
  const prompt = u.prompt_tokens || 0;
  const completion = u.completion_tokens || 0;
  return { prompt, completion, total: u.total_tokens || prompt + completion };
}

/**
 * 跑一次编辑任务。
 * 返回 { text, mode, rounds, stats, warnings }：
 *   mode = 'patch'（按指令打补丁）| 'fallback'（模型给了整段改写）
 *   text 是最终文本，交给上层的 diff 视图去比对。
 */
export async function runAgent({ task, actionId, docLines, fromLine, toLine, isSelection, onStage }) {
  const baseLines = docLines.slice(fromLine - 1, toLine);
  const messages = [
    { role: 'system', content: AGENT_SYSTEM },
    { role: 'user', content: buildUserMessage({ task, docLines, fromLine, toLine, isSelection }) },
  ];

  const stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, latency: 0 };
  const warnings = [];
  let rounds = 0;
  let lastProblem = '';

  // 输出预算按原文长度给：补丁一般很短（几十 token），但需要兜住「模型改成整篇改写」的回退路径，
  // 也要避免 max_tokens 太小把补丁截断——截断的补丁会误删内容，比慢一点糟糕得多。
  const estimated = Math.round(baseLines.join('\n').length / 1.2) + 400;
  const callOptions = { maxTokens: Math.max(1200, Math.min(estimated, 8192)), temperature: 0.15 };

  for (let round = 0; round < 2; round++) {
    if (onStage) onStage(round === 0 ? '正在生成编辑指令…' : '校验未通过，正在修正…');
    const res = await ipc.aiChat(messages, callOptions);
    rounds++;
    const usage = readUsage(res);
    stats.promptTokens += usage.prompt;
    stats.completionTokens += usage.completion;
    stats.totalTokens += usage.total;
    stats.latency += res.latency_ms || 0;
    stats.model = res.model;

    const raw = res.content || '';
    const parsed = parseEdits(raw);

    if (parsed.edits.length) {
      const { lines, errors } = applyEdits(baseLines, parsed.edits, fromLine);
      const newText = lines.join('\n');
      const problems = [...errors];

      // 用接口的 finish_reason 判截断（比猜 END 是否出现可靠）：被判 length 说明补丁可能少了一截
      if (res.finish_reason === 'length') problems.push('输出达到长度上限被截断，请减少改动量或分批处理');

      if (!fencesBalanced(newText)) problems.push('代码围栏（```）数量不成对');

      if (actionId === 'layout') {
        const before = contentSignature(baseLines.join('\n'));
        const after = contentSignature(newText);
        if (before !== after) {
          const div = firstDivergence(before, after);
          problems.push(
            `「排版整理」不应改动文字，但第 ${div ? div.at : '?'} 个字符处出现差异：` +
              `原文「${div ? div.a : '?'}」→ 现在「${div ? div.b : '?'}」`
          );
        }
      }

      if (!problems.length) {
        return { text: newText, mode: 'patch', rounds, stats, warnings, edits: parsed.edits.length };
      }
      lastProblem = problems.join('；');
      if (round === 1) break;

      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `按上面的指令改完之后有问题：${lastProblem}\n请重新给出修正后的完整指令（从 REPLACE/DELETE/INSERT 开始，END 结束）。`,
      });
      continue;
    }

    // 没解析出指令：可能是模型直接给了改写后的全文 —— 但要先过三道护栏，
    // 否则「模型只回了一个 END」就会把整篇文档替换成那几个字。
    const fallbackText = cleanOutput(raw);
    const origText = baseLines.join('\n');
    const fragment = /^(END|REPLACE|DELETE|INSERT)\b/i.test(fallbackText.trim());
    const tooShort = origText.length > 120 && fallbackText.length < origText.length * 0.25;
    const layoutBrokeText =
      actionId === 'layout' && contentSignature(origText) !== contentSignature(fallbackText);

    if (fallbackText && !fragment && !tooShort && !layoutBrokeText) {
      warnings.push('模型未按补丁格式输出，已按整篇改写处理');
      return { text: fallbackText, mode: 'fallback', rounds, stats, warnings, edits: 0 };
    }

    if (fragment) {
      lastProblem = '输出既不是编辑指令，也不是完整文本（疑似只回了协议片段）';
    } else if (tooShort) {
      lastProblem = `输出过短：只有 ${fallbackText.length} 字，原文 ${origText.length} 字，疑似被截断`;
    } else if (layoutBrokeText) {
      lastProblem = '「排版整理」不应改动文字，但返回结果改动了文字';
    } else {
      lastProblem = '没有识别到可用的编辑指令';
    }
    if (round === 1) break;
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `请严格按 REPLACE/DELETE/INSERT + END 的格式输出编辑指令，不要改写或复述全文。（上一次问题：${lastProblem}）`,
    });
  }

  throw new Error(lastProblem || '模型没有给出可用的编辑指令');
}
