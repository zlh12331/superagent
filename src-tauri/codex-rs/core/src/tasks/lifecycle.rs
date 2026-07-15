//! Turn / Thread 生命周期事件分发实现。
//!
//! 本文件为 `Session` 实现了一组辅助方法，用于将 turn 与 thread 的生命周期事件
//! （启动、停止、空闲、中止、错误）分发给所有已注册的扩展 contributor。

use codex_extension_api::ExtensionData;
use codex_protocol::protocol::CodexErrorInfo;
use codex_protocol::protocol::TokenUsage;
use codex_protocol::protocol::TurnAbortReason;

use crate::session::session::Session;
use crate::session::turn_context::TurnContext;

impl Session {
    /// 触发 turn 启动生命周期事件，通知所有 turn lifecycle contributor。
    ///
    /// 传入当前 turn 上下文以及 turn 启动时的令牌用量快照。
    pub(super) async fn emit_turn_start_lifecycle(
        &self,
        turn_context: &TurnContext,
        token_usage_at_turn_start: &TokenUsage,
    ) {
        for contributor in self.services.extensions.turn_lifecycle_contributors() {
            contributor
                .on_turn_start(codex_extension_api::TurnStartInput {
                    turn_id: turn_context.sub_id.as_str(),
                    collaboration_mode: &turn_context.collaboration_mode,
                    token_usage_at_turn_start,
                    session_store: &self.services.session_extension_data,
                    thread_store: &self.services.thread_extension_data,
                    turn_store: turn_context.extension_data.as_ref(),
                })
                .await;
        }
    }

    /// 触发 turn 停止生命周期事件，通知所有 turn lifecycle contributor。
    pub(super) async fn emit_turn_stop_lifecycle(&self, turn_store: &ExtensionData) {
        for contributor in self.services.extensions.turn_lifecycle_contributors() {
            contributor
                .on_turn_stop(codex_extension_api::TurnStopInput {
                    session_store: &self.services.session_extension_data,
                    thread_store: &self.services.thread_extension_data,
                    turn_store,
                })
                .await;
        }
    }

    /// 如果当前确实处于空闲状态，则触发 thread 空闲生命周期事件。
    ///
    /// 判定空闲的条件：
    /// - 没有活跃的 turn；
    /// - 输入队列中不存在会触发新 turn 的 mailbox 项。
    /// 若任一条件不满足，则直接返回不触发事件。
    pub(crate) async fn emit_thread_idle_lifecycle_if_idle(&self) {
        if self.active_turn.lock().await.is_some()
            || self.input_queue.has_trigger_turn_mailbox_items().await
        {
            return;
        }

        for contributor in self.services.extensions.thread_lifecycle_contributors() {
            contributor
                .on_thread_idle(codex_extension_api::ThreadIdleInput {
                    session_store: &self.services.session_extension_data,
                    thread_store: &self.services.thread_extension_data,
                })
                .await;
        }
    }

    /// 触发 turn 中止生命周期事件，通知所有 turn lifecycle contributor。
    ///
    /// 传入中止原因与 turn 级扩展数据。
    pub(super) async fn emit_turn_abort_lifecycle(
        &self,
        reason: TurnAbortReason,
        turn_store: &ExtensionData,
    ) {
        for contributor in self.services.extensions.turn_lifecycle_contributors() {
            contributor
                .on_turn_abort(codex_extension_api::TurnAbortInput {
                    reason: reason.clone(),
                    session_store: &self.services.session_extension_data,
                    thread_store: &self.services.thread_extension_data,
                    turn_store,
                })
                .await;
        }
    }

    /// 触发 turn 错误生命周期事件，通知所有 turn lifecycle contributor。
    ///
    /// 传入当前 turn 上下文与错误信息。
    pub(crate) async fn emit_turn_error_lifecycle(
        &self,
        turn_context: &TurnContext,
        error: CodexErrorInfo,
    ) {
        for contributor in self.services.extensions.turn_lifecycle_contributors() {
            contributor
                .on_turn_error(codex_extension_api::TurnErrorInput {
                    turn_id: turn_context.sub_id.as_str(),
                    error: error.clone(),
                    session_store: &self.services.session_extension_data,
                    thread_store: &self.services.thread_extension_data,
                    turn_store: turn_context.extension_data.as_ref(),
                })
                .await;
        }
    }
}
