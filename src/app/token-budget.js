// token 估算与预算：对话链路与编辑链路共用，避免两处实现漂移。
// 估算不求精确，只求「同向且不偏离数量级」——中文约 1.5 token/字，英文约 4 字符/token，
// 数字/标点按半字符折算。给用户的提示与给模型的预算都用这一份。

export function estimateTokens(text) {
  const s = String(text || '');
  let units = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code > 0x2e80) units += 1.5;      // CJK
    else if (/[0-9]/.test(ch)) units += 0.5;
    else if (/\s/.test(ch)) units += 0.25;
    else units += 0.25;                   // 英文约 4 字符 1 token
  }
  return Math.max(1, Math.round(units));
}

/** 按任务类型给输出预算：写作/翻译类需要更长输出，问答/补丁较短。 */
export function outputBudget(kind, contextText = '') {
  const ctxTokens = estimateTokens(contextText);
  const caps = {
    chat: 2048,
    write: 4096,
    translate: 4096,
    patch: Math.max(1200, Math.min(8192, Math.round(ctxTokens * 0.5) + 400)),
  };
  return caps[kind] || caps.chat;
}

/**
 * 按 token 预算挑选最近的历史消息。
 * @param {Array<{role,content}>} history 从旧到新
 * @param {number} budget 可用 token 预算（默认 6000）
 * @returns {Array} 被保留的消息（仍是最近的、顺序不变）
 */
export function selectHistory(history, budget = 6000) {
  const kept = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const cost = estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    if (used + cost > budget && kept.length) break;
    kept.unshift(m);
    used += cost;
  }
  return kept;
}
