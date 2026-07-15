//! memories 启动期 guard：基于 Codex backend 限流快照判断是否应启动 memory 流水线。
//!
//! 当限流剩余比例低于配置阈值时跳过 memory 启动，避免加剧限流。

use codex_backend_client::Client as BackendClient;
use codex_core::config::Config;
use codex_login::AuthManager;
use codex_protocol::protocol::RateLimitSnapshot;
use codex_protocol::protocol::RateLimitWindow;
use tracing::info;
use tracing::warn;

/// 检查当前限流是否允许启动 memory 流水线。
///
/// 检查过程中若发生错误（如无法获取限流），默认返回 `true`，避免阻断 memory 流水线。
pub(crate) async fn rate_limits_ok(auth_manager: &AuthManager, config: &Config) -> bool {
    rate_limits_check(auth_manager, config)
        .await
        .unwrap_or(true)
}

/// 查询 backend 限流快照，判断当前是否允许启动 memory 流水线。
///
/// 返回 `None` 表示无法判断（例如未使用 codex backend），调用方应视作允许。
async fn rate_limits_check(auth_manager: &AuthManager, config: &Config) -> Option<bool> {
    let auth = auth_manager.auth().await?;
    // 非 codex backend 用户无法查询限流，直接返回 None。
    if !auth.uses_codex_backend() {
        return None;
    }

    let client = BackendClient::from_auth(config.chatgpt_base_url.clone(), &auth)
        .map_err(|err| warn!(%err, "failed to construct backend client"))
        .ok()?;

    let snapshots = client
        .get_rate_limits_many()
        .await
        .map_err(|err| warn!(%err, "failed to fetch rate limits"))
        .ok()?;

    // 优先匹配 codex 专属 limit_id，否则取第一个快照作为兜底。
    let snapshot = snapshots
        .iter()
        .find(|s| s.limit_id.as_deref() == Some(crate::guard_limits::CODEX_LIMIT_ID))
        .or_else(|| snapshots.first())?;

    let min_remaining_percent = config.memories.min_rate_limit_remaining_percent;
    let allowed = snapshot_allows_startup(snapshot, min_remaining_percent);

    if !allowed {
        info!(
            min_remaining_percent,
            "skipping memories startup because Codex rate limits are below the configured threshold"
        );
    }

    Some(allowed)
}

/// 判断单条限流快照是否允许启动 memory 流水线。
///
/// 已达到限流上限或主/次窗口使用率超过阈值时返回 `false`。
fn snapshot_allows_startup(snapshot: &RateLimitSnapshot, min_remaining_percent: i64) -> bool {
    // 已触发限流（rate_limit_reached_type 非空）直接拒绝。
    if snapshot.rate_limit_reached_type.is_some() {
        return false;
    }

    // 将剩余百分比换算为最大允许使用百分比，主/次窗口都必须满足。
    let max_used_percent = 100.0 - min_remaining_percent.clamp(0, 100) as f64;
    window_allows_startup(snapshot.primary.as_ref(), max_used_percent)
        && window_allows_startup(snapshot.secondary.as_ref(), max_used_percent)
}

/// 判断单个限流窗口是否允许启动 memory 流水线。
///
/// 窗口为 `None` 时视作无限制，返回 `true`。
fn window_allows_startup(window: Option<&RateLimitWindow>, max_used_percent: f64) -> bool {
    match window {
        Some(window) => window.used_percent <= max_used_percent,
        None => true,
    }
}

#[cfg(test)]
#[path = "guard_tests.rs"]
mod tests;
