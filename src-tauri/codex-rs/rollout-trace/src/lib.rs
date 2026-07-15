//! Codex rollout 的 trace bundle 格式、写入器与 reducer。
//!
//! 该 crate 拥有 trace schema 的定义权。热路径 Codex 代码应依赖此处提供的
//! 轻量级 writer API；语义重放（semantic replay）与视图投影（viewer projection）
//! 保持在 `codex-core` 之外。
//!
//! 详见 `README.md` 中的系统架构图与 reducer 模型说明。

mod bundle;
mod code_cell;
mod compaction;
mod inference;
mod mcp;
mod model;
mod payload;
mod protocol_event;
mod raw_event;
mod reducer;
mod thread;
mod tool_dispatch;
mod writer;

/// 写在原始 trace bundle 旁边的约定俗成的 reduced-state 缓存文件名。
pub use bundle::REDUCED_STATE_FILE_NAME;
/// 用于记录单个 code-mode runtime cell 的句柄（支持 no-op 模式）。
pub use code_cell::CodeCellTraceContext;
/// 远程 compaction 安装事件的原始检查点 payload。
pub use compaction::CompactionCheckpointTracePayload;
/// 用于记录远程 compaction 请求的句柄（支持 no-op 模式）。
pub use compaction::CompactionTraceAttempt;
/// compaction 检查点的共享记录上下文。
pub use compaction::CompactionTraceContext;
/// 用于记录单次上游推理（inference）尝试的句柄（支持 no-op 模式）。
pub use inference::InferenceTraceAttempt;
/// 单个 Codex turn 内推理尝试的共享记录上下文。
pub use inference::InferenceTraceContext;
/// trace 拥有的 MCP 执行关联信息，传播至 bridge 请求元数据。
pub use mcp::McpCallTraceContext;
/// 重放（replay）返回的公开 reduced trace 模型。
pub use model::*;
/// rollout bundle 中单个原始 payload 的稳定标识符。
pub use payload::RawPayloadId;
/// 原始 payload 文件的粗粒度角色标签。
pub use payload::RawPayloadKind;
/// 对 bundle 中存储的原始请求/响应/日志 payload 的引用。
pub use payload::RawPayloadRef;
/// 由原始 trace writer 分配的单调递增序列号。
pub use raw_event::RawEventSeq;
/// 语义归约前观察到的运行时请求者（requester）。
pub use raw_event::RawToolCallRequester;
/// 来自 `trace.jsonl` 的一条只追加（append-only）原始 trace 事件。
pub use raw_event::RawTraceEvent;
/// 热路径 trace 生产者提供的事件封装上下文。
pub use raw_event::RawTraceEventContext;
/// 单条原始 trace 事件的类型化 payload。
pub use raw_event::RawTraceEventPayload;
/// 重放原始 trace bundle 并写入/读取其 reduced `RolloutTrace`。
pub use reducer::replay_bundle;
/// 子 agent 向父 agent 报告完成时捕获的原始 payload。
pub use thread::AgentResultTracePayload;
/// 启用本地 trace bundle 记录的环境变量名。
pub use thread::CODEX_ROLLOUT_TRACE_ROOT_ENV;
/// 线程启动时捕获的原始元数据。
pub use thread::ThreadStartedTraceMetadata;
/// 用于在 rollout bundle 中记录单个线程的句柄（支持 no-op 模式）。
pub use thread::ThreadTraceContext;
/// 规范 Codex 工具边界的请求数据。
pub use tool_dispatch::ToolDispatchInvocation;
/// 在 registry 边界观察到的工具输入。
pub use tool_dispatch::ToolDispatchPayload;
/// 导致 dispatch 级别工具调用的运行时来源。
pub use tool_dispatch::ToolDispatchRequester;
/// dispatch 级别工具调用返回的结果数据。
pub use tool_dispatch::ToolDispatchResult;
/// 用于记录单次已解析工具分派（dispatch）的句柄（支持 no-op 模式）。
pub use tool_dispatch::ToolDispatchTraceContext;
/// 热路径 Codex 插桩使用的只追加（append-only）写入器。
pub use writer::TraceWriter;
