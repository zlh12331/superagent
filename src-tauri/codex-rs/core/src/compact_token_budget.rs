//! 基于 token 预算的本地压缩实现。
//!
//! 本模块实现跳过模型/服务端摘要的压缩方式：直接安装新的 context window，
//! 但仍以标准压缩生命周期建模，使 compact hooks 与 `ContextCompaction` turn item
//! 与本地/远程压缩保持一致的生命周期。

use std::sync::Arc;

use crate::compact::InitialContextInjection;
use crate::context::world_state::WorldState;
use crate::hook_runtime::PostCompactHookOutcome;
use crate::hook_runtime::PreCompactHookOutcome;
use crate::hook_runtime::run_post_compact_hooks;
use crate::hook_runtime::run_pre_compact_hooks;
use crate::session::session::Session;
use crate::session::step_context::StepContext;
use crate::session::turn_context::TurnContext;
use codex_analytics::CompactionTrigger;
use codex_protocol::error::CodexErr;
use codex_protocol::error::Result as CodexResult;
use codex_protocol::items::ContextCompactionItem;
use codex_protocol::items::TurnItem;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::TurnStartedEvent;

/// 运行手动 token 预算压缩任务。
///
/// token 预算压缩跳过模型/服务端摘要，直接安装新的 context window。
/// 仍以标准压缩生命周期建模，使 compact hooks 与 `ContextCompaction` turn item
/// 与本地/远程压缩保持一致的生命周期。
pub(crate) async fn run_manual_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
) -> CodexResult<()> {
    let start_event = EventMsg::TurnStarted(TurnStartedEvent {
        turn_id: turn_context.sub_id.clone(),
        trace_id: turn_context.trace_id.clone(),
        started_at: turn_context.turn_timing_state.started_at_unix_secs().await,
        model_context_window: turn_context.model_context_window(),
        collaboration_mode_kind: turn_context.collaboration_mode.mode,
    });
    sess.send_event(&turn_context, start_event).await;

    // 手动压缩在 run_turn 之外运行，因此捕获自己的当前 step。
    let step_context = sess.capture_step_context(Arc::clone(&turn_context)).await;
    let world_state = Arc::new(sess.build_world_state_for_step(&step_context).await);
    run_compact_task_inner(&sess, &turn_context, world_state, CompactionTrigger::Manual).await
}

/// 运行内联自动 token 预算压缩任务。
///
/// token 预算压缩跳过模型/服务端摘要，直接安装新的 context window。
/// 仍以标准压缩生命周期建模，使 compact hooks 与 `ContextCompaction` turn item
/// 与本地/远程压缩保持一致的生命周期。
pub(crate) async fn run_inline_auto_compact_task(
    sess: Arc<Session>,
    step_context: Arc<StepContext>,
    initial_context_injection: InitialContextInjection,
) -> CodexResult<()> {
    let turn_context = &step_context.turn;
    let world_state = match initial_context_injection {
        InitialContextInjection::BeforeLastUserMessage(world_state) => world_state,
        InitialContextInjection::DoNotInject => {
            Arc::new(sess.build_world_state_for_step(&step_context).await)
        }
    };
    run_compact_task_inner(&sess, turn_context, world_state, CompactionTrigger::Auto).await
}

/// token 预算压缩任务的核心实现，处理 pre/post compact hooks 与 context window 切换。
async fn run_compact_task_inner(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    world_state: Arc<WorldState>,
    trigger: CompactionTrigger,
) -> CodexResult<()> {
    let pre_compact_outcome = run_pre_compact_hooks(sess, turn_context, trigger).await;
    match pre_compact_outcome {
        PreCompactHookOutcome::Continue => {}
        PreCompactHookOutcome::Stopped => return Err(CodexErr::TurnAborted),
    }

    let compaction_item = TurnItem::ContextCompaction(ContextCompactionItem::new());
    sess.emit_turn_item_started(turn_context, &compaction_item)
        .await;
    sess.start_new_context_window(turn_context.as_ref(), world_state)
        .await;
    sess.emit_turn_item_completed(turn_context, compaction_item)
        .await;

    let post_compact_outcome = run_post_compact_hooks(sess, turn_context, trigger).await;
    if let PostCompactHookOutcome::Stopped = post_compact_outcome {
        return Err(CodexErr::TurnAborted);
    }

    Ok(())
}
