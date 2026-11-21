// 编辑历史：把 AI 编辑存进**应用私有 git 仓库**（App Data / history）。
//
// 设计要点：
// - git 只作存储引擎（内容寻址 + delta 压缩 + 成熟 diff），不当用户工作区。
//   **永不 discover / init / 读取用户的任何 git 仓库**，用户目录与提交完全不受影响。
// - 每个文档（docKey = 绝对路径，未保存用 untitled/<name>）一条 ref：
//   refs/feathermark/<md5(docKey)>；commit 串成链，第一版无父节点（私有仓库无 HEAD）。
// - commit 的 tree 里放 document.md（版本全文），git show <commit>:document.md 可取回。
use git2::{Commit, Repository, Signature};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

/// git ref 前缀，与任何用户分支命名隔离。
const REF_PREFIX: &str = "refs/feathermark/";
/// 私有仓库在 App Data 下的子目录名。
const HISTORY_DIR: &str = "history";

/// docKey → ref 名：用 md5 生成稳定的 32 位 hex，规避路径字符/长度/中文等 ref 合法性问题。
/// md5 在这里只作内容定址，不用于安全用途。
fn ref_name(doc_key: &str) -> String {
    let normalized = doc_key.replace('\\', "/");
    let mut hasher = Md5::new();
    hasher.update(normalized.as_bytes());
    let hex: String = hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    format!("{}{}", REF_PREFIX, hex)
}

/// 打开（或首次创建）应用私有历史仓库。返回 (仓库, 路径字符串)。
fn open_history_repo(app: &tauri::AppHandle) -> Result<(Repository, String), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{}", e))?
        .join(HISTORY_DIR);
    let path = dir.to_string_lossy().to_string();
    let repo = if dir.join(".git").exists() || dir.join("HEAD").exists() {
        Repository::open(&dir).map_err(|e| format!("历史存储打开失败：{}", e))?
    } else {
        std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建历史存储目录：{}", e))?;
        Repository::init(&dir).map_err(|e| format!("无法创建历史存储：{}", e))?
    };
    Ok((repo, path))
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
    pub label: String,     // 模板名/来源（从 message 第一行解析）
    pub time: i64,         // unix 秒
}

/// 从 commit message 第一行解析 label：
/// 形如 "feathermark: 润色 · 2026-11-21 13:55" → "润色"
fn parse_label(message: &str) -> String {
    let first = message.lines().next().unwrap_or("");
    let rest = first.strip_prefix("feathermark:").unwrap_or(first).trim();
    rest.split(" · ").next().unwrap_or(rest).trim().to_string()
}

/// 记录一个 AI 编辑版本。doc 是即将写入的新全文；不碰任何用户文件/仓库。
#[tauri::command]
pub fn history_record(
    app: tauri::AppHandle,
    doc_key: String,
    doc: String,
    label: String,
    meta: Option<Value>,
) -> Result<String, String> {
    let (repo, _) = open_history_repo(&app)?;
    let refname = ref_name(&doc_key);
    // 私有仓库无 HEAD：仅当该 ref 已有历史时串父节点，第一版父节点留空。
    let parent = find_ref_commit(&repo, &refname);

    // 1. 写 blob（内容寻址，重复内容自动去重）
    let blob_id = repo.blob(doc.as_bytes()).map_err(|e| e.to_string())?;

    // 2. 造 tree：把文档放在固定路径，便于 `git show <commit>:document.md`
    let mut builder = repo.treebuilder(None).map_err(|e| e.to_string())?;
    builder
        .insert("document.md", blob_id, 0o100644)
        .map_err(|e| e.to_string())?;
    let tree_id = builder.write().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;

    // 3. message：第一行 label + 时间，可选 trailer 带元数据
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let mut message = format!("feathermark: {} · {}\n", label, chrono_like_utc(ts));
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
pub fn history_list(app: tauri::AppHandle, doc_key: String) -> Result<Vec<VersionInfo>, String> {
    let (repo, _) = open_history_repo(&app)?;
    let refname = ref_name(&doc_key);
    let Some(head) = find_ref_commit(&repo, &refname) else {
        return Ok(vec![]);
    };
    let mut out = vec![];
    let mut cur = Some(head);
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
        // 只沿 feathermark 自己写的 commit 链回溯
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
pub fn history_doc(app: tauri::AppHandle, commit_id: String) -> Result<String, String> {
    let (repo, _) = open_history_repo(&app)?;
    let oid = git2::Oid::from_str(&commit_id).map_err(|_| "无效的 commit id".to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = tree.get_name("document.md").ok_or("该版本没有文档内容")?;
    let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
    String::from_utf8(blob.content().to_vec()).map_err(|e| format!("文档不是 UTF-8：{}", e))
}

/// 删除某文档的全部历史 ref。
#[tauri::command]
pub fn history_clear(app: tauri::AppHandle, doc_key: String) -> Result<(), String> {
    let (repo, _) = open_history_repo(&app)?;
    let refname = ref_name(&doc_key);
    let result = match repo.find_reference(&refname) {
        Ok(mut r) => r.delete().map_err(|e| e.to_string()),
        Err(_) => Ok(()),
    };
    result
}

/// 删除私有仓库中所有 feathermark 历史 ref（不删仓库本身、不碰任何用户仓库）。
#[tauri::command]
pub fn history_clear_all(app: tauri::AppHandle) -> Result<usize, String> {
    let (repo, _) = open_history_repo(&app)?;
    let mut removed = 0usize;
    let refs: Vec<String> = repo
        .references()
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter_map(|r| r.name().map(|s| s.to_string()))
        .filter(|n| n.starts_with(REF_PREFIX))
        .collect();
    for name in refs {
        if repo.find_reference(&name).and_then(|mut r| r.delete()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 返回私有历史仓库路径（设置面板显示，便于高级用户自行 git log 查看）。
/// 不创建仓库——只是算路径，无副作用。
#[tauri::command]
pub fn history_storage_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{}", e))?
        .join(HISTORY_DIR);
    Ok(dir.to_string_lossy().to_string())
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
    fn ref_name_is_hash_and_stable() {
        let r1 = ref_name("/Users/me/note.md");
        let r2 = ref_name("/Users/me/note.md");
        assert_eq!(r1, r2);
        assert!(r1.starts_with(REF_PREFIX));
        assert_eq!(r1.len(), REF_PREFIX.len() + 32);
        // 不同文档键 → 不同 ref；同一路径的 \ 和 / 归一化后相同
        assert_ne!(ref_name("/a.md"), ref_name("/b.md"));
        assert_eq!(ref_name("C:\\docs\\a.md"), ref_name("C:/docs/a.md"));
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

    /// 用纯 git2 API 在临时目录复刻私有仓库的完整生命周期：
    /// 建仓库 → 无 HEAD 写第一条 → 串第二条 → 取回 → 清空 ref。
    /// 关键验证：私有仓库无 HEAD 也能工作，且不产生任何用户工作区文件。
    #[test]
    fn private_repo_chain_without_head() {
        let dir = std::env::temp_dir().join(format!("fm-private-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = Repository::init(&dir).unwrap();
        let refname = ref_name("/virtual/doc.md");

        let write = |text: &str, label: &str, parent: Option<Commit>| -> String {
            let blob = repo.blob(text.as_bytes()).unwrap();
            let mut b = repo.treebuilder(None).unwrap();
            b.insert("document.md", blob, 0o100644).unwrap();
            let tree = repo.find_tree(b.write().unwrap()).unwrap();
            let sig = Signature::now("FeatherMark", "feathermark@local").unwrap();
            let parents: Vec<&Commit> = parent.iter().collect();
            let msg = format!("feathermark: {} · 2026-11-21 14:00", label);
            repo.commit(Some(refname.as_str()), &sig, &sig, &msg, &tree, &parents)
                .unwrap().to_string()
        };

        let c1 = write("版本一\n", "润色", None);
        let p1 = repo.find_commit(git2::Oid::from_str(&c1).unwrap()).unwrap();
        let c2 = write("版本二\n", "纠错", Some(p1));

        // 无 HEAD
        assert!(repo.head().is_err(), "私有仓库不应有 HEAD");
        // 链：head → parent
        {
            let head = repo.find_commit(git2::Oid::from_str(&c2).unwrap()).unwrap();
            assert_eq!(head.parent(0).unwrap().id().to_string(), c1);
            // 取回内容
            let tree = head.tree().unwrap();
            let blob = repo.find_blob(tree.get_name("document.md").unwrap().id()).unwrap();
            assert_eq!(std::str::from_utf8(blob.content()).unwrap(), "版本二\n");
            // 目录里除了 .git 没有别的（不碰工作区）
            let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
            assert_eq!(entries.len(), 1, "私有仓库目录只应有 .git");
            assert!(entries[0].file_name().to_str().unwrap() == ".git");
        }

        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
