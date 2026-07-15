//! 系统托盘实现。
//!
//! 提供带有上下文菜单的托盘图标，支持点击切换窗口可见性
//! 和动态图标状态切换（正常 / 通知徽标）。
//!
//! 跨平台图标处理：
//! - macOS：使用模板图像（单色，自动适配菜单栏明暗主题）
//! - Windows/Linux：使用全彩应用图标

use std::sync::Mutex;

use tauri::{
    AppHandle, Manager, Runtime, WebviewWindow,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent, TrayIconId},
};
use tauri_plugin_positioner::{Position, on_tray_event};

use crate::error::AppError;

/// 托盘图标状态 — 控制显示哪个图标。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub enum TrayIconState {
    /// 默认应用图标
    Normal,
    /// 带通知徽标的图标（如未读消息提示）
    Notification,
}

/// 托盘窗口定位 — 控制窗口相对于托盘图标的出现位置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub enum TrayPosition {
    /// 托盘图标左上角
    TopLeft,
    /// 托盘图标右上角
    TopRight,
    /// 托盘图标左下角
    BottomLeft,
    /// 托盘图标右下角
    BottomRight,
}

/// 全局托盘图标状态 — 在命令处理器和事件处理器之间共享。
static TRAY_STATE: Mutex<TrayIconState> = Mutex::new(TrayIconState::Normal);

/// 托盘菜单项 ID — 在应用内必须唯一。
const MENU_ID_SHOW: &str = "tray_show";
const MENU_ID_QUIT: &str = "tray_quit";

/// 构建并注册系统托盘图标。
///
/// 在应用 setup 期间调用一次。托盘提供以下功能：
/// - 单击左键：切换主窗口可见性
/// - 双击左键：显示并聚焦主窗口
/// - 右键点击：上下文菜单（显示/隐藏、分隔符、退出）
/// - Positioner 集成：支持相对于托盘图标的窗口定位
pub fn init_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // 注意：托盘菜单项当前为英文。Rust 端尚未实现 i18n；
    // 待 Rust i18n 系统就绪后，这些字符串应进行本地化。
    let show_item = MenuItem::with_id(app, MENU_ID_SHOW, "Show/Hide", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, MENU_ID_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

    // 使用应用默认窗口图标作为托盘图标。
    // 在 macOS 上标记为模板图像，使其自动适配菜单栏明暗主题。
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("app must have a default window icon"))?;

    TrayIconBuilder::with_id(TrayIconId::new("main-tray"))
        .icon(icon)
        .tooltip("Tauri App")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon_as_template(cfg!(target_os = "macos"))
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(handle_tray_event)
        .build(app)?;

    log::info!("System tray initialized");
    Ok(())
}

/// 处理托盘上下文菜单的点击事件。
fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_ID_SHOW => {
            toggle_main_window(app);
        }
        MENU_ID_QUIT => {
            log::info!("Quit requested from tray menu");
            app.exit(0);
        }
        _ => {
            log::debug!("Unhandled tray menu item: {:?}", event.id());
        }
    }
}

/// 处理托盘图标上的鼠标事件。
fn handle_tray_event<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, event: TrayIconEvent) {
    // positioner 插件需要此调用来计算相对于托盘的窗口位置
    on_tray_event(tray.app_handle(), &event);

    match event {
        // 单击左键：切换窗口可见性
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => {
            toggle_main_window(tray.app_handle());
        }
        // 双击左键：确保窗口已显示并聚焦
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } => {
            show_and_focus_main_window(tray.app_handle());
        }
        _ => {}
    }
}

/// 切换主窗口的显示/隐藏状态。
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if is_window_visible(&window) {
            let _ = window.hide();
            log::debug!("Main window hidden via tray");
        } else {
            show_and_focus_main_window(app);
        }
    }
}

/// 显示（若已隐藏）并聚焦主窗口。
fn show_and_focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        log::debug!("Main window shown via tray");
    }
}

/// 检查窗口当前是否可见（未隐藏且未最小化）。
fn is_window_visible<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
}

/// 更新托盘图标状态（正常 / 通知徽标）。
///
/// 作为 Tauri 命令暴露给前端，前端可在收到通知或未读数变化时
/// 触发徽标显示。
#[tauri::command]
#[specta::specta]
pub fn set_tray_icon_state(state: TrayIconState) -> Result<(), AppError> {
    let mut current = TRAY_STATE
        .lock()
        .map_err(|e| AppError::tray(format!("Tray state lock poisoned: {e}")))?;

    if *current != state {
        *current = state;
        log::debug!("Tray icon state changed to: {state:?}");
        // 注意：实际的图标切换需要访问 TrayIcon 句柄。
        // macOS 模板图标依赖系统处理；Windows/Linux 需要在此处
        // 切换第二个图标资源。待徽标图标资源就绪后作为扩展点实现。
    }
    Ok(())
}

/// 将窗口移动到相对于托盘图标的位置（如弹出式面板）。
///
/// 作为 Tauri 命令暴露给前端，前端可将快速面板或弹出窗口
/// 定位到托盘图标附近。
#[tauri::command]
#[specta::specta]
pub fn move_window_to_tray(
    app: tauri::AppHandle,
    window_label: String,
    position: TrayPosition,
) -> Result<(), AppError> {
    use tauri_plugin_positioner::WindowExt;

    let pos = match position {
        TrayPosition::TopLeft => Position::TopLeft,
        TrayPosition::TopRight => Position::TopRight,
        TrayPosition::BottomLeft => Position::BottomLeft,
        TrayPosition::BottomRight => Position::BottomRight,
    };

    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| AppError::not_found(format!("Window not found: {window_label}")))?;

    window
        .move_window(pos)
        .map_err(|e| AppError::window(format!("Failed to move window: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_state_default_is_normal() {
        // 静态变量在进程启动时应为 Normal 状态
        let state = TRAY_STATE.lock().unwrap();
        assert_eq!(*state, TrayIconState::Normal);
    }

    #[test]
    fn tray_state_enum_equality() {
        assert_eq!(TrayIconState::Normal, TrayIconState::Normal);
        assert_ne!(TrayIconState::Normal, TrayIconState::Notification);
    }
}
