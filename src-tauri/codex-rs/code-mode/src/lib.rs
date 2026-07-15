//! Code mode 运行时入口。
//!
//! 本 crate 提供 Code mode 的两种会话实现：
//! - 进程内会话（基于 V8 嵌入式运行时，见 [`service::InProcessCodeModeSession`]）
//! - 子进程会话（见 [`remote_session::ProcessOwnedCodeModeSession`]）
//!
//! 同时重导出 `codex_code_mode_protocol` 中的协议类型，
//! 供调用方在一个 crate 内完成类型解析。

mod cell_actor;
mod remote_session;
mod runtime;
mod service;
mod session_runtime;

/// 任务失败回调类型。
///
/// 当 V8 运行时线程发生 panic 等致命错误时被调用，参数为失败原因描述。
pub(crate) type TaskFailureHandler = std::sync::Arc<dyn Fn(String) + Send + Sync>;

/// 重导出 `codex_code_mode_protocol` 中定义的全部协议类型。
pub use codex_code_mode_protocol::*;
/// 子进程会话句柄，对应一个被父进程持有的 Code mode 子进程。
pub use remote_session::ProcessOwnedCodeModeSession;
/// 子进程会话 Provider，负责按需启动 Code mode 子进程。
pub use remote_session::ProcessOwnedCodeModeSessionProvider;
/// 进程内会话实现，直接在当前进程中嵌入 V8 运行时执行代码。
pub use service::InProcessCodeModeSession;
/// 进程内会话 Provider，返回 [`InProcessCodeModeSession`] 实例。
pub use service::InProcessCodeModeSessionProvider;
/// 空实现的会话 delegate，所有回调均为 no-op。
pub use service::NoopCodeModeSessionDelegate;
