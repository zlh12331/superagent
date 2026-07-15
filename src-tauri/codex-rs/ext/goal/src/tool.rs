//! Goal 工具执行器模块。
//!
//! 该模块实现 [`GoalToolExecutor`]，处理来自模型的 get/create/update goal
//! 工具调用。每个工具变体对应一个 `GoalToolKind`，通过同一执行器实例分发。
//!
//! ## 工具流程
//!
//! - **get**：读取当前 thread 的 goal 并返回
//! - **create**：校验 objective 与 budget，插入新 goal，绑定到当前 turn，
//!   记录 metrics/analytics，发射事件
//! - **update**：仅允许标记 complete/blocked，结算当前进度，更新 goal 状态，
//!   记录 metrics/analytics，发射事件

use std::sync::Arc;

use codex_extension_api::FunctionCallError;
use codex_extension_api::JsonToolOutput;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolName;
use codex_extension_api::ToolOutput;
use codex_extension_api::ToolSpec;
use codex_protocol::ThreadId;
use codex_protocol::protocol::ThreadGoal;
use codex_protocol::protocol::ThreadGoalStatus;
use codex_protocol::protocol::validate_thread_goal_objective;
use serde::Deserialize;
use serde::Serialize;

use crate::accounting::BudgetLimitedGoalDisposition;
use crate::accounting::GoalAccountingState;
use crate::analytics::GoalAnalytics;
use crate::analytics::GoalEventAttribution;
use crate::events::GoalEventEmitter;
use crate::metrics::GoalMetrics;
use crate::spec::CREATE_GOAL_TOOL_NAME;
use crate::spec::GET_GOAL_TOOL_NAME;
use crate::spec::UPDATE_GOAL_TOOL_NAME;
use crate::spec::create_create_goal_tool;
use crate::spec::create_get_goal_tool;
use crate::spec::create_update_goal_tool;

/// Goal 工具执行器。
///
/// 通过 `kind` 字段区分 get/create/update 三种变体。
#[derive(Clone)]
pub(crate) struct GoalToolExecutor {
    /// 工具变体
    kind: GoalToolKind,
    /// 所属 thread ID
    thread_id: ThreadId,
    /// state DB runtime
    state_db: Arc<codex_state::StateRuntime>,
    /// 计费状态机
    accounting_state: Arc<GoalAccountingState>,
    /// 遥测客户端
    analytics: GoalAnalytics,
    /// 事件发射器
    event_emitter: GoalEventEmitter,
    /// 指标记录器
    metrics: GoalMetrics,
}

/// Goal 工具变体。
#[derive(Clone, Copy)]
enum GoalToolKind {
    /// `get_goal`：读取当前 goal
    Get,
    /// `create_goal`：创建新 goal
    Create,
    /// `update_goal`：更新 goal 状态
    Update,
}

/// `create_goal` 工具的请求参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CreateGoalRequest {
    /// goal 的具体目标
    pub objective: String,
    /// 可选的 token 预算
    pub token_budget: Option<i64>,
}

/// `update_goal` 工具的请求参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct UpdateGoalArgs {
    /// 目标状态（仅支持 complete/blocked）
    status: ThreadGoalStatus,
}

/// Goal 工具的统一响应结构。
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoalToolResponse {
    /// 当前 goal（如有）
    goal: Option<ThreadGoal>,
    /// 剩余 token 预算（如有）
    remaining_tokens: Option<i64>,
    /// 完成时的预算报告提示（仅 complete 状态包含）
    completion_budget_report: Option<String>,
}

/// 是否在响应中包含完成预算报告。
#[derive(Clone, Copy)]
enum CompletionBudgetReport {
    /// 包含
    Include,
    /// 不包含
    Omit,
}

impl GoalToolExecutor {
    /// 构造 `get_goal` 工具执行器。
    pub(crate) fn get(
        thread_id: ThreadId,
        state_db: Arc<codex_state::StateRuntime>,
        accounting_state: Arc<GoalAccountingState>,
        analytics: GoalAnalytics,
        event_emitter: GoalEventEmitter,
        metrics: GoalMetrics,
    ) -> Self {
        Self {
            kind: GoalToolKind::Get,
            thread_id,
            state_db,
            accounting_state,
            analytics,
            event_emitter,
            metrics,
        }
    }

    /// 构造 `create_goal` 工具执行器。
    pub(crate) fn create(
        thread_id: ThreadId,
        state_db: Arc<codex_state::StateRuntime>,
        accounting_state: Arc<GoalAccountingState>,
        analytics: GoalAnalytics,
        event_emitter: GoalEventEmitter,
        metrics: GoalMetrics,
    ) -> Self {
        Self {
            kind: GoalToolKind::Create,
            thread_id,
            state_db,
            accounting_state,
            analytics,
            event_emitter,
            metrics,
        }
    }

    /// 构造 `update_goal` 工具执行器。
    pub(crate) fn update(
        thread_id: ThreadId,
        state_db: Arc<codex_state::StateRuntime>,
        accounting_state: Arc<GoalAccountingState>,
        analytics: GoalAnalytics,
        event_emitter: GoalEventEmitter,
        metrics: GoalMetrics,
    ) -> Self {
        Self {
            kind: GoalToolKind::Update,
            thread_id,
            state_db,
            accounting_state,
            analytics,
            event_emitter,
            metrics,
        }
    }
}

impl ToolExecutor<ToolCall> for GoalToolExecutor {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(match self.kind {
            GoalToolKind::Get => GET_GOAL_TOOL_NAME,
            GoalToolKind::Create => CREATE_GOAL_TOOL_NAME,
            GoalToolKind::Update => UPDATE_GOAL_TOOL_NAME,
        })
    }

    fn spec(&self) -> ToolSpec {
        match self.kind {
            GoalToolKind::Get => create_get_goal_tool(),
            GoalToolKind::Create => create_create_goal_tool(),
            GoalToolKind::Update => create_update_goal_tool(),
        }
    }

    fn handle(&self, invocation: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_> {
        Box::pin(async move {
            match self.kind {
                GoalToolKind::Get => self.handle_get(invocation).await,
                GoalToolKind::Create => self.handle_create(invocation).await,
                GoalToolKind::Update => self.handle_update(invocation).await,
            }
        })
    }
}

impl GoalToolExecutor {
    /// 处理 `get_goal` 工具调用：读取当前 thread 的 goal。
    async fn handle_get(
        &self,
        invocation: ToolCall,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError> {
        let _ = invocation.function_arguments()?;
        let goal = self
            .state_db
            .thread_goals()
            .get_thread_goal(self.thread_id)
            .await
            .map(|goal| goal.map(protocol_goal_from_state))
            .map_err(|err| {
                FunctionCallError::RespondToModel(format!("failed to read goal: {err}"))
            })?;
        goal_response(goal, CompletionBudgetReport::Omit)
    }

    /// 处理 `create_goal` 工具调用：创建新 goal。
    ///
    /// 流程：
    /// 1. 解析并校验 objective 与 budget
    /// 2. 插入新 goal（状态为 Active）
    /// 3. 填充空 thread preview
    /// 4. 绑定到当前 turn
    /// 5. 记录 metrics/analytics
    /// 6. 发射 goal_updated 事件
    async fn handle_create(
        &self,
        invocation: ToolCall,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError> {
        let mut request: CreateGoalRequest = parse_arguments(invocation.function_arguments()?)?;
        // trim objective 避免前后空白影响校验
        request.objective = request.objective.trim().to_string();
        validate_thread_goal_objective(&request.objective)
            .map_err(FunctionCallError::RespondToModel)?;
        validate_goal_budget(request.token_budget).map_err(FunctionCallError::RespondToModel)?;

        let goal = self
            .state_db
            .thread_goals()
            .insert_thread_goal(
                self.thread_id,
                request.objective.as_str(),
                codex_state::ThreadGoalStatus::Active,
                request.token_budget,
            )
            .await
            .map_err(|err| FunctionCallError::RespondToModel(format!("failed to create goal: {err}")))?
            .ok_or_else(|| {
                FunctionCallError::RespondToModel(
                    "cannot create a new goal because this thread has an unfinished goal; complete the existing goal first"
                        .to_string(),
                )
            })?;
        fill_empty_thread_preview_if_possible(self.state_db.as_ref(), self.thread_id, &goal).await;
        let turn_id = self
            .accounting_state
            .mark_current_turn_goal_active(goal.goal_id.clone());
        self.metrics.record_created();
        self.analytics.created(
            &goal,
            GoalEventAttribution::Turn(invocation.turn_id.as_str()),
        );
        let goal = protocol_goal_from_state(goal);
        self.emit_goal_updated_from_tool_call(&invocation, turn_id, goal.clone());
        goal_response(Some(goal), CompletionBudgetReport::Omit)
    }

    /// 处理 `update_goal` 工具调用：更新 goal 状态。
    ///
    /// 仅允许标记 complete/blocked。流程：
    /// 1. 校验 status
    /// 2. 结算当前进度
    /// 3. 更新 goal 状态
    /// 4. 记录 metrics/analytics
    /// 5. 清除当前 turn 的 goal 绑定
    /// 6. 发射 goal_updated 事件
    async fn handle_update(
        &self,
        invocation: ToolCall,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError> {
        let args: UpdateGoalArgs = parse_arguments(invocation.function_arguments()?)?;
        // 仅允许 complete/blocked，其他状态由用户/系统控制
        if !matches!(
            args.status,
            ThreadGoalStatus::Complete | ThreadGoalStatus::Blocked
        ) {
            return Err(FunctionCallError::RespondToModel(
                "update_goal can only mark the existing goal complete or blocked; pause, resume, budget-limited, and usage-limited status changes are controlled by the user or system"
                    .to_string(),
            ));
        }

        // 根据 target status 选择计费模式
        self.account_active_goal_progress(
            match args.status {
                ThreadGoalStatus::Complete => codex_state::GoalAccountingMode::ActiveOrComplete,
                ThreadGoalStatus::Blocked => codex_state::GoalAccountingMode::ActiveOrStopped,
                // 上面已校验，这里不会到达
                ThreadGoalStatus::Active
                | ThreadGoalStatus::Paused
                | ThreadGoalStatus::UsageLimited
                | ThreadGoalStatus::BudgetLimited => unreachable!("status validated above"),
            },
            invocation.call_id.as_str(),
            BudgetLimitedGoalDisposition::ClearActive,
        )
        .await?;
        let previous_status = self
            .current_goal_status_for_metrics(/*expected_goal_id*/ None)
            .await?;
        let goal = self
            .state_db
            .thread_goals()
            .update_thread_goal(
                self.thread_id,
                codex_state::GoalUpdate {
                    objective: None,
                    status: Some(state_status_from_protocol(args.status)),
                    token_budget: None,
                    expected_goal_id: None,
                },
            )
            .await
            .map_err(|err| {
                FunctionCallError::RespondToModel(format!("failed to update goal: {err}"))
            })?
            .ok_or_else(|| {
                FunctionCallError::RespondToModel(
                    "cannot update goal because this thread has no goal".to_string(),
                )
            })?;
        self.metrics
            .record_terminal_if_status_changed(previous_status, &goal);
        self.analytics.status_changed(
            &goal,
            previous_status,
            GoalEventAttribution::Turn(invocation.turn_id.as_str()),
        );
        let goal = protocol_goal_from_state(goal);
        let turn_id = self.accounting_state.clear_current_turn_goal();
        self.emit_goal_updated_from_tool_call(&invocation, turn_id, goal.clone());
        // complete 状态包含预算报告，blocked 不包含
        goal_response(
            Some(goal),
            if args.status == ThreadGoalStatus::Complete {
                CompletionBudgetReport::Include
            } else {
                CompletionBudgetReport::Omit
            },
        )
    }

    /// 发射 goal_updated 事件，使用工具调用的 call_id 作为事件 ID。
    fn emit_goal_updated_from_tool_call(
        &self,
        invocation: &ToolCall,
        turn_id: Option<String>,
        goal: ThreadGoal,
    ) {
        self.event_emitter
            .thread_goal_updated(invocation.call_id.clone(), turn_id, goal);
    }

    /// 结算当前活跃 turn 的 goal 进度。
    ///
    /// 与 `GoalRuntimeHandle::account_active_goal_progress` 类似，但
    /// 返回 protocol 层的 goal 对象。
    async fn account_active_goal_progress(
        &self,
        mode: codex_state::GoalAccountingMode,
        event_id: &str,
        budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
    ) -> Result<Option<ThreadGoal>, FunctionCallError> {
        let Some(turn_id) = self.accounting_state.current_turn_id() else {
            return Ok(None);
        };
        let _accounting_permit = self
            .accounting_state
            .progress_accounting_permit()
            .await
            .map_err(|err| {
                FunctionCallError::Fatal(format!(
                    "goal progress accounting semaphore closed: {err}"
                ))
            })?;
        let Some(snapshot) = self.accounting_state.progress_snapshot(turn_id.as_str()) else {
            return Ok(None);
        };
        let previous_status = self
            .current_goal_status_for_metrics(Some(snapshot.expected_goal_id.as_str()))
            .await?;
        let outcome = self
            .state_db
            .thread_goals()
            .account_thread_goal_usage(
                self.thread_id,
                snapshot.time_delta_seconds,
                snapshot.token_delta,
                mode,
                Some(snapshot.expected_goal_id.as_str()),
            )
            .await
            .map_err(|err| {
                FunctionCallError::RespondToModel(format!("failed to account goal progress: {err}"))
            })?;
        Ok(match outcome {
            codex_state::GoalAccountingOutcome::Updated(goal) => {
                self.metrics
                    .record_terminal_if_status_changed(previous_status, &goal);
                self.analytics
                    .usage_accounted(&goal, GoalEventAttribution::Turn(turn_id.as_str()));
                self.analytics.status_changed(
                    &goal,
                    previous_status,
                    GoalEventAttribution::Turn(turn_id.as_str()),
                );
                self.accounting_state.mark_progress_accounted_for_status(
                    turn_id.as_str(),
                    &snapshot,
                    goal.status,
                    budget_limited_goal_disposition,
                );
                let goal = protocol_goal_from_state(goal);
                self.event_emitter.thread_goal_updated(
                    event_id.to_string(),
                    Some(turn_id),
                    goal.clone(),
                );
                Some(goal)
            }
            codex_state::GoalAccountingOutcome::Unchanged(_) => None,
        })
    }

    /// 读取当前 goal 状态用于 metrics 比对。
    ///
    /// `expected_goal_id` 用于乐观并发控制：若 goal_id 不匹配则返回 `None`。
    async fn current_goal_status_for_metrics(
        &self,
        expected_goal_id: Option<&str>,
    ) -> Result<Option<codex_state::ThreadGoalStatus>, FunctionCallError> {
        let goal = self
            .state_db
            .thread_goals()
            .get_thread_goal(self.thread_id)
            .await
            .map_err(|err| {
                FunctionCallError::RespondToModel(format!(
                    "failed to read goal metrics status: {err}"
                ))
            })?;
        Ok(goal.and_then(|goal| {
            expected_goal_id
                .is_none_or(|expected_goal_id| goal.goal_id == expected_goal_id)
                .then_some(goal.status)
        }))
    }
}

/// 解析工具调用参数 JSON。
fn parse_arguments<T>(arguments: &str) -> Result<T, FunctionCallError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(arguments)
        .map_err(|err| FunctionCallError::RespondToModel(err.to_string()))
}

/// 校验 goal token budget。
///
/// 当提供 budget 时必须为正数。
pub(crate) fn validate_goal_budget(value: Option<i64>) -> Result<(), String> {
    if let Some(value) = value
        && value <= 0
    {
        return Err("goal budgets must be positive when provided".to_string());
    }
    Ok(())
}

/// 构造 goal 工具响应。
fn goal_response(
    goal: Option<ThreadGoal>,
    completion_budget_report: CompletionBudgetReport,
) -> Result<Box<dyn ToolOutput>, FunctionCallError> {
    let value = serde_json::to_value(GoalToolResponse::new(goal, completion_budget_report))
        .map_err(|err| FunctionCallError::Fatal(err.to_string()))?;
    Ok(Box::new(JsonToolOutput::new(value)))
}

impl GoalToolResponse {
    /// 构造响应。
    ///
    /// 根据 `report_mode` 决定是否包含完成预算报告。
    fn new(goal: Option<ThreadGoal>, report_mode: CompletionBudgetReport) -> Self {
        let remaining_tokens = goal.as_ref().and_then(|goal| {
            goal.token_budget
                .map(|budget| (budget - goal.tokens_used).max(0))
        });
        let completion_budget_report = match report_mode {
            CompletionBudgetReport::Include => goal
                .as_ref()
                .filter(|goal| goal.status == ThreadGoalStatus::Complete)
                .and_then(completion_budget_report),
            CompletionBudgetReport::Omit => None,
        };
        Self {
            goal,
            remaining_tokens,
            completion_budget_report,
        }
    }
}

/// 若 thread preview 为空，则用 goal objective 填充。
pub(crate) async fn fill_empty_thread_preview_if_possible(
    state_db: &codex_state::StateRuntime,
    thread_id: ThreadId,
    goal: &codex_state::ThreadGoal,
) {
    if let Err(err) = state_db
        .set_thread_preview_if_empty(thread_id, goal.objective.as_str())
        .await
    {
        tracing::warn!(
            "failed to set empty thread preview from goal objective for {thread_id}: {err}"
        );
    }
}

/// 将 state 层 goal 对象转换为 protocol 层 goal 对象。
pub(crate) fn protocol_goal_from_state(goal: codex_state::ThreadGoal) -> ThreadGoal {
    ThreadGoal {
        thread_id: goal.thread_id,
        objective: goal.objective,
        status: protocol_status_from_state(goal.status),
        token_budget: goal.token_budget,
        tokens_used: goal.tokens_used,
        time_used_seconds: goal.time_used_seconds,
        created_at: goal.created_at.timestamp(),
        updated_at: goal.updated_at.timestamp(),
    }
}

/// state 层 status → protocol 层 status 转换。
fn protocol_status_from_state(status: codex_state::ThreadGoalStatus) -> ThreadGoalStatus {
    match status {
        codex_state::ThreadGoalStatus::Active => ThreadGoalStatus::Active,
        codex_state::ThreadGoalStatus::Paused => ThreadGoalStatus::Paused,
        codex_state::ThreadGoalStatus::Blocked => ThreadGoalStatus::Blocked,
        codex_state::ThreadGoalStatus::UsageLimited => ThreadGoalStatus::UsageLimited,
        codex_state::ThreadGoalStatus::BudgetLimited => ThreadGoalStatus::BudgetLimited,
        codex_state::ThreadGoalStatus::Complete => ThreadGoalStatus::Complete,
    }
}

/// protocol 层 status → state 层 status 转换。
pub(crate) fn state_status_from_protocol(
    status: ThreadGoalStatus,
) -> codex_state::ThreadGoalStatus {
    match status {
        ThreadGoalStatus::Active => codex_state::ThreadGoalStatus::Active,
        ThreadGoalStatus::Paused => codex_state::ThreadGoalStatus::Paused,
        ThreadGoalStatus::Blocked => codex_state::ThreadGoalStatus::Blocked,
        ThreadGoalStatus::UsageLimited => codex_state::ThreadGoalStatus::UsageLimited,
        ThreadGoalStatus::BudgetLimited => codex_state::ThreadGoalStatus::BudgetLimited,
        ThreadGoalStatus::Complete => codex_state::ThreadGoalStatus::Complete,
    }
}

/// 生成完成预算报告提示文本。
///
/// 当 goal 无 token budget 且无时间用量时返回 `None`；
/// 否则返回提示模型向用户报告最终用量的文本。
fn completion_budget_report(goal: &ThreadGoal) -> Option<String> {
    if goal.token_budget.is_none() && goal.time_used_seconds <= 0 {
        None
    } else {
        Some(
            "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language."
                .to_string(),
        )
    }
}
