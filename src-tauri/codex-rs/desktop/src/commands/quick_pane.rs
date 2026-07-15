//! 快速面板窗口管理命令。
//!
//! 快速面板是一个浮动面板（macOS 上为 NSPanel，其他平台为标准窗口），
//! 通过全局快捷键提供快速输入功能。
//!
//! ## 架构位置
//!
//! 本模块属于 `commands` 业务域之一，与 [`crate::commands::tray`] 和
//! [`crate::commands::preferences`] 协同工作：
//!
//! - [`crate::commands::tray`]：系统托盘图标，用于切换主窗口可见性；
//! - [`crate::commands::preferences`]：加载/保存 `quick_pane_shortcut` 偏好；
//! - 本模块：在应用启动时通过 [`init_quick_pane`] 创建面板窗口，
//!   并通过 [`register_quick_pane_shortcut`] 绑定全局快捷键。
//!
//! ## 设计决策
//!
//! - **平台差异**：macOS 使用 `tauri-nspanel` 提供的 NSPanel 以获得原生
//!   浮动面板行为（显示在全屏应用之上、可成为 key window 但不激活应用）；
//!   非 macOS 平台退化为标准 Tauri 窗口，通过 `always_on_top` 近似实现。
//! - **光标感知定位**：面板显示时定位到光标所在显示器的中心位置，
//!   而非主窗口位置，便于在多显示器场景下快速使用。
//! - **快捷键互斥**：使用全局 `Mutex` 跟踪当前已注册的快捷键，
//!   更新时先注销旧的再注册新的，避免快捷键冲突。
//!
//! [`init_quick_pane`]: init_quick_pane
//! [`register_quick_pane_shortcut`]: register_quick_pane_shortcut

use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl};

use crate::error::AppError;
use crate::types::DEFAULT_QUICK_PANE_SHORTCUT;

// ============================================================================
// 常量
// ============================================================================

/// 快速面板的窗口标签 — 在 Tauri 应用内必须唯一，用于 `get_webview_window` 查找。
const QUICK_PANE_LABEL: &str = "quick-pane";

/// 快速面板窗口宽度（逻辑像素）— 适配单行输入框的横向尺寸。
const QUICK_PANE_WIDTH: f64 = 500.0;

/// 快速面板窗口高度（逻辑像素）— 较小高度适配单行输入场景。
const QUICK_PANE_HEIGHT: f64 = 72.0;

/// 跟踪当前已注册的快速面板快捷键，便于选择性注销。
/// 这使我们能只注销自己的快捷键，不影响其他快捷键。
///
/// 使用 `Mutex` 而非 `RwLock`：写入操作（注册/注销）必须独占，
/// 读取场景极少，`Mutex` 开销更低且语义更清晰。
static CURRENT_QUICK_PANE_SHORTCUT: Mutex<Option<String>> = Mutex::new(None);

// ============================================================================
// macOS 专属：NSPanel 支持
// ============================================================================

#[cfg(target_os = "macos")]
use tauri_nspanel::{
    CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask, tauri_panel,
};

// 为快速面板定义自定义 panel 类（仅 macOS）
#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(QuickPanePanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

// ============================================================================
// 窗口初始化
// ============================================================================

/// 在应用启动时创建快速面板窗口。
///
/// 必须在主线程中调用（如在 `setup()` 回调中），因为 Tauri 窗口创建
/// 要求主线程上下文。窗口初始为隐藏状态，通过 [`show_quick_pane`]
/// 命令或全局快捷键触发显示。
///
/// # 平台分发
///
/// 根据 `target_os` 分发到平台专属实现：
/// - macOS：`init_quick_pane_macos` — 使用 NSPanel 获得原生浮动面板行为；
/// - 其他平台：`init_quick_pane_standard` — 使用标准 Tauri 窗口。
///
/// # 错误
///
/// 若窗口/面板创建失败（如窗口标签冲突、资源加载失败），
/// 返回 [`AppError::quick_pane`]。
///
/// # 调用时机
///
/// 在 `lib.rs` 的 `setup()` 期间调用一次，确保后续命令能通过
/// `QUICK_PANE_LABEL` 查找到该窗口。
///
/// [`show_quick_pane`]: show_quick_pane
pub fn init_quick_pane(app: &AppHandle) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        init_quick_pane_macos(app)
    }

    #[cfg(not(target_os = "macos"))]
    {
        init_quick_pane_standard(app)
    }
}

/// 在 macOS 上以 NSPanel 形式创建快速面板（隐藏状态）。
///
/// 使用 `tauri-nspanel` crate 的 `PanelBuilder` 构建 NSPanel，配置如下：
///
/// - **级别**：`PanelLevel::Status` — 显示在全屏应用和状态栏之上；
/// - **集合行为**：`full_screen_auxiliary` + `can_join_all_spaces` —
///   在所有 Space 中可见，作为全屏辅助面板；
/// - **样式掩码**：`nonactivating_panel` — 成为 key window 时不激活应用，
///   避免从当前应用抢夺焦点；
/// - **透明 + 阴影**：配合前端实现圆角浮动效果；
/// - **不可调整大小**：固定尺寸，避免用户意外调整。
///
/// # 错误
///
/// 若 `PanelBuilder::build()` 失败（如 `QUICK_PANE_LABEL` 已被占用），
/// 返回 [`AppError::quick_pane`]。
#[cfg(target_os = "macos")]
fn init_quick_pane_macos(app: &AppHandle) -> Result<(), AppError> {
    use tauri::{LogicalSize, Size};

    log::debug!("Creating quick pane as NSPanel (macOS)");

    let panel = PanelBuilder::<_, QuickPanePanel>::new(app, QUICK_PANE_LABEL)
        .url(WebviewUrl::App("quick-pane.html".into()))
        // TODO: i18n - 快速面板标题应本地化
        .title("Quick Entry")
        .size(Size::Logical(LogicalSize::new(500.0, 72.0)))
        .level(PanelLevel::Status) // Status 级别，以显示在全屏应用之上
        .transparent(true)
        .has_shadow(true)
        .collection_behavior(
            CollectionBehavior::new()
                .full_screen_auxiliary()
                .can_join_all_spaces(),
        )
        .style_mask(StyleMask::empty().nonactivating_panel())
        .hides_on_deactivate(false)
        .works_when_modal(true)
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .skip_taskbar(true)
                .resizable(false)
                .center()
        })
        .build()
        .map_err(|e| AppError::quick_pane(format!("Failed to create quick pane panel: {e}")))?;

    // 初始隐藏 - 通过 show_quick_pane 命令显示
    panel.hide();
    log::info!("Quick pane NSPanel created (hidden)");
    Ok(())
}

/// 在非 macOS 平台上以标准 Tauri 窗口形式创建快速面板（隐藏状态）。
///
/// 使用 `WebviewWindowBuilder` 构建标准窗口，通过以下配置近似 macOS 行为：
///
/// - `always_on_top(true)`：置顶显示，近似 `PanelLevel::Status`；
/// - `skip_taskbar(true)`：不显示在任务栏，避免占用任务栏位置；
/// - `decorations(false)` + `transparent(true)`：无边框透明，配合前端实现
///   圆角浮动效果（与 macOS 端视觉一致）；
/// - `visible(false)`：初始隐藏，通过 [`show_quick_pane`] 触发显示；
/// - `resizable(false)`：固定尺寸。
///
/// # 平台限制
///
/// 标准 Tauri 窗口无法完全复现 NSPanel 的 `nonactivating_panel` 行为：
/// 在 Windows/Linux 上，面板成为 key window 时会激活应用。
/// 这是已知的跨平台差异，前端应通过失焦事件处理面板隐藏。
///
/// # 错误
///
/// 若 `WebviewWindowBuilder::build()` 失败（如 `QUICK_PANE_LABEL` 已被占用），
/// 返回 [`AppError::quick_pane`]。
///
/// [`show_quick_pane`]: show_quick_pane
#[cfg(not(target_os = "macos"))]
fn init_quick_pane_standard(app: &AppHandle) -> Result<(), AppError> {
    use tauri::webview::WebviewWindowBuilder;

    log::debug!("Creating quick pane as standard window");

    WebviewWindowBuilder::new(
        app,
        QUICK_PANE_LABEL,
        WebviewUrl::App("quick-pane.html".into()),
    )
    // TODO: i18n - 快速面板标题应本地化
    .title("Quick Entry")
    .inner_size(500.0, 72.0)
    .always_on_top(true)
    .skip_taskbar(true)
    .decorations(false)
    .transparent(true)
    .visible(false) // 初始隐藏
    .resizable(false)
    .center()
    .build()
    .map_err(|e| AppError::quick_pane(format!("Failed to create quick pane window: {e}")))?;

    log::info!("Quick pane window created (hidden)");
    Ok(())
}

// ============================================================================
// 窗口定位
// ============================================================================

/// 获取包含指定光标位置的显示器，找不到时回退到主显示器。
///
/// 多显示器场景下，用户可能在任意显示器上按快捷键，需要找到光标
/// 所在的显示器以正确计算面板定位。
///
/// # 参数
///
/// - `app`：Tauri 应用句柄，用于查询显示器信息；
/// - `cursor_pos`：光标的物理坐标（像素）。
///
/// # 回退策略
///
/// 1. 若 `monitor_from_point` 返回 `None`（光标在所有显示器之外），
///    回退到主显示器；
/// 2. 若 `monitor_from_point` 出错或主显示器获取失败，返回 `None`，
///    调用方应处理 `None` 情况（如使用默认位置）。
fn get_monitor_for_cursor(
    app: &AppHandle,
    cursor_pos: tauri::PhysicalPosition<f64>,
) -> Option<tauri::Monitor> {
    match app.monitor_from_point(cursor_pos.x, cursor_pos.y) {
        Ok(Some(m)) => Some(m),
        Ok(None) => {
            log::warn!("No monitor found at cursor position, trying primary monitor");
            app.primary_monitor().ok().flatten()
        }
        Err(e) => {
            log::warn!("Failed to get monitor from point: {e}");
            app.primary_monitor().ok().flatten()
        }
    }
}

/// 计算窗口在光标所在显示器上居中显示的位置。
///
/// 若无法确定光标所在显示器，则回退到主显示器。
///
/// # 定位算法
///
/// 1. 获取光标的物理坐标；
/// 2. 通过 [`get_monitor_for_cursor`] 找到光标所在显示器；
/// 3. 读取该显示器的位置、尺寸和 `scale_factor`；
/// 4. 按 `scale_factor` 将逻辑尺寸（`QUICK_PANE_WIDTH/HEIGHT`）
///    转换为物理像素；
/// 5. 计算居中偏移：`显示器原点 + (显示器尺寸 - 窗口尺寸) / 2`。
///
/// # 为什么不用逻辑坐标
///
/// 跨平台 API（如 `set_position`）通常使用物理坐标。在不同 `scale_factor`
/// 的显示器之间，物理坐标保证一致性。
///
/// # 返回值
///
/// - `Some(PhysicalPosition)`：计算成功，可用于 `window.set_position`；
/// - `None`：光标位置或显示器信息获取失败，调用方应回退到默认位置
///   （如使用 `center()` 配置的初始位置）。
fn get_centered_position_on_cursor_monitor(
    app: &AppHandle,
) -> Option<tauri::PhysicalPosition<i32>> {
    // 获取光标位置
    let cursor_pos = match app.cursor_position() {
        Ok(pos) => pos,
        Err(e) => {
            log::warn!("Failed to get cursor position: {e}");
            return None;
        }
    };

    log::debug!("Cursor position: ({}, {})", cursor_pos.x, cursor_pos.y);

    // 获取包含光标的显示器
    let monitor = get_monitor_for_cursor(app, cursor_pos)?;

    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let scale_factor = monitor.scale_factor();

    log::debug!(
        "Monitor: pos=({}, {}), size={}x{}, scale={}",
        monitor_pos.x,
        monitor_pos.y,
        monitor_size.width,
        monitor_size.height,
        scale_factor
    );

    // 计算在该显示器上居中的位置
    // 窗口尺寸需要按显示器的 scale factor 缩放
    let scaled_width = (QUICK_PANE_WIDTH * scale_factor) as i32;
    let scaled_height = (QUICK_PANE_HEIGHT * scale_factor) as i32;

    let x = monitor_pos.x + (monitor_size.width as i32 - scaled_width) / 2;
    let y = monitor_pos.y + (monitor_size.height as i32 - scaled_height) / 2;

    log::debug!("Calculated position: ({x}, {y})");

    Some(tauri::PhysicalPosition::new(x, y))
}

/// 将快速面板窗口定位到光标所在显示器的居中位置。
///
/// 这是显示前的预处理步骤：每次显示面板前都会重新定位，
/// 确保面板始终出现在用户当前焦点所在的显示器上。
///
/// # 错误处理
///
/// - 若位置计算失败（返回 `None`），保持当前窗口位置不变；
/// - 若 `set_position` 失败，仅记录警告，不阻塞显示流程。
///
/// # 为什么每次都重新计算
///
/// 用户可能在调用间移动到不同显示器（如笔记本电脑 + 外接显示器），
/// 重新计算保证面板始终跟随用户焦点。
fn position_quick_pane_on_cursor_monitor(app: &AppHandle) {
    if let Some(position) = get_centered_position_on_cursor_monitor(app)
        && let Some(window) = app.get_webview_window(QUICK_PANE_LABEL)
        && let Err(e) = window.set_position(position)
    {
        log::warn!("Failed to set window position: {e}");
    }
}

// ============================================================================
// 窗口可见性
// ============================================================================

/// 返回快速面板当前是否可见。
///
/// 平台差异：
/// - macOS：通过 `get_webview_panel` 获取 NSPanel 句柄并查询 `is_visible()`；
/// - 其他平台：通过 `get_webview_window` 获取标准窗口并查询。
///
/// 用于 [`toggle_quick_pane`] 决定是显示还是隐藏面板。
fn is_quick_pane_visible(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        app.get_webview_panel(QUICK_PANE_LABEL)
            .map(|panel| panel.is_visible())
            .unwrap_or(false)
    }

    #[cfg(not(target_os = "macos"))]
    {
        app.get_webview_window(QUICK_PANE_LABEL)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false)
    }
}

/// 显示快速面板窗口并使其成为 key window（用于接收键盘输入）。
///
/// 执行步骤：
/// 1. 调用 `position_quick_pane_on_cursor_monitor` 重新定位到光标所在显示器；
/// 2. macOS：调用 `panel.show_and_make_key()` 显示并获取键盘焦点；
/// 3. 其他平台：调用 `window.show()` + `window.set_focus()` 模拟。
///
/// # 错误
///
/// - 若面板未初始化（[`init_quick_pane`] 未调用），返回 [`AppError::not_found`]；
/// - 若显示或聚焦失败，返回 [`AppError::window`]。
///
/// # 前端触发方式
///
/// 作为 Tauri 命令暴露给前端，前端通过 `invoke('show_quick_pane')` 调用。
/// 也可由 [`register_quick_pane_shortcut`] 注册的全局快捷键间接触发。
///
/// [`init_quick_pane`]: init_quick_pane
/// [`register_quick_pane_shortcut`]: register_quick_pane_shortcut
#[tauri::command]
#[specta::specta]
pub fn show_quick_pane(app: AppHandle) -> Result<(), AppError> {
    log::info!("Showing quick pane window");

    position_quick_pane_on_cursor_monitor(&app);

    #[cfg(target_os = "macos")]
    {
        let panel = app
            .get_webview_panel(QUICK_PANE_LABEL)
            .map_err(|e| AppError::not_found(format!("Quick pane panel not found: {e:?}")))?;
        panel.show_and_make_key();
        log::debug!("Quick pane panel shown (macOS)");
    }

    #[cfg(not(target_os = "macos"))]
    {
        let window = app.get_webview_window(QUICK_PANE_LABEL).ok_or_else(|| {
            AppError::not_found(
                "Quick pane window not found - was init_quick_pane called at startup?",
            )
        })?;
        window
            .show()
            .map_err(|e| AppError::window(format!("Failed to show window: {e}")))?;
        window
            .set_focus()
            .map_err(|e| AppError::window(format!("Failed to focus window: {e}")))?;
        log::debug!("Quick pane window shown");
    }

    Ok(())
}

/// 关闭快速面板窗口。
///
/// 在 macOS 上，隐藏前先调用 `resign_key_window()` 取消 key window 状态，
/// 以避免 macOS 自动激活主窗口（这会导致切换 Space 的视觉干扰）。
///
/// # 幂等性
///
/// 若面板已隐藏，直接返回 `Ok(())`，避免重复触发隐藏逻辑。
/// 这对于 `resign_key_window` 触发的 blur 事件 → 再次调用 dismiss 的
/// 循环场景至关重要。
///
/// # 错误
///
/// - 非 macOS 平台：若 `window.hide()` 失败，返回 [`AppError::window`]；
/// - macOS 平台：若面板查找失败，静默返回 `Ok(())`（面板可能未初始化）。
///
/// # 前端触发方式
///
/// 作为 Tauri 命令暴露给前端，前端在以下场景调用：
/// - 用户按 Esc 键；
/// - 面板失焦（blur 事件）；
/// - 提交输入后自动隐藏。
#[tauri::command]
#[specta::specta]
pub fn dismiss_quick_pane(app: AppHandle) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(panel) = app.get_webview_panel(QUICK_PANE_LABEL) {
            // 守卫：resign_key_window 会触发 blur 事件，进而再次调用 dismiss
            if !panel.is_visible() {
                return Ok(());
            }
            log::info!("Dismissing quick pane window");
            // 在隐藏前先取消 key window，防止 macOS
            // 激活主窗口（会导致切换 Space）
            panel.resign_key_window();
            panel.hide();
            log::debug!("Quick pane panel dismissed (macOS)");
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window(QUICK_PANE_LABEL) {
            let is_visible = window.is_visible().unwrap_or(false);
            if !is_visible {
                log::debug!("Quick pane already hidden, skipping");
                return Ok(());
            }
            log::info!("Dismissing quick pane window");
            window
                .hide()
                .map_err(|e| AppError::window(format!("Failed to hide window: {e}")))?;
            log::debug!("Quick pane window hidden");
        }
    }

    Ok(())
}

/// 切换快速面板窗口的可见性。
///
/// 通过 `is_quick_pane_visible` 检查当前状态，决定调用
/// [`dismiss_quick_pane`] 还是 [`show_quick_pane`]。
///
/// 这是全局快捷键绑定的默认动作：按下快捷键时，若面板已显示则隐藏，
/// 若已隐藏则显示。
///
/// # 前端触发方式
///
/// 作为 Tauri 命令暴露给前端，但通常由 [`register_quick_pane_shortcut`]
/// 注册的全局快捷键直接调用。
#[tauri::command]
#[specta::specta]
pub fn toggle_quick_pane(app: AppHandle) -> Result<(), AppError> {
    log::info!("Toggling quick pane window");

    if is_quick_pane_visible(&app) {
        dismiss_quick_pane(app)
    } else {
        show_quick_pane(app)
    }
}

// ============================================================================
// 快捷键管理
// ============================================================================

/// 注册快速面板全局快捷键，并注销之前已注册的快捷键。
///
/// 此辅助函数同时被 `setup()` 和 [`update_quick_pane_shortcut`] 使用，
/// 以保持快捷键注册逻辑的一致性。
///
/// # 执行步骤
///
/// 1. 加锁 `CURRENT_QUICK_PANE_SHORTCUT` 以原子地完成"获取旧值 + 设置新值"；
/// 2. 若存在旧快捷键，解析为 `Shortcut` 并调用 `unregister` 注销
///    （失败仅警告，不阻塞流程 — 旧快捷键可能已被注销）；
/// 3. 调用 `on_shortcut` 注册新快捷键，回调内监听 `Pressed` 状态
///    调用 [`toggle_quick_pane`]；
/// 4. 将新快捷键字符串保存到 `CURRENT_QUICK_PANE_SHORTCUT`，
///    便于后续注销。
///
/// # 为什么需要跟踪当前快捷键
///
/// `tauri-plugin-global-shortcut` 的 `unregister_all()` 会注销所有快捷键，
/// 包括其他功能注册的。通过跟踪当前快捷键字符串，可以使用 `unregister(shortcut)`
/// 选择性注销，避免影响其他快捷键。
///
/// # 错误
///
/// - 若 Mutex 加锁失败（poisoned），返回 [`AppError::quick_pane`]；
/// - 若新快捷键注册失败（如格式无效、已被其他应用占用），
///   返回 [`AppError::quick_pane`]。
///
/// [`update_quick_pane_shortcut`]: update_quick_pane_shortcut
/// [`toggle_quick_pane`]: toggle_quick_pane
#[cfg(desktop)]
pub fn register_quick_pane_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), AppError> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let global_shortcut = app.global_shortcut();

    // 加锁以原子地获取当前快捷键并更新
    let mut current_shortcut = CURRENT_QUICK_PANE_SHORTCUT
        .lock()
        .map_err(|e| AppError::quick_pane(format!("Failed to lock shortcut mutex: {e}")))?;

    // 若存在旧快捷键则注销
    if let Some(old_shortcut_str) = current_shortcut.take() {
        log::debug!("Unregistering old quick pane shortcut: {old_shortcut_str}");
        // 将旧快捷键字符串解析为 Shortcut
        match old_shortcut_str.parse::<Shortcut>() {
            Ok(old_shortcut) => {
                if let Err(e) = global_shortcut.unregister(old_shortcut) {
                    log::warn!("Failed to unregister old shortcut '{old_shortcut_str}': {e}");
                    // 仍然继续 - 旧快捷键可能已被注销
                }
            }
            Err(e) => {
                log::warn!("Failed to parse old shortcut '{old_shortcut_str}': {e}");
                // 仍然继续 - 若无法解析，则无法注销
            }
        }
    }

    // 注册新快捷键
    let app_handle = app.clone();
    global_shortcut
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            use tauri_plugin_global_shortcut::ShortcutState;
            if event.state == ShortcutState::Pressed {
                log::info!("Quick pane shortcut triggered");
                if let Err(e) = toggle_quick_pane(app_handle.clone()) {
                    log::error!("Failed to toggle quick pane: {e}");
                }
            }
        })
        .map_err(|e| {
            AppError::quick_pane(format!("Failed to register shortcut '{shortcut}': {e}"))
        })?;

    // 保存新快捷键，便于后续注销
    *current_shortcut = Some(shortcut.to_string());
    log::debug!("Registered quick pane shortcut: {shortcut}");

    Ok(())
}

/// 返回默认快捷键常量，供前端使用。
///
/// 前端在偏好设置界面需要显示默认值作为占位符或"重置为默认"按钮的值。
/// 通过 Tauri 命令暴露（而非在前端硬编码），保证 Rust 与前端
/// 默认值始终一致。
///
/// # 返回值
///
/// 返回 [`crate::types::DEFAULT_QUICK_PANE_SHORTCUT`] 的字符串副本。
#[tauri::command]
#[specta::specta]
pub fn get_default_quick_pane_shortcut() -> String {
    DEFAULT_QUICK_PANE_SHORTCUT.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // get_default_quick_pane_shortcut — 正向/边界用例
    // =========================================================================

    #[test]
    fn get_default_quick_pane_shortcut_returns_non_empty_string() {
        let shortcut = get_default_quick_pane_shortcut();
        assert!(!shortcut.is_empty());
    }

    #[test]
    fn get_default_quick_pane_shortcut_contains_command_or_control() {
        let shortcut = get_default_quick_pane_shortcut();
        assert!(
            shortcut.contains("CommandOrControl"),
            "Expected shortcut to contain CommandOrControl, got: {shortcut}"
        );
    }

    #[test]
    fn get_default_quick_pane_shortcut_matches_constant() {
        let shortcut = get_default_quick_pane_shortcut();
        assert_eq!(shortcut, DEFAULT_QUICK_PANE_SHORTCUT);
    }

    #[test]
    fn get_default_quick_pane_shortcut_returns_owned_string() {
        let shortcut1 = get_default_quick_pane_shortcut();
        let shortcut2 = get_default_quick_pane_shortcut();
        // 验证每次调用都返回独立的 owned String
        assert_eq!(shortcut1, shortcut2);
        assert_eq!(shortcut1, DEFAULT_QUICK_PANE_SHORTCUT);
    }
}

/// 更新快速面板的全局快捷键。
///
/// 传入 `None` 则重置为默认值（[`DEFAULT_QUICK_PANE_SHORTCUT`]）。
///
/// # 执行步骤
///
/// 1. 校验输入：非空且长度不超过 50 字符；
/// 2. 桌面平台：调用 [`register_quick_pane_shortcut`] 注册新快捷键
///    （内部会先注销旧快捷键）；
/// 3. 非桌面平台：记录警告并返回 `Ok(())`。
///
/// # 参数
///
/// - `app`：Tauri 应用句柄；
/// - `shortcut`：新的快捷键字符串（如 `"CommandOrControl+Shift+Space"`），
///   或 `None` 重置为默认值。
///
/// # 错误
///
/// - 若快捷键为空字符串，返回 [`AppError::validation`]；
/// - 若快捷键长度超过 50 字符，返回 [`AppError::validation`]；
/// - 若 [`register_quick_pane_shortcut`] 失败，传播其错误。
///
/// # 前端触发方式
///
/// 作为 Tauri 命令暴露给前端，前端在偏好设置面板中用户修改快捷键后调用。
/// 调用成功后，前端还应通过 `save_preferences` 持久化新快捷键到
/// `preferences.json`，以便下次启动时通过 [`load_quick_pane_shortcut`]
/// 恢复。
///
/// [`DEFAULT_QUICK_PANE_SHORTCUT`]: crate::types::DEFAULT_QUICK_PANE_SHORTCUT
/// [`register_quick_pane_shortcut`]: register_quick_pane_shortcut
/// [`load_quick_pane_shortcut`]: crate::commands::preferences::load_quick_pane_shortcut
#[tauri::command]
#[specta::specta]
pub fn update_quick_pane_shortcut(
    app: AppHandle,
    shortcut: Option<String>,
) -> Result<(), AppError> {
    // 若提供了快捷键则进行校验
    if let Some(s) = &shortcut {
        if s.is_empty() {
            return Err(AppError::validation("Shortcut cannot be empty"));
        }
        if s.chars().count() > 50 {
            return Err(AppError::validation(
                "Shortcut too long (max 50 characters)",
            ));
        }
    }

    #[cfg(desktop)]
    {
        let new_shortcut = shortcut.as_deref().unwrap_or(DEFAULT_QUICK_PANE_SHORTCUT);
        log::info!("Updating quick pane shortcut to: {new_shortcut}");

        register_quick_pane_shortcut(&app, new_shortcut)?;

        log::info!("Quick pane shortcut updated successfully");
    }

    #[cfg(not(desktop))]
    {
        let _ = (app, shortcut);
        log::warn!("Global shortcuts not supported on this platform");
    }

    Ok(())
}
