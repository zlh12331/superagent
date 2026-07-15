//! `CodexClientHandle` trait — 依赖注入抽象。
//!
//! 这个 trait 将命令处理器与具体的 codex-rs 客户端实现解耦，使得：
//! - 单元测试可以使用 `MockCodexClient`（不需要真实 codex-rs 进程）
//! - 未来 `Remote` 连接模式无需修改命令处理器
//!
//! ## 使用方式
//!
//! 当前命令处理器直接通过 `state::handle()` 获取 `&InProcessClientSender`，
//! 并未强制使用此 trait。此 trait 作为可选的抽象层提供：
//! - 需要测试的模块可以通过 trait 参数注入 mock
//! - 未来 Remote 模式只需提供另一个实现
//!
//! ## 为 InProcessClientSender 实现此 trait
//!
//! `InProcessClientSender` 已自动实现本 trait（通过 blanket implementation），
//! 无需手动 impl。现有代码无需修改即可获得 trait 支持。
//!
//! ## Mock 示例
//!
//! ```no_run
//! # use codex_desktop_lib::bridge::trait_def::CodexClientHandle;
//! # use codex_app_server_protocol::*;
//! # use std::io::Result;
//! #
//! # #[cfg(test)]
//! # mod tests {
//! #     use super::*;
//! #     use mockall::mock;
//! #
//! #     mock! {
//! #         pub FakeClient {}
//! #         impl CodexClientHandle for FakeClient {
//! #             async fn request(
//! #                 &self, request: ClientRequest
//! #             ) -> std::io::Result<std::result::Result<serde_json::Value, JSONRPCErrorError>>;
//! #             fn notify(&self, notification: ClientNotification) -> std::io::Result<()>;
//! #             fn respond_to_server_request(
//! #                 &self, request_id: RequestId, result: serde_json::Value
//! #             ) -> std::io::Result<()>;
//! #             fn fail_server_request(
//! #                 &self, request_id: RequestId, error: JSONRPCErrorError
//! #             ) -> std::io::Result<()>;
//! #         }
//! #     }
//! # }
//! ```

use std::io::Result as IoResult;

use codex_app_server::in_process::InProcessClientSender;
use codex_app_server_protocol::ClientNotification;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::RequestId;

/// codex 客户端句柄的抽象 trait。
///
/// 定义了命令处理器与 codex-rs 通信所需的四个核心操作：
/// - `request` — 发送请求并等待响应（用于 thread/start、turn/start 等）
/// - `notify` — 发送 fire-and-forget 通知（用于 thread/stop 等）
/// - `respond_to_server_request` — 响应服务器端审批请求（批准）
/// - `fail_server_request` — 拒绝服务器端审批请求（拒绝）
///
/// # 实现
///
/// `InProcessClientSender` 已实现此 trait，现有代码无需修改。
#[async_trait::async_trait]
pub trait CodexClientHandle: Send + Sync {
    /// 发送 `ClientRequest` 并等待 JSON-RPC 响应。
    ///
    /// 返回外层 `io::Result` 表示传输错误（通道关闭、队列满），
    /// 内层 `Result` 表示 JSON-RPC 层面的成功或错误。
    async fn request(
        &self,
        request: ClientRequest,
    ) -> IoResult<std::result::Result<serde_json::Value, JSONRPCErrorError>>;

    /// 发送 fire-and-forget 通知到 codex 运行时。
    ///
    /// 通知不需要响应，传输错误（通道关闭、队列满）仍会返回。
    fn notify(&self, notification: ClientNotification) -> IoResult<()>;

    /// 响应一个 pending server request（如审批请求）。
    ///
    /// 将 JSON-RPC result 回传给 codex-rs，使其继续执行被审批的操作。
    fn respond_to_server_request(
        &self,
        request_id: RequestId,
        result: serde_json::Value,
    ) -> IoResult<()>;

    /// 拒绝一个 pending server request。
    ///
    /// 将 JSON-RPC error 回传给 codex-rs，使其中止被拒绝的操作。
    fn fail_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>;
}

/// 为 `InProcessClientSender` 自动实现 `CodexClientHandle`。
///
/// 这使得所有命令处理器可以通过 trait 抽象与 codex-rs 通信，
/// 而实际运行时使用的是 in-process sender。
/// 测试时可以注入 mock 实现，无需真实 codex-rs 运行时。
#[async_trait::async_trait]
impl CodexClientHandle for InProcessClientSender {
    async fn request(
        &self,
        request: ClientRequest,
    ) -> IoResult<std::result::Result<serde_json::Value, JSONRPCErrorError>> {
        InProcessClientSender::request(self, request).await
    }

    fn notify(&self, notification: ClientNotification) -> IoResult<()> {
        InProcessClientSender::notify(self, notification)
    }

    fn respond_to_server_request(
        &self,
        request_id: RequestId,
        result: serde_json::Value,
    ) -> IoResult<()> {
        InProcessClientSender::respond_to_server_request(self, request_id, result)
    }

    fn fail_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()> {
        InProcessClientSender::fail_server_request(self, request_id, error)
    }
}
