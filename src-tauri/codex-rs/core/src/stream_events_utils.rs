//! 模型流事件处理工具。
//!
//! 本模块处理模型流式响应中的已完成 output item，包括：
//! 记录会话历史、排队工具执行、剥离隐藏标记、解析记忆引用、持久化生成的图片等。

use std::pin::Pin;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use codex_extension_api::ExtensionData;
use codex_protocol::config_types::ModeKind;
use codex_protocol::items::ImageGenerationItem;
use codex_protocol::items::TurnItem;
use codex_utils_stream_parser::strip_citations;
use tokio_util::sync::CancellationToken;

use crate::context::ContextualUserFragment;
use crate::context::ImageGenerationInstructions;
use crate::function_tool::FunctionCallError;
use crate::parse_turn_item;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::tools::parallel::ToolCallRuntime;
use crate::tools::router::ToolRouter;
use codex_memories_read::citations::parse_memory_citation;
use codex_memories_read::citations::thread_ids_from_memory_citation;
use codex_protocol::error::CodexErr;
use codex_protocol::error::Result;
use codex_protocol::memory_citation::MemoryCitation;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::MessagePhase;
use codex_protocol::models::ResponseInputItem;
use codex_protocol::models::ResponseItem;
use codex_rollout::state_db;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_stream_parser::strip_proposed_plan_blocks;
use futures::Future;
use tracing::debug;
use tracing::instrument;
use tracing::warn;

/// 生成图片的默认 artifact 存储目录名。
const GENERATED_IMAGE_ARTIFACTS_DIR: &str = "generated_images";

/// 返回生成图片的宿主默认 artifact 路径。
pub fn image_generation_artifact_path(
    codex_home: &AbsolutePathBuf,
    session_id: &str,
    call_id: &str,
) -> AbsolutePathBuf {
    let sanitize = |value: &str| {
        let mut sanitized: String = value
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        if sanitized.is_empty() {
            sanitized = "generated_image".to_string();
        }
        sanitized
    };

    codex_home
        .join(GENERATED_IMAGE_ARTIFACTS_DIR)
        .join(sanitize(session_id))
        .join(format!("{}.png", sanitize(call_id)))
}

fn strip_hidden_assistant_markup(text: &str, plan_mode: bool) -> String {
    let (without_citations, _) = strip_citations(text);
    if plan_mode {
        strip_proposed_plan_blocks(&without_citations)
    } else {
        without_citations
    }
}

fn strip_hidden_assistant_markup_and_parse_memory_citation(
    text: &str,
    plan_mode: bool,
) -> (
    String,
    Option<codex_protocol::memory_citation::MemoryCitation>,
) {
    let (without_citations, citations) = strip_citations(text);
    let visible_text = if plan_mode {
        strip_proposed_plan_blocks(&without_citations)
    } else {
        without_citations
    };
    (visible_text, parse_memory_citation(citations))
}

/// 从 `ResponseItem` 中提取 assistant 消息的原始输出文本。
pub(crate) fn raw_assistant_output_text_from_item(item: &ResponseItem) -> Option<String> {
    if let ResponseItem::Message { role, content, .. } = item
        && role == "assistant"
    {
        let combined = content
            .iter()
            .filter_map(|ci| match ci {
                codex_protocol::models::ContentItem::OutputText { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        return Some(combined);
    }
    None
}

async fn save_image_generation_result(
    codex_home: &AbsolutePathBuf,
    session_id: &str,
    call_id: &str,
    result: &str,
) -> Result<AbsolutePathBuf> {
    let bytes = BASE64_STANDARD
        .decode(result.trim().as_bytes())
        .map_err(|err| {
            CodexErr::InvalidRequest(format!("invalid image generation payload: {err}"))
        })?;
    let path = image_generation_artifact_path(codex_home, session_id, call_id);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&path, bytes).await?;
    Ok(path)
}

/// 持久化图片生成结果到磁盘，并更新 `ImageGenerationItem` 的 `saved_path`。
pub(crate) async fn persist_image_generation_item(
    sess: &Session,
    turn_context: &TurnContext,
    image_item: &mut ImageGenerationItem,
) -> Option<AbsolutePathBuf> {
    image_item.saved_path = None;
    let session_id = sess.thread_id.to_string();
    match save_image_generation_result(
        &turn_context.config.codex_home,
        &session_id,
        &image_item.id,
        &image_item.result,
    )
    .await
    {
        Ok(path) => {
            image_item.saved_path = Some(path.clone());
            Some(path)
        }
        Err(err) => {
            let output_path = image_generation_artifact_path(
                &turn_context.config.codex_home,
                &session_id,
                &image_item.id,
            );
            let output_dir = output_path
                .parent()
                .unwrap_or_else(|| turn_context.config.codex_home.clone());
            tracing::warn!(
                call_id = %image_item.id,
                output_dir = %output_dir.display(),
                "failed to save generated image: {err}"
            );
            None
        }
    }
}

async fn record_image_generation_instructions(
    sess: &Session,
    turn_context: &TurnContext,
    image_item: &ImageGenerationItem,
) {
    if image_item.saved_path.is_none() {
        return;
    }
    let session_id = sess.thread_id.to_string();
    let image_output_path =
        image_generation_artifact_path(&turn_context.config.codex_home, &session_id, "<image_id>");
    let image_output_dir = image_output_path
        .parent()
        .unwrap_or_else(|| turn_context.config.codex_home.clone());
    let message: ResponseItem = ContextualUserFragment::into(ImageGenerationInstructions::new(
        image_output_dir.display(),
        image_output_path.display(),
    ));
    sess.record_conversation_items(turn_context, &[message])
        .await;
}

/// 持久化已完成的模型响应 item，并记录引用的记忆使用情况。
pub(crate) async fn record_completed_response_item(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
) {
    record_completed_response_item_with_finalized_facts(
        sess,
        turn_context,
        item,
        /*finalized_facts*/ None,
    )
    .await;
}

/// 持久化已完成的模型响应 item，并使用已确定的 facts 记录记忆引用与邮箱延迟。
pub(crate) async fn record_completed_response_item_with_finalized_facts(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
    finalized_facts: Option<&FinalizedTurnItemFacts>,
) {
    sess.record_conversation_items(turn_context, std::slice::from_ref(item))
        .await;
    let defers_mailbox_delivery = finalized_facts.map_or_else(
        || {
            completed_item_defers_mailbox_delivery_to_next_turn(
                item,
                turn_context.collaboration_mode.mode == ModeKind::Plan,
            )
        },
        |facts| facts.defers_mailbox_delivery_to_next_turn,
    );
    if defers_mailbox_delivery {
        sess.input_queue
            .defer_mailbox_delivery_to_next_turn(&sess.active_turn, &turn_context.sub_id)
            .await;
    }
    mark_thread_memory_mode_polluted_if_external_context(sess, turn_context, item).await;
    let has_memory_citation = if let Some(memory_citation) =
        finalized_facts.and_then(|facts| facts.memory_citation.as_ref())
    {
        record_stage1_output_usage_for_memory_citation(
            sess.services.state_db.as_ref(),
            memory_citation,
        )
        .await
    } else {
        record_stage1_output_usage_and_detect_memory_citation(sess.services.state_db.as_ref(), item)
            .await
    };
    if has_memory_citation {
        sess.record_memory_citation_for_turn(&turn_context.sub_id)
            .await;
    }
}

fn response_item_may_include_external_context(item: &ResponseItem) -> bool {
    matches!(
        item,
        ResponseItem::ToolSearchCall { .. }
            | ResponseItem::ToolSearchOutput { .. }
            | ResponseItem::WebSearchCall { .. }
    )
}

/// 若 item 包含外部上下文（工具搜索、Web 搜索等），则将线程标记为 memory mode 已污染。
pub(crate) async fn mark_thread_memory_mode_polluted_if_external_context(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
) {
    if !turn_context.config.memories.disable_on_external_context
        || !response_item_may_include_external_context(item)
    {
        return;
    }
    state_db::mark_thread_memory_mode_polluted(
        sess.services.state_db.as_deref(),
        sess.thread_id,
        "record_completed_response_item",
    )
    .await;
}

async fn record_stage1_output_usage_and_detect_memory_citation(
    state_db_ctx: Option<&state_db::StateDbHandle>,
    item: &ResponseItem,
) -> bool {
    let Some(raw_text) = raw_assistant_output_text_from_item(item) else {
        return false;
    };

    let (_, citations) = strip_citations(&raw_text);
    let Some(memory_citation) = parse_memory_citation(citations) else {
        return false;
    };
    record_stage1_output_usage_for_memory_citation(state_db_ctx, &memory_citation).await
}

async fn record_stage1_output_usage_for_memory_citation(
    state_db_ctx: Option<&state_db::StateDbHandle>,
    memory_citation: &MemoryCitation,
) -> bool {
    let thread_ids = thread_ids_from_memory_citation(memory_citation);
    if thread_ids.is_empty() {
        return true;
    }

    if let Some(db) = state_db_ctx {
        let _ = db.memories().record_stage1_output_usage(&thread_ids).await;
    }
    true
}

/// 处理模型流中已完成 output item 的返回类型别名，代表一个正在执行的工具调用 future。
pub(crate) type InFlightFuture<'f> =
    Pin<Box<dyn Future<Output = Result<ResponseInputItem>> + Send + 'f>>;

/// 处理单个 output item 后的结果。
#[derive(Default)]
pub(crate) struct OutputItemResult {
    /// 最后一条 agent 消息文本（若有）。
    pub last_agent_message: Option<String>,
    /// 是否需要后续 follow-up（如工具调用后需要再次请求模型）。
    pub needs_follow_up: bool,
    /// 正在执行的工具调用 future（若有）。
    pub tool_future: Option<InFlightFuture<'static>>,
}

/// 处理 output item 的上下文，持有会话、turn 上下文、工具运行时等。
pub(crate) struct HandleOutputCtx {
    /// 当前会话。
    pub sess: Arc<Session>,
    /// 当前 turn 上下文。
    pub turn_context: Arc<TurnContext>,
    /// turn 级扩展数据存储。
    pub turn_store: Arc<ExtensionData>,
    /// 工具调用运行时。
    pub tool_runtime: ToolCallRuntime,
    /// 取消令牌。
    pub cancellation_token: CancellationToken,
}

/// 应用所有已注册的 turn item contributor 到给定 item。
pub(crate) async fn apply_turn_item_contributors(
    sess: &Session,
    turn_store: &ExtensionData,
    item: &mut TurnItem,
) {
    let contributors = sess.services.extensions.turn_item_contributors().to_vec();
    for contributor in contributors {
        if let Err(err) = contributor
            .contribute(&sess.services.thread_extension_data, turn_store, item)
            .await
        {
            warn!("turn item contributor failed: {err}");
        }
    }
}

/// turn item contributor 的执行策略。
pub(crate) enum TurnItemContributorPolicy<'a> {
    /// 跳过 contributor。
    Skip,
    /// 运行 contributor，传入 turn 级扩展数据。
    Run(&'a ExtensionData),
}

/// 已最终化的 turn item 及其 facts。
pub(crate) struct FinalizedTurnItem {
    /// 最终的 turn item。
    pub(crate) turn_item: TurnItem,
    /// 从该 item 提取的 facts。
    pub(crate) facts: FinalizedTurnItemFacts,
}

/// 从已完成的非工具响应 item 中提取的 facts。
#[derive(Clone, Default)]
pub(crate) struct FinalizedTurnItemFacts {
    /// 解析到的记忆引用（若有）。
    pub(crate) memory_citation: Option<MemoryCitation>,
    /// 最后一条 agent 消息文本（若有）。
    pub(crate) last_agent_message: Option<String>,
    /// 是否将邮箱投递延迟到下一个 turn。
    pub(crate) defers_mailbox_delivery_to_next_turn: bool,
}

/// 最终化非工具响应 item：解析 turn item、运行 contributor、剥离隐藏标记。
pub(crate) async fn finalize_non_tool_response_item(
    sess: &Session,
    turn_context: &TurnContext,
    contributor_policy: TurnItemContributorPolicy<'_>,
    item: &ResponseItem,
    plan_mode: bool,
) -> Option<FinalizedTurnItem> {
    let turn_item =
        handle_non_tool_response_item(sess, turn_context, contributor_policy, item, plan_mode)
            .await?;
    let (memory_citation, last_agent_message, defers_mailbox_delivery_to_next_turn) =
        match &turn_item {
            TurnItem::AgentMessage(agent_message) => {
                let combined = agent_message
                    .content
                    .iter()
                    .map(|entry| match entry {
                        codex_protocol::items::AgentMessageContent::Text { text } => text.as_str(),
                    })
                    .collect::<String>();
                let last_agent_message = if combined.trim().is_empty() {
                    None
                } else {
                    Some(combined)
                };
                let defers_mailbox_delivery_to_next_turn =
                    !matches!(agent_message.phase, Some(MessagePhase::Commentary))
                        && last_agent_message.is_some();
                (
                    agent_message.memory_citation.clone(),
                    last_agent_message,
                    defers_mailbox_delivery_to_next_turn,
                )
            }
            TurnItem::ImageGeneration(_) => (None, None, true),
            _ => (None, None, false),
        };
    Some(FinalizedTurnItem {
        turn_item,
        facts: FinalizedTurnItemFacts {
            memory_citation,
            last_agent_message,
            defers_mailbox_delivery_to_next_turn,
        },
    })
}

/// 处理模型流中已完成的 output item：记录历史并排队工具执行。
///
/// 立即记录 item 使历史与 rollout 保持同步，即使 turn 后续被取消也不会丢失。
#[instrument(level = "trace", skip_all)]
pub(crate) async fn handle_output_item_done(
    ctx: &mut HandleOutputCtx,
    item: ResponseItem,
    previously_active_item: Option<TurnItem>,
) -> Result<OutputItemResult> {
    let mut output = OutputItemResult::default();
    let plan_mode = ctx.turn_context.collaboration_mode.mode == ModeKind::Plan;

    match ToolRouter::build_tool_call(item.clone()) {
        // 模型发出了工具调用：记录日志、立即持久化 item、排队工具执行。
        Ok(Some(call)) => {
            ctx.sess
                .input_queue
                .accept_mailbox_delivery_for_current_turn(
                    &ctx.sess.active_turn,
                    &ctx.turn_context.sub_id,
                )
                .await;

            let payload_preview = call.payload.log_payload().into_owned();
            tracing::info!(
                thread_id = %ctx.sess.thread_id,
                "ToolCall: {} {}",
                call.tool_name,
                payload_preview
            );

            record_completed_response_item(ctx.sess.as_ref(), ctx.turn_context.as_ref(), &item)
                .await;

            let cancellation_token = ctx.cancellation_token.child_token();
            let tool_future: InFlightFuture<'static> = Box::pin(
                ctx.tool_runtime
                    .clone()
                    .handle_tool_call(call, cancellation_token),
            );

            output.needs_follow_up = true;
            output.tool_future = Some(tool_future);
        }
        // 非工具调用：将消息/推理转换为 turn item 并标记为已完成。
        Ok(None) => {
            let finalized_turn_item = finalize_non_tool_response_item(
                ctx.sess.as_ref(),
                ctx.turn_context.as_ref(),
                TurnItemContributorPolicy::Run(ctx.turn_store.as_ref()),
                &item,
                plan_mode,
            )
            .await;
            let finalized_facts = finalized_turn_item
                .as_ref()
                .map(|finalized| finalized.facts.clone());
            if let Some(finalized_turn_item) = finalized_turn_item {
                if previously_active_item.is_none() {
                    let mut started_item = finalized_turn_item.turn_item.clone();
                    if let TurnItem::ImageGeneration(item) = &mut started_item {
                        item.status = "in_progress".to_string();
                        item.revised_prompt = None;
                        item.result.clear();
                        item.saved_path = None;
                    }
                    ctx.sess
                        .emit_turn_item_started(&ctx.turn_context, &started_item)
                        .await;
                }

                ctx.sess
                    .emit_turn_item_completed(&ctx.turn_context, finalized_turn_item.turn_item)
                    .await;
            }
            record_completed_response_item_with_finalized_facts(
                ctx.sess.as_ref(),
                ctx.turn_context.as_ref(),
                &item,
                finalized_facts.as_ref(),
            )
            .await;

            output.last_agent_message = finalized_facts.and_then(|facts| facts.last_agent_message);
        }
        // 工具请求应直接回复（或被拒绝）：将该响应推入 transcript。
        Err(FunctionCallError::RespondToModel(message)) => {
            let response = ResponseInputItem::FunctionCallOutput {
                call_id: String::new(),
                output: FunctionCallOutputPayload {
                    body: FunctionCallOutputBody::Text(message),
                    ..Default::default()
                },
            };
            record_completed_response_item(ctx.sess.as_ref(), ctx.turn_context.as_ref(), &item)
                .await;
            if let Some(response_item) = response_input_to_response_item(&response) {
                ctx.sess
                    .record_conversation_items(
                        &ctx.turn_context,
                        std::slice::from_ref(&response_item),
                    )
                    .await;
            }

            output.needs_follow_up = true;
        }
        // 发生致命错误：将其暴露回历史。
        Err(FunctionCallError::Fatal(message)) => {
            return Err(CodexErr::Fatal(message));
        }
    }

    Ok(output)
}

/// 处理非工具响应 item：解析为 turn item 并最终化。
///
/// 仅处理消息、推理、Web 搜索、图片生成等 item 类型；
/// 工具输出等意外类型返回 `None`。
pub(crate) async fn handle_non_tool_response_item(
    sess: &Session,
    turn_context: &TurnContext,
    contributor_policy: TurnItemContributorPolicy<'_>,
    item: &ResponseItem,
    plan_mode: bool,
) -> Option<TurnItem> {
    debug!(?item, "Output item");

    match item {
        ResponseItem::Message { .. }
        | ResponseItem::Reasoning { .. }
        | ResponseItem::WebSearchCall { .. }
        | ResponseItem::ImageGenerationCall { .. } => {
            let mut turn_item = parse_turn_item(item)?;
            finalize_turn_item(
                sess,
                turn_context,
                contributor_policy,
                &mut turn_item,
                plan_mode,
            )
            .await;
            if let TurnItem::ImageGeneration(image_item) = &turn_item {
                record_image_generation_instructions(sess, turn_context, image_item).await;
            }
            Some(turn_item)
        }
        ResponseItem::FunctionCallOutput { .. }
        | ResponseItem::CustomToolCallOutput { .. }
        | ResponseItem::ToolSearchOutput { .. } => {
            debug!("unexpected tool output from stream");
            None
        }
        _ => None,
    }
}

/// 最终化 turn item：运行 contributor、剥离隐藏标记、持久化图片生成结果。
pub(crate) async fn finalize_turn_item(
    sess: &Session,
    turn_context: &TurnContext,
    contributor_policy: TurnItemContributorPolicy<'_>,
    turn_item: &mut TurnItem,
    plan_mode: bool,
) {
    if let TurnItemContributorPolicy::Run(turn_store) = contributor_policy {
        apply_turn_item_contributors(sess, turn_store, turn_item).await;
    }
    if let TurnItem::AgentMessage(agent_message) = &mut *turn_item {
        let combined = agent_message
            .content
            .iter()
            .map(|entry| match entry {
                codex_protocol::items::AgentMessageContent::Text { text } => text.as_str(),
            })
            .collect::<String>();
        let (stripped, memory_citation) =
            strip_hidden_assistant_markup_and_parse_memory_citation(&combined, plan_mode);
        agent_message.content =
            vec![codex_protocol::items::AgentMessageContent::Text { text: stripped }];
        if agent_message.memory_citation.is_none() {
            agent_message.memory_citation = memory_citation;
        }
    }
    if let TurnItem::ImageGeneration(image_item) = &mut *turn_item
        && !image_item.result.is_empty()
    {
        persist_image_generation_item(sess, turn_context, image_item).await;
    }
}

/// 从 `ResponseItem` 中提取最后一条 assistant 消息文本，并剥离隐藏标记。
pub(crate) fn last_assistant_message_from_item(
    item: &ResponseItem,
    plan_mode: bool,
) -> Option<String> {
    if let Some(combined) = raw_assistant_output_text_from_item(item) {
        if combined.is_empty() {
            return None;
        }
        let stripped = strip_hidden_assistant_markup(&combined, plan_mode);
        if stripped.trim().is_empty() {
            return None;
        }
        return Some(stripped);
    }
    None
}

fn completed_item_defers_mailbox_delivery_to_next_turn(
    item: &ResponseItem,
    plan_mode: bool,
) -> bool {
    match item {
        ResponseItem::Message { role, phase, .. } => {
            if role != "assistant" || matches!(phase, Some(MessagePhase::Commentary)) {
                return false;
            }
            // 将 `None` 视为 final-answer 文本，使未标记的 provider 默认采用
            // 更安全的"延迟邮箱投递"行为。
            last_assistant_message_from_item(item, plan_mode).is_some()
        }
        ResponseItem::ImageGenerationCall { .. } => true,
        _ => false,
    }
}

/// 将 `ResponseInputItem` 转换为 `ResponseItem`，用于将工具输出等推入会话历史。
pub(crate) fn response_input_to_response_item(input: &ResponseInputItem) -> Option<ResponseItem> {
    match input {
        ResponseInputItem::FunctionCallOutput { call_id, output } => {
            Some(ResponseItem::FunctionCallOutput {
                id: None,
                call_id: call_id.clone(),
                output: output.clone(),
                internal_chat_message_metadata_passthrough: None,
            })
        }
        ResponseInputItem::CustomToolCallOutput {
            call_id,
            name,
            output,
        } => Some(ResponseItem::CustomToolCallOutput {
            id: None,
            call_id: call_id.clone(),
            name: name.clone(),
            output: output.clone(),
            internal_chat_message_metadata_passthrough: None,
        }),
        ResponseInputItem::McpToolCallOutput { call_id, output } => {
            let output = output.as_function_call_output_payload();
            Some(ResponseItem::FunctionCallOutput {
                id: None,
                call_id: call_id.clone(),
                output,
                internal_chat_message_metadata_passthrough: None,
            })
        }
        ResponseInputItem::ToolSearchOutput {
            call_id,
            status,
            execution,
            tools,
        } => Some(ResponseItem::ToolSearchOutput {
            id: None,
            call_id: Some(call_id.clone()),
            status: status.clone(),
            execution: execution.clone(),
            tools: tools.clone(),
            internal_chat_message_metadata_passthrough: None,
        }),
        _ => None,
    }
}

#[cfg(test)]
#[path = "stream_events_utils_tests.rs"]
mod tests;
