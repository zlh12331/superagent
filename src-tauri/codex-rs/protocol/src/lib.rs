//! codex-rs 协议定义 crate。
//!
//! 本 crate 定义了 codex-rs 与外部世界（Tauri 命令层、IPC、上层 UI 等）之间交换
//! 数据时所使用的全部协议类型。所有跨进程通信、序列化结构以及与 Agent 主进程
//! 交互的消息体均以此处定义的类型为唯一事实来源。
//!
//! 架构位置：位于 codex-rs 内核与外部接入层（如 Tauri / CLI / SDK）之间，作为
//! 稳定的协议边界，避免内核内部实现细节外泄。

pub mod account;
mod agent_path;
pub mod auth;
mod session_id;
mod thread_id;
mod tool_name;
pub use agent_path::AgentPath;
pub use session_id::SessionId;
pub use thread_id::ThreadId;
pub use tool_name::ToolName;
pub mod approvals;
pub mod capabilities;
mod compacted_item;
pub mod config_types;
pub mod dynamic_tools;
pub mod error;
pub mod exec_output;
pub mod items;
pub mod mcp;
pub mod mcp_approval_meta;
pub mod memory_citation;
pub mod models;
pub mod network_policy;
pub mod num_format;
pub mod openai_models;
pub mod parse_command;
pub mod permissions;
pub mod plan_tool;
pub mod protocol;
pub mod request_permissions;
pub mod request_user_input;
pub mod shell_environment;
pub mod user_input;
