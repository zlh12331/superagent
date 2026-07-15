//! Goal runtime handle 模块。
//!
//! 该模块实现 [`GoalRuntimeHandle`]，每个 thread 持有一个独立的 runtime
//! handle，负责：
//!
//! - 接收外部 goal 变更（set/clear）并应用 runtime 副作用
//! - 在 turn 错误时停止活跃 goal
//! - 在 idle 状态下自动 continuation（推进活跃 goal）
//! - 结算 turn/idle 进度并持久化到 state DB
//! - 注入 steering prompt 到活跃 turn
//!
//! ## 并发模型
//!
//! `goal_state_lock` 信号量（permits = 1）用于串行化以下临界区：
//! - stop_active_goal_for_turn：结算 + 状态更新
//! - continue_if_idle：读取 goal + 启动 continuation
//!
//! 防止外部 goal 变更与 idle continuation 在状态变更过程中读取中间状态。

use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use codex_core::ThreadManager;
use codex_protocol::ThreadId;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::ThreadGoal;

use crate::accounting::BudgetLimitedGoalDisposition;
use crate::accounting::GoalAccountingState;
use crate::analytics::GoalAnalytics;
use crate::analytics::GoalEventAttribution;
use crate::events::GoalEventEmitter;
use crate::metrics::GoalMetrics;
use crate::steering::continuation_steering_item;
use crate::steering::objective_updated_steering_item;
use crate::tool::protocol_goal_from_state;
use tokio::sync::Semaphore;
use tokio::sync::SemaphorePermit;

/// Goal runtime handle，每 thread 一个。
///
/// 通过 `Arc<GoalRuntimeInner>` 共享内部状态，clone 开销低。
#[derive(Clone)]
pub struct GoalRuntimeHandle {
    inner: Arc<GoalRuntimeInner>,
}

/// Goal runtime 配置，在构造 handle 时传入。
pub(crate) struct GoalRuntimeConfig {
    /// 遥测客户端
    pub(crate) analytics: GoalAnalytics,
    /// 是否启用 goal 功能
    pub(crate) enabled: bool,
    /// 该 thread 是否可见 goal 工具
    pub(crate) tools_available_for_thread: bool,
}

/// 活跃 goal 停止原因。
pub(crate) enum ActiveGoalStopReason {
    /// turn 因错误终止（非 usage limit）
    TurnError,
    /// 达到 usage limit
    UsageLimit,
}

/// Goal runtime 内部状态。
struct GoalRuntimeInner {
    /// 所属 thread ID
    thread_id: ThreadId,
    /// state DB runtime
    state_dbs: Arc<codex_state::StateRuntime>,
    /// 遥测客户端
    analytics: GoalAnalytics,
    /// 事件发射器
    event_emitter: GoalEventEmitter,
    /// 指标记录器
    metrics: GoalMetrics,
    /// thread manager 弱引用
    thread_manager: Weak<ThreadManager>,
    /// 计费状态机
    accounting_state: Arc<GoalAccountingState>,
    /// 是否启用 goal 功能（原子变量，支持运行时切换）
    enabled: AtomicBool,
    /// 该 thread 是否可见 goal 工具
    tools_available_for_thread: bool,
    /// goal 状态锁，串行化 stop/continuation 临界区
    goal_state_lock: Semaphore,
}

/// 一次进度结算的结果。
pub(crate) struct AccountedGoalProgress {
    /// 结算后的协议层 goal 对象
    pub(crate) goal: ThreadGoal,
    /// 结算对应的 goal_id
    pub(crate) goal_id: String,
}

/// 变更前的 goal 快照，用于检测状态变更与 objective 变更。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviousGoalSnapshot {
    /// goal ID
    pub goal_id: String,
    /// 变更前状态
    pub status: codex_state::ThreadGoalStatus,
    /// 变更前 objective
    pub objective: String,
}

impl From<&codex_state::ThreadGoal> for PreviousGoalSnapshot {
    fn from(goal: &codex_state::ThreadGoal) -> Self {
        Self {
            goal_id: goal.goal_id.clone(),
            status: goal.status,
            objective: goal.objective.clone(),
        }
    }
}

impl std::fmt::Debug for GoalRuntimeHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoalRuntimeHandle").finish_non_exhaustive()
    }
}

impl GoalRuntimeHandle {
    /// 创建一个新的 `GoalRuntimeHandle`。
    pub(crate) fn new(
        thread_id: ThreadId,
        state_dbs: Arc<codex_state::StateRuntime>,
        event_emitter: GoalEventEmitter,
        metrics: GoalMetrics,
        thread_manager: Weak<ThreadManager>,
        accounting_state: Arc<GoalAccountingState>,
        config: GoalRuntimeConfig,
    ) -> Self {
        Self {
            inner: Arc::new(GoalRuntimeInner {
                thread_id,
                state_dbs,
                analytics: config.analytics,
                event_emitter,
                metrics,
                thread_manager,
                accounting_state,
                enabled: AtomicBool::new(config.enabled),
                tools_available_for_thread: config.tools_available_for_thread,
                // 单许可信号量，串行化 goal 状态变更临界区
                goal_state_lock: Semaphore::new(/*permits*/ 1),
            }),
        }
    }

    /// 设置 goal 功能启用状态。
    pub(crate) fn set_enabled(&self, enabled: bool) {
        self.inner.enabled.store(enabled, Ordering::Relaxed);
    }

    /// 返回 goal 功能是否启用。
    pub(crate) fn is_enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::Relaxed)
    }

    /// 返回 goal 工具是否对当前 thread 可见。
    ///
    /// 需同时满足：goal 功能启用 + 该 thread 工具可用。
    pub(crate) fn tools_visible(&self) -> bool {
        self.is_enabled() && self.inner.tools_available_for_thread
    }

    /// 返回所属 thread ID。
    pub(crate) fn thread_id(&self) -> ThreadId {
        self.inner.thread_id
    }

    /// 返回计费状态机的强引用。
    pub(crate) fn accounting_state(&self) -> Arc<GoalAccountingState> {
        Arc::clone(&self.inner.accounting_state)
    }

    /// 获取 goal 状态锁许可。
    ///
    /// 用于在外部 goal 变更期间防止 idle continuation 干扰。
    pub(crate) async fn goal_state_permit(&self) -> Result<SemaphorePermit<'_>, String> {
        self.inner
            .goal_state_lock
            .acquire()
            .await
            .map_err(|err| err.to_string())
    }

    /// 准备外部 goal 变更。
    ///
    /// 在外部（非 tool call）修改 goal 之前调用，结算当前进度以避免
    /// 遗漏计费。根据是否有活跃 turn 选择 turn/idle 结算路径。
    pub async fn prepare_external_goal_mutation(&self) -> Result<(), String> {
        if !self.is_enabled() {
            return Ok(());
        }

        if let Some(turn_id) = self.inner.accounting_state.current_turn_id() {
            self.account_active_goal_progress(
                turn_id.as_str(),
                &format!("{turn_id}:external-goal-mutation"),
                codex_state::GoalAccountingMode::ActiveOnly,
                BudgetLimitedGoalDisposition::ClearActive,
            )
            .await?;
            return Ok(());
        }

        self.account_idle_goal_progress(
            &format!("{}:external-goal-mutation", self.inner.thread_id),
            codex_state::GoalAccountingMode::ActiveOnly,
            BudgetLimitedGoalDisposition::ClearActive,
        )
        .await?;
        Ok(())
    }

    /// 应用外部 goal 设置的 runtime 副作用。
    ///
    /// 在 goal 写入 state DB 成功后调用，根据新状态执行相应操作：
    /// - Active：绑定到 turn/idle，若 objective 变更则注入 steering，触发 continuation
    /// - BudgetLimited：若无活跃 turn 则清除活跃 goal
    /// - 其他终态：清除活跃 goal
    pub async fn apply_external_goal_set(
        &self,
        goal: codex_state::ThreadGoal,
        previous_goal: Option<PreviousGoalSnapshot>,
    ) -> Result<(), String> {
        if !self.is_enabled() {
            return Ok(());
        }

        // 判断是替换现有 goal 还是新建 goal
        let replaced_existing_goal = previous_goal
            .as_ref()
            .is_some_and(|previous_goal| previous_goal.goal_id != goal.goal_id);
        if previous_goal.is_none() || replaced_existing_goal {
            self.inner.metrics.record_created();
            self.inner
                .analytics
                .created(&goal, GoalEventAttribution::NoTurn);
        }
        let previous_status = previous_goal
            .as_ref()
            .and_then(|previous_goal| (!replaced_existing_goal).then_some(previous_goal.status));
        self.inner
            .metrics
            .record_resumed_if_status_changed(previous_status, goal.status);
        self.inner
            .metrics
            .record_terminal_if_status_changed(previous_status, &goal);
        self.inner
            .analytics
            .status_changed(&goal, previous_status, GoalEventAttribution::NoTurn);
        // 判断 objective 是否变更（仅在非替换场景下有意义）
        let objective_changed = previous_goal.as_ref().is_some_and(|previous_goal| {
            !replaced_existing_goal && previous_goal.objective != goal.objective
        });
        match goal.status {
            codex_state::ThreadGoalStatus::Active => {
                // 绑定到当前 turn 或 idle
                if self.inner.accounting_state.current_turn_id().is_some() {
                    let _ = self
                        .inner
                        .accounting_state
                        .mark_current_turn_goal_active(goal.goal_id.clone());
                } else {
                    self.inner
                        .accounting_state
                        .mark_idle_goal_active(goal.goal_id.clone());
                }
                if objective_changed {
                    let item = objective_updated_steering_item(&protocol_goal_from_state(goal));
                    self.inject_active_turn_steering(item).await;
                }
                self.continue_if_idle().await?;
            }
            codex_state::ThreadGoalStatus::BudgetLimited => {
                // BudgetLimited 且无活跃 turn：清除活跃 goal
                if self.inner.accounting_state.current_turn_id().is_none() {
                    self.inner.accounting_state.clear_active_goal();
                }
            }
            codex_state::ThreadGoalStatus::Paused
            | codex_state::ThreadGoalStatus::Blocked
            | codex_state::ThreadGoalStatus::UsageLimited
            | codex_state::ThreadGoalStatus::Complete => {
                self.inner.accounting_state.clear_active_goal();
            }
        }
        Ok(())
    }

    /// 应用外部 goal 清除的 runtime 副作用。
    pub async fn apply_external_goal_clear(
        &self,
        goal: codex_state::ThreadGoal,
    ) -> Result<(), String> {
        if !self.is_enabled() {
            return Ok(());
        }

        self.inner.analytics.cleared(&goal);
        self.inner.accounting_state.clear_active_goal();
        Ok(())
    }

    /// 因 usage limit 停止当前 turn 的活跃 goal。
    pub async fn usage_limit_active_goal_for_turn(&self, turn_id: &str) -> Result<(), String> {
        self.stop_active_goal_for_turn(turn_id, ActiveGoalStopReason::UsageLimit)
            .await
    }

    /// 结算当前 turn 并在终态错误后停止其活跃 goal。
    ///
    /// 持有 `goal_state_permit` 贯穿结算与状态更新，防止外部 goal 变更
    /// 与 idle continuation 在中间状态交错。
    pub(crate) async fn stop_active_goal_for_turn(
        &self,
        turn_id: &str,
        reason: ActiveGoalStopReason,
    ) -> Result<(), String> {
        if !self.is_enabled() {
            return Ok(());
        }

        // 持有 permit 直到结算与状态更新完成，防止外部 goal 变更
        // 与 idle continuation 在中间状态交错
        let _goal_state_permit = self.goal_state_permit().await?;
        if !self
            .inner
            .accounting_state
            .turn_is_current_active_goal(turn_id)
        {
            return Ok(());
        }

        let (event_name, status) = match reason {
            ActiveGoalStopReason::TurnError => {
                ("turn-error", codex_state::ThreadGoalStatus::Blocked)
            }
            ActiveGoalStopReason::UsageLimit => {
                ("usage-limit", codex_state::ThreadGoalStatus::UsageLimited)
            }
        };
        self.account_active_goal_progress(
            turn_id,
            &format!("{turn_id}:{event_name}-progress"),
            codex_state::GoalAccountingMode::ActiveOnly,
            BudgetLimitedGoalDisposition::ClearActive,
        )
        .await?;

        let Some(active_goal) = self
            .inner
            .state_dbs
            .thread_goals()
            .get_thread_goal(self.thread_id())
            .await
            .map_err(|err| err.to_string())?
        else {
            self.inner.accounting_state.clear_active_goal();
            return Ok(());
        };
        // 判断是否可以停止：Active 总是可停；BudgetLimited 仅在转为 UsageLimited 时可停
        let can_stop = active_goal.status == codex_state::ThreadGoalStatus::Active
            || (active_goal.status == codex_state::ThreadGoalStatus::BudgetLimited
                && status == codex_state::ThreadGoalStatus::UsageLimited);
        if !can_stop {
            self.inner.accounting_state.clear_active_goal();
            return Ok(());
        }
        let previous_status = Some(active_goal.status);
        let Some(goal) = self
            .inner
            .state_dbs
            .thread_goals()
            .update_thread_goal(
                self.thread_id(),
                codex_state::GoalUpdate {
                    objective: None,
                    status: Some(status),
                    token_budget: None,
                    expected_goal_id: Some(active_goal.goal_id),
                },
            )
            .await
            .map_err(|err| err.to_string())?
        else {
            return Ok(());
        };
        self.inner
            .metrics
            .record_terminal_if_status_changed(previous_status, &goal);
        self.inner.analytics.status_changed(
            &goal,
            previous_status,
            GoalEventAttribution::Turn(turn_id),
        );
        self.inner.accounting_state.clear_active_goal();
        let goal = protocol_goal_from_state(goal);
        self.inner.event_emitter.thread_goal_updated(
            format!("{turn_id}:{event_name}"),
            Some(turn_id.to_string()),
            goal,
        );
        Ok(())
    }

    /// thread 恢复后还原 runtime 状态。
    ///
    /// 若 goal 仍为 Active，重新标记为 idle 活跃并记录恢复指标；
    /// 否则清除活跃 goal。
    pub async fn restore_after_resume(&self) -> Result<(), String> {
        if !self.is_enabled() {
            return Ok(());
        }

        let goal = self
            .inner
            .state_dbs
            .thread_goals()
            .get_thread_goal(self.thread_id())
            .await
            .map_err(|err| err.to_string())?;
        match goal {
            Some(goal) if goal.status == codex_state::ThreadGoalStatus::Active => {
                self.inner
                    .accounting_state
                    .mark_idle_goal_active(goal.goal_id);
                self.inner.metrics.record_resumed();
            }
            Some(_) | None => self.inner.accounting_state.clear_active_goal(),
        }
        Ok(())
    }

    /// 在 idle 状态下尝试启动 continuation 推进活跃 goal。
    ///
    /// 持有 `goal_state_permit` 贯穿读取 goal 与启动 continuation，
    /// 防止外部 set/clear 在读取后、启动前变更 goal 状态。
    pub(crate) async fn continue_if_idle(&self) -> Result<(), String> {
        if !self.tools_visible() {
            self.inner.accounting_state.clear_active_goal();
            return Ok(());
        }
        // 持有 permit 直到 continuation 启动完成，防止外部 set/clear
        // 在读取 goal 后、启动 continuation 前变更 goal 状态
        let _goal_state_permit = self.goal_state_permit().await?;

        let Some(thread_manager) = self.inner.thread_manager.upgrade() else {
            tracing::debug!("skipping goal continuation because thread manager is unavailable");
            return Ok(());
        };
        let Ok(thread) = thread_manager.get_thread(self.inner.thread_id).await else {
            tracing::debug!("skipping goal continuation because live thread is unavailable");
            return Ok(());
        };

        let Some(goal) = self
            .inner
            .state_dbs
            .thread_goals()
            .get_thread_goal(self.thread_id())
            .await
            .map_err(|err| err.to_string())?
        else {
            self.inner.accounting_state.clear_active_goal();
            return Ok(());
        };
        if goal.status != codex_state::ThreadGoalStatus::Active {
            self.inner.accounting_state.clear_active_goal();
            return Ok(());
        }
        let item = continuation_steering_item(&protocol_goal_from_state(goal));

        if let Err(err) = thread.try_start_turn_if_idle(vec![item]).await {
            let reason = err.reason();
            tracing::debug!(
                ?reason,
                "skipping goal continuation because automatic idle work was rejected"
            );
        }

        // 若 continuation 启动失败，清除活跃 goal 避免重复尝试
        let current_turn_is_goal_active = self
            .inner
            .accounting_state
            .current_turn_id()
            .is_some_and(|turn_id| {
                self.inner
                    .accounting_state
                    .turn_is_current_active_goal(turn_id.as_str())
            });
        if !current_turn_is_goal_active {
            self.inner.accounting_state.clear_active_goal();
        }
        Ok(())
    }

    /// 向活跃 turn 注入 steering prompt。
    ///
    /// 若 thread manager 不可用或无活跃 turn，则跳过。
    pub(crate) async fn inject_active_turn_steering(&self, item: ResponseItem) {
        let Some(thread_manager) = self.inner.thread_manager.upgrade() else {
            tracing::debug!("skipping goal steering because thread manager is unavailable");
            return;
        };
        let Ok(thread) = thread_manager.get_thread(self.inner.thread_id).await else {
            tracing::debug!("skipping goal steering because live thread is unavailable");
            return;
        };
        if thread.inject_if_running(vec![item]).await.is_err() {
            tracing::debug!("skipping goal steering because no turn is active");
        }
    }

    /// 结算当前 turn 的活跃 goal 进度并持久化到 state DB。
    ///
    /// 流程：
    /// 1. 获取 `progress_accounting_permit` 串行化结算
    /// 2. 生成进度快照
    /// 3. 调用 state DB 的 `account_thread_goal_usage` 入库
    /// 4. 根据结果更新 metrics/analytics/事件
    pub(crate) async fn account_active_goal_progress(
        &self,
        turn_id: &str,
        event_id: &str,
        mode: codex_state::GoalAccountingMode,
        budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
    ) -> Result<Option<AccountedGoalProgress>, String> {
        let accounting = self.accounting_state();
        let _accounting_permit = accounting
            .progress_accounting_permit()
            .await
            .map_err(|err| err.to_string())?;
        let Some(snapshot) = accounting.progress_snapshot(turn_id) else {
            return Ok(None);
        };
        let previous_status = self
            .current_goal_status_for_metrics(Some(snapshot.expected_goal_id.as_str()))
            .await?;
        let outcome = self
            .inner
            .state_dbs
            .thread_goals()
            .account_thread_goal_usage(
                self.thread_id(),
                snapshot.time_delta_seconds,
                snapshot.token_delta,
                mode,
                Some(snapshot.expected_goal_id.as_str()),
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(match outcome {
            codex_state::GoalAccountingOutcome::Updated(goal) => {
                let goal_id = goal.goal_id.clone();
                self.inner
                    .metrics
                    .record_terminal_if_status_changed(previous_status, &goal);
                self.inner
                    .analytics
                    .usage_accounted(&goal, GoalEventAttribution::Turn(turn_id));
                self.inner.analytics.status_changed(
                    &goal,
                    previous_status,
                    GoalEventAttribution::Turn(turn_id),
                );
                accounting.mark_progress_accounted_for_status(
                    turn_id,
                    &snapshot,
                    goal.status,
                    budget_limited_goal_disposition,
                );
                let goal = protocol_goal_from_state(goal);
                self.inner.event_emitter.thread_goal_updated(
                    event_id.to_string(),
                    Some(turn_id.to_string()),
                    goal.clone(),
                );
                Some(AccountedGoalProgress { goal, goal_id })
            }
            codex_state::GoalAccountingOutcome::Unchanged(_) => None,
        })
    }

    /// 结算 idle 状态下的 goal 进度（仅时间增量）。
    ///
    /// 与 `account_active_goal_progress` 类似，但：
    /// - 使用 idle 进度快照（无 token 增量）
    /// - 事件归因为 `NoTurn`
    /// - Unchanged 时重置 idle 基线并清除活跃 goal
    async fn account_idle_goal_progress(
        &self,
        event_id: &str,
        mode: codex_state::GoalAccountingMode,
        budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
    ) -> Result<Option<AccountedGoalProgress>, String> {
        let accounting = self.accounting_state();
        let _accounting_permit = accounting
            .progress_accounting_permit()
            .await
            .map_err(|err| err.to_string())?;
        let Some(snapshot) = accounting.idle_progress_snapshot() else {
            return Ok(None);
        };
        let previous_status = self
            .current_goal_status_for_metrics(Some(snapshot.expected_goal_id.as_str()))
            .await?;
        let outcome = self
            .inner
            .state_dbs
            .thread_goals()
            .account_thread_goal_usage(
                self.thread_id(),
                snapshot.time_delta_seconds,
                /*token_delta*/ 0,
                mode,
                Some(snapshot.expected_goal_id.as_str()),
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(match outcome {
            codex_state::GoalAccountingOutcome::Updated(goal) => {
                let goal_id = goal.goal_id.clone();
                self.inner
                    .metrics
                    .record_terminal_if_status_changed(previous_status, &goal);
                self.inner
                    .analytics
                    .usage_accounted(&goal, GoalEventAttribution::NoTurn);
                self.inner.analytics.status_changed(
                    &goal,
                    previous_status,
                    GoalEventAttribution::NoTurn,
                );
                accounting.mark_idle_progress_accounted_for_status(
                    &snapshot,
                    goal.status,
                    budget_limited_goal_disposition,
                );
                let goal = protocol_goal_from_state(goal);
                self.inner.event_emitter.thread_goal_updated(
                    event_id.to_string(),
                    /*turn_id*/ None,
                    goal.clone(),
                );
                Some(AccountedGoalProgress { goal, goal_id })
            }
            codex_state::GoalAccountingOutcome::Unchanged(_) => {
                accounting.reset_idle_progress_baseline_and_clear_active_goal();
                None
            }
        })
    }

    /// 读取当前 goal 状态用于 metrics 比对。
    ///
    /// `expected_goal_id` 用于乐观并发控制：若 goal_id 不匹配则返回 `None`。
    async fn current_goal_status_for_metrics(
        &self,
        expected_goal_id: Option<&str>,
    ) -> Result<Option<codex_state::ThreadGoalStatus>, String> {
        let goal = self
            .inner
            .state_dbs
            .thread_goals()
            .get_thread_goal(self.thread_id())
            .await
            .map_err(|err| err.to_string())?;
        Ok(goal.and_then(|goal| {
            expected_goal_id
                .is_none_or(|expected_goal_id| goal.goal_id == expected_goal_id)
                .then_some(goal.status)
        }))
    }
}
