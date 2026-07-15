//! 上下文压缩（compact）任务实现。
//!
//! `CompactTask` 是手动触发或自动触发的上下文压缩任务的 session task 实现。
//! 根据配置与特性开关，它会选择以下三种压缩路径之一：
//! - 基于令牌预算的本地压缩（`TokenBudget` feature 开启时）
//! - 远程 v2 压缩（`RemoteCompactionV2` feature 开启时）
//! - 远程 v1 压缩或本地 summarization 压缩

use std::sync::Arc;

use super::SessionTask;
use super::SessionTaskContext;
use super::SessionTaskResult;
use super::emit_compact_metric;
use crate::session::TurnInput;
use crate::session::turn_context::TurnContext;
use crate::state::TaskKind;
use codex_features::Feature;
use codex_protocol::error::CodexErr;
use codex_protocol::user_input::UserInput;
use tokio_util::sync::CancellationToken;

/// 上下文压缩任务。
#[derive(Clone, Copy, Default)]
pub(crate) struct CompactTask;

impl SessionTask for CompactTask {
    fn kind(&self) -> TaskKind {
        TaskKind::Compact
    }

    fn span_name(&self) -> &'static str {
        "session_task.compact"
    }

    async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        _cancellation_token: CancellationToken,
    ) -> SessionTaskResult {
        let session = session.clone_session();
        // 优先使用基于令牌预算的压缩路径。
        if ctx.config.features.enabled(Feature::TokenBudget) {
            crate::compact_token_budget::run_manual_compact_task(session, ctx).await?;
            return Ok(None);
        }

        let result = if crate::compact::should_use_remote_compact_task(ctx.provider.info()) {
            // 模型支持远程压缩，根据 feature 选择 v2 或 v1。
            if ctx
                .config
                .features
                .enabled(codex_features::Feature::RemoteCompactionV2)
            {
                emit_compact_metric(
                    &session.services.session_telemetry,
                    "remote_v2",
                    /*manual*/ true,
                );
                crate::compact_remote_v2::run_remote_compact_task(session.clone(), ctx).await
            } else {
                emit_compact_metric(
                    &session.services.session_telemetry,
                    "remote",
                    /*manual*/ true,
                );
                crate::compact_remote::run_remote_compact_task(session.clone(), ctx).await
            }
        } else {
            // 模型不支持远程压缩，使用本地 summarization 路径。
            emit_compact_metric(
                &session.services.session_telemetry,
                "local",
                /*manual*/ true,
            );
            let input = vec![UserInput::Text {
                text: ctx
                    .config
                    .compact_prompt
                    .as_deref()
                    .unwrap_or(crate::compact::SUMMARIZATION_PROMPT)
                    .to_string(),
                // 压缩 prompt 是合成的，没有需要保留的 UI element 区间。
                text_elements: Vec::new(),
            }];
            crate::compact::run_compact_task(session.clone(), ctx, input).await
        };
        // turn 被中止时向上传递错误，其他错误被吞掉并返回 `None`。
        if let Err(err @ CodexErr::TurnAborted) = result {
            return Err(err);
        }
        Ok(None)
    }
}
