//! SSE（Server-Sent Events）流式响应处理模块。
//!
//! ## 职责
//!
//! 负责解析 OpenAI Responses API 通过 SSE 协议推送的事件流，将其转换为
//! `codex-protocol` 层可消费的 [`ResponsesStreamEvent`]，并通过
//! [`spawn_response_stream`] 启动后台流式处理任务。
//!
//! ## 架构位置
//!
//! 位于 `codex-api` 传输层之上、`codex-protocol` 事件总线之下：
//!
//! ```text
//! OpenAI Responses API
//!        │ (SSE over HTTP)
//!        ▼
//! ┌──────────────────────────┐
//! │  sse::responses          │  ← 本模块
//! │  - 解析 SSE event        │
//! │  - process_responses_event
//! │  - spawn_response_stream │
//! └──────────────────────────┘
//!        │ (ResponsesStreamEvent)
//!        ▼
//!   codex-protocol 事件循环
//! ```
//!
//! ## 主要导出
//!
//! - [`ResponsesStreamEvent`]：从 SSE 流中解析出的事件类型（仅 crate 内部使用）
//! - [`process_responses_event`]：处理单个 SSE 事件的函数（仅 crate 内部使用）
//! - [`spawn_response_stream`]：启动后台 SSE 流式处理任务的函数（公开导出）

pub(crate) mod responses;

pub(crate) use responses::ResponsesStreamEvent;
pub(crate) use responses::process_responses_event;
pub use responses::spawn_response_stream;
