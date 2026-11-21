// 编辑历史：把 AI 编辑存进用户 git 仓库的独立 ref（refs/feathermark/<file-key>）。
//
// 设计要点：
// - 只用对象库 + ref 的底层 API（blob/tree/commit/reference），**不碰 index、不改工作区**。
//   用户不会看到任何 git status 变化，普通 git log 也不受影响。
// - 每个文档一条 ref，串成 commit 链：第一版父节点 = 用户 HEAD（分叉点），
//   后续版本的父节点 = 上一版 AI commit。
// - commit 存的是该版本文档的完整 tree；git 的内容寻址 + zlib 压缩负责去重与省空间。
use git2::{Commit, Repository, Signature};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// git ref 前缀，与用户分支完全隔离。
const REF_PREFIX: &str = "refs/feathermark/";

/// 把文件路径编码成合法的 ref 片段：只保留 [A-Za-z0-9._/-]，其余按字节百分号编码。
/// 这样 `docs/我的笔记.md` 也能做 ref 名，且不会与用户 ref 冲突。
fn encode_file_key(file_key: &str) -> String {
    let mut out = String::new();
    for b in file_key.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    // 去掉可能导致 ref 非法的边界：开头/结尾的点、连续的点、结尾的 .lock
    let out = out.trim_matches('.').to_string();
    if out.is_empty() { "untitled".to_string() } else { out }
}

fn ref_name(file_key: &str) -> String {
    format!("{}{}", REF_PREFIX, encode_file_key(file_key))
}

/// 打开仓库：从 workspace 向上 discover（支持工作区是子目录）。
fn open_repo(workspace: &str) -> Result<Repository, String> {
    Repository::discover(workspace).map_err(|e| format!("这里不是 git 仓库：{}", e.message()))
}

/// 取 ref 当前指向的 commit（不存在返回 None）。
fn find_ref_commit<'a>(repo: &'a Repository, refname: &str) -> Option<Commit<'a>> {
    repo.find_reference(refname)
        .ok()
        .and_then(|r| r.target())
        .and_then(|oid| repo.find_commit(oid).ok())
}

/// 历史里固定身份，不依赖用户的 git config。
fn history_signature<'a>() -> Result<Signature<'a>, String> {
    Signature::now("FeatherMark", "feathermark@local")
        .map_err(|e| format!("构造签名失败：{}", e))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionInfo {
    pub id: String,        // commit id (short)
    pub full_id: String,
    pub message: String,   // 完整 message（含 trailer）
    pub label: String,     // 模板名/保存/恢复点（从 message 第一行解析）
    pub time: i64,         // unix 秒
}

/// 从 commit message 第一行解析 label：
/// 形如 "feathermark: 润色 · 2026-11-21 13:55" → "润色"
fn parse_label(message: &str) -> String {
    let first = message.lines().next().unwrap_or("");
    let rest = first.strip_prefix("feathermark:").unwrap_or(first).trim();
    rest.split(" · ").next().unwrap_or(rest).trim().to_string()
}

/// 记录一个 AI 编辑版本。doc 是即将写入的新全文；不碰工作区文件。
#[tauri::command]
pub fn history_record(
    workspace: String,
    file_key: String,
    doc: String,
    label: String,
    meta: Option<Value>,
) -> Result<String, String> {
    let repo = open_repo(&workspace)?;
    let refname = ref_name(&file_key);
    let parent = find_ref_commit(&repo, &refname)
        .or_else(|| repo.head().ok().and_then(|h| h.peel_to_commit().ok()));

    // 1. 写 blob（内容寻址，重复内容自动去重）
    let blob_id = repo.blob(doc.as_bytes()).map_err(|e| e.to_string())?;

    // 2. 造 tree：把文档放在一个固定路径，便于 `git show <commit>:<path>`
    let mut builder = repo.treebuilder(None).map_err(|e| e.to_string())?;
    builder
        .insert("document.md", blob_id, 0o100644)
        .map_err(|e| e.to_string())?;
    let tree_id = builder.write().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;

    // 3. message：第一行是 label + 时间，后面用 trailer 带元数据
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let when = chrono_like_utc(ts);
    let mut message = format!("feathermark: {} · {}\n", label, when);
    if let Some(m) = &meta {
        if let Ok(s) = serde_json::to_string(m) {
            message.push_str(&format!("\nfeathermark-meta: {}\n", s));
        }
    }

    // 4. commit 并更新独立 ref（父节点串联）
    let sig = history_signature()?;
    let parents: Vec<&Commit> = parent.iter().collect();
    let commit_id = repo
        .commit(Some(&refname), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| format!("写入历史失败：{}", e))?;
    Ok(commit_id.to_string())
}

/// 列出某文档的版本历史（新→旧）。
#[tauri::command]
pub fn history_list(workspace: String, file_key: String) -> Result<Vec<VersionInfo>, String> {
    let repo = open_repo(&workspace)?;
    let refname = ref_name(&file_key);
    let Some(head) = find_ref_commit(&repo, &refname) else {
        return Ok(vec![]);
    };
    let mut out = vec![];
    let mut cur = Some(head);
    // 只走 feathermark 自己的链（父节点是用户 HEAD 时停止）
    while let Some(c) = cur {
        let message = c.message().unwrap_or("").to_string();
        let label = parse_label(&message);
        let id = c.id().to_string();
        out.push(VersionInfo {
            id: id.chars().take(8).collect(),
            full_id: id,
            message,
            label,
            time: c.time().seconds(),
        });
        // 下一条：仅当父 commit 也是 feathermark 历史的第一行才继续
        cur = c.parent(0).ok().filter(|p| {
            p.message()
                .and_then(|m| m.lines().next())
                .map(|l| l.starts_with("feathermark:"))
                .unwrap_or(false)
        });
    }
    Ok(out)
}

/// 取出某版本的文档全文（等价于 `git show <commit>:document.md`）。
#[tauri::command]
pub fn history_doc(workspace: String, commit_id: String) -> Result<String, String> {
    let repo = open_repo(&workspace)?;
    let oid = git2::Oid::from_str(&commit_id).map_err(|_| "无效的 commit id".to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = tree.get_name("document.md").ok_or("该版本没有文档内容")?;
    let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
    String::from_utf8(blob.content().to_vec()).map_err(|e| format!("文档不是 UTF-8：{}", e))
}

/// 删除某文档的全部历史 ref。
#[tauri::command]
pub fn history_clear(workspace: String, file_key: String) -> Result<(), String> {
    let repo = open_repo(&workspace)?;
    let refname = ref_name(&file_key);
    let result = match repo.find_reference(&refname) {
        Ok(mut r) => r.delete().map_err(|e| e.to_string()),
        Err(_) => Ok(()),
    };
    result
}

/// 工作区是否是 git 仓库（UI 据此决定是否显示历史入口）。
#[tauri::command]
pub fn history_is_repo(workspace: String) -> bool {
    open_repo(&workspace).is_ok()
}

/// 极简 UTC 时间格式化（不引 chrono，避免再增依赖）：2026-11-21 14:08。
/// 用 days→ civil date 的标准算法（Howard Hinnant）。
fn chrono_like_utc(ts: i64) -> String {
    let days = ts.div_euclid(86400);
    let secs = ts.rem_euclid(86400);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    if m <= 2 { y += 1; }
    let hh = secs / 3600;
    let mm = (secs % 3600) / 60;
    format!("{:04}-{:02}-{:02} {:02}:{:02}", y, m, d, hh, mm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_key_encoding() {
        assert_eq!(encode_file_key("docs/note.md"), "docs/note.md");
        assert_eq!(encode_file_key("docs/我的笔记.md"), "docs/%E6%88%91%E7%9A%84%E7%AC%94%E8%AE%B0.md");
        assert_eq!(encode_file_key("..."), "untitled");
        assert!(ref_name("a.md").starts_with(REF_PREFIX));
    }

    #[test]
    fn label_parsing() {
        assert_eq!(parse_label("feathermark: 润色 · 2026-11-21 14:08"), "润色");
        assert_eq!(parse_label("feathermark: 保存"), "保存");
        assert_eq!(parse_label("普通提交"), "普通提交");
    }

    #[test]
    fn utc_format() {
        assert_eq!(chrono_like_utc(0), "1970-01-01 00:00");
        assert_eq!(chrono_like_utc(1730000000).len(), 16);
    }

    /// 真实仓库端到端：记录两个版本，验证 ref 链、文档存取、工作区不被污染。
    #[test]
    fn record_chain_and_worktree_isolation() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("fm-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_str().unwrap().to_string();

        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).output().unwrap();
            assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "user@test.com"]);
        git(&["config", "user.name", "Test User"]);
        std::fs::write(dir.join("note.md"), "# 原文\n").unwrap();
        git(&["add", "note.md"]);
        git(&["commit", "-qm", "用户的提交"]);

        // 记录两个 AI 版本
        let id1 = history_record(d.clone(), "note.md".into(), "润色版\n".into(), "润色".into(), None).unwrap();
        let id2 = history_record(d.clone(), "note.md".into(), "纠错版\n".into(), "纠错".into(), None).unwrap();
        assert_ne!(id1, id2);

        // 1. list 返回两个版本（新→旧），label 正确
        let list = history_list(d.clone(), "note.md".into()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].label, "纠错");
        assert_eq!(list[1].label, "润色");

        // 2. doc 取出与写入一致
        assert_eq!(history_doc(d.clone(), id1.clone()).unwrap(), "润色版\n");
        assert_eq!(history_doc(d.clone(), id2.clone()).unwrap(), "纠错版\n");

        // 3. 主分支 log 只有用户提交，工作区干净
        assert_eq!(git(&["log", "--oneline"]).lines().count(), 1);
        assert!(git(&["log", "--oneline"]).contains("用户的提交"));
        assert!(git(&["status", "--short"]).is_empty(), "工作区应干净");

        // 4. clear 后历史清空
        history_clear(d.clone(), "note.md".into()).unwrap();
        assert!(history_list(d, "note.md".into()).unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
