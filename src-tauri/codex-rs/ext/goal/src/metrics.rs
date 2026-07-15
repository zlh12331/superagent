//! Goal OTel 指标记录模块。
//!
//! 该模块封装 [`MetricsClient`]，为 goal 生命周期中的关键状态变更
//! （创建、恢复、终态）记录 counter 与 histogram 指标。
//!
//! ## 指标分类
//!
//! - **Counter**：goal_created / goal_resumed / goal_blocked /
//!   goal_usage_limited / goal_budget_limited / goal_completed
//! - **Histogram**：goal_token_count / goal_duration_seconds（按 status 打标）

use codex_otel::GOAL_BLOCKED_METRIC;
use codex_otel::GOAL_BUDGET_LIMITED_METRIC;
use codex_otel::GOAL_COMPLETED_METRIC;
use codex_otel::GOAL_CREATED_METRIC;
use codex_otel::GOAL_DURATION_SECONDS_METRIC;
use codex_otel::GOAL_RESUMED_METRIC;
use codex_otel::GOAL_TOKEN_COUNT_METRIC;
use codex_otel::GOAL_USAGE_LIMITED_METRIC;
use codex_otel::MetricsClient;

/// Goal 指标记录器。
///
/// 当未配置 `MetricsClient` 时所有方法均为空操作。
#[derive(Clone, Default)]
pub(crate) struct GoalMetrics {
    metrics_client: Option<MetricsClient>,
}

impl GoalMetrics {
    /// 创建一个新的 `GoalMetrics` 实例。
    ///
    /// 传入 `None` 时所有记录方法均为空操作。
    pub(crate) fn new(metrics_client: Option<MetricsClient>) -> Self {
        Self { metrics_client }
    }

    /// 记录 goal 创建事件（counter +1）。
    pub(crate) fn record_created(&self) {
        let Some(metrics_client) = self.metrics_client.as_ref() else {
            return;
        };
        let _ = metrics_client.counter(GOAL_CREATED_METRIC, /*inc*/ 1, &[]);
    }

    /// 记录 goal 恢复事件（counter +1）。
    pub(crate) fn record_resumed(&self) {
        let Some(metrics_client) = self.metrics_client.as_ref() else {
            return;
        };
        let _ = metrics_client.counter(GOAL_RESUMED_METRIC, /*inc*/ 1, &[]);
    }

    /// 当 goal 从非活跃态转为 Active 时记录恢复事件。
    ///
    /// 仅当 `goal_status` 为 Active 且 `previous_status` 为
    /// Paused/Blocked/UsageLimited 之一时才记录。
    pub(crate) fn record_resumed_if_status_changed(
        &self,
        previous_status: Option<codex_state::ThreadGoalStatus>,
        goal_status: codex_state::ThreadGoalStatus,
    ) {
        if goal_status == codex_state::ThreadGoalStatus::Active
            && matches!(
                previous_status,
                Some(
                    codex_state::ThreadGoalStatus::Paused
                        | codex_state::ThreadGoalStatus::Blocked
                        | codex_state::ThreadGoalStatus::UsageLimited
                )
            )
        {
            self.record_resumed();
        }
    }

    /// 当 goal 进入终态时记录相关指标。
    ///
    /// 仅当 `previous_status` 与 `goal.status` 不同时才记录。
    /// 根据 `goal.status` 选择对应的 counter：
    /// - Blocked → goal_blocked
    /// - UsageLimited → goal_usage_limited
    /// - BudgetLimited → goal_budget_limited
    /// - Complete → goal_completed
    /// - Active/Paused → 不记录（非终态）
    ///
    /// 同时记录 token 用量与耗时的 histogram，按 status 打标。
    pub(crate) fn record_terminal_if_status_changed(
        &self,
        previous_status: Option<codex_state::ThreadGoalStatus>,
        goal: &codex_state::ThreadGoal,
    ) {
        if previous_status == Some(goal.status) {
            return;
        }

        let counter = match goal.status {
            codex_state::ThreadGoalStatus::Blocked => GOAL_BLOCKED_METRIC,
            codex_state::ThreadGoalStatus::UsageLimited => GOAL_USAGE_LIMITED_METRIC,
            codex_state::ThreadGoalStatus::BudgetLimited => GOAL_BUDGET_LIMITED_METRIC,
            codex_state::ThreadGoalStatus::Complete => GOAL_COMPLETED_METRIC,
            codex_state::ThreadGoalStatus::Active | codex_state::ThreadGoalStatus::Paused => {
                return;
            }
        };
        let Some(metrics_client) = self.metrics_client.as_ref() else {
            return;
        };
        let status_tag = [("status", goal.status.as_str())];
        let _ = metrics_client.counter(counter, /*inc*/ 1, &[]);
        let _ = metrics_client.histogram(GOAL_TOKEN_COUNT_METRIC, goal.tokens_used, &status_tag);
        let _ = metrics_client.histogram(
            GOAL_DURATION_SECONDS_METRIC,
            goal.time_used_seconds,
            &status_tag,
        );
    }
}
