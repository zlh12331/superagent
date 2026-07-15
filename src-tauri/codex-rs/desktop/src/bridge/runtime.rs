//! In-process codex-rs 运行时生命周期管理。
//!
//! 负责以下工作：
//! - 从桌面应用环境构建 `InProcessStartArgs`
//! - 通过 `in_process::start()` 启动 codex-rs `InProcessAppServer`
//! - 通过 `tokio::select!` 运行事件循环（next_event + shutdown 信号）
//! - Graceful shutdown：在消费 client 之前发送 `thread/unsubscribe`
//!
//! ## 双句柄模式
//!
//! `InProcessClientHandle` 被拆分为两部分：
//! - `InProcessClientSender`（可 clone）→ 存储在 `state::AppState` 中，
//!   供命令处理器发送 request/notification
//! - `InProcessClientHandle`（独占）→ 移动到事件循环 task 中，
//!   持有 `next_event()` 和 `shutdown()` 的所有权
//!
//! 这种拆分是必要的，因为 `shutdown(self)` 需要所有权，
//! 而命令处理器需要并发的 `&self` 访问以调用 `request()` / `notify()`。

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

use codex_app_server::in_process::{
    self, DEFAULT_IN_PROCESS_CHANNEL_CAPACITY, InProcessClientHandle,
};
use codex_app_server_protocol::ClientInfo;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::InitializeParams;
use codex_arg0::Arg0DispatchPaths;
use codex_config::{CloudConfigBundleLoader, LoaderOverrides, NoopThreadConfigLoader};
use codex_core::config::{Config, ConfigBuilder, find_codex_home};
use codex_exec_server::{EnvironmentManager, ExecServerRuntimePaths};
use codex_feedback::CodexFeedback;
use codex_otel::OtelProvider;
use codex_protocol::protocol::SessionSource;
use codex_rollout::state_db as rollout_state_db;
use tauri::AppHandle;
use tauri::async_runtime::JoinHandle;
use tokio::sync::mpsc;

use crate::bridge::request::send_request_with_timeout;
use crate::error::AppError;
use crate::state;

/// shutdown 信号的 channel 容量（最多只发送 1 条消息）。
const SHUTDOWN_CHANNEL_CAPACITY: usize = 1;

/// OTel 服务名 — 用于 metrics/trace 上报时的 service.name 标签。
///
/// 借鉴 codex-main 的 `OTEL_SERVICE_NAME = "codex-app-server"`：
/// 桌面端使用 "superagent" 区分来源，便于在 telemetry 后端按客户端过滤。
const OTEL_SERVICE_NAME: &str = "superagent";

/// 全局存储 OtelProvider — 保持其生命周期与进程一致。
///
/// 借鉴 codex-main 的 `app-server/src/lib.rs:532-545`：
/// - `build_provider` 在默认配置下（无 OTEL exporter）返回 `Ok(None)`，不安装任何 provider
/// - 如果用户在 config.toml 中配置了 OTEL exporter，则返回 `Some(provider)`
/// - `record_process_start` 和 `install_sqlite_telemetry` 都接受 `Option<&OtelProvider>`，
///   `None` 时为 no-op，安全调用
///
/// 使用 `OnceLock` 而非 `Mutex`：OtelProvider 安装后只读，不需要后续修改。
/// 持有 `Option<OtelProvider>` 而非 `OtelProvider`：默认配置下为 `None`。
static OTEL_PROVIDER: OnceLock<Option<OtelProvider>> = OnceLock::new();

/// 运行时句柄的全局存储。
///
/// 使用 `Mutex<Option<RuntimeHandle>>` 的原因：
/// - `RuntimeHandle` 包含 `JoinHandle` 和 `mpsc::Sender`，它们是 `Send`
///   但不是 `Sync` — 用 `Mutex` 包装后即可变为 `Send + Sync`
/// - `Option` 允许在 shutdown 时取出句柄
/// - `OnceLock` 提供一次性初始化，无需 `lazy_static`
static RUNTIME_HANDLE: OnceLock<Mutex<Option<RuntimeHandle>>> = OnceLock::new();

/// 运行中的 codex runtime 句柄。
///
/// drop 此句柄不会关闭 runtime — 请在应用退出时显式调用
/// [`shutdown_runtime`]。
///
/// `shutdown_tx` sender 用于向事件循环发送停止信号，
/// `event_loop_task` 则被 await 以确保干净地终止。
pub struct RuntimeHandle {
    shutdown_tx: Option<mpsc::Sender<()>>,
    event_loop_task: JoinHandle<()>,
}

impl RuntimeHandle {
    /// 向事件循环发送 shutdown 信号并等待其完成。
    ///
    /// 这是异步 shutdown 序列的同步封装：
    /// 1. 通过 channel 发送 shutdown 信号
    /// 2. 等待事件循环 task 结束（task 内部会调用 `client.shutdown()`）
    pub fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            // try_send 是非阻塞的 — 事件循环会随后取到该信号
            let _ = tx.try_send(());
        }
        // 阻塞等待事件循环 task 退出。
        // `tauri::async_runtime::JoinHandle` 实现了 `Future`，因此可以直接
        // await。如果 task 已经结束，此处会立即返回。
        // 使用 `block_on` 是因为 `RunEvent::Exit` 是同步的。
        tauri::async_runtime::block_on(async {
            let _ = (&mut self.event_loop_task).await;
        });
    }
}

/// 初始化 in-process codex-rs 运行时。
///
/// 本函数执行以下步骤：
/// 1. 解析 `codex_home` 并加载基础 `Config`
/// 2. 初始化 SQLite 状态数据库
/// 3. 构建桌面应用适用的 `InProcessStartArgs` 默认值
/// 4. 调用 `in_process::start()` 启动运行时（包含 initialize 握手）
/// 5. 提取 `InProcessClientSender` 并存入全局 state
/// 6. 启动事件循环 task 消费 `InProcessServerEvent`
///
/// # 参数
///
/// * `app_handle` — Tauri 应用句柄，用于向前端 emit 事件
///
/// # 错误
///
/// 如果运行时启动失败，返回 `AppError::RuntimeStart`。
pub async fn init_app_server(app_handle: AppHandle) -> Result<(), AppError> {
    log::info!("Initializing codex-rs in-process runtime...");

    // 1. 解析 codex_home — 存放 codex 配置和数据的目录。
    //    首次运行时该目录可能不存在；find_codex_home 会处理创建。
    let codex_home = find_codex_home()
        .map_err(|e| AppError::runtime_start(format!("failed to find codex_home: {e}")))?;
    log::debug!("codex_home: {}", codex_home.display());

    // 2. 加载配置。ConfigBuilder 会尝试加载用户/项目配置；
    //    如果失败，则回退到默认配置，保证应用仍能启动。
    let config = match ConfigBuilder::default()
        .codex_home(codex_home.as_path().to_path_buf())
        .build()
        .await
    {
        Ok(config) => config,
        Err(e) => {
            log::warn!(
                "Failed to load codex config, using defaults: {e}. \
                 The app will start with default settings."
            );
            Config::load_default_with_cli_overrides_for_codex_home(
                codex_home.as_path().to_path_buf(),
                Vec::new(),
            )
            .await
            .map_err(|e| AppError::runtime_start(format!("failed to load default config: {e}")))?
        }
    };
    let config = Arc::new(config);

    // 2.5. 初始化 OpenTelemetry provider — 借鉴 codex-main 的 `app-server/src/lib.rs:532-545`
    //
    // codex-main 的 app-server 在 `start_app_server` 中调用 `build_provider`，
    // 但 InProcess 路径（`in_process::start`）不包含 OTEL 初始化，桌面端需自行接入。
    //
    // ## 行为说明
    //
    // - 默认配置（无 OTEL exporter）→ `build_provider` 返回 `Ok(None)`，不安装任何 provider
    // - 用户在 config.toml 中配置 OTEL → 返回 `Some(provider)`，安装后开始上报 metrics/trace
    // - `default_analytics_enabled = false`：桌面端默认不启用 analytics，
    //   遵循"用户未明确同意则不上报"的隐私原则
    //
    // ## 错误处理
    //
    // OTEL 初始化失败不阻止 runtime 启动（non-fatal）：
    // - 记录 warning 日志
    // - 继续启动 runtime（OTEL 是可观测性附加能力，非核心功能）
    //
    // ## 生命周期
    //
    // `OtelProvider` 存储在全局 `OnceLock<Option<OtelProvider>>` 中，
    // 与进程同生命周期。shutdown 不需要显式释放（进程退出时自动清理）。
    init_otel_provider(&config);

    // 3. 初始化 SQLite 状态数据库，用于 rollout 持久化。
    //    此步骤是非致命的 — 没有 state DB 运行时也能工作
    //    （remote control 和部分历史功能将不可用）。
    let state_db = match rollout_state_db::try_init(config.as_ref()).await {
        Ok(state_db) => Some(state_db),
        Err(e) => {
            log::warn!(
                "Failed to initialize SQLite state DB, continuing without it: {e}. \
                 Remote control and history features may be unavailable."
            );
            None
        }
    };

    // 4. 构造本地执行环境所需的 runtime paths 并构建 environment manager。
    //    codex_self_exe 指向当前 Tauri 应用可执行文件，exec-server 子进程
    //    通过 argv0 派发模式调用主程序的隐藏 helper 子命令
    //    （如 apply_patch、codex-fs-helper 等）。
    //    codex_linux_sandbox_exe 仅 Linux 平台沙箱需要，桌面应用暂传 None。
    //    传入 from_env 满足 codex-rs 核心硬契约：
    //    "声明 include_local = true 时必须提供 runtime paths"。
    let local_runtime_paths = ExecServerRuntimePaths::from_optional_paths(
        std::env::current_exe().ok(),
        None,
    )
    .map_err(|e| AppError::runtime_start(format!("failed to resolve runtime paths: {e}")))?;

    // from_env 读取 CODEX_* 环境变量，无需 codex_home 目录完整配置。
    // 传入 Some(local_runtime_paths) 满足 codex-rs 核心硬契约。
    let environment_manager = EnvironmentManager::from_env(Some(local_runtime_paths))
        .await
        .map_err(|e| AppError::runtime_start(format!("failed to init environment manager: {e}")))?;
    let environment_manager = Arc::new(environment_manager);

    // 5. 构造桌面应用适用的 InProcessStartArgs 默认值。
    let args = in_process::InProcessStartArgs {
        arg0_paths: Arg0DispatchPaths::default(),
        config: Arc::clone(&config),
        cli_overrides: Vec::new(),
        loader_overrides: LoaderOverrides::default(),
        strict_config: false,
        cloud_config_bundle: CloudConfigBundleLoader::default(),
        thread_config_loader: Arc::new(NoopThreadConfigLoader),
        feedback: CodexFeedback::new(),
        // 启用 SQLite 日志层 — 借鉴 codex-main 的多层 tracing_subscriber 架构
        // log_db 将 tracing 事件持久化到 state_db 的 SQLite 日志表，
        // 支持按 thread_id / 级别 / 时间范围结构化查询历史日志。
        // state_db 为 None 时（初始化失败）回退为 None，runtime 仍可运行。
        log_db: state_db.clone().map(codex_state::log_db::start),
        state_db,
        environment_manager: Arc::clone(&environment_manager),
        config_warnings: Vec::new(),
        // 桌面应用使用 Custom("desktop") 作为会话来源，
        // 区分于 Cli/VSCode 等其他客户端，影响 thread/search 的 sourceKinds 过滤
        // 和 rollout 文件中的 session_source 元数据。
        session_source: SessionSource::Custom("desktop".to_string()),
        enable_codex_api_key_env: false,
        initialize: InitializeParams {
            client_info: ClientInfo {
                name: "superagent".to_string(),
                title: Some("SuperAgent".to_string()),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            capabilities: None,
        },
        channel_capacity: DEFAULT_IN_PROCESS_CHANNEL_CAPACITY,
    };

    // 6. 启动 in-process 运行时。内部会执行 initialize/initialized
    //    握手，并返回一个可直接使用的 client 句柄。
    let client = in_process::start(args)
        .await
        .map_err(|e| AppError::runtime_start(format!("in-process runtime failed to start: {e}")))?;

    // 7. 提取可 clone 的 sender 并存入全局 state，
    //    供命令处理器使用。
    let sender = client.sender();
    state::set_sender(sender)?;
    state::set_connection_mode(state::ConnectionMode::InProcess);

    log::info!("Codex-rs in-process runtime started successfully");

    // 8. 启动事件循环 task。client 句柄会被 move 到 task 中，
    //    因为 next_event() 和 shutdown() 需要所有权。
    let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(SHUTDOWN_CHANNEL_CAPACITY);
    let event_loop_task =
        tauri::async_runtime::spawn(run_event_loop(client, app_handle, shutdown_rx));

    let runtime_handle = RuntimeHandle {
        shutdown_tx: Some(shutdown_tx),
        event_loop_task,
    };

    // 存入全局 static，供后续从 RunEvent::Exit 中触发 shutdown
    let mutex = RUNTIME_HANDLE.get_or_init(|| Mutex::new(None));
    // Mutex 中毒说明另一线程 panic，恢复内部数据以写入新值
    *mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(runtime_handle);

    Ok(())
}

/// in-process codex-rs 运行时的事件循环。
///
/// 本函数运行在专属的 tokio task 中，负责：
/// - 从运行时消费 `InProcessServerEvent`
/// - 将 `ServerNotification` emit 到 Tauri 前端
/// - 将 `ServerRequest` 注册到 pending approval 存储
/// - 记录 `Lagged` 事件（通过 TurnCompleted backfill 恢复背压丢事件）
/// - 收到 shutdown 信号时优雅关闭
///
/// # Shutdown 序列
///
/// 1. 通过 `shutdown_rx` 收到 shutdown 信号
/// 2. 跳出事件循环
/// 3. 为所有已加载的 thread 发送 `thread/unsubscribe`（best-effort）
/// 4. 调用 `client.shutdown()` 排空 pending work 并终止 tasks
/// 5. 清理全局 state（`state::clear_sender` + `approval::clear`）
///
/// 步骤 3-5 实现 project_memory 约束：
/// "shutdown() must first send thread/unsubscribe for graceful disconnection
/// before consuming the client"
async fn run_event_loop(
    mut client: InProcessClientHandle,
    app_handle: AppHandle,
    mut shutdown_rx: mpsc::Receiver<()>,
) {
    log::info!("Codex event loop started");

    loop {
        tokio::select! {
            // 从 codex-rs 运行时接收事件
            event = client.next_event() => match event {
                Some(event) => {
                    // 使用 bridge::event::dispatch_event 统一分发
                    crate::bridge::event::dispatch_event(&app_handle, event);
                }
                None => {
                    // 事件流关闭 — 运行时已断开连接
                    crate::bridge::event::emit_disconnected(
                        &app_handle,
                        "event stream closed by runtime",
                    );
                    break;
                }
            },

            // 来自 RuntimeHandle::shutdown() 的关闭信号
            _ = shutdown_rx.recv() => {
                log::info!("Shutdown signal received — stopping codex event loop");
                break;
            }
        }
    }

    // ========================================================================
    // Graceful shutdown 序列（Task 8）
    // ========================================================================
    //
    // 1. 发送 thread/unsubscribe 取消订阅所有已加载线程
    //    确保 codex-rs 正确释放每个线程的服务器端资源
    //    （事件 channel、rollout writer 等）
    // 2. 调用 client.shutdown() 终止 runtime（排空 pending work + 终止 tasks）
    // 3. 清理全局状态（sender + pending approvals）
    //
    // 遵循 project_memory 约束：
    // "shutdown() must first send thread/unsubscribe for graceful disconnection
    // before consuming the client"
    log::info!("Shutting down codex-rs in-process runtime...");

    // Step 1: 取消订阅所有已加载线程（best-effort，失败不阻止 shutdown）
    unsubscribe_all_loaded_threads().await;

    // Step 2: 关闭 runtime — 排空 pending work 并终止内部 tasks
    if let Err(e) = client.shutdown().await {
        log::error!("Codex runtime shutdown error: {e}");
    } else {
        log::info!("Codex-rs runtime shut down cleanly");
    }

    // Step 3: 清理全局状态
    // clear_sender 使后续命令返回 NotInitialized，而不是使用已失效的 sender
    // （失效的 sender 会导致命令永久挂起或返回模糊的传输错误）
    state::clear_sender();
    // clear 清除所有 pending approval requests，防止 stale 请求残留
    // （用户在 shutdown 后尝试响应审批会收到 NotFound 错误）
    crate::bridge::approval::clear();
}

/// 取消订阅所有已加载（subscribed）的线程。
///
/// 在 `client.shutdown()` 之前调用，确保 codex-rs 正确释放每个线程的
/// 服务器端资源（事件 channel、rollout writer 等）。
///
/// # Best-effort 语义
///
/// 此函数是 best-effort 操作：
/// - 如果 runtime 未初始化，直接返回（shutdown 会处理剩余清理）
/// - 如果 `thread/loaded/list` 失败，记录警告并跳过取消订阅
/// - 单个线程的 `thread/unsubscribe` 失败只记录警告，不阻止其他线程取消订阅
/// - 使用短超时（5s 列表 / 3s 每个取消订阅），防止卡住的线程阻塞 shutdown
///
/// # 分页处理
///
/// `thread/loaded/list` 返回分页结果，通过 `next_cursor` 翻页。
/// 每页请求 100 条（服务器可能限制实际返回数量），直到 `next_cursor` 为 None。
async fn unsubscribe_all_loaded_threads() {
    // 获取全局 sender — 如果未初始化，说明 runtime 已关闭，无需取消订阅
    let sender = match state::handle() {
        Ok(sender) => sender,
        Err(e) => {
            log::debug!("Skipping thread unsubscribe — runtime not initialized: {e}");
            return;
        }
    };

    // 收集所有已加载线程 ID（分页拉取）
    let mut all_thread_ids: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        // 使用 serde_json::json! 构造参数（与 commands/thread.rs 模式一致），
        // 避免直接导入 protocol::v2 模块（该模块在 lib.rs 中未公开导出）。
        // serde_json::from_value 会根据 ClientRequest::ThreadLoadedList 的 params
        // 字段类型自动推断目标类型。
        let params = match serde_json::from_value(serde_json::json!({
            "cursor": cursor,
            // 每页 100 条，减少 round trips（服务器可能限制实际返回数量）
            "limit": 100,
        })) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Failed to construct ThreadLoadedListParams: {e}");
                break;
            }
        };

        let request = ClientRequest::ThreadLoadedList {
            request_id: state::sequencer().next_id(),
            params,
        };

        // 使用 5 秒超时 — 这是本地操作，正常情况 < 100ms
        let response = match send_request_with_timeout(&sender, request, Duration::from_secs(5)).await {
            Ok(value) => value,
            Err(e) => {
                log::warn!("Failed to list loaded threads during shutdown: {e}");
                break;
            }
        };

        // 从响应中提取 thread IDs 和 nextCursor
        // ThreadLoadedListResponse: { data: Vec<String>, nextCursor: Option<String> }
        // 使用 serde_json::Value 导航，避免导入 v2 类型
        // 先创建一个空 Vec 并绑定到 let，避免 `unwrap_or(&Vec::new())` 中的临时值
        // 在语句结束时被 drop 导致借用错误（E0716）。
        let empty_vec: Vec<serde_json::Value> = Vec::new();
        let data = response
            .get("data")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty_vec);
        let thread_ids: Vec<String> = data
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        all_thread_ids.extend(thread_ids);

        // 检查是否还有更多页 — nextCursor 为 None 或空字符串表示已到末页
        let next_cursor = response
            .get("nextCursor")
            .and_then(|v| v.as_str())
            .map(String::from);

        match next_cursor {
            Some(next) if !next.is_empty() => {
                cursor = Some(next);
            }
            _ => break,
        }
    }

    if all_thread_ids.is_empty() {
        log::info!("No loaded threads to unsubscribe during shutdown");
        return;
    }

    log::info!(
        "Unsubscribing {} loaded thread(s) before shutdown",
        all_thread_ids.len()
    );

    // 逐个取消订阅 — 使用 3 秒超时防止单个卡住的线程阻塞整个 shutdown
    let mut success_count: u32 = 0;
    let mut fail_count: u32 = 0;

    for thread_id in &all_thread_ids {
        // 同样使用 serde_json::json! 构造参数
        let params = match serde_json::from_value(serde_json::json!({
            "threadId": thread_id,
        })) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Failed to construct ThreadUnsubscribeParams for {thread_id}: {e}");
                fail_count += 1;
                continue;
            }
        };

        let request = ClientRequest::ThreadUnsubscribe {
            request_id: state::sequencer().next_id(),
            params,
        };

        match send_request_with_timeout(&sender, request, Duration::from_secs(3)).await {
            Ok(_) => success_count += 1,
            Err(e) => {
                log::warn!("Failed to unsubscribe thread {thread_id} during shutdown: {e}");
                fail_count += 1;
            }
        }
    }

    log::info!(
        "Thread unsubscribe complete: {success_count} succeeded, {fail_count} failed"
    );
}

/// 如果运行时正在运行，则将其关闭。
///
/// 本函数预期从 `lib.rs` 的 `RunEvent::Exit` 中调用。
/// 即使运行时从未初始化也安全（此时为 no-op）。
///
/// 使用 `RUNTIME_HANDLE.get()`（而非 `get_or_init`），这样从未初始化的
/// 运行时不会创建空的 `Mutex` — 保证 "是否已启动?" 检查的准确性。
pub fn shutdown_runtime() {
    if let Some(mutex) = RUNTIME_HANDLE.get()
        && let Ok(mut guard) = mutex.lock()
        && let Some(handle) = guard.as_mut()
    {
        handle.shutdown();
    }
}

/// 初始化 OpenTelemetry provider 并安装到全局存储。
///
/// 借鉴 codex-main 的 `app-server/src/lib.rs:532-545`：在 runtime 启动前
/// 调用 `build_provider` 构建 OTEL provider，并执行 `record_process_start`
/// 和 `install_sqlite_telemetry` 注册 process 启动指标和 SQLite 遥测。
///
/// ## 默认行为
///
/// - 用户未配置 OTEL exporter（默认）→ `build_provider` 返回 `Ok(None)`，
///   `record_process_start` 和 `install_sqlite_telemetry` 均为 no-op
/// - 用户在 `~/.codex/config.toml` 中配置 `[otel]` exporter → 返回 `Some(provider)`，
///   开始上报 metrics/trace 到指定 endpoint
///
/// ## 错误处理
///
/// OTEL 初始化失败不阻止 runtime 启动（non-fatal）：
/// - 记录 warning 日志
/// - 跳过后续 record/install 调用
/// - 继续启动 runtime（OTEL 是可观测性附加能力，非核心功能）
///
/// ## 重复调用保护
///
/// 使用 `OnceLock::set` 的返回值判断是否已初始化：
/// - 首次调用：执行初始化
/// - 后续调用（理论上不会发生）：跳过，记录 debug 日志
///
/// # 参数
///
/// - `config` — 已加载的 codex 配置，包含 `[otel]` 段
fn init_otel_provider(config: &Config) {
    // 首次调用执行初始化，后续调用（runtime 重启等场景）跳过
    let is_first_init = OTEL_PROVIDER.set(build_and_install_otel(config)).is_ok();
    if !is_first_init {
        log::debug!("OTEL provider already initialized — skipping");
    }
}

/// 构建 OTEL provider 并执行 metrics/telemetry 安装。
///
/// 这是 `init_otel_provider` 的内部实现，分离出来便于 `OnceLock::set` 直接消费返回值。
///
/// # 参数
///
/// - `config` — codex 配置引用
///
/// # 返回
///
/// 返回 `Option<OtelProvider>`：
/// - `None` — 默认配置或初始化失败（已记录日志）
/// - `Some(provider)` — 成功构建并安装，需存储到全局 `OnceLock` 保持生命周期
fn build_and_install_otel(config: &Config) -> Option<OtelProvider> {
    // 借鉴 codex-main 的调用：build_provider(config, version, name_override, analytics_default)
    // - service_version 使用 desktop 的 CARGO_PKG_VERSION
    // - service_name_override 使用 "superagent" 区分于 codex-app-server
    // - default_analytics_enabled = false：遵循"用户未明确同意则不上报"原则
    let otel = match codex_core::otel_init::build_provider(
        config,
        env!("CARGO_PKG_VERSION"),
        Some(OTEL_SERVICE_NAME),
        false,
    ) {
        Ok(otel) => otel,
        Err(e) => {
            // OTEL 配置错误（如 endpoint 格式错误）— 记录警告但不阻止启动
            log::warn!("Failed to build OTEL provider, continuing without telemetry: {e}");
            return None;
        }
    };

    // 记录 process 启动指标（如 process.start 时间戳）
    // otel 为 None 时为 no-op，安全调用
    codex_core::otel_init::record_process_start(otel.as_ref(), OTEL_SERVICE_NAME);

    // 安装 SQLite telemetry recorder — 将 SQLite 操作指标上报到 metrics 后端
    // otel 为 None 时为 no-op，安全调用
    codex_core::otel_init::install_sqlite_telemetry(otel.as_ref(), OTEL_SERVICE_NAME);

    if otel.is_some() {
        log::info!("OTEL provider initialized — telemetry export enabled");
    } else {
        log::debug!("OTEL provider not configured — telemetry export disabled (default)");
    }

    otel
}
