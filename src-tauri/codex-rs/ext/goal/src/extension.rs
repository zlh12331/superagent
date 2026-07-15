//! Goal extension 主实现模块。
//!
//! 该模块实现 [`GoalExtension`]，通过实现多个 contributor trait
//! 将 goal 功能集成到 codex 的生命周期中：
//!
//! - [`ThreadLifecycleContributor`]：thread 启动/恢复/idle/停止时管理 runtime
//! - [`ConfigContributor`]：配置变更时启停 goal 功能
//! - [`TurnLifecycleContributor`]：turn 启动/停止/中止/错误时进行计费
//! - [`TokenUsageContributor`]：接收 token 用量更新
//! - [`ToolLifecycleContributor`]：工具完成后结算进度并注入 steering
//! - [`ToolContributor`]：向模型暴露 get/create/update goal 工具

use std::sync::Arc;
use std::sync::Weak;

use codex_analytics::AnalyticsEventsClient;
use codex_core::ThreadManager;
use codex_extension_api::ConfigContributor;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionEventSink;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::ThreadIdleInput;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadResumeInput;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::ThreadStopInput;
use codex_extension_api::TokenUsageContributor;
use codex_extension_api::ToolCallOutcome;
use codex_extension_api::ToolContributor;
use codex_extension_api::ToolFinishInput;
use codex_extension_api::ToolLifecycleContributor;
use codex_extension_api::ToolLifecycleFuture;
use codex_extension_api::TurnAbortInput;
use codex_extension_api::TurnErrorInput;
use codex_extension_api::TurnLifecycleContributor;
use codex_extension_api::TurnStartInput;
use codex_extension_api::TurnStopInput;
use codex_otel::MetricsClient;
use codex_protocol::ThreadId;
use codex_protocol::protocol::CodexErrorInfo;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::protocol::ThreadGoalStatus;
use codex_protocol::protocol::TokenUsageInfo;

use crate::accounting::BudgetLimitedGoalDisposition;
use crate::accounting::GoalAccountingState;
use crate::analytics::GoalAnalytics;
use crate::api::GoalService;
use crate::events::GoalEventEmitter;
use crate::metrics::GoalMetrics;
use crate::runtime::ActiveGoalStopReason;
use crate::runtime::GoalRuntimeConfig;
use crate::runtime::GoalRuntimeHandle;
use crate::spec::UPDATE_GOAL_TOOL_NAME;
use crate::steering::budget_limit_steering_item;
use crate::tool::GoalToolExecutor;

/// Goal extension 配置，记录当前 thread 是否启用 goal 功能。
#[derive(Clone, Debug)]
pub struct GoalExtensionConfig {
    /// 是否启用 goal 功能
    pub enabled: bool,
}

impl GoalExtensionConfig {
    /// 从布尔值构造配置。
    fn from_enabled(enabled: bool) -> Self {
        Self { enabled }
    }
}

/// Goal extension 主结构。
///
/// 泛型 `C` 为用户配置类型，通过 `goals_enabled` 闭包判断某配置是否启用 goal。
#[derive(Clone)]
pub struct GoalExtension<C> {
    /// state DB runtime（用于持久化 goal）
    state_dbs: Arc<codex_state::StateRuntime>,
    /// 遥测客户端
    analytics: GoalAnalytics,
    /// 事件发射器
    event_emitter: GoalEventEmitter,
    /// 指标记录器
    metrics: GoalMetrics,
    /// thread manager 弱引用（用于 idle continuation）
    thread_manager: Weak<ThreadManager>,
    /// goal service 引用
    goal_service: Arc<GoalService>,
    /// 判断配置是否启用 goal 的闭包
    goals_enabled: Arc<dyn Fn(&C) -> bool + Send + Sync>,
}

impl<C> std::fmt::Debug for GoalExtension<C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoalExtension").finish_non_exhaustive()
    }
}

impl<C> GoalExtension<C> {
    /// 使用 host capabilities 构造 `GoalExtension`。
    pub(crate) fn new_with_host_capabilities(
        state_dbs: Arc<codex_state::StateRuntime>,
        analytics_events_client: AnalyticsEventsClient,
        event_sink: Arc<dyn ExtensionEventSink>,
        metrics_client: Option<MetricsClient>,
        thread_manager: Weak<ThreadManager>,
        goal_service: Arc<GoalService>,
        goals_enabled: impl Fn(&C) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            state_dbs,
            analytics: GoalAnalytics::new(analytics_events_client),
            event_emitter: GoalEventEmitter::new(event_sink),
            metrics: GoalMetrics::new(metrics_client),
            thread_manager,
            goal_service,
            goals_enabled: Arc::new(goals_enabled),
        }
    }
}

impl<C> ThreadLifecycleContributor<C> for GoalExtension<C>
where
    C: Send + Sync + 'static,
{
    /// thread 启动时：根据配置初始化 runtime handle 并注册到 service。
    fn on_thread_start<'a>(&'a self, input: ThreadStartInput<'a, C>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let enabled = (self.goals_enabled)(input.config);
            // 工具可用性：需要 persistent thread state 且非 Review subagent
            let tools_available_for_thread = input.persistent_thread_state_available
                && !matches!(
                    input.session_source,
                    SessionSource::SubAgent(SubAgentSource::Review)
                );
            input
                .thread_store
                .insert(GoalExtensionConfig::from_enabled(enabled));
            let accounting_state = input
                .thread_store
                .get_or_init::<GoalAccountingState>(GoalAccountingState::default);
            let Ok(thread_id) = ThreadId::from_string(input.thread_store.level_id()) else {
                return;
            };
            let runtime = input.thread_store.get_or_init::<GoalRuntimeHandle>(|| {
                GoalRuntimeHandle::new(
                    thread_id,
                    Arc::clone(&self.state_dbs),
                    self.event_emitter.clone(),
                    self.metrics.clone(),
                    self.thread_manager.clone(),
                    accounting_state,
                    GoalRuntimeConfig {
                        analytics: self.analytics.clone(),
                        enabled,
                        tools_available_for_thread,
                    },
                )
            });
            runtime.set_enabled(enabled);
            self.goal_service.register_runtime(&runtime);
        })
    }

    /// thread 恢复时：恢复 runtime 状态（如 idle goal 重新激活）。
    fn on_thread_resume<'a>(&'a self, input: ThreadResumeInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(runtime) = goal_runtime_handle(input.thread_store) else {
                return;
            };

            if let Err(err) = runtime.restore_after_resume().await {
                tracing::warn!(
                    "failed to restore goal runtime after thread resume for {}: {err}",
                    runtime.thread_id()
                );
            }
        })
    }

    /// thread idle 时：尝试启动 idle continuation（自动推进活跃 goal）。
    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(runtime) = goal_runtime_handle(input.thread_store) else {
                return;
            };

            if let Err(err) = runtime.continue_if_idle().await {
                tracing::warn!(
                    "failed to continue active goal for idle thread {}: {err}",
                    runtime.thread_id()
                );
            }
        })
    }

    /// thread 停止时：从 service 注销 runtime。
    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(runtime) = goal_runtime_handle(input.thread_store) {
                self.goal_service.unregister_runtime(&runtime);
            }
        })
    }
}

impl<C> ConfigContributor<C> for GoalExtension<C>
where
    C: Send + Sync + 'static,
{
    /// 配置变更时：根据新配置启停 goal 功能。
    fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &C,
        new_config: &C,
    ) {
        let enabled = (self.goals_enabled)(new_config);
        thread_store.insert(GoalExtensionConfig::from_enabled(enabled));
        if let Some(runtime) = goal_runtime_handle(thread_store) {
            runtime.set_enabled(enabled);
        }
    }
}

impl<C> TurnLifecycleContributor for GoalExtension<C>
where
    C: Send + Sync + 'static,
{
    /// turn 启动时：初始化 turn 计费记录，并在已有活跃 goal 时绑定。
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(runtime) = goal_runtime_handle(input.thread_store) else {
                return;
            };
            if !runtime.is_enabled() {
                return;
            }

            let accounting = runtime.accounting_state();
            accounting.start_turn(
                input.turn_id,
                input.collaboration_mode.mode,
                input.token_usage_at_turn_start,
            );
            // Plan 模式不进行 goal 计费
            if matches!(
                input.collaboration_mode.mode,
                codex_protocol::config_types::ModeKind::Plan
            ) {
                accounting.clear_current_turn_goal();
                return;
            }
            let Ok(goal) = self
                .state_dbs
                .thread_goals()
                .get_thread_goal(runtime.thread_id())
                .await
            else {
                return;
            };
            // 仅在 goal 处于 Active 或 BudgetLimited 时绑定到当前 turn
            if let Some(goal) = goal
                && matches!(
                    goal.status,
                    codex_state::ThreadGoalStatus::Active
                        | codex_state::ThreadGoalStatus::BudgetLimited
                )
            {
                accounting.mark_turn_goal_active(input.turn_id, goal.goal_id);
            }
        })
    }

    /// turn 正常停止时：结算当前 turn 的进度并清理计费记录。
    fn on_turn_stop<'a>(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(runtime) = goal_runtime_handle(input.thread_store) else {
                return;
            };
            if !runtime.is_enabled() {
                return;
            }

            let turn_id = input.turn_store.level_id();
            if let Err(err) = runtime
                .account_active_goal_progress(
                    turn_id,
                    &format!("{turn_id}:turn-stop"),
                    codex_state::GoalAccountingMode::ActiveOnly,
                    BudgetLimitedGoalDisposition::ClearActive,
                )
                .await
            {
                tracing::warn!(
                    "failed to account active goal progress at turn stop for {turn_id}: {err}"
                );
                return;
            }
            runtime.accounting_state().finish_turn(turn_id);
        })
    }

    /// turn 中止时：结算进度并清理计费记录。
    fn on_turn_abort<'a>(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(runtime) = goal_runtime_handle(input.thread_store) else {
                return;
            };
            if !runtime.is_enabled() {
                return;
            }

            let turn_id = input.turn_store.level_id();
            if let Err(err) = runtime
                .account_active_goal_progress(
                    turn_id,
                    &format!("{turn_id}:turn-abort"),
                    codex_state::GoalAccountingMode::ActiveOnly,
                    BudgetLimitedGoalDisposition::ClearActive,
                )
                .await
            {
                tracing::warn!(
                    "failed to account active goal progress after turn abort for {turn_id}: {err}"
                );
                return;
            }
            runtime.accounting_state().finish_turn(turn_id);
        })
    }

    /// turn 出错时：根据错误类型停止活跃 goal。
    ///
    /// - UsageLimitExceeded → UsageLimited 状态
    /// - 其他错误 → Blocked 状态（防止自动 continuation 死循环消耗 token）
    fn on_turn_error<'a>(&'a self, input: TurnErrorInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(runtime) = goal_runtime_handle(input.thread_store) else {
                return;
            };

            let reason = match input.error {
                CodexErrorInfo::UsageLimitExceeded => ActiveGoalStopReason::UsageLimit,
                // turn 因不可重试错误或重试耗尽而结束。将 goal 标记为 Blocked
                // 防止自动 continuation 死循环消耗 token（如 compaction 错误场景）
                _ => ActiveGoalStopReason::TurnError,
            };
            if let Err(err) = runtime
                .stop_active_goal_for_turn(input.turn_id, reason)
                .await
            {
                tracing::warn!(
                    error = ?input.error,
                    "failed to stop active goal after turn error: {err}"
                );
            }
        })
    }
}

impl<C> TokenUsageContributor for GoalExtension<C>
where
    C: Send + Sync + 'static,
{
    /// 接收 token 用量更新，记录到当前 turn 的计账中。
    fn on_token_usage<'a>(
        &'a self,
        _session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
        turn_store: &'a ExtensionData,
        token_usage: &'a TokenUsageInfo,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(runtime) = goal_runtime_handle(thread_store) else {
                return;
            };
            if !runtime.is_enabled() {
                return;
            }

            let Some(_recorded) = runtime
                .accounting_state()
                .record_token_usage(turn_store.level_id(), &token_usage.total_token_usage)
            else {
                return;
            };
        })
    }
}

impl<C> ToolLifecycleContributor for GoalExtension<C>
where
    C: Send + Sync + 'static,
{
    /// 工具完成后：结算 goal 进度，若进入 BudgetLimited 则注入 steering prompt。
    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            let Some(runtime) = goal_runtime_handle(input.thread_store) else {
                return;
            };
            // 判断该工具调用是否应计入 goal 进度
            let should_count_for_goal_progress = runtime.is_enabled()
                && tool_attempt_counts_for_goal_progress(input.outcome)
                && !(input.tool_name.namespace.is_none()
                    && input.tool_name.name == UPDATE_GOAL_TOOL_NAME);
            if !should_count_for_goal_progress {
                return;
            }
            let turn_id = input.turn_id;
            let progress = match runtime
                .account_active_goal_progress(
                    turn_id,
                    input.call_id,
                    codex_state::GoalAccountingMode::ActiveOnly,
                    // 工具完成后保留活跃 goal，让 turn 可以继续推进
                    BudgetLimitedGoalDisposition::KeepActive,
                )
                .await
            {
                Ok(Some(progress)) => progress,
                Ok(None) => return,
                Err(err) => {
                    tracing::warn!(
                        "failed to account active goal progress after tool finish for {turn_id}: {err}"
                    );
                    return;
                }
            };
            let goal = progress.goal;
            // 非 BudgetLimited 状态无需注入 steering
            if goal.status != ThreadGoalStatus::BudgetLimited {
                return;
            }
            // 仅在首次上报 BudgetLimited 时注入 steering，避免重复
            if !runtime
                .accounting_state()
                .mark_budget_limit_reported_if_new(progress.goal_id.as_str())
            {
                return;
            }
            let item = budget_limit_steering_item(&goal);
            runtime.inject_active_turn_steering(item).await;
        })
    }
}

impl<C> ToolContributor for GoalExtension<C>
where
    C: Send + Sync + 'static,
{
    /// 向模型暴露 goal 工具（get/create/update）。
    ///
    /// 若 runtime 不可用或工具不可见（如 Review subagent），返回空列表。
    fn tools(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn codex_extension_api::ToolExecutor<codex_extension_api::ToolCall>>> {
        let Some(runtime) = goal_runtime_handle(thread_store) else {
            return Vec::new();
        };
        if !runtime.tools_visible() {
            return Vec::new();
        }

        vec![
            Arc::new(GoalToolExecutor::get(
                runtime.thread_id(),
                Arc::clone(&self.state_dbs),
                runtime.accounting_state(),
                self.analytics.clone(),
                self.event_emitter.clone(),
                self.metrics.clone(),
            )),
            Arc::new(GoalToolExecutor::create(
                runtime.thread_id(),
                Arc::clone(&self.state_dbs),
                runtime.accounting_state(),
                self.analytics.clone(),
                self.event_emitter.clone(),
                self.metrics.clone(),
            )),
            Arc::new(GoalToolExecutor::update(
                runtime.thread_id(),
                Arc::clone(&self.state_dbs),
                runtime.accounting_state(),
                self.analytics.clone(),
                self.event_emitter.clone(),
                self.metrics.clone(),
            )),
        ]
    }
}

/// 安装 goal extension 到 registry。
///
/// 注册顺序：thread_lifecycle → config → turn_lifecycle → token_usage →
/// tool_lifecycle → tool_contributor。
pub fn install_with_backend<C>(
    registry: &mut ExtensionRegistryBuilder<C>,
    state_dbs: Arc<codex_state::StateRuntime>,
    analytics_events_client: AnalyticsEventsClient,
    metrics_client: Option<MetricsClient>,
    thread_manager: Weak<ThreadManager>,
    goal_service: Arc<GoalService>,
    goals_enabled: impl Fn(&C) -> bool + Send + Sync + 'static,
) where
    C: Send + Sync + 'static,
{
    let extension = Arc::new(GoalExtension::new_with_host_capabilities(
        state_dbs,
        analytics_events_client,
        registry.event_sink(),
        metrics_client,
        thread_manager,
        Arc::clone(&goal_service),
        goals_enabled,
    ));
    registry.thread_lifecycle_contributor(extension.clone());
    registry.config_contributor(extension.clone());
    registry.turn_lifecycle_contributor(extension.clone());
    registry.token_usage_contributor(extension.clone());
    registry.tool_lifecycle_contributor(extension.clone());
    registry.tool_contributor(extension);
}

/// 从 thread store 获取 runtime handle 的强引用。
fn goal_runtime_handle(thread_store: &ExtensionData) -> Option<Arc<GoalRuntimeHandle>> {
    thread_store.get::<GoalRuntimeHandle>()
}

/// 判断工具调用结果是否应计入 goal 进度。
///
/// - Completed：计入
/// - Failed（handler 已执行）：计入
/// - Blocked / Failed（handler 未执行）/ Aborted：不计入
fn tool_attempt_counts_for_goal_progress(outcome: ToolCallOutcome) -> bool {
    match outcome {
        ToolCallOutcome::Completed { .. } => true,
        ToolCallOutcome::Failed {
            handler_executed: true,
        } => true,
        ToolCallOutcome::Blocked
        | ToolCallOutcome::Failed {
            handler_executed: false,
        }
        | ToolCallOutcome::Aborted => false,
    }
}
