//! rollout 预算(rollout budget)模块。
//!
//! 用于在一个 root-thread 会话树内统计 token 消耗,并在接近预算上限时
//! 向 thread 发送提醒(reminder),提示 LLM 主动结束或精简后续操作。
//!
//! # 设计要点
//! - 使用加权 token 计数:output token 与 prefill token 分别按权重累加,
//!   以反映不同阶段对成本的真实影响。
//! - 提醒通过阈值列表(reminder_at_remaining_tokens)分级触发,
//!   每个 thread 独立记录已送达的提醒级别,确保所有 thread 都能观察到阈值跨越事件。

use crate::config::RolloutBudgetConfig;
use codex_protocol::ThreadId;
use codex_protocol::protocol::TokenUsage;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;

/// 当前应向 thread 提示的预算剩余信息。
pub(crate) struct RolloutBudgetReminder {
    /// 剩余可用 token 数(已下取整,非负)。
    pub(crate) remaining_tokens: i64,
    /// 当前命中的提醒阈值索引(值越大表示越接近耗尽)。
    reminder_index: i64,
}

/// 一个 root-thread 会话树共享的预算统计与提醒状态。
///
/// 通过 [`OnceLock`] 惰性初始化内部 [`Mutex`],以便在配置完成前调用方法不会 panic。
#[derive(Default)]
pub(crate) struct RolloutBudget {
    state: OnceLock<Mutex<RolloutBudgetState>>,
}

/// rollout 预算的可变状态。
struct RolloutBudgetState {
    config: RolloutBudgetConfig,
    /// 已使用的加权 token 总量。
    weighted_tokens_used: f64,
    /// 每个 thread 最近一次已送达的提醒,确保每个 thread 都能观察到阈值跨越。
    deliveries: HashMap<ThreadId, ThreadBudgetDelivery>,
}

/// 单个 thread 的预算提醒投递记录。
struct ThreadBudgetDelivery {
    window_id: String,
    reminder_index: i64,
}

impl RolloutBudget {
    /// 配置预算参数,仅首次调用生效(后续调用被 `OnceLock` 忽略)。
    pub(crate) fn configure(&self, config: RolloutBudgetConfig) {
        self.state.get_or_init(|| {
            Mutex::new(RolloutBudgetState {
                config,
                weighted_tokens_used: 0.0,
                deliveries: HashMap::new(),
            })
        });
    }

    /// 记录一次 token 使用,并返回当前预算是否已耗尽。
    ///
    /// 一旦返回 `true`,后续调用也会持续返回 `true`(单调递增,不会回退)。
    /// 若预算尚未配置,则返回 `false`。
    pub(crate) fn record_usage(&self, usage: &TokenUsage) -> bool {
        let Some(mut state) = self.lock() else {
            return false;
        };
        // 加权累加:output token 按 sampling_token_weight 计,
        // 未命中缓存的 input token 按 prefill_token_weight 计。
        state.weighted_tokens_used += usage.output_tokens.max(0) as f64
            * state.config.sampling_token_weight
            + usage.non_cached_input() as f64 * state.config.prefill_token_weight;
        state.weighted_tokens_used >= state.config.limit_tokens as f64
    }

    /// 计算指定 thread 当前应接收的预算提醒。
    ///
    /// 返回 `Some(reminder)` 表示有新的阈值被命中且尚未送达该 thread;
    /// 返回 `None` 表示无需提醒(已送达或预算未配置)。
    pub(crate) fn pending_reminder(
        &self,
        thread_id: ThreadId,
        window_id: &str,
    ) -> Option<RolloutBudgetReminder> {
        let state = self.lock()?;
        let remaining_tokens = (state.config.limit_tokens as f64 - state.weighted_tokens_used)
            .max(0.0)
            .floor() as i64;
        // 命中的阈值数量即提醒级别:命中越多,剩余越少,索引越大。
        let reminder_index = state
            .config
            .reminder_at_remaining_tokens
            .iter()
            .filter(|&&threshold| remaining_tokens <= threshold)
            .count() as i64;
        if state.deliveries.get(&thread_id).is_some_and(|delivery| {
            delivery.window_id.as_str() == window_id && delivery.reminder_index >= reminder_index
        }) {
            return None;
        }
        Some(RolloutBudgetReminder {
            remaining_tokens,
            reminder_index,
        })
    }

    /// 标记一次提醒已成功投递给指定 thread。
    ///
    /// 必须在 history 插入完成之后调用;若在那之前会话被取消,应允许重试,
    /// 因此仅在锁可用时更新 deliveries。
    pub(crate) fn mark_reminder_delivered(
        &self,
        thread_id: ThreadId,
        window_id: &str,
        reminder: RolloutBudgetReminder,
    ) {
        // 仅在 history 插入完成之后才标记为已投递;在此之前发生的取消应当能够重试。
        let Some(mut state) = self.lock() else {
            return;
        };
        state.deliveries.insert(
            thread_id,
            ThreadBudgetDelivery {
                window_id: window_id.to_string(),
                reminder_index: reminder.reminder_index,
            },
        );
    }

    /// 强制下一次采样请求重新向 `thread_id` 播报当前剩余预算。
    ///
    /// 用于在用户主动询问预算或重置后重新触发提醒。
    pub(crate) fn rearm_reminder(&self, thread_id: ThreadId) {
        let Some(mut state) = self.lock() else {
            return;
        };
        state.deliveries.remove(&thread_id);
    }

    /// 获取内部状态的锁;若预算尚未配置则返回 `None`。
    fn lock(&self) -> Option<MutexGuard<'_, RolloutBudgetState>> {
        self.state.get().map(|state| {
            state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        })
    }
}
