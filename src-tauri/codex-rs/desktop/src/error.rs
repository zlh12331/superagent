//! 所有 Tauri 命令的统一错误类型。
//!
//! 手动实现 `Display` 和 `Serialize`，在输出前通过 `redact_error_message`
//! 脱敏敏感数据（如 API key、token 等），防止通过日志、Sentry、Tauri IPC 泄露。
//!
//! `Debug` 和 `Clone` 仍然自动派生，`specta::Type` 用于生成 TypeScript 绑定。

use codex_app_server_protocol::JSONRPCErrorError;

/// 所有 Tauri 命令处理器使用的统一错误类型。
///
/// 每个变体对应一类宽泛的失败场景。`kind` 标签允许前端按错误类型 switch，
/// `message` 字段则承载人类可读的详细信息。
///
/// ## P1-4 脱敏设计
///
/// `Display` 和 `Serialize` 的输出经过 `redact_error_message` 处理：
/// 1. 键值对模式（`api_key=xxx`）→ `api_key=***`
/// 2. 值模式（`sk-xxx`、`AKIAxxx`、`Bearer xxx`）→ 脱敏
/// 3. 超长消息（>1000 字节）→ 截断 + `...` 后缀
///
/// 这确保错误消息通过日志、Sentry、Tauri IPC 传输时不会泄露敏感数据。
/// `Debug` 和 `Clone` 自动派生，`serde::Deserialize` 派生以让 `#[serde(...)]` 属性
/// 合法（specta 读取此属性生成正确的 TS 类型），`specta::Type` 用于生成 TypeScript 绑定。
/// `Serialize` 手动实现以在输出前调用 `redact_error_message` 脱敏。
#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    /// 文件系统或 I/O 错误。
    Io(String),
    /// JSON 序列化/反序列化错误。
    Serialization(String),
    /// 路径解析错误（例如找不到应用数据目录）。
    Path(String),
    /// 输入校验错误。
    Validation(String),
    /// 资源未找到。
    NotFound(String),
    /// `spawn_blocking` 产生的任务 join 错误。
    TaskJoin(String),
    /// 托盘图标操作错误。
    Tray(String),
    /// 快捷面板操作错误。
    QuickPane(String),
    /// 通知错误。
    Notification(String),
    /// 窗口操作错误。
    Window(String),
    /// Codex 运行时启动失败。
    RuntimeStart(String),
    /// Codex 运行时未能正常关闭。
    RuntimeShutdown(String),
    /// Codex 运行时未初始化 —— 在 `setup()` 之前调用了命令。
    NotInitialized(String),
    /// Codex app-server 返回了错误。
    AppServerError(String),
    /// 发往 app-server 的类型化请求失败（传输、服务端错误或响应解码失败）。
    /// 由 [`TypedRequestError`] 转换而来。
    TypedRequestError(String),
}

/// 手动实现 Display — 输出前调用 `redact_error_message` 脱敏。
///
/// 这确保 `format!("{err}")`、`log::info!("{err}")`、Sentry 事件
/// 都不会泄露 API key、token 等敏感数据。
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (prefix, message) = self.prefix_and_safe_message();
        write!(f, "{prefix}: {message}")
    }
}

/// 手动实现 std::error::Error — 基于 Display，无需额外 source。
impl std::error::Error for AppError {}

/// 手动实现 Serialize — 序列化前调用 `redact_error_message` 脱敏。
///
/// 这确保通过 Tauri IPC 传到前端的消息不会泄露敏感数据。
/// 序列化格式与之前的 `#[serde(tag = "kind", content = "message")]` 一致：
/// `{"kind":"Io","message":"disk full"}`
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let (kind, message) = self.kind_and_safe_message();
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &message)?;
        state.end()
    }
}

/// 向 codex app-server 发起类型化请求时产生的错误。
///
/// 封装了在 bridge 层调用 `request_typed::<T>()` 时出现的三类失败：
/// - [`TypedRequestError::Transport`] —— 发送请求或接收响应时的 IO 错误
///   （通道关闭、队列已满等）。
/// - [`TypedRequestError::Server`] —— 服务端返回了 JSON-RPC 错误响应
///   （`JSONRPCErrorError`）。
/// - [`TypedRequestError::Deserialize`] —— 响应负载无法反序列化为目标类型 `T`。
///
/// 本类型镜像 `codex_app_server_client::TypedRequestError`，但在本地定义，
/// 以避免引入 `codex-app-server-client` crate 依赖（该依赖会牵连
/// `codex-uds` 和 `codex-utils-rustls-provider`）。
#[derive(Debug)]
pub enum TypedRequestError {
    /// 传输层失败：通道关闭、队列已满等。
    Transport {
        /// JSON-RPC 方法名（例如 `"thread/start"`）。
        method: String,
        source: std::io::Error,
    },
    /// 服务端返回了 JSON-RPC 错误响应。
    Server {
        /// JSON-RPC 方法名。
        method: String,
        source: JSONRPCErrorError,
    },
    /// 响应负载反序列化为目标类型失败。
    Deserialize {
        /// JSON-RPC 方法名。
        method: String,
        source: serde_json::Error,
    },
}

impl std::fmt::Display for TypedRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport { method, source } => {
                write!(f, "{method} transport error: {source}")
            }
            Self::Server { method, source } => {
                write!(
                    f,
                    "{method} failed: {} (code {})",
                    source.message, source.code
                )?;
                if let Some(data) = source.data.as_ref() {
                    write!(f, ", data: {data}")?;
                }
                Ok(())
            }
            Self::Deserialize { method, source } => {
                write!(f, "{method} response decode error: {source}")
            }
        }
    }
}

impl std::error::Error for TypedRequestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport { source, .. } => Some(source),
            Self::Server { .. } => None,
            Self::Deserialize { source, .. } => Some(source),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Serialization(e.to_string())
    }
}

impl From<TypedRequestError> for AppError {
    fn from(e: TypedRequestError) -> Self {
        AppError::TypedRequestError(e.to_string())
    }
}

impl AppError {
    /// 返回 Display 用的前缀和脱敏后的消息。
    ///
    /// 前缀与原来的 `#[error("IO error: {0}")]` 格式一致，
    /// 消息经过 `redact_error_message` 脱敏 + 截断。
    fn prefix_and_safe_message(&self) -> (&'static str, String) {
        use crate::utils::redact::redact_error_message;
        match self {
            AppError::Io(msg) => ("IO error", redact_error_message(msg)),
            AppError::Serialization(msg) => ("Serialization error", redact_error_message(msg)),
            AppError::Path(msg) => ("Path error", redact_error_message(msg)),
            AppError::Validation(msg) => ("Validation error", redact_error_message(msg)),
            AppError::NotFound(msg) => ("Not found", redact_error_message(msg)),
            AppError::TaskJoin(msg) => ("Task join error", redact_error_message(msg)),
            AppError::Tray(msg) => ("Tray error", redact_error_message(msg)),
            AppError::QuickPane(msg) => ("Quick pane error", redact_error_message(msg)),
            AppError::Notification(msg) => ("Notification error", redact_error_message(msg)),
            AppError::Window(msg) => ("Window error", redact_error_message(msg)),
            AppError::RuntimeStart(msg) => ("Runtime start error", redact_error_message(msg)),
            AppError::RuntimeShutdown(msg) => ("Runtime shutdown error", redact_error_message(msg)),
            AppError::NotInitialized(msg) => ("Runtime not initialized", redact_error_message(msg)),
            AppError::AppServerError(msg) => ("App server error", redact_error_message(msg)),
            AppError::TypedRequestError(msg) => ("Typed request error", redact_error_message(msg)),
        }
    }

    /// 返回 Serialize 用的 kind 标签和脱敏后的消息。
    fn kind_and_safe_message(&self) -> (&'static str, String) {
        use crate::utils::redact::redact_error_message;
        match self {
            AppError::Io(msg) => ("Io", redact_error_message(msg)),
            AppError::Serialization(msg) => ("Serialization", redact_error_message(msg)),
            AppError::Path(msg) => ("Path", redact_error_message(msg)),
            AppError::Validation(msg) => ("Validation", redact_error_message(msg)),
            AppError::NotFound(msg) => ("NotFound", redact_error_message(msg)),
            AppError::TaskJoin(msg) => ("TaskJoin", redact_error_message(msg)),
            AppError::Tray(msg) => ("Tray", redact_error_message(msg)),
            AppError::QuickPane(msg) => ("QuickPane", redact_error_message(msg)),
            AppError::Notification(msg) => ("Notification", redact_error_message(msg)),
            AppError::Window(msg) => ("Window", redact_error_message(msg)),
            AppError::RuntimeStart(msg) => ("RuntimeStart", redact_error_message(msg)),
            AppError::RuntimeShutdown(msg) => ("RuntimeShutdown", redact_error_message(msg)),
            AppError::NotInitialized(msg) => ("NotInitialized", redact_error_message(msg)),
            AppError::AppServerError(msg) => ("AppServerError", redact_error_message(msg)),
            AppError::TypedRequestError(msg) => ("TypedRequestError", redact_error_message(msg)),
        }
    }

    pub fn io(msg: impl Into<String>) -> Self {
        AppError::Io(msg.into())
    }

    pub fn serialization(msg: impl Into<String>) -> Self {
        AppError::Serialization(msg.into())
    }

    pub fn path(msg: impl Into<String>) -> Self {
        AppError::Path(msg.into())
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError::NotFound(msg.into())
    }

    pub fn task_join(msg: impl Into<String>) -> Self {
        AppError::TaskJoin(msg.into())
    }

    pub fn tray(msg: impl Into<String>) -> Self {
        AppError::Tray(msg.into())
    }

    pub fn quick_pane(msg: impl Into<String>) -> Self {
        AppError::QuickPane(msg.into())
    }

    pub fn notification(msg: impl Into<String>) -> Self {
        AppError::Notification(msg.into())
    }

    pub fn window(msg: impl Into<String>) -> Self {
        AppError::Window(msg.into())
    }

    pub fn runtime_start(msg: impl Into<String>) -> Self {
        AppError::RuntimeStart(msg.into())
    }

    pub fn runtime_shutdown(msg: impl Into<String>) -> Self {
        AppError::RuntimeShutdown(msg.into())
    }

    pub fn not_initialized(msg: impl Into<String>) -> Self {
        AppError::NotInitialized(msg.into())
    }

    pub fn app_server_error(msg: impl Into<String>) -> Self {
        AppError::AppServerError(msg.into())
    }

    pub fn typed_request_error(msg: impl Into<String>) -> Self {
        AppError::TypedRequestError(msg.into())
    }

    /// 返回稳定的错误码字符串，用于编程化的错误处理。
    ///
    /// 这些错误码与 `src/lib/error-codes.ts` 中的定义镜像，必须保持同步。
    /// 前端可据此按错误类型 switch，而无需解析人类可读的消息。
    pub fn error_code(&self) -> &'static str {
        match self {
            AppError::Io(_) => "ERR_IO",
            AppError::Serialization(_) => "ERR_SERIALIZATION",
            AppError::Path(_) => "ERR_PATH",
            AppError::Validation(_) => "ERR_VALIDATION",
            AppError::NotFound(_) => "ERR_NOT_FOUND",
            AppError::TaskJoin(_) => "ERR_TASK_JOIN",
            AppError::Tray(_) => "ERR_TRAY",
            AppError::QuickPane(_) => "ERR_QUICK_PANE",
            AppError::Notification(_) => "ERR_NOTIFICATION",
            AppError::Window(_) => "ERR_WINDOW",
            AppError::RuntimeStart(_) => "ERR_RUNTIME_START",
            AppError::RuntimeShutdown(_) => "ERR_RUNTIME_SHUTDOWN",
            AppError::NotInitialized(_) => "ERR_NOT_INITIALIZED",
            AppError::AppServerError(_) => "ERR_APP_SERVER",
            AppError::TypedRequestError(_) => "ERR_TYPED_REQUEST",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Display trait — 正向用例
    // =========================================================================

    #[test]
    fn display_io_shows_prefix() {
        let err = AppError::Io("disk full".into());
        assert_eq!(format!("{err}"), "IO error: disk full");
    }

    #[test]
    fn display_serialization_shows_prefix() {
        let err = AppError::Serialization("bad json".into());
        assert_eq!(format!("{err}"), "Serialization error: bad json");
    }

    #[test]
    fn display_path_shows_prefix() {
        let err = AppError::Path("not found".into());
        assert_eq!(format!("{err}"), "Path error: not found");
    }

    #[test]
    fn display_validation_shows_prefix() {
        let err = AppError::Validation("too long".into());
        assert_eq!(format!("{err}"), "Validation error: too long");
    }

    #[test]
    fn display_not_found_shows_prefix() {
        let err = AppError::NotFound("missing".into());
        assert_eq!(format!("{err}"), "Not found: missing");
    }

    #[test]
    fn display_task_join_shows_prefix() {
        let err = AppError::TaskJoin("panic".into());
        assert_eq!(format!("{err}"), "Task join error: panic");
    }

    #[test]
    fn display_tray_shows_prefix() {
        let err = AppError::Tray("icon failed".into());
        assert_eq!(format!("{err}"), "Tray error: icon failed");
    }

    #[test]
    fn display_quick_pane_shows_prefix() {
        let err = AppError::QuickPane("no window".into());
        assert_eq!(format!("{err}"), "Quick pane error: no window");
    }

    #[test]
    fn display_notification_shows_prefix() {
        let err = AppError::Notification("denied".into());
        assert_eq!(format!("{err}"), "Notification error: denied");
    }

    #[test]
    fn display_window_shows_prefix() {
        let err = AppError::Window("closed".into());
        assert_eq!(format!("{err}"), "Window error: closed");
    }

    #[test]
    fn display_runtime_start_shows_prefix() {
        let err = AppError::RuntimeStart("timeout".into());
        assert_eq!(format!("{err}"), "Runtime start error: timeout");
    }

    #[test]
    fn display_runtime_shutdown_shows_prefix() {
        let err = AppError::RuntimeShutdown("hang".into());
        assert_eq!(format!("{err}"), "Runtime shutdown error: hang");
    }

    #[test]
    fn display_not_initialized_shows_prefix() {
        let err = AppError::NotInitialized("not called".into());
        assert_eq!(format!("{err}"), "Runtime not initialized: not called");
    }

    #[test]
    fn display_app_server_error_shows_prefix() {
        let err = AppError::AppServerError("internal".into());
        assert_eq!(format!("{err}"), "App server error: internal");
    }

    // =========================================================================
    // From<std::io::Error> — 正向/异常用例
    // =========================================================================

    #[test]
    fn from_io_error_maps_to_io_variant() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let app_err = AppError::from(io_err);
        assert!(matches!(app_err, AppError::Io(_)));
        assert!(app_err.to_string().contains("file missing"));
    }

    #[test]
    fn from_io_error_preserves_message() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let app_err = AppError::from(io_err);
        assert!(app_err.to_string().contains("access denied"));
    }

    // =========================================================================
    // From<serde_json::Error> — 正向/异常用例
    // =========================================================================

    #[test]
    fn from_serde_json_error_maps_to_serialization_variant() {
        let json_err = serde_json::from_str::<String>("not a string").unwrap_err();
        let app_err = AppError::from(json_err);
        assert!(matches!(app_err, AppError::Serialization(_)));
    }

    #[test]
    fn from_serde_json_error_preserves_message() {
        let json_err = serde_json::from_str::<serde_json::Value>("{bad}").unwrap_err();
        let app_err = AppError::from(json_err);
        assert!(!app_err.to_string().is_empty());
    }

    // =========================================================================
    // 构造函数 — 正向用例
    // =========================================================================

    #[test]
    fn constructor_io_creates_correct_variant() {
        let err = AppError::io("read failed");
        assert!(matches!(err, AppError::Io(s) if s == "read failed"));
    }

    #[test]
    fn constructor_serialization_creates_correct_variant() {
        let err = AppError::serialization("parse failed");
        assert!(matches!(err, AppError::Serialization(s) if s == "parse failed"));
    }

    #[test]
    fn constructor_path_creates_correct_variant() {
        let err = AppError::path("dir missing");
        assert!(matches!(err, AppError::Path(s) if s == "dir missing"));
    }

    #[test]
    fn constructor_validation_creates_correct_variant() {
        let err = AppError::validation("invalid input");
        assert!(matches!(err, AppError::Validation(s) if s == "invalid input"));
    }

    #[test]
    fn constructor_not_found_creates_correct_variant() {
        let err = AppError::not_found("resource");
        assert!(matches!(err, AppError::NotFound(s) if s == "resource"));
    }

    #[test]
    fn constructor_task_join_creates_correct_variant() {
        let err = AppError::task_join("cancelled");
        assert!(matches!(err, AppError::TaskJoin(s) if s == "cancelled"));
    }

    #[test]
    fn constructor_tray_creates_correct_variant() {
        let err = AppError::tray("init failed");
        assert!(matches!(err, AppError::Tray(s) if s == "init failed"));
    }

    #[test]
    fn constructor_quick_pane_creates_correct_variant() {
        let err = AppError::quick_pane("no window");
        assert!(matches!(err, AppError::QuickPane(s) if s == "no window"));
    }

    #[test]
    fn constructor_notification_creates_correct_variant() {
        let err = AppError::notification("unsupported");
        assert!(matches!(err, AppError::Notification(s) if s == "unsupported"));
    }

    #[test]
    fn constructor_window_creates_correct_variant() {
        let err = AppError::window("destroyed");
        assert!(matches!(err, AppError::Window(s) if s == "destroyed"));
    }

    #[test]
    fn constructor_runtime_start_creates_correct_variant() {
        let err = AppError::runtime_start("timeout");
        assert!(matches!(err, AppError::RuntimeStart(s) if s == "timeout"));
    }

    #[test]
    fn constructor_runtime_shutdown_creates_correct_variant() {
        let err = AppError::runtime_shutdown("hang");
        assert!(matches!(err, AppError::RuntimeShutdown(s) if s == "hang"));
    }

    #[test]
    fn constructor_not_initialized_creates_correct_variant() {
        let err = AppError::not_initialized("not called");
        assert!(matches!(err, AppError::NotInitialized(s) if s == "not called"));
    }

    #[test]
    fn constructor_app_server_error_creates_correct_variant() {
        let err = AppError::app_server_error("internal");
        assert!(matches!(err, AppError::AppServerError(s) if s == "internal"));
    }

    // =========================================================================
    // 构造函数 — 边界用例
    // =========================================================================

    #[test]
    fn constructor_accepts_string_literal() {
        let err = AppError::io("literal");
        assert!(err.to_string().contains("literal"));
    }

    #[test]
    fn constructor_accepts_owned_string() {
        let msg = String::from("owned");
        let err = AppError::io(msg);
        assert!(err.to_string().contains("owned"));
    }

    #[test]
    fn constructor_accepts_empty_string() {
        let err = AppError::io("");
        assert!(matches!(err, AppError::Io(s) if s.is_empty()));
    }

    // =========================================================================
    // Serialize — 正向用例
    // =========================================================================

    #[test]
    fn serialize_produces_tagged_json() {
        let err = AppError::Validation("bad input".into());
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"kind\":\"Validation\""));
        assert!(json.contains("\"message\":\"bad input\""));
    }

    #[test]
    fn serialize_all_variants_have_kind_tag() {
        let cases = [
            (AppError::Io("x".into()), "Io"),
            (AppError::Serialization("x".into()), "Serialization"),
            (AppError::Path("x".into()), "Path"),
            (AppError::Validation("x".into()), "Validation"),
            (AppError::NotFound("x".into()), "NotFound"),
            (AppError::TaskJoin("x".into()), "TaskJoin"),
            (AppError::Tray("x".into()), "Tray"),
            (AppError::QuickPane("x".into()), "QuickPane"),
            (AppError::Notification("x".into()), "Notification"),
            (AppError::Window("x".into()), "Window"),
            (AppError::RuntimeStart("x".into()), "RuntimeStart"),
            (AppError::RuntimeShutdown("x".into()), "RuntimeShutdown"),
            (AppError::NotInitialized("x".into()), "NotInitialized"),
            (AppError::AppServerError("x".into()), "AppServerError"),
        ];
        for (err, expected_kind) in cases {
            let json = serde_json::to_string(&err).unwrap();
            assert!(
                json.contains(&format!("\"kind\":\"{expected_kind}\"")),
                "Serialized JSON missing kind tag for {expected_kind}: {json}"
            );
        }
    }

    // =========================================================================
    // Clone — 正向用例
    // =========================================================================

    #[test]
    fn clone_produces_equal_error() {
        let err = AppError::Io("test".into());
        let cloned = err.clone();
        assert_eq!(err.to_string(), cloned.to_string());
    }

    // =========================================================================
    // error_code — 正向用例
    // =========================================================================

    #[test]
    fn error_code_io_returns_stable_code() {
        let err = AppError::Io("test".into());
        assert_eq!(err.error_code(), "ERR_IO");
    }

    #[test]
    fn error_code_serialization_returns_stable_code() {
        let err = AppError::Serialization("test".into());
        assert_eq!(err.error_code(), "ERR_SERIALIZATION");
    }

    #[test]
    fn error_code_path_returns_stable_code() {
        let err = AppError::Path("test".into());
        assert_eq!(err.error_code(), "ERR_PATH");
    }

    #[test]
    fn error_code_validation_returns_stable_code() {
        let err = AppError::Validation("test".into());
        assert_eq!(err.error_code(), "ERR_VALIDATION");
    }

    #[test]
    fn error_code_not_found_returns_stable_code() {
        let err = AppError::NotFound("test".into());
        assert_eq!(err.error_code(), "ERR_NOT_FOUND");
    }

    #[test]
    fn error_code_task_join_returns_stable_code() {
        let err = AppError::TaskJoin("test".into());
        assert_eq!(err.error_code(), "ERR_TASK_JOIN");
    }

    #[test]
    fn error_code_tray_returns_stable_code() {
        let err = AppError::Tray("test".into());
        assert_eq!(err.error_code(), "ERR_TRAY");
    }

    #[test]
    fn error_code_quick_pane_returns_stable_code() {
        let err = AppError::QuickPane("test".into());
        assert_eq!(err.error_code(), "ERR_QUICK_PANE");
    }

    #[test]
    fn error_code_notification_returns_stable_code() {
        let err = AppError::Notification("test".into());
        assert_eq!(err.error_code(), "ERR_NOTIFICATION");
    }

    #[test]
    fn error_code_window_returns_stable_code() {
        let err = AppError::Window("test".into());
        assert_eq!(err.error_code(), "ERR_WINDOW");
    }

    #[test]
    fn error_code_runtime_start_returns_stable_code() {
        let err = AppError::RuntimeStart("test".into());
        assert_eq!(err.error_code(), "ERR_RUNTIME_START");
    }

    #[test]
    fn error_code_runtime_shutdown_returns_stable_code() {
        let err = AppError::RuntimeShutdown("test".into());
        assert_eq!(err.error_code(), "ERR_RUNTIME_SHUTDOWN");
    }

    #[test]
    fn error_code_not_initialized_returns_stable_code() {
        let err = AppError::NotInitialized("test".into());
        assert_eq!(err.error_code(), "ERR_NOT_INITIALIZED");
    }

    #[test]
    fn error_code_app_server_error_returns_stable_code() {
        let err = AppError::AppServerError("test".into());
        assert_eq!(err.error_code(), "ERR_APP_SERVER");
    }

    #[test]
    fn error_code_typed_request_error_returns_stable_code() {
        let err = AppError::TypedRequestError("test".into());
        assert_eq!(err.error_code(), "ERR_TYPED_REQUEST");
    }

    // =========================================================================
    // error_code — 边界用例
    // =========================================================================

    #[test]
    fn error_code_is_stable_across_different_messages() {
        let err1 = AppError::Io("message1".into());
        let err2 = AppError::Io("message2".into());
        assert_eq!(err1.error_code(), err2.error_code());
    }

    #[test]
    fn error_code_differs_across_variants() {
        let io_err = AppError::Io("test".into());
        let validation_err = AppError::Validation("test".into());
        assert_ne!(io_err.error_code(), validation_err.error_code());
    }

    #[test]
    fn error_code_all_variants_unique() {
        let codes = [
            AppError::Io("x".into()).error_code(),
            AppError::Serialization("x".into()).error_code(),
            AppError::Path("x".into()).error_code(),
            AppError::Validation("x".into()).error_code(),
            AppError::NotFound("x".into()).error_code(),
            AppError::TaskJoin("x".into()).error_code(),
            AppError::Tray("x".into()).error_code(),
            AppError::QuickPane("x".into()).error_code(),
            AppError::Notification("x".into()).error_code(),
            AppError::Window("x".into()).error_code(),
            AppError::RuntimeStart("x".into()).error_code(),
            AppError::RuntimeShutdown("x".into()).error_code(),
            AppError::NotInitialized("x".into()).error_code(),
            AppError::AppServerError("x".into()).error_code(),
            AppError::TypedRequestError("x".into()).error_code(),
        ];
        let unique: std::collections::HashSet<&str> = codes.iter().copied().collect();
        assert_eq!(codes.len(), unique.len(), "Duplicate error codes found");
    }

    // =========================================================================
    // TypedRequestError — Display trait
    // =========================================================================

    #[test]
    fn typed_request_error_display_transport_shows_method_and_source() {
        let err = TypedRequestError::Transport {
            method: "thread/start".to_string(),
            source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "channel closed"),
        };
        assert!(err.to_string().contains("thread/start"));
        assert!(err.to_string().contains("transport error"));
        assert!(err.to_string().contains("channel closed"));
    }

    #[test]
    fn typed_request_error_display_server_shows_method_code_and_message() {
        let err = TypedRequestError::Server {
            method: "turn/start".to_string(),
            source: JSONRPCErrorError {
                code: -32601,
                message: "method not found".to_string(),
                data: None,
            },
        };
        let s = err.to_string();
        assert!(s.contains("turn/start"));
        assert!(s.contains("method not found"));
        assert!(s.contains("-32601"));
    }

    #[test]
    fn typed_request_error_display_server_includes_data_when_present() {
        let err = TypedRequestError::Server {
            method: "config/read".to_string(),
            source: JSONRPCErrorError {
                code: -32602,
                message: "invalid params".to_string(),
                data: Some(serde_json::json!({"field": "path"})),
            },
        };
        let s = err.to_string();
        assert!(s.contains("data:"));
        assert!(s.contains("field"));
    }

    #[test]
    fn typed_request_error_display_deserialize_shows_method_and_source() {
        let json_err = serde_json::from_str::<String>("not a string").unwrap_err();
        let err = TypedRequestError::Deserialize {
            method: "mcp/server_status_list".to_string(),
            source: json_err,
        };
        assert!(err.to_string().contains("mcp/server_status_list"));
        assert!(err.to_string().contains("decode error"));
    }

    // =========================================================================
    // TypedRequestError — Error::source()
    // =========================================================================

    #[test]
    fn typed_request_error_source_transport_returns_some() {
        let err = TypedRequestError::Transport {
            method: "test".to_string(),
            source: std::io::Error::new(std::io::ErrorKind::WouldBlock, "full"),
        };
        assert!(std::error::Error::source(&err).is_some());
    }

    #[test]
    fn typed_request_error_source_server_returns_none() {
        let err = TypedRequestError::Server {
            method: "test".to_string(),
            source: JSONRPCErrorError {
                code: -1,
                message: "err".to_string(),
                data: None,
            },
        };
        assert!(std::error::Error::source(&err).is_none());
    }

    #[test]
    fn typed_request_error_source_deserialize_returns_some() {
        let json_err = serde_json::from_str::<i32>("not a number").unwrap_err();
        let err = TypedRequestError::Deserialize {
            method: "test".to_string(),
            source: json_err,
        };
        assert!(std::error::Error::source(&err).is_some());
    }

    // =========================================================================
    // From<TypedRequestError> for AppError
    // =========================================================================

    #[test]
    fn from_typed_request_error_transport_maps_to_typed_request_variant() {
        let typed = TypedRequestError::Transport {
            method: "thread/start".to_string(),
            source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed"),
        };
        let app_err = AppError::from(typed);
        assert!(matches!(app_err, AppError::TypedRequestError(_)));
        assert!(app_err.to_string().contains("thread/start"));
    }

    #[test]
    fn from_typed_request_error_server_maps_to_typed_request_variant() {
        let typed = TypedRequestError::Server {
            method: "turn/start".to_string(),
            source: JSONRPCErrorError {
                code: -32603,
                message: "internal error".to_string(),
                data: None,
            },
        };
        let app_err = AppError::from(typed);
        assert!(matches!(app_err, AppError::TypedRequestError(_)));
        assert!(app_err.to_string().contains("turn/start"));
        assert!(app_err.to_string().contains("internal error"));
    }

    #[test]
    fn from_typed_request_error_deserialize_maps_to_typed_request_variant() {
        let json_err = serde_json::from_str::<String>("123").unwrap_err();
        let typed = TypedRequestError::Deserialize {
            method: "fs/read".to_string(),
            source: json_err,
        };
        let app_err = AppError::from(typed);
        assert!(matches!(app_err, AppError::TypedRequestError(_)));
        assert!(app_err.to_string().contains("fs/read"));
    }

    // =========================================================================
    // AppError::TypedRequestError — Display / constructor / serialize
    // =========================================================================

    #[test]
    fn display_typed_request_error_shows_prefix() {
        let err = AppError::TypedRequestError("decode failed".into());
        assert_eq!(format!("{err}"), "Typed request error: decode failed");
    }

    #[test]
    fn constructor_typed_request_error_creates_correct_variant() {
        let err = AppError::typed_request_error("transport failure");
        assert!(matches!(err, AppError::TypedRequestError(s) if s == "transport failure"));
    }

    #[test]
    fn serialize_typed_request_error_produces_tagged_json() {
        let err = AppError::TypedRequestError("bad response".into());
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"kind\":\"TypedRequestError\""));
        assert!(json.contains("\"message\":\"bad response\""));
    }
}
