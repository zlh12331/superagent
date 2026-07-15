//! Codex analytics 事件采集与上报。
//!
//! 本 crate 负责：
//! - 采集 app-server 协议事件、工具调用、插件、guardian 审查等 analytics fact
//! - 通过 [`AnalyticsEventsClient`] 将 fact 异步上报到后端
//! - 在 debug 构建下支持将事件写入本地文件用于测试
//!
//! 核心类型：
//! - [`AnalyticsEventsClient`]：对外暴露的事件采集客户端
//! - [`TrackEventsContext`]：单个 turn / thread 级的追踪上下文
//! - [`AnalyticsFact`]：内部事件输入，由 reducer 转换为上报请求

mod accepted_lines;
#[cfg(debug_assertions)]
mod analytics_capture;
mod client;
mod events;
mod facts;
mod reducer;

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub use accepted_lines::accepted_line_fingerprints_from_unified_diff;
pub use accepted_lines::fingerprint_hash;
pub use client::AnalyticsEventsClient;
pub use events::AppServerRpcTransport;
pub use events::GuardianApprovalRequestSource;
pub use events::GuardianReviewAnalyticsResult;
pub use events::GuardianReviewDecision;
pub use events::GuardianReviewEventParams;
pub use events::GuardianReviewFailureReason;
pub use events::GuardianReviewSessionAnalyticsParams;
pub use events::GuardianReviewSessionKind;
pub use events::GuardianReviewTerminalStatus;
pub use events::GuardianReviewTrackContext;
pub use events::GuardianReviewedAction;
pub use facts::AcceptedLineFingerprint;
pub use facts::AnalyticsJsonRpcError;
pub use facts::AppInvocation;
pub use facts::CodexCompactionEvent;
pub use facts::CodexErrKind;
pub use facts::CodexGoalEvent;
pub use facts::CodexTurnSteerEvent;
pub use facts::CompactionImplementation;
pub use facts::CompactionPhase;
pub use facts::CompactionReason;
pub use facts::CompactionStatus;
pub use facts::CompactionStrategy;
pub use facts::CompactionTrigger;
pub use facts::ExternalAgentConfigImportCompletedInput;
pub use facts::ExternalAgentConfigImportFailureInput;
pub use facts::GoalEventKind;
pub use facts::HookRunFact;
pub use facts::InputError;
pub use facts::InvocationType;
pub use facts::PluginInstallRequestSource;
pub use facts::PluginInstallRequested;
pub use facts::PluginInstallRequestedPlugin;
pub use facts::SkillInvocation;
pub use facts::SubAgentThreadStartedInput;
pub use facts::ThreadInitializationMode;
pub use facts::TrackEventsContext;
pub use facts::TurnCodexErrorFact;
pub use facts::TurnProfile;
pub use facts::TurnProfileFact;
pub use facts::TurnResolvedConfigFact;
pub use facts::TurnStatus;
pub use facts::TurnSteerRejectionReason;
pub use facts::TurnSteerRequestError;
pub use facts::TurnSteerResult;
pub use facts::TurnTokenUsageFact;
pub use facts::build_track_events_context;

#[cfg(test)]
mod analytics_client_tests;

/// 返回当前 Unix 时间戳（秒）。
pub fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// 返回当前 Unix 时间戳（毫秒）。
pub fn now_unix_millis() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

/// 将实现了 [`Serialize`](serde::Serialize) 的枚举序列化为字符串形式。
///
/// 仅适用于被 `#[serde(rename_all = "snake_case")]` 等属性标注的枚举，
/// 序列化结果应为一个 JSON 字符串。
pub(crate) fn serialize_enum_as_string<T: serde::Serialize>(value: &T) -> Option<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
}

/// 将 `usize` 安全转换为 `u64`，溢出时返回 `u64::MAX`。
pub(crate) fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

/// 将可选的 `i64` 安全转换为 `u64`，负值或溢出时返回 `None`。
pub(crate) fn option_i64_to_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|value| u64::try_from(value).ok())
}
