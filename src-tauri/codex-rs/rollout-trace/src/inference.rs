//! 用于记录 upstream inference attempts 的 hot-path 辅助函数。
//!
//! model client 不应需要知道 rollout tracing 是否启用。disabled context
//! 不记录任何内容，这使得 one-shot HTTP calls、WebSocket reuse 与
//! retry/fallback attempts 走同一套代码路径。

use std::fmt::Display;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::TokenUsage;
use http::HeaderMap;
use http::HeaderValue;
use serde::Serialize;
use serde_json::Value as JsonValue;
use uuid::Uuid;

use crate::model::AgentThreadId;
use crate::model::CodexTurnId;
use crate::model::InferenceCallId;
use crate::payload::RawPayloadKind;
use crate::raw_event::RawTraceEventContext;
use crate::raw_event::RawTraceEventPayload;
use crate::writer::TraceWriter;

const INFERENCE_CALL_ID_HEADER: &str = "x-codex-inference-call-id";

/// Turn-local inference tracing context。
///
/// 刻意设计为 no-op capable handle，而非在每个 transport callsite 使用 `Option`。
/// tracing 是否启用是 session 级关注点；retry、fallback 与 stream mapping
/// 代码应始终能描述发生了什么，无需先判断 trace 是否可用。
#[derive(Clone, Debug)]
pub struct InferenceTraceContext {
    state: InferenceTraceContextState,
}

#[derive(Clone, Debug)]
enum InferenceTraceContextState {
    Disabled,
    Enabled(EnabledInferenceTraceContext),
}

#[derive(Clone, Debug)]
struct EnabledInferenceTraceContext {
    writer: Arc<TraceWriter>,
    thread_id: AgentThreadId,
    codex_turn_id: CodexTurnId,
    model: String,
    provider_name: String,
}

/// One concrete upstream request attempt.
///
/// A Codex turn can create multiple attempts when auth recovery retries the
/// HTTP request or WebSocket setup falls back to HTTP. Completion is often
/// observed after the client returns the response stream, so the attempt owns
/// the terminal guard that prevents duplicate lifecycle events.
#[derive(Debug)]
pub struct InferenceTraceAttempt {
    state: InferenceTraceAttemptState,
}

#[derive(Debug)]
enum InferenceTraceAttemptState {
    Disabled,
    Enabled(EnabledInferenceTraceAttempt),
}

#[derive(Debug)]
struct EnabledInferenceTraceAttempt {
    context: EnabledInferenceTraceContext,
    inference_call_id: InferenceCallId,
    terminal_recorded: AtomicBool,
}

/// Non-delta response payload saved for completed or interrupted inference streams.
///
/// We intentionally record completed output items instead of every stream delta
/// here. The raw stream can be added later as a separate payload class; this
/// response summary gives the reducer stable response identity when available
/// plus model-visible output without duplicating high-volume text deltas.
#[derive(Serialize)]
struct TracedResponseStreamOutput<'a> {
    response_id: Option<&'a str>,
    upstream_request_id: Option<&'a str>,
    token_usage: Option<&'a TokenUsage>,
    output_items: Vec<JsonValue>,
}

impl InferenceTraceContext {
    /// Builds a context that accepts trace calls and records nothing.
    pub fn disabled() -> Self {
        Self {
            state: InferenceTraceContextState::Disabled,
        }
    }

    /// Builds an enabled context for all upstream attempts made by one Codex turn.
    pub fn enabled(
        writer: Arc<TraceWriter>,
        thread_id: AgentThreadId,
        codex_turn_id: CodexTurnId,
        model: String,
        provider_name: String,
    ) -> Self {
        Self {
            state: InferenceTraceContextState::Enabled(EnabledInferenceTraceContext {
                writer,
                thread_id,
                codex_turn_id,
                model,
                provider_name,
            }),
        }
    }

    /// Starts a new attempt after the concrete provider request has been built.
    pub fn start_attempt(&self) -> InferenceTraceAttempt {
        let InferenceTraceContextState::Enabled(context) = &self.state else {
            return InferenceTraceAttempt::disabled();
        };

        InferenceTraceAttempt {
            state: InferenceTraceAttemptState::Enabled(EnabledInferenceTraceAttempt {
                context: context.clone(),
                inference_call_id: next_inference_call_id(),
                terminal_recorded: AtomicBool::new(false),
            }),
        }
    }
}

impl InferenceTraceAttempt {
    /// Builds an attempt that records nothing.
    pub fn disabled() -> Self {
        Self {
            state: InferenceTraceAttemptState::Disabled,
        }
    }

    fn inference_call_id(&self) -> Option<&str> {
        match &self.state {
            InferenceTraceAttemptState::Disabled => None,
            InferenceTraceAttemptState::Enabled(attempt) => {
                Some(attempt.inference_call_id.as_str())
            }
        }
    }

    /// Adds rollout-trace propagation headers for this attempt when tracing is enabled.
    pub fn add_request_headers(&self, headers: &mut HeaderMap) {
        let Some(inference_call_id) = self.inference_call_id() else {
            return;
        };
        let Ok(inference_call_id) = HeaderValue::from_str(inference_call_id) else {
            // These IDs are generated internally as UUID strings, so rejection
            // should be impossible in practice. Tracing remains best-effort,
            // though, and must never make provider requests fail.
            return;
        };

        headers.insert(INFERENCE_CALL_ID_HEADER, inference_call_id);
    }

    /// 记录 replay 应视为 model-visible inference input 的 request payload。
    ///
    /// 通常为确切的 provider request。当 transport 省略已发送的 input 时
    /// （如 untraced warmup response 后的 websocket reuse），调用方可改为
    /// 传入 logical request。
    pub fn record_started(&self, request: &impl Serialize) {
        let InferenceTraceAttemptState::Enabled(attempt) = &self.state else {
            return;
        };
        let Some(request_payload) = write_json_payload_best_effort(
            &attempt.context.writer,
            RawPayloadKind::InferenceRequest,
            request,
        ) else {
            return;
        };

        append_with_context_best_effort(
            &attempt.context,
            RawTraceEventPayload::InferenceStarted {
                inference_call_id: attempt.inference_call_id.clone(),
                thread_id: attempt.context.thread_id.clone(),
                codex_turn_id: attempt.context.codex_turn_id.clone(),
                model: attempt.context.model.clone(),
                provider_name: attempt.context.provider_name.clone(),
                request_payload,
            },
        );
    }

    /// Records successful provider completion and serializes the observed output items.
    ///
    /// Callers pass protocol-native response items so this crate owns the
    /// trace-specific serialization rules. That keeps codex-core focused on
    /// transport behavior while preserving trace evidence that normal request
    /// serialization intentionally omits.
    pub fn record_completed(
        &self,
        response_id: &str,
        upstream_request_id: Option<&str>,
        token_usage: &Option<TokenUsage>,
        output_items: &[ResponseItem],
    ) {
        let Some(attempt) = self.take_terminal_attempt() else {
            return;
        };
        let Some(response_payload) = write_response_payload_best_effort(
            attempt,
            Some(response_id),
            upstream_request_id,
            token_usage.as_ref(),
            output_items,
        ) else {
            return;
        };

        append_with_context_best_effort(
            &attempt.context,
            RawTraceEventPayload::InferenceCompleted {
                inference_call_id: attempt.inference_call_id.clone(),
                response_id: Some(response_id.to_string()),
                upstream_request_id: upstream_request_id.map(str::to_string),
                response_payload,
            },
        );
    }

    /// Records pre-response and mid-stream failures.
    pub fn record_failed(
        &self,
        error: impl Display,
        upstream_request_id: Option<&str>,
        output_items: &[ResponseItem],
    ) {
        let Some(attempt) = self.take_terminal_attempt() else {
            return;
        };
        let partial_response_payload = if output_items.is_empty() {
            None
        } else {
            write_response_payload_best_effort(
                attempt,
                /*response_id*/ None,
                upstream_request_id,
                /*token_usage*/ None,
                output_items,
            )
        };
        append_with_context_best_effort(
            &attempt.context,
            RawTraceEventPayload::InferenceFailed {
                inference_call_id: attempt.inference_call_id.clone(),
                upstream_request_id: upstream_request_id.map(str::to_string),
                error: error.to_string(),
                partial_response_payload,
            },
        );
    }

    /// 记录 Codex 有意停止消费的 provider stream。
    ///
    /// 当 turn 被中断或 mailbox delivery 抢占当前 sampling request 时发生。
    /// 在此之前观察到的 complete output items 保留为 partial response evidence。
    pub fn record_cancelled(
        &self,
        reason: impl Display,
        upstream_request_id: Option<&str>,
        output_items: &[ResponseItem],
    ) {
        let Some(attempt) = self.take_terminal_attempt() else {
            return;
        };
        let partial_response_payload = if output_items.is_empty() {
            None
        } else {
            write_response_payload_best_effort(
                attempt,
                /*response_id*/ None,
                upstream_request_id,
                /*token_usage*/ None,
                output_items,
            )
        };
        append_with_context_best_effort(
            &attempt.context,
            RawTraceEventPayload::InferenceCancelled {
                inference_call_id: attempt.inference_call_id.clone(),
                upstream_request_id: upstream_request_id.map(str::to_string),
                reason: reason.to_string(),
                partial_response_payload,
            },
        );
    }

    fn take_terminal_attempt(&self) -> Option<&EnabledInferenceTraceAttempt> {
        let attempt = match &self.state {
            InferenceTraceAttemptState::Disabled => return None,
            InferenceTraceAttemptState::Enabled(attempt) => attempt,
        };
        if attempt.terminal_recorded.swap(true, Ordering::AcqRel) {
            return None;
        }
        Some(attempt)
    }
}

/// 为 trace evidence 而非未来 request construction 序列化 response item。
///
/// protocol serializer 在为后续 model requests 整理 items 时，刻意省略了
/// 部分 readable reasoning content。Rollout traces 需要 item 的原始形态
/// （即 Codex 收到时的样子），因此该 helper 在 raw payload 中恢复该内容。
pub(crate) fn trace_response_item_json(item: &ResponseItem) -> JsonValue {
    let mut value = serde_json::to_value(item).unwrap_or_else(|err| {
        serde_json::json!({
            "serialization_error": err.to_string(),
        })
    });

    if let ResponseItem::Reasoning {
        content: Some(content),
        ..
    } = item
        && let JsonValue::Object(object) = &mut value
    {
        object.insert(
            "content".to_string(),
            serde_json::to_value(content).unwrap_or_else(|err| {
                serde_json::json!({
                    "serialization_error": err.to_string(),
                })
            }),
        );
    }

    value
}

fn next_inference_call_id() -> InferenceCallId {
    Uuid::new_v4().to_string()
}

fn write_json_payload_best_effort(
    writer: &TraceWriter,
    kind: RawPayloadKind,
    payload: &impl Serialize,
) -> Option<crate::RawPayloadRef> {
    writer.write_json_payload(kind, payload).ok()
}

fn write_response_payload_best_effort(
    attempt: &EnabledInferenceTraceAttempt,
    response_id: Option<&str>,
    upstream_request_id: Option<&str>,
    token_usage: Option<&TokenUsage>,
    output_items: &[ResponseItem],
) -> Option<crate::RawPayloadRef> {
    let response_payload = TracedResponseStreamOutput {
        response_id,
        upstream_request_id,
        token_usage,
        output_items: output_items.iter().map(trace_response_item_json).collect(),
    };
    write_json_payload_best_effort(
        &attempt.context.writer,
        RawPayloadKind::InferenceResponse,
        &response_payload,
    )
}

fn append_with_context_best_effort(
    context: &EnabledInferenceTraceContext,
    payload: RawTraceEventPayload,
) {
    let event_context = RawTraceEventContext {
        thread_id: Some(context.thread_id.clone()),
        codex_turn_id: Some(context.codex_turn_id.clone()),
    };
    let _ = context.writer.append_with_context(event_context, payload);
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use codex_protocol::models::ReasoningItemContent;
    use codex_protocol::models::ReasoningItemReasoningSummary;
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::model::ExecutionStatus;
    use crate::replay_bundle;

    #[test]
    fn disabled_attempt_adds_no_request_headers() {
        let mut headers = HeaderMap::new();

        InferenceTraceAttempt::disabled().add_request_headers(&mut headers);

        assert!(headers.is_empty());
    }

    #[test]
    fn enabled_attempt_adds_inference_request_header() -> anyhow::Result<()> {
        let temp = TempDir::new()?;
        let writer = Arc::new(TraceWriter::create(
            temp.path(),
            "trace-1".to_string(),
            "rollout-1".to_string(),
            "thread-root".to_string(),
        )?);
        let context = InferenceTraceContext::enabled(
            writer,
            "thread-root".to_string(),
            "turn-1".to_string(),
            "gpt-test".to_string(),
            "test-provider".to_string(),
        );
        let attempt = context.start_attempt();
        let mut headers = HeaderMap::new();

        attempt.add_request_headers(&mut headers);

        let header = headers
            .get(INFERENCE_CALL_ID_HEADER)
            .expect("inference header present");
        assert_eq!(Some(header.to_str()?), attempt.inference_call_id());
        assert!(Uuid::parse_str(header.to_str()?).is_ok());
        Ok(())
    }

    #[test]
    fn enabled_context_records_replayable_inference_attempt() -> anyhow::Result<()> {
        let temp = TempDir::new()?;
        let writer = Arc::new(TraceWriter::create(
            temp.path(),
            "trace-1".to_string(),
            "rollout-1".to_string(),
            "thread-root".to_string(),
        )?);
        writer.append(RawTraceEventPayload::ThreadStarted {
            thread_id: "thread-root".to_string(),
            agent_path: "/root".to_string(),
            metadata_payload: None,
        })?;
        writer.append(RawTraceEventPayload::CodexTurnStarted {
            codex_turn_id: "turn-1".to_string(),
            thread_id: "thread-root".to_string(),
        })?;
        let context = InferenceTraceContext::enabled(
            writer,
            "thread-root".to_string(),
            "turn-1".to_string(),
            "gpt-test".to_string(),
            "test-provider".to_string(),
        );

        let attempt = context.start_attempt();
        attempt.record_started(&json!({
            "model": "gpt-test",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "hello"}]
            }],
        }));
        attempt.record_completed("resp-1", Some("req-1"), &None, &[]);

        let rollout = replay_bundle(temp.path())?;
        let inference = rollout
            .inference_calls
            .values()
            .next()
            .expect("recorded inference call");

        assert_eq!(rollout.inference_calls.len(), 1);
        assert_eq!(inference.thread_id, "thread-root");
        assert_eq!(inference.codex_turn_id, "turn-1");
        assert_eq!(inference.execution.status, ExecutionStatus::Completed);
        assert_eq!(inference.upstream_request_id, Some("req-1".to_string()));
        assert_eq!(rollout.raw_payloads.len(), 2);

        Ok(())
    }

    #[test]
    fn traced_response_item_preserves_reasoning_content_omitted_by_normal_serializer() {
        let item = ResponseItem::Reasoning {
            id: Some("rs-1".to_string()),
            summary: vec![ReasoningItemReasoningSummary::SummaryText {
                text: "summary".to_string(),
            }],
            content: Some(vec![ReasoningItemContent::Text {
                text: "raw reasoning".to_string(),
            }]),
            encrypted_content: Some("encoded".to_string()),
            internal_chat_message_metadata_passthrough: None,
        };

        let normal = serde_json::to_value(&item).expect("response item serializes");
        let traced = trace_response_item_json(&item);

        assert_eq!(normal.get("content"), None);
        assert_eq!(
            traced,
            json!({
                "type": "reasoning",
                "id": "rs-1",
                "summary": [{"type": "summary_text", "text": "summary"}],
                "content": [{"type": "text", "text": "raw reasoning"}],
                "encrypted_content": "encoded",
            }),
        );
    }
}
