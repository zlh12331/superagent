//! 云端配置 bundle 相关的指标（metrics）上报。
//!
//! 通过 `codex_otel` 全局实例发送 counter 指标，覆盖三类事件：
//! - `fetch_attempt`：每次后端请求尝试
//! - `fetch_final`：一次完整 fetch 流程的最终结果
//! - `load`：bundle 加载（startup / refresh）的整体结果

use codex_config::CloudConfigBundle;

/// 指标名：单次后端 fetch 尝试。
const CLOUD_CONFIG_BUNDLE_FETCH_ATTEMPT_METRIC: &str = "codex.cloud_config_bundle.fetch_attempt";
/// 指标名：一次完整 fetch 流程的最终结果。
const CLOUD_CONFIG_BUNDLE_FETCH_FINAL_METRIC: &str = "codex.cloud_config_bundle.fetch_final";
/// 指标名：bundle 加载（startup / refresh）的整体结果。
const CLOUD_CONFIG_BUNDLE_LOAD_METRIC: &str = "codex.cloud_config_bundle.load";

/// 上报一次 fetch 尝试的指标。
///
/// 参数：
/// - `trigger`：触发来源（`startup` / `refresh`）。
/// - `attempt`：当前重试轮次（从 1 开始）。
/// - `outcome`：结果标签（`success` / `error` / `unauthorized`）。
/// - `status_code`：HTTP 状态码（若适用）。
pub(crate) fn emit_fetch_attempt_metric(
    trigger: &str,
    attempt: usize,
    outcome: &str,
    status_code: Option<u16>,
) {
    let attempt_tag = attempt.to_string();
    let status_code_tag = status_code_tag(status_code);
    emit_metric(
        CLOUD_CONFIG_BUNDLE_FETCH_ATTEMPT_METRIC,
        vec![
            ("trigger", trigger.to_string()),
            ("attempt", attempt_tag),
            ("outcome", outcome.to_string()),
            ("status_code", status_code_tag),
        ],
    );
}

/// 上报一次完整 fetch 流程的最终结果指标。
///
/// 参数：
/// - `trigger`：触发来源（`startup` / `refresh`）。
/// - `outcome`：最终结果（`success` / `error`）。
/// - `reason`：失败时的原因标签；成功时为 `none`。
/// - `attempt_count`：本次流程累计尝试次数。
/// - `status_code`：最后一次 HTTP 状态码（若适用）。
/// - `bundle`：成功时携带的 bundle，用于生成 `bundle_shape` 标签。
pub(crate) fn emit_fetch_final_metric(
    trigger: &str,
    outcome: &str,
    reason: &str,
    attempt_count: usize,
    status_code: Option<u16>,
    bundle: Option<&CloudConfigBundle>,
) {
    let attempt_count_tag = attempt_count.to_string();
    let status_code_tag = status_code_tag(status_code);
    emit_metric(
        CLOUD_CONFIG_BUNDLE_FETCH_FINAL_METRIC,
        vec![
            ("trigger", trigger.to_string()),
            ("outcome", outcome.to_string()),
            ("reason", reason.to_string()),
            ("attempt_count", attempt_count_tag),
            ("status_code", status_code_tag),
            ("bundle_shape", bundle_shape_tag(bundle)),
        ],
    );
}

/// 上报一次 bundle 加载（startup / refresh）的整体结果指标。
///
/// 参数：
/// - `trigger`：触发来源（`startup` / `refresh`）。
/// - `outcome`：最终结果（`success` / `error`）。
/// - `bundle`：成功时携带的 bundle，用于生成 `bundle_shape` 标签。
pub(crate) fn emit_load_metric(trigger: &str, outcome: &str, bundle: Option<&CloudConfigBundle>) {
    emit_metric(
        CLOUD_CONFIG_BUNDLE_LOAD_METRIC,
        vec![
            ("trigger", trigger.to_string()),
            ("outcome", outcome.to_string()),
            ("bundle_shape", bundle_shape_tag(bundle)),
        ],
    );
}

/// 根据 bundle 中包含的 enterprise_managed 片段生成 `bundle_shape` 标签。
///
/// - `none`：bundle 不存在。
/// - `empty`：bundle 存在但不含任何片段。
/// - 其它：按字母序拼接的片段来源列表（如 `enterprise_config,enterprise_requirements`）。
pub(crate) fn bundle_shape_tag(bundle: Option<&CloudConfigBundle>) -> String {
    let Some(bundle) = bundle else {
        return "none".to_string();
    };

    let mut sources = Vec::new();
    if !bundle.config_toml.enterprise_managed.is_empty() {
        sources.push("enterprise_config");
    }
    if !bundle.requirements_toml.enterprise_managed.is_empty() {
        sources.push("enterprise_requirements");
    }

    if sources.is_empty() {
        "empty".to_string()
    } else {
        sources.sort_unstable();
        sources.join(",")
    }
}

fn status_code_tag(status_code: Option<u16>) -> String {
    status_code
        .map(|status_code| status_code.to_string())
        .unwrap_or_else(|| "none".to_string())
}

fn emit_metric(metric_name: &str, tags: Vec<(&str, String)>) {
    if let Some(metrics) = codex_otel::global() {
        let tag_refs = tags
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect::<Vec<_>>();
        let _ = metrics.counter(metric_name, /*inc*/ 1, &tag_refs);
    }
}
