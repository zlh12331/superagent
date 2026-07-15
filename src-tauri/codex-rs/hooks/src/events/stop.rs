//! Stop / SubagentStop 钩子事件实现。
//!
//! Stop 钩子允许在 agent 一轮结束前进行拦截。返回 `decision:block` 时
//! 会附带一个 continuation prompt，让 agent 继续工作。退出码 2 在
//! stderr 中提供 continuation prompt 的简写形式。

use std::path::PathBuf;

use codex_protocol::ThreadId;
use codex_protocol::items::HookPromptFragment;
use codex_protocol::protocol::HookCompletedEvent;
use codex_protocol::protocol::HookEventName;
use codex_protocol::protocol::HookOutputEntry;
use codex_protocol::protocol::HookOutputEntryKind;
use codex_protocol::protocol::HookRunStatus;
use codex_protocol::protocol::HookRunSummary;
use codex_utils_absolute_path::AbsolutePathBuf;

use super::common;
use crate::engine::CommandShell;
use crate::engine::ConfiguredHandler;
use crate::engine::command_runner::CommandRunResult;
use crate::engine::dispatcher;
use crate::engine::output_parser;
use crate::schema::NullableString;
use crate::schema::StopCommandInput;
use crate::schema::SubagentStopCommandInput;

/// Stop 钩子的请求负载。
#[derive(Debug, Clone)]
pub struct StopRequest {
    /// 当前会话 ID。
    pub session_id: ThreadId,
    /// 当前 turn ID。
    pub turn_id: String,
    /// 当前工作目录。
    pub cwd: AbsolutePathBuf,
    /// transcript 文件路径（可选）。
    pub transcript_path: Option<PathBuf>,
    /// 当前使用的模型名。
    pub model: String,
    /// 当前权限模式。
    pub permission_mode: String,
    /// 是否已经处于 stop hook 激活状态，避免无限递归。
    pub stop_hook_active: bool,
    /// 最近一条 assistant 消息内容（可选）。
    pub last_assistant_message: Option<String>,
    /// 目标事件类型（Stop 或 SubagentStop）。
    pub target: StopHookTarget,
}

/// Stop 钩子的目标类型，区分根会话与子代理。
#[derive(Debug, Clone)]
pub enum StopHookTarget {
    /// 根会话的 Stop 事件。
    Stop,
    /// 子代理的 SubagentStop 事件。
    SubagentStop {
        /// 子代理 ID。
        agent_id: String,
        /// 子代理类型。
        agent_type: String,
        /// 子代理 transcript 路径（可选）。
        agent_transcript_path: Option<PathBuf>,
    },
}

impl StopHookTarget {
    /// 返回该目标对应的事件类型。
    fn event_name(&self) -> HookEventName {
        match self {
            Self::Stop => HookEventName::Stop,
            Self::SubagentStop { .. } => HookEventName::SubagentStop,
        }
    }

    /// 返回用于 matcher 的输入：SubagentStop 使用 agent_type，Stop 无。
    fn matcher_input(&self) -> Option<&str> {
        match self {
            Self::Stop => None,
            Self::SubagentStop { agent_type, .. } => Some(agent_type.as_str()),
        }
    }
}

/// Stop 钩子的执行结果。
#[derive(Debug, Default)]
pub struct StopOutcome {
    /// 各 handler 的完成事件。
    pub hook_events: Vec<HookCompletedEvent>,
    /// 是否应停止整个流程。
    pub should_stop: bool,
    /// 停止原因。
    pub stop_reason: Option<String>,
    /// 是否应阻塞结束并要求 agent 继续。
    pub should_block: bool,
    /// 阻塞原因，作为 continuation prompt 传给 agent。
    pub block_reason: Option<String>,
    /// continuation prompt 片段，供模型上下文使用。
    pub continuation_fragments: Vec<HookPromptFragment>,
}

/// 单个 Stop handler 的中间数据。
#[derive(Debug, Default, PartialEq, Eq)]
struct StopHandlerData {
    should_stop: bool,
    stop_reason: Option<String>,
    should_block: bool,
    block_reason: Option<String>,
    continuation_fragments: Vec<HookPromptFragment>,
}

/// 预览 Stop 事件下匹配的 handler。
pub(crate) fn preview(
    handlers: &[ConfiguredHandler],
    request: &StopRequest,
) -> Vec<HookRunSummary> {
    dispatcher::select_handlers(
        handlers,
        request.target.event_name(),
        request.target.matcher_input(),
    )
    .into_iter()
    .map(|handler| dispatcher::running_summary(&handler))
    .collect()
}

/// 实际运行 Stop 钩子，根据目标类型分发到不同的输入 schema。
pub(crate) async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: StopRequest,
) -> StopOutcome {
    let matched = dispatcher::select_handlers(
        handlers,
        request.target.event_name(),
        request.target.matcher_input(),
    );
    if matched.is_empty() {
        return StopOutcome {
            hook_events: Vec::new(),
            should_stop: false,
            stop_reason: None,
            should_block: false,
            block_reason: None,
            continuation_fragments: Vec::new(),
        };
    }

    let input_json = match request.target {
        StopHookTarget::Stop => {
            let input = StopCommandInput {
                session_id: request.session_id.to_string(),
                turn_id: request.turn_id.clone(),
                transcript_path: NullableString::from_path(request.transcript_path.clone()),
                cwd: request.cwd.display().to_string(),
                hook_event_name: "Stop".to_string(),
                model: request.model.clone(),
                permission_mode: request.permission_mode.clone(),
                stop_hook_active: request.stop_hook_active,
                last_assistant_message: NullableString::from_string(
                    request.last_assistant_message.clone(),
                ),
            };
            match serde_json::to_string(&input) {
                Ok(input_json) => input_json,
                Err(error) => {
                    return serialization_failure_outcome(
                        common::serialization_failure_hook_events(
                            matched,
                            Some(request.turn_id),
                            format!("failed to serialize stop hook input: {error}"),
                        ),
                    );
                }
            }
        }
        StopHookTarget::SubagentStop {
            agent_id,
            agent_type,
            agent_transcript_path,
        } => {
            let input = SubagentStopCommandInput {
                session_id: request.session_id.to_string(),
                turn_id: request.turn_id.clone(),
                transcript_path: NullableString::from_path(request.transcript_path.clone()),
                agent_transcript_path: NullableString::from_path(agent_transcript_path),
                cwd: request.cwd.display().to_string(),
                hook_event_name: "SubagentStop".to_string(),
                model: request.model.clone(),
                permission_mode: request.permission_mode.clone(),
                stop_hook_active: request.stop_hook_active,
                agent_id,
                agent_type,
                last_assistant_message: NullableString::from_string(
                    request.last_assistant_message.clone(),
                ),
            };
            match serde_json::to_string(&input) {
                Ok(input_json) => input_json,
                Err(error) => {
                    return serialization_failure_outcome(
                        common::serialization_failure_hook_events(
                            matched,
                            Some(request.turn_id),
                            format!("failed to serialize subagent stop hook input: {error}"),
                        ),
                    );
                }
            }
        }
    };

    let results = dispatcher::execute_handlers(
        shell,
        matched,
        input_json,
        request.cwd.as_path(),
        Some(request.turn_id),
        parse_completed,
    )
    .await;

    let aggregate = aggregate_results(results.iter().map(|result| &result.data));

    StopOutcome {
        hook_events: results.into_iter().map(|result| result.completed).collect(),
        should_stop: aggregate.should_stop,
        stop_reason: aggregate.stop_reason,
        should_block: aggregate.should_block,
        block_reason: aggregate.block_reason,
        continuation_fragments: aggregate.continuation_fragments,
    }
}

/// 解析 Stop / SubagentStop handler 的命令输出。
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<StopHandlerData> {
    let mut entries = Vec::new();
    let mut status = HookRunStatus::Completed;
    let mut should_stop = false;
    let mut stop_reason = None;
    let mut should_block = false;
    let mut block_reason = None;
    let mut continuation_prompt = None;
    let hook_event_name = match handler.event_name {
        HookEventName::Stop | HookEventName::SubagentStop => handler.event_name,
        event_name => {
            panic!("expected stop hook event, got {event_name:?}");
        }
    };

    match run_result.error.as_deref() {
        Some(error) => {
            status = HookRunStatus::Failed;
            entries.push(HookOutputEntry {
                kind: HookOutputEntryKind::Error,
                text: error.to_string(),
            });
        }
        None => match run_result.exit_code {
            Some(0) => {
                let trimmed_stdout = run_result.stdout.trim();
                if trimmed_stdout.is_empty() {
                } else if let Some(parsed) = match hook_event_name {
                    HookEventName::Stop => output_parser::parse_stop(&run_result.stdout),
                    HookEventName::SubagentStop => {
                        output_parser::parse_subagent_stop(&run_result.stdout)
                    }
                    _ => unreachable!("validated stop hook event"),
                } {
                    if let Some(system_message) = parsed.universal.system_message {
                        entries.push(HookOutputEntry {
                            kind: HookOutputEntryKind::Warning,
                            text: system_message,
                        });
                    }
                    let _ = parsed.universal.suppress_output;
                    if !parsed.universal.continue_processing {
                        status = HookRunStatus::Stopped;
                        should_stop = true;
                        stop_reason = parsed.universal.stop_reason.clone();
                        if let Some(stop_reason_text) = parsed.universal.stop_reason {
                            entries.push(HookOutputEntry {
                                kind: HookOutputEntryKind::Stop,
                                text: stop_reason_text,
                            });
                        }
                    } else if let Some(invalid_block_reason) = parsed.invalid_block_reason {
                        status = HookRunStatus::Failed;
                        entries.push(HookOutputEntry {
                            kind: HookOutputEntryKind::Error,
                            text: invalid_block_reason,
                        });
                    } else if parsed.should_block {
                        if let Some(reason) =
                            parsed.reason.as_deref().and_then(common::trimmed_non_empty)
                        {
                            status = HookRunStatus::Blocked;
                            should_block = true;
                            block_reason = Some(reason.clone());
                            continuation_prompt = Some(reason.clone());
                            entries.push(HookOutputEntry {
                                kind: HookOutputEntryKind::Feedback,
                                text: reason,
                            });
                        } else {
                            status = HookRunStatus::Failed;
                            entries.push(HookOutputEntry {
                                kind: HookOutputEntryKind::Error,
                                text: match hook_event_name {
                                    HookEventName::Stop => "Stop hook returned decision:block without a non-empty reason",
                                    HookEventName::SubagentStop => "SubagentStop hook returned decision:block without a non-empty reason",
                                    _ => unreachable!("validated stop hook event"),
                                }
                                .to_string(),
                            });
                        }
                    }
                } else {
                    status = HookRunStatus::Failed;
                    entries.push(HookOutputEntry {
                        kind: HookOutputEntryKind::Error,
                        text: match hook_event_name {
                            HookEventName::Stop => "hook returned invalid stop hook JSON output",
                            HookEventName::SubagentStop => {
                                "hook returned invalid subagent stop hook JSON output"
                            }
                            _ => unreachable!("validated stop hook event"),
                        }
                        .to_string(),
                    });
                }
            }
            Some(2) => {
                // 退出码 2 表示要求 agent 继续：stderr 作为 continuation prompt。
                if let Some(reason) = common::trimmed_non_empty(&run_result.stderr) {
                    status = HookRunStatus::Blocked;
                    should_block = true;
                    block_reason = Some(reason.clone());
                    continuation_prompt = Some(reason.clone());
                    entries.push(HookOutputEntry {
                        kind: HookOutputEntryKind::Feedback,
                        text: reason,
                    });
                } else {
                    status = HookRunStatus::Failed;
                    entries.push(HookOutputEntry {
                        kind: HookOutputEntryKind::Error,
                        text: match hook_event_name {
                            HookEventName::Stop => {
                                "Stop hook exited with code 2 but did not write a continuation prompt to stderr"
                            }
                            HookEventName::SubagentStop => {
                                "SubagentStop hook exited with code 2 but did not write a continuation prompt to stderr"
                            }
                            _ => unreachable!("validated stop hook event"),
                        }
                        .to_string(),
                    });
                }
            }
            Some(exit_code) => {
                status = HookRunStatus::Failed;
                entries.push(HookOutputEntry {
                    kind: HookOutputEntryKind::Error,
                    text: format!("hook exited with code {exit_code}"),
                });
            }
            None => {
                status = HookRunStatus::Failed;
                entries.push(HookOutputEntry {
                    kind: HookOutputEntryKind::Error,
                    text: "hook exited without a status code".to_string(),
                });
            }
        },
    }

    let completed = HookCompletedEvent {
        turn_id,
        run: dispatcher::completed_summary(handler, &run_result, status, entries),
    };
    let continuation_fragments = continuation_prompt
        .map(|prompt| {
            vec![HookPromptFragment::from_single_hook(
                prompt,
                completed.run.id.clone(),
            )]
        })
        .unwrap_or_default();

    dispatcher::ParsedHandler {
        completed,
        data: StopHandlerData {
            should_stop,
            stop_reason,
            should_block,
            block_reason,
            continuation_fragments,
        },
        completion_order: 0,
    }
}

/// 聚合多个 handler 的中间数据，得到最终的 [`StopHandlerData`]。
///
/// - 任一 handler 要求停止即视为应停止。
/// - 在没有 handler 要求停止时，任一 handler 要求阻塞即视为应阻塞。
/// - 阻塞原因按声明顺序拼接。
fn aggregate_results<'a>(
    results: impl IntoIterator<Item = &'a StopHandlerData>,
) -> StopHandlerData {
    let results = results.into_iter().collect::<Vec<_>>();
    let should_stop = results.iter().any(|result| result.should_stop);
    let stop_reason = results.iter().find_map(|result| result.stop_reason.clone());
    let should_block = !should_stop && results.iter().any(|result| result.should_block);
    let block_reason = if should_block {
        common::join_text_chunks(
            results
                .iter()
                .filter_map(|result| result.block_reason.clone())
                .collect(),
        )
    } else {
        None
    };
    let continuation_fragments = if should_block {
        results
            .iter()
            .filter(|result| result.should_block)
            .flat_map(|result| result.continuation_fragments.clone())
            .collect()
    } else {
        Vec::new()
    };

    StopHandlerData {
        should_stop,
        stop_reason,
        should_block,
        block_reason,
        continuation_fragments,
    }
}

/// 构造序列化失败时的 [`StopOutcome`]，所有字段除 hook_events 外均为默认值。
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> StopOutcome {
    StopOutcome {
        hook_events,
        should_stop: false,
        stop_reason: None,
        should_block: false,
        block_reason: None,
        continuation_fragments: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use codex_protocol::protocol::HookEventName;
    use codex_protocol::protocol::HookOutputEntry;
    use codex_protocol::protocol::HookOutputEntryKind;
    use codex_protocol::protocol::HookRunStatus;
    use codex_utils_absolute_path::test_support::PathBufExt;
    use codex_utils_absolute_path::test_support::test_path_buf;
    use pretty_assertions::assert_eq;

    use codex_protocol::items::HookPromptFragment;

    use super::StopHandlerData;
    use super::aggregate_results;
    use super::parse_completed;
    use crate::engine::ConfiguredHandler;
    use crate::engine::command_runner::CommandRunResult;

    #[test]
    fn block_decision_with_reason_sets_continuation_prompt() {
        let parsed = parse_completed(
            &handler(),
            run_result(
                Some(0),
                r#"{"decision":"block","reason":"retry with tests"}"#,
                "",
            ),
            Some("turn-1".to_string()),
        );

        assert_eq!(
            parsed.data,
            StopHandlerData {
                should_stop: false,
                stop_reason: None,
                should_block: true,
                block_reason: Some("retry with tests".to_string()),
                continuation_fragments: vec![HookPromptFragment {
                    text: "retry with tests".to_string(),
                    hook_run_id: parsed.completed.run.id.clone(),
                }],
            }
        );
        assert_eq!(parsed.completed.run.status, HookRunStatus::Blocked);
    }

    #[test]
    fn block_decision_without_reason_is_invalid() {
        let parsed = parse_completed(
            &handler(),
            run_result(Some(0), r#"{"decision":"block"}"#, ""),
            Some("turn-1".to_string()),
        );

        assert_eq!(parsed.data, StopHandlerData::default());
        assert_eq!(parsed.completed.run.status, HookRunStatus::Failed);
        assert_eq!(
            parsed.completed.run.entries,
            vec![HookOutputEntry {
                kind: HookOutputEntryKind::Error,
                text: "Stop hook returned decision:block without a non-empty reason".to_string(),
            }]
        );
    }

    #[test]
    fn continue_false_overrides_block_decision() {
        let parsed = parse_completed(
            &handler(),
            run_result(
                Some(0),
                r#"{"continue":false,"stopReason":"done","decision":"block","reason":"keep going"}"#,
                "",
            ),
            Some("turn-1".to_string()),
        );

        assert_eq!(
            parsed.data,
            StopHandlerData {
                should_stop: true,
                stop_reason: Some("done".to_string()),
                should_block: false,
                block_reason: None,
                continuation_fragments: Vec::new(),
            }
        );
        assert_eq!(parsed.completed.run.status, HookRunStatus::Stopped);
    }

    #[test]
    fn exit_code_two_uses_stderr_feedback_only() {
        let parsed = parse_completed(
            &handler(),
            run_result(Some(2), "ignored stdout", "retry with tests"),
            Some("turn-1".to_string()),
        );

        assert_eq!(
            parsed.data,
            StopHandlerData {
                should_stop: false,
                stop_reason: None,
                should_block: true,
                block_reason: Some("retry with tests".to_string()),
                continuation_fragments: vec![HookPromptFragment {
                    text: "retry with tests".to_string(),
                    hook_run_id: parsed.completed.run.id.clone(),
                }],
            }
        );
        assert_eq!(parsed.completed.run.status, HookRunStatus::Blocked);
    }

    #[test]
    fn exit_code_two_without_stderr_does_not_block() {
        let parsed = parse_completed(
            &handler(),
            run_result(Some(2), "", "   "),
            /*turn_id*/ None,
        );

        assert_eq!(parsed.data, StopHandlerData::default());
        assert_eq!(parsed.completed.run.status, HookRunStatus::Failed);
        assert_eq!(
            parsed.completed.run.entries,
            vec![HookOutputEntry {
                kind: HookOutputEntryKind::Error,
                text:
                    "Stop hook exited with code 2 but did not write a continuation prompt to stderr"
                        .to_string(),
            }]
        );
    }

    #[test]
    fn block_decision_with_blank_reason_fails_instead_of_blocking() {
        let parsed = parse_completed(
            &handler(),
            run_result(Some(0), "{\"decision\":\"block\",\"reason\":\"   \"}", ""),
            Some("turn-1".to_string()),
        );

        assert_eq!(parsed.data, StopHandlerData::default());
        assert_eq!(parsed.completed.run.status, HookRunStatus::Failed);
        assert_eq!(
            parsed.completed.run.entries,
            vec![HookOutputEntry {
                kind: HookOutputEntryKind::Error,
                text: "Stop hook returned decision:block without a non-empty reason".to_string(),
            }]
        );
    }

    #[test]
    fn invalid_stdout_fails_instead_of_silently_nooping() {
        let parsed = parse_completed(
            &handler(),
            run_result(Some(0), "not json", ""),
            Some("turn-1".to_string()),
        );

        assert_eq!(parsed.data, StopHandlerData::default());
        assert_eq!(parsed.completed.run.status, HookRunStatus::Failed);
        assert_eq!(
            parsed.completed.run.entries,
            vec![HookOutputEntry {
                kind: HookOutputEntryKind::Error,
                text: "hook returned invalid stop hook JSON output".to_string(),
            }]
        );
    }

    #[test]
    fn aggregate_results_concatenates_blocking_reasons_in_declaration_order() {
        let aggregate = aggregate_results([
            &StopHandlerData {
                should_stop: false,
                stop_reason: None,
                should_block: true,
                block_reason: Some("first".to_string()),
                continuation_fragments: vec![HookPromptFragment::from_single_hook(
                    "first", "run-1",
                )],
            },
            &StopHandlerData {
                should_stop: false,
                stop_reason: None,
                should_block: true,
                block_reason: Some("second".to_string()),
                continuation_fragments: vec![HookPromptFragment::from_single_hook(
                    "second", "run-2",
                )],
            },
        ]);

        assert_eq!(
            aggregate,
            StopHandlerData {
                should_stop: false,
                stop_reason: None,
                should_block: true,
                block_reason: Some("first\n\nsecond".to_string()),
                continuation_fragments: vec![
                    HookPromptFragment::from_single_hook("first", "run-1"),
                    HookPromptFragment::from_single_hook("second", "run-2"),
                ],
            }
        );
    }

    fn handler() -> ConfiguredHandler {
        ConfiguredHandler {
            event_name: HookEventName::Stop,
            matcher: None,
            command: "echo hook".to_string(),
            timeout_sec: 600,
            status_message: None,
            source_path: test_path_buf("/tmp/hooks.json").abs(),
            source: codex_protocol::protocol::HookSource::User,
            display_order: 0,
            env: std::collections::HashMap::new(),
        }
    }

    fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult {
        CommandRunResult {
            started_at: 1,
            completed_at: 2,
            duration_ms: 1,
            exit_code,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            error: None,
        }
    }
}
