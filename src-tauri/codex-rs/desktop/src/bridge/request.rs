//! 通用请求基础设施。
//!
//! 提供：
//! - [`RequestIdSequencer`] — 原子递增的 JSON-RPC request ID 生成器，
//!   保证并发请求的 ID 唯一性。
//! - [`send_request`] — 发送 `ClientRequest` 并等待原始 JSON 响应。
//! - [`send_request_typed`] — 发送请求并将响应反序列化为目标类型 `T`。
//! - [`send_notification`] — 发送 fire-and-forget 通知。
//!
//! ## 设计原理
//!
//! codex-rs 的 `InProcessClientSender::request()` 返回
//! `Result<Result<serde_json::Value, JSONRPCErrorError>, io::Error>`，
//! 即三层错误嵌套。本模块将其扁平化为 [`TypedRequestError`]，
//! 使命令处理器的错误处理更简洁。
//!
//! ## 使用示例
//!
//! ```no_run
//! # use codex_app_server_protocol::{ClientRequest, ThreadStartParams};
//! # use codex_app_server::in_process::InProcessClientSender;
//! # use codex_desktop_lib::bridge::request::{RequestIdSequencer, send_request_typed};
//! # use codex_desktop_lib::error::AppError;
//! # use serde::Deserialize;
//! # #[derive(serde::Deserialize)]
//! # struct MyResponse { thread_id: String }
//! async fn example(sender: &InProcessClientSender, seq: &RequestIdSequencer)
//!     -> Result<MyResponse, AppError>
//! {
//!     // 使用 ThreadStartParams::default() 构造默认参数
//!     // （ThreadStartParams derive 了 Default，所有字段默认 None/false）
//!     let request = ClientRequest::ThreadStart {
//!         request_id: seq.next_id(),
//!         params: ThreadStartParams::default(),
//!     };
//!     send_request_typed(sender, request, "thread/start").await
//!         .map_err(AppError::from)
//! }
//! ```

use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use codex_app_server::in_process::InProcessClientSender;
use codex_app_server_protocol::ClientNotification;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::RequestId;
use serde::de::DeserializeOwned;
use tokio::time::timeout;

use crate::error::TypedRequestError;

/// 默认请求超时时间（30 秒）。
///
/// 覆盖绝大多数 codex-rs 命令（thread/start、config/get 等通常 < 1 秒）。
/// 长时命令（如 turn/start 涉及模型推理）应使用 [`send_request_with_timeout`]
/// 传入更长的超时值。
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// JSON-RPC request ID 生成器。
///
/// 使用 `AtomicI64` 保证线程安全的递增 ID。生成的 ID 从 1 开始
/// （0 保留给 `initialize` 握手），单调递增，不会回绕。
///
/// # 设计说明
///
/// codex-rs 的 `InProcessClientSender` 内部用 `HashMap<RequestId, oneshot::Sender>`
/// 路由响应。如果两个并发请求使用相同的 ID，后者的响应会覆盖前者的
/// channel sender，导致前者永远等待（或收到错误的响应）。
/// 因此，所有请求必须使用唯一的 ID。
///
/// # 示例
///
/// ```
/// # use codex_app_server_protocol::RequestId;
/// # use codex_desktop_lib::bridge::request::RequestIdSequencer;
/// let seq = RequestIdSequencer::new();
/// assert_eq!(seq.next_id(), RequestId::Integer(1));
/// assert_eq!(seq.next_id(), RequestId::Integer(2));
/// ```
#[derive(Debug)]
pub struct RequestIdSequencer {
    counter: AtomicI64,
}

impl RequestIdSequencer {
    /// 创建新的序列号生成器，初始值为 0（第一次 `next_id()` 返回 1）。
    pub const fn new() -> Self {
        Self {
            counter: AtomicI64::new(0),
        }
    }

    /// 生成下一个唯一的 `RequestId`。
    ///
    /// 使用 `Relaxed` 内存序，因为我们只需要原子性而非跨变量顺序。
    pub fn next_id(&self) -> RequestId {
        let id = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        RequestId::Integer(id)
    }

    /// 返回当前已生成的最大 ID（不消耗）。
    /// 主要用于测试和调试。
    pub fn current(&self) -> i64 {
        self.counter.load(Ordering::Relaxed)
    }
}

impl Default for RequestIdSequencer {
    fn default() -> Self {
        Self::new()
    }
}

/// 发送 `ClientRequest` 并等待原始 JSON 响应（默认 30 秒超时）。
///
/// 这是底层请求函数，返回 codex-rs 的原始
/// `Result<Result<Value, JSONRPCErrorError>, io::Error>`。
/// 大多数调用方应使用 [`send_request_typed`] 获取反序列化后的类型。
///
/// 超时后返回 [`TypedRequestError::Transport`]，避免 codex-rs 异常时
/// 命令永久挂起导致 UI 假死。
///
/// # 参数
///
/// - `sender` — 来自 `state::handle()` 的全局 sender
/// - `request` — 已构造好的 `ClientRequest`（request_id 必须唯一）
///
/// # 错误
///
/// - [`TypedRequestError::Transport`] — 通道关闭、队列满或超时
/// - [`TypedRequestError::Server`] — 服务器返回 JSON-RPC 错误
pub async fn send_request(
    sender: &InProcessClientSender,
    request: ClientRequest,
) -> Result<serde_json::Value, TypedRequestError> {
    send_request_with_timeout(sender, request, DEFAULT_REQUEST_TIMEOUT).await
}

/// 发送 `ClientRequest` 并使用自定义超时等待响应。
///
/// 长时命令（如 `turn/start` 涉及模型推理）应传入更长的超时值。
/// 超时后返回 [`TypedRequestError::Transport`]，错误消息包含方法名和超时秒数。
///
/// # 参数
///
/// - `sender` — 来自 `state::handle()` 的全局 sender
/// - `request` — 已构造好的 `ClientRequest`
/// - `timeout_duration` — 超时时间
pub async fn send_request_with_timeout(
    sender: &InProcessClientSender,
    request: ClientRequest,
    timeout_duration: Duration,
) -> Result<serde_json::Value, TypedRequestError> {
    let method = request.method();
    let timeout_secs = timeout_duration.as_secs();

    // 使用 tokio::time::timeout 包装请求，防止 codex-rs 异常时永久挂起。
    // 超时后 oneshot channel 的 sender 端会被 drop，不会影响 codex-rs 内部状态。
    let response = timeout(timeout_duration, sender.request(request))
        .await
        .map_err(|_elapsed| TypedRequestError::Transport {
            method: method.clone(),
            source: std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("{method} timed out after {timeout_secs}s"),
            ),
        })?
        .map_err(|e| TypedRequestError::Transport {
            method: method.clone(),
            source: e,
        })?;

    response.map_err(|e| TypedRequestError::Server { method, source: e })
}

/// 发送 `ClientRequest`，并将响应反序列化为目标类型 `T`（默认 30 秒超时）。
///
/// 这是推荐的请求函数，自动处理三层错误嵌套：
/// 1. `io::Error` → [`TypedRequestError::Transport`]（含超时）
/// 2. `JSONRPCErrorError` → [`TypedRequestError::Server`]
/// 3. `serde_json::Error` → [`TypedRequestError::Deserialize`]
///
/// # 类型参数
///
/// - `T` — 期望的响应类型，必须实现 `serde::de::DeserializeOwned`
///
/// # 参数
///
/// - `sender` — 来自 `state::handle()` 的全局 sender
/// - `request` — 已构造好的 `ClientRequest`
/// - `method` — JSON-RPC 方法名（用于错误消息，如 `"thread/start"`）
///
/// # 示例
///
/// ```no_run
/// # async fn example(sender: &codex_app_server::in_process::InProcessClientSender)
/// #     -> Result<String, codex_desktop_lib::error::TypedRequestError>
/// # {
/// # use codex_app_server_protocol::{ClientRequest, RequestId, ThreadStartParams};
/// # use codex_desktop_lib::bridge::request::send_request_typed;
/// # #[derive(serde::Deserialize)]
/// # struct ThreadStartResponse { thread_id: String }
/// let request = ClientRequest::ThreadStart {
///     request_id: RequestId::Integer(1),
///     params: ThreadStartParams::default(),
/// };
/// let response: ThreadStartResponse =
///     send_request_typed(sender, request, "thread/start").await?;
/// # Ok(response.thread_id)
/// # }
/// ```
pub async fn send_request_typed<T: DeserializeOwned>(
    sender: &InProcessClientSender,
    request: ClientRequest,
    method: &str,
) -> Result<T, TypedRequestError> {
    let value = send_request(sender, request).await?;
    serde_json::from_value::<T>(value).map_err(|e| TypedRequestError::Deserialize {
        method: method.to_string(),
        source: e,
    })
}

/// 发送 fire-and-forget 通知到 codex 运行时。
///
/// 通知不需要响应，但传输错误（通道关闭、队列满）仍然会返回。
///
/// # 参数
///
/// - `sender` — 来自 `state::handle()` 的全局 sender
/// - `notification` — 要发送的 `ClientNotification`
///
/// # 错误
///
/// 返回 `io::Error` 表示传输失败。
pub fn send_notification(
    sender: &InProcessClientSender,
    notification: ClientNotification,
) -> Result<(), std::io::Error> {
    sender.notify(notification)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequencer_starts_at_one() {
        let seq = RequestIdSequencer::new();
        assert_eq!(seq.next_id(), RequestId::Integer(1));
    }

    #[test]
    fn sequencer_increments_monotonically() {
        let seq = RequestIdSequencer::new();
        assert_eq!(seq.next_id(), RequestId::Integer(1));
        assert_eq!(seq.next_id(), RequestId::Integer(2));
        assert_eq!(seq.next_id(), RequestId::Integer(3));
    }

    #[test]
    fn sequencer_is_thread_safe() {
        let seq = std::sync::Arc::new(RequestIdSequencer::new());
        let mut handles = vec![];

        for _ in 0..4 {
            let seq_clone = std::sync::Arc::clone(&seq);
            handles.push(std::thread::spawn(move || {
                let mut ids = vec![];
                for _ in 0..25 {
                    ids.push(seq_clone.next_id());
                }
                ids
            }));
        }

        let mut all_ids = vec![];
        for handle in handles {
            all_ids.extend(handle.join().unwrap());
        }

        // 100 个 ID 应该全部唯一
        let unique: std::collections::HashSet<i64> = all_ids
            .iter()
            .map(|id| match id {
                RequestId::Integer(n) => *n,
                RequestId::String(_) => panic!("应得到 Integer ID"),
            })
            .collect();
        assert_eq!(all_ids.len(), unique.len(), "检测到重复的 request ID");
    }

    #[test]
    fn sequencer_current_returns_last_generated() {
        let seq = RequestIdSequencer::new();
        assert_eq!(seq.current(), 0);
        seq.next_id();
        assert_eq!(seq.current(), 1);
        seq.next_id();
        assert_eq!(seq.current(), 2);
    }

    #[test]
    fn sequencer_default_starts_at_zero() {
        let seq = RequestIdSequencer::default();
        assert_eq!(seq.current(), 0);
    }
}
