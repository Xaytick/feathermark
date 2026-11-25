// 原生菜单栏：中英双语，运行时可切换。
//
// 设计：
// - 所有「应用级动作」（新建/打开/保存/视图切换/设置…）都是带稳定 id 的 MenuItem，
//   点击后 emit("menu-action", id)，由前端接管道具栏已有的同名动作；这样菜单与前端
//   只有一层 id 契约，文案变化不影响行为。
// - 系统级动作（关于/服务/隐藏/退出/最小化/最大化/关闭窗口）用 PredefinedMenuItem，
//   它们的文案由操作系统本地化——但我们会显式传中文 text，保证中文模式一致。
// - 语言选择持久化到 app_data_dir/language.txt，启动时读取；set_language 命令重建菜单。
use tauri::menu::{
    Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Manager, Runtime};

const LANG_FILE: &str = "language.txt";

/// 应用界面语言。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Locale {
    Zh,
    En,
}

impl Locale {
    pub fn from_str(s: &str) -> Self {
        if s.to_ascii_lowercase().starts_with("zh") { Locale::Zh } else { Locale::En }
    }
    pub fn as_str(self) -> &'static str {
        match self { Locale::Zh => "zh", Locale::En => "en" }
    }
}

fn lang_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(LANG_FILE))
}

/// 读取持久化语言；无文件或读取失败时默认中文（本项目用户以中文为主）。
pub fn load_locale<R: Runtime>(app: &AppHandle<R>) -> Locale {
    lang_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| Locale::from_str(s.trim()))
        .unwrap_or(Locale::Zh)
}

/// 保存语言选择。
pub fn save_locale<R: Runtime>(app: &AppHandle<R>, locale: Locale) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(LANG_FILE), locale.as_str()).map_err(|e| e.to_string())
}

// 文案表：一个函数返回一对 (中文, 英文)。
fn t(locale: Locale, zh: &'static str, en: &'static str) -> String {
    match locale { Locale::Zh => zh.to_string(), Locale::En => en.to_string() }
}

/// 带 id 的菜单项：点击时把 id 发给前端。
fn item<R: Runtime, M: Manager<R>>(
    m: &M, locale: Locale, id: &str, zh: &'static str, en: &'static str, accel: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(m, id, t(locale, zh, en), true, accel)
}

/// 子菜单。
fn sub<R: Runtime, M: Manager<R>>(
    m: &M, id: &str, locale: Locale, zh: &'static str, en: &'static str,
) -> tauri::Result<Submenu<R>> {
    Submenu::with_id(m, id, t(locale, zh, en), true)
}

/// 构建完整菜单栏。
pub fn build_menu<R: Runtime>(app: &AppHandle<R>, locale: Locale) -> tauri::Result<Menu<R>> {
    let sep = || PredefinedMenuItem::separator(app);

    // ---- 应用菜单（macOS 第一项）：关于 / 服务 / 隐藏 / 退出 ----
    let app_menu = sub(app, "app", locale, "&FeatherMark", "&FeatherMark")?;
    app_menu.append(&PredefinedMenuItem::about(
        app,
        Some(&t(locale, "关于 FeatherMark", "About FeatherMark")),
        None,
    )?)?;
    app_menu.append(&sep()?)?;
    app_menu.append(&PredefinedMenuItem::services(
        app,
        Some(&t(locale, "服务", "Services")),
    )?)?;
    app_menu.append(&sep()?)?;
    app_menu.append(&PredefinedMenuItem::hide(
        app,
        Some(&t(locale, "隐藏 FeatherMark", "Hide FeatherMark")),
    )?)?;
    app_menu.append(&PredefinedMenuItem::hide_others(
        app,
        Some(&t(locale, "隐藏其他", "Hide Others")),
    )?)?;
    app_menu.append(&sep()?)?;
    app_menu.append(&PredefinedMenuItem::quit(
        app,
        Some(&t(locale, "退出 FeatherMark", "Quit FeatherMark")),
    )?)?;

    // ---- 文件 ----
    let file = sub(app, "file", locale, "&文件", "&File")?;
    file.append(&item(app, locale, "file.new", "新建", "New", None)?)?;
    file.append(&item(app, locale, "file.open", "打开文件…", "Open File…", None)?)?;
    file.append(&item(app, locale, "file.open_folder", "打开文件夹…", "Open Folder…", None)?)?;
    file.append(&sep()?)?;
    file.append(&item(app, locale, "file.save", "保存", "Save", None)?)?;
    file.append(&item(app, locale, "file.save_as", "另存为…", "Save As…", None)?)?;
    file.append(&sep()?)?;
    let export = sub(app, "file.export", locale, "导出", "Export")?;
    export.append(&item(app, locale, "file.export_html", "导出 HTML", "Export HTML", None)?)?;
    export.append(&item(app, locale, "file.export_png", "导出长图 PNG", "Export PNG", None)?)?;
    export.append(&item(app, locale, "file.export_pdf", "导出 PDF", "Export PDF", None)?)?;
    file.append(&export)?;
    file.append(&sep()?)?;
    file.append(&item(app, locale, "file.close", "关闭标签", "Close Tab", None)?)?;

    // ---- 编辑 ----
    // 撤销/重做/剪切/复制/粘贴/全选必须用系统标准项（PredefinedMenuItem），
    // macOS 才会把这些 action 接进 WebView 的 responder chain，⌘Z/⌘X/⌘C/⌘V/⌘A
    // 才能在输入框和编辑器里原生工作。自定义 MenuItem 带 id 不会触发这些系统 action。
    let edit = sub(app, "edit", locale, "&编辑", "&Edit")?;
    edit.append(&PredefinedMenuItem::undo(app, Some(&t(locale, "撤销", "Undo")))?)?;
    edit.append(&PredefinedMenuItem::redo(app, Some(&t(locale, "重做", "Redo")))?)?;
    edit.append(&sep()?)?;
    edit.append(&PredefinedMenuItem::cut(app, Some(&t(locale, "剪切", "Cut")))?)?;
    edit.append(&PredefinedMenuItem::copy(app, Some(&t(locale, "复制", "Copy")))?)?;
    edit.append(&PredefinedMenuItem::paste(app, Some(&t(locale, "粘贴", "Paste")))?)?;
    edit.append(&PredefinedMenuItem::select_all(app, Some(&t(locale, "全选", "Select All")))?)?;
    edit.append(&sep()?)?;
    edit.append(&item(app, locale, "edit.find", "查找", "Find", None)?)?;
    edit.append(&item(app, locale, "edit.find_in_files", "在工作区搜索", "Search in Workspace", None)?)?;
    edit.append(&sep()?)?;
    edit.append(&item(app, locale, "edit.settings", "设置…", "Settings…", None)?)?;

    // ---- 视图 ----
    let view = sub(app, "view", locale, "&视图", "&View")?;
    view.append(&item(app, locale, "view.editor", "仅编辑", "Editor Only", None)?)?;
    view.append(&item(app, locale, "view.split", "分屏", "Split View", None)?)?;
    view.append(&item(app, locale, "view.preview", "仅预览", "Preview Only", None)?)?;
    view.append(&sep()?)?;
    view.append(&item(app, locale, "view.sidebar", "切换侧栏", "Toggle Sidebar", None)?)?;
    view.append(&item(app, locale, "view.outline", "大纲", "Outline", None)?)?;
    view.append(&sep()?)?;
    view.append(&item(app, locale, "view.devtools", "开发者工具", "Developer Tools", None)?)?;

    // ---- 窗口 ----
    let window = sub(app, "window", locale, "&窗口", "&Window")?;
    window.append(&PredefinedMenuItem::minimize(app, Some(&t(locale, "最小化", "Minimize")))?)?;
    window.append(&PredefinedMenuItem::maximize(app, Some(&t(locale, "最大化", "Maximize")))?)?;
    window.append(&sep()?)?;
    window.append(&PredefinedMenuItem::close_window(app, Some(&t(locale, "关闭窗口", "Close Window")))?)?;

    // ---- 帮助 ----
    let help = sub(app, "help", locale, "&帮助", "&Help")?;
    help.append(&PredefinedMenuItem::about(
        app,
        Some(&t(locale, "关于 FeatherMark", "About FeatherMark")),
        None,
    )?)?;
    help.append(&item(app, locale, "help.shortcuts", "快捷键", "Keyboard Shortcuts", None)?)?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

/// 切换语言：保存 + 重建菜单栏。前端设置面板调用；返回新语言确认。
#[tauri::command]
pub fn set_language<R: Runtime>(app: AppHandle<R>, lang: String) -> Result<String, String> {
    let locale = Locale::from_str(&lang);
    save_locale(&app, locale)?;
    let menu = build_menu(&app, locale).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(locale.as_str().to_string())
}

/// 读取当前语言（前端启动时同步设置面板 UI 用）。
#[tauri::command]
pub fn get_language<R: Runtime>(app: AppHandle<R>) -> String {
    load_locale(&app).as_str().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_parse() {
        assert_eq!(Locale::from_str("zh"), Locale::Zh);
        assert_eq!(Locale::from_str("zh-CN"), Locale::Zh);
        assert_eq!(Locale::from_str("ZH"), Locale::Zh);
        assert_eq!(Locale::from_str("en"), Locale::En);
        assert_eq!(Locale::from_str("en-US"), Locale::En);
        assert_eq!(Locale::from_str(""), Locale::En);
        assert_eq!(Locale::Zh.as_str(), "zh");
        assert_eq!(Locale::En.as_str(), "en");
    }

    #[test]
    fn text_bilingual() {
        assert_eq!(t(Locale::Zh, "文件", "File"), "文件");
        assert_eq!(t(Locale::En, "文件", "File"), "File");
        assert_eq!(t(Locale::Zh, "设置…", "Settings…"), "设置…");
        assert_eq!(t(Locale::En, "设置…", "Settings…"), "Settings…");
    }
}
