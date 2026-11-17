# FeatherMark AI 编辑 Agent Harness 架构设计（极简版）

> 目标：把现有 `src/app/agent.js`（309 行）改造成**功能与实现简单清晰**的补丁式编辑 agent。
> 用户已拍板：保留 `REPLACE/DELETE/INSERT + END` 协议、删掉 fallback、按“速度 + token 双降”验收。
> 本文档只做设计，不改代码；实现前请确认文中标为「默认假设（可推翻）」的条目。

---

## 1. 需求规格

| 维度 | 内容 | 状态 |
|---|---|---|
| 目标与用途 | 对 Markdown 选中片段或全文做轻量改写；模型只回编辑指令，本地按行号打补丁，用户先看 diff 再应用 | 已确认 |
| 成功标准 | 成功补丁 1 轮完成；输出 token p95 ≤ 当前 50%；`agent.js` 行数 ≤ 216（降 ≥30%）；应用后 `⌘Z` 可撤销 | 已确认（口径见 §10） |
| 任务结构 | 固定管线：取范围 → 组上下文 → 1 次 LLM → 解析 → 校验 → 返回 diff 文本。无动态编排 | 已确认 |
| 数据/资源边界 | 只读编辑器快照、配置里的 Base URL / 模型 / API Key；写操作只在用户点「应用替换」后由 CodeMirror 完成；密钥不进 WebView | 已确认 |
| 硬约束 | 保留补丁协议；删除整篇改写 fallback；不引入插件系统、子代理、分布式；本地离线可跑（本地模型） | 已确认 |
| 用户与场景 | 桌面端单用户；选中几行或整篇文档；对排版/措辞做小改；弱模型也要能稳定输出短补丁 | 已确认 |
| 边界（不做什么） | 不做自动多轮自愈、不做模型自评、不做事件溯源/回放、不做跨会话记忆、不做流式输出 | 默认假设（可推翻） |
| 技术栈约束 | Tauri v2 + Rust `ai_chat` IPC + 原生 ES modules + esbuild；不新增 npm 依赖 | 已确认 |

**关于“输出 token 降 50%”：诚实口径**  
纯成功路径当前已经是 1 轮、约 54 completion tokens（mock 实测），保留协议时单次成功补丁不可能稳定再砍一半。可稳定达标的是**加权 p95 / 失败路径**：删除 retry 与 fallback 后，失败任务不再产生第二轮请求和整篇重写输出。验收以 §10 的样本口径为准，而不是承诺每次成功调用都减半。

---

## 2. 架构范式 P（判据在先，案例在后）

| 子维度 | 选定 | 被否的对端 | 否决理由（含代价） |
|---|---|---|---|
| 扩展方式 | **嵌入式**：固定动词协议 + 固定校验器 | 插件化（工具注册/热插拔） | 只有 1 个外部能力（LLM），能力集不会增长。插件化至少多 3 个模块（registry/loader/lifecycle），约 +150 行，没有任何真实扩展需求 |
| 配置方式 | **命令式**：动作与提示词写在 `agent.js` 常量里 | 声明式流程配置（YAML/JSON DSL） | 流程固定为一条直线，声明式会逼出“配置里的图灵完备”，多 1 个解析器且不能带来可审计收益 |
| 部署拓扑 | **单机**：Tauri 桌面进程内 | 分布式 | 单用户、单任务、状态就是一段字符串；分布式引入一致性/网络分区/运维，规模不存在 |
| 编排模式 | **中心化**：`runAgent` 单一协调者 | 去中心化/对等 | 无多代理；对等编排无 verified harness 案例背书，且调试成本更高 |

> 判据来自 `h-framework.md` §六：任务结构固定、工具集小且稳定、要极简可维护 → 嵌入式/命令式/单机/中心化。知识库里的 `mini-SWE-agent`（约 100 行、单 bash 工具）只作选定后的对照印证，不是选型依据。本项目比它更窄：没有 shell，只有一个文本补丁协议。

---

## 3. 技术栈选型

| 项 | 选型 | 理由 |
|---|---|---|
| 语言 | JavaScript ES modules（浏览器侧） | 与现有 `src/app/*.js` 一致，无需 TS 编译链 |
| 运行时 | Tauri v2 WebView；Rust 侧 `reqwest` 代发 LLM 请求 | 复用已实现 IPC，密钥不出 Rust |
| 关键依赖 | 无新增依赖；复用 `ipc.aiChat()`、`CodeMirror.replaceRange()` | 满足“简单清晰”，避免包体积与维护面扩大 |
| 构建 | esbuild（`build.mjs` 已配置） | 继续打 `app-bundle.js` |
| LLM 接口 | OpenAI 兼容 `/chat/completions` | 用户自填 Base URL / model / extra_body，支持本地 Ollama |

---

## 4. 六层设计（决策 + 落地规格）

### 4.1 E 执行循环

- **设计决策**：严格**单轮固定管线**。`runAgent` 只做一次 LLM 调用；成功即返回，失败即抛 `AgentError`。没有 for 循环、没有 retry。
- **落地规格**：`runAgent(req: AgentRequest): Promise<AgentResult>` 顺序调用 `guardScope → buildMessages → ipc.aiChat → parseEdits → applyEdits → validatePatch`。
  - 终止条件：`validatePatch` 全部通过 → 返回；任一失败 → 抛错。
  - 熔断：一次调用；`max_tokens` 上限见 §10；Rust 侧已有 150s 超时；文档超长（默认 8000 字符）直接拒绝并提示缩小选区。

### 4.2 T 工具注册

- **设计决策**：**不建工具注册表**。唯一外部工具就是 `ipc.aiChat()`；读文档来自编辑器快照，写文档由 UI 层在用户确认后执行。
- **落地规格**：工具就是普通函数签名（§6.2）；无动态 function-calling，无 MCP，无插件目录。

### 4.3 C 上下文管理

- **设计决策**：稳定前缀 + 最小可用上下文。
  - `AGENT_SYSTEM` 从 384 字符压到 ≤200 字符（约 175 → ≤90 input tokens），且**逐字节稳定**以命中服务端 prompt cache。
  - 选中模式不再发 ±2 行上下文，改为 ±1 行；全文模式仍发全部编号行。
  - 单行编辑允许简写 `REPLACE 12` / `DELETE 12`；多行仍用 `12-14`。
- **落地规格**：`buildUserMessage(req)` 只拼三段：范围声明、编号原文、任务；不拼示例、不拼历史对话。

### 4.4 S 状态存储

- **设计决策**：**无 agent 状态存储**。每次请求是自包含的；`docSnapshot` 只作为本次调用的乐观并发校验字符串，调用结束即丢弃。
- **落地规格**：不上事件溯源（无回放/时移需求）、不上跨会话记忆（每次编辑都是新任务）。现有 `session.tabs` 负责文档恢复，与 agent 无关。

### 4.5 L 生命周期钩子

- **设计决策**：两个确定性钩子，无模型自评。
  1. **前置**：`guardScope(req)` 校验行号范围、文档长度。
  2. **后置**：`validatePatch(req, parsed, candidateLines)` 校验越界、代码围栏、排版整理的内容不变式。
- **落地规格**：钩子是普通纯函数，在 `runAgent` 里显式调用；失败抛 `AgentError`。UI 在应用前再次比对 `cm.getValue()` 与快照，防止生成期间用户改了文档。

### 4.6 V 评估接口

- **设计决策**：**确定性校验 + 独立读路径**。校验器读的是原始 `docLines` 和候选 `candidateLines`，不读模型自述。
- **落地规格**：`validatePatch()` 返回第一个错误即可，不做“第几个字符差异”的长篇解释（省约 14 行代码）；错误码见 §7.2。验收用固定样本跑回归（§10）。

---

## 5. 模块 / 目录结构（代码骨架）

```
src/
├── app/
│   ├── agent.js        # 唯一改动文件：协议常量、解析、打补丁、校验、runAgent
│   ├── ai.js           # UI 层：捕获范围、调用 runAgent、渲染 diff/错误、应用替换
│   └── ipc.js          # 不变：aiChat(messages, opts) 仍为唯一后端出口
└── ...                 # 其他模块不变
```

**预期行数**：`agent.js` 从 309 行降到 **≤216 行**（删 fallback ≈60 行、删 retry 循环 ≈25 行、删 `cleanOutput` ≈12 行、删 `firstDivergence` ≈14 行、提示词压缩 ≈8 行，基础校验保留）。

---

## 6. 关键接口签名（真实 API，类型完整）

### 6.1 数据源接口

```js
/**
 * @typedef {{role: 'system'|'user'|'assistant', content: string}} ChatMessage
 * @typedef {{content: string, model: string, usage?: object, latency_ms?: number,
 *            finish_reason?: string}} ChatResponse
 * @typedef {{maxTokens: number, temperature: number}} ChatOptions
 */

/** 来自 src/app/ipc.js（已存在，签名不变） */
// export const aiChat = (messages: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>
```

### 6.2 工具接口

```js
/**
 * @typedef {'polish'|'concise'|'expand'|'layout'|'proof'|'translate'|'custom'} AgentAction
 * @typedef {{task: string, actionId: AgentAction, docLines: string[],
 *            fromLine: number, toLine: number, isSelection: boolean}} AgentRequest
 * @typedef {{op: 'REPLACE'|'DELETE'|'INSERT', start: number, end: number,
 *            lines: string[]}} EditOp
 * @typedef {{text: string, edits: number, stats: AgentStats}} AgentResult
 * @typedef {{promptTokens: number, completionTokens: number, totalTokens: number,
 *            latency: number, model: string}} AgentStats
 */

/** 主入口：一次调用，成功返回文本，失败抛 AgentError */
export async function runAgent(req: AgentRequest): Promise<AgentResult>

/** 把模型输出解析成指令流；容错仅限：整体 ``` 围栏、CRLF、EOF 作为 END */
export function parseEdits(raw: string): { edits: EditOp[], ok: boolean, reason?: string }

/** 把指令打到切片上；从后往前 splice，保证行号不失效 */
export function applyEdits(baseLines: string[], edits: EditOp[], absStart: number):
  { lines: string[], errors: string[] }

/** 确定性校验；返回第一个问题，没有则返回 null */
export function validatePatch(req: AgentRequest, parsed: {edits: EditOp[]},
                              candidateLines: string[]): string | null
```

### 6.3 钩子接口

```js
/** 前置：范围与长度守卫；失败抛 AgentError */
function guardScope(req: AgentRequest): void

/** 后置：由 validatePatch 实现；失败抛 AgentError */
function assertValidPatch(req: AgentRequest, parsed, candidateLines): void

/** UI 层应用前钩子（在 ai.js）：快照不一致则拒绝写入 */
function assertSnapshotUnchanged(cm, snapshot: string): void
```

---

## 7. 核心数据结构

### 7.1 状态结构

无持久状态。单次调用的临时对象：

```js
const ctx = {
  req,            // AgentRequest
  snapshot: docLines.join('\n'),
  messages,       // ChatMessage[]，仅 2 条
  stats,          // AgentStats
}
```

### 7.2 消息/任务结构

见 §6.2 的 `AgentRequest` / `EditOp` / `AgentResult`。

错误类型（替代 fallback）：

```js
export class AgentError extends Error {
  /** 'BAD_PROTOCOL' | 'OUT_OF_RANGE' | 'UNBALANCED_FENCE'
   *  | 'LAYOUT_TEXT_CHANGED' | 'TRUNCATED' | 'EMPTY_OUTPUT' | 'TOO_LARGE' */
  code: string
  detail?: string
  raw?: string     // 仅内存，最多保留 600 字符用于「查看原始输出」
}
```

### 7.3 配置结构

无新增配置文件；复用 `ai-config.json`（Rust 侧 0600 保存）：

```json
{
  "provider": "custom",
  "base_url": "https://example.com/v1",
  "model": "your-model-id",
  "api_key": "sk-...",
  "temperature": 0.3,
  "max_tokens": 4096,
  "extra_body": "{}",
  "skip_temperature": false
}
```

`agent.js` 调用时只覆盖 `maxTokens` 与 `temperature`；`extra_body` / `skip_temperature` 仍由 Rust 合并（见 `ai.rs::build_body`）。

---

## 8. 配置文件格式（声明式流程 schema）

**不引入流程配置**。`agent.js` 里的动作表是唯一“配置”：

```js
const ACTIONS = [
  { id: 'polish', prompt: '只润色，不改结构和事实' },
  { id: 'layout', prompt: '只改排版，不改任何文字' },
  // ...
]
```

新增动作 = 加一条常量，不改解析/校验/循环。这是命令式但足够清晰；引入 DSL 只会多一个解析器。

---

## 9. 层间交叉检查

| 关系 | 说明 |
|---|---|
| E 终止 ↔ V 校验 | `runAgent` 的唯一终止判据是 `validatePatch` 通过；没有“模型说完成” |
| L 前置 ↔ C 上下文 | `guardScope` 先拒绝超长文档，再组上下文；避免拼出巨大 prompt |
| S 快照 ↔ L 应用 | `assertSnapshotUnchanged` 防止生成期间用户编辑被覆盖 |
| C 压缩 ↔ V 校验 | 上下文变窄后，越界风险上升；`applyEdits` 的行号检查必须保留 |
| T 单工具 ↔ P 嵌入式 | 只有 `aiChat` 一个外部能力，因此不需要注册表；两者一致 |

---

## 10. 六层决策表（量化候选对比）

| 层 | 候选方案 | 优点 | 代价（可比较量纲） | 选定 | 依据·状态 |
|---|---|---|---|---|---|
| E | 保留 1 次 retry | 弱模型成功率 +（约 5–15%） | 失败任务多 **1 次 LLM 往返**；completion tokens 约 ×2；+25 行 | 否 | 用户要简洁+速度；失败交给 UI 重试 |
| E | 删除 retry / fallback | 单轮、代码短、错误显式 | 弱模型一次失败需用户点重试 | **是** | 用户已确认删 fallback；默认假设删 retry |
| C | 当前 system 384 字符 | 协议说明完整 | ≈175 input tokens/请求 | 否 | — |
| C | 压到 ≤200 字符 | 每请求省 ≈85 input tokens；缓存后仍省计费 | 需重新验证弱模型遵守率 | **是** | 默认假设（可推翻） |
| C | 选区上下文 ±2 → ±1 | — | 每选区省 2 行 ≈20–60 input tokens | **是** | 默认假设 |
| C | 单行 `REPLACE 12` 简写 | 每个单行 op 省 ≈2–3 output tokens | 解析器多 1 个正则分支（≈2 行） | **是** | 仍保留三种动词与 END |
| V | 保留 `firstDivergence` 详细差异 | 错误更可解释 | +14 行；不影响 token | 否 | 用通用错误码 + 可选 raw 片段替代 |
| V | 保留围栏/排版不变式 | 防止破坏文档 | +约 25 行；0 LLM 成本 | **是** | 高危错误必须本地拦截 |
| T | 插件化工具表 | 可扩展 | +3 模块 / +约 150 行 / 0 实际需求 | 否 | 判据：工具集小且稳定 |
| P | 分布式/多代理 | 理论吞吐 | +网络/一致性/运维；本场景无规模 | 否 | 判据：单机单用户 |

### 验收路径（可达，不空口承诺）

1. **行数**：`wc -l src/app/agent.js` ≤216。当前 309。
2. **成功 1 轮**：mock LLM 固定返回合法补丁，`stats.rounds` 字段移除后以“只调用一次 `aiChat`”的 spy 计数断言为 1。
3. **输出 token p95**：本地 mock server 按样本返回 usage；样本 = 12 个任务（8 成功、2 协议错误、2 超长/截断）。当前实现统计 completion tokens；优化后 p95 ≤ 当前 p95 × 0.5。当前主要下降来自删掉错误任务的第二轮与整篇 fallback；成功样本只靠简写与提示词压缩小幅下降。
4. **正确性**：4 个 Node 单测覆盖 `parseEdits` 简写/多行、越界拒绝、围栏不成对、排版整理改字拒绝。
5. **环境**：macOS Apple Silicon、Node ≥18、Tauri debug 构建；mock 延迟固定 350ms，避免网络抖动影响耗时对比。真实供应商 token 计费未纳入自动验收（无 API Key），只能手工抽检。

---

## 11. 参考架构图（文字流程）

```
[Editor snapshot]
      │ guardScope(req)  ── fail ──> AgentError(TOO_LARGE)
      ▼
[buildMessages: stable system + numbered slice + task]
      ▼
ipc.aiChat(messages, {maxTokens, temperature})   ← 唯一外部调用，仅 1 次
      ▼
parseEdits(raw) ── fail ──> AgentError(BAD_PROTOCOL, raw 片段)
      ▼
applyEdits(docLines, edits, fromLine) ── fail ──> AgentError(OUT_OF_RANGE)
      ▼
validatePatch(req, parsed, candidateLines) ── fail ──> AgentError(...)
      ▼
AgentResult{text, edits, stats} ──> ai.js 渲染 diff ──> 用户点「应用替换」
                                                        │
                                        assertSnapshotUnchanged(cm)
                                                        ▼
                                             cm.replaceRange(...)  ⌘Z 可撤销
```

---

## 12. 遗留问题与未知区（诚实标注）

- **弱模型遵守率未量化**：system 压缩后，未做真实多模型 A/B；若 `BAD_PROTOCOL` 率明显上升，需要把提示词回退到完整版（这是可推翻的默认假设）。
- **token 口径**：真实供应商的 tokenizer 不同；§10 的 50% 以 mock usage 为准，换模型需重跑样本。
- **主观质量无法自动评分**：“润色是否更好”无 ground truth，只自动校验结构与不变式，质量由用户 diff 确认。
- **单轮无自愈的体验代价**：用户会看到更多显式错误；这是用“少花 token/时间”换“多一次手动重试”，需实现后观察。

---

## 13. 魔鬼代言人（反例 · 必产出）

1. **模型漏写 END，但补丁本身完整** → 旧实现可能仍应用；新严格解析若只认 END 会误报 `BAD_PROTOCOL`。  
   **缓解**：解析时把 EOF 视作隐式 END（不引入 fallback，只是终止符容错）；已写入 §6.2 的“EOF 作为 END”。

2. **单行简写 `REPLACE 12` 被弱模型误写为 `REPLACE 12-`** → 解析失败率上升，用户被迫重试。  
   **缓解**：保留完整语法 `12-14` 兼容；错误码 `BAD_PROTOCOL` 附带原始行片段，用户可一键展开定位；若样本显示 >10% 失败，撤销简写（代价：每 op 多 2–3 output tokens）。

3. **超长文档被 `guardScope` 拒绝，用户正想“全文排版整理”** → 功能看起来“坏了”。  
   **缓解**：错误信息明确给出“请选中一段（建议 ≤8000 字符）”；不做静默截断，避免生成错误补丁。

4. **删掉 fallback 后，模型偶发整篇改写会被直接拒绝** → 用户体验比旧版“至少能用”更差。  
   **接受理由**：用户已拍板删回退；整篇改写破坏“先看差异、逐块接受”的安全模型，错误显式暴露优于静默降级。UI 必须提供「重试 / 查看原始输出 / 手动粘贴」三条出路。

5. **prompt cache 因压缩 system 失效一次** → 首次调用输入成本不降反升。  
   **缓解**：压缩后冻结 system 前缀，后续请求持续命中；一次性代价可接受。

---

## 14. 范式偏见自检（必产出）

- **扩展方式**：认真评估了插件化；否决理由是可量化成本（+3 模块 / +150 行 / 0 扩展需求），不是因为案例库主流插件化。选定嵌入式，与 `mini-SWE-agent` 的极简立场一致，但判据来自本项目“只有一个 LLM 工具”的事实。
- **编排模式**：评估过去中心化/对等；本场景没有多自治实体，且该端无 verified harness 案例背书，因此选中心化并显式说明，不假装“高级”。
- **复杂度**：逐条列出被砍掉、可能为未来预留的机制——工具注册表、动态编排、多轮自愈、事件溯源、跨会话记忆、流程 DSL、模型自评。均判定为“不会发生的需求”。
- **残留风险**：唯一保留的“看起来多余”是 `extra_body` / `skip_temperature`（属于已有 AI 服务配置，不是 agent 新增机制）；它们解决真实模型差异，保留。

---

## 15. 用户决策与默认假设清单

**用户已确认**
- “简洁”= 功能及实现简单清晰。
- 保留 `REPLACE/DELETE/INSERT + END` 协议，删除 fallback。
- 验收 = 速度 + token 双降（成功 1 轮、输出 p95 ≤ 当前 50%、行数降 ≥30%）。

**默认假设（实现前可推翻）**
- 同时删除自动 retry，失败由 UI 提供手动重试。
- system prompt 压缩到 ≤200 字符，选区上下文从 ±2 改为 ±1。
- 单行 op 允许 `REPLACE 12` 简写，多行仍 `12-14`。
- EOF 视作隐式 END。
- 不再输出“第几个字符不同”的详细差异，只给错误码 + 原始输出片段。
