use crate::error::ApiError;
use codex_protocol::config_types::ReasoningSummary as ReasoningSummaryConfig;
use codex_protocol::config_types::Verbosity as VerbosityConfig;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ReasoningEffort as ReasoningEffortConfig;
use codex_protocol::protocol::ModelVerification;
use codex_protocol::protocol::RateLimitSnapshot;
use codex_protocol::protocol::TokenUsage;
use codex_protocol::protocol::TurnModerationMetadataEvent;
use codex_protocol::protocol::W3cTraceContext;
use futures::Stream;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;
use tokio::sync::mpsc;

/// WebSocket 请求中携带 W3C Trace Context `traceparent` 的 client metadata 键。
pub const WS_REQUEST_HEADER_TRACEPARENT_CLIENT_METADATA_KEY: &str = "ws_request_header_traceparent";
/// WebSocket 请求中携带 W3C Trace Context `tracestate` 的 client metadata 键。
pub const WS_REQUEST_HEADER_TRACESTATE_CLIENT_METADATA_KEY: &str = "ws_request_header_tracestate";

/// compaction 端点的标准输入载荷。
#[derive(Debug, Clone, Serialize)]
pub struct CompactionInput<'a> {
    pub model: &'a str,
    pub input: &'a [ResponseItem],
    #[serde(skip_serializing_if = "str::is_empty")]
    pub instructions: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    pub parallel_tool_calls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Reasoning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextControls>,
}

/// memory summarize 端点的标准输入载荷。
#[derive(Debug, Clone, Serialize)]
pub struct MemorySummarizeInput {
    pub model: String,
    #[serde(rename = "traces")]
    pub raw_memories: Vec<RawMemory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Reasoning>,
}

/// 单条原始 memory 记录，作为 memory summarize 的输入。
#[derive(Debug, Clone, Serialize)]
pub struct RawMemory {
    pub id: String,
    pub metadata: RawMemoryMetadata,
    pub items: Vec<Value>,
}

/// 原始 memory 的元数据，记录来源路径。
#[derive(Debug, Clone, Serialize)]
pub struct RawMemoryMetadata {
    pub source_path: String,
}

/// memory summarize 端点的输出结构。
///
/// 同时支持新旧字段名（`trace_summary` / `raw_memory`）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct MemorySummarizeOutput {
    #[serde(rename = "trace_summary", alias = "raw_memory")]
    pub raw_memory: String,
    pub memory_summary: String,
}

/// Responses API 流式响应事件。
///
/// 每个变体对应服务端下发的一种事件类型，包括创建、增量、完成、安全缓冲、
/// 速率限制、模型校验、moderation 元数据等。
#[derive(Debug)]
pub enum ResponseEvent {
    Created,
    SafetyBuffering(SafetyBuffering),
    OutputItemDone(ResponseItem),
    OutputItemAdded(ResponseItem),
    /// 当服务端在流响应中包含 `OpenAI-Model` 时触发。
    /// 当后端安全路由生效时，该模型可能与请求的模型不同。
    ServerModel(String),
    /// 当服务端建议额外的账户验证时触发。
    ModelVerifications(Vec<ModelVerification>),
    /// 当服务端为 first-party turn 展示下发 moderation 元数据时触发。
    TurnModerationMetadata(TurnModerationMetadataEvent),
    /// 当响应中存在 `X-Reasoning-Included: true` 时触发，
    /// 表示服务端已经计入历史 reasoning tokens，客户端不应再次估算。
    ServerReasoningIncluded(bool),
    Completed {
        response_id: String,
        token_usage: Option<TokenUsage>,
        /// 模型是否明确结束了本轮 turn？某些 provider 不会设置该字段，
        /// 因此为 `None` 时客户端需依赖兜底逻辑。
        end_turn: Option<bool>,
    },
    OutputTextDelta(String),
    ToolCallInputDelta {
        item_id: String,
        call_id: Option<String>,
        delta: String,
    },
    ReasoningSummaryDelta {
        delta: String,
        summary_index: i64,
    },
    ReasoningContentDelta {
        delta: String,
        content_index: i64,
    },
    ReasoningSummaryPartAdded {
        summary_index: i64,
    },
    RateLimits(RateLimitSnapshot),
    ModelsEtag(String),
}

/// 安全缓冲（safety buffering）事件载荷。
///
/// 当后端安全系统判定需要缓冲时下发，包含触发用例与原因。`show_buffering_ui`
/// 与 `faster_model` 不参与序列化，由客户端基于 treatment 配置填充。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SafetyBuffering {
    pub use_cases: Vec<String>,
    pub reasons: Vec<String>,
    #[serde(skip)]
    pub show_buffering_ui: bool,
    #[serde(skip)]
    pub faster_model: Option<String>,
}

impl SafetyBuffering {
    /// 应用 safety buffering treatment 配置，返回更新后的 `SafetyBuffering`。
    pub(crate) fn with_treatment(mut self, treatment: &SafetyBufferingTreatment) -> Self {
        self.show_buffering_ui = treatment.show_buffering_ui;
        self.faster_model.clone_from(&treatment.faster_model);
        self
    }
}

/// safety buffering 的 treatment 配置，决定是否展示缓冲 UI 与使用的更快模型。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SafetyBufferingTreatment {
    pub show_buffering_ui: bool,
    pub faster_model: Option<String>,
}

/// reasoning 上下文范围枚举，控制推理时纳入的历史 turn 范围。
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningContext {
    Auto,
    CurrentTurn,
    AllTurns,
}

/// reasoning 配置，包含 effort、summary 与 context 三个可选子项。
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Reasoning {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<ReasoningEffortConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<ReasoningSummaryConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ReasoningContext>,
}

/// text controls 中的格式类型枚举。
///
/// 当前仅支持 `json_schema`。
#[derive(Debug, Serialize, Default, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TextFormatType {
    #[default]
    JsonSchema,
}

/// text controls 中的输出格式定义。
#[derive(Debug, Serialize, Default, Clone, PartialEq)]
pub struct TextFormat {
    /// OpenAI text controls 使用的格式类型。
    pub r#type: TextFormatType,
    /// 为 `true` 时，服务端将严格校验响应格式。
    pub strict: bool,
    /// 期望输出的 JSON schema。
    pub schema: Value,
    /// 格式的友好名称，用于遥测与调试。
    pub name: String,
}

/// 控制 Responses API 的 `text` 字段，组合 verbosity 与可选的 JSON schema 输出格式。
#[derive(Debug, Serialize, Default, Clone, PartialEq)]
pub struct TextControls {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verbosity: Option<OpenAiVerbosity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<TextFormat>,
}

/// OpenAI 响应 verbosity 枚举。
#[derive(Debug, Serialize, Default, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OpenAiVerbosity {
    Low,
    #[default]
    Medium,
    High,
}

impl From<VerbosityConfig> for OpenAiVerbosity {
    fn from(v: VerbosityConfig) -> Self {
        match v {
            VerbosityConfig::Low => OpenAiVerbosity::Low,
            VerbosityConfig::Medium => OpenAiVerbosity::Medium,
            VerbosityConfig::High => OpenAiVerbosity::High,
        }
    }
}

/// Responses API（HTTP）请求载荷。
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ResponsesApiRequest {
    pub model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    pub input: Vec<ResponseItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<serde_json::Value>>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
    pub reasoning: Option<Reasoning>,
    pub store: bool,
    pub stream: bool,
    pub include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextControls>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<HashMap<String, String>>,
}

impl From<&ResponsesApiRequest> for ResponseCreateWsRequest {
    fn from(request: &ResponsesApiRequest) -> Self {
        Self {
            model: request.model.clone(),
            instructions: request.instructions.clone(),
            previous_response_id: None,
            input: request.input.clone(),
            tools: request.tools.clone(),
            tool_choice: request.tool_choice.clone(),
            parallel_tool_calls: request.parallel_tool_calls,
            reasoning: request.reasoning.clone(),
            store: request.store,
            stream: request.stream,
            include: request.include.clone(),
            service_tier: request.service_tier.clone(),
            prompt_cache_key: request.prompt_cache_key.clone(),
            text: request.text.clone(),
            generate: None,
            client_metadata: request.client_metadata.clone(),
        }
    }
}

/// Responses API（WebSocket）的 `response.create` 请求载荷。
///
/// 相比 HTTP 版本多了 `previous_response_id` 与 `generate` 字段。
#[derive(Debug, Serialize)]
pub struct ResponseCreateWsRequest {
    pub model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_response_id: Option<String>,
    pub input: Vec<ResponseItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
    pub reasoning: Option<Reasoning>,
    pub store: bool,
    pub stream: bool,
    pub include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextControls>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<HashMap<String, String>>,
}

/// 构造 Responses WebSocket 请求的 `client_metadata` 字段。
///
/// 将可选的现有 `client_metadata` 与 W3C Trace Context（`traceparent` /
/// `tracestate`）合并。当结果为空时返回 `None`。
///
/// # 参数
///
/// - `client_metadata`: 已有的 client metadata（可能为 `None`）
/// - `trace`: 可选的 W3C Trace Context
pub fn response_create_client_metadata(
    client_metadata: Option<HashMap<String, String>>,
    trace: Option<&W3cTraceContext>,
) -> Option<HashMap<String, String>> {
    let mut client_metadata = client_metadata.unwrap_or_default();

    if let Some(traceparent) = trace.and_then(|trace| trace.traceparent.as_deref()) {
        client_metadata.insert(
            WS_REQUEST_HEADER_TRACEPARENT_CLIENT_METADATA_KEY.to_string(),
            traceparent.to_string(),
        );
    }
    if let Some(tracestate) = trace.and_then(|trace| trace.tracestate.as_deref()) {
        client_metadata.insert(
            WS_REQUEST_HEADER_TRACESTATE_CLIENT_METADATA_KEY.to_string(),
            tracestate.to_string(),
        );
    }

    (!client_metadata.is_empty()).then_some(client_metadata)
}

/// Responses WebSocket 请求的顶层枚举，当前仅支持 `response.create`。
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
#[allow(clippy::large_enum_variant)]
pub enum ResponsesWsRequest {
    #[serde(rename = "response.create")]
    ResponseCreate(ResponseCreateWsRequest),
}

/// 根据 verbosity 与输出 schema 构造 Responses API 的 `text` 参数。
///
/// 当 `verbosity` 与 `output_schema` 均为 `None` 时返回 `None`，表示不发送
/// `text` 字段。否则构造 [`TextControls`]，将 schema 包装为 `TextFormat`。
///
/// # 参数
///
/// - `verbosity`: 可选的 verbosity 配置
/// - `output_schema`: 可选的输出 JSON schema
/// - `output_schema_strict`: 是否要求服务端严格校验 schema
pub fn create_text_param_for_request(
    verbosity: Option<VerbosityConfig>,
    output_schema: &Option<Value>,
    output_schema_strict: bool,
) -> Option<TextControls> {
    if verbosity.is_none() && output_schema.is_none() {
        return None;
    }

    Some(TextControls {
        verbosity: verbosity.map(std::convert::Into::into),
        format: output_schema.as_ref().map(|schema| TextFormat {
            r#type: TextFormatType::JsonSchema,
            strict: output_schema_strict,
            schema: schema.clone(),
            name: "codex_output_schema".to_string(),
        }),
    })
}

/// Responses API 的流式响应包装器。
///
/// 通过 mpsc channel 接收 [`ResponseEvent`]，并实现 `futures::Stream` trait
/// 以便组合使用。同时携带服务端返回的 `x-request-id`。
pub struct ResponseStream {
    pub rx_event: mpsc::Receiver<Result<ResponseEvent, ApiError>>,
    /// 服务端返回的 `x-request-id` 响应头（若存在）。
    pub upstream_request_id: Option<String>,
}

impl Stream for ResponseStream {
    type Item = Result<ResponseEvent, ApiError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx_event.poll_recv(cx)
    }
}
