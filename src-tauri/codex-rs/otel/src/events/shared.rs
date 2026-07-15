//! Telemetry 事件共享宏与工具函数。
//!
//! 定义 `log_event!`、`trace_event!`、`log_and_trace_event!` 三个宏，
//! 用于在记录 telemetry 事件时统一附加会话级 metadata 字段。
//! 同时提供 RFC 3339 时间戳生成函数 [`timestamp`]。

use chrono::SecondsFormat;
use chrono::Utc;

/// 记录一条仅导出为日志的 telemetry 事件。
///
/// 自动附加会话级 metadata（conversation_id、app_version、auth_mode 等）。
macro_rules! log_event {
    ($self:expr, $($fields:tt)*) => {{
        tracing::event!(
            target: $crate::targets::OTEL_LOG_ONLY_TARGET,
            tracing::Level::INFO,
            $($fields)*
            event.timestamp = %$crate::events::shared::timestamp(),
            conversation.id = %$self.metadata.conversation_id,
            app.version = %$self.metadata.app_version,
            auth_mode = $self.metadata.auth_mode,
            originator = %$self.metadata.originator,
            user.account_id = $self.metadata.account_id,
            user.email = $self.metadata.account_email,
            terminal.type = %$self.metadata.terminal_type,
            model = %$self.metadata.model,
            slug = %$self.metadata.slug,
        );
    }};
}

/// 记录一条可安全导出为 trace span 的 telemetry 事件。
///
/// 与 [`log_event!`] 类似，但不会包含敏感字段（如 account_id、email）。
macro_rules! trace_event {
    ($self:expr, $($fields:tt)*) => {{
        tracing::event!(
            target: $crate::targets::OTEL_TRACE_SAFE_TARGET,
            tracing::Level::INFO,
            $($fields)*
            event.timestamp = %$crate::events::shared::timestamp(),
            conversation.id = %$self.metadata.conversation_id,
            app.version = %$self.metadata.app_version,
            auth_mode = $self.metadata.auth_mode,
            originator = %$self.metadata.originator,
            terminal.type = %$self.metadata.terminal_type,
            model = %$self.metadata.model,
            slug = %$self.metadata.slug,
        );
    }};
}

/// 同时记录日志事件与 trace 事件。
///
/// `common` 块的字段同时出现在两种事件中；
/// `log` 块的字段仅出现在日志事件中；`trace` 块的字段仅出现在 trace 事件中。
macro_rules! log_and_trace_event {
    (
        $self:expr,
        common: { $($common:tt)* },
        log: { $($log:tt)* },
        trace: { $($trace:tt)* },
    ) => {{
        log_event!($self, $($common)* $($log)*);
        trace_event!($self, $($common)* $($trace)*);
    }};
}

pub(crate) use log_and_trace_event;
pub(crate) use log_event;
pub(crate) use trace_event;

/// 返回当前 UTC 时间的 RFC 3339 格式字符串（毫秒精度）。
pub(crate) fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
