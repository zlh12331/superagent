//! 客户端公共类型模块。
//!
//! 集中定义 [`ModelClient`](crate::client::ModelClient) 对外暴露的请求与响应类型,
//! 包括一次模型 turn 的请求 payload [`Prompt`] 与流式响应 [`ResponseStream`]。
//!
//! 该模块刻意保持薄封装,以便上层(`session`、`tasks`)与底层(`client`)之间共享同一组类型,
//! 避免类型重复定义和重复转换。

pub use codex_api::ResponseEvent;
use codex_protocol::error::Result;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::ResponseItem;
use codex_tools::ToolSpec;
use futures::Stream;
use serde_json::Value;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// 一次模型 turn 的 API 请求 payload。
///
/// 该结构在 turn 启动时由 session 层组装,包含模型本次推理所需的全部上下文:
/// 历史 input、可用 tools、并行调用约束、base instructions 以及可选的输出 schema。
#[derive(Debug, Clone)]
pub struct Prompt {
    /// 会话上下文的 input items,按时间顺序排列。
    pub input: Vec<ResponseItem>,

    /// 模型可用的工具列表,包含来自外部 MCP server 的额外工具。
    pub(crate) tools: Vec<ToolSpec>,

    /// 本次 prompt 是否允许并行 tool 调用。
    pub(crate) parallel_tool_calls: bool,

    /// 基础 instructions(system prompt 的一部分),用于约束模型行为。
    pub base_instructions: BaseInstructions,

    /// 模型响应的可选输出 schema,用于结构化输出。
    pub output_schema: Option<Value>,

    /// 是否要求 Responses API 严格校验 `output_schema`。
    pub output_schema_strict: bool,
}

impl Default for Prompt {
    fn default() -> Self {
        Self {
            input: Vec::new(),
            tools: Vec::new(),
            parallel_tool_calls: false,
            base_instructions: BaseInstructions::default(),
            output_schema: None,
            // 默认开启严格 schema 校验,以尽早暴露不合规的模型输出。
            output_schema_strict: true,
        }
    }
}

impl Prompt {
    /// 返回用于发起 Responses API 请求的格式化 input。
    ///
    /// # 参数
    /// - `use_responses_lite`:是否使用 Responses Lite 协议;若为 true,
    ///   会调用 [`strip_image_details`] 移除图片项中的 `detail` 字段以减小 payload 体积。
    pub(crate) fn get_formatted_input_for_request(
        &self,
        use_responses_lite: bool,
    ) -> Vec<ResponseItem> {
        let mut input = self.input.clone();
        if use_responses_lite {
            strip_image_details(&mut input);
        }
        input
    }
}

/// 移除 input items 中所有图片的 `detail` 字段。
///
/// Responses Lite 协议对图片 detail 字段不敏感,移除该字段可减小请求体积。
/// 该函数遍历 `Message` 与 `FunctionCallOutput` 中的所有图片 content item。
fn strip_image_details(items: &mut [ResponseItem]) {
    for item in items {
        match item {
            ResponseItem::Message { content, .. } => {
                for content_item in content {
                    if let ContentItem::InputImage { detail, .. } = content_item {
                        *detail = None;
                    }
                }
            }
            ResponseItem::FunctionCallOutput { output, .. }
            | ResponseItem::CustomToolCallOutput { output, .. } => {
                if let Some(content) = output.content_items_mut() {
                    for content_item in content {
                        if let FunctionCallOutputContentItem::InputImage { detail, .. } =
                            content_item
                        {
                            *detail = None;
                        }
                    }
                }
            }
            ResponseItem::AdditionalTools { .. }
            | ResponseItem::Reasoning { .. }
            | ResponseItem::AgentMessage { .. }
            | ResponseItem::LocalShellCall { .. }
            | ResponseItem::FunctionCall { .. }
            | ResponseItem::ToolSearchCall { .. }
            | ResponseItem::CustomToolCall { .. }
            | ResponseItem::ToolSearchOutput { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::ImageGenerationCall { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::CompactionTrigger { .. }
            | ResponseItem::ContextCompaction { .. }
            | ResponseItem::Other => {}
        }
    }
}

/// 来自模型 provider 的流式响应。
///
/// 内部基于 tokio mpsc channel 的事件接收端,并携带一个 [`CancellationToken`]
/// 用于在消费方提前停止 polling 时通知上游 mapper 任务退出。
pub struct ResponseStream {
    pub(crate) rx_event: mpsc::Receiver<Result<ResponseEvent>>,
    /// 通知 mapper 任务:消费方在 provider stream 到达终止事件之前已停止 polling。
    pub(crate) consumer_dropped: CancellationToken,
}

impl Stream for ResponseStream {
    type Item = Result<ResponseEvent>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx_event.poll_recv(cx)
    }
}

impl Drop for ResponseStream {
    fn drop(&mut self) {
        // 消费方 drop 时取消 token,确保上游 mapper 任务能够及时退出,
        // 避免在无人消费时继续处理 provider stream 浪费资源。
        self.consumer_dropped.cancel();
    }
}

#[cfg(test)]
#[path = "client_common_tests.rs"]
mod tests;
