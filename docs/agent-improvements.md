# Agent 能力优化技术方案

> 版本：v0.1（2026-11-25）
> 依据版本：`ef0b750`（含 ⌘ 快捷键修复、Tavily 联网检索）
> 范围：FeatherMark 内置 Agent（对话式 + 模板编辑式）
> 目标：在不改变产品定位（轻量、离线优先、密钥不出本机）的前提下，提升读写准确性、回复可读性、交互便捷性，并补齐技能自动选用。

---

## 0. 现状架构（先统一认识）

Agent 由**两条独立链路**组成，能力并不对等，这是多数问题的根源：

| 链路 | 入口 | 调用方式 | 输出 | 校验/自愈 |
| --- | --- | --- | --- | --- |
| 对话式 Agent | 右侧 Agent 面板（`chat.js`） | `ipc.aiChatStream`（流式） | 普通回答 / 补丁（REPLACE/DELETE/INSERT） | 仅补丁越界检查 |
| 模板编辑 Agent | 编辑弹窗 / ⌘J（`agent-edit.js` + `agent.js`） | `ipc.aiChat`（非流式） | 补丁 → 逐块 diff | 越界 + 围栏成对 + 排版不变式 + 一轮自愈 + 整篇回退护栏 |

后端边界统一在 `src-tauri/src/ai.rs`：配置本地落盘（0600）、代发 OpenAI 兼容请求、Tavily 联网检索、SSE 事件（`chunk/thinking/searching/search_done/search_error/done/cancelled/error`）。前端不持明文密钥。

---

## 1. 读写准确性

### 1.1 对话补丁缺少模板链路的护栏
- 现状证据：`chat.js:490-526` `openApply` 只做 `applyEdits` 越界检查；`agent.js:250-262` 的 `fencesBalanced`、`contentSignature`（排版不变式）未复用到对话路径。
- 风险：补丁围栏不成对导致预览吞掉后续内容；「排版」意图下误改文字。
- 方案：在 `openApply` 中、构造 diff 前调用 `fencesBalanced(applied.lines.join('\n'))`，失败则写入 `showApplyWarnings`；识别到「排版/整理格式」意图时跑 `contentSignature` 前后比对。复用 `agent.js` 已导出函数，不重复实现。
- 验收：构造一个围栏不成对的补丁，`查看差异`弹窗出现明确 warning 且默认禁用「应用」。

### 1.2 对话输出预算固定
- 现状证据：`chat.js:907` 固定 `maxTokens: 2048, temperature: 0.3`；模板链路有按原文长度估算（`agent.js:225-226`）。
- 风险：长文写作/长补丁被截断（`finish_reason=length`），截断补丁可能误删内容。
- 方案：把估算逻辑抽为 `shared/estimateBudget.js`，对话按任务类型给预算（问答 2048、写作/翻译 ≥4096、按上下文长度封顶）；设置页暴露「输出上限」高级项。
- 验收：触发一次长文写作，`finish_reason` 不再为 `length`；预算随任务类型变化。

### 1.3 上下文截断单位与提示不一致
- 现状证据：`chat.js:713-723` 用 `numbered.length`（行数）对比 `MAX_CONTEXT=6000`，注释写"截断至 6000 字"；`buildContextMessage` 仍宣称"共 N 行/可修改范围全文"。
- 风险：长文档只发送一部分，模型却对未发送部分编行号。
- 方案：统一按**字符**截断；注入文本里显式写"仅发送第 a–b 行（共 N 行），其余不可见，不要引用未发送行号"。
- 验收：>6000 字文档发送后，模型回答不引用未发送行号；注入文本包含截断说明。

### 1.4 历史无 token 预算
- 现状证据：`chat.js:829` `slice(-9)`。
- 方案：以 token 估算累计回溯，超预算丢弃最早轮次；超长会话生成滚动摘要。
- 验收：长对话不遗忘近期约束，且不超模型上下文。

---

## 2. 回复可读性（P0 首选）

### 2.1 Agent 回复不渲染公式/图表/高亮
- 现状证据：`chat.js:321-332` 仅 `UnifiedRenderer.renderMarkdown` + `addCodeCopyButtons`；系统提示却声明支持 mermaid（`chat.js:38`）。
- 方案：终态渲染后调用与预览一致的后处理（参考 `preview.js:96-147`）：`renderMathInElement`、`mermaid.run({nodes})`、`hljs.highlightElement`；外链补 `target=_blank rel=noopener`。
- 验收：让 Agent 输出含 `$E=mc^2$`、```mermaid 块、```js 块，回复区分别渲染为公式、图、着色代码。

### 2.2 流式阶段纯文本
- 现状证据：`chat.js:319-320` 流式 `body.textContent = content + ' ▌'`。
- 方案：流式按帧节流（~80ms）走 `renderMarkdown` + sanitize；至少对代码围栏做轻量格式化；性能不足时退化为纯文本。
- 验收：流式生成代码块/列表时可读，无明显卡顿。

### 2.3 其它
- 代码块加语言标签与折叠；长消息折叠；会话内搜索。
- 验收：长回复可折叠，代码块显示语言。

---

## 3. 交互便捷性

- 重新生成：复用 `send`，剔除当前 assistant 消息后重发同一条 user 消息。
- 编辑重发：用户消息可编辑并重新发送（形成分支或覆盖）。
- 输入历史：输入框 ↑ 召回上一条。
- 会话管理：重命名 / 搜索 / 置顶；新会话快捷键。
- token 估算：`chat.js:789` 由 `length/2.2` 改为中英分档（中文≈1字1.5token、英文≈4字符1token），状态栏估算更可信。
- 验收：上述操作均可用且不打断输入焦点。

---

## 4. 联网搜索

现状（`ai.rs`）：Tavily `/search` → `results[].title/url/content` 注入 messages（带 `[编号]`）→ 来源随返回值给前端。

| 项 | 现状 | 方案 | 验收 |
| --- | --- | --- | --- |
| 检索词质量 | `last_user_text` 直接取整条用户输入 | 先让模型产出 1–3 个精炼 query，可并行检索后合并去重 | 长/含指令的问题也能命中 |
| 编号与来源对应 | `ai.rs:403` 仅"建议"标注 | 来源区为唯一事实来源；或把 `[n]` 后处理为可点击锚点 | 点击编号跳到对应来源 |
| 失败可见性 | `search_error` 仅 toast | 消息 meta 固化"本次未联网" | 失败时消息有明确标记 |
| 成本/时效 | 单 query、无缓存、未用 `topic/time_range` | 短时结果缓存；时效问题自动带 `time_range` | 重复问题不重复扣费 |

---

## 5. 文件处理

- 图片：默认 path（模型看不到图）。→ 小图默认 data URL + canvas 压缩（限制长边与字节），大图提示；明确"路径模式模型不可见图"。
- data URL：无压缩/上限。→ 加尺寸与大小上限，防爆 token/请求体。
- 文本附件：取前 4000 字（`chat.js:682`）→ 注入处标注"仅前 4000 字"。
- 解析：不支持 PDF/DOCX → 至少 PDF 抽文本（轻量解析）。
- 工作区引用：Agent 不能主动读其它文件 → 增加 `@文件名` 引用或受控读取。
- 验收：发图可识别；大附件有明确截断提示；`@文件` 能把工作区文件纳入上下文。

---

## 6. 技能管理与自动选用（P2 重点）

现状：技能=可复用 prompt（`skills.js`）；选用仅手动 pin（chip）与斜杠 once（`chat.js:140/831`）；一次只能一个；`pinnedSkillId` 重启丢失；正文上限 6000 字全量注入。

方案：
1. 自动推荐：发送前用 `name+description` 做匹配（先规则/关键词，后小模型打分），在输入框上方给"建议启用：X"一键启用；置信度高时自动附加。
2. 多技能叠加：允许多个技能按序拼接，限制数量与总 prompt 预算。
3. 按需注入：长技能正文摘要化或按段注入。
4. 持久化：`pinnedSkillId` 落 localStorage。
5. 参数化：借鉴 `edit-templates.js` `ParamSpec`，技能支持填参（如目标语言、风格）。
- 验收：输入与某技能描述匹配的请求时出现推荐；pin 重启后仍在；多技能可叠加且不超预算。

---

## 7. 优先级与工作量

| 优先级 | 事项 | 主要改动文件 | 风险/回归点 |
| --- | --- | --- | --- |
| P0 | 回复渲染（公式/图表/高亮） | `chat.js` messageNode | XSS（走 sanitize）、Mermaid 异步时序 |
| P0 | 对话补丁护栏复用 | `chat.js` openApply | 误拦截正常补丁 |
| P0 | 上下文截断单位/标注 | `chat.js` buildContextMessage | 长文档行为变化 |
| P0 | 流式 markdown 渲染 | `chat.js` messageNode | 性能、半截 markdown |
| P1 | 动态输出预算 | `chat.js`/`agent.js`/shared | token 成本上升 |
| P1 | token 预算历史 | `chat.js` | 遗忘早期约束 |
| P1 | 联网 query 改写 | `ai.rs` | 多一次模型调用延迟 |
| P1 | 图片压缩与默认策略 | `chat.js` 附件 | 大图清晰度 |
| P2 | 技能自动推荐/多技能/参数化 | `skills.js`/`chat.js` | 误推荐、prompt 膨胀 |
| P2 | 重新生成/编辑重发/@文件 | `chat.js` | 会话状态一致性 |

---

## 8. 全局约束（任何改动都需遵守）

- 密钥与 HTTP 仅在 Rust 侧；前端不持久化二进制附件；`localStorage` 会话/技能有上限。
- 所有 AI 输出经 sanitize；不引入远程脚本/样式。
- 保持系统提示前缀稳定以利 prompt cache；新增能力尽量复用 `agent.js`/`edit-templates.js` 已有函数，避免双份实现漂移。
- 每个 P0/P1 项附浏览器或真实 GUI 验证；不以 mock 替代真实模块验证（此前 ⌘ 键修复的教训）。
