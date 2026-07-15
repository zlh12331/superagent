//! Server request / 审批流程。
//!
//! 负责：
//! - 存储 codex-rs 发来的 `ServerRequest`（如命令执行审批、文件变更审批等）
//! - 提供审批响应回传机制（approve / deny）
//! - 通过 `InProcessClientSender::respond_to_server_request` /
//!   `fail_server_request` 将结果回传给 codex-rs
//!
//! ## 事件流
//!
//! ```text
//! codex-rs ServerRequest
//!     ↓
//! event::dispatch_event() 收到 InProcessServerEvent::ServerRequest
//!     ↓
//! approval::register(request) → 存入 PENDING_REQUESTS
//!     ↓
//! app_handle.emit("codex:approval:request", &request) → 前端显示审批对话框
//!     ↓
//! 用户点击"批准"或"拒绝"
//!     ↓
//! Tauri 命令 approval_respond / approval_reject
//!     ↓
//! approval::respond() / approval::reject()
//!     ↓
//! sender.respond_to_server_request() / sender.fail_server_request()
//!     ↓
//! codex-rs 收到响应，继续或中止 turn
//! ```
//!
//! ## 设计说明
//!
//! 使用全局 `RwLock<HashMap<RequestId, ServerRequest>>` 存储 pending 请求：
//! - `RwLock` 而非 `Mutex`：list() 是读操作，可并发
//! - `HashMap` 而非 `Vec`：按 `RequestId` O(1) 查找
//! - 全局静态：与 `state::AppState` 一致，避免在 AppState 中增加审批状态
//!   （审批状态属于 bridge 层职责，不属于全局应用状态）

use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::RwLock;

use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ServerRequest;

use crate::error::AppError;
use crate::state;

/// 全局 pending server requests 存储。
///
/// key: `RequestId`（从 `ServerRequest::id()` 提取）
/// value: 原始 `ServerRequest`（保留用于审计和超时清理）
static PENDING_REQUESTS: OnceLock<RwLock<HashMap<RequestId, ServerRequest>>> = OnceLock::new();

/// 返回全局 pending requests 存储的引用。
fn pending() -> &'static RwLock<HashMap<RequestId, ServerRequest>> {
    PENDING_REQUESTS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// 注册一个 pending server request。
///
/// 当 `event::dispatch_event` 收到 `InProcessServerEvent::ServerRequest` 时调用。
/// 将 request 存入全局存储，等待前端通过 Tauri 命令响应。
///
/// 如果同一 `RequestId` 已存在（理论上不应发生，因为 ID 是全局唯一的），
/// 旧 request 会被覆盖并记录警告日志。
///
/// # 参数
///
/// - `request` — codex-rs 发来的 server request（如审批请求）
///
/// # 返回
///
/// 返回 `RequestId`，前端用此 ID 调用 `approval_respond` / `approval_reject`。
pub fn register(request: ServerRequest) -> RequestId {
    let id = request.id().clone();

    let mut map = pending()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if map.contains_key(&id) {
        log::warn!(
            "Duplicate server request ID {id:?} — overwriting existing pending request"
        );
    }
    map.insert(id.clone(), request);

    id
}

/// 取出并移除一个 pending server request。
///
/// 在 `approval_respond` / `approval_reject` 内部调用，也可以用于
/// 超时清理或断连时批量移除。
///
/// # 参数
///
/// - `request_id` — 待取出的 request ID
///
/// # 返回
///
/// 返回 `Option<ServerRequest>`。`None` 表示该 ID 不存在（已被响应或从未注册）。
pub fn take(request_id: &RequestId) -> Option<ServerRequest> {
    pending()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(request_id)
}

/// 返回所有 pending request ID 的列表。
///
/// 前端可以通过 Tauri 命令查询当前有哪些待审批请求，
/// 用于页面刷新后恢复审批对话框。
pub fn list_pending_ids() -> Vec<RequestId> {
    pending()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .keys()
        .cloned()
        .collect()
}

/// 清除所有 pending requests。
///
/// 在 runtime 断连或 shutdown 时调用，防止 stale 请求残留。
/// 清除后，前端如果尝试响应已被清除的 request，会收到 `NotFound` 错误。
pub fn clear() {
    let mut map = pending().write().unwrap_or_else(std::sync::PoisonError::into_inner);
    let count = map.len();
    map.clear();
    if count > 0 {
        log::info!("Cleared {count} pending server requests");
    }
}

/// 清理指定 thread 的所有 pending server requests。
///
/// 借鉴 codex-main 的 `outgoing_message.rs:468-501` 的 `cancel_requests_for_thread` 设计：
/// 当 thread 被关闭/归档/删除时，该 thread 相关的 pending 审批请求已无意义，
/// 应该从 pending 存储中移除，避免 stale 请求残留导致前端显示幽灵审批对话框。
///
/// ## 与 codex-main 的差异
///
/// - codex-main 在服务器端取消请求并通知 callback（callback 在 InProcess 模式下是 sender）
/// - 桌面端只清理本地 pending 存储 — codex-rs 服务器端会自行取消其 callback，
///   不需要桌面端主动 `fail_server_request`（重复 fail 会导致 JSON-RPC 错误）
///
/// ## 触发时机
///
/// 在 `event::dispatch_event` 收到以下通知时调用：
/// - `ThreadClosed` — thread 被关闭
/// - `ThreadDeleted` — thread 被删除
/// - `ThreadArchived` — thread 被归档（只读，无法继续审批）
///
/// # 参数
///
/// - `thread_id` — 要清理的 thread ID
///
/// # 返回
///
/// 返回被清理的 pending request 数量（用于日志记录）。
pub fn clear_for_thread(thread_id: &str) -> usize {
    let mut map = pending().write().unwrap_or_else(std::sync::PoisonError::into_inner);

    // 先收集要移除的 request_id（避免在迭代时修改 HashMap）
    let to_remove: Vec<RequestId> = map
        .iter()
        .filter_map(|(id, req)| {
            // 通过 mapper 提取 thread_id，匹配则收集 request_id
            crate::bridge::mapper::thread_id_of(req)
                .filter(|tid| tid == thread_id)
                .map(|_| id.clone())
        })
        .collect();

    let count = to_remove.len();
    for id in to_remove {
        map.remove(&id);
    }

    if count > 0 {
        log::info!(
            "Cleared {count} pending server requests for thread={thread_id}"
        );
    }

    count
}

/// 批准一个 pending server request，将结果回传给 codex-rs。
///
/// 前端用户点击"批准"后调用此 Tauri 命令。
/// 从全局存储中取出 request（如果存在），然后通过 `sender.respond_to_server_request`
/// 将 JSON-RPC result 回传给 codex-rs。
///
/// # 参数
///
/// - `request_id` — 要批准的 request ID
/// - `result` — JSON-RPC result payload（具体结构取决于 ServerRequest 类型）
///
/// # 错误
///
/// - [`AppError::NotInitialized`] — codex 运行时未初始化
/// - [`AppError::NotFound`] — request_id 不在 pending 存储中（已响应或从未注册）
/// - [`AppError::AppServerError`] — 回传响应时传输失败
pub fn respond(request_id: RequestId, result: serde_json::Value) -> Result<(), AppError> {
    let sender = state::handle()?;

    // 取出 pending request，确认该 ID 确实存在
    // 取出后不再需要 request 本身（result 已由前端构造），
    // 但保留 take 操作以确保不会重复响应
    if take(&request_id).is_none() {
        return Err(AppError::not_found(format!(
            "no pending server request with id {request_id:?}"
        )));
    }

    sender
        .respond_to_server_request(request_id, result)
        .map_err(|e| {
            AppError::app_server_error(format!("failed to respond to server request: {e}"))
        })
}

/// 拒绝一个 pending server request，将错误回传给 codex-rs。
///
/// 前端用户点击"拒绝"后调用此 Tauri 命令。
/// 从全局存储中取出 request，然后通过 `sender.fail_server_request`
/// 将 JSON-RPC error 回传给 codex-rs。
///
/// # 参数
///
/// - `request_id` — 要拒绝的 request ID
/// - `error` — JSON-RPC error（包含 code 和 message）
///
/// # 错误
///
/// - [`AppError::NotInitialized`] — codex 运行时未初始化
/// - [`AppError::NotFound`] — request_id 不在 pending 存储中
/// - [`AppError::AppServerError`] — 回传错误时传输失败
pub fn reject(request_id: RequestId, error: JSONRPCErrorError) -> Result<(), AppError> {
    let sender = state::handle()?;

    if take(&request_id).is_none() {
        return Err(AppError::not_found(format!(
            "no pending server request with id {request_id:?}"
        )));
    }

    sender
        .fail_server_request(request_id, error)
        .map_err(|e| {
            AppError::app_server_error(format!("failed to reject server request: {e}"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_app_server_protocol::RequestId;

    // 注意：这些测试操作全局静态 PENDING_REQUESTS，可能相互影响。
    // 每个测试前调用 clear() 确保干净状态。

    #[test]
    fn list_pending_ids_returns_empty_when_cleared() {
        clear();
        assert!(list_pending_ids().is_empty());
    }

    #[test]
    fn take_returns_none_for_unknown_id() {
        clear();
        let result = take(&RequestId::Integer(999999));
        assert!(result.is_none());
    }

    #[test]
    fn clear_with_empty_storage_is_noop() {
        clear();
        // 不应 panic
        clear();
    }
}
