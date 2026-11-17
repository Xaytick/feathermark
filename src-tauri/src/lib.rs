// FeatherMark 桌面端后端。
//
// 设计取舍（与参考实现 TizuMark 一致）：
// - 前端不做任何文件系统访问，全部经这几个 #[tauri::command] 走 Rust，IPC 入口在前端
//   收敛到 modules/tauri-api.js 一处；权限只申请窗口/对话框，不放开 fs 插件。
// - 读取时自动探测 BOM 与 GB18030，避免中文旧文件在 macOS 上变乱码。
// - 写入前统一过 safe_write_target，拦截系统目录等危险目标。
// - 目录监听用 notify，回调里无锁、无状态，异常只上报不 panic。
use base64::Engine;
use encoding_rs::GB18030;
use md5::{Digest, Md5};
use notify::{Config as NotifyConfig, Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::ops::Deref;
use std::sync::Mutex;
mod ai;

use tauri::{Emitter, Manager};

// ---------------------------------------------------------------- 基础工具

// 结构化错误：前端按 kind 映射到 E_NOT_FOUND / E_PERMISSION / E_LOCKED / E_IO，
// 从而给出「文件不存在 / 没有权限 / 被占用 / 读写失败」四类可行动的提示。
fn io_error_json(kind: &str, path: &str, message: &str) -> String {
    serde_json::json!({
        "kind": kind,
        "path": path,
        "message": message,
    })
    .to_string()
}

fn json_err(kind: &str, path: &str, message: &str) -> String {
    format!(
        "{{\"kind\":\"{}\",\"path\":\"{}\",\"message\":\"{}\"}}",
        kind,
        path.replace('\\', "\\\\").replace('"', "\\\""),
        message.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

// 解码文本：优先 UTF-8（顺带剥 BOM），失败回落 GB18030 —— 覆盖 Windows 上大量
// 记事本/WordPad 时代留下的中文文档。
fn decode_bytes(raw: &[u8]) -> String {
    let stripped: &[u8] = if raw.len() >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF {
        &raw[3..]
    } else {
        raw
    };
    if let Ok(s) = String::from_utf8(stripped.to_vec()) {
        return s;
    }
    let (cow, _enc, _had_errors) = GB18030.decode(stripped);
    cow.into_owned()
}

/// 归一化成可比较的路径字符串：统一分隔符、去掉末尾分隔符、小写（Windows/macOS 大小写不敏感）。
fn normalize_path(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s.to_lowercase()
}

/// 写入目标安全校验：编辑器需要读写用户任意选中的文件，故不做全盘 scope 限制，
/// 只拦截系统关键目录与自启动目录这类「写进去会危害系统或被利用做持久化」的目标。
fn safe_write_target(path: &str) -> Result<std::path::PathBuf, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let p = std::path::Path::new(path);
    let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let norm = normalize_path(&canonical.to_string_lossy());

    const BLOCKED_PREFIX: &[&str] = &[
        "/system",
        "/library",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/private/etc",
        "/private/var/db",
        "/boot",
        "/dev",
        "c:/windows",
        "c:/program files",
        "c:/program files (x86)",
        "c:/programdata/microsoft/windows/start menu/programs/startup",
    ];
    for b in BLOCKED_PREFIX {
        if norm == *b || norm.starts_with(&format!("{}/", b)) {
            return Err(format!("拒绝写入受保护的系统路径：{}", path));
        }
    }
    Ok(canonical)
}

fn files_from_args(argv: Vec<String>) -> Vec<String> {
    // argv[0] 是可执行文件自身，其余才是「双击/拖到图标上」带进来的文件
    argv.into_iter().skip(1).filter(|a| !a.starts_with('-')).collect()
}

fn app_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

// ---------------------------------------------------------------- 应用 / 窗口

struct WatcherState(Mutex<Option<RecommendedWatcher>>);

#[tauri::command]
fn open_devtools(app_handle: tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.open_devtools();
    }
}

#[tauri::command]
fn get_cli_args() -> Vec<String> {
    files_from_args(std::env::args().collect())
}

#[tauri::command]
fn platform() -> String {
    app_platform().to_string()
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 自绘标题栏的窗口按钮（Windows / Linux 用；macOS 走系统红绿灯，前端不调这个）。
#[tauri::command]
fn window_action(action: String, window: tauri::WebviewWindow) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(|e| e.to_string())
            } else {
                window.maximize().map_err(|e| e.to_string())
            }
        }
        "close" => window.close().map_err(|e| e.to_string()),
        other => Err(format!("未知的窗口操作：{}", other)),
    }
}

// ---------------------------------------------------------------- 读写文件

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let raw = fs::read(&path).map_err(|e| {
        let kind = match e.kind() {
            std::io::ErrorKind::NotFound => "NotFound",
            std::io::ErrorKind::PermissionDenied => "PermissionDenied",
            _ => match e.raw_os_error() {
                // Windows ERROR_SHARING_VIOLATION；macOS 上是别的码，靠 kind 兜住
                Some(32) => "Locked",
                _ => "Io",
            },
        };
        io_error_json(kind, &path, &e.to_string())
    })?;
    Ok(decode_bytes(&raw))
}

/// 读取打包进 App 的资源（首次启动展示的 welcome.md）：dev 模式回落到项目根目录，
/// 生产模式读 Tauri 资源目录。返回真正读到的路径，前端据此解析图片相对路径。
#[tauri::command]
fn read_bundled_file(app: tauri::AppHandle, filename: String) -> Result<serde_json::Value, String> {
    use tauri::path::BaseDirectory;
    if let Ok(p) = app.path().resolve(&filename, BaseDirectory::Resource) {
        if let Ok(bytes) = fs::read(&p) {
            return Ok(serde_json::json!({
                "content": decode_bytes(&bytes),
                "path": p.to_string_lossy().to_string(),
            }));
        }
    }
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest_dir.parent() {
        let dev_path = root.join(&filename);
        if let Ok(bytes) = fs::read(&dev_path) {
            return Ok(serde_json::json!({
                "content": decode_bytes(&bytes),
                "path": dev_path.to_string_lossy().to_string(),
            }));
        }
        // welcome.md 在 assets/ 下，dev 模式也允许直接给相对路径
        let alt = root.join("assets").join(&filename);
        if let Ok(bytes) = fs::read(&alt) {
            return Ok(serde_json::json!({
                "content": decode_bytes(&bytes),
                "path": alt.to_string_lossy().to_string(),
            }));
        }
    }
    Err(json_err("NotFound", &filename, "打包资源不存在"))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    safe_write_target(&path)?;
    fs::write(&path, content.as_bytes()).map_err(|e| {
        io_error_json(
            if e.kind() == std::io::ErrorKind::PermissionDenied { "PermissionDenied" } else { "Io" },
            &path,
            &e.to_string(),
        )
    })
}

/// 导出 PNG / PDF 时前端只有 base64（canvas.toDataURL），比传 Vec<u8> 省一层 JSON 数组展开。
#[tauri::command]
fn save_base64_file(path: String, base64_data: String) -> Result<(), String> {
    safe_write_target(&path)?;
    let data = base64_data.split(',').last().unwrap_or(&base64_data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("base64 解码失败：{}", e))?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_binary_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    safe_write_target(&path)?;
    fs::write(&path, &contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    safe_write_target(&path)?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize, Clone, Copy)]
struct FileMeta {
    mtime: u64,
    size: u64,
}

#[tauri::command]
fn file_meta(path: String) -> Result<Option<FileMeta>, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Ok(None);
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(FileMeta { mtime, size: meta.len() }))
}

#[tauri::command]
fn is_directory(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

// ---------------------------------------------------------------- 目录树

// 重型/非笔记目录：不进树、不参与搜索，避免 node_modules 之类把树和搜索结果撑爆。
const IGNORE_DIRS: &[&str] = &[
    ".git", ".svn", ".hg", ".idea", ".vscode", "node_modules", "dist", "src-tauri", "target",
    "build", "out", "bin", "obj", "__pycache__", ".venv", "venv",
];

// 单目录条目上限：防止某个上万文件的目录把 DOM 卡死。
const MAX_DIR_ENTRIES: usize = 3000;

#[derive(serde::Serialize, Clone)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    created: u64,
    mtime: u64,
    size: u64,
}

#[derive(serde::Serialize)]
struct DirListing {
    entries: Vec<DirEntryInfo>,
    truncated: bool,
}

impl Deref for DirListing {
    type Target = Vec<DirEntryInfo>;
    fn deref(&self) -> &Self::Target {
        &self.entries
    }
}

#[tauri::command]
fn list_dir(path: String) -> Result<DirListing, String> {
    let p = std::path::Path::new(&path);
    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let read = fs::read_dir(p).map_err(|e| {
        io_error_json(
            if e.kind() == std::io::ErrorKind::PermissionDenied { "PermissionDenied" } else { "Io" },
            &path,
            &e.to_string(),
        )
    })?;
    for entry in read.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if is_dir && IGNORE_DIRS.contains(&name.as_str()) {
            continue;
        }
        let secs = |t: std::io::Result<std::time::SystemTime>| {
            t.ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        };
        entries.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            created: secs(meta.created()),
            mtime: secs(meta.modified()),
            size: if is_dir { 0 } else { meta.len() },
        });
        if entries.len() >= MAX_DIR_ENTRIES {
            break;
        }
    }
    let truncated = entries.len() >= MAX_DIR_ENTRIES;
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });
    Ok(DirListing { entries, truncated })
}

/// 在系统文件管理器里定位文件（macOS `open -R`、Windows `explorer /select,`、Linux 打开父目录）。
#[tauri::command]
fn reveal_in_folder(path: String, is_dir: bool) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is empty".to_string());
    }
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path).to_string();
    let spawn_res = if is_dir {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(&path).spawn()
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer").arg(&path).spawn()
        }
        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open").arg(&path).spawn()
        }
    } else {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").args(["-R", &path]).spawn()
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer").args(["/select,", &path]).spawn()
        }
        #[cfg(target_os = "linux")]
        {
            let parent = std::path::Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            std::process::Command::new("xdg-open").arg(parent).spawn()
        }
    };
    spawn_res.map_err(|e| format!("无法启动文件管理器 ({}): {}", path, e))?;
    Ok(())
}

/// 用系统默认程序打开路径/链接（导出后用浏览器看 HTML、点开外部链接）。
#[tauri::command]
fn open_path(target: String) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("target is empty".to_string());
    }
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(&target).spawn();
    #[cfg(target_os = "windows")]
    let res = std::process::Command::new("cmd").args(["/C", "start", "", &target]).spawn();
    #[cfg(target_os = "linux")]
    let res = std::process::Command::new("xdg-open").arg(&target).spawn();
    res.map_err(|e| format!("打开失败 ({}): {}", target, e))?;
    Ok(())
}

fn is_path_within(src: &str, dst: &str) -> bool {
    let s = normalize_path(src);
    let d = normalize_path(dst);
    s == d || d.starts_with(&format!("{}/", s))
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    safe_write_target(&from)?;
    safe_write_target(&to)?;
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_path(path: String) -> Result<(), String> {
    safe_write_target(&path)?;
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if !dst.exists() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    }
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_symlink() {
            continue; // 跳过符号链接，避免递归环
        }
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn copy_path(from: String, to: String) -> Result<(), String> {
    safe_write_target(&from)?;
    safe_write_target(&to)?;
    if is_path_within(&from, &to) {
        return Err("不能把路径复制到它自身或子目录里".into());
    }
    let from_p = std::path::Path::new(&from);
    if from_p.is_file() {
        fs::copy(&from, &to).map(|_| ()).map_err(|e| e.to_string())
    } else {
        copy_dir_recursive(from_p, std::path::Path::new(&to))
    }
}

#[tauri::command]
fn move_path(from: String, to: String) -> Result<(), String> {
    safe_write_target(&from)?;
    safe_write_target(&to)?;
    if is_path_within(&from, &to) {
        return Err("不能把路径移动到它自身或子目录里".into());
    }
    // 同设备 rename 是原子的；跨设备会失败，回退成 copy + remove
    match fs::rename(&from, &to) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_path(from.clone(), to)?;
            remove_path(from)
        }
    }
}

// ---------------------------------------------------------------- 目录监听

/// 监听整个工作区。前端收到 fs-changed 后防抖：重建文件树 + 检查已打开标签是否被外部改动。
#[tauri::command]
fn watch_folder(path: String, app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut state) = app.state::<WatcherState>().0.lock() {
        *state = None;
    }
    let app_handle = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<NotifyEvent>| {
            // 回调在 notify 的线程里跑：保持无锁、无状态。这里只做「有变化」的广播，
            // 具体哪些文件变了交给前端用 file_meta 比对，避免事件风暴下重复读写。
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if res.is_ok() {
                    let _ = app_handle.emit("fs-changed", ());
                }
            }));
        },
        NotifyConfig::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    if let Ok(mut state) = app.state::<WatcherState>().0.lock() {
        *state = Some(watcher); // 旧句柄在这里被 drop，监听自动停止
    }
    Ok(())
}

#[tauri::command]
fn stop_watch(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut state) = app.state::<WatcherState>().0.lock() {
        *state = None;
    }
    Ok(())
}

// ---------------------------------------------------------------- 图片

#[derive(serde::Serialize)]
struct ImageAssetInfo {
    filename: String,
    width: u32,
    height: u32,
}

/// 粘贴/拖入的图片落到 assets 目录：文件名取内容 MD5，天然去重（同一张图反复粘贴只存一份）。
#[tauri::command]
fn save_image_to_assets(bytes: Vec<u8>, ext: String, assets_dir: String) -> Result<ImageAssetInfo, String> {
    let hash = format!("{:x}", Md5::digest(&bytes));
    let ext = ext.trim_start_matches('.').to_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
    let filename = format!("{}.{}", hash, ext);
    safe_write_target(&assets_dir)?;
    let dest = std::path::Path::new(&assets_dir).join(&filename);
    fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    if !dest.exists() {
        fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }
    let (width, height) = match imagesize::blob_size(&bytes) {
        Ok(size) => (size.width as u32, size.height as u32),
        Err(_) => (0, 0),
    };
    Ok(ImageAssetInfo { filename, width, height })
}

/// 读取本地图片或下载网络图片，返回 base64（导出单文件 HTML 时把图片内联进去）。
#[tauri::command]
async fn fetch_image_as_base64(url: String) -> Result<String, String> {
    let bytes = if url.starts_with("http://") || url.starts_with("https://") {
        let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
        resp.bytes().await.map_err(|e| e.to_string())?.to_vec()
    } else {
        let raw = url.strip_prefix("file://").unwrap_or(&url);
        let canonical = std::path::Path::new(raw)
            .canonicalize()
            .map_err(|e| format!("无法解析路径 {}: {}", url, e))?;
        if !canonical.is_file() {
            return Err(format!("不是普通文件：{}", url));
        }
        fs::read(&canonical).map_err(|e| format!("读取失败 {}: {}", url, e))?
    };
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|p| p.to_string_lossy().to_string())
}

/// 系统已安装字体族名（设置里给编辑器/预览/代码块分别选字体，列表要全量可搜索）。
#[tauri::command]
async fn list_system_fonts() -> Result<Vec<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut names: std::collections::HashSet<String> = std::collections::HashSet::new();
        for face in db.faces() {
            for (family, _lang) in &face.families {
                let name = family.trim();
                if !name.is_empty() {
                    names.insert(name.to_string());
                }
            }
        }
        let mut list: Vec<String> = names.into_iter().collect();
        list.sort();
        list
    })
    .await;
    match result {
        Ok(list) => Ok(list),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------- 搜索

#[derive(serde::Serialize)]
struct FileMatch {
    path: String,
    matches: Vec<LineMatch>,
}

#[derive(serde::Serialize)]
struct LineMatch {
    line: usize, // 1-based
    col: usize,  // 1-based 字符列
    line_text: String,
}

fn search_in_files_impl(
    dir: &str,
    pattern: &str,
    case_sensitive: bool,
    use_regex: bool,
    extensions: &[String],
) -> Result<Vec<FileMatch>, String> {
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    let re: Option<regex::Regex> = if use_regex {
        Some(regex::Regex::new(pattern).map_err(|e| format!("正则无效：{}", e))?)
    } else {
        None
    };
    let pattern_lower = pattern.to_lowercase();
    let exts: Vec<String> = if extensions.is_empty() {
        vec!["md".into(), "markdown".into(), "txt".into()]
    } else {
        extensions.iter().map(|e| e.to_lowercase()).collect()
    };

    const MAX_FILES: usize = 2000;
    const MAX_PER_FILE: usize = 500;
    const MAX_TOTAL: usize = 5000;
    const MAX_LINE_TEXT: usize = 300;

    let mut results: Vec<FileMatch> = Vec::new();
    let mut total = 0usize;
    let mut file_count = 0usize;
    let mut stack: Vec<std::path::PathBuf> = vec![std::path::PathBuf::from(dir)];

    'outer: while let Some(cur) = stack.pop() {
        let rd = match fs::read_dir(&cur) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            if file_count >= MAX_FILES || total >= MAX_TOTAL {
                break 'outer;
            }
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || IGNORE_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !exts.contains(&ext) {
                continue;
            }
            let content = match fs::read(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let text = decode_bytes(&content);
            let mut file_matches: Vec<LineMatch> = Vec::new();
            for (i, line) in text.lines().enumerate() {
                if file_matches.len() >= MAX_PER_FILE {
                    break;
                }
                let byte_col = if let Some(re) = &re {
                    re.find(line).map(|m| m.start())
                } else if case_sensitive {
                    line.find(pattern)
                } else {
                    line.to_lowercase().find(&pattern_lower)
                };
                if let Some(bc) = byte_col {
                    let char_col = line[..bc].chars().count();
                    file_matches.push(LineMatch {
                        line: i + 1,
                        col: char_col + 1,
                        line_text: line.chars().take(MAX_LINE_TEXT).collect(),
                    });
                    total += 1;
                    if total >= MAX_TOTAL {
                        break;
                    }
                }
            }
            if !file_matches.is_empty() {
                results.push(FileMatch {
                    path: path.to_string_lossy().to_string(),
                    matches: file_matches,
                });
                file_count += 1;
            }
        }
    }
    Ok(results)
}

#[tauri::command]
async fn search_in_files(
    dir: String,
    pattern: String,
    case_sensitive: bool,
    use_regex: bool,
    extensions: Vec<String>,
) -> Result<Vec<FileMatch>, String> {
    search_in_files_impl(&dir, &pattern, case_sensitive, use_regex, &extensions)
}

#[derive(serde::Serialize)]
struct SearchFileEntry {
    name: String,
    path: String,
    relative_path: String,
}

/// 快速打开用的文件清单：递归遍历工作区，按扩展名过滤（None/空 = 全收），带深度与数量上限。
#[tauri::command]
fn search_files(
    path: String,
    extensions: Option<Vec<String>>,
    max_results: Option<usize>,
) -> Vec<SearchFileEntry> {
    let exts: Option<Vec<String>> = extensions.map(|v| {
        v.into_iter()
            .map(|e| e.to_lowercase())
            .filter(|e| !e.is_empty())
            .collect()
    });
    let max = max_results.unwrap_or(20000).max(1);
    let root = std::path::Path::new(&path);
    let mut results: Vec<SearchFileEntry> = Vec::new();
    let mut dir_count: usize = 0;
    if root.is_dir() {
        search_files_walk(root, root, exts.as_deref(), &mut results, &mut dir_count, 0, 24, 8000, max);
    }
    results
}

#[allow(clippy::too_many_arguments)]
fn search_files_walk(
    dir: &std::path::Path,
    root: &std::path::Path,
    exts: Option<&[String]>,
    results: &mut Vec<SearchFileEntry>,
    dir_count: &mut usize,
    depth: usize,
    max_depth: usize,
    max_dirs: usize,
    max_results: usize,
) {
    if depth > max_depth || *dir_count > max_dirs || results.len() >= max_results {
        return;
    }
    *dir_count += 1;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // 权限不足的目录：跳过，不影响其它分支
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if IGNORE_DIRS.contains(&name.as_str()) {
                continue;
            }
            search_files_walk(&path, root, exts, results, dir_count, depth + 1, max_depth, max_dirs, max_results);
            continue;
        }
        if let Some(list) = exts {
            if list.is_empty() {
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !list.contains(&ext) {
                continue;
            }
        }
        let relative = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        results.push(SearchFileEntry { name, path: path.to_string_lossy().to_string(), relative_path: relative });
        if results.len() >= max_results {
            return;
        }
    }
}

// ---------------------------------------------------------------- 入口

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 重复启动时：聚焦已有窗口，并把新实例带的文件交给它打开
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let files = files_from_args(argv);
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .manage(WatcherState(Mutex::new(None)))
        .manage(ai::StreamCancels::default())
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            get_cli_args,
            platform,
            quit_app,
            window_action,
            read_file,
            read_bundled_file,
            write_file,
            save_base64_file,
            write_binary_file,
            ensure_dir,
            file_meta,
            is_directory,
            list_dir,
            reveal_in_folder,
            open_path,
            rename_path,
            remove_path,
            copy_path,
            move_path,
            watch_folder,
            stop_watch,
            save_image_to_assets,
            fetch_image_as_base64,
            app_data_dir,
            list_system_fonts,
            search_in_files,
            search_files,
            ai::ai_config_get,
            ai::ai_config_set,
            ai::ai_config_clear_key,
            ai::ai_chat,
            ai::ai_chat_stream,
            ai::ai_chat_stream_cancel,
            ai::ai_test,
            ai::ai_models,
        ])
        .run(tauri::generate_context!())
        .expect("启动 FeatherMark 失败");
}
