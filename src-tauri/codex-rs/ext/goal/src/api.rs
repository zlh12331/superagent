//! Goal service API 模块。
//!
//! 该模块对外暴露 [`GoalService`]，提供查询、设置、清除 thread goal 的
//! 公共接口。供外部调用方（如 UI/CLI/host）通过统一的 service 层操作 goal，
//! 而无需直接操作 state DB 或 runtime。
//!
//! ## 并发保护
//!
//! 在外部修改 goal 期间，会持有 `goal_state_permit` 信号量许可，
//! 避免 idle continuation 在状态变更过程中读取到中间状态。

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::Weak;

use codex_protocol::ThreadId;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::RolloutItem;
use codex_protocol::protocol::ThreadGoal;
use codex_protocol::protocol::ThreadGoalStatus;
use codex_protocol::protocol::ThreadGoalUpdatedEvent;
use codex_protocol::protocol::validate_thread_goal_objective;

use crate::runtime::GoalRuntimeHandle;
use crate::runtime::PreviousGoalSnapshot;
use crate::tool::fill_empty_thread_preview_if_possible;
use crate::tool::protocol_goal_from_state;
use crate::tool::state_status_from_protocol;
use crate::tool::validate_goal_budget;

/// Goal service 错误类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalServiceError {
    /// 请求参数无效（如 objective 为空、budget 非正）
    InvalidRequest(String),
    /// 内部错误（如 state DB 读写失败）
    Internal(String),
}

impl fmt::Display for GoalServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) | Self::Internal(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for GoalServiceError {}

/// goal objective 更新策略。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GoalObjectiveUpdate<'a> {
    /// 保持现有 objective 不变
    Keep,
    /// 设置为指定值
    Set(&'a str),
}

/// goal token budget 更新策略。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GoalTokenBudgetUpdate {
    /// 保持现有 budget 不变
    Keep,
    /// 设置为指定值（`None` 表示清除 budget）
    Set(Option<i64>),
}

/// 设置 goal 的请求参数。
#[derive(Clone, Copy, Debug)]
pub struct GoalSetRequest<'a> {
    /// 目标 thread ID
    pub thread_id: ThreadId,
    /// objective 更新策略
    pub objective: GoalObjectiveUpdate<'a>,
    /// 可选的状态直接设置
    pub status: Option<ThreadGoalStatus>,
    /// token budget 更新策略
    pub token_budget: GoalTokenBudgetUpdate,
}

/// 设置 goal 的结果。
///
/// 包含最新的 goal 状态、state 层的 goal 对象，以及变更前的快照（如有）。
#[derive(Clone, Debug)]
pub struct GoalSetOutcome {
    /// 协议层 goal 对象
    pub goal: ThreadGoal,
    /// state 层 goal 对象，用于后续 runtime 效果应用
    state_goal: codex_state::ThreadGoal,
    /// 变更前的 goal 快照（如有）
    previous_goal: Option<PreviousGoalSnapshot>,
}

impl GoalSetOutcome {
    /// 构造 `ThreadGoalUpdated` rollout item，供写入 rollout 日志。
    pub fn thread_goal_updated_item(&self) -> RolloutItem {
        RolloutItem::EventMsg(EventMsg::ThreadGoalUpdated(ThreadGoalUpdatedEvent {
            thread_id: self.goal.thread_id,
            turn_id: None,
            goal: self.goal.clone(),
        }))
    }

    /// 应用 runtime 副作用（如 steering prompt 注入、idle continuation）。
    ///
    /// 应在 goal 写入 state DB 成功后调用。
    pub async fn apply_runtime_effects(&self, goal_service: &GoalService) {
        if let Some(runtime) = goal_service.runtime_for_thread(self.goal.thread_id)
            && let Err(err) = runtime
                .apply_external_goal_set(self.state_goal.clone(), self.previous_goal.clone())
                .await
        {
            tracing::warn!("failed to apply external goal status runtime effects: {err}");
        }
    }
}

/// Goal service。
///
/// 维护 thread → runtime handle 的弱引用映射，支持多 thread 并发操作。
#[derive(Debug, Default)]
pub struct GoalService {
    /// thread_id → runtime handle 弱引用
    runtimes: Mutex<HashMap<String, Weak<GoalRuntimeHandle>>>,
}

impl GoalService {
    /// 创建一个新的 `GoalService` 实例。
    pub fn new() -> Self {
        Self::default()
    }

    /// 查询指定 thread 的当前 goal。
    ///
    /// 返回 `Ok(None)` 表示该 thread 没有 goal。
    pub async fn get_thread_goal(
        &self,
        state_db: &codex_state::StateRuntime,
        thread_id: ThreadId,
    ) -> Result<Option<ThreadGoal>, GoalServiceError> {
        state_db
            .thread_goals()
            .get_thread_goal(thread_id)
            .await
            .map(|goal| goal.map(protocol_goal_from_state))
            .map_err(|err| GoalServiceError::Internal(format!("failed to read thread goal: {err}")))
    }

    /// 设置（创建或更新）指定 thread 的 goal。
    ///
    /// 该方法会：
    /// 1. 校验 objective 与 budget
    /// 2. 获取 `goal_state_permit` 防止 idle continuation 干扰
    /// 3. 调用 `prepare_external_goal_mutation` 结算当前进度
    /// 4. 根据 objective 是否变更决定 update 或 replace
    /// 5. 填充空 thread preview（如有 objective）
    pub async fn set_thread_goal(
        &self,
        state_db: &codex_state::StateRuntime,
        request: GoalSetRequest<'_>,
    ) -> Result<GoalSetOutcome, GoalServiceError> {
        let GoalSetRequest {
            thread_id,
            objective,
            status,
            token_budget,
        } = request;
        let status = status.map(state_status_from_protocol);
        let objective = match objective {
            GoalObjectiveUpdate::Keep => None,
            GoalObjectiveUpdate::Set(objective) => Some(objective.trim()),
        };
        let token_budget = match token_budget {
            GoalTokenBudgetUpdate::Keep => None,
            GoalTokenBudgetUpdate::Set(token_budget) => Some(token_budget),
        };

        if let Some(objective) = objective {
            validate_thread_goal_objective(objective).map_err(GoalServiceError::InvalidRequest)?;
        }
        if objective.is_some() || token_budget.is_some() {
            validate_goal_budget(token_budget.flatten())
                .map_err(GoalServiceError::InvalidRequest)?;
        }

        let runtime = self.runtime_for_thread(thread_id);
        // 持有 permit 直到 prepare/write 完成，防止 idle continuation
        // 从即将被本次外部变更覆盖的 goal 状态启动
        let _goal_state_permit = match runtime.as_ref() {
            Some(runtime) => Some(
                runtime
                    .goal_state_permit()
                    .await
                    .map_err(GoalServiceError::Internal)?,
            ),
            None => None,
        };
        if let Some(runtime) = runtime.as_ref()
            && let Err(err) = runtime.prepare_external_goal_mutation().await
        {
            tracing::warn!("failed to prepare external goal mutation: {err}");
        }

        let (goal, previous_goal) = if let Some(objective) = objective {
            // objective 变更：需要区分 update 现有 goal 还是 replace（无 goal 时）
            let existing_goal = state_db
                .thread_goals()
                .get_thread_goal(thread_id)
                .await
                .map_err(|err| {
                    GoalServiceError::Internal(format!("failed to read thread goal: {err}"))
                })?;
            if let Some(existing_goal) = existing_goal.as_ref() {
                // 已有 goal：update（携带 expected_goal_id 进行乐观并发控制）
                let previous_goal = PreviousGoalSnapshot::from(existing_goal);
                state_db
                    .thread_goals()
                    .update_thread_goal(
                        thread_id,
                        codex_state::GoalUpdate {
                            objective: Some(objective.to_string()),
                            status,
                            token_budget,
                            expected_goal_id: Some(existing_goal.goal_id.clone()),
                        },
                    )
                    .await
                    .map_err(|err| {
                        GoalServiceError::Internal(format!("failed to update thread goal: {err}"))
                    })?
                    .ok_or_else(|| {
                        GoalServiceError::InvalidRequest(format!(
                            "cannot update goal for thread {thread_id}: no goal exists"
                        ))
                    })
                    .map(|goal| (goal, Some(previous_goal)))?
            } else {
                // 无 goal：replace（创建新 goal）
                state_db
                    .thread_goals()
                    .replace_thread_goal(
                        thread_id,
                        objective,
                        status.unwrap_or(codex_state::ThreadGoalStatus::Active),
                        token_budget.flatten(),
                    )
                    .await
                    .map_err(|err| {
                        GoalServiceError::Internal(format!("failed to replace thread goal: {err}"))
                    })
                    .map(|goal| (goal, None))?
            }
        } else {
            // objective 不变：仅更新 status/budget
            let existing_goal = state_db
                .thread_goals()
                .get_thread_goal(thread_id)
                .await
                .map_err(|err| {
                    GoalServiceError::Internal(format!("failed to read thread goal: {err}"))
                })?
                .ok_or_else(|| {
                    GoalServiceError::InvalidRequest(format!(
                        "cannot update goal for thread {thread_id}: no goal exists"
                    ))
                })?;
            let previous_goal = PreviousGoalSnapshot::from(&existing_goal);
            let expected_goal_id = existing_goal.goal_id.clone();
            state_db
                .thread_goals()
                .update_thread_goal(
                    thread_id,
                    codex_state::GoalUpdate {
                        objective: None,
                        status,
                        token_budget,
                        expected_goal_id: Some(expected_goal_id),
                    },
                )
                .await
                .map_err(|err| {
                    GoalServiceError::Internal(format!("failed to update thread goal: {err}"))
                })?
                .ok_or_else(|| {
                    GoalServiceError::InvalidRequest(format!(
                        "cannot update goal for thread {thread_id}: no goal exists"
                    ))
                })
                .map(|goal| (goal, Some(previous_goal)))?
        };

        if objective.is_some() {
            fill_empty_thread_preview_if_possible(state_db, thread_id, &goal).await;
        }
        Ok(GoalSetOutcome {
            goal: protocol_goal_from_state(goal.clone()),
            state_goal: goal,
            previous_goal,
        })
    }

    /// 清除指定 thread 的 goal。
    ///
    /// 返回 `Ok(true)` 表示成功清除；`Ok(false)` 表示本来就没有 goal。
    pub async fn clear_thread_goal(
        &self,
        state_db: &codex_state::StateRuntime,
        thread_id: ThreadId,
    ) -> Result<bool, GoalServiceError> {
        let runtime = self.runtime_for_thread(thread_id);
        // 持有 permit 直到 prepare/delete 完成，防止 idle continuation
        // 从即将被清除的 goal 状态启动
        let goal_state_permit = match runtime.as_ref() {
            Some(runtime) => Some(
                runtime
                    .goal_state_permit()
                    .await
                    .map_err(GoalServiceError::Internal)?,
            ),
            None => None,
        };
        if let Some(runtime) = runtime.as_ref()
            && let Err(err) = runtime.prepare_external_goal_mutation().await
        {
            tracing::warn!("failed to prepare external goal mutation: {err}");
        }

        let cleared_goal = state_db
            .thread_goals()
            .delete_thread_goal(thread_id)
            .await
            .map_err(|err| {
                GoalServiceError::Internal(format!("failed to clear thread goal: {err}"))
            })?;
        let cleared = cleared_goal.is_some();
        // 显式释放 permit 与 runtime 引用后再调用 apply_external_goal_clear
        drop(goal_state_permit);
        drop(runtime);

        if let (Some(runtime), Some(goal)) = (self.runtime_for_thread(thread_id), cleared_goal)
            && let Err(err) = runtime.apply_external_goal_clear(goal).await
        {
            tracing::warn!("failed to apply external goal clear runtime effects: {err}");
        }

        Ok(cleared)
    }

    /// 注册一个 runtime handle 到 service。
    ///
    /// 使用弱引用，避免阻止 runtime 被回收。
    pub(crate) fn register_runtime(&self, runtime: &Arc<GoalRuntimeHandle>) {
        self.runtimes()
            .insert(runtime.thread_id().to_string(), Arc::downgrade(runtime));
    }

    /// 注销一个 runtime handle。
    ///
    /// 仅当注册的弱引用与传入的 runtime 指向同一对象时才移除，
    /// 避免误删新注册的 runtime。
    pub(crate) fn unregister_runtime(&self, runtime: &Arc<GoalRuntimeHandle>) {
        let key = runtime.thread_id().to_string();
        let runtime = Arc::downgrade(runtime);
        let mut runtimes = self.runtimes();
        if runtimes
            .get(&key)
            .is_some_and(|registered| registered.ptr_eq(&runtime))
        {
            runtimes.remove(&key);
        }
    }

    /// 获取指定 thread 的 runtime handle（升级弱引用）。
    ///
    /// 若弱引用已失效，自动从映射中清除。
    fn runtime_for_thread(&self, thread_id: ThreadId) -> Option<Arc<GoalRuntimeHandle>> {
        let key = thread_id.to_string();
        let mut runtimes = self.runtimes();
        let runtime = runtimes.get(&key).and_then(Weak::upgrade);
        if runtime.is_none() {
            runtimes.remove(&key);
        }
        runtime
    }

    /// 获取 runtimes 映射的互斥锁，poison 时自动恢复。
    fn runtimes(&self) -> std::sync::MutexGuard<'_, HashMap<String, Weak<GoalRuntimeHandle>>> {
        self.runtimes.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
