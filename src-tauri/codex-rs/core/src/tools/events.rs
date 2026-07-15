//! 工具事件发射器实现。
//!
//! 本模块负责将工具调用的生命周期（启动/成功/失败）转换为对外可见的事件，
//! 例如 `ExecCommandBegin`、`ExecCommandEnd`、`FileChange` 与 `TurnDiff`。
//! 同时维护 turn 级 diff tracker 的更新策略，确保文件改动可被追踪。

use crate::function_tool::FunctionCallError;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::tools::context::SharedTurnDiffTracker;
use crate::tools::sandboxing::ToolError;
use crate::turn_timing::now_unix_timestamp_ms;
use codex_apply_patch::AppliedPatchDelta;
use codex_protocol::error::CodexErr;
use codex_protocol::error::SandboxErr;
use codex_protocol::exec_output::ExecToolCallOutput;
use codex_protocol::items::FileChangeItem;
use codex_protocol::items::TurnItem;
use codex_protocol::parse_command::ParsedCommand;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::ExecCommandBeginEvent;
use codex_protocol::protocol::ExecCommandEndEvent;
use codex_protocol::protocol::ExecCommandSource;
use codex_protocol::protocol::ExecCommandStatus;
use codex_protocol::protocol::FileChange;
use codex_protocol::protocol::PatchApplyStatus;
use codex_protocol::protocol::TurnDiffEvent;
use codex_shell_command::parse_command::parse_command;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use super::format_exec_output_str;

/// 工具事件发射上下文，携带工具调用所需的共享引用。
///
/// 使用借用（`&'a`）以避免不必要的引用计数克隆，
/// 生命周期与发起工具调用的 turn 绑定。
#[derive(Clone, Copy)]
pub(crate) struct ToolEventCtx<'a> {
    /// 当前会话句柄。
    pub session: &'a Session,
    /// 当前 turn 上下文。
    pub turn: &'a TurnContext,
    /// 工具调用 ID。
    pub call_id: &'a str,
    /// 可选的 turn 级 diff tracker 共享句柄。
    pub turn_diff_tracker: Option<&'a SharedTurnDiffTracker>,
}

impl<'a> ToolEventCtx<'a> {
    /// 创建一个新的工具事件上下文。
    pub fn new(
        session: &'a Session,
        turn: &'a TurnContext,
        call_id: &'a str,
        turn_diff_tracker: Option<&'a SharedTurnDiffTracker>,
    ) -> Self {
        Self {
            session,
            turn,
            call_id,
            turn_diff_tracker,
        }
    }
}

/// 工具调用的阶段标识，用于驱动 `ToolEmitter::emit` 的分支逻辑。
pub(crate) enum ToolEventStage<'a> {
    /// 工具调用开始阶段。
    Begin,
    /// 工具调用成功完成阶段，携带输出与可选的 apply_patch delta。
    Success {
        /// 工具执行输出。
        output: ExecToolCallOutput,
        /// 已应用的 patch delta（用于 diff tracker 更新）。
        applied_patch_delta: Option<&'a AppliedPatchDelta>,
    },
    /// 工具调用失败阶段，携带具体失败信息。
    Failure(ToolEventFailure<'a>),
}

/// 工具调用失败的具体类型。
pub(crate) enum ToolEventFailure<'a> {
    /// 带有输出的失败（例如命令执行返回非零退出码）。
    Output(ExecToolCallOutput),
    /// 仅携带消息字符串的失败（例如内部错误）。
    Message(String),
    /// 被拒绝的失败（例如用户拒绝审批）。
    Rejected {
        /// 拒绝消息。
        message: String,
        /// 已应用的 patch delta（可能部分应用后才被拒绝）。
        applied_patch_delta: Option<&'a AppliedPatchDelta>,
    },
}

/// turn diff tracker 的更新策略。
enum TurnDiffTrackerUpdate<'a> {
    /// 追踪一个新的 patch delta。
    Track {
        /// 关联的 environment ID（用于隔离不同环境的改动）。
        environment_id: Option<String>,
        /// 待追踪的 patch delta。
        delta: &'a AppliedPatchDelta,
    },
    /// 失效整个 tracker（例如发生了不可追踪的改动）。
    Invalidate,
    /// 不更新 tracker。
    None,
}

/// 根据已知的 patch delta 计算对应的 tracker 更新策略。
///
/// 当 delta 为空且精确（exact）时返回 `None`，否则返回 `Track`。
fn tracker_update_for_known_delta<'a>(
    environment_id: Option<&str>,
    delta: &'a AppliedPatchDelta,
) -> TurnDiffTrackerUpdate<'a> {
    if delta.is_exact() && delta.is_empty() {
        TurnDiffTrackerUpdate::None
    } else {
        TurnDiffTrackerUpdate::Track {
            environment_id: environment_id.map(str::to_string),
            delta,
        }
    }
}

/// 发射 `ExecCommandBegin` 事件，表示命令执行开始。
pub(crate) async fn emit_exec_command_begin(
    ctx: ToolEventCtx<'_>,
    command: &[String],
    cwd: &PathUri,
    parsed_cmd: &[ParsedCommand],
    source: ExecCommandSource,
    interaction_input: Option<String>,
    process_id: Option<&str>,
) {
    ctx.session
        .send_event(
            ctx.turn,
            EventMsg::ExecCommandBegin(ExecCommandBeginEvent {
                call_id: ctx.call_id.to_string(),
                process_id: process_id.map(str::to_owned),
                turn_id: ctx.turn.sub_id.clone(),
                started_at_ms: now_unix_timestamp_ms(),
                command: command.to_vec(),
                cwd: cwd.clone(),
                parsed_cmd: parsed_cmd.to_vec(),
                source,
                interaction_input,
            }),
        )
        .await;
}

// 具体类型、无分配的发射器：避免使用 trait object 与 boxed future。
/// 工具事件发射器枚举，针对不同工具类型提供专用的事件构造逻辑。
///
/// 使用具体枚举而非 trait object 以避免堆分配与动态分发开销。
pub(crate) enum ToolEmitter {
    /// Shell 命令发射器。
    Shell {
        /// 命令参数列表。
        command: Vec<String>,
        /// 工作目录。
        cwd: PathUri,
        /// 命令来源（如模型发起、hook 发起等）。
        source: ExecCommandSource,
        /// 解析后的命令结构（用于事件透传）。
        parsed_cmd: Vec<ParsedCommand>,
    },
    /// apply_patch 工具发射器。
    ApplyPatch {
        /// 文件变更映射表。
        changes: HashMap<PathBuf, FileChange>,
        /// 是否自动批准（无需用户确认）。
        auto_approved: bool,
        /// 关联的 environment ID。
        environment_id: Option<String>,
    },
    /// unified_exec 工具发射器。
    UnifiedExec {
        /// 命令参数列表。
        command: Vec<String>,
        /// 工作目录。
        cwd: PathUri,
        /// 命令来源。
        source: ExecCommandSource,
        /// 解析后的命令结构。
        parsed_cmd: Vec<ParsedCommand>,
        /// 关联的进程 ID（若已启动）。
        process_id: Option<String>,
    },
}

impl ToolEmitter {
    /// 创建一个 Shell 命令发射器，自动解析命令结构。
    pub fn shell(command: Vec<String>, cwd: AbsolutePathBuf, source: ExecCommandSource) -> Self {
        let parsed_cmd = parse_command(&command);
        Self::Shell {
            command,
            cwd: PathUri::from_abs_path(&cwd),
            source,
            parsed_cmd,
        }
    }

    /// 创建一个关联指定 environment 的 apply_patch 发射器。
    pub fn apply_patch_for_environment(
        changes: HashMap<PathBuf, FileChange>,
        auto_approved: bool,
        environment_id: String,
    ) -> Self {
        Self::ApplyPatch {
            changes,
            auto_approved,
            environment_id: Some(environment_id),
        }
    }

    /// 创建一个 unified_exec 发射器，自动解析命令结构。
    pub fn unified_exec(
        command: &[String],
        cwd: PathUri,
        source: ExecCommandSource,
        process_id: Option<String>,
    ) -> Self {
        let parsed_cmd = parse_command(command);
        Self::UnifiedExec {
            command: command.to_vec(),
            cwd,
            source,
            parsed_cmd,
            process_id,
        }
    }

    /// 根据阶段（Begin/Success/Failure）发射对应事件。
    ///
    /// 内部根据发射器类型与阶段的组合，分发到具体的事件构造逻辑。
    pub async fn emit(&self, ctx: ToolEventCtx<'_>, stage: ToolEventStage<'_>) {
        match (self, stage) {
            (
                Self::Shell {
                    command,
                    cwd,
                    source,
                    parsed_cmd,
                    ..
                },
                stage,
            ) => {
                emit_exec_stage(
                    ctx,
                    ExecCommandInput::new(
                        command, cwd, parsed_cmd, *source, /*interaction_input*/ None,
                        /*process_id*/ None,
                    ),
                    stage,
                )
                .await;
            }

            (
                Self::ApplyPatch {
                    changes,
                    auto_approved,
                    ..
                },
                ToolEventStage::Begin,
            ) => {
                ctx.session
                    .emit_turn_item_started(
                        ctx.turn,
                        &TurnItem::FileChange(FileChangeItem {
                            id: ctx.call_id.to_string(),
                            changes: changes.clone(),
                            status: None,
                            auto_approved: Some(*auto_approved),
                            stdout: None,
                            stderr: None,
                        }),
                    )
                    .await;
            }
            (
                Self::ApplyPatch {
                    changes,
                    environment_id,
                    ..
                },
                ToolEventStage::Success {
                    output,
                    applied_patch_delta,
                },
            ) => {
                let status = if output.exit_code == 0 {
                    PatchApplyStatus::Completed
                } else {
                    PatchApplyStatus::Failed
                };
                let tracker_update = applied_patch_delta
                    .map(|delta| tracker_update_for_known_delta(environment_id.as_deref(), delta))
                    .unwrap_or(TurnDiffTrackerUpdate::Invalidate);
                emit_patch_end(
                    ctx,
                    changes.clone(),
                    output.stdout.text.clone(),
                    output.stderr.text.clone(),
                    status,
                    tracker_update,
                )
                .await;
            }
            (
                Self::ApplyPatch { changes, .. },
                ToolEventStage::Failure(ToolEventFailure::Output(output)),
            ) => {
                emit_patch_end(
                    ctx,
                    changes.clone(),
                    output.stdout.text.clone(),
                    output.stderr.text.clone(),
                    if output.exit_code == 0 {
                        PatchApplyStatus::Completed
                    } else {
                        PatchApplyStatus::Failed
                    },
                    TurnDiffTrackerUpdate::Invalidate,
                )
                .await;
            }
            (
                Self::ApplyPatch { changes, .. },
                ToolEventStage::Failure(ToolEventFailure::Message(message)),
            ) => {
                emit_patch_end(
                    ctx,
                    changes.clone(),
                    String::new(),
                    (*message).to_string(),
                    PatchApplyStatus::Failed,
                    TurnDiffTrackerUpdate::None,
                )
                .await;
            }
            (
                Self::ApplyPatch {
                    changes,
                    environment_id,
                    ..
                },
                ToolEventStage::Failure(ToolEventFailure::Rejected {
                    message,
                    applied_patch_delta,
                }),
            ) => {
                emit_patch_end(
                    ctx,
                    changes.clone(),
                    String::new(),
                    (*message).to_string(),
                    PatchApplyStatus::Declined,
                    applied_patch_delta
                        .map(|delta| {
                            tracker_update_for_known_delta(environment_id.as_deref(), delta)
                        })
                        .unwrap_or(TurnDiffTrackerUpdate::None),
                )
                .await;
            }
            (
                Self::UnifiedExec {
                    command,
                    cwd,
                    source,
                    parsed_cmd,
                    process_id,
                },
                stage,
            ) => {
                emit_exec_stage(
                    ctx,
                    ExecCommandInput::new(
                        command,
                        cwd,
                        parsed_cmd,
                        *source,
                        /*interaction_input*/ None,
                        process_id.as_deref(),
                    ),
                    stage,
                )
                .await;
            }
        }
    }

    /// 发射工具调用开始事件。
    pub async fn begin(&self, ctx: ToolEventCtx<'_>) {
        self.emit(ctx, ToolEventStage::Begin).await;
    }

    /// 按当前 turn 的截断策略格式化执行输出，供回传模型使用。
    fn format_exec_output_for_model(
        &self,
        output: &ExecToolCallOutput,
        ctx: ToolEventCtx<'_>,
    ) -> String {
        super::format_exec_output_for_model(output, ctx.turn.model_info.truncation_policy.into())
    }

    /// 处理工具执行结果并发射对应事件，返回模型可见的响应字符串。
    ///
    /// 根据执行结果的退出码或错误类型构造对应的事件阶段，
    /// 并在事件发射后返回 `Ok(content)`（成功）或
    /// `Err(FunctionCallError::RespondToModel(content))`（失败但仍回传模型）。
    pub async fn finish(
        &self,
        ctx: ToolEventCtx<'_>,
        out: Result<ExecToolCallOutput, ToolError>,
        applied_patch_delta: Option<&AppliedPatchDelta>,
    ) -> Result<String, FunctionCallError> {
        let (event, result) = match out {
            Ok(output) => {
                let content = self.format_exec_output_for_model(&output, ctx);
                let exit_code = output.exit_code;
                let event = ToolEventStage::Success {
                    output,
                    applied_patch_delta,
                };
                let result = if exit_code == 0 {
                    Ok(content)
                } else {
                    Err(FunctionCallError::RespondToModel(content))
                };
                (event, result)
            }
            Err(ToolError::Codex(CodexErr::Sandbox(SandboxErr::Timeout { output }))) => {
                let response = self.format_exec_output_for_model(&output, ctx);
                let event = ToolEventStage::Failure(ToolEventFailure::Output(*output));
                let result = Err(FunctionCallError::RespondToModel(response));
                (event, result)
            }
            Err(ToolError::Codex(CodexErr::Sandbox(SandboxErr::Denied { output, .. }))) => {
                let response = self.format_exec_output_for_model(&output, ctx);
                // apply_patch 可能在已经提交了一段已知前缀后才被拒绝。
                // 复用带输出的路径，使可见项仍然失败，同时让 turn diff 消费该前缀。
                let event = match (self, applied_patch_delta) {
                    (Self::ApplyPatch { .. }, Some(delta)) => ToolEventStage::Success {
                        output: *output,
                        applied_patch_delta: Some(delta),
                    },
                    _ => ToolEventStage::Failure(ToolEventFailure::Output(*output)),
                };
                let result = Err(FunctionCallError::RespondToModel(response));
                (event, result)
            }
            Err(ToolError::Codex(err)) => {
                let message = format!("execution error: {err:?}");
                let event = ToolEventStage::Failure(ToolEventFailure::Message(message.clone()));
                let result = Err(FunctionCallError::RespondToModel(message));
                (event, result)
            }
            Err(ToolError::Rejected(msg)) => {
                // 对 exec 工具的常见拒绝消息做归一化，使测试与用户看到清晰一致的措辞。
                //
                // 注意：ToolError::Rejected 目前既用于用户拒绝审批，也用于部分运行时拒绝路径
                // （例如 setup 失败）。这里有意将所有拒绝都映射到 "rejected" 事件路径，
                // 因此部分非用户原因的失败可能也会被报告为 Declined。
                //
                // TODO: 应为用户拒绝审批新增一个独立的 ToolError 变体。
                let normalized = if msg == "rejected by user" {
                    match self {
                        Self::Shell { .. } | Self::UnifiedExec { .. } => {
                            "exec command rejected by user".to_string()
                        }
                        Self::ApplyPatch { .. } => "patch rejected by user".to_string(),
                    }
                } else {
                    msg
                };
                let event = ToolEventStage::Failure(ToolEventFailure::Rejected {
                    message: normalized.clone(),
                    applied_patch_delta,
                });
                let result = Err(FunctionCallError::RespondToModel(normalized));
                (event, result)
            }
        };
        self.emit(ctx, event).await;
        result
    }
}

/// exec 命令的输入参数聚合结构，用于在内部函数间传递。
struct ExecCommandInput<'a> {
    /// 命令参数列表。
    command: &'a [String],
    /// 工作目录。
    cwd: &'a PathUri,
    /// 解析后的命令结构。
    parsed_cmd: &'a [ParsedCommand],
    /// 命令来源。
    source: ExecCommandSource,
    /// 交互式输入（可选）。
    interaction_input: Option<&'a str>,
    /// 关联的进程 ID（可选）。
    process_id: Option<&'a str>,
}

impl<'a> ExecCommandInput<'a> {
    /// 创建一个新的 `ExecCommandInput`。
    fn new(
        command: &'a [String],
        cwd: &'a PathUri,
        parsed_cmd: &'a [ParsedCommand],
        source: ExecCommandSource,
        interaction_input: Option<&'a str>,
        process_id: Option<&'a str>,
    ) -> Self {
        Self {
            command,
            cwd,
            parsed_cmd,
            source,
            interaction_input,
            process_id,
        }
    }
}

/// exec 命令的执行结果聚合结构，用于构造 `ExecCommandEnd` 事件。
struct ExecCommandResult {
    /// 标准输出文本。
    stdout: String,
    /// 标准错误文本。
    stderr: String,
    /// 聚合输出（stdout + stderr）。
    aggregated_output: String,
    /// 退出码。
    exit_code: i32,
    /// 执行耗时。
    duration: Duration,
    /// 按截断策略格式化后的输出（供模型可见）。
    formatted_output: String,
    /// 执行状态（Completed/Failed/Declined）。
    status: ExecCommandStatus,
}

/// 根据阶段发射 exec 命令事件（开始或结束）。
///
/// 对 Begin 阶段调用 `emit_exec_command_begin`，
/// 对 Success/Failure 阶段构造 `ExecCommandResult` 后调用 `emit_exec_end`。
async fn emit_exec_stage(
    ctx: ToolEventCtx<'_>,
    exec_input: ExecCommandInput<'_>,
    stage: ToolEventStage<'_>,
) {
    match stage {
        ToolEventStage::Begin => {
            emit_exec_command_begin(
                ctx,
                exec_input.command,
                exec_input.cwd,
                exec_input.parsed_cmd,
                exec_input.source,
                exec_input.interaction_input.map(str::to_owned),
                exec_input.process_id,
            )
            .await;
        }
        ToolEventStage::Success { output, .. }
        | ToolEventStage::Failure(ToolEventFailure::Output(output)) => {
            let exec_result = ExecCommandResult {
                stdout: output.stdout.text.clone(),
                stderr: output.stderr.text.clone(),
                aggregated_output: output.aggregated_output.text.clone(),
                exit_code: output.exit_code,
                duration: output.duration,
                formatted_output: format_exec_output_str(
                    &output,
                    ctx.turn.model_info.truncation_policy.into(),
                ),
                status: if output.exit_code == 0 {
                    ExecCommandStatus::Completed
                } else {
                    ExecCommandStatus::Failed
                },
            };
            emit_exec_end(ctx, exec_input, exec_result).await;
        }
        ToolEventStage::Failure(ToolEventFailure::Message(message)) => {
            let text = message.to_string();
            let exec_result = ExecCommandResult {
                stdout: String::new(),
                stderr: text.clone(),
                aggregated_output: text.clone(),
                exit_code: -1,
                duration: Duration::ZERO,
                formatted_output: text,
                status: ExecCommandStatus::Failed,
            };
            emit_exec_end(ctx, exec_input, exec_result).await;
        }
        ToolEventStage::Failure(ToolEventFailure::Rejected { message, .. }) => {
            let text = message.to_string();
            let exec_result = ExecCommandResult {
                stdout: String::new(),
                stderr: text.clone(),
                aggregated_output: text.clone(),
                exit_code: -1,
                duration: Duration::ZERO,
                formatted_output: text,
                status: ExecCommandStatus::Declined,
            };
            emit_exec_end(ctx, exec_input, exec_result).await;
        }
    }
}

/// 发射 `ExecCommandEnd` 事件，表示命令执行结束。
async fn emit_exec_end(
    ctx: ToolEventCtx<'_>,
    exec_input: ExecCommandInput<'_>,
    exec_result: ExecCommandResult,
) {
    ctx.session
        .send_event(
            ctx.turn,
            EventMsg::ExecCommandEnd(ExecCommandEndEvent {
                call_id: ctx.call_id.to_string(),
                process_id: exec_input.process_id.map(str::to_owned),
                turn_id: ctx.turn.sub_id.clone(),
                completed_at_ms: now_unix_timestamp_ms(),
                command: exec_input.command.to_vec(),
                cwd: exec_input.cwd.clone(),
                parsed_cmd: exec_input.parsed_cmd.to_vec(),
                source: exec_input.source,
                interaction_input: exec_input.interaction_input.map(str::to_owned),
                stdout: exec_result.stdout,
                stderr: exec_result.stderr,
                aggregated_output: exec_result.aggregated_output,
                exit_code: exec_result.exit_code,
                duration: exec_result.duration,
                formatted_output: exec_result.formatted_output,
                status: exec_result.status,
            }),
        )
        .await;
}

/// 发射 apply_patch 结束事件（`FileChange` 项完成），并按需更新 turn diff tracker。
///
/// 根据 `tracker_update` 策略更新 diff tracker，并在 tracker 发生变化时
/// 发射 `TurnDiff` 事件，使前端可感知到本 turn 的文件改动累积情况。
async fn emit_patch_end(
    ctx: ToolEventCtx<'_>,
    changes: HashMap<PathBuf, FileChange>,
    stdout: String,
    stderr: String,
    status: PatchApplyStatus,
    tracker_update: TurnDiffTrackerUpdate<'_>,
) {
    ctx.session
        .emit_turn_item_completed(
            ctx.turn,
            TurnItem::FileChange(FileChangeItem {
                id: ctx.call_id.to_string(),
                changes,
                status: Some(status),
                auto_approved: None,
                stdout: Some(stdout),
                stderr: Some(stderr),
            }),
        )
        .await;

    if let Some(tracker) = ctx.turn_diff_tracker {
        let (should_emit_turn_diff, unified_diff) = {
            let mut guard = tracker.lock().await;
            let had_unified_diff = guard.has_unified_diff();
            let tracker_changed = match tracker_update {
                TurnDiffTrackerUpdate::Track {
                    environment_id,
                    delta,
                } => {
                    guard.track_delta(environment_id.as_deref().unwrap_or_default(), delta);
                    true
                }
                TurnDiffTrackerUpdate::Invalidate => {
                    guard.invalidate();
                    true
                }
                TurnDiffTrackerUpdate::None => false,
            };
            let unified_diff = guard.get_unified_diff();
            (
                tracker_changed && (had_unified_diff || unified_diff.is_some()),
                unified_diff.unwrap_or_default(),
            )
        };
        if should_emit_turn_diff {
            ctx.session
                .send_event(ctx.turn, EventMsg::TurnDiff(TurnDiffEvent { unified_diff }))
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::tests::make_session_and_context_with_dynamic_tools_and_rx;
    use crate::turn_diff_tracker::TurnDiffTracker;
    use codex_exec_server::LOCAL_FS;
    use codex_protocol::error::CodexErr;
    use codex_protocol::error::SandboxErr;
    use codex_protocol::exec_output::ExecToolCallOutput;
    use codex_protocol::items::TurnItem;
    use codex_protocol::protocol::PatchApplyStatus;
    use codex_utils_path_uri::PathUri;
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::Mutex;

    async fn assert_failed_apply_patch_tracks_committed_delta(
        out: Result<ExecToolCallOutput, ToolError>,
        expected_status: PatchApplyStatus,
    ) {
        let (session, turn, rx_event) =
            make_session_and_context_with_dynamic_tools_and_rx(Vec::new()).await;
        let tracker = Arc::new(Mutex::new(TurnDiffTracker::new()));
        let dir = tempdir().expect("tempdir");
        let cwd = PathUri::from_host_native_path(dir.path()).expect("absolute cwd");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let delta = codex_apply_patch::apply_patch(
            "*** Begin Patch\n*** Add File: out/dest.txt\n+after\n*** End Patch",
            &cwd,
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .expect("apply patch");

        ToolEmitter::ApplyPatch {
            changes: HashMap::new(),
            auto_approved: false,
            environment_id: None,
        }
        .finish(
            ToolEventCtx::new(session.as_ref(), turn.as_ref(), "call-id", Some(&tracker)),
            out,
            Some(&delta),
        )
        .await
        .expect_err("failed patch");

        let completed = rx_event.recv().await.expect("item completed event");
        assert!(matches!(
            completed.msg,
            EventMsg::ItemCompleted(event)
                if matches!(
                    &event.item,
                    TurnItem::FileChange(FileChangeItem {
                        status: Some(status),
                        ..
                    }) if status == &expected_status
                )
        ));

        let unified_diff = loop {
            let event = tokio::time::timeout(Duration::from_secs(1), rx_event.recv())
                .await
                .expect("turn diff event")
                .expect("channel open");
            if let EventMsg::TurnDiff(TurnDiffEvent { unified_diff }) = event.msg {
                break unified_diff;
            }
        };
        assert!(unified_diff.contains("out/dest.txt"));
        assert!(unified_diff.contains("+after"));
    }

    #[tokio::test]
    async fn denied_apply_patch_tracks_committed_delta() {
        let output = ExecToolCallOutput {
            exit_code: 1,
            ..Default::default()
        };
        assert_failed_apply_patch_tracks_committed_delta(
            Err(ToolError::Codex(CodexErr::Sandbox(SandboxErr::Denied {
                output: Box::new(output),
                network_policy_decision: None,
            }))),
            PatchApplyStatus::Failed,
        )
        .await;
    }

    #[tokio::test]
    async fn rejected_apply_patch_tracks_committed_delta() {
        assert_failed_apply_patch_tracks_committed_delta(
            Err(ToolError::Rejected("rejected by user".to_string())),
            PatchApplyStatus::Declined,
        )
        .await;
    }

    #[tokio::test]
    async fn net_zero_patch_emits_empty_turn_diff() {
        let (session, turn, rx_event) =
            make_session_and_context_with_dynamic_tools_and_rx(Vec::new()).await;
        let tracker = Arc::new(Mutex::new(TurnDiffTracker::new()));
        let dir = tempdir().expect("tempdir");
        let cwd = PathUri::from_host_native_path(dir.path()).expect("absolute cwd");

        for patch in [
            "*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch",
            "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch",
        ] {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let delta = codex_apply_patch::apply_patch(
                patch,
                &cwd,
                &mut stdout,
                &mut stderr,
                LOCAL_FS.as_ref(),
                /*sandbox*/ None,
            )
            .await
            .expect("apply patch");

            emit_patch_end(
                ToolEventCtx::new(session.as_ref(), turn.as_ref(), "call-id", Some(&tracker)),
                HashMap::new(),
                String::new(),
                String::new(),
                PatchApplyStatus::Completed,
                TurnDiffTrackerUpdate::Track {
                    environment_id: None,
                    delta: &delta,
                },
            )
            .await;

            rx_event.recv().await.expect("item completed event");
            let unified_diff = loop {
                let event = rx_event.recv().await.expect("turn diff event");
                if let EventMsg::TurnDiff(TurnDiffEvent { unified_diff }) = event.msg {
                    break unified_diff;
                }
            };
            if patch.contains("Delete File") {
                assert_eq!(unified_diff, "");
            } else {
                assert!(unified_diff.contains("+one"));
            }
        }
    }

    #[tokio::test]
    async fn invalidation_emits_empty_turn_diff() {
        let (session, turn, rx_event) =
            make_session_and_context_with_dynamic_tools_and_rx(Vec::new()).await;
        let tracker = Arc::new(Mutex::new(TurnDiffTracker::new()));
        let dir = tempdir().expect("tempdir");
        let cwd = PathUri::from_host_native_path(dir.path()).expect("absolute cwd");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let delta = codex_apply_patch::apply_patch(
            "*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch",
            &cwd,
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .expect("apply patch");
        tracker.lock().await.track_delta("", &delta);

        emit_patch_end(
            ToolEventCtx::new(session.as_ref(), turn.as_ref(), "call-id", Some(&tracker)),
            HashMap::new(),
            String::new(),
            String::new(),
            PatchApplyStatus::Completed,
            TurnDiffTrackerUpdate::Invalidate,
        )
        .await;

        rx_event.recv().await.expect("item completed event");
        loop {
            let event = rx_event.recv().await.expect("turn diff event");
            if let EventMsg::TurnDiff(TurnDiffEvent { unified_diff }) = event.msg {
                assert_eq!(unified_diff, "");
                break;
            }
        }
    }
}
