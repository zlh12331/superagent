//! codex app-server crate 入口。
//!
//! 本 crate 是 codex-rs 上游 fork 的应用服务器实现，桌面端通过 InProcess 模式
//! 嵌入运行，也可作为独立二进制启动，对外提供 JSON-RPC 接口。
//!
//! # 架构位置
//!
//! app-server 处于 codex-rs 的"中间层"：
//! - 向上：通过 transport 层（stdio / Unix socket / WebSocket）与前端（VS Code、
//!   Tauri 桌面端等）通信。
//! - 向下：调用 `codex-core`、`codex-exec-server`、`codex-config` 等领域 crate
//!   完成实际的会话、执行、配置管理等工作。
//!
//! # 主要组件
//!
//! - [`run_main`] / [`run_main_with_transport_options`]：服务器主入口，启动传输
//!   acceptor、processor 循环与 outbound 路由循环。
//! - `MessageProcessor`：处理 JSON-RPC 请求分发与会话生命周期。
//! - `Transport`：管理多种传输方式下的连接接入与消息收发。
//! - `ConfigManager`：管理配置加载、热更新与多源合并。
//!
//! # 关键约束
//!
//! - 通过 `#![deny(clippy::print_stdout, clippy::print_stderr)]` 禁止直接打印，
//!   所有日志输出必须通过 `tracing`。
//! - 桌面端嵌入运行时通过 `in_process` 模块提供入口。

#![recursion_limit = "256"]
#![deny(clippy::print_stdout, clippy::print_stderr)]

use codex_arg0::Arg0DispatchPaths;
use codex_config::ConfigLayerStackOrdering;
use codex_config::LoaderOverrides;
use codex_config::NoopThreadConfigLoader;
use codex_config::RemoteThreadConfigLoader;
use codex_config::ThreadConfigLoader;
use codex_core::config::Config;
use codex_core::resolve_installation_id;
use codex_login::AuthManager;
#[cfg(debug_assertions)]
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_cli::CliConfigOverrides;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::ErrorKind;
use std::io::Result as IoResult;
use std::path::Path;
use std::sync::Arc;
use std::sync::RwLock;
use std::sync::atomic::AtomicBool;

use crate::analytics_utils::analytics_events_client_from_config;
use crate::config_manager::ConfigManager;
use crate::connection_cleanup::ConnectionCleanupTasks;
use crate::message_processor::MessageProcessor;
use crate::message_processor::MessageProcessorArgs;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::OutgoingEnvelope;
use crate::outgoing_message::OutgoingMessageSender;
use crate::outgoing_message::QueuedOutgoingMessage;
use crate::transport::CHANNEL_CAPACITY;
use crate::transport::ConnectionState;
use crate::transport::OutboundConnectionState;
use crate::transport::RemoteControlPolicy;
use crate::transport::RemoteControlStartConfig;
use crate::transport::TransportEvent;
use crate::transport::acquire_app_server_startup_lock;
use crate::transport::app_server_startup_lock_path;
use crate::transport::auth::policy_from_settings;
use crate::transport::prepare_control_socket_path;
use crate::transport::route_outgoing_envelope;
use crate::transport::start_control_socket_acceptor;
use crate::transport::start_remote_control;
use crate::transport::start_stdio_connection;
use crate::transport::start_websocket_acceptor;
use codex_analytics::AppServerRpcTransport;
use codex_app_server_protocol::ConfigWarningNotification;
use codex_app_server_protocol::JSONRPCMessage;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::TextPosition as AppTextPosition;
use codex_app_server_protocol::TextRange as AppTextRange;
use codex_config::ConfigLayerSource;
use codex_config::ConfigLoadError;
use codex_config::TextRange as CoreTextRange;
use codex_core::ExecPolicyError;
use codex_core::check_execpolicy_for_warnings;
use codex_core::config::find_codex_home;
use codex_exec_server::EnvironmentManager;
use codex_exec_server::ExecServerRuntimePaths;
use codex_feedback::CodexFeedback;
use codex_protocol::protocol::SessionSource;
use codex_rollout::state_db as rollout_state_db;
use codex_state::log_db;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::error;
use tracing::info;
use tracing::warn;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::Registry;
use tracing_subscriber::util::SubscriberInitExt;

/// SQLite 数据库损坏后自动重建时下发给客户端的配置告警摘要文案。
const SQLITE_RECOVERY_CONFIG_WARNING_SUMMARY: &str = "Codex rebuilt its local database.";

mod analytics_utils;
mod app_info;
mod app_server_tracing;
mod attestation;
mod auth_mode;
mod bespoke_event_handling;
mod command_exec;
mod config;
mod config_layer;
mod config_manager;
mod config_manager_service;
mod connection_cleanup;
mod connection_rpc_gate;
mod current_time;
mod dynamic_tools;
mod error_code;
mod extensions;
mod filters;
mod fs_watch;
mod fuzzy_file_search;
mod image_url;
pub mod in_process;
mod mcp_refresh;
mod message_processor;
mod models;
mod models_refresh_worker;
mod outgoing_message;
mod request_processors;
mod request_serialization;
mod server_request_error;
mod skills_watcher;
mod thread_state;
mod thread_status;
mod transport;

pub use crate::error_code::INPUT_TOO_LARGE_ERROR_CODE;
pub use crate::error_code::INVALID_PARAMS_ERROR_CODE;
pub use crate::transport::AppServerTransport;
pub use crate::transport::RemoteControlStartupMode;
pub use crate::transport::app_server_control_socket_path;
pub use crate::transport::auth::AppServerWebsocketAuthArgs;
pub use crate::transport::auth::AppServerWebsocketAuthSettings;
pub use crate::transport::auth::WebsocketAuthCliMode;
pub use crate::transport::take_remote_control_disabled_env;

/// 控制日志输出格式的环境变量名（`LOG_FORMAT=json` 切换为 JSON 格式）。
const LOG_FORMAT_ENV_VAR: &str = "LOG_FORMAT";
/// OpenTelemetry 中标识本服务的名称。
const OTEL_SERVICE_NAME: &str = "codex-app-server";
#[cfg(debug_assertions)]
/// debug 构建下用于覆盖用户配置文件路径的环境变量名，供集成测试使用。
const TEST_USER_CONFIG_FILE_ENV_VAR: &str = "CODEX_APP_SERVER_TEST_USER_CONFIG_FILE";

/// 日志输出格式枚举。
///
/// 通过 `LOG_FORMAT` 环境变量控制，支持默认文本格式与 JSON 格式。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LogFormat {
    Default,
    Json,
}

/// `tracing` 订阅器的 stderr 日志层类型别名。
///
/// 使用 trait object 以便在运行时根据 [`LogFormat`] 选择具体实现。
type StderrLogLayer = Box<dyn Layer<Registry> + Send + Sync + 'static>;

/// 根据配置派生线程级配置加载器。
///
/// 当 `experimental_thread_config_endpoint` 配置项存在时，返回远程加载器；
/// 否则返回 no-op 加载器。
///
/// # 参数
///
/// - `config`: 全局配置引用，用于读取 `experimental_thread_config_endpoint`。
///
/// # 返回值
///
/// 返回 `Arc<dyn ThreadConfigLoader>`：
/// - `Some(endpoint)` → [`RemoteThreadConfigLoader`]
/// - `None` → [`NoopThreadConfigLoader`]
fn configured_thread_config_loader(config: &Config) -> Arc<dyn ThreadConfigLoader> {
    match config.experimental_thread_config_endpoint.as_deref() {
        Some(endpoint) => Arc::new(RemoteThreadConfigLoader::new(endpoint)),
        None => Arc::new(NoopThreadConfigLoader),
    }
}

/// 从 processor/transport 侧到 outbound 路由任务的控制面消息。
///
/// [`run_main_with_transport_options`] 使用两个独立的循环/任务：
/// - processor 循环：处理入站 JSON-RPC 与请求分发
/// - outbound 循环：执行对每个连接的（可能较慢的）写入
///
/// `OutboundControlEvent` 让两个循环协同工作，而无需直接共享可变的连接状态。
/// 特别是 outbound 循环需要在连接打开/关闭时收到通知，以便正确路由消息。
enum OutboundControlEvent {
    /// 注册一个新打开连接的 writer。
    Opened {
        connection_id: ConnectionId,
        writer: mpsc::Sender<QueuedOutgoingMessage>,
        disconnect_sender: Option<CancellationToken>,
        initialized: Arc<AtomicBool>,
        experimental_api_enabled: Arc<AtomicBool>,
        opted_out_notification_methods: Arc<RwLock<HashSet<String>>>,
    },
    /// 移除一个已关闭/断开连接的状态。
    Closed { connection_id: ConnectionId },
    /// 在优雅重启期间断开所有面向连接的客户端。
    DisconnectAll,
}

/// 服务器关闭状态的累积器。
///
/// 跟踪是否收到关闭信号、是否被强制关闭，以及最近一次记录的运行中 assistant turn
/// 数量（用于日志降噪）。
#[derive(Default)]
struct ShutdownState {
    requested: bool,
    forced: bool,
    last_logged_running_turn_count: Option<usize>,
}

/// 关闭状态机在每次轮询时返回的动作。
enum ShutdownAction {
    /// 无需动作，继续等待。
    Noop,
    /// 满足关闭条件，可以执行最终关闭流程。
    Finish,
}

/// 收到的关闭信号类型。
///
/// 区分"可强制"信号（再次触发会立即关闭）与"仅优雅"信号（仅触发优雅重启）。
#[derive(Clone, Copy)]
enum ShutdownSignal {
    /// 可被二次信号强制关闭（Ctrl+C / SIGTERM）。
    Forceable,
    #[cfg(unix)]
    /// 仅触发优雅重启（SIGHUP）。
    GracefulOnly,
}

/// 等待操作系统关闭信号。
///
/// 在 Unix 上监听 Ctrl+C、SIGTERM、SIGHUP；在其他平台仅监听 Ctrl+C。
///
/// # 返回值
///
/// 返回 [`ShutdownSignal`] 表示收到的信号类型；或在注册信号失败时返回 `io::Error`。
async fn shutdown_signal() -> IoResult<ShutdownSignal> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::SignalKind;
        use tokio::signal::unix::signal;

        let mut term = signal(SignalKind::terminate())?;
        let mut hangup = signal(SignalKind::hangup())?;
        tokio::select! {
            ctrl_c_result = tokio::signal::ctrl_c() => ctrl_c_result.map(|_| ShutdownSignal::Forceable),
            _ = term.recv() => Ok(ShutdownSignal::Forceable),
            _ = hangup.recv() => Ok(ShutdownSignal::GracefulOnly),
        }
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .map(|_| ShutdownSignal::Forceable)
    }
}

impl ShutdownState {
    /// 是否已收到过关闭信号。
    fn requested(&self) -> bool {
        self.requested
    }

    /// 是否被强制关闭（再次收到 Forceable 信号）。
    fn forced(&self) -> bool {
        self.forced
    }

    /// 处理一次关闭信号。
    ///
    /// 首次收到信号时进入"优雅重启排空"阶段，记录当前连接与运行中 turn 数量。
    /// 若已进入排空阶段又收到 `Forceable` 信号，则升级为强制关闭。
    ///
    /// # 参数
    ///
    /// - `signal`: 收到的信号类型
    /// - `connection_count`: 当前活动连接数（仅用于日志）
    /// - `running_turn_count`: 当前运行中的 assistant turn 数（仅用于日志）
    fn on_signal(
        &mut self,
        signal: ShutdownSignal,
        connection_count: usize,
        running_turn_count: usize,
    ) {
        if self.requested {
            if matches!(signal, ShutdownSignal::Forceable) {
                self.forced = true;
            }
            return;
        }

        self.requested = true;
        self.last_logged_running_turn_count = None;
        info!(
            "received shutdown signal; entering graceful restart drain (connections={}, runningAssistantTurns={}, requests still accepted until no assistant turns are running)",
            connection_count, running_turn_count,
        );
    }

    /// 每次主循环轮询时调用，决定是否可以执行最终关闭。
    ///
    /// 当未收到关闭信号时返回 `Noop`。已收到信号后，若处于强制关闭模式或当前没有
    /// 运行中的 assistant turn，则返回 `Finish`；否则返回 `Noop` 继续等待，并在
    /// running turn 数量变化时记录一条日志。
    ///
    /// # 参数
    ///
    /// - `running_turn_count`: 当前运行中的 assistant turn 数
    /// - `connection_count`: 当前活动连接数（仅用于日志）
    ///
    /// # 返回值
    ///
    /// 返回 [`ShutdownAction::Finish`] 表示可以执行最终关闭；否则返回
    /// [`ShutdownAction::Noop`]。
    fn update(&mut self, running_turn_count: usize, connection_count: usize) -> ShutdownAction {
        if !self.requested {
            return ShutdownAction::Noop;
        }

        if self.forced || running_turn_count == 0 {
            if self.forced {
                info!(
                    "received second shutdown signal; forcing restart with {running_turn_count} running assistant turn(s) and {connection_count} connection(s)"
                );
            } else {
                info!(
                    "shutdown signal restart: no assistant turns running; stopping acceptor and disconnecting {connection_count} connection(s)"
                );
            }
            return ShutdownAction::Finish;
        }

        if self.last_logged_running_turn_count != Some(running_turn_count) {
            info!(
                "shutdown signal restart: waiting for {running_turn_count} running assistant turn(s) to finish"
            );
            self.last_logged_running_turn_count = Some(running_turn_count);
        }

        ShutdownAction::Noop
    }
}

/// 根据配置加载错误构造一条配置告警通知。
///
/// 尝试从错误中提取文件路径与文本范围，附加到告警的 `path` / `range` 字段。
///
/// # 参数
///
/// - `summary`: 告警摘要文案
/// - `err`: 触发告警的底层 `io::Error`
///
/// # 返回值
///
/// 返回填充好的 [`ConfigWarningNotification`]。
fn config_warning_from_error(
    summary: impl Into<String>,
    err: &std::io::Error,
) -> ConfigWarningNotification {
    let (path, range) = match config_error_location(err) {
        Some((path, range)) => (Some(path), Some(range)),
        None => (None, None),
    };
    ConfigWarningNotification {
        summary: summary.into(),
        details: Some(err.to_string()),
        path,
        range,
    }
}

/// 从 `io::Error` 中尝试提取配置错误的位置信息（文件路径 + 文本范围）。
///
/// 仅当错误链中包含 [`ConfigLoadError`] 时返回 `Some`。
fn config_error_location(err: &std::io::Error) -> Option<(String, AppTextRange)> {
    err.get_ref()
        .and_then(|err| err.downcast_ref::<ConfigLoadError>())
        .map(|err| {
            let config_error = err.config_error();
            (
                config_error.path.to_string_lossy().to_string(),
                app_text_range(&config_error.range),
            )
        })
}

/// 从执行策略解析错误中提取位置信息（文件路径 + 文本范围）。
///
/// 仅 `ExecPolicyError::ParsePolicy` 分支可能携带具体位置；其他分支返回 `(None, None)`。
///
/// # 参数
///
/// - `err`: 执行策略错误
///
/// # 返回值
///
/// 返回 `(Option<path>, Option<range>)`，分别对应文件路径与文本范围。
fn exec_policy_warning_location(err: &ExecPolicyError) -> (Option<String>, Option<AppTextRange>) {
    match err {
        ExecPolicyError::ParsePolicy { path, source } => {
            if let Some(location) = source.location() {
                let range = AppTextRange {
                    start: AppTextPosition {
                        line: location.range.start.line,
                        column: location.range.start.column,
                    },
                    end: AppTextPosition {
                        line: location.range.end.line,
                        column: location.range.end.column,
                    },
                };
                return (Some(location.path), Some(range));
            }
            (Some(path.clone()), None)
        }
        _ => (None, None),
    }
}

/// 将 core 层的 [`CoreTextRange`] 转换为 app-server 协议层的 [`AppTextRange`]。
///
/// 字段一一对应拷贝。
fn app_text_range(range: &CoreTextRange) -> AppTextRange {
    AppTextRange {
        start: AppTextPosition {
            line: range.start.line,
            column: range.start.column,
        },
        end: AppTextPosition {
            line: range.end.line,
            column: range.end.column,
        },
    }
}

/// 检查项目级配置层是否存在被禁用的目录，若有则生成一条告警通知。
///
/// 当项目尚未受信时，项目本地的配置、hooks、exec policies 会被禁用，但 skills
/// 仍会加载。该函数遍历所有被禁用的项目配置层，构造一条汇总告警。
///
/// # 参数
///
/// - `config`: 全局配置引用
///
/// # 返回值
///
/// 返回 `Some(ConfigWarningNotification)` 表示存在被禁用的项目配置层；
/// 否则返回 `None`。
fn project_config_warning(config: &Config) -> Option<ConfigWarningNotification> {
    let mut disabled_folders = Vec::new();

    for layer in config.config_layer_stack.get_layers(
        ConfigLayerStackOrdering::LowestPrecedenceFirst,
        /*include_disabled*/ true,
    ) {
        let ConfigLayerSource::Project { dot_codex_folder } = &layer.name else {
            continue;
        };
        let Some(disabled_reason) = &layer.disabled_reason else {
            continue;
        };
        disabled_folders.push((
            dot_codex_folder.as_path().display().to_string(),
            disabled_reason.clone(),
        ));
    }

    if disabled_folders.is_empty() {
        return None;
    }

    let mut message = concat!(
        "Project-local config, hooks, and exec policies are disabled in the following folders ",
        "until the project is trusted, but skills still load.\n",
    )
    .to_string();
    for (index, (folder, reason)) in disabled_folders.iter().enumerate() {
        let display_index = index + 1;
        message.push_str(&format!("    {display_index}. {folder}\n"));
        message.push_str(&format!("       {reason}\n"));
    }

    Some(ConfigWarningNotification {
        summary: message,
        details: None,
        path: None,
        range: None,
    })
}

impl LogFormat {
    /// 根据环境变量的原始字符串值解析日志格式。
    ///
    /// 大小写不敏感，前后空白会被忽略。仅当值（trim 后小写）等于 `"json"` 时
    /// 返回 [`LogFormat::Json`]，其他情况（包括 `None`）返回 [`LogFormat::Default`]。
    ///
    /// # 参数
    ///
    /// - `value`: 环境变量原始值（可能为 `None`）
    fn from_env_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase) {
            Some(value) if value == "json" => Self::Json,
            _ => Self::Default,
        }
    }
}

/// 从环境变量 `LOG_FORMAT` 读取并解析日志格式。
fn log_format_from_env() -> LogFormat {
    let value = std::env::var(LOG_FORMAT_ENV_VAR).ok();
    LogFormat::from_env_value(value.as_deref())
}

/// app-server 主入口（stdio 传输默认）。
///
/// 等价于调用 [`run_main_with_transport_options`] 并使用：
/// - 传输方式：`Stdio`
/// - 会话来源：`SessionSource::VSCode`
/// - WebSocket 认证：默认设置
/// - 运行时选项：默认设置
///
/// # 参数
///
/// - `arg0_paths`: 可执行文件派发路径信息
/// - `cli_config_overrides`: 来自 CLI `-c` 的配置覆盖
/// - `loader_overrides`: 配置加载器覆盖项
/// - `strict_config`: 是否对未知配置字段严格报错
/// - `default_analytics_enabled`: 是否默认启用 analytics
///
/// # 返回值
///
/// 启动成功后随服务器生命周期运行；任何启动阶段错误以 `io::Error` 返回。
pub async fn run_main(
    arg0_paths: Arg0DispatchPaths,
    cli_config_overrides: CliConfigOverrides,
    loader_overrides: LoaderOverrides,
    strict_config: bool,
    default_analytics_enabled: bool,
) -> IoResult<()> {
    run_main_with_transport_options(
        arg0_paths,
        cli_config_overrides,
        loader_overrides,
        strict_config,
        default_analytics_enabled,
        AppServerTransport::Stdio,
        SessionSource::VSCode,
        AppServerWebsocketAuthSettings::default(),
        AppServerRuntimeOptions::default(),
    )
    .await
}

/// 控制插件启动任务是否执行的枚举。
///
/// 主要供集成测试使用，避免插件启动任务干扰测试。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginStartupTasks {
    /// 执行插件启动任务。
    Start,
    /// 跳过插件启动任务。
    Skip,
}

/// app-server 运行时选项。
///
/// 控制若干不影响协议但影响启动行为的开关，例如插件启动任务、远程控制启动模式、
/// 是否安装关闭信号处理器。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppServerRuntimeOptions {
    /// 是否启动插件启动任务。
    pub plugin_startup_tasks: PluginStartupTasks,
    /// 远程控制启动模式。
    pub remote_control_startup_mode: RemoteControlStartupMode,
    /// 是否安装 OS 关闭信号处理器以支持优雅重启。
    pub install_shutdown_signal_handler: bool,
}

impl Default for AppServerRuntimeOptions {
    fn default() -> Self {
        Self {
            plugin_startup_tasks: PluginStartupTasks::Start,
            remote_control_startup_mode: RemoteControlStartupMode::ResolvePersisted,
            install_shutdown_signal_handler: true,
        }
    }
}

/// app-server 主入口（自定义传输选项）。
///
/// 这是 app-server 的核心启动函数，负责：
/// 1. 加载配置（含 CLI 覆盖、托管配置、线程级配置加载器）。
/// 2. 初始化 OpenTelemetry、SQLite state db、日志订阅器。
/// 3. 启动传输 acceptor（stdio / Unix socket / WebSocket）与远程控制。
/// 4. 启动 outbound 路由任务与 processor 主循环。
/// 5. 处理关闭信号、优雅排空与最终关闭。
///
/// # 参数
///
/// - `arg0_paths`: 可执行文件派发路径信息
/// - `cli_config_overrides`: 来自 CLI `-c` 的配置覆盖
/// - `loader_overrides`: 配置加载器覆盖项
/// - `strict_config`: 是否对未知配置字段严格报错
/// - `default_analytics_enabled`: 是否默认启用 analytics
/// - `transport`: 传输方式（`Stdio` / `UnixSocket` / `WebSocket` / `Off`）
/// - `session_source`: 会话来源，影响产品限制与元数据
/// - `auth`: WebSocket 认证设置
/// - `runtime_options`: 运行时选项（插件任务、远程控制、关闭信号处理）
///
/// # 返回值
///
/// 启动成功后随服务器生命周期运行；任何启动阶段错误以 `io::Error` 返回。
#[allow(clippy::too_many_arguments)]
pub async fn run_main_with_transport_options(
    arg0_paths: Arg0DispatchPaths,
    cli_config_overrides: CliConfigOverrides,
    loader_overrides: LoaderOverrides,
    strict_config: bool,
    default_analytics_enabled: bool,
    transport: AppServerTransport,
    session_source: SessionSource,
    auth: AppServerWebsocketAuthSettings,
    runtime_options: AppServerRuntimeOptions,
) -> IoResult<()> {
    let loader_overrides = loader_overrides_with_test_user_config_file(
        loader_overrides,
        test_user_config_file_from_env(),
    )?;
    let (transport_event_tx, mut transport_event_rx) =
        mpsc::channel::<TransportEvent>(CHANNEL_CAPACITY);
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel::<OutgoingEnvelope>(CHANNEL_CAPACITY);
    let (outbound_control_tx, mut outbound_control_rx) =
        mpsc::channel::<OutboundControlEvent>(CHANNEL_CAPACITY);

    // 一次性解析 CLI 覆盖项并预先生成基础 Config，后续组件无需再处理原始 TOML 值。
    let cli_kv_overrides = cli_config_overrides.parse_overrides().map_err(|e| {
        std::io::Error::new(
            ErrorKind::InvalidInput,
            format!("error parsing -c overrides: {e}"),
        )
    })?;
    let codex_home = find_codex_home()?;
    let local_runtime_paths = ExecServerRuntimePaths::from_optional_paths(
        arg0_paths.codex_self_exe.clone(),
        arg0_paths.codex_linux_sandbox_exe.clone(),
    )?;
    let environment_manager = if loader_overrides.ignore_user_config {
        EnvironmentManager::from_env(Some(local_runtime_paths)).await
    } else {
        EnvironmentManager::from_codex_home(codex_home.clone(), Some(local_runtime_paths)).await
    }
    .map(Arc::new)
    .map_err(std::io::Error::other)?;
    let config_manager = ConfigManager::new(
        codex_home.to_path_buf(),
        cli_kv_overrides.clone(),
        loader_overrides,
        strict_config,
        Default::default(),
        arg0_paths.clone(),
        Arc::new(NoopThreadConfigLoader),
    );
    match config_manager
        .load_latest_config(/*fallback_cwd*/ None)
        .await
    {
        Ok(config) => {
            let discovered_thread_config_loader = configured_thread_config_loader(&config);
            config_manager
                .replace_thread_config_loader(Arc::clone(&discovered_thread_config_loader));
            let auth_manager =
                AuthManager::shared_from_config(&config, /*enable_codex_api_key_env*/ false).await;
            config_manager
                .replace_cloud_config_bundle_loader(auth_manager, config.chatgpt_base_url);
        }
        Err(err) => {
            warn!(error = %err, "Failed to preload config for cloud config bundle");
            // TODO: Decide whether bootstrap config preload failures should block startup.
            // 此处失败时无法安装 cloud/thread config loaders，非严格模式下
            // 服务器将在没有托管 cloud config 的情况下继续启动。
        }
    };
    let mut config_warnings = Vec::new();
    let (mut config, should_run_personality_migration) = match config_manager
        .load_latest_config(/*fallback_cwd*/ None)
        .await
    {
        Ok(config) => (config, true),
        Err(err) => {
            if strict_config {
                return Err(err);
            }

            let message = config_warning_from_error("Invalid configuration; using defaults.", &err);
            config_warnings.push(message);
            (
                config_manager.load_default_config().await.map_err(|e| {
                    std::io::Error::new(
                        ErrorKind::InvalidData,
                        format!("error loading default config after config error: {e}"),
                    )
                })?,
                false,
            )
        }
    };

    let otel = codex_core::otel_init::build_provider(
        &config,
        env!("CARGO_PKG_VERSION"),
        Some(OTEL_SERVICE_NAME),
        default_analytics_enabled,
    )
    .map_err(|e| {
        std::io::Error::new(
            ErrorKind::InvalidData,
            format!("error loading otel config: {e}"),
        )
    })?;
    codex_core::otel_init::record_process_start(otel.as_ref(), OTEL_SERVICE_NAME);
    codex_core::otel_init::install_sqlite_telemetry(otel.as_ref(), OTEL_SERVICE_NAME);
    let unix_socket_startup_lock = match &transport {
        AppServerTransport::UnixSocket { socket_path } => {
            let startup_lock_path = app_server_startup_lock_path(&codex_home)?;
            let startup_lock = acquire_app_server_startup_lock(startup_lock_path).await?;
            prepare_control_socket_path(socket_path.as_path()).await?;
            Some(startup_lock)
        }
        _ => None,
    };
    let state_db_init = match init_sqlite_state_db_with_fresh_start_on_corruption(&config).await {
        Ok(state_db_init) => state_db_init,
        Err(err) => {
            return Err(std::io::Error::other(format!(
                "failed to initialize sqlite state runtime under {}: {err}",
                config.sqlite_home.display()
            )));
        }
    };
    let state_db = state_db_init.state_db;
    if let Some(recovery_notice) = state_db_init.recovery_notice {
        config_warnings.push(ConfigWarningNotification {
            summary: SQLITE_RECOVERY_CONFIG_WARNING_SUMMARY.to_string(),
            details: Some(recovery_notice.details),
            path: None,
            range: None,
        });
    }

    if should_run_personality_migration {
        let effective_toml = config.config_layer_stack.effective_config();
        match effective_toml.try_into() {
            Ok(config_toml) => {
                match codex_core::personality_migration::maybe_migrate_personality(
                    &config.codex_home,
                    &config_toml,
                    state_db.clone(),
                )
                .await
                {
                    Ok(codex_core::personality_migration::PersonalityMigrationStatus::Applied) => {
                        config = config_manager
                            .load_latest_config(/*fallback_cwd*/ None)
                            .await
                            .map_err(|err| {
                                std::io::Error::new(
                                    ErrorKind::InvalidData,
                                    format!(
                                        "error reloading config after personality migration: {err}"
                                    ),
                                )
                            })?;
                    }
                    Ok(
                        codex_core::personality_migration::PersonalityMigrationStatus::SkippedMarker
                        | codex_core::personality_migration::PersonalityMigrationStatus::SkippedExplicitPersonality
                        | codex_core::personality_migration::PersonalityMigrationStatus::SkippedNoSessions,
                    ) => {}
                    Err(err) => {
                        warn!(error = %err, "Failed to run personality migration");
                    }
                }
            }
            Err(err) => {
                warn!(error = %err, "Failed to deserialize config for personality migration");
            }
        }
    }

    if let Ok(Some(err)) = check_execpolicy_for_warnings(&config.config_layer_stack).await {
        let (path, range) = exec_policy_warning_location(&err);
        let message = ConfigWarningNotification {
            summary: "Error parsing rules; custom rules not applied.".to_string(),
            details: Some(err.to_string()),
            path,
            range,
        };
        config_warnings.push(message);
    }

    if let Some(warning) = project_config_warning(&config) {
        config_warnings.push(warning);
    }
    for warning in &config.startup_warnings {
        config_warnings.push(ConfigWarningNotification {
            summary: warning.clone(),
            details: None,
            path: None,
            range: None,
        });
    }
    if let Some(warning) =
        codex_core::config::system_bwrap_warning(config.permissions.permission_profile())
    {
        config_warnings.push(ConfigWarningNotification {
            summary: warning,
            details: None,
            path: None,
            range: None,
        });
    }

    let feedback = CodexFeedback::new();

    // 安装一个简单的 tracing 订阅器，使 `tracing` 输出可见。
    // 用户可通过 `RUST_LOG` 控制日志级别，通过 `LOG_FORMAT=json` 切换 JSON 日志。
    let stderr_fmt: StderrLogLayer = match log_format_from_env() {
        LogFormat::Json => tracing_subscriber::fmt::layer()
            .json()
            .with_writer(std::io::stderr)
            .with_span_events(tracing_subscriber::fmt::format::FmtSpan::FULL)
            .with_filter(EnvFilter::from_default_env())
            .boxed(),
        LogFormat::Default => tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_span_events(tracing_subscriber::fmt::format::FmtSpan::FULL)
            .with_filter(EnvFilter::from_default_env())
            .boxed(),
    };

    let feedback_layer = feedback.logger_layer();
    let feedback_metadata_layer = feedback.metadata_layer();
    let log_db = state_db.clone().map(log_db::start);
    let log_db_layer = log_db
        .clone()
        .map(|layer| layer.with_filter(log_db::default_filter()));
    let otel_logger_layer = otel.as_ref().and_then(|o| o.logger_layer());
    let otel_tracing_layer = otel.as_ref().and_then(|o| o.tracing_layer());
    let _ = tracing_subscriber::registry()
        .with(stderr_fmt)
        .with(feedback_layer)
        .with(feedback_metadata_layer)
        .with(log_db_layer)
        .with(otel_logger_layer)
        .with(otel_tracing_layer)
        .try_init();
    for warning in &config_warnings {
        match &warning.details {
            Some(details) => error!("{} {}", warning.summary, details),
            None => error!("{}", warning.summary),
        }
    }
    let remote_control_policy = if config
        .config_layer_stack
        .requirements()
        .allow_remote_control
        .as_ref()
        .is_some_and(|requirement| !requirement.value)
    {
        RemoteControlPolicy::DisabledByRequirements
    } else {
        RemoteControlPolicy::Allowed
    };
    let remote_control_startup_mode = runtime_options.remote_control_startup_mode;
    let remote_control_explicitly_requested =
        remote_control_startup_mode == RemoteControlStartupMode::EnabledEphemeral;
    if remote_control_explicitly_requested
        && remote_control_policy == RemoteControlPolicy::DisabledByRequirements
    {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "remote control is disabled by managed requirements",
        ));
    }
    let installation_id = resolve_installation_id(&config.codex_home).await?;
    let transport_shutdown_token = CancellationToken::new();
    let mut transport_accept_handles = Vec::<JoinHandle<()>>::new();

    let single_client_mode = matches!(&transport, AppServerTransport::Stdio);
    let shutdown_when_no_connections = single_client_mode;
    let graceful_signal_restart_enabled =
        runtime_options.install_shutdown_signal_handler && !single_client_mode;
    let mut app_server_client_name_rx = None;

    match &transport {
        AppServerTransport::Stdio => {
            let (stdio_client_name_tx, stdio_client_name_rx) = oneshot::channel::<String>();
            app_server_client_name_rx = Some(stdio_client_name_rx);
            start_stdio_connection(
                transport_event_tx.clone(),
                &mut transport_accept_handles,
                stdio_client_name_tx,
            )
            .await?;
        }
        AppServerTransport::UnixSocket { socket_path } => {
            let accept_handle = start_control_socket_acceptor(
                socket_path.clone(),
                transport_event_tx.clone(),
                transport_shutdown_token.clone(),
            )
            .await?;
            transport_accept_handles.push(accept_handle);
        }
        AppServerTransport::WebSocket { bind_address } => {
            let accept_handle = start_websocket_acceptor(
                *bind_address,
                transport_event_tx.clone(),
                transport_shutdown_token.clone(),
                policy_from_settings(&auth)?,
            )
            .await?;
            transport_accept_handles.push(accept_handle);
        }
        AppServerTransport::Off => {}
    }
    drop(unix_socket_startup_lock);

    let auth_manager =
        AuthManager::shared_from_config(&config, /*enable_codex_api_key_env*/ false).await;

    let remote_control_enabled = remote_control_policy == RemoteControlPolicy::Allowed
        && remote_control_explicitly_requested
        && state_db.is_some();
    if remote_control_explicitly_requested && state_db.is_none() {
        error!("remote control disabled because sqlite state db is unavailable");
    }
    let no_local_transport = transport_accept_handles.is_empty();
    if no_local_transport
        && remote_control_startup_mode != RemoteControlStartupMode::ResolvePersisted
        && !remote_control_enabled
    {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            if remote_control_policy == RemoteControlPolicy::DisabledByRequirements {
                "no transport configured; remote control disabled by managed requirements"
            } else if remote_control_explicitly_requested && state_db.is_none() {
                "no transport configured; remote control disabled because sqlite state db is unavailable"
            } else {
                "no transport configured; use --listen or enable remote control"
            },
        ));
    }

    let (remote_control_accept_handle, remote_control_handle) = start_remote_control(
        RemoteControlStartConfig {
            remote_control_url: config.chatgpt_base_url.clone(),
            installation_id: installation_id.clone(),
            policy: remote_control_policy,
        },
        state_db.clone(),
        auth_manager.clone(),
        transport_event_tx.clone(),
        transport_shutdown_token.clone(),
        app_server_client_name_rx,
        remote_control_startup_mode,
    )
    .await?;
    if no_local_transport
        && remote_control_startup_mode == RemoteControlStartupMode::ResolvePersisted
    {
        let persisted_enabled = match remote_control_handle
            .resolve_persisted_preference(/*app_server_client_name*/ None)
            .await
        {
            Ok(persisted_enabled) => persisted_enabled,
            Err(err) => {
                warn!("failed to resolve persisted remote control preference: {err}");
                false
            }
        };
        if !persisted_enabled {
            transport_shutdown_token.cancel();
            let _ = remote_control_accept_handle.await;
            return Err(std::io::Error::new(
                ErrorKind::InvalidInput,
                if remote_control_policy == RemoteControlPolicy::DisabledByRequirements {
                    "no transport configured; remote control disabled by managed requirements"
                } else {
                    "no transport configured; use --listen or enable remote control"
                },
            ));
        }
    }
    transport_accept_handles.push(remote_control_accept_handle);

    let outbound_handle = tokio::spawn(async move {
        let mut outbound_connections = HashMap::<ConnectionId, OutboundConnectionState>::new();
        loop {
            tokio::select! {
                    biased;
                    event = outbound_control_rx.recv() => {
                        let Some(event) = event else {
                            break;
                        };
                        match event {
                            OutboundControlEvent::Opened {
                                connection_id,
                                writer,
                                disconnect_sender,
                                initialized,
                                experimental_api_enabled,
                                opted_out_notification_methods,
                            } => {
                                outbound_connections.insert(
                                    connection_id,
                                    OutboundConnectionState::new(
                                        writer,
                                        initialized,
                                        experimental_api_enabled,
                                        opted_out_notification_methods,
                                        disconnect_sender,
                                    ),
                                );
                            }
                            OutboundControlEvent::Closed { connection_id } => {
                                outbound_connections.remove(&connection_id);
                            }
                            OutboundControlEvent::DisconnectAll => {
                                info!(
                                    "disconnecting {} outbound websocket connection(s) for graceful restart",
                                    outbound_connections.len()
                                );
                                for connection_state in outbound_connections.values() {
                                    connection_state.request_disconnect();
                                }
                                outbound_connections.clear();
                            }
                        }
                    }
                    envelope = outgoing_rx.recv() => {
                    let Some(envelope) = envelope else {
                        break;
                    };
                    route_outgoing_envelope(&mut outbound_connections, envelope).await;
                }
            }
        }
        info!("outbound router task exited (channel closed)");
    });

    let processor_handle = tokio::spawn({
        let auth_manager = Arc::clone(&auth_manager);
        let analytics_events_client =
            analytics_events_client_from_config(Arc::clone(&auth_manager), &config);
        let outgoing_message_sender = Arc::new(OutgoingMessageSender::new(
            outgoing_tx,
            analytics_events_client.clone(),
        ));
        let initialize_notification_sender = outgoing_message_sender.clone();
        let outbound_control_tx = outbound_control_tx;
        let processor = Arc::new(MessageProcessor::new(MessageProcessorArgs {
            outgoing: outgoing_message_sender,
            analytics_events_client,
            arg0_paths,
            config: Arc::new(config),
            config_manager,
            environment_manager,
            feedback: feedback.clone(),
            log_db,
            state_db: state_db.clone(),
            config_warnings,
            session_source,
            auth_manager,
            installation_id,
            rpc_transport: analytics_rpc_transport(&transport),
            remote_control_handle: Some(remote_control_handle.clone()),
            plugin_startup_tasks: runtime_options.plugin_startup_tasks,
        }));
        let mut thread_created_rx = processor.thread_created_receiver();
        let mut running_turn_count_rx = processor.subscribe_running_assistant_turn_count();
        let mut connections = HashMap::<ConnectionId, ConnectionState>::new();
        let mut connection_cleanup_tasks = ConnectionCleanupTasks::new();
        let mut remote_control_status_rx = remote_control_handle.status_receiver();
        let mut remote_control_status = remote_control_status_rx.borrow().clone();
        let transport_shutdown_token = transport_shutdown_token.clone();
        async move {
            let mut listen_for_threads = true;
            let mut shutdown_state = ShutdownState::default();
            let exit_reason = loop {
                let running_turn_count = {
                    let running_turn_count = running_turn_count_rx.borrow();
                    *running_turn_count
                };
                if matches!(
                    shutdown_state.update(running_turn_count, connections.len()),
                    ShutdownAction::Finish
                ) {
                    transport_shutdown_token.cancel();
                    let _ = outbound_control_tx
                        .send(OutboundControlEvent::DisconnectAll)
                        .await;
                    break "shutdown_requested";
                }

                tokio::select! {
                    shutdown_signal_result = shutdown_signal(), if graceful_signal_restart_enabled && !shutdown_state.forced() => {
                        let signal = match shutdown_signal_result {
                            Ok(signal) => signal,
                            Err(err) => {
                                warn!("failed to listen for shutdown signal during graceful restart drain: {err}");
                                continue;
                            }
                        };
                        let running_turn_count = *running_turn_count_rx.borrow();
                        shutdown_state.on_signal(signal, connections.len(), running_turn_count);
                    }
                    changed = running_turn_count_rx.changed(), if graceful_signal_restart_enabled && shutdown_state.requested() => {
                        if changed.is_err() {
                            warn!("running-turn watcher closed during graceful restart drain");
                        }
                    }
                    event = transport_event_rx.recv() => {
                        let Some(event) = event else {
                            break "transport_channel_closed";
                        };
                        match event {
                            TransportEvent::ConnectionOpened {
                                connection_id,
                                origin,
                                writer,
                                disconnect_sender,
                            } => {
                                let outbound_initialized = Arc::new(AtomicBool::new(false));
                                let outbound_experimental_api_enabled =
                                    Arc::new(AtomicBool::new(false));
                                let outbound_opted_out_notification_methods =
                                    Arc::new(RwLock::new(HashSet::new()));
                                if outbound_control_tx
                                    .send(OutboundControlEvent::Opened {
                                        connection_id,
                                        writer,
                                        disconnect_sender,
                                        initialized: Arc::clone(&outbound_initialized),
                                        experimental_api_enabled: Arc::clone(
                                            &outbound_experimental_api_enabled,
                                        ),
                                        opted_out_notification_methods: Arc::clone(
                                            &outbound_opted_out_notification_methods,
                                        ),
                                    })
                                    .await
                                    .is_err()
                                {
                                    break "outbound_router_closed";
                                }
                                connections.insert(
                                    connection_id,
                                    ConnectionState::new(
                                        origin,
                                        outbound_initialized,
                                        outbound_experimental_api_enabled,
                                        outbound_opted_out_notification_methods,
                                    ),
                                );
                            }
                            TransportEvent::ConnectionClosed { connection_id } => {
                                let Some(connection_state) = connections.remove(&connection_id) else {
                                    continue;
                                };
                                connection_state.session.rpc_gate.close().await;
                                let outbound_closed = outbound_control_tx
                                    .send(OutboundControlEvent::Closed { connection_id })
                                    .await
                                    .is_ok();
                                let processor = Arc::clone(&processor);
                                connection_cleanup_tasks.spawn(async move {
                                    processor
                                        .connection_closed(connection_id, &connection_state.session)
                                        .await;
                                });
                                if !outbound_closed {
                                    break "outbound_router_closed";
                                }
                                if shutdown_when_no_connections && connections.is_empty() {
                                    break "last_connection_closed";
                                }
                            }
                            TransportEvent::IncomingMessage { connection_id, message } => {
                                match message {
                                    JSONRPCMessage::Request(request) => {
                                        let Some(connection_state) = connections.get_mut(&connection_id) else {
                                            warn!("dropping request from unknown connection: {connection_id:?}");
                                            continue;
                                        };
                                        let was_initialized =
                                            connection_state.session.initialized();
                                        processor
                                            .process_request(
                                                connection_id,
                                                request,
                                                &transport,
                                                Arc::clone(&connection_state.session),
                                            )
                                            .await;
                                        let opted_out_notification_methods_snapshot = connection_state
                                            .session
                                            .opted_out_notification_methods();
                                        let experimental_api_enabled =
                                            connection_state.session.experimental_api_enabled();
                                        let is_initialized = connection_state.session.initialized();
                                        if let Ok(mut opted_out_notification_methods) = connection_state
                                            .outbound_opted_out_notification_methods
                                            .write()
                                        {
                                            *opted_out_notification_methods =
                                                opted_out_notification_methods_snapshot;
                                        } else {
                                            warn!(
                                                "failed to update outbound opted-out notifications"
                                            );
                                        }
                                        connection_state
                                            .outbound_experimental_api_enabled
                                            .store(
                                                experimental_api_enabled,
                                                std::sync::atomic::Ordering::Release,
                                            );
                                        if !was_initialized && is_initialized {
                                            processor
                                                .send_initialize_notifications_to_connection(
                                                    connection_id,
                                                )
                                                .await;
                                            initialize_notification_sender
                                                .send_server_notification_to_connections(
                                                    &[connection_id],
                                                    ServerNotification::RemoteControlStatusChanged(
                                                        remote_control_status.clone(),
                                                    ),
                                                )
                                                .await;
                                            processor
                                                .connection_initialized(
                                                    connection_id,
                                                    connection_state
                                                        .session
                                                        .request_attestation(),
                                                )
                                                .await;
                                            connection_state
                                                .outbound_initialized
                                                .store(true, std::sync::atomic::Ordering::Release);
                                        }
                                    }
                                    JSONRPCMessage::Response(response) => {
                                        if !connections.contains_key(&connection_id) {
                                            warn!("dropping response from unknown connection: {connection_id:?}");
                                            continue;
                                        }
                                        processor.process_response(response).await;
                                    }
                                    JSONRPCMessage::Notification(notification) => {
                                        if !connections.contains_key(&connection_id) {
                                            warn!("dropping notification from unknown connection: {connection_id:?}");
                                            continue;
                                        }
                                        processor.process_notification(notification).await;
                                    }
                                    JSONRPCMessage::Error(err) => {
                                        if !connections.contains_key(&connection_id) {
                                            warn!("dropping error from unknown connection: {connection_id:?}");
                                            continue;
                                        }
                                        processor.process_error(err).await;
                                    }
                                }
                            }
                        }
                    }
                    _ = connection_cleanup_tasks.reap_next() => {}
                    changed = remote_control_status_rx.changed() => {
                        if changed.is_err() {
                            continue;
                        }
                        let status = remote_control_status_rx.borrow().clone();
                        if remote_control_status == status {
                            continue;
                        }
                        remote_control_status = status.clone();
                        let notification = ServerNotification::RemoteControlStatusChanged(status);
                        initialize_notification_sender
                            .send_server_notification(notification)
                            .await;
                    }
                    created = thread_created_rx.recv(), if listen_for_threads => {
                        match created {
                            Ok(thread_id) => {
                                let mut initialized_connection_ids = Vec::new();
                                for (connection_id, connection_state) in &connections {
                                    if connection_state.session.initialized() {
                                        initialized_connection_ids.push(*connection_id);
                                    }
                                }
                                processor
                                    .try_attach_thread_listener(
                                        thread_id,
                                        initialized_connection_ids,
                                    )
                                    .await;
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                // TODO(jif) handle lag.
                                // 假设 thread 创建量足够低，不会发生 lag。
                                // 如果发生，仅记录日志而不重同步，避免为应当保持未订阅的
                                // thread 附加 listener。
                                warn!("thread_created receiver lagged; skipping resync");
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                listen_for_threads = false;
                            }
                        }
                    }
                }
            };

            if !shutdown_state.forced() {
                futures::future::join_all(
                    connections
                        .values()
                        .map(|connection_state| connection_state.session.rpc_gate.shutdown()),
                )
                .await;
                connection_cleanup_tasks.drain().await;
                processor.drain_background_tasks().await;
                processor.shutdown_threads().await;
            } else {
                connection_cleanup_tasks.abort();
            }
            info!(
                exit_reason,
                remaining_connection_count = connections.len(),
                shutdown_forced = shutdown_state.forced(),
                "processor task exited"
            );
        }
    });

    drop(transport_event_tx);

    let _ = processor_handle.await;
    let _ = outbound_handle.await;

    transport_shutdown_token.cancel();
    for handle in transport_accept_handles {
        let _ = handle.await;
    }

    if let Some(otel) = otel {
        otel.shutdown();
    }

    Ok(())
}

/// SQLite 数据库损坏恢复后给客户端的告警详情。
struct SqliteRecoveryNotice {
    details: String,
}

/// 记录一个已恢复的 SQLite 数据库的原始路径与备份目录。
struct RecoveredSqliteDatabase {
    database_path: String,
    backup_folder: String,
}

/// SQLite state db 初始化结果。
///
/// 包含初始化成功后的 state db 句柄，以及（若发生损坏恢复）告警通知。
struct StateDbInitResult {
    state_db: Option<rollout_state_db::StateDbHandle>,
    recovery_notice: Option<SqliteRecoveryNotice>,
}

/// 初始化 SQLite state db，遇到损坏时自动备份并重建。
///
/// 该函数循环尝试初始化 state db：
/// 1. 调用 `try_init` 尝试初始化。
/// 2. 若返回损坏错误（或数据库父路径是一个阻塞的文件而非目录），将损坏的数据库
///    文件移动到备份目录，再次尝试初始化。
/// 3. 重复直到成功或遇到不可恢复错误。
///
/// 为避免无限循环，已尝试备份的数据库路径会被记录，若再次遇到同一路径则直接报错。
///
/// # 参数
///
/// - `config`: 全局配置，用于定位 SQLite home
///
/// # 返回值
///
/// 成功时返回 [`StateDbInitResult`]；不可恢复错误以 `anyhow::Error` 返回。
async fn init_sqlite_state_db_with_fresh_start_on_corruption(
    config: &Config,
) -> anyhow::Result<StateDbInitResult> {
    let mut attempted_backups = HashSet::new();
    let mut recovered_databases = Vec::new();
    loop {
        let err = match rollout_state_db::try_init(config).await {
            Ok(state_db) => {
                let recovery_notice = sqlite_recovery_notice(&recovered_databases);
                if recovery_notice.is_some() {
                    emit_state_db_backup_warning(SQLITE_RECOVERY_CONFIG_WARNING_SUMMARY);
                    for recovered_database in &recovered_databases {
                        emit_state_db_backup_warning(&format!(
                            "Database path: {}",
                            recovered_database.database_path
                        ));
                        emit_state_db_backup_warning(&format!(
                            "Backup folder: {}",
                            recovered_database.backup_folder
                        ));
                    }
                }
                return Ok(StateDbInitResult {
                    state_db: Some(state_db),
                    recovery_notice,
                });
            }
            Err(err) => err,
        };
        let database_path = codex_state::runtime_db_path_for_corruption_error(&err)
            .unwrap_or_else(|| codex_state::state_db_path(config.sqlite_home.as_path()));
        if !codex_state::is_sqlite_corruption_error(&err)
            && !sqlite_home_is_blocking_file(database_path.as_path())
        {
            return Err(err);
        }

        if !attempted_backups.insert(database_path.clone()) {
            return Err(anyhow::anyhow!(
                "failed to initialize sqlite state runtime after moving damaged database file into a backup folder: {err}"
            ));
        }

        let original_error = err.to_string();
        emit_state_db_backup_warning(&format!(
            "Codex local database at {} appears damaged. Moving it into a backup folder so the app server can rebuild it from saved data.",
            database_path.display()
        ));
        let backups = codex_state::backup_runtime_db_for_fresh_start(database_path.as_path())
            .await
            .map_err(|backup_err| {
                anyhow::anyhow!(
                    "failed to move damaged sqlite state database files into a backup folder: {backup_err}; original error: {original_error}"
                )
            })?;
        for backup in &backups {
            emit_state_db_backup_warning(&format!(
                "Moved damaged Codex local database file {} to {}",
                backup.original_path.display(),
                backup.backup_path.display()
            ));
        }
        if let Some(first_backup) = backups.first()
            && let Some(backup_folder) = first_backup.backup_path.parent()
        {
            recovered_databases.push(RecoveredSqliteDatabase {
                database_path: first_backup.original_path.display().to_string(),
                backup_folder: backup_folder.display().to_string(),
            });
        }
    }
}

/// 判断数据库路径的父目录是否是一个文件而非目录（这会导致 SQLite 初始化失败）。
///
/// 当父路径的元数据存在且 `is_file()` 为真时返回 `true`。
fn sqlite_home_is_blocking_file(database_path: &Path) -> bool {
    database_path
        .parent()
        .and_then(|path| std::fs::metadata(path).ok())
        .is_some_and(|metadata| metadata.is_file())
}

/// 根据已恢复的数据库列表生成告警详情。
///
/// 列表为空时返回 `None`。否则将每个数据库的路径与备份目录拼接为多行文本。
///
/// # 参数
///
/// - `recovered_databases`: 已恢复的数据库列表
fn sqlite_recovery_notice(
    recovered_databases: &[RecoveredSqliteDatabase],
) -> Option<SqliteRecoveryNotice> {
    if recovered_databases.is_empty() {
        return None;
    }

    let details = recovered_databases
        .iter()
        .map(|recovered_database| {
            format!(
                "Database path: {}\nBackup folder: {}",
                recovered_database.database_path, recovered_database.backup_folder
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(SqliteRecoveryNotice { details })
}

/// 输出一条 state db 备份告警。
///
/// 优先通过 `tracing::warn!` 输出；若 tracing dispatcher 尚未安装
/// （启动早期），则直接写入 stderr。
fn emit_state_db_backup_warning(message: &str) {
    warn!("{message}");
    if !tracing::dispatcher::has_been_set() {
        #[allow(clippy::print_stderr)]
        {
            eprintln!("{message}");
        }
    }
}

/// 从环境变量读取 debug-only 的测试用户配置文件路径。
///
/// 仅在 debug 构建生效；release 构建始终返回 `None`。
fn test_user_config_file_from_env() -> Option<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    {
        std::env::var_os(TEST_USER_CONFIG_FILE_ENV_VAR)
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from)
    }

    #[cfg(not(debug_assertions))]
    None
}

/// 将 debug-only 的测试用户配置文件路径合并到 [`LoaderOverrides`]。
///
/// 仅在 debug 构建且 `test_user_config_file` 为 `Some` 时覆盖
/// `loader_overrides.user_config_path`；其他情况原样返回 `loader_overrides`。
///
/// # 参数
///
/// - `loader_overrides`: 原始加载器覆盖项
/// - `test_user_config_file`: 可选的测试用户配置文件路径
///
/// # 错误
///
/// 当提供的路径不是绝对路径时返回 `io::Error`（`ErrorKind::InvalidInput`）。
fn loader_overrides_with_test_user_config_file(
    mut loader_overrides: LoaderOverrides,
    test_user_config_file: Option<std::path::PathBuf>,
) -> IoResult<LoaderOverrides> {
    #[cfg(debug_assertions)]
    if let Some(path) = test_user_config_file {
        let path = AbsolutePathBuf::from_absolute_path(path).map_err(|err| {
            std::io::Error::new(
                ErrorKind::InvalidInput,
                format!("invalid test user config path: {err}"),
            )
        })?;
        warn!(
            path = %path.as_path().display(),
            "using debug-only app-server test user config file"
        );
        loader_overrides.user_config_path = Some(path);
    }

    #[cfg(not(debug_assertions))]
    let _ = test_user_config_file;

    Ok(loader_overrides)
}

/// 根据传输方式映射对应的 analytics RPC 传输类型。
///
/// - `Stdio` → [`AppServerRpcTransport::Stdio`]
/// - `UnixSocket` / `WebSocket` / `Off` → [`AppServerRpcTransport::Websocket`]
fn analytics_rpc_transport(transport: &AppServerTransport) -> AppServerRpcTransport {
    match transport {
        AppServerTransport::Stdio => AppServerRpcTransport::Stdio,
        AppServerTransport::UnixSocket { .. }
        | AppServerTransport::WebSocket { .. }
        | AppServerTransport::Off => AppServerRpcTransport::Websocket,
    }
}

#[cfg(test)]
mod tests {
    use super::LogFormat;
    #[cfg(debug_assertions)]
    use super::loader_overrides_with_test_user_config_file;
    #[cfg(debug_assertions)]
    use codex_config::LoaderOverrides;
    #[cfg(debug_assertions)]
    use codex_utils_absolute_path::AbsolutePathBuf;
    use pretty_assertions::assert_eq;

    #[test]
    fn log_format_from_env_value_matches_json_values_case_insensitively() {
        assert_eq!(LogFormat::from_env_value(Some("json")), LogFormat::Json);
        assert_eq!(LogFormat::from_env_value(Some("JSON")), LogFormat::Json);
        assert_eq!(LogFormat::from_env_value(Some("  Json  ")), LogFormat::Json);
    }

    #[test]
    fn log_format_from_env_value_defaults_for_non_json_values() {
        assert_eq!(
            LogFormat::from_env_value(/*value*/ None),
            LogFormat::Default
        );
        assert_eq!(LogFormat::from_env_value(Some("")), LogFormat::Default);
        assert_eq!(LogFormat::from_env_value(Some("text")), LogFormat::Default);
        assert_eq!(LogFormat::from_env_value(Some("jsonl")), LogFormat::Default);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_test_user_config_file_overrides_loader_path() {
        let path = std::env::temp_dir().join("codex-app-server-test-config.toml");
        let loader_overrides = loader_overrides_with_test_user_config_file(
            LoaderOverrides::default(),
            Some(path.clone()),
        )
        .expect("test config path should be valid");

        assert_eq!(
            loader_overrides.user_config_path,
            Some(AbsolutePathBuf::from_absolute_path(path).expect("absolute test path"))
        );
    }
}
