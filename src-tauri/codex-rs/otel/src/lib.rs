//! OpenTelemetry 集成模块。
//!
//! 该 crate 负责 Codex 与 OpenTelemetry 的集成，包括：
//! - 配置 OTLP / Statsig 等 metrics、traces、logs exporter
//! - 构建并管理 OTEL provider（[`provider::OtelProvider`]）
//! - 在 W3C trace context 之间进行注入与提取
//! - 维护全局 metrics 客户端与运行时指标采集
//! - 会话级 telemetry 元数据管理
//!
//! 对外暴露的主要类型有：[`OtelProvider`]、[`OtelSettings`]、[`OtelExporter`]、
//! [`Timer`] 以及各类 trace context 辅助函数。

pub(crate) mod config;
mod events;
pub(crate) mod metrics;
pub(crate) mod provider;
pub(crate) mod trace_context;

mod otlp;
mod targets;

use crate::metrics::Result as MetricsResult;
use codex_protocol::auth::AuthMode;
use serde::Serialize;
use strum_macros::Display;

pub use crate::config::OtelExporter;
pub use crate::config::OtelHttpProtocol;
pub use crate::config::OtelSettings;
pub use crate::config::OtelTlsConfig;
pub use crate::config::StatsigMetricsSettings;
pub use crate::config::validate_span_attributes;
pub use crate::events::session_telemetry::AuthEnvTelemetryMetadata;
pub use crate::events::session_telemetry::SessionTelemetry;
pub use crate::events::session_telemetry::SessionTelemetryMetadata;
pub use crate::metrics::runtime_metrics::RuntimeMetricTotals;
pub use crate::metrics::runtime_metrics::RuntimeMetricsSummary;
pub use crate::metrics::timer::Timer;
pub use crate::metrics::*;
pub use crate::provider::OtelProvider;
pub use crate::trace_context::context_from_w3c_trace_context;
pub use crate::trace_context::current_span_trace_id;
pub use crate::trace_context::current_span_w3c_trace_context;
pub use crate::trace_context::inject_span_w3c_trace_headers;
pub use crate::trace_context::set_parent_from_context;
pub use crate::trace_context::set_parent_from_w3c_trace_context;
pub use crate::trace_context::span_w3c_trace_context;
pub use crate::trace_context::traceparent_context_from_env;
pub use crate::trace_context::validate_tracestate_entries;
pub use crate::trace_context::validate_tracestate_member;
pub use codex_utils_string::sanitize_metric_tag_value;

/// 工具调用决策的来源，用于 telemetry 区分某次工具调用是由谁批准的。
#[derive(Debug, Clone, Serialize, Display)]
#[serde(rename_all = "snake_case")]
pub enum ToolDecisionSource {
    /// 由自动审查器（automated reviewer）批准。
    AutomatedReviewer,
    /// 由配置默认规则批准。
    Config,
    /// 由用户手动批准。
    User,
}

/// 将认证域（authentication domain）粗粒度地映射到 telemetry 使用的维度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Display)]
pub enum TelemetryAuthMode {
    ApiKey,
    Chatgpt,
}

/// 将 [`AuthMode`] 转换为 [`TelemetryAuthMode`]。
///
/// 将多个细粒度认证模式归并为 telemetry 所需的粗粒度类别：
/// - `ApiKey` / `BedrockApiKey` 归为 [`TelemetryAuthMode::ApiKey`]
/// - `Chatgpt` / `ChatgptAuthTokens` / `AgentIdentity` / `PersonalAccessToken`
///   归为 [`TelemetryAuthMode::Chatgpt`]
impl From<AuthMode> for TelemetryAuthMode {
    fn from(mode: AuthMode) -> Self {
        match mode {
            AuthMode::ApiKey | AuthMode::BedrockApiKey => Self::ApiKey,
            AuthMode::Chatgpt
            | AuthMode::ChatgptAuthTokens
            | AuthMode::AgentIdentity
            | AuthMode::PersonalAccessToken => Self::Chatgpt,
        }
    }
}

/// 通过全局安装的 metrics 客户端启动一个计时器（timer）。
///
/// `name` 为指标名称，`tags` 为附加的标签键值对。
/// 若全局未安装 metrics 客户端，则返回 [`MetricsError::ExporterDisabled`]。
pub fn start_global_timer(name: &str, tags: &[(&str, &str)]) -> MetricsResult<Timer> {
    let Some(metrics) = crate::metrics::global() else {
        return Err(MetricsError::ExporterDisabled);
    };
    metrics.start_timer(name, tags)
}

/// 返回全局安装的 OTEL metrics 客户端解析后的 Statsig metrics 配置。
///
/// 仅当活跃的 metrics exporter 为 Statsig 时返回 `Some`。
pub fn global_statsig_metrics_settings() -> Option<StatsigMetricsSettings> {
    crate::metrics::global_statsig_settings()
}
