//! 评审（review）任务实现。
//!
//! `ReviewTask` 是 `/review` 流程对应的 session task 实现。它会启动一个独立的 sub-codex
//! 会话执行评审，将模型输出解析为结构化的 `ReviewOutputEvent`，并在结束时发送
//! `ExitedReviewMode` 事件与对应的对话项。

use std::sync::Arc;

use codex_prompts::render_review_exit_interrupted;
use codex_prompts::render_review_exit_success;
use codex_protocol::config_types::WebSearchMode;
use codex_protocol::items::TurnItem;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::AgentMessageContentDeltaEvent;
use codex_protocol::protocol::AskForApproval;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::ExitedReviewModeEvent;
use codex_protocol::protocol::ItemCompletedEvent;
use codex_protocol::protocol::ReviewOutputEvent;
use codex_protocol::protocol::SubAgentSource;
use tokio_util::sync::CancellationToken;

use crate::codex_delegate::run_codex_thread_one_shot;
use crate::config::Constrained;
use crate::review_format::format_review_findings_block;
use crate::review_format::render_review_output_text;
use crate::session::TurnInput;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::state::TaskKind;
use codex_features::Feature;
use codex_protocol::user_input::UserInput;

use super::SessionTask;
use super::SessionTaskContext;
use super::SessionTaskResult;

/// 评审任务。
#[derive(Clone, Copy)]
pub(crate) struct ReviewTask;

impl ReviewTask {
    /// 创建一个新的 `ReviewTask` 实例。
    pub(crate) fn new() -> Self {
        Self
    }
}

impl SessionTask for ReviewTask {
    fn kind(&self) -> TaskKind {
        TaskKind::Review
    }

    fn span_name(&self) -> &'static str {
        "session_task.review"
    }

    async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> SessionTaskResult {
        // 上报评审任务计数。
        session.session.services.session_telemetry.counter(
            "codex.task.review",
            /*inc*/ 1,
            &[],
        );

        // 收集所有用户输入内容。
        let mut user_input = Vec::new();
        for item in input {
            match item {
                TurnInput::UserInput { mut content, .. } => user_input.append(&mut content),
                TurnInput::ResponseItem(_) | TurnInput::InterAgentCommunication(_) => {}
            }
        }

        // 启动 sub-codex 评审会话并获取事件接收端。
        let output = match start_review_conversation(
            session.clone(),
            ctx.clone(),
            user_input,
            cancellation_token.clone(),
        )
        .await
        {
            Some(receiver) => process_review_events(session.clone(), ctx.clone(), receiver).await,
            None => None,
        };
        // 如果未被取消，则发送退出评审模式事件并记录对话项。
        if !cancellation_token.is_cancelled() {
            exit_review_mode(session.clone_session(), output.clone(), ctx.clone()).await;
        }
        Ok(None)
    }

    async fn abort(&self, session: Arc<SessionTaskContext>, ctx: Arc<TurnContext>) {
        // 中止时以 `None` 作为评审输出退出评审模式。
        exit_review_mode(session.clone_session(), /*review_output*/ None, ctx).await;
    }
}

/// 启动 sub-codex 评审会话，返回事件接收端（若启动成功）。
///
/// 该函数会基于当前会话配置克隆出一份 sub-agent 配置，并施加评审专用限制：
/// - 禁用 web 搜索、CSV spawn、collab 与 multi-agent v2 等特性
/// - 强制 `Never` 审批策略
/// - 设置评审专用 base_instructions
async fn start_review_conversation(
    session: Arc<SessionTaskContext>,
    ctx: Arc<TurnContext>,
    input: Vec<UserInput>,
    cancellation_token: CancellationToken,
) -> Option<async_channel::Receiver<Event>> {
    let config = ctx.config.clone();
    let mut sub_agent_config = config.as_ref().clone();
    // 沿用评审专用特性限制，避免 delegate 重新启用被禁用的工具
    // （web search、collab tools、view image）。
    if let Err(err) = sub_agent_config
        .web_search_mode
        .set(WebSearchMode::Disabled)
    {
        panic!("by construction Constrained<WebSearchMode> must always support Disabled: {err}");
    }
    let _ = sub_agent_config.features.disable(Feature::SpawnCsv);
    let _ = sub_agent_config.features.disable(Feature::Collab);
    let _ = sub_agent_config.features.disable(Feature::MultiAgentV2);

    // 为 sub-agent 设置显式的评审 rubric。
    sub_agent_config.base_instructions = Some(crate::REVIEW_PROMPT.to_string());
    sub_agent_config.permissions.approval_policy = Constrained::allow_only(AskForApproval::Never);

    let model = config
        .review_model
        .clone()
        .unwrap_or_else(|| ctx.model_info.slug.clone());
    sub_agent_config.model = Some(model);
    (run_codex_thread_one_shot(
        sub_agent_config,
        session.auth_manager(),
        session.models_manager(),
        input,
        session.clone_session(),
        ctx.clone(),
        cancellation_token,
        SubAgentSource::Review,
        /*final_output_json_schema*/ None,
        /*initial_history*/ None,
    )
    .await)
        .ok()
        .map(|io| io.rx_event)
}

/// 处理来自评审会话的事件流，直到拿到 `TurnComplete` 或被中止。
///
/// 该函数会转发 agent 消息与其他事件给主会话，但抑制 assistant 消息的
/// `ItemCompleted` 与增量 delta，以避免触发旧版的 `AgentMessage` 行为，
/// 因为评审流程希望以结构化输出替代纯文本展示。
async fn process_review_events(
    session: Arc<SessionTaskContext>,
    ctx: Arc<TurnContext>,
    receiver: async_channel::Receiver<Event>,
) -> Option<ReviewOutputEvent> {
    let mut prev_agent_message: Option<Event> = None;
    while let Ok(event) = receiver.recv().await {
        match event.clone().msg {
            EventMsg::AgentMessage(_) => {
                // 上一条 agent 消息尚未发出，先转发它，再缓存当前消息。
                if let Some(prev) = prev_agent_message.take() {
                    session
                        .clone_session()
                        .send_event(ctx.as_ref(), prev.msg)
                        .await;
                }
                prev_agent_message = Some(event);
            }
            // 仅抑制 assistant 消息的 ItemCompleted：转发它会通过
            // as_legacy_events() 触发旧版的 AgentMessage 行为，
            // 而评审流程有意隐藏该路径，改用结构化输出。
            EventMsg::ItemCompleted(ItemCompletedEvent {
                item: TurnItem::AgentMessage(_),
                ..
            })
            | EventMsg::AgentMessageContentDelta(AgentMessageContentDeltaEvent { .. }) => {}
            EventMsg::TurnComplete(task_complete) => {
                // 从最后一条 agent 消息（若存在）中解析评审输出。
                let out = task_complete
                    .last_agent_message
                    .as_deref()
                    .map(parse_review_output_event);
                return out;
            }
            EventMsg::TurnAborted(_) => {
                // 取消或中止：调用方将以 `None` 终结。
                return None;
            }
            other => {
                // 其他事件直接转发给主会话。
                session
                    .clone_session()
                    .send_event(ctx.as_ref(), other)
                    .await;
            }
        }
    }
    // 通道关闭但未收到 TurnComplete：视为被打断。
    None
}

/// 从评审模型返回的文本块解析 `ReviewOutputEvent`。
///
/// 解析顺序：
/// 1. 直接反序列化为 `ReviewOutputEvent`。
/// 2. 若失败，尝试提取第一个 JSON 对象子串并反序列化。
/// 3. 仍失败则返回结构化回退项，将原始文本放入 `overall_explanation`。
fn parse_review_output_event(text: &str) -> ReviewOutputEvent {
    if let Ok(ev) = serde_json::from_str::<ReviewOutputEvent>(text) {
        return ev;
    }
    if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}'))
        && start < end
        && let Some(slice) = text.get(start..=end)
        && let Ok(ev) = serde_json::from_str::<ReviewOutputEvent>(slice)
    {
        return ev;
    }
    ReviewOutputEvent {
        overall_explanation: text.to_string(),
        ..Default::default()
    }
}

/// 发送 `ExitedReviewMode` 事件并可选记录评审输出对应的对话项。
///
/// 同时会写入一条 user 消息和一条 assistant 消息，记录评审结果或被打断提示。
/// 评审 turn 可能早于任何常规用户 turn，因此会显式触发 rollout 持久化。
pub(crate) async fn exit_review_mode(
    session: Arc<Session>,
    review_output: Option<ReviewOutputEvent>,
    ctx: Arc<TurnContext>,
) {
    const REVIEW_USER_MESSAGE_ID: &str = "review_rollout_user";
    const REVIEW_ASSISTANT_MESSAGE_ID: &str = "review_rollout_assistant";
    let (user_message, assistant_message) = if let Some(out) = review_output.clone() {
        let mut findings_str = String::new();
        let text = out.overall_explanation.trim();
        if !text.is_empty() {
            findings_str.push_str(text);
        }
        if !out.findings.is_empty() {
            let block = format_review_findings_block(&out.findings, /*selection*/ None);
            findings_str.push_str(&format!("\n{block}"));
        }
        let rendered = render_review_exit_success(&findings_str);
        let assistant_message = render_review_output_text(&out);
        (rendered, assistant_message)
    } else {
        // 评审被打断：渲染中断提示。
        let rendered = render_review_exit_interrupted();
        let assistant_message =
            "Review was interrupted. Please re-run /review and wait for it to complete."
                .to_string();
        (rendered, assistant_message)
    };

    // 记录 user 消息（评审 prompt 渲染结果）。
    session
        .record_conversation_items(
            &ctx,
            &[ResponseItem::Message {
                id: Some(REVIEW_USER_MESSAGE_ID.to_string()),
                role: "user".to_string(),
                content: vec![ContentItem::InputText { text: user_message }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            }],
        )
        .await;

    // 发送退出评审模式事件。
    session
        .send_event(
            ctx.as_ref(),
            EventMsg::ExitedReviewMode(ExitedReviewModeEvent { review_output }),
        )
        .await;

    // 记录 assistant 消息并发出对应 turn item。
    session
        .record_response_item_and_emit_turn_item(
            ctx.as_ref(),
            ResponseItem::Message {
                id: Some(REVIEW_ASSISTANT_MESSAGE_ID.to_string()),
                role: "assistant".to_string(),
                content: vec![ContentItem::OutputText {
                    text: assistant_message,
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
        )
        .await;

    // 评审 turn 可能早于任何常规用户 turn，因此显式触发 rollout 持久化。
    // 该操作放在评审输出之后，使文件创建与 git 元数据收集不会延迟面向用户的项。
    session.ensure_rollout_materialized().await;
}
