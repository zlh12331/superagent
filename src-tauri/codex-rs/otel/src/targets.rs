//! OTEL 日志与 trace 导出目标（tracing target）前缀定义。
//!
//! 通过统一的前缀约定区分哪些 tracing 事件应作为日志导出、
//! 哪些可以安全地作为 trace span 导出。

/// 所有 OTEL 导出目标的公共前缀。
pub(crate) const OTEL_TARGET_PREFIX: &str = "codex_otel";
/// 仅用于日志导出的 tracing target。
pub(crate) const OTEL_LOG_ONLY_TARGET: &str = "codex_otel.log_only";
/// 可安全作为 trace span 导出的 tracing target。
pub(crate) const OTEL_TRACE_SAFE_TARGET: &str = "codex_otel.trace_safe";

/// 判断该 target 是否应作为日志导出。
///
/// 属于 `codex_otel` 前缀但不属于 trace_safe 的 target 都会导出为日志。
pub(crate) fn is_log_export_target(target: &str) -> bool {
    target.starts_with(OTEL_TARGET_PREFIX) && !is_trace_safe_target(target)
}

/// 判断该 target 是否可安全作为 trace span 导出。
///
/// 仅 `codex_otel.trace_safe` 前缀的 target 视为安全。
pub(crate) fn is_trace_safe_target(target: &str) -> bool {
    target.starts_with(OTEL_TRACE_SAFE_TARGET)
}
