//! 常规用户 turn 任务实现。
//!
//! `RegularTask` 是处理一次普通用户输入（user turn）的 session task 实现，
//! 负责触发 `TurnStarted` 事件、消费启动预热（prewarm）结果并循环执行 turn，
//! 直到没有更多待处理输入为止。

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::session::TurnInput;
use crate::session::turn::run_turn;
use crate::session::turn_context::TurnContext;
use crate::session_startup_prewarm::SessionStartupPrewarmResolution;
use crate::state::TaskKind;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::TurnStartedEvent;
use tracing::Instrument;
use tracing::trace_span;

use super::SessionTask;
use super::SessionTaskContext;
use super::SessionTaskResult;

/// 常规用户 turn 任务。
#[derive(Default)]
pub(crate) struct RegularTask;

impl RegularTask {
    /// 创建一个新的 `RegularTask` 实例。
    pub(crate) fn new() -> Self {
        Self
    }
}

impl SessionTask for RegularTask {
    fn kind(&self) -> TaskKind {
        TaskKind::Regular
    }

    fn span_name(&self) -> &'static str {
        "session_task.turn"
    }

    async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> SessionTaskResult {
        let sess = session.clone_session();
        let turn_extension_data = session.turn_extension_data();
        let run_turn_span = trace_span!("run_turn");
        // 常规 turn 内联发送 `TurnStarted` 事件，这样首 turn 的生命周期
        // 不必等待启动预热（startup prewarm）解析完成。
        let prewarmed_client_session = async {
            let event = EventMsg::TurnStarted(TurnStartedEvent {
                turn_id: ctx.sub_id.clone(),
                trace_id: ctx.trace_id.clone(),
                started_at: ctx.turn_timing_state.started_at_unix_secs().await,
                model_context_window: ctx.model_context_window(),
                collaboration_mode_kind: ctx.collaboration_mode.mode,
            });
            sess.send_event(ctx.as_ref(), event).await;
            sess.set_server_reasoning_included(/*included*/ false).await;
            sess.consume_startup_prewarm_for_regular_turn(&cancellation_token)
                .await
        }
        .instrument(trace_span!("regular_task.prepare_run_turn"))
        .await;
        let prewarmed_client_session = match prewarmed_client_session {
            // 启动预热被取消，直接结束当前任务。
            SessionStartupPrewarmResolution::Cancelled => return Ok(None),
            // 启动预热不可用，退化为常规路径。
            SessionStartupPrewarmResolution::Unavailable { .. } => None,
            // 启动预热就绪，使用预热好的 client session。
            SessionStartupPrewarmResolution::Ready(prewarmed_client_session) => {
                Some(*prewarmed_client_session)
            }
        };
        let mut next_input = input;
        let mut prewarmed_client_session = prewarmed_client_session;
        loop {
            let last_agent_message = run_turn(
                Arc::clone(&sess),
                Arc::clone(&ctx),
                Arc::clone(&turn_extension_data),
                next_input,
                prewarmed_client_session.take(),
                cancellation_token.child_token(),
            )
            .instrument(run_turn_span.clone())
            .await?;
            // 如果没有更多待处理的输入，则返回最后一次 agent 消息并结束任务。
            if !sess.input_queue.has_pending_input(&sess.active_turn).await {
                return Ok(last_agent_message);
            }
            // 已有新输入待处理，清空入参以使用队列中的输入进入下一轮。
            next_input = Vec::new();
        }
    }
}
