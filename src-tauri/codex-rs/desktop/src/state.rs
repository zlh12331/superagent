//! 全局应用状态管理。
//!
//! 使用 `RwLock<Option<InProcessClientSender>>` 存储 runtime sender，
//! 支持 runtime 崩溃后重连（替换 `OnceLock` 的单次写入限制）。
//! `InProcessClientSender` 是 cloneable 的，可以被多个 command handler
//! 并发使用。
//!
//! ## 设计
//!
//! codex-rs 的 `InProcessClientHandle` 分为两部分：
//! - `InProcessClientSender` — cloneable，用于发送请求和通知。存储在此处。
//! - `InProcessClientHandle` 本身 — 不可 clone，拥有事件接收器和 runtime task。
//!   在 `bridge::runtime` 中移入事件循环 task。
//!
//! 这是因为 `shutdown(self)` 和 `next_event(&mut self)` 需要独占所有权，
//! 而命令处理器需要并发访问发送请求。
//!
//! ## 重连支持
//!
//! 使用 `RwLock<Option<InProcessClientSender>>` 而非 `OnceLock`：
//! - `OnceLock::set` 只能成功一次，runtime 崩溃后无法替换 sender
//! - `RwLock` 允许 `set_sender` 在 runtime 重启时替换旧的 sender
//! - `handle()` 通过读锁获取 sender 引用，重连后立即可用

use std::sync::OnceLock;
use std::sync::RwLock;

use codex_app_server::in_process::InProcessClientSender;

use crate::bridge::request::RequestIdSequencer;
use crate::error::AppError;

/// codex runtime 的连接模式。
///
/// `InProcess` 用于 app-server 嵌入 Tauri 进程内运行。
/// `Remote` 为未来基于 WebSocket 的连接预留。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionMode {
    /// 进程内 runtime（嵌入 Tauri 应用中）。
    InProcess,
    /// 远程 runtime（通过 WebSocket 连接——未来支持）。
    Remote,
}

/// 全局应用状态。
///
/// `sender` 在 `setup()` 期间由 `bridge::runtime::init_app_server()` 设置，
/// 通过 [`handle`] 被所有命令处理器读取。
///
/// `connection_mode` 追踪当前 runtime 连接模式，允许命令处理器
/// 适配行为（如 remote 模式的 fallback 路径）。
pub struct AppState {
    /// runtime sender，用 RwLock 包装以支持重连。
    /// None 表示 runtime 未初始化或已关闭。
    sender: RwLock<Option<InProcessClientSender>>,
    connection_mode: RwLock<ConnectionMode>,
    /// 全局 RequestIdSequencer — 所有命令域共用同一个实例，
    /// 保证跨模块的 request ID 唯一性。
    sequencer: RequestIdSequencer,
}

static STATE: OnceLock<AppState> = OnceLock::new();

/// 返回全局 `AppState`，若尚未初始化则初始化容器。
///
/// sender 本身在 `init_app_server()` 被调用之前不会设置。
fn state() -> &'static AppState {
    STATE.get_or_init(|| AppState {
        sender: RwLock::new(None),
        connection_mode: RwLock::new(ConnectionMode::InProcess),
        sequencer: RequestIdSequencer::new(),
    })
}

/// 将 runtime sender 存入全局状态。
///
/// 在 `setup()` 期间由 `bridge::runtime::init_app_server()` 调用。
/// 支持重连：如果 sender 已存在（runtime 重启场景），会被替换。
/// 旧 sender 的所有 pending 请求会因 channel 关闭而返回传输错误，
/// 前端应处理这些错误并重试。
pub(crate) fn set_sender(sender: InProcessClientSender) -> Result<(), AppError> {
    let mut guard = state()
        .sender
        .write()
        .map_err(|e| AppError::not_initialized(format!("state sender RwLock poisoned: {e}")))?;

    if guard.is_some() {
        log::info!("Replacing existing runtime sender (reconnect scenario)");
    }
    *guard = Some(sender);
    Ok(())
}

/// 从全局状态清除 runtime sender。
///
/// 在 runtime shutdown 或断连时调用，使后续命令返回 `NotInitialized` 错误。
/// 这比保留一个已失效的 sender 更好——失效的 sender 会让命令永久挂起
/// 或返回模糊的传输错误。
pub(crate) fn clear_sender() {
    let guard = state().sender.write();
    // 使用 let-chains 合并条件（Rust 2024 edition 稳定特性）
    if let Ok(mut guard) = guard
        && guard.is_some()
    {
        log::info!("Clearing runtime sender (runtime shutdown/disconnect)");
        *guard = None;
    }
    // 如果 RwLock poisoned，忽略错误——clear 是 best-effort 操作
}

/// 返回全局 `InProcessClientSender` 的 clone。
///
/// 命令处理器用它向进程内 app-server 发送 `ClientRequest` 和
/// `ClientNotification` 消息。
///
/// # 设计说明：返回 owned clone 而非引用
///
/// `InProcessClientSender` 内部仅持有一个 `mpsc::Sender` 的句柄，
/// `clone()` 代价极低（仅复制一个 channel sender 引用）。
/// 返回 owned 值而非 `&'static` 引用的原因：
///
/// 全局状态用 `RwLock<Option<InProcessClientSender>>` 存储以支持重连。
/// 如果返回 `&'static` 引用，读锁释放后，另一个线程调用 `set_sender()`
/// 替换 sender 会使引用悬垂（use-after-free UB）。
///
/// 此前的实现使用 `unsafe { &*(ptr as *const _) }` 绕过借用检查，
/// 注释声称"leak 读锁 guard"但实际并未 leak，是真实的 UB。
///
/// 返回 owned clone 彻底消除该 UB：调用方持有一个独立的 sender 副本，
/// 不依赖 RwLock 内部的生命周期。调用方代码 `let sender = state::handle()?;`
/// 无需改动（后续通过 `&sender` 借用使用）。
///
/// # 错误
///
/// 若 `init_app_server()` 尚未调用或 runtime 已关闭，返回 `NotInitialized`。
pub fn handle() -> Result<InProcessClientSender, AppError> {
    let guard = state()
        .sender
        .read()
        .map_err(|e| AppError::not_initialized(format!("state sender RwLock poisoned: {e}")))?;

    guard
        .as_ref()
        .ok_or_else(|| {
            AppError::not_initialized(
                "codex runtime not initialized — call init_app_server() first",
            )
        })
        // Clone 一份 owned sender — InProcessClientSender 内部仅是 mpsc::Sender，
        // clone 代价极低，且彻底消除了 'static 引用 + RwLock 重写造成的 UB。
        .cloned()
}

/// 返回当前连接模式。
pub fn connection_mode() -> ConnectionMode {
    // RwLock 中毒说明另一线程 panic，恢复内部数据比直接崩溃更稳健
    *state()
        .connection_mode
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// 设置连接模式。
///
/// runtime 成功启动后由 `bridge::runtime` 调用。
pub(crate) fn set_connection_mode(mode: ConnectionMode) {
    // RwLock 中毒说明另一线程 panic，恢复内部数据以写入新值
    *state()
        .connection_mode
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = mode;
}

/// 若 runtime 已初始化且可接收请求，返回 `true`。
pub fn is_initialized() -> bool {
    // 使用 read() 获取读锁，检查 sender 是否存在
    // （RwLock<Option<T>> 没有 OnceLock::get() 方法）
    state()
        .sender
        .read()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

/// 返回全局 `RequestIdSequencer` 的静态引用。
///
/// 所有命令域通过此函数获取同一个 sequencer 实例，
/// 保证跨模块的 JSON-RPC request ID 唯一性。
///
/// # 设计说明
///
/// 早期实现中每个命令域（account/thread/turn 等）各自维护一个
/// `static SEQUENCER: OnceLock<RequestIdSequencer>`，导致跨模块的
/// request ID 从各自独立计数器开始（1, 1, 1...），与 codex-rs
/// 内部 `HashMap<RequestId, oneshot::Sender>` 的路由逻辑冲突，
/// 可能导致响应错位。统一为全局单例后，ID 在整个进程内单调递增。
pub fn sequencer() -> &'static RequestIdSequencer {
    &state().sequencer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_mode_defaults_to_in_process() {
        // 初始化前 connection_mode 应为 InProcess
        assert_eq!(connection_mode(), ConnectionMode::InProcess);
    }

    #[test]
    fn sequencer_returns_global_singleton() {
        // 多次调用 sequencer() 应返回同一个实例（指针相等）
        let ptr1 = sequencer() as *const _;
        let ptr2 = sequencer() as *const _;
        assert_eq!(ptr1, ptr2, "sequencer() 必须返回全局单例");
    }

    #[test]
    fn sequencer_next_id_is_monotonic() {
        // 全局 sequencer 的 next_id 应单调递增（不回绕）
        let id1 = sequencer().next_id();
        let id2 = sequencer().next_id();
        match (id1, id2) {
            (codex_app_server_protocol::RequestId::Integer(a),
             codex_app_server_protocol::RequestId::Integer(b)) => {
                assert!(b > a, "后一次 next_id ({b}) 必须大于前一次 ({a})");
            }
            _ => panic!("RequestId 应为 Integer 变体"),
        }
    }
}
