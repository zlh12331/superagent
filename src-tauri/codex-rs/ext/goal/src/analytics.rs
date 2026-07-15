//! Goal 遥测事件发射模块。
//!
//! 该模块封装 [`AnalyticsEventsClient`]，为 goal 生命周期中的关键事件
//! （创建、用量结算、状态变更、清理）提供统一的上报接口。
//!
//! ## 事件归因（Attribution）
//!
//! 每个事件都会标注其归因：是否发生在某个 turn 内（`Turn(turn_id)`），
//! 还是发生在没有活跃 turn 的 idle 状态下（`NoTurn`）。

use codex_analytics::AnalyticsEventsClient;
use codex_analytics::CodexGoalEvent;
use codex_analytics::GoalEventKind;

/// Goal 遥测客户端，封装 analytics events client。
#[derive(Clone)]
pub(crate) struct GoalAnalytics {
    client: AnalyticsEventsClient,
}

/// 事件归因，描述事件发生在 turn 内还是 idle 状态下。
pub(crate) enum GoalEventAttribution<'a> {
    /// 事件发生在指定 turn 内
    Turn(&'a str),
    /// 事件发生在没有活跃 turn 的 idle 状态下
    NoTurn,
}

impl GoalAnalytics {
    /// 创建一个新的 `GoalAnalytics` 实例。
    pub(crate) fn new(client: AnalyticsEventsClient) -> Self {
        Self { client }
    }

    /// 上报 goal 创建事件。
    pub(crate) fn created(
        &self,
        goal: &codex_state::ThreadGoal,
        attribution: GoalEventAttribution<'_>,
    ) {
        self.track(goal, attribution, GoalEventKind::Created);
    }

    /// 上报 goal 用量结算事件。
    ///
    /// 仅在该事件中携带累计的 token 与时间用量。
    pub(crate) fn usage_accounted(
        &self,
        goal: &codex_state::ThreadGoal,
        attribution: GoalEventAttribution<'_>,
    ) {
        self.track(goal, attribution, GoalEventKind::UsageAccounted);
    }

    /// 上报 goal 状态变更事件。
    ///
    /// 仅当 `previous_status` 与当前 `goal.status` 不同时才上报。
    pub(crate) fn status_changed(
        &self,
        goal: &codex_state::ThreadGoal,
        previous_status: Option<codex_state::ThreadGoalStatus>,
        attribution: GoalEventAttribution<'_>,
    ) {
        if previous_status.is_some_and(|status| status != goal.status) {
            self.track(goal, attribution, GoalEventKind::StatusChanged);
        }
    }

    /// 上报 goal 清理事件。
    pub(crate) fn cleared(&self, goal: &codex_state::ThreadGoal) {
        self.track(goal, GoalEventAttribution::NoTurn, GoalEventKind::Cleared);
    }

    /// 内部统一的事件上报实现。
    ///
    /// 仅 `UsageAccounted` 事件携带累计 token 与时间用量；
    /// 其他事件（Created/StatusChanged/Cleared）不携带累计值。
    fn track(
        &self,
        goal: &codex_state::ThreadGoal,
        attribution: GoalEventAttribution<'_>,
        event_kind: GoalEventKind,
    ) {
        let (cumulative_tokens_accounted, cumulative_time_accounted_seconds) = match event_kind {
            GoalEventKind::UsageAccounted => (Some(goal.tokens_used), Some(goal.time_used_seconds)),
            GoalEventKind::Created | GoalEventKind::StatusChanged | GoalEventKind::Cleared => {
                (None, None)
            }
        };
        self.client.track_goal_event(CodexGoalEvent {
            thread_id: goal.thread_id.to_string(),
            turn_id: match attribution {
                GoalEventAttribution::Turn(turn_id) => Some(turn_id.to_string()),
                GoalEventAttribution::NoTurn => None,
            },
            goal_id: goal.goal_id.clone(),
            event_kind,
            goal_status: goal.status,
            has_token_budget: goal.token_budget.is_some(),
            cumulative_tokens_accounted,
            cumulative_time_accounted_seconds,
        });
    }
}
