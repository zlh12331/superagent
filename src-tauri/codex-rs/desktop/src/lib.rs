//! Tauri 应用库入口。
//!
//! 本模块作为 Tauri 应用的主入口。
//! 命令实现组织在 `commands` 模块中，
//! 共享类型则位于 `types` 模块。

// 测试编译时放宽 clippy 规则：测试代码中 .unwrap()/.expect() 是标准实践。
// 仅在 cfg(test) 下生效，不影响生产代码的 clippy 检查。
#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used))]

mod bindings;

// 模块向 tests/ 目录下的集成测试暴露。
// #[doc(hidden)] 使其不出现在 rustdoc 中。
#[doc(hidden)]
pub mod bridge;
#[doc(hidden)]
pub mod commands;
#[doc(hidden)]
pub mod error;
#[doc(hidden)]
pub mod state;
#[doc(hidden)]
pub mod types;
#[doc(hidden)]
pub mod utils;

use tauri::{Manager, RunEvent, WindowEvent};

// 仅 re-export 外部所需的项
pub use types::DEFAULT_QUICK_PANE_SHORTCUT;

/// 应用入口。设置所有插件并初始化应用。
///
/// Sentry 优先于其他代码初始化，以便捕获插件设置或应用构造期间的 panic。
/// `_sentry_guard` 必须在整个应用生命周期内存活——drop 时会在 `shutdown_timeout`
/// （默认 2 秒）内将待处理事件 flush 到 Sentry。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 应用入口函数 — 构建 Tauri 应用并启动事件循环。
///
/// `.expect()` 位于应用启动路径：若 Tauri 构建失败，应用无法运行，
/// panic 是唯一合理行为（与 std::process::exit 等效）。
#[allow(clippy::expect_used)]
pub fn run() {
    // 创建自定义 tokio runtime，增大 worker 线程栈大小到 8MB（默认 2MB）。
    //
    // 原因：codex-rs 内部的 async 函数链较深（account/read、thread/start 等），
    // 在 debug 模式下 async 状态机未经优化，栈使用量远大于 release 模式。
    // 默认 2MB 栈大小会导致 tokio worker 线程栈溢出（STATUS_STACK_OVERFLOW 0xc00000fd）。
    //
    // 使用 `Box::leak` 保持 runtime 全局存活——Tauri 文档明确要求不能 drop
    // 通过 `async_runtime::set` 注册的 runtime。runtime 生命周期与进程一致，
    // 泄漏是预期行为，不会造成资源浪费。
    //
    // 必须在 `sentry::init` 和 `tauri::Builder::default()` 之前调用，
    // 因为 `set` 在 runtime 已初始化时会 panic。
    let tokio_runtime = Box::leak(Box::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_stack_size(8 * 1024 * 1024) // 8MB，默认 2MB 的 4 倍
            .build()
            .expect("Failed to build tokio runtime"),
    ));
    tauri::async_runtime::set(tokio_runtime.handle().clone());

    // 优先于其他代码初始化 Sentry。
    //
    // DSN 在编译期通过 `option_env!("SENTRY_DSN")` 读取——该宏读取
    // `build.rs` 通过 `cargo:rustc-env` 设置的 `SENTRY_DSN` 环境变量。
    // 使用 `option_env!`（而非依赖 sentry 运行时 `env::var`）是必要的，
    // 因为 `cargo:rustc-env` 只影响编译期，不影响运行时进程环境。
    //
    // 若 DSN 未设置，`dsn: None` → sentry::init 返回 no-op guard。
    //
    // `before_send` 作为同意门控：除非用户已明确授权（`CONSENT_STATE == 1`），
    // 否则事件被丢弃。同意状态在 `setup()` 中从 `preferences.json` 初始化，
    // 并通过 `set_consent` Tauri 命令在用户于 UI 中切换同意时更新。
    let _sentry_guard = sentry::init(sentry::ClientOptions {
        dsn: option_env!("SENTRY_DSN")
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse().ok()),
        release: sentry::release_name!(),
        environment: Some(if cfg!(debug_assertions) {
            "development".into()
        } else {
            "production".into()
        }),
        // 全量错误采样——自托管 Sentry 无配额限制
        sample_rate: 1.0,
        // 禁用 Rust 侧性能追踪——桌面应用无 HTTP 请求链可追踪。
        // 前端（React SDK）保留追踪，用于 Web Vitals（LCP/FCP/INP/CLS）。
        traces_sample_rate: 0.0,
        // 为所有捕获的事件附加堆栈
        attach_stacktrace: true,
        // Release Health：跟踪无崩溃会话率
        auto_session_tracking: true,
        // 同意门控 + 脱敏：除非用户已授权，否则丢弃事件；
        // 传输前对敏感数据脱敏。
        // CONSENT_STATE：0=未知，1=已授权，2=已拒绝。
        //
        // 脱敏覆盖 8 个标准敏感键（token、password、secret、cookie 等）
        // + Codex 项目专属键（thread_id、session_id）。
        // 这与前端的 `redactSentryEvent` 对齐——Rust 侧产生的事件
        // （panic 捕获、日志事件）也经过脱敏。
        before_send: Some(std::sync::Arc::new(|mut event| {
            if commands::crash_report::CONSENT_STATE.load(std::sync::atomic::Ordering::Relaxed) != 1
            {
                return None;
            }
            utils::redact::redact_sentry_event(&mut event);
            Some(event)
        })),
        // 增大关闭超时，确保退出时事件已 flush
        shutdown_timeout: std::time::Duration::from_secs(5),
        ..Default::default()
    });

    let builder = bindings::generate_bindings();

    // 在 debug 构建中导出 TypeScript 绑定。
    // 注意：tauri-specta rc.25 在 Windows debug 构建生成类型时可能栈溢出。
    // 若崩溃，运行 `cargo test export_bindings --release -- --ignored` 手动重新生成绑定，
    // 或运行 `npm run gen:bindings`（若可用）。
    #[cfg(all(debug_assertions, not(target_os = "windows")))]
    bindings::export_ts_bindings();

    // 使用通用插件构建
    let mut app_builder = tauri::Builder::default();

    // 单实例插件必须最先注册
    // 用户尝试打开第二个实例时，改为聚焦已有窗口
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }));
    }

    // 窗口状态插件——保存/恢复窗口位置和大小
    // 注意：quick-pane 被加入黑名单，因为它是 NSPanel，调用 is_maximized() 会崩溃
    // 参见：https://github.com/tauri-apps/plugins-workspace/issues/1546
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all())
                .with_denylist(&["quick-pane"])
                .build(),
        );
    }

    // Positioner 插件——启用相对托盘的窗口定位
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(tauri_plugin_positioner::init());
    }

    // Autostart 插件——允许用户在偏好中启用"开机启动"
    // 默认关闭；用户通过"通用"偏好面板开启。
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    // Deep link 插件——允许通过 tauri-app:// URL 打开应用。
    // on_open_url 处理器（在 setup 中注册）显示/聚焦主窗口；
    // 前端通过 @tauri-apps/plugin-deep-link 监听以进行导航。
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(tauri_plugin_deep_link::init());
    }

    // Updater 插件——用于应用内更新
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    // HTTP 插件——Rust 侧 HTTP 客户端，绕过浏览器 CORS。
    // 用于 API 配置表单和外部服务集成。
    app_builder = app_builder.plugin(tauri_plugin_http::init());

    // Shell 插件——生成子进程并通过系统默认应用打开文件/URL。
    // 与 opener 插件互补，支持命令执行。
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(tauri_plugin_shell::init());
    }

    // Store 插件——支持原子写入的持久化键值存储。
    // 用于应用偏好和轻量状态持久化。
    app_builder = app_builder.plugin(tauri_plugin_store::Builder::new().build());

    app_builder = app_builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin({
            #[allow(unused_mut)]
            let mut targets = vec![
                // 始终输出到 stdout，便于开发
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                // macOS 上写入系统日志（出现在 Console.app）
                #[cfg(target_os = "macos")]
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: None,
                }),
            ];
            // 写入 webview 控制台——Linux 在 setup() 期间 WebKitGTK webview 尚不存在，
            // 会导致 app.emit() 在 IPC socket 上死锁，故排除。
            #[cfg(not(target_os = "linux"))]
            targets.push(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Webview,
            ));
            tauri_plugin_log::Builder::new()
                // 开发环境用 Debug 级别，生产用 Info
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .targets(targets)
                .build()
        });

    // macOS：添加 NSPanel 插件以获得原生面板行为
    #[cfg(target_os = "macos")]
    {
        app_builder = app_builder.plugin(tauri_nspanel::init());
    }

    app_builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            log::info!("Application starting up");
            log::debug!(
                "App handle initialized for package: {}",
                app.package_info().name
            );

            // 在设置 panic hook 之前，从已保存的偏好初始化同意状态。
            // 确保 setup() 之后的 panic 遵循用户之前保存的同意
            // （隐私安全默认值：0=未知）。
            commands::crash_report::init_consent_from_preferences(app.handle());

            // 提前设置 panic hook，以捕获初始化期间的任何 panic
            commands::crash_report::setup_panic_hook(app.handle());

            // 配置 Sentry scope 的应用上下文标签。
            // 这些标签出现在每个 Sentry 事件上，帮助识别环境
            // （OS、arch、应用版本）而不发送 PII。
            sentry::configure_scope(|scope| {
                let pkg = app.package_info();
                scope.set_tag("app.name", &pkg.name);
                scope.set_tag("app.version", pkg.version.to_string());
                scope.set_tag("os.family", std::env::consts::OS);
                scope.set_tag("os.arch", std::env::consts::ARCH);
                scope.set_context("device", {
                    let mut map = std::collections::BTreeMap::new();
                    map.insert("arch".to_string(), std::env::consts::ARCH.into());
                    map.insert("os_name".to_string(), std::env::consts::OS.into());
                    sentry::protocol::Context::Other(map)
                });
                scope.set_context("app", {
                    let mut map = std::collections::BTreeMap::new();
                    map.insert("app_name".to_string(), pkg.name.clone().into());
                    map.insert("app_version".to_string(), pkg.version.to_string().into());
                    sentry::protocol::Context::Other(map)
                });
            });

            // 设置全局快捷键插件（不携带任何快捷键——单独注册）
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::Builder;

                app.handle().plugin(Builder::new().build())?;
            }

            // 加载已保存的偏好并注册 quick pane 快捷键
            #[cfg(desktop)]
            {
                let saved_shortcut = commands::preferences::load_quick_pane_shortcut(app.handle());
                let shortcut_to_register = saved_shortcut
                    .as_deref()
                    .unwrap_or(DEFAULT_QUICK_PANE_SHORTCUT);

                log::info!("Registering quick pane shortcut: {shortcut_to_register}");
                commands::quick_pane::register_quick_pane_shortcut(
                    app.handle(),
                    shortcut_to_register,
                )?;
            }

            // 创建 quick pane 窗口（隐藏）——必须在主线程执行
            if let Err(e) = commands::quick_pane::init_quick_pane(app.handle()) {
                log::error!("Failed to create quick pane: {e}");
                // 非致命：应用可在无 quick pane 的情况下继续运行
            }

            // 初始化系统托盘（仅桌面）
            #[cfg(desktop)]
            {
                if let Err(e) = commands::tray::init_tray(app.handle()) {
                    log::error!("Failed to initialize system tray: {e}");
                    // 非致命：应用可在无托盘的情况下继续运行
                }
            }

            // 初始化 deep link 处理（仅桌面）
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // 运行时注册所有已配置的 scheme，使 deep link 在
                // Windows 和 Linux 的 dev 模式下生效（macOS 需已安装 bundle）。
                #[cfg(any(windows, target_os = "linux"))]
                {
                    if let Err(e) = app.deep_link().register_all() {
                        log::warn!("Failed to register deep link schemes: {e}");
                    }
                }

                // 处理 deep link 事件：显示/聚焦主窗口。
                // 前端通过 @tauri-apps/plugin-deep-link 监听以进行导航。
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        // P1-6 修复：deep link URL 可能携带 OAuth token
                        //（如 `tauri-app://auth?token=xxx`），只记录 scheme+path，
                        // 并对残留的查询参数脱敏
                        let safe_url = url
                            .as_str()
                            .split('?')
                            .next()
                            .unwrap_or("[invalid url]");
                        let safe_url = crate::utils::redact::redact_sensitive(safe_url);
                        log::info!("Deep link received: {safe_url}");
                    }
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            }

            // 注意：应用菜单从 JavaScript 构建，以支持 i18n
            // 菜单实现见 src/lib/menu.ts

            // 初始化 codex-rs 进程内运行时。
            //
            // 启动嵌入式 app-server，执行 initialize 握手，
            // 并生成事件循环任务，通过 Tauri emit 将 codex 事件转发到前端。
            //
            // 非致命：若运行时启动失败（如配置错误），应用继续运行——
            // codex 命令将返回 NotInitialized，直到运行时可用。
            // 用户可从设置中重试。
            let runtime_app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async {
                if let Err(e) = bridge::runtime::init_app_server(runtime_app_handle).await {
                    log::error!("Failed to initialize codex runtime: {e}");
                }
            });

            Ok(())
        })
        .invoke_handler(builder.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match &event {
            // 桌面：隐藏主窗口而非退出，使托盘图标可重新打开它，
            // 且 quick-pane 快捷键独立工作。
            // macOS 上这也使 dock 图标可重新打开窗口。
            // Windows/Linux 上托盘图标左键切换可见性。
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                #[cfg(desktop)]
                {
                    api.prevent_close();

                    // 隐藏前保存窗口状态
                    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                    if let Err(e) = app_handle.save_window_state(StateFlags::all()) {
                        log::warn!("Failed to save window state: {e}");
                    }

                    // 隐藏窗口，使应用在托盘中继续运行
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.hide();
                        log::info!("Main window hidden (running in tray)");
                    }
                }
            }

            // macOS：Dock 图标点击——若主窗口已隐藏则重新打开
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();

                        // window-state 插件仅在应用启动时自动恢复，
                        // 不会在 hide/show 周期后恢复。
                        // 不调用则窗口可能出现在过时坐标上。
                        use tauri_plugin_window_state::{StateFlags, WindowExt};
                        let _ = window.restore_state(StateFlags::all());

                        let _ = window.set_focus();
                        log::info!("Main window reopened from dock");
                    }
                }
            }

            // 实际退出时清理（Cmd+Q、菜单退出，或非 macOS 上的窗口关闭）。
            // RunEvent::Exit 在进程退出前可靠触发，不像 ExitRequested
            // 在 macOS 的 Cmd+Q 下不触发（tauri-apps/tauri#9198）。
            RunEvent::Exit => {
                log::info!("Application exiting — performing cleanup");

                // 隐藏 quick-pane 面板以避免应用销毁阶段引发崩溃
                #[cfg(target_os = "macos")]
                {
                    use tauri_nspanel::ManagerExt;
                    if let Ok(panel) = app_handle.get_webview_panel("quick-pane") {
                        panel.hide();
                    }
                }

                // 注销全局快捷键
                #[cfg(desktop)]
                {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    if let Err(e) = app_handle.global_shortcut().unregister_all() {
                        log::warn!("Failed to unregister global shortcuts: {e}");
                    }
                }

                // 优雅关闭 codex-rs 运行时。
                // 通知事件循环停止，等待待处理事件排空，
                // 并调用 client.shutdown() 进行清理。
                // 若运行时从未初始化，安全 no-op。
                bridge::runtime::shutdown_runtime();

                log::info!("Cleanup complete");
            }

            _ => {}
        });
}
