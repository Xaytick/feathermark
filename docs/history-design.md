# 编辑历史快照与版本对比 — 实现方案

> 状态：设计稿，尚未实现。目标：让每次 AI 编辑（及手动存盘）留下可回溯的版本，
> 用户能对比「任意版本 ↔ 当前文档」并一键恢复，把线性 ⌘Z 升级为可管理的版本历史。
> **存储模型采用 git 式「基线快照 + 行级增量」**，而非每版存全文（见 §3）。

## 1. 现状与问题

- 撤销只有 CodeMirror 的 ⌘Z 线性历史：一旦中间又手动编辑，很难精确回到某个 AI 版本。
- 写回点有两处，都直接 `cm.replaceRange`：
  - `agent-edit.js:applyChanges()` — 模板编辑写回
  - `chat.js` 的 `openApply`/接受修改 — 对话补丁写回
- 文档状态在 `tab.doc` / `tab.savedDoc`；会话持久化在 `store.js` 的 `session`（`feathermark.session.v1`，400ms 节流）。
- 已有可复用能力：`diff-view.js` 的 `buildDiffView(old, new)` 能生成逐块 diff。

## 2. 设计目标与非目标

**目标**
1. 每次 AI 写回前自动存一份「修改前」快照，附带操作元数据（模板名/token/时间/范围）。
2. 手动 Ctrl/Cmd+S 存盘时也打一个点（可选，默认开）。
3. 历史面板：按时间线列出当前标签的快照；选中任意快照与当前文档做 diff；支持恢复到编辑器 / 另存为新文件。
4. 持久化到 localStorage，重启后仍在。

**非目标（本轮不做）**
- 不做多人协同、云端同步、分支树。
- 不做全文搜索历史内容、不做快照 diff 的逐块部分恢复（只整体恢复）。
- 不改变现有 ⌘Z 行为，二者并存。

## 3. 存储模型：git 式「基线 + 增量」

### 3.1 为什么不是每版全文

实测（180 行 README、模拟 20 次每次改 2–3 行）：
- 每版存全文累计 **125.2 KB**；
- 只存带位置的行级增量累计 **2.7 KB**，省 **98%**。

Git 的逻辑模型也是「每个提交指向完整快照」，省空间靠 blob 去重 + packfile delta——
所以我们做的是同一件事的轻量版：**基线存全文，之后只存 diff**。

### 3.2 关键取舍（必须接受）

增量不是免费午餐，三点代价要在设计里正面处理：

| 维度 | 全量快照 | 纯增量链 |
|---|---|---|
| 存储 | O(n×size) | O(size + n×patch)，省 ~98% |
| 随机访问第 k 版 | O(1) 直接读 | O(k) 回放 k 个 patch |
| 鲁棒性 | 单条损坏只丢一版 | 任一 patch 损坏 → 之后全废 |

**解法：基线 + 检查点（checkpoint）混合。**
- 每个标签只在**链首存一份全文基线**；
- 之后每版存 patch；
- 每 10 版强制做一次全文检查点（相当于 git gc 的轻量版），把链长钉在 ≤10；
- 这样随机访问最多回放 10 步，中间任一 patch 损坏最多影响 10 版，且可从最近检查点重建。

### 3.3 数据结构

独立 key `feathermark.history.v2`（v1 全量方案未实现，直接上 v2）：

```js
{
  version: 2,
  byFile: {                    // 稳定键：path 优先，未命名用 name（见 §8）
    [fileKey]: {
      base: {                  // 基线：某版本的全文
        id, ts, doc: '……', docHash
      },
      checkpoints: [           // 全文检查点，每 10 版一个，含链首
        { id, ts, doc, docHash, at: 0 }   // at = 在链中的序号，用于快速定位
      ],
      versions: [              // 版本链，新→旧；每项 = 相对「前一版」的增量
        {
          id: 'v_xxx',
          ts: 1730000000000,
          label: '润色',        // 模板名 / '保存' / '手动打点' / '恢复点'
          source: 'template' | 'chat' | 'save' | 'manual' | 'restore',
          patch: [              // unified-diff 风格：带位置才能回放
            { at: 12, del: ['旧行'], add: ['新行'] },   // at = 1 基行号
            { at: 30, del: [], add: ['插入行'] }
          ],
          docHash: 'md5',       // 该版本的全文 hash：校验 + 定位检查点
          meta: { promptTokens, completionTokens, model, latencyMs, edits }
        }
      ]
    }
  }
}
```

### 3.4 patch 生成与回放

- **生成**：用 `diff-view.js` 的 `diffLines(before, after)`（已验证 7/7 无损往返），
  把 `same` 行跳过、连续 `del`/`add` 聚成 hunk，记录起始行号。
- **回放**：从最近检查点的 `doc` 出发，`patch` 按 `at` **从大到小**应用（行号不失效，
  与 `agent.js:applyEdits` 同一技巧），得到任意版本全文。
- **校验**：回放后用 `docHash` 比对，不一致则回退到上一个检查点并标记链损坏（UI 提示「历史链部分损坏」）。
- **去重**：`docHash` 与上一版相同则不产生新版本。
- **上限**：每文件 30 版，超过淘汰最旧；淘汰时若删掉的是检查点，把下一个全文检查点提升为基线。

## 4. 模块划分

新增 `src/app/history.js`（纯数据层，不 import 其他模块，靠注入）：

```js
export function createHistory({
  now = Date.now, uid, hash, diffLines,           // 全是可注入的纯函数
  limit = 30, checkpointEvery = 10, localStorageKey = 'feathermark.history.v2'
}) {
  return {
    list(fileKey),                  // 版本元数据数组（新→旧，不含全文）
    create(fileKey, { beforeDoc, afterDoc, label, source, meta }),
      // 内部：diffLines(before,after) → patch；每 10 版或首版写全文检查点
      // 返回版本对象或 null（内容未变被去重）
    docAt(fileKey, versionId),      // ★ 回放：从最近检查点 apply patch 得到该版全文
      // 用 docHash 校验，损坏则回退上一个检查点并标记
    remove(fileKey, versionId),     // 删除后重建后续 patch 链（或提升检查点）
    clear(fileKey),
    pruneGlobal(maxTotal),
  };
}
```

`diffLines` 从 `diff-view.js` 提取成独立纯函数导出（目前是模块内私有），便于注入和单测。
理由：与项目「纯模块 + 依赖注入」的既有风格一致（照 `store.js` / `chat.js` 的 create* 模式），便于单测。

## 5. 版本创建时机（关键）

在**三处写回点的 `replaceRange` 之前**调用 `history.create({ beforeDoc, afterDoc, ... })`：

1. `agent-edit.js:applyChanges()` — `cm.operation(...)` 前，`beforeDoc = scope.snapshot`（生成前全文，已有），`afterDoc = view.compose()`（即将写入的新全文，已有），`label = template.label`，`source='template'`，`meta` 取 `result` 的 token/模型/edits。
2. `chat.js` 接受修改处 — `replaceRange` 前，`beforeDoc = applyScope.snapshot`，`afterDoc = 即将写入的 next`。
3. `saveTab()` — 存盘前，`beforeDoc = tab.savedDoc`、`afterDoc = tab.doc`；内容未变会被 hash 去重。

**为什么需要 before 和 after 两份**：增量版本记录的是「从 before 到 after 的 diff」，两份都要有才能生成 patch（全量方案只需 before）。两份数据在三处写回点都已存在，无需额外抓取。

**不影响现有护栏**：两处写回点已有「生成期间文档被改动则拒绝写回」的比对（`scope.snapshot` / `applyScope.snapshot`）。history.create 放在比对通过之后、replaceRange 之前，顺序不变。

## 6. UI 交互

新增 `index.html` 的 `#history-dialog`（参照 `#apply-dialog` 结构）：

- **左侧时间线**：每条显示 `标签 · 相对时间 · 摘要（改动行数/token）`；当前文档状态置顶为「当前」项。
- **右侧 diff 区**：`history.docAt(fileKey, versionId)` 回放出版本文本，再复用 `buildDiffView(versionDoc, currentDoc)` —— 展示「该版本 → 当前」的差异。
  - 注意方向：左是历史、右是现在，让用户看清「从那时到现在改了什么」。
- **底部操作**：
  - `恢复到编辑器`：二次确认后 `cm.replaceRange(versionDoc, 全文范围)`；恢复前先自动打一个 `source='restore'` 的版本（before=当前，after=被恢复内容）。
  - `另存为新文件`：触发 `pickSavePath` 把回放出的 doc 写出。
  - `删除此版本` / `清空该文件历史`。
- **入口**：更多菜单加「编辑历史…」；标题栏可加一个时钟图标按钮（可选）。
- **i18n**：新增 key 走 `i18n.js`（`history.title` 等），与现有中英体系一致。

## 7. 与现有的集成点清单

| 文件 | 改动 |
|---|---|
| `src/app/history.js` | 新建，增量数据层（create/docAt/checkpoint/prune） |
| `src/app/diff-view.js` | 把 `diffLines` 提取为导出纯函数供 history 注入 |
| `src/app/main.js` | 实例化 history；`saveTab` 打点；菜单入口；恢复回调 |
| `src/app/agent-edit.js` | `applyChanges` 写回前打点（注入 history） |
| `src/app/chat.js` | 接受修改写回前打点（注入 history） |
| `src/index.html` | 新增 `#history-dialog` |
| `src/styles.css` | 时间线 + 面板样式 |
| `src/app/i18n.js` | 历史面板文案 |
| `tests/history.test.mjs` | 单测：patch 无损往返、检查点回放、hash 校验与损坏回退、去重、上限 |

注入方式：`createChat` / `createAgentEdit` 的入参增加 `history`，由 main 统一传入（延续现有依赖注入风格，不新增跨模块 import）。

## 8. 关键边界与风险

1. **链式损坏**：任一 patch 损坏会影响其后最多 10 版（检查点间隔）。`docAt` 用 docHash 校验，不一致回退到上一个检查点并在 UI 标注「该版本数据已损坏」。
2. **恢复覆盖未保存改动**：恢复前先打 `restore` 版本，且二次确认提示「当前未保存的改动会保留为一个版本」。
3. **稳定键**：标签 id 是运行时随机 `uid`，重启会重新生成 → 历史对不上。
   - **对策**：索引用「稳定键」——有 path 用 path，无 path 用 `name`（未命名标签）。这是本方案最需要注意的一点。
4. **增量与全文的取舍**：如果未来要支持「按内容搜索历史版本」，增量链需回放全部版本才能搜——那种需求下应另建全文索引，不属本轮。
5. **性能**：`diffLines` 的 LCS 是 O(n·m)，已有 `n*m>600000` 退化的兜底思路（需从 diff-view 提取时保留）；回放 ≤10 步，每步行级 splice，开销可忽略。

## 9. 分阶段落地

- **P1 数据层**：history.js + 单测（patch 无损往返、检查点、hash 校验、去重、上限、损坏回退）。
- **P2 自动打点**：三处写回/存盘接入，先不露 UI，验证 localStorage 里存的是增量而非全文。
- **P3 历史面板**：dialog + docAt 回放 + diff + 恢复/另存 + 入口 + i18n。
- **P4 打磨**：稳定键迁移、链修复、设置项（开关/上限/检查点间隔）。

## 10. 验收标准

1. 用「润色」改一段后，历史面板出现一条 `润色` 版本；点开 diff 显示「该版本 → 当前」。
2. 连续两次无变化的操作只产生一条版本（hash 去重生效）。
3. 恢复到某版本后，当前文档内容 = 该版本内容；且历史里多出一条 `恢复点`。
4. 重启应用后，同一文件的历史仍在（稳定键生效）。
5. **存储验证**：180 行文档做 20 次编辑，历史数据总量应接近实测的 ~3KB 而非 ~125KB（证明走的是增量）。
6. **检查点验证**：做满 20 版后，版本链里应存在 ≥2 个全文检查点，任意版本 `docAt` 回放结果与当时写入的 afterDoc 完全一致。
