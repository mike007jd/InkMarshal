//! macOS-native menu bar for InkMarshal (Wave 3 commit 4).
//!
//! The Rust menu is the source of truth on macOS — labels are picked from a
//! locale match (en / zh-CN / zh-TW) read at app launch. The front-end's
//! `LanguageProvider` persists the current locale to `~/.inkmarshal/app/locale.txt`
//! so this module can read it without a webview round-trip. Switching locale
//! at runtime requires an app restart for new labels (matches typical macOS
//! behaviour — `NSMenu` isn't routinely rebuilt on language toggle).
//!
//! Every clickable item carries a stable dotted id (`inkmarshal.file.new`
//! etc.). Click events are emitted as a single `inkmarshal://menu` Tauri event
//! whose payload is that id; the frontend's `DesktopShell` maps the id to the
//! actual behaviour (open dialog, flush manuscript, toggle panels, …).
//!
//! Coexistence: this module only registers a menu. It does not touch vault,
//! engine, or runtime state — appending `.menu()` + `.on_menu_event()` to the
//! Builder chain in `lib.rs` is sufficient.

use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Runtime,
};

/// Locale tag used for menu labels. The LanguageProvider writes the active
/// locale to `<~/.inkmarshal/app>/locale.txt`; before that file exists, the
/// operating-system locale is used.
#[derive(Clone, Copy)]
enum MenuLocale {
    En,
    ZhCN,
    ZhTW,
}

fn parse_locale(raw: &str) -> MenuLocale {
    match normalize_locale(raw) {
        "zh-CN" => MenuLocale::ZhCN,
        "zh-TW" => MenuLocale::ZhTW,
        _ => MenuLocale::En,
    }
}

pub(crate) fn normalize_locale(raw: &str) -> &'static str {
    let normalized = raw.trim().replace('_', "-").to_ascii_lowercase();
    if !normalized.starts_with("zh") {
        return "en";
    }
    if normalized.contains("hant")
        || normalized
            .split('-')
            .any(|part| matches!(part, "tw" | "hk" | "mo"))
    {
        "zh-TW"
    } else {
        "zh-CN"
    }
}

/// Read the persisted locale from `<~/.inkmarshal/app>/locale.txt`. A missing
/// file is the expected first-launch state, so fall back to the active OS locale.
///
/// IMPORTANT: this runs inside `Builder::menu()`, which Tauri invokes during
/// `Builder::build()` — i.e. *before* the path-resolver state is managed.
/// Calling `app.path()` here panics with "state() called before manage() for
/// PathResolver". We therefore use the shared HOME-based path helper directly.
pub fn read_locale_or_default<R: Runtime>(_app: &AppHandle<R>) -> String {
    let Ok(dir) = crate::inkmarshal_home::inkmarshal_app_dir() else {
        return sys_locale::get_locale().unwrap_or_else(|| "en".to_string());
    };
    let path = dir.join("locale.txt");
    match std::fs::read_to_string(&path) {
        Ok(s) => s.trim().to_string(),
        Err(_) => sys_locale::get_locale().unwrap_or_else(|| "en".to_string()),
    }
}

struct Labels {
    // Submenus
    app_menu: &'static str,
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    models: &'static str,
    window: &'static str,
    help: &'static str,
    // App submenu items
    about: &'static str,
    preferences: &'static str,
    services: &'static str,
    hide: &'static str,
    hide_others: &'static str,
    show_all: &'static str,
    quit: &'static str,
    // File items
    new_novel: &'static str,
    open_recent: &'static str,
    open_recent_empty: &'static str,
    save: &'static str,
    export: &'static str,
    close_window: &'static str,
    // Edit items
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    find: &'static str,
    // View items
    view_chat: &'static str,
    view_knowledge: &'static str,
    view_conv: &'static str,
    view_manuscript: &'static str,
    toggle_sidebar: &'static str,
    toggle_right_panel: &'static str,
    // Models
    models_item: &'static str,
    // Window items
    minimize: &'static str,
    zoom: &'static str,
    // Help items
    documentation: &'static str,
    report_issue: &'static str,
}

const EN: Labels = Labels {
    app_menu: "InkMarshal",
    file: "File",
    edit: "Edit",
    view: "View",
    models: "Models",
    window: "Window",
    help: "Help",
    about: "About InkMarshal",
    preferences: "Preferences…",
    services: "Services",
    hide: "Hide InkMarshal",
    hide_others: "Hide Others",
    show_all: "Show All",
    quit: "Quit InkMarshal",
    new_novel: "New Novel",
    open_recent: "Open Recent",
    open_recent_empty: "No Recent Novels",
    save: "Save",
    export: "Export ZIP",
    close_window: "Close Window",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    find: "Find…",
    view_chat: "Chat",
    view_knowledge: "Story Deck",
    view_conv: "Conversations",
    view_manuscript: "Manuscript",
    toggle_sidebar: "Toggle Sidebar",
    toggle_right_panel: "Toggle Right Panel",
    models_item: "Models…",
    minimize: "Minimize",
    zoom: "Zoom",
    documentation: "Documentation",
    report_issue: "Report Issue",
};

const ZH_CN: Labels = Labels {
    app_menu: "InkMarshal",
    file: "文件",
    edit: "编辑",
    view: "视图",
    models: "模型",
    window: "窗口",
    help: "帮助",
    about: "关于 InkMarshal",
    preferences: "偏好设置…",
    services: "服务",
    hide: "隐藏 InkMarshal",
    hide_others: "隐藏其他",
    show_all: "全部显示",
    quit: "退出 InkMarshal",
    new_novel: "新建小说",
    open_recent: "打开最近",
    open_recent_empty: "没有最近的小说",
    save: "立即保存",
    export: "导出 ZIP",
    close_window: "关闭窗口",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    select_all: "全选",
    find: "查找…",
    view_chat: "对话",
    view_knowledge: "故事卡组",
    view_conv: "会话",
    view_manuscript: "手稿",
    toggle_sidebar: "切换左栏",
    toggle_right_panel: "切换右栏",
    models_item: "模型管理…",
    minimize: "最小化",
    zoom: "缩放",
    documentation: "文档",
    report_issue: "反馈问题",
};

const ZH_TW: Labels = Labels {
    app_menu: "InkMarshal",
    file: "檔案",
    edit: "編輯",
    view: "視圖",
    models: "模型",
    window: "視窗",
    help: "說明",
    about: "關於 InkMarshal",
    preferences: "偏好設定…",
    services: "服務",
    hide: "隱藏 InkMarshal",
    hide_others: "隱藏其他",
    show_all: "全部顯示",
    quit: "退出 InkMarshal",
    new_novel: "新建小說",
    open_recent: "開啟最近",
    open_recent_empty: "沒有最近的小說",
    save: "立即儲存",
    export: "匯出 ZIP",
    close_window: "關閉視窗",
    undo: "復原",
    redo: "重做",
    cut: "剪下",
    copy: "複製",
    paste: "貼上",
    select_all: "全選",
    find: "尋找…",
    view_chat: "對話",
    view_knowledge: "故事卡組",
    view_conv: "會話",
    view_manuscript: "手稿",
    toggle_sidebar: "切換左欄",
    toggle_right_panel: "切換右欄",
    models_item: "模型管理…",
    minimize: "最小化",
    zoom: "縮放",
    documentation: "說明文件",
    report_issue: "回報問題",
};

fn labels_for(locale: MenuLocale) -> &'static Labels {
    match locale {
        MenuLocale::En => &EN,
        MenuLocale::ZhCN => &ZH_CN,
        MenuLocale::ZhTW => &ZH_TW,
    }
}

/// Build the full top-level menu for a given locale string. The returned Menu
/// is registered via `Builder::menu(...)` in `lib.rs`. Failure returns the
/// underlying `tauri::Error` so the caller can log + fall back to no menu;
/// the front-end's keydown bindings then provide the same hotkeys.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>, locale_raw: &str) -> tauri::Result<Menu<R>> {
    let locale = parse_locale(locale_raw);
    let l = labels_for(locale);

    // ── App submenu (macOS only renders this in the system menu; on other
    //    platforms the first submenu becomes a window-menu entry, which is
    //    still functional and harmless).
    let about_item = PredefinedMenuItem::about(app, Some(l.about), None)?;
    let preferences_item = MenuItemBuilder::with_id("inkmarshal.prefs", l.preferences)
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let services_item = PredefinedMenuItem::services(app, Some(l.services))?;
    let hide_item = PredefinedMenuItem::hide(app, Some(l.hide))?;
    let hide_others_item = PredefinedMenuItem::hide_others(app, Some(l.hide_others))?;
    let show_all_item = PredefinedMenuItem::show_all(app, Some(l.show_all))?;
    let quit_item = PredefinedMenuItem::quit(app, Some(l.quit))?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;

    let app_submenu = SubmenuBuilder::new(app, l.app_menu)
        .item(&about_item)
        .item(&sep1)
        .item(&preferences_item)
        .item(&sep2)
        .item(&services_item)
        .item(&sep3)
        .item(&hide_item)
        .item(&hide_others_item)
        .item(&show_all_item)
        .item(&sep4)
        .item(&quit_item)
        .build()?;

    // ── File submenu
    let new_novel_item = MenuItemBuilder::with_id("inkmarshal.file.new", l.new_novel)
        .accelerator("CmdOrCtrl+N")
        .build(app)?;

    // Open Recent is a placeholder until the recent-novel store ships. We
    // keep the submenu so the layout matches the macOS expectation, with a
    // single disabled "No recent novels" item inside.
    let recent_empty =
        MenuItemBuilder::with_id("inkmarshal.file.openRecent.empty", l.open_recent_empty)
            .enabled(false)
            .build(app)?;
    let open_recent = SubmenuBuilder::new(app, l.open_recent)
        .item(&recent_empty)
        .build()?;

    let save_item = MenuItemBuilder::with_id("inkmarshal.file.save", l.save)
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let export_item = MenuItemBuilder::with_id("inkmarshal.file.export", l.export)
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let close_window_item = MenuItemBuilder::with_id("inkmarshal.file.closeWindow", l.close_window)
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let file_sep1 = PredefinedMenuItem::separator(app)?;
    let file_sep2 = PredefinedMenuItem::separator(app)?;

    let file_submenu = SubmenuBuilder::new(app, l.file)
        .item(&new_novel_item)
        .item(&open_recent)
        .item(&file_sep1)
        .item(&save_item)
        .item(&export_item)
        .item(&file_sep2)
        .item(&close_window_item)
        .build()?;

    // ── Edit submenu — Cut/Copy/Paste/Undo/Redo are predefined so the OS
    //    binds them to the focused webview's contenteditable as expected.
    let undo = PredefinedMenuItem::undo(app, Some(l.undo))?;
    let redo = PredefinedMenuItem::redo(app, Some(l.redo))?;
    let cut = PredefinedMenuItem::cut(app, Some(l.cut))?;
    let copy = PredefinedMenuItem::copy(app, Some(l.copy))?;
    let paste = PredefinedMenuItem::paste(app, Some(l.paste))?;
    let select_all = PredefinedMenuItem::select_all(app, Some(l.select_all))?;
    let find_item = MenuItemBuilder::with_id("inkmarshal.edit.find", l.find)
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let edit_sep1 = PredefinedMenuItem::separator(app)?;
    let edit_sep2 = PredefinedMenuItem::separator(app)?;
    let edit_sep3 = PredefinedMenuItem::separator(app)?;

    let edit_submenu = SubmenuBuilder::new(app, l.edit)
        .item(&undo)
        .item(&redo)
        .item(&edit_sep1)
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&select_all)
        .item(&edit_sep2)
        .item(&find_item)
        .item(&edit_sep3)
        .build()?;

    // ── View submenu
    let view_chat_item = MenuItemBuilder::with_id("inkmarshal.view.chat", l.view_chat)
        .accelerator("CmdOrCtrl+1")
        .build(app)?;
    let view_knowledge_item =
        MenuItemBuilder::with_id("inkmarshal.view.knowledge", l.view_knowledge)
            .accelerator("CmdOrCtrl+2")
            .build(app)?;
    let view_conv_item = MenuItemBuilder::with_id("inkmarshal.view.conv", l.view_conv)
        .accelerator("CmdOrCtrl+3")
        .build(app)?;
    let view_manuscript_item =
        MenuItemBuilder::with_id("inkmarshal.view.manuscript", l.view_manuscript)
            .accelerator("CmdOrCtrl+4")
            .build(app)?;
    let toggle_left_item = MenuItemBuilder::with_id("inkmarshal.view.toggleLeft", l.toggle_sidebar)
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let toggle_right_item =
        MenuItemBuilder::with_id("inkmarshal.view.toggleRight", l.toggle_right_panel)
            .accelerator("CmdOrCtrl+\\")
            .build(app)?;
    let view_sep1 = PredefinedMenuItem::separator(app)?;

    let view_submenu = SubmenuBuilder::new(app, l.view)
        .item(&view_chat_item)
        .item(&view_knowledge_item)
        .item(&view_conv_item)
        .item(&view_manuscript_item)
        .item(&view_sep1)
        .item(&toggle_left_item)
        .item(&toggle_right_item)
        .build()?;

    // ── Models submenu
    let models_item = MenuItemBuilder::with_id("inkmarshal.models", l.models_item)
        .accelerator("CmdOrCtrl+M")
        .build(app)?;
    let models_submenu = SubmenuBuilder::new(app, l.models)
        .item(&models_item)
        .build()?;

    // ── Window submenu — minimize at Alt+Cmd+M to avoid the Cmd+M clash with
    //    the Models accelerator. Zoom stays predefined (toggles native zoom).
    let minimize_item = MenuItemBuilder::with_id("inkmarshal.window.minimize", l.minimize)
        .accelerator("CmdOrCtrl+Alt+M")
        .build(app)?;
    let zoom_item = PredefinedMenuItem::maximize(app, Some(l.zoom))?;
    let window_submenu = SubmenuBuilder::new(app, l.window)
        .item(&minimize_item)
        .item(&zoom_item)
        .build()?;

    // ── Help submenu — plain text items, frontend handles the click.
    let docs_item = MenuItemBuilder::with_id("inkmarshal.help.docs", l.documentation).build(app)?;
    let report_item =
        MenuItemBuilder::with_id("inkmarshal.help.report", l.report_issue).build(app)?;
    let help_submenu = SubmenuBuilder::new(app, l.help)
        .item(&docs_item)
        .item(&report_item)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&models_submenu)
        .item(&window_submenu)
        .item(&help_submenu)
        .build()
}

#[cfg(test)]
mod tests {
    use super::{parse_locale, MenuLocale};

    #[test]
    fn maps_system_chinese_locales_to_the_supported_script() {
        assert!(matches!(parse_locale("zh-Hans-AU"), MenuLocale::ZhCN));
        assert!(matches!(parse_locale("zh_CN.UTF-8"), MenuLocale::ZhCN));
        assert!(matches!(parse_locale("zh-Hant-HK"), MenuLocale::ZhTW));
        assert!(matches!(parse_locale("zh_TW"), MenuLocale::ZhTW));
    }

    #[test]
    fn defaults_unsupported_system_locales_to_english() {
        assert!(matches!(parse_locale("en-AU"), MenuLocale::En));
        assert!(matches!(parse_locale("fr-FR"), MenuLocale::En));
    }
}
