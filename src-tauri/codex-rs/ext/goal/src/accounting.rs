//! Goal 计费状态机实现。
//!
//! 该模块负责追踪每个 turn 的 token 使用量增量、wall-clock 时间增量，
//! 以及 goal 的活跃状态。计费数据用于在 goal 仍在推进时定期将用量
//! 持久化到 state DB，并在达到预算上限时触发状态变更。
//!
//! ## 并发模型
//!
//! - 状态字段通过 `Mutex<GoalAccountingInner>` 互斥访问
//! - 进度结算（snapshot → 写库 → 标记 accounted）通过 `progress_accounting_lock`
//!   信号量串行化，避免多个 tool-completion hook 同时计费导致的重复扣减

use codex_protocol::config_types::ModeKind;
use codex_protocol::protocol::TokenUsage;
use codex_state::ThreadGoalStatus;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Semaphore;
use tokio::sync::SemaphorePermit;

/// Goal 计费状态机。
///
/// 每个 thread 持有独立实例，追踪其下所有 turn 的 token/time 用量以及
/// 当前活跃 goal。`progress_accounting_lock` 用于串行化进度结算流程，
/// 防止并发 tool-completion hook 对同一份用量重复入库。
#[derive(Debug)]
pub(crate) struct GoalAccountingState {
    /// 互斥保护的内部状态
    inner: Mutex<GoalAccountingInner>,
    /// 进度结算串行化信号量，permits = 1
    progress_accounting_lock: Semaphore,
}

/// 计费状态机内部数据。
#[derive(Debug)]
struct GoalAccountingInner {
    /// 当前活跃 turn 的 ID
    current_turn_id: Option<String>,
    /// 所有已知 turn 的计费记录（按 turn_id 索引）
    turns: HashMap<String, GoalTurnAccounting>,
    /// wall-clock 时间计费
    wall_clock: GoalWallClockAccounting,
    /// 已上报过 budget-limited 事件的 goal_id，避免重复上报
    budget_limit_reported_goal_id: Option<String>,
}

/// 单个 turn 的计费记录。
#[derive(Debug)]
struct GoalTurnAccounting {
    /// 当前 turn 的累计 token 用量
    current_token_usage: TokenUsage,
    /// 上次入库结算时的 token 用量基线
    last_accounted_token_usage: TokenUsage,
    /// 该 turn 当前关联的活跃 goal_id
    active_goal_id: Option<String>,
    /// 是否对该 turn 进行 token 计费（Plan 模式不计费）
    account_tokens: bool,
}

/// wall-clock 时间计费记录。
#[derive(Debug)]
struct GoalWallClockAccounting {
    /// 上次入库结算的时间点
    last_accounted_at: Instant,
    /// 当前关联的活跃 goal_id
    active_goal_id: Option<String>,
}

/// 一次 turn 进度快照，用于结算当前 turn 的 token/time 增量。
#[derive(Debug, Clone)]
pub(crate) struct GoalProgressSnapshot {
    /// 快照时的当前 token 用量
    pub(crate) current_token_usage: TokenUsage,
    /// 快照对应的 goal_id（用于乐观并发控制）
    pub(crate) expected_goal_id: String,
    /// 自上次结算以来的时间增量（秒）
    pub(crate) time_delta_seconds: i64,
    /// 自上次结算以来的 token 增量
    pub(crate) token_delta: i64,
}

/// 一次 idle 进度快照，用于在没有活跃 turn 时结算 wall-clock 时间增量。
#[derive(Debug, Clone)]
pub(crate) struct IdleGoalProgressSnapshot {
    /// 快照对应的 goal_id
    pub(crate) expected_goal_id: String,
    /// 自上次结算以来的时间增量（秒）
    pub(crate) time_delta_seconds: i64,
}

/// 当 goal 被判定为 BudgetLimited 时，对当前活跃 goal 的处置策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BudgetLimitedGoalDisposition {
    /// 保留活跃 goal，继续在后续 turn 中计费
    KeepActive,
    /// 清除活跃 goal，等待外部触发恢复
    ClearActive,
}

/// 记录一次 token 用量增量结果。
///
/// - `turn_delta`：当前 turn 的增量
/// - `thread_unflushed_delta`：整个 thread 所有未入库 turn 的增量总和
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RecordedTokenDelta {
    pub(crate) turn_delta: i64,
    pub(crate) thread_unflushed_delta: i64,
}

impl GoalAccountingState {
    /// 启动一个新的 turn，初始化其计费记录。
    ///
    /// # 参数
    /// - `turn_id`：新 turn 的标识
    /// - `collaboration_mode`：协作模式（Plan 模式不进行 token 计费）
    /// - `token_usage_at_turn_start`：turn 开始时的 token 用量基线
    pub(crate) fn start_turn(
        &self,
        turn_id: impl Into<String>,
        collaboration_mode: ModeKind,
        token_usage_at_turn_start: &TokenUsage,
    ) {
        let turn_id = turn_id.into();
        let mut inner = self.inner();
        inner.current_turn_id = Some(turn_id.clone());
        inner.turns.insert(
            turn_id,
            GoalTurnAccounting::new(
                token_usage_at_turn_start.clone(),
                // Plan 模式不进行 token 计费
                !matches!(collaboration_mode, ModeKind::Plan),
            ),
        );
    }

    /// 返回当前活跃 turn 的 ID。
    pub(crate) fn current_turn_id(&self) -> Option<String> {
        self.inner().current_turn_id.clone()
    }

    /// 获取进度结算许可。
    ///
    /// 调用方应在获取进度快照之前获取该许可，并持有至持久化用量写入成功、
    /// 快照被标记为已结算之后释放。这确保同一时刻只有一个 hook 能对
    /// 给定的 token/time 增量进行结算。
    pub(crate) async fn progress_accounting_permit(
        &self,
    ) -> Result<SemaphorePermit<'_>, tokio::sync::AcquireError> {
        self.progress_accounting_lock.acquire().await
    }

    /// 判断给定 turn 是否为当前活跃 turn 且绑定了活跃 goal。
    pub(crate) fn turn_is_current_active_goal(&self, turn_id: &str) -> bool {
        let inner = self.inner();
        if inner.current_turn_id.as_deref() != Some(turn_id) {
            return false;
        }
        let Some(turn) = inner.turns.get(turn_id) else {
            return false;
        };
        turn.account_tokens && turn.active_goal_id.is_some()
    }

    /// 记录某 turn 的最新 token 用量，并返回自上次结算以来的增量。
    ///
    /// 返回 `None` 表示该 turn 不计费或无增量。
    pub(crate) fn record_token_usage(
        &self,
        turn_id: impl Into<String>,
        total_usage: &TokenUsage,
    ) -> Option<RecordedTokenDelta> {
        let turn_id = turn_id.into();
        let mut inner = self.inner();
        let turn = inner.turns.get_mut(&turn_id)?;
        turn.current_token_usage = total_usage.clone();
        if !turn.account_tokens {
            return None;
        }

        let delta = turn.token_delta_since_last_accounting();
        if delta <= 0 {
            return None;
        }
        Some(RecordedTokenDelta {
            turn_delta: delta,
            thread_unflushed_delta: inner.thread_unflushed_token_delta(),
        })
    }

    /// 将指定 turn 绑定到一个活跃 goal。
    pub(crate) fn mark_turn_goal_active(&self, turn_id: &str, goal_id: impl Into<String>) {
        let mut inner = self.inner();
        let goal_id = goal_id.into();
        // 切换到新 goal 时清除已上报的 budget-limited 标记
        if inner.budget_limit_reported_goal_id.as_deref() != Some(goal_id.as_str()) {
            inner.budget_limit_reported_goal_id = None;
        }
        if let Some(turn) = inner.turns.get_mut(turn_id) {
            turn.active_goal_id = Some(goal_id.clone());
            if inner.current_turn_id.as_deref() == Some(turn_id) {
                inner.wall_clock.mark_active_goal(goal_id);
            }
        }
    }

    /// 将当前活跃 turn 绑定到一个活跃 goal，并重置 token 基线。
    ///
    /// 返回被绑定的 turn_id（如果当前有活跃 turn）。
    pub(crate) fn mark_current_turn_goal_active(
        &self,
        goal_id: impl Into<String>,
    ) -> Option<String> {
        let mut inner = self.inner();
        let turn_id = inner.current_turn_id.clone()?;
        let goal_id = goal_id.into();
        if inner.budget_limit_reported_goal_id.as_deref() != Some(goal_id.as_str()) {
            inner.budget_limit_reported_goal_id = None;
        }
        let turn = inner.turns.get_mut(turn_id.as_str())?;
        turn.active_goal_id = Some(goal_id.clone());
        turn.reset_baseline_to_current();
        inner.wall_clock.mark_active_goal(goal_id);
        Some(turn_id)
    }

    /// 在没有活跃 turn 时（idle 状态）将 goal 标记为活跃。
    pub(crate) fn mark_idle_goal_active(&self, goal_id: impl Into<String>) {
        let mut inner = self.inner();
        let goal_id = goal_id.into();
        if inner.budget_limit_reported_goal_id.as_deref() != Some(goal_id.as_str()) {
            inner.budget_limit_reported_goal_id = None;
        }
        inner.wall_clock.mark_active_goal(goal_id);
    }

    /// 清除当前活跃 turn 的 goal 绑定。
    ///
    /// 返回被清除 goal 的 turn_id（如果存在）。
    pub(crate) fn clear_current_turn_goal(&self) -> Option<String> {
        let mut inner = self.inner();
        let turn_id = inner.current_turn_id.clone()?;
        if let Some(turn) = inner.turns.get_mut(turn_id.as_str()) {
            turn.active_goal_id = None;
        }
        inner.wall_clock.clear_active_goal();
        inner.budget_limit_reported_goal_id = None;
        Some(turn_id)
    }

    /// 清除所有活跃 goal 绑定（当前 turn 与 wall-clock）。
    pub(crate) fn clear_active_goal(&self) {
        let mut inner = self.inner();
        if let Some(turn_id) = inner.current_turn_id.clone()
            && let Some(turn) = inner.turns.get_mut(turn_id.as_str())
        {
            turn.active_goal_id = None;
        }
        inner.wall_clock.clear_active_goal();
        inner.budget_limit_reported_goal_id = None;
    }

    /// 生成指定 turn 的进度快照。
    ///
    /// 返回 `None` 表示该 turn 不计费、无活跃 goal 或无增量。
    pub(crate) fn progress_snapshot(&self, turn_id: &str) -> Option<GoalProgressSnapshot> {
        let inner = self.inner();
        let turn = inner.turns.get(turn_id)?;
        if !turn.account_tokens {
            return None;
        }
        let expected_goal_id = turn.active_goal_id()?;
        let token_delta = turn.token_delta_since_last_accounting();
        // 仅当 wall-clock 当前活跃 goal 与 turn 的活跃 goal 一致时才计算时间增量
        let time_delta_seconds =
            if inner.wall_clock.active_goal_id.as_deref() == Some(expected_goal_id.as_str()) {
                inner.wall_clock.time_delta_since_last_accounting()
            } else {
                0
            };
        if time_delta_seconds == 0 && token_delta <= 0 {
            return None;
        }
        Some(GoalProgressSnapshot {
            current_token_usage: turn.current_token_usage.clone(),
            expected_goal_id,
            time_delta_seconds,
            token_delta,
        })
    }

    /// 生成 idle 状态下的进度快照（仅含时间增量）。
    pub(crate) fn idle_progress_snapshot(&self) -> Option<IdleGoalProgressSnapshot> {
        let inner = self.inner();
        let expected_goal_id = inner.wall_clock.active_goal_id.clone()?;
        let time_delta_seconds = inner.wall_clock.time_delta_since_last_accounting();
        if time_delta_seconds == 0 {
            return None;
        }
        Some(IdleGoalProgressSnapshot {
            expected_goal_id,
            time_delta_seconds,
        })
    }

    /// 在持久化用量写入成功后，将快照标记为已结算。
    ///
    /// 根据新状态与 `budget_limited_goal_disposition` 决定是否清除活跃 goal。
    pub(crate) fn mark_progress_accounted_for_status(
        &self,
        turn_id: &str,
        snapshot: &GoalProgressSnapshot,
        status: ThreadGoalStatus,
        budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
    ) {
        let clear_active_goal = should_clear_active_goal(status, budget_limited_goal_disposition);
        let mut inner = self.inner();
        if let Some(turn) = inner.turns.get_mut(turn_id) {
            turn.last_accounted_token_usage = snapshot.current_token_usage.clone();
            if clear_active_goal {
                turn.active_goal_id = None;
            }
        }
        inner.wall_clock.mark_accounted(snapshot.time_delta_seconds);
        if clear_active_goal {
            inner.wall_clock.clear_active_goal();
        }
        if status != ThreadGoalStatus::BudgetLimited {
            inner.budget_limit_reported_goal_id = None;
        }
    }

    /// 结束指定 turn，清理其计费记录。
    pub(crate) fn finish_turn(&self, turn_id: &str) {
        let mut inner = self.inner();
        inner.turns.remove(turn_id);
        if inner.current_turn_id.as_deref() == Some(turn_id) {
            inner.current_turn_id = None;
        }
    }

    /// idle 状态下的快照结算标记。
    pub(crate) fn mark_idle_progress_accounted_for_status(
        &self,
        snapshot: &IdleGoalProgressSnapshot,
        status: ThreadGoalStatus,
        budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
    ) {
        let clear_active_goal = should_clear_active_goal(status, budget_limited_goal_disposition);
        let mut inner = self.inner();
        inner.wall_clock.mark_accounted(snapshot.time_delta_seconds);
        if clear_active_goal {
            inner.wall_clock.clear_active_goal();
        }
        if status != ThreadGoalStatus::BudgetLimited {
            inner.budget_limit_reported_goal_id = None;
        }
    }

    /// 重置 idle 进度基线并清除活跃 goal。
    pub(crate) fn reset_idle_progress_baseline_and_clear_active_goal(&self) {
        let mut inner = self.inner();
        inner.wall_clock.reset_baseline();
        inner.wall_clock.clear_active_goal();
        inner.budget_limit_reported_goal_id = None;
    }

    /// 标记某 goal 已上报过 budget-limited 事件。
    ///
    /// 返回 `true` 表示首次上报，`false` 表示已上报过（应跳过）。
    pub(crate) fn mark_budget_limit_reported_if_new(&self, goal_id: &str) -> bool {
        let mut inner = self.inner();
        if inner.budget_limit_reported_goal_id.as_deref() == Some(goal_id) {
            return false;
        }
        inner.budget_limit_reported_goal_id = Some(goal_id.to_string());
        true
    }

    /// 获取内部状态的互斥锁，poison 时自动恢复。
    fn inner(&self) -> std::sync::MutexGuard<'_, GoalAccountingInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for GoalAccountingState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(GoalAccountingInner::default()),
            // 单许可信号量，用于串行化进度结算
            progress_accounting_lock: Semaphore::new(/*permits*/ 1),
        }
    }
}

/// 计算两次 token 用量之间的 delta（基于 input - cached + output）。
fn token_delta_since_last_accounting(last: &TokenUsage, current: &TokenUsage) -> i64 {
    let delta = TokenUsage {
        input_tokens: current.input_tokens.saturating_sub(last.input_tokens),
        cached_input_tokens: current
            .cached_input_tokens
            .saturating_sub(last.cached_input_tokens),
        output_tokens: current.output_tokens.saturating_sub(last.output_tokens),
        reasoning_output_tokens: current
            .reasoning_output_tokens
            .saturating_sub(last.reasoning_output_tokens),
        total_tokens: current.total_tokens.saturating_sub(last.total_tokens),
    };
    goal_token_delta_for_usage(&delta)
}

/// 计算某次 usage 对 goal 计费的有效 token 数。
///
/// 公式：`input_tokens - cached_input_tokens + max(output_tokens, 0)`
///
/// 缓存命中的 input token 不计入 goal 预算。
pub(crate) fn goal_token_delta_for_usage(usage: &TokenUsage) -> i64 {
    usage
        .input_tokens
        .saturating_sub(usage.cached_input_tokens)
        .saturating_add(usage.output_tokens.max(0))
}

impl Default for GoalAccountingInner {
    fn default() -> Self {
        Self {
            current_turn_id: None,
            turns: HashMap::new(),
            wall_clock: GoalWallClockAccounting::new(),
            budget_limit_reported_goal_id: None,
        }
    }
}

impl GoalAccountingInner {
    /// 计算整个 thread 所有未入库 turn 的 token 增量总和。
    fn thread_unflushed_token_delta(&self) -> i64 {
        self.turns
            .values()
            .filter(|turn| turn.account_tokens)
            .fold(0_i64, |total, turn| {
                total.saturating_add(turn.token_delta_since_last_accounting().max(0))
            })
    }
}

impl GoalTurnAccounting {
    fn new(current_token_usage: TokenUsage, account_tokens: bool) -> Self {
        Self {
            last_accounted_token_usage: current_token_usage.clone(),
            current_token_usage,
            active_goal_id: None,
            account_tokens,
        }
    }

    /// 返回当前活跃 goal_id 的克隆。
    fn active_goal_id(&self) -> Option<String> {
        self.active_goal_id.clone()
    }

    /// 将上次结算基线重置为当前用量。
    ///
    /// 用于在 goal 重新激活时避免重复计费历史用量。
    fn reset_baseline_to_current(&mut self) {
        self.last_accounted_token_usage = self.current_token_usage.clone();
    }

    /// 计算自上次结算以来的 token 增量。
    fn token_delta_since_last_accounting(&self) -> i64 {
        token_delta_since_last_accounting(
            &self.last_accounted_token_usage,
            &self.current_token_usage,
        )
    }
}

impl GoalWallClockAccounting {
    fn new() -> Self {
        Self {
            last_accounted_at: Instant::now(),
            active_goal_id: None,
        }
    }

    /// 返回自上次结算以来经过的秒数（饱和转换为 i64）。
    fn time_delta_since_last_accounting(&self) -> i64 {
        i64::try_from(self.last_accounted_at.elapsed().as_secs()).unwrap_or(i64::MAX)
    }

    /// 将基线时间向前推进指定秒数，标记为已结算。
    fn mark_accounted(&mut self, accounted_seconds: i64) {
        if accounted_seconds <= 0 {
            return;
        }
        let advance = Duration::from_secs(u64::try_from(accounted_seconds).unwrap_or(u64::MAX));
        self.last_accounted_at = self
            .last_accounted_at
            .checked_add(advance)
            .unwrap_or_else(Instant::now);
    }

    /// 重置基线时间为当前时刻。
    fn reset_baseline(&mut self) {
        self.last_accounted_at = Instant::now();
    }

    /// 标记一个 goal 为活跃，若与当前活跃 goal 不同则重置基线。
    fn mark_active_goal(&mut self, goal_id: impl Into<String>) {
        let goal_id = goal_id.into();
        if self.active_goal_id.as_deref() != Some(goal_id.as_str()) {
            self.reset_baseline();
            self.active_goal_id = Some(goal_id);
        }
    }

    /// 清除活跃 goal 并重置基线。
    fn clear_active_goal(&mut self) {
        self.active_goal_id = None;
        self.reset_baseline();
    }
}

/// 根据新状态与 disposition 决定是否清除活跃 goal。
///
/// - Active：永不清除
/// - BudgetLimited：依 disposition 而定
/// - 其他终态（Paused/Blocked/UsageLimited/Complete）：始终清除
fn should_clear_active_goal(
    status: ThreadGoalStatus,
    budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
) -> bool {
    match status {
        ThreadGoalStatus::Active => false,
        ThreadGoalStatus::BudgetLimited => matches!(
            budget_limited_goal_disposition,
            BudgetLimitedGoalDisposition::ClearActive
        ),
        ThreadGoalStatus::Paused
        | ThreadGoalStatus::Blocked
        | ThreadGoalStatus::UsageLimited
        | ThreadGoalStatus::Complete => true,
    }
}
