//! Codex delegate 模块。
//!
//! 提供 subagent(包括 guardian reviewer)的 spawn 能力,
//! 在独立线程中运行子 codex 会话,并通过 channel 与父 session 通信。

use std::collections::HashMap;
use std::sync::Arc;

use async_channel::Receiver;
use async_channel::Sender;
use codex_analytics::GuardianApprovalRequestSource;
use codex_async_utils::OrCancelExt;
use codex_extension_api::LoadedUserInstructions;
use codex_protocol::protocol::ApplyPatchApprovalRequestEvent;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::ExecApprovalRequestEvent;
use codex_protocol::protocol::McpInvocation;
use codex_protocol::protocol::Op;
use codex_protocol::protocol::RequestUserInputEvent;
use codex_protocol::protocol::ReviewDecision;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::protocol::Submission;
use codex_protocol::protocol::ThreadSource;
use codex_protocol::request_permissions::PermissionGrantScope;
use codex_protocol::request_permissions::RequestPermissionsArgs;
use codex_protocol::request_permissions::RequestPermissionsEvent;
use codex_protocol::request_permissions::RequestPermissionsResponse;
use codex_protocol::request_user_input::RequestUserInputArgs;
use codex_protocol::request_user_input::RequestUserInputResponse;
use codex_protocol::user_input::UserInput;
use serde_json::Value;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::guardian::GuardianApprovalRequest;
use crate::guardian::new_guardian_review_id;
use crate::guardian::routes_approval_to_guardian;
use crate::guardian::routes_approval_to_guardian_with_reviewer;
use crate::guardian::spawn_approval_request_review;
use crate::mcp_tool_call::MCP_TOOL_APPROVAL_ACCEPT;
use crate::mcp_tool_call::MCP_TOOL_APPROVAL_ACCEPT_FOR_SESSION;
use crate::mcp_tool_call::MCP_TOOL_APPROVAL_DECLINE_SYNTHETIC;
use crate::mcp_tool_call::McpToolApprovalMetadata;
use crate::mcp_tool_call::build_guardian_mcp_tool_review_request;
use crate::mcp_tool_call::is_mcp_tool_approval_question_id;
use crate::mcp_tool_call::lookup_mcp_tool_metadata;
use crate::mcp_tool_call::mcp_approvals_reviewer;
use crate::session::Codex;
use crate::session::CodexSpawnArgs;
use crate::session::CodexSpawnOk;
use crate::session::SUBMISSION_CHANNEL_CAPACITY;
use crate::session::emit_subagent_session_started;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use codex_login::AuthManager;
use codex_models_manager::manager::SharedModelsManager;
use codex_protocol::error::CodexErr;
use codex_protocol::protocol::InitialHistory;
use codex_protocol::protocol::MultiAgentVersion;

#[cfg(test)]
use crate::session::completed_session_loop_termination;

#[derive(Clone)]
struct PendingMcpInvocation {
    invocation: McpInvocation,
    metadata: Option<McpToolApprovalMetadata>,
}

/// 启动一个交互式 sub-Codex 线程并返回 IO 通道。
///
/// 返回的 `events_rx` 产出 sub-agent 发出的非审批事件。
/// 审批请求通过 `parent_session` 处理，不会暴露给调用方。
/// 返回的 `ops_tx` 允许调用方向 sub-agent 提交额外的 `Op`。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_codex_thread_interactive(
    config: Config,
    auth_manager: Arc<AuthManager>,
    models_manager: SharedModelsManager,
    parent_session: Arc<Session>,
    parent_ctx: Arc<TurnContext>,
    cancel_token: CancellationToken,
    subagent_source: SubAgentSource,
    initial_history: Option<InitialHistory>,
) -> Result<Codex, CodexErr> {
    let (tx_sub, rx_sub) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY);
    let (tx_ops, rx_ops) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY);
    let conversation_history = initial_history.unwrap_or(InitialHistory::New);
    let forked_from_thread_id = conversation_history.forked_from_id();
    let user_instructions = LoadedUserInstructions {
        instructions: parent_session.user_instructions().await,
        warnings: Vec::new(),
    };
    let CodexSpawnOk { codex, .. } = Box::pin(Codex::spawn(CodexSpawnArgs {
        config,
        allow_provider_model_fallback: false,
        user_instructions,
        installation_id: parent_session.installation_id.clone(),
        auth_manager,
        models_manager,
        environment_manager: parent_session
            .services
            .turn_environments
            .environment_manager(),
        skills_service: Arc::clone(&parent_session.services.skills_service),
        plugins_manager: Arc::clone(&parent_session.services.plugins_manager),
        mcp_manager: Arc::clone(&parent_session.services.mcp_manager),
        code_mode_session_provider: parent_session.services.code_mode_service.session_provider(),
        extensions: Arc::clone(&parent_session.services.extensions),
        conversation_history,
        requested_history_mode: None,
        session_source: SessionSource::SubAgent(subagent_source.clone()),
        forked_from_thread_id,
        parent_thread_id: Some(parent_session.thread_id),
        thread_source: Some(ThreadSource::Subagent),
        originator: parent_ctx.originator.clone(),
        agent_control: parent_session.services.agent_control.clone(),
        dynamic_tools: Vec::new(),
        metrics_service_name: None,
        user_shell_override: None,
        inherited_environments: Some(parent_ctx.environments.clone()),
        inherited_exec_policy: Some(Arc::clone(&parent_session.services.exec_policy)),
        parent_rollout_thread_trace: codex_rollout_trace::ThreadTraceContext::disabled(),
        parent_trace: None,
        environment_selections: parent_ctx.environments.to_selections(),
        thread_extension_init: codex_extension_api::ExtensionDataInit::default(),
        supports_openai_form_elicitation: parent_session
            .services
            .supports_openai_form_elicitation
            .load(std::sync::atomic::Ordering::Relaxed),
        analytics_events_client: Some(parent_session.services.analytics_events_client.clone()),
        thread_store: Arc::clone(&parent_session.services.thread_store),
        attestation_provider: parent_session.services.attestation_provider.clone(),
        external_time_provider: Some(Arc::clone(&parent_session.services.time_provider)),
        inherited_multi_agent_version: Some(MultiAgentVersion::Disabled),
    }))
    .or_cancel(&cancel_token)
    .await??;
    let thread_config = codex.thread_config_snapshot().await;
    let client_metadata = parent_session.app_server_client_metadata().await;
    emit_subagent_session_started(
        &parent_session.services.analytics_events_client,
        client_metadata,
        codex.session.session_id(),
        codex.session.thread_id,
        Some(parent_session.thread_id),
        thread_config,
        subagent_source,
    );
    let codex = Arc::new(codex);

    // 使用 child token，这样父级取消会级联，但我们也可以将其限定在此任务范围内
    let cancel_token_events = cancel_token.child_token();
    let cancel_token_ops = cancel_token.child_token();

    // 将 sub-agent 的事件转发给消费者，过滤审批请求并路由到父 session 进行决策。
    let parent_session_clone = Arc::clone(&parent_session);
    let parent_ctx_clone = Arc::clone(&parent_ctx);
    let codex_for_events = Arc::clone(&codex);
    // 在调用开始时缓存子调用的 MCP 元数据。后续的旧版 RequestUserInput
    // 审批事件只携带 call_id 和问题元数据。
    let pending_mcp_invocations =
        Arc::new(Mutex::new(HashMap::<String, PendingMcpInvocation>::new()));
    tokio::spawn(async move {
        forward_events(
            codex_for_events,
            tx_sub,
            parent_session_clone,
            parent_ctx_clone,
            pending_mcp_invocations,
            cancel_token_events,
        )
        .await;
    });

    // Forward ops from the caller to the sub-agent.
    let codex_for_ops = Arc::clone(&codex);
    tokio::spawn(async move {
        forward_ops(codex_for_ops, rx_ops, cancel_token_ops).await;
    });

    Ok(Codex {
        tx_sub: tx_ops,
        rx_event: rx_sub,
        agent_status: codex.agent_status.clone(),
        session: Arc::clone(&codex.session),
        session_loop_termination: codex.session_loop_termination.clone(),
    })
}

/// 一次性使用的便捷封装，接受初始 prompt。
///
/// 内部调用交互式变体，然后立即提交提供的输入。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_codex_thread_one_shot(
    config: Config,
    auth_manager: Arc<AuthManager>,
    models_manager: SharedModelsManager,
    input: Vec<UserInput>,
    parent_session: Arc<Session>,
    parent_ctx: Arc<TurnContext>,
    cancel_token: CancellationToken,
    subagent_source: SubAgentSource,
    final_output_json_schema: Option<Value>,
    initial_history: Option<InitialHistory>,
) -> Result<Codex, CodexErr> {
    // 使用 child token，这样我们可以在完成后停止 delegate，
    // 而不需要调用方取消父 token。
    let child_cancel = cancel_token.child_token();
    let io = Box::pin(run_codex_thread_interactive(
        config,
        auth_manager,
        models_manager,
        parent_session,
        parent_ctx,
        child_cancel.clone(),
        subagent_source,
        initial_history,
    ))
    .await?;

    // Send the initial input to kick off the one-shot turn.
    io.submit(Op::UserInput {
        items: input,
        final_output_json_schema,
        responsesapi_client_metadata: None,
        additional_context: Default::default(),
        thread_settings: Default::default(),
    })
    .await?;

    // 桥接事件，以便我们观察完成状态并自动关闭。
    let (tx_bridge, rx_bridge) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY);
    let ops_tx = io.tx_sub.clone();
    let agent_status = io.agent_status.clone();
    let session = Arc::clone(&io.session);
    let session_loop_termination = io.session_loop_termination.clone();
    let io_for_bridge = io;
    tokio::spawn(async move {
        while let Ok(event) = io_for_bridge.next_event().await {
            let should_shutdown = matches!(
                event.msg,
                EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)
            );
            let _ = tx_bridge.send(event).await;
            if should_shutdown {
                let _ = ops_tx
                    .send(Submission {
                        id: "shutdown".to_string(),
                        op: Op::Shutdown {},
                        client_user_message_id: None,
                        trace: None,
                    })
                    .await;
                child_cancel.cancel();
                break;
            }
        }
    });

    // 对于一次性使用，返回一个已关闭的 `tx_sub`，这样调用方就无法在初始请求后
    // 提交额外的 op。创建一个通道并立即丢弃接收方以关闭它。
    let (tx_closed, rx_closed) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY);
    drop(rx_closed);

    Ok(Codex {
        rx_event: rx_bridge,
        tx_sub: tx_closed,
        agent_status,
        session,
        session_loop_termination,
    })
}

async fn forward_events(
    codex: Arc<Codex>,
    tx_sub: Sender<Event>,
    parent_session: Arc<Session>,
    parent_ctx: Arc<TurnContext>,
    pending_mcp_invocations: Arc<Mutex<HashMap<String, PendingMcpInvocation>>>,
    cancel_token: CancellationToken,
) {
    let cancelled = cancel_token.cancelled();
    tokio::pin!(cancelled);

    loop {
        tokio::select! {
            _ = &mut cancelled => {
                shutdown_delegate(&codex).await;
                break;
            }
            event = codex.next_event() => {
                let event = match event {
                    Ok(event) => event,
                    Err(_) => break,
                };
                match event {
                    Event {
                        id: _,
                        msg: EventMsg::TokenCount(_),
                    } => {}
                    Event {
                        id: _,
                        msg: EventMsg::SessionConfigured(_),
                    } => {}
                    Event {
                        id,
                        msg: EventMsg::ExecApprovalRequest(event),
                    } => {
                        // 通过父 session 发起审批；不暴露给消费者。
                        handle_exec_approval(
                            &codex,
                            id,
                            &parent_session,
                            &parent_ctx,
                            event,
                            &cancel_token,
                        )
                        .await;
                    }
                    Event {
                        id,
                        msg: EventMsg::ApplyPatchApprovalRequest(event),
                    } => {
                        handle_patch_approval(
                            &codex,
                            id,
                            &parent_session,
                            &parent_ctx,
                            event,
                            &cancel_token,
                        )
                        .await;
                    }
                    Event {
                        msg: EventMsg::RequestPermissions(event),
                        ..
                    } => {
                        handle_request_permissions(
                            &codex,
                            &parent_session,
                            &parent_ctx,
                            event,
                            &cancel_token,
                        )
                        .await;
                    }
                    Event {
                        id,
                        msg: EventMsg::RequestUserInput(event),
                    } => {
                        handle_request_user_input(
                            &codex,
                            id,
                            &parent_session,
                            &parent_ctx,
                            &pending_mcp_invocations,
                            event,
                            &cancel_token,
                        )
                        .await;
                    }
                    Event {
                        id,
                        msg: EventMsg::McpToolCallBegin(event),
                    } => {
                        // 运行时刷新在请求步骤被捕获之前发布，因此调用开始时的子运行时
                        // 就是执行此调用的运行时。现在缓存其元数据；后续审批事件只有 call ID。
                        let metadata = if let Some(turn_context) =
                            codex.session.turn_context_for_sub_id(&id).await
                        {
                            let mcp = codex.session.services.latest_mcp_runtime();
                            lookup_mcp_tool_metadata(
                                codex.session.as_ref(),
                                turn_context.as_ref(),
                                mcp.manager(),
                                &event.invocation.server,
                                &event.invocation.tool,
                            )
                            .await
                        } else {
                            None
                        };
                        pending_mcp_invocations
                            .lock()
                            .await
                            .insert(
                                event.call_id.clone(),
                                PendingMcpInvocation {
                                    invocation: event.invocation.clone(),
                                    metadata,
                                },
                            );
                        if !forward_event_or_shutdown(
                            &codex,
                            &tx_sub,
                            &cancel_token,
                            Event {
                                id,
                                msg: EventMsg::McpToolCallBegin(event),
                            },
                        )
                        .await
                        {
                            break;
                        }
                    }
                    Event {
                        id,
                        msg: EventMsg::McpToolCallEnd(event),
                    } => {
                        pending_mcp_invocations.lock().await.remove(&event.call_id);
                        if !forward_event_or_shutdown(
                            &codex,
                            &tx_sub,
                            &cancel_token,
                            Event {
                                id,
                                msg: EventMsg::McpToolCallEnd(event),
                            },
                        )
                        .await
                        {
                            break;
                        }
                    }
                    other => {
                        if !forward_event_or_shutdown(&codex, &tx_sub, &cancel_token, other).await
                        {
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// Ask the delegate to stop and drain its events so background sends do not hit a closed channel.
async fn shutdown_delegate(codex: &Codex) {
    let _ = codex.submit(Op::Interrupt).await;
    let _ = codex.submit(Op::Shutdown {}).await;

    let _ = timeout(Duration::from_millis(500), async {
        while let Ok(event) = codex.next_event().await {
            if matches!(
                event.msg,
                EventMsg::TurnAborted(_) | EventMsg::TurnComplete(_)
            ) {
                break;
            }
        }
    })
    .await;
}

async fn forward_event_or_shutdown(
    codex: &Codex,
    tx_sub: &Sender<Event>,
    cancel_token: &CancellationToken,
    event: Event,
) -> bool {
    match tx_sub.send(event).or_cancel(cancel_token).await {
        Ok(Ok(())) => true,
        _ => {
            shutdown_delegate(codex).await;
            false
        }
    }
}

/// 将调用方的 op 转发给 sub-agent，并尊重取消操作。
async fn forward_ops(
    codex: Arc<Codex>,
    rx_ops: Receiver<Submission>,
    cancel_token_ops: CancellationToken,
) {
    loop {
        let submission = match rx_ops.recv().or_cancel(&cancel_token_ops).await {
            Ok(Ok(submission)) => submission,
            Ok(Err(_)) | Err(_) => break,
        };
        let _ = codex.submit_with_id(submission).await;
    }
}

/// Handle an ExecApprovalRequest by consulting the parent session and replying.
async fn handle_exec_approval(
    codex: &Codex,
    turn_id: String,
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    event: ExecApprovalRequestEvent,
    cancel_token: &CancellationToken,
) {
    let approval_id_for_op = event.effective_approval_id();
    let ExecApprovalRequestEvent {
        call_id,
        approval_id,
        environment_id,
        command,
        cwd,
        reason,
        network_approval_context,
        proposed_execpolicy_amendment,
        additional_permissions,
        available_decisions,
        ..
    } = event;
    let decision = if routes_approval_to_guardian(parent_ctx) {
        let review_cancel = cancel_token.child_token();
        let review_rx = spawn_approval_request_review(
            Arc::clone(parent_session),
            Arc::clone(parent_ctx),
            new_guardian_review_id(),
            GuardianApprovalRequest::Shell {
                id: call_id.clone(),
                command,
                cwd,
                sandbox_permissions: if additional_permissions.is_some() {
                    crate::sandboxing::SandboxPermissions::WithAdditionalPermissions
                } else {
                    crate::sandboxing::SandboxPermissions::UseDefault
                },
                additional_permissions,
                justification: None,
            },
            reason,
            GuardianApprovalRequestSource::DelegatedSubagent,
            review_cancel.clone(),
        );
        await_approval_with_cancel(
            async move { review_rx.await.unwrap_or_default() },
            parent_session,
            &approval_id_for_op,
            cancel_token,
            Some(&review_cancel),
        )
        .await
    } else {
        await_approval_with_cancel(
            parent_session.request_command_approval(
                parent_ctx,
                call_id,
                approval_id,
                environment_id,
                command,
                cwd,
                reason,
                network_approval_context,
                proposed_execpolicy_amendment,
                additional_permissions,
                available_decisions,
            ),
            parent_session,
            &approval_id_for_op,
            cancel_token,
            /*review_cancel_token*/ None,
        )
        .await
    };

    let _ = codex
        .submit(Op::ExecApproval {
            id: approval_id_for_op,
            turn_id: Some(turn_id),
            decision,
        })
        .await;
}

/// 通过咨询父 session 来处理 ApplyPatchApprovalRequest 并回复。
async fn handle_patch_approval(
    codex: &Codex,
    _id: String,
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    event: ApplyPatchApprovalRequestEvent,
    cancel_token: &CancellationToken,
) {
    let ApplyPatchApprovalRequestEvent {
        call_id,
        changes,
        reason,
        grant_root,
        ..
    } = event;
    let approval_id = call_id.clone();
    let guardian_decision = if routes_approval_to_guardian(parent_ctx) {
        let files = changes
            .keys()
            .map(|path| {
                #[allow(deprecated)]
                parent_ctx.cwd.join(path)
            })
            .collect::<Vec<_>>();
        let review_cancel = cancel_token.child_token();
        let patch = changes
            .iter()
            .map(|(path, change)| match change {
                codex_protocol::protocol::FileChange::Add { content } => {
                    format!("*** Add File: {}\n{}", path.display(), content)
                }
                codex_protocol::protocol::FileChange::Delete { content } => {
                    format!("*** Delete File: {}\n{}", path.display(), content)
                }
                codex_protocol::protocol::FileChange::Update {
                    unified_diff,
                    move_path,
                } => {
                    if let Some(move_path) = move_path {
                        format!(
                            "*** Update File: {}\n*** Move to: {}\n{}",
                            path.display(),
                            move_path.display(),
                            unified_diff
                        )
                    } else {
                        format!("*** Update File: {}\n{}", path.display(), unified_diff)
                    }
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let review_rx = spawn_approval_request_review(
            Arc::clone(parent_session),
            Arc::clone(parent_ctx),
            new_guardian_review_id(),
            GuardianApprovalRequest::ApplyPatch {
                id: approval_id.clone(),
                #[allow(deprecated)]
                cwd: parent_ctx.cwd.clone(),
                files,
                patch,
            },
            reason.clone(),
            GuardianApprovalRequestSource::DelegatedSubagent,
            review_cancel.clone(),
        );
        Some(
            await_approval_with_cancel(
                async move { review_rx.await.unwrap_or_default() },
                parent_session,
                &approval_id,
                cancel_token,
                Some(&review_cancel),
            )
            .await,
        )
    } else {
        None
    };
    let decision = if let Some(decision) = guardian_decision {
        decision
    } else {
        let decision_rx = parent_session
            .request_patch_approval(parent_ctx, call_id, changes, reason, grant_root)
            .await;
        await_approval_with_cancel(
            async move { decision_rx.await.unwrap_or_default() },
            parent_session,
            &approval_id,
            cancel_token,
            /*review_cancel_token*/ None,
        )
        .await
    };
    let _ = codex
        .submit(Op::PatchApproval {
            id: approval_id,
            decision,
        })
        .await;
}

async fn handle_request_user_input(
    codex: &Codex,
    id: String,
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    pending_mcp_invocations: &Arc<Mutex<HashMap<String, PendingMcpInvocation>>>,
    event: RequestUserInputEvent,
    cancel_token: &CancellationToken,
) {
    if let Some(response) = maybe_auto_review_mcp_request_user_input(
        parent_session,
        parent_ctx,
        pending_mcp_invocations,
        &event,
        cancel_token,
    )
    .await
    {
        let _ = codex.submit(Op::UserInputAnswer { id, response }).await;
        return;
    }

    let args = RequestUserInputArgs {
        questions: event.questions,
        auto_resolution_ms: event.auto_resolution_ms,
    };
    let response_fut =
        parent_session.request_user_input(parent_ctx, parent_ctx.sub_id.clone(), args);
    let response = await_user_input_with_cancel(
        response_fut,
        parent_session,
        &parent_ctx.sub_id,
        cancel_token,
    )
    .await;
    let _ = codex.submit(Op::UserInputAnswer { id, response }).await;
}

/// 拦截 RequestUserInput 兼容路径上的委托式旧版 MCP 审批提示，
/// 当 guardian 激活时，在运行 guardian 审查后以编程方式回答它们。
///
/// RequestUserInput 事件只携带 `call_id` 和审批问题元数据，
/// 因此此辅助函数将其与在 `McpToolCallBegin` 时缓存的子运行时元数据
/// 关联，以重建完整的 guardian 审查请求。
async fn maybe_auto_review_mcp_request_user_input(
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    pending_mcp_invocations: &Arc<Mutex<HashMap<String, PendingMcpInvocation>>>,
    event: &RequestUserInputEvent,
    cancel_token: &CancellationToken,
) -> Option<RequestUserInputResponse> {
    // TODO(ccunningham): 在与 @fouad 协调后，也在此处支持委托式 MCP 审批 elicitations。
    // 目前 guardian 仅自动审查委托式 MCP 审批的 RequestUserInput 兼容路径。
    let question = event
        .questions
        .iter()
        .find(|question| is_mcp_tool_approval_question_id(&question.id))?;
    let pending = pending_mcp_invocations
        .lock()
        .await
        .get(&event.call_id)
        .cloned()?;
    let invocation = pending.invocation;
    let metadata = pending.metadata;
    let approvals_reviewer =
        mcp_approvals_reviewer(parent_ctx, &invocation.server, metadata.as_ref());
    if !routes_approval_to_guardian_with_reviewer(parent_ctx, approvals_reviewer) {
        return None;
    }
    let review_cancel = cancel_token.child_token();
    let review_rx = spawn_approval_request_review(
        Arc::clone(parent_session),
        Arc::clone(parent_ctx),
        new_guardian_review_id(),
        build_guardian_mcp_tool_review_request(&event.call_id, &invocation, metadata.as_ref()),
        /*retry_reason*/ None,
        GuardianApprovalRequestSource::DelegatedSubagent,
        review_cancel.clone(),
    );
    let decision = await_approval_with_cancel(
        async move { review_rx.await.unwrap_or_default() },
        parent_session,
        &event.call_id,
        cancel_token,
        Some(&review_cancel),
    )
    .await;
    let selected_label = match decision {
        ReviewDecision::ApprovedForSession => question
            .options
            .as_ref()
            .and_then(|options| {
                options
                    .iter()
                    .find(|option| option.label == MCP_TOOL_APPROVAL_ACCEPT_FOR_SESSION)
            })
            .map(|option| option.label.clone())
            .unwrap_or_else(|| MCP_TOOL_APPROVAL_ACCEPT.to_string()),
        ReviewDecision::Approved
        | ReviewDecision::ApprovedExecpolicyAmendment { .. }
        | ReviewDecision::NetworkPolicyAmendment { .. } => MCP_TOOL_APPROVAL_ACCEPT.to_string(),
        ReviewDecision::Denied | ReviewDecision::TimedOut | ReviewDecision::Abort => {
            MCP_TOOL_APPROVAL_DECLINE_SYNTHETIC.to_string()
        }
    };
    Some(RequestUserInputResponse {
        answers: HashMap::from([(
            question.id.clone(),
            codex_protocol::request_user_input::RequestUserInputAnswer {
                answers: vec![selected_label],
            },
        )]),
    })
}

async fn handle_request_permissions(
    codex: &Codex,
    parent_session: &Arc<Session>,
    parent_ctx: &Arc<TurnContext>,
    event: RequestPermissionsEvent,
    cancel_token: &CancellationToken,
) {
    let call_id = event.call_id;
    let args = RequestPermissionsArgs {
        environment_id: event.environment_id,
        reason: event.reason,
        permissions: event.permissions,
    };
    let cwd = event.cwd.unwrap_or_else(|| {
        #[allow(deprecated)]
        parent_ctx.cwd.clone()
    });
    let response_fut = parent_session.request_permissions_for_cwd(
        parent_ctx,
        call_id.clone(),
        args,
        cwd,
        cancel_token.clone(),
    );
    let response =
        await_request_permissions_with_cancel(response_fut, parent_session, &call_id, cancel_token)
            .await;
    let _ = codex
        .submit(Op::RequestPermissionsResponse {
            id: call_id,
            response,
        })
        .await;
}

async fn await_user_input_with_cancel<F>(
    fut: F,
    parent_session: &Session,
    sub_id: &str,
    cancel_token: &CancellationToken,
) -> RequestUserInputResponse
where
    F: core::future::Future<Output = Option<RequestUserInputResponse>>,
{
    tokio::select! {
        biased;
        _ = cancel_token.cancelled() => {
            let empty = RequestUserInputResponse {
                answers: HashMap::new(),
            };
            parent_session
                .notify_user_input_response(sub_id, empty.clone())
                .await;
            empty
        }
        response = fut => response.unwrap_or_else(|| RequestUserInputResponse {
            answers: HashMap::new(),
        }),
    }
}

async fn await_request_permissions_with_cancel<F>(
    fut: F,
    parent_session: &Session,
    call_id: &str,
    cancel_token: &CancellationToken,
) -> RequestPermissionsResponse
where
    F: core::future::Future<Output = Option<RequestPermissionsResponse>>,
{
    tokio::select! {
        biased;
        _ = cancel_token.cancelled() => {
            let empty = RequestPermissionsResponse {
                permissions: Default::default(),
                scope: PermissionGrantScope::Turn,
                strict_auto_review: false,
            };
            parent_session
                .notify_request_permissions_response(call_id, empty.clone())
                .await;
            empty
        }
        response = fut => response.unwrap_or_else(|| RequestPermissionsResponse {
            permissions: Default::default(),
            scope: PermissionGrantScope::Turn,
            strict_auto_review: false,
        }),
    }
}

/// 等待审批决策，取消时中止。
// 修复：补充缺失的泛型参数 <F> 声明（原代码遗漏导致 F 类型未找到）
async fn await_approval_with_cancel<F>(
    fut: F,
    parent_session: &Session,
    approval_id: &str,
    cancel_token: &CancellationToken,
    review_cancel_token: Option<&CancellationToken>,
) -> codex_protocol::protocol::ReviewDecision
where
    F: core::future::Future<Output = codex_protocol::protocol::ReviewDecision>,
{
    tokio::select! {
        biased;
        _ = cancel_token.cancelled() => {
            if let Some(review_cancel_token) = review_cancel_token {
                review_cancel_token.cancel();
            }
            parent_session
                .notify_approval(approval_id, codex_protocol::protocol::ReviewDecision::Abort)
                .await;
            codex_protocol::protocol::ReviewDecision::Abort
        }
        decision = fut => {
            decision
        }
    }
}

#[cfg(test)]
#[path = "codex_delegate_tests.rs"]
mod tests;
