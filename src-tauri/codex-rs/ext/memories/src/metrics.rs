//! Memories 工具遥测指标模块。
//!
//! 该模块负责记录 memories 工具调用的 counter 指标，
//! 并提供将 memory 路径映射为 telemetry scope 标签的辅助函数。
//!
//! ## 指标
//!
//! - `codex.memories.tool.call`：工具调用计数，附带以下标签：
//!   - `tool`：工具全名（`memories/<operation>`）
//!   - `operation`：操作名称
//!   - `scope`：memory 路径分类
//!   - `status`：`succeeded` 或 `failed`
//!   - `truncated`：结果是否被截断

use codex_otel::MetricsClient;

use crate::MEMORY_TOOLS_NAMESPACE;

/// memories 工具调用 counter 指标名。
pub(crate) const MEMORIES_TOOL_CALL_METRIC: &str = "codex.memories.tool.call";

/// 记录一次 memories 工具调用。
///
/// # 参数
/// - `metrics_client`：遥测客户端（`None` 时跳过记录）
/// - `operation`：操作名称（如 `list`、`read`、`search`）
/// - `scope`：memory 路径分类标签
/// - `success`：调用是否成功
/// - `truncated`：结果是否被截断的标签值
pub(crate) fn record_tool_call(
    metrics_client: Option<&MetricsClient>,
    operation: &str,
    scope: &str,
    success: bool,
    truncated: &str,
) {
    let Some(metrics_client) = metrics_client else {
        return;
    };

    let tool = format!("{MEMORY_TOOLS_NAMESPACE}/{operation}");
    let _ = metrics_client.counter(
        MEMORIES_TOOL_CALL_METRIC,
        /*inc*/ 1,
        &[
            ("tool", tool.as_str()),
            ("operation", operation),
            ("scope", scope),
            ("status", status_tag(success)),
            ("truncated", truncated),
        ],
    );
}

/// 根据 memory 相对路径返回对应的 scope 标签。
///
/// 路径分类规则：
/// - 空路径 → `root`
/// - `MEMORY.md` → `memory_md`
/// - `memory_summary.md` → `memory_summary`
/// - `raw_memories.md` → `raw_memories`
/// - `rollout_summaries/...` → `rollout_summaries`
/// - `skills/...` → `skills`
/// - `extensions/ad_hoc/notes/...` → `ad_hoc_notes`
/// - 其他 → `other`
pub(crate) fn scope_from_path(path: &str) -> &'static str {
    let path = path.trim_matches('/');
    let path = path.strip_prefix("./").unwrap_or(path);

    if path.is_empty() {
        "root"
    } else if path == "MEMORY.md" {
        "memory_md"
    } else if path == "memory_summary.md" {
        "memory_summary"
    } else if path == "raw_memories.md" {
        "raw_memories"
    } else if path == "rollout_summaries" || path.starts_with("rollout_summaries/") {
        "rollout_summaries"
    } else if path == "skills" || path.starts_with("skills/") {
        "skills"
    } else if path == "extensions/ad_hoc/notes" || path.starts_with("extensions/ad_hoc/notes/") {
        "ad_hoc_notes"
    } else {
        "other"
    }
}

/// 根据可选的 memory 路径返回 scope 标签，路径为 `None` 时返回默认值。
pub(crate) fn scope_from_optional_path(path: Option<&str>, default: &'static str) -> &'static str {
    path.map_or(default, scope_from_path)
}

/// 将截断标志转换为标签值。
///
/// - `Some(true)` → `"true"`
/// - `Some(false)` → `"false"`
/// - `None` → `"unknown"`
pub(crate) fn truncated_tag(truncated: Option<bool>) -> &'static str {
    match truncated {
        Some(true) => "true",
        Some(false) => "false",
        None => "unknown",
    }
}

/// 将成功标志转换为状态标签值。
fn status_tag(success: bool) -> &'static str {
    if success { "succeeded" } else { "failed" }
}
