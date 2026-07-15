//! 工具调用的上下文与输出类型定义。
//!
//! 本模块定义了工具调用的 invocation 上下文（`ToolInvocation`）、调用来源（`ToolCallSource`）
//! 以及多种工具输出类型（`McpToolOutput`、`FunctionToolOutput`、`ApplyPatchToolOutput`、
//! `AbortedToolOutput`、`ExecCommandToolOutput` 等）。

use crate::context_manager::truncate_function_output_payload;
use crate::original_image_detail::sanitize_original_image_detail;
use crate::session::session::Session;
use crate::session::step_context::StepContext;
use crate::session::turn_context::TurnContext;
use crate::tools::TELEMETRY_PREVIEW_MAX_BYTES;
use crate::tools::TELEMETRY_PREVIEW_MAX_LINES;
use crate::tools::TELEMETRY_PREVIEW_TRUNCATION_NOTICE;
use crate::turn_diff_tracker::TurnDiffTracker;
use crate::unified_exec::resolve_max_tokens;
use codex_protocol::mcp::CallToolResult;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ResponseInputItem;
use codex_protocol::models::function_call_output_content_items_to_text;
use codex_tools::LoadableToolSpec;
use codex_tools::ToolName;
use codex_utils_output_truncation::TruncationPolicy;
use codex_utils_output_truncation::formatted_truncate_text;
use codex_utils_string::take_bytes_at_char_boundary;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub use codex_tools::ToolOutput;
pub use codex_tools::ToolPayload;

/// 将一个 `ToolOutput` 实例装箱为 `Box<dyn ToolOutput>`。
pub(crate) fn boxed_tool_output<T>(output: T) -> Box<dyn ToolOutput>
where
    T: ToolOutput + 'static,
{
    Box::new(output)
}

/// 共享的 turn 级 diff tracker 类型别名。
pub type SharedTurnDiffTracker = Arc<Mutex<TurnDiffTracker>>;

/// 工具调用的来源。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolCallSource {
    /// 由模型直接发起的工具调用。
    Direct,
    /// 由 code mode 的某个 cell 发起的嵌套工具调用。
    CodeMode {
        /// 发起嵌套工具请求的 runtime cell ID。
        cell_id: String,
        /// code mode 中每个 cell 内的工具调用 ID。
        /// 该 ID 仅用于调试 JS/runtime 桥接，
        /// 不是 Codex 的工具调用 ID，因为它只需在单个 cell 内唯一即可。
        runtime_tool_call_id: String,
    },
}

/// 工具调用上下文，封装工具执行所需的全部共享状态。
#[derive(Clone)]
pub struct ToolInvocation {
    /// 当前会话句柄。
    pub session: Arc<Session>,
    // TODO(sayan): 待 handler 全面使用 `step_context.turn` 后移除该兼容字段。
    /// 当前 turn 上下文（兼容字段）。
    pub turn: Arc<TurnContext>,
    /// 当前 step 上下文。
    pub(crate) step_context: Arc<StepContext>,
    /// 取消令牌。
    pub cancellation_token: CancellationToken,
    /// diff tracker。
    pub tracker: SharedTurnDiffTracker,
    /// 工具调用 ID。
    pub call_id: String,
    /// 工具名称。
    pub tool_name: ToolName,
    /// 调用来源。
    pub source: ToolCallSource,
    /// 调用 payload。
    pub payload: ToolPayload,
}

/// MCP 工具调用输出。
#[derive(Clone, Debug)]
pub struct McpToolOutput {
    /// MCP `CallToolResult`。
    pub result: CallToolResult,
    /// 工具输入参数（JSON）。
    pub tool_input: JsonValue,
    /// 工具执行 wall time。
    pub wall_time: Duration,
    /// 是否支持 original image detail。
    pub original_image_detail_supported: bool,
    /// 输出截断策略。
    pub truncation_policy: TruncationPolicy,
}

impl ToolOutput for McpToolOutput {
    fn log_preview(&self) -> String {
        let payload = self.response_payload();
        let preview = payload.body.to_text().unwrap_or_else(|| {
            serde_json::to_string(&self.result.content)
                .unwrap_or_else(|err| format!("failed to serialize mcp result: {err}"))
        });
        telemetry_preview(&preview)
    }

    fn success_for_logging(&self) -> bool {
        self.result.success()
    }

    fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem {
        ResponseInputItem::FunctionCallOutput {
            call_id: call_id.to_string(),
            output: self.response_payload(),
        }
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        serde_json::to_value(&self.result).unwrap_or_else(|err| {
            JsonValue::String(format!("failed to serialize mcp result: {err}"))
        })
    }

    fn post_tool_use_input(&self, _payload: &ToolPayload) -> Option<JsonValue> {
        Some(self.tool_input.clone())
    }

    fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue> {
        serde_json::to_value(&self.result).ok()
    }
}

impl McpToolOutput {
    /// 构造面向模型可见的 `FunctionCallOutputPayload`，包含 wall time 头部与截断处理。
    fn response_payload(&self) -> FunctionCallOutputPayload {
        let mut payload = self.result.as_function_call_output_payload();
        if let Some(items) = payload.content_items_mut() {
            sanitize_original_image_detail(self.original_image_detail_supported, items);
        }

        let wall_time_seconds = self.wall_time.as_secs_f64();
        let header = format!("Wall time: {wall_time_seconds:.4} seconds\nOutput:");

        match &mut payload.body {
            FunctionCallOutputBody::Text(text) => {
                if text.is_empty() {
                    *text = header;
                } else {
                    *text = format!("{header}\n{text}");
                }
            }
            FunctionCallOutputBody::ContentItems(items) => {
                items.insert(0, FunctionCallOutputContentItem::InputText { text: header });
            }
        }

        // 这是上下文注入形式，因此保持与会话历史中 function-call 输出截断一致。
        // code mode 消费者仍然会拿到原始的 `CallToolResult`。
        //
        // 文本会在 Responses payload 内被再次序列化，因此预留少量缓冲以容纳
        // JSON 转义与 wrapper 开销。
        truncate_function_output_payload(&payload, self.truncation_policy * 1.2)
    }
}

/// 工具搜索（tool_search）输出。
#[derive(Clone)]
pub struct ToolSearchOutput {
    /// 搜索到的可加载工具规格列表。
    pub tools: Vec<LoadableToolSpec>,
}

impl ToolOutput for ToolSearchOutput {
    fn log_preview(&self) -> String {
        let tools = self
            .tools
            .iter()
            .map(|tool| {
                serde_json::to_value(tool).unwrap_or_else(|err| {
                    JsonValue::String(format!("failed to serialize tool_search output: {err}"))
                })
            })
            .collect();
        telemetry_preview(&JsonValue::Array(tools).to_string())
    }

    fn success_for_logging(&self) -> bool {
        true
    }

    fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem {
        ResponseInputItem::ToolSearchOutput {
            call_id: call_id.to_string(),
            status: "completed".to_string(),
            execution: "client".to_string(),
            tools: self
                .tools
                .iter()
                .map(|tool| {
                    serde_json::to_value(tool).unwrap_or_else(|err| {
                        JsonValue::String(format!("failed to serialize tool_search output: {err}"))
                    })
                })
                .collect(),
        }
    }
}

/// 通用 function tool 输出。
pub struct FunctionToolOutput {
    /// 输出内容项列表。
    pub body: Vec<FunctionCallOutputContentItem>,
    /// 是否成功（`None` 表示未知）。
    pub success: Option<bool>,
    /// 可选的 post-tool-use 响应（若与 `to_response_item` 不同）。
    pub post_tool_use_response: Option<JsonValue>,
}

impl FunctionToolOutput {
    /// 从纯文本构造输出。
    pub fn from_text(text: String, success: Option<bool>) -> Self {
        Self {
            body: vec![FunctionCallOutputContentItem::InputText { text }],
            success,
            post_tool_use_response: None,
        }
    }

    /// 从内容项列表构造输出。
    pub fn from_content(
        content: Vec<FunctionCallOutputContentItem>,
        success: Option<bool>,
    ) -> Self {
        Self {
            body: content,
            success,
            post_tool_use_response: None,
        }
    }

    /// 将输出内容项列表合并为纯文本。
    pub fn into_text(self) -> String {
        function_call_output_content_items_to_text(&self.body).unwrap_or_default()
    }
}

impl ToolOutput for FunctionToolOutput {
    fn log_preview(&self) -> String {
        telemetry_preview(
            &function_call_output_content_items_to_text(&self.body).unwrap_or_default(),
        )
    }

    fn success_for_logging(&self) -> bool {
        self.success.unwrap_or(true)
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        function_tool_response(call_id, payload, self.body.clone(), self.success)
    }

    fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue> {
        self.post_tool_use_response.clone()
    }
}

/// apply_patch 工具的输出。
pub struct ApplyPatchToolOutput {
    /// 输出文本。
    pub text: String,
}

impl ApplyPatchToolOutput {
    /// 从纯文本构造输出。
    pub fn from_text(text: String) -> Self {
        Self { text }
    }
}

impl ToolOutput for ApplyPatchToolOutput {
    fn log_preview(&self) -> String {
        telemetry_preview(&self.text)
    }

    fn success_for_logging(&self) -> bool {
        true
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        function_tool_response(
            call_id,
            payload,
            vec![FunctionCallOutputContentItem::InputText {
                text: self.text.clone(),
            }],
            Some(true),
        )
    }

    fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue> {
        Some(JsonValue::String(self.text.clone()))
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        JsonValue::Object(serde_json::Map::new())
    }
}

/// 被中止的工具输出。
pub struct AbortedToolOutput {
    /// 中止消息。
    pub message: String,
}

impl ToolOutput for AbortedToolOutput {
    fn log_preview(&self) -> String {
        telemetry_preview(&self.message)
    }

    fn success_for_logging(&self) -> bool {
        false
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        match payload {
            ToolPayload::ToolSearch { .. } => ResponseInputItem::ToolSearchOutput {
                call_id: call_id.to_string(),
                status: "completed".to_string(),
                execution: "client".to_string(),
                tools: Vec::new(),
            },
            _ => function_tool_response(
                call_id,
                payload,
                vec![FunctionCallOutputContentItem::InputText {
                    text: self.message.clone(),
                }],
                /*success*/ None,
            ),
        }
    }
}

/// unified_exec / exec_command 工具的输出。
#[derive(Debug, Clone, PartialEq)]
pub struct ExecCommandToolOutput {
    /// 用于事件关联的 call ID（可能与 invocation call ID 不同）。
    pub event_call_id: String,
    /// chunk ID（用于分块输出场景）。
    pub chunk_id: String,
    /// 工具执行 wall time。
    pub wall_time: Duration,
    /// 截断前的原始字节输出。
    pub raw_output: Vec<u8>,
    /// 输出截断策略。
    pub truncation_policy: TruncationPolicy,
    /// 模型输出侧的最大 token 数。
    pub max_output_tokens: Option<usize>,
    /// 进程 ID（若仍在运行）。
    pub process_id: Option<i32>,
    /// 退出码（若已退出）。
    pub exit_code: Option<i32>,
    /// 原始输出的 token 计数（若有）。
    pub original_token_count: Option<usize>,
    /// hook 命令字符串（若通过 hook 触发）。
    pub hook_command: Option<String>,
}

impl ToolOutput for ExecCommandToolOutput {
    fn log_preview(&self) -> String {
        telemetry_preview(&self.response_text())
    }

    fn success_for_logging(&self) -> bool {
        true
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        function_tool_response(
            call_id,
            payload,
            vec![FunctionCallOutputContentItem::InputText {
                text: self.response_text(),
            }],
            Some(true),
        )
    }

    fn post_tool_use_id(&self, call_id: &str) -> String {
        if self.event_call_id.is_empty() {
            call_id.to_string()
        } else {
            self.event_call_id.clone()
        }
    }

    fn post_tool_use_input(&self, _payload: &ToolPayload) -> Option<JsonValue> {
        self.hook_command
            .as_ref()
            .map(|command| serde_json::json!({ "command": command }))
    }

    fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue> {
        // 进程仍在运行或没有 hook 命令时，不暴露 post-tool-use 响应。
        if self.process_id.is_some() || self.hook_command.is_none() {
            return None;
        }

        Some(JsonValue::String(
            self.truncated_output(self.model_output_max_tokens()),
        ))
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        #[derive(Serialize)]
        struct UnifiedExecCodeModeResult {
            #[serde(skip_serializing_if = "Option::is_none")]
            chunk_id: Option<String>,
            wall_time_seconds: f64,
            #[serde(skip_serializing_if = "Option::is_none")]
            exit_code: Option<i32>,
            #[serde(skip_serializing_if = "Option::is_none")]
            session_id: Option<i32>,
            #[serde(skip_serializing_if = "Option::is_none")]
            original_token_count: Option<usize>,
            output: String,
        }

        let result = UnifiedExecCodeModeResult {
            chunk_id: (!self.chunk_id.is_empty()).then(|| self.chunk_id.clone()),
            wall_time_seconds: self.wall_time.as_secs_f64(),
            exit_code: self.exit_code,
            session_id: self.process_id,
            original_token_count: self.original_token_count,
            output: match self.max_output_tokens {
                Some(max_tokens) => self.truncated_output(max_tokens),
                None => String::from_utf8_lossy(&self.raw_output).to_string(),
            },
        };

        serde_json::to_value(result).unwrap_or_else(|err| {
            JsonValue::String(format!("failed to serialize exec result: {err}"))
        })
    }
}

impl ExecCommandToolOutput {
    /// 计算模型输出可用的最大 token 数，取 `max_output_tokens` 与截断策略 token 预算的较小值。
    fn model_output_max_tokens(&self) -> usize {
        resolve_max_tokens(self.max_output_tokens).min(self.truncation_policy.token_budget())
    }

    /// 按指定 token 上限截断输出文本。
    pub(crate) fn truncated_output(&self, max_tokens: usize) -> String {
        let text = String::from_utf8_lossy(&self.raw_output).to_string();
        formatted_truncate_text(&text, TruncationPolicy::Tokens(max_tokens))
    }

    /// 构造面向模型的响应文本，包含 chunk ID、wall time、退出码、进程 ID 等元信息。
    fn response_text(&self) -> String {
        let mut sections = Vec::new();

        if !self.chunk_id.is_empty() {
            sections.push(format!("Chunk ID: {}", self.chunk_id));
        }

        let wall_time_seconds = self.wall_time.as_secs_f64();
        sections.push(format!("Wall time: {wall_time_seconds:.4} seconds"));

        if let Some(exit_code) = self.exit_code {
            sections.push(format!("Process exited with code {exit_code}"));
        }

        if let Some(process_id) = &self.process_id {
            sections.push(format!("Process running with session ID {process_id}"));
        }

        if let Some(original_token_count) = self.original_token_count {
            sections.push(format!("Original token count: {original_token_count}"));
        }

        sections.push("Output:".to_string());
        sections.push(self.truncated_output(self.model_output_max_tokens()));

        sections.join("\n")
    }
}

/// 构造 function tool 的响应项。
///
/// 根据是否为 `Custom` payload 选择 `CustomToolCallOutput` 或 `FunctionCallOutput`。
fn function_tool_response(
    call_id: &str,
    payload: &ToolPayload,
    body: Vec<FunctionCallOutputContentItem>,
    success: Option<bool>,
) -> ResponseInputItem {
    let body = match body.as_slice() {
        [FunctionCallOutputContentItem::InputText { text }] => {
            FunctionCallOutputBody::Text(text.clone())
        }
        _ => FunctionCallOutputBody::ContentItems(body),
    };

    if matches!(payload, ToolPayload::Custom { .. }) {
        return ResponseInputItem::CustomToolCallOutput {
            call_id: call_id.to_string(),
            name: None,
            output: FunctionCallOutputPayload { body, success },
        };
    }

    ResponseInputItem::FunctionCallOutput {
        call_id: call_id.to_string(),
        output: FunctionCallOutputPayload { body, success },
    }
}

/// 生成遥测预览文本，按字节与行数限制截断并附加截断提示。
fn telemetry_preview(content: &str) -> String {
    let truncated_slice = take_bytes_at_char_boundary(content, TELEMETRY_PREVIEW_MAX_BYTES);
    let truncated_by_bytes = truncated_slice.len() < content.len();

    let mut preview = String::new();
    let mut lines_iter = truncated_slice.lines();
    for idx in 0..TELEMETRY_PREVIEW_MAX_LINES {
        match lines_iter.next() {
            Some(line) => {
                if idx > 0 {
                    preview.push('\n');
                }
                preview.push_str(line);
            }
            None => break,
        }
    }
    let truncated_by_lines = lines_iter.next().is_some();

    if !truncated_by_bytes && !truncated_by_lines {
        return content.to_string();
    }

    if preview.len() < truncated_slice.len()
        && truncated_slice
            .as_bytes()
            .get(preview.len())
            .is_some_and(|byte| *byte == b'\n')
    {
        preview.push('\n');
    }

    if !preview.is_empty() && !preview.ends_with('\n') {
        preview.push('\n');
    }
    preview.push_str(TELEMETRY_PREVIEW_TRUNCATION_NOTICE);

    preview
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;
