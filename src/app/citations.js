// 联网搜索来源解析：把后端结构化的 url_citation 与正文里的链接标注合并、去重、归一化。
// 做成纯函数，便于用 Node 原生断言单测（见 tests/agent.test.mjs 的模式）。

const MAX_CITES = 12;

function cleanTitle(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function validHttp(url) {
  return /^https?:\/\/[^\s)]+$/i.test(url);
}

/**
 * 提取来源链接。
 * @param {string} content 回复正文
 * @param {Array<{url:string,title?:string}>} structured 后端采集的 url_citation / citations
 * @returns {Array<{url:string,title:string}>} 去重后的来源列表（结构化在前）
 */
export function extractCitations(content, structured) {
  const out = [];
  const seen = new Set();
  const push = (url, title) => {
    if (!validHttp(url)) return;
    const u = url.replace(/&amp;/g, '&');
    if (seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, title: cleanTitle(title) || u.replace(/^https?:\/\//i, '').split('/')[0] });
  };

  // 1) 后端结构化的 url_citation（权威来源）
  for (const c of Array.isArray(structured) ? structured : []) {
    if (c && typeof c === 'object') push(c.url, c.title);
    else if (typeof c === 'string') push(c, '');
    if (out.length >= MAX_CITES) break;
  }

  // 2) 正文里的 markdown 链接 [文字](http...)
  const text = String(content || '');
  const mdRe = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/gi;
  let m;
  while ((m = mdRe.exec(text)) && out.length < MAX_CITES) {
    push(m[2], m[1]);
  }

  // 3) 正文里的裸 URL（补漏，排在最后）。排除中英文标点，避免把句号/逗号吞进 URL。
  const bareRe = /(?:^|[\s(])(https?:\/\/[^\s)\]>"'，。！？；：、）】》]{6,})/gi;
  while ((m = bareRe.exec(text)) && out.length < MAX_CITES) {
    push(m[1], '');
  }

  return out;
}
