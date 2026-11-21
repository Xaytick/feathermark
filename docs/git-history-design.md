# 编辑历史 — 基于 Git 独立 ref 的实现方案


> **注意（v0.4.39 起已作废）**：本文描述的「用户仓库 + 独立 ref」方案已被
> `docs/history-toggle-design.md` 的重构方案取代。历史现存于应用私有 git 仓库，
> 永不接触用户仓库。本文仅作设计演进记录保留。

> 状态：设计稿，尚未实现。用户已拍板：**用 git2 + 用户仓库的独立 ref 命名空间**。
> 目标：每次 AI 编辑留下可回溯的版本，不污染用户的 git log，但可用标准 git 工具查看。

## 1. 决策与验证结论

用户选择「用户仓库 + 独立 ref 命名空间 + git2」。三项关键技术验证均通过：

| 验证项 | 结果 |
|---|---|
| 独立 ref 是否污染主分支 log | ✅ `git log` 只有用户提交；`git log refs/feathermark/<file>` 才显示 AI 历史 |
| 能否不碰工作区写入历史 | ✅ 用 `hash-object` / `mktree` / `commit-tree` / `update-ref` 底层 API，工作区和 index 完全不动 |
| git2 能否在项目工具链编译 | ✅ macOS `cargo check` 通过；**`cargo xwin check` 通过**（裸 `cargo check --target` 因缺 SDK headers 失败，但项目用的就是 xwin，无影响） |

代价：二进制约 +7MB（15→22MB）；Windows 交叉编译必须走 `cargo xwin`（现有脚本已如此）。

## 2. 核心概念：独立 ref 命名空间

每个文档一个 ref：`refs/feathermark/<file-key>`。

- **不污染用户**：AI 版本不进 `HEAD`、不进任何 branch、不出现在普通 `git log`。
- **外部可见**：`git log refs/feathermark/note.md` 能看到完整历史，VS Code 的 git 插件刷新后也能看到这些 ref（虽不显示为分支）。
- **磁盘格式兼容**：就是标准 git commit，用户能用 `git show` 看任意版本内容。

`<file-key>` 用相对工作区的安全路径（如 `docs/note.md` → `docs__note.md`），
需通过 `git check-ref-format` 规则校验，非法字符做百分号编码。

## 3. commit 结构

每个版本是一个 commit，父节点指向**上一个 AI 版本**（第一版的父指向用户仓库的 HEAD，形成分叉点）：

```
用户提交链:  C1 ── C2 ── C3  (HEAD, main)
                    │
AI ref 链:          └── A1 ── A2 ── A3   refs/feathermark/note.md
```

- **commit message**：`feathermark: 润色 · 2026-11-21 13:55`（模板名 + 时间）
- **commit 内容**：该版本文档的完整 tree（内容寻址自动去重 + zlib 压缩，等价于之前自研方案的"基线+增量"，但由 git 免费提供）
- **commit 元数据**：`feathermark.label`、`feathermark.source`、`feathermark.tokens` 等放 commit message 的 trailer 或 notes（可选）
- **不写工作区**：用 `Repository::blob()` / `TreeBuilder` / `commit()` + `reference()` 底层 API

## 4. Rust 后端新增命令（src-tauri/src/history.rs）

```rust
/// 记录一个 AI 编辑版本。doc 是即将写入的新全文；不碰工作区文件。
#[tauri::command]
pub fn history_record(
    workspace: String,     // 工作区根目录（git 仓库）
    file_key: String,      // 相对路径 / 安全键
    doc: String,           // 版本全文
    label: String,         // 模板名/保存/恢复点
    meta: Option<Value>,   // token、模型等
) -> Result<String, String>;  // 返回 commit id

/// 列出某文档的版本历史（新→旧），含 id/message/time/label
#[tauri::command]
pub fn history_list(workspace: String, file_key: String) -> Result<Vec<VersionInfo>, String>;

/// 取出某版本的文档全文（git show <commit>:<path>）
#[tauri::command]
pub fn history_doc(workspace: String, commit_id: String) -> Result<String, String>;

/// 删除某文档的全部历史 ref（可选）
#[tauri::command]
pub fn history_clear(workspace: String, file_key: String) -> Result<(), String>;

/// 检测工作区是否 git 仓库（决定 UI 是否显示历史入口）
#[tauri::command]
pub fn history_is_repo(workspace: String) -> bool;
```

实现要点：
- `Repository::discover(workspace)` 找仓库（支持子目录）
- 历史 ref 不存在时，父节点取 `repo.head()`；存在时取 ref 当前 commit
- 用 `repo.blob(doc.as_bytes())` → `TreeBuilder::insert(path, blob, 0o100644)` → `tree.write()` → `repo.commit(Some(ref_name), sig, sig, msg, &tree, &[parent])`
- 全部操作只在对象库 + ref 上，**不调用 checkout、不写 index、不改工作区**

## 5. 前端集成

| 文件 | 改动 |
|---|---|
| `src/app/ipc.js` | 加 5 个 history 命令封装 |
| `src/app/main.js` | 写回点调用 `historyRecord`；菜单「编辑历史…」；恢复回调 |
| `src/app/agent-edit.js` | `applyChanges` 写回前记录（afterDoc = compose 结果） |
| `src/app/chat.js` | 接受修改写回前记录 |
| `src/app/history-panel.js`（新） | 历史面板：列表 + diff + 恢复/另存 |
| `src/index.html` / `styles.css` / `i18n.js` | 面板 UI + 中英文案 |

- 写回点传 `afterDoc`（新全文），与 git 方案只需一份——比自研增量方案更简单。
- 历史面板 diff 用 `buildDiffView(historyDoc, currentDoc)`，复用现有组件。
- 恢复：二次确认后 `cm.replaceRange(historyDoc, 全文范围)`，并先记录一条 `source='restore'` 的版本。

## 6. 边界与风险

1. **工作区不是 git 仓库**：UI 不显示历史入口（或提示"先 git init"）。用户明确选了"用户仓库"方案，这是预期行为。
2. **detached HEAD / 无提交**：仓库无 HEAD 时第一版父节点留空，仍能写历史。
3. **文件被 gitignore**：无关——我们不 add 到 index，直接写 blob + tree，gitignore 不影响。
4. **ref 名冲突**：用 `git check-ref-format` 校验；路径含特殊字符做编码。
5. **性能**：git 对象写入是本地操作，毫秒级；`history_list` 遍历 ref 链，30 条内无压力。
6. **用户误删 .git**：历史随之丢失——这是"存在用户仓库"方案的固有代价，接受。
7. **commit 作者身份**：用一个固定身份（如 `FeatherMark <feathermark@local>`），不依赖用户 git config。

## 7. 与「外部 git」的关系

- AI 历史在独立 ref，用户自己的 commit / branch / tag 完全不受影响。
- 用户想看：`git log refs/feathermark/<file-key>`；想比对：`git diff HEAD refs/feathermark/<file-key> -- <path>`。
- 未来增强（本轮不做）：若用户希望 AI 编辑落成正式 commit，只需在设置里切换，把 ref 改成 branch 即可——底层已全是标准 git commit。

## 8. 分阶段落地

- **P1 Rust 命令 + 单测**：history_record/list/doc，前置条件检测（工作区是 git 仓库）。
- **P2 写回点接入**：三处调用 history_record，用 git CLI 验证 ref 链正确、工作区干净。
- **P3 历史面板**：列表 + diff + 恢复/另存 + 入口 + i18n。
- **P4 打磨**：ref 名编码、错误提示、设置项（开关）、Windows 包体积确认。

## 9. 验收标准

1. 在文档中做一次 AI 润色，`git log` 仍只有用户自己的提交；`git log refs/feathermark/<file>` 多出一条 `feathermark: 润色`。
2. git 工作区保持干净（AI 写历史不产生未提交改动）——用 `git status --short` 确认。
3. `history_doc` 取出的内容与当时写入的新全文完全一致。
4. 恢复到某版本后，文档内容 = 该版本历史内容，且历史里多出一条 `恢复点`。
5. Windows 交叉编译（`./scripts/build-windows.sh`）通过，产物可运行。
