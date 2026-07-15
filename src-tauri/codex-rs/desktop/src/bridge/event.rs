//! 事件桥接：codex-rs 事件 → Tauri 前端事件。
//!
//! 负责将 codex-rs 的 [`InProcessServerEvent`] 转换为 Tauri `emit` 调用，
//! 让前端通过 `listen("codex:notification", ...)` 监听。
//!
//! ## 事件流
//!
//! ```text
//! codex-rs runtime
//!     ↓
//! InProcessServerEvent (3 种变体)
//!     ├─ ServerNotification → emit("codex:notification", payload)
//!     │    └─ TurnCompleted → maybe_backfill_turn_completed_items()
//!     ├─ ServerRequest → emit("codex:approval:request", payload) [任务 8 后续]
//!     └─ Lagged → emit("codex:lagged", count)
//!     ↓
//! next_event() 返回 None → emit("codex:disconnected", reason)
//! ```
//!
//! ## TurnCompleted 背压恢复
//!
//! 当事件循环因背压丢弃事件时（`Lagged`），`TurnCompleted` 通知可能也被丢弃。
//! 收到 `TurnCompleted` 时，调用 [`maybe_backfill_turn_completed_items`]
//! 从 rollout 文件恢复被丢弃的 item，保证前端看到完整的 turn 历史记录。
//!
//! ## Disconnected 处理
//!
//! `next_event()` 返回 `None` 表示运行时已关闭（正常关闭或崩溃）。
//! 此时 emit `"codex:disconnected"` 事件，前端可以：
//! - 显示"连接已断开"提示
//! - 禁用输入框
//! - 提供重连按钮（未来 Remote 模式）

use codex_app_server::in_process::InProcessServerEvent;
use tauri::AppHandle;
use tauri::Emitter;

/// 事件名称常量 — 前端通过 `listen()` 监听这些事件。
///
/// 所有 codex 相关事件使用 `codex:` 前缀，避免与其他 Tauri 事件冲突。
pub mod event_names {
    /// 服务器通知（如 thread/started、turn/completed 等）。
    /// payload 是序列化后的 `ServerNotification`。
    pub const NOTIFICATION: &str = "codex:notification";

    /// 服务器请求（如命令执行审批）。
    /// payload 是序列化后的 `ServerRequest`。
    /// 前端收到后应显示审批对话框，并通过 `thread/approve` 命令响应。
    pub const APPROVAL_REQUEST: &str = "codex:approval:request";

    /// 事件循环背压警告。
    /// payload 是被丢弃的事件数量（`usize`）。
    /// 前端可以提示用户"正在同步…"并等待 TurnCompleted 自动恢复。
    pub const LAGGED: &str = "codex:lagged";

    /// 运行时断开连接。
    /// payload 是断开原因（`&str`，如 `"event stream closed"`）。
    /// 前端应显示断连提示并禁用输入。
    pub const DISCONNECTED: &str = "codex:disconnected";
}

/// 处理单个 `InProcessServerEvent`，将其转换为 Tauri emit 调用。
///
/// 这是事件分发的核心函数，由 `bridge::runtime::run_event_loop` 调用。
///
/// # 参数
///
/// - `app_handle` — Tauri 应用句柄，用于 emit 事件到前端
/// - `event` — codex-rs 运行时产生的事件
pub fn dispatch_event(app_handle: &AppHandle, event: InProcessServerEvent) {
    match event {
        InProcessServerEvent::ServerNotification(notif) => {
            // 将通知序列化后 emit 到前端
            // 前端通过 `listen("codex:notification", ...)` 接收
            let _ = app_handle.emit(event_names::NOTIFICATION, &notif);

            // 检查是否是 TurnCompleted — 需要触发背压恢复
            // 使用 mapper::is_turn_completed（matches! 宏）替代字符串反射，
            // 编译期类型安全，不依赖 Display trait 的输出格式。
            if crate::bridge::mapper::is_turn_completed(&notif) {
                maybe_backfill_turn_completed_items(app_handle, &notif);
            }

            // 检查是否是 thread 生命周期事件（关闭/删除/归档）
            // 借鉴 codex-main 的 cancel_requests_for_thread：清理该 thread 的 pending 审批请求
            if let Some(thread_id) = thread_id_from_lifecycle_notification(&notif) {
                let cleared = crate::bridge::approval::clear_for_thread(&thread_id);
                if cleared > 0 {
                    log::info!(
                        "Cleared {cleared} pending requests due to thread lifecycle \
                         event (thread_id={thread_id})"
                    );
                }
            }
        }

        InProcessServerEvent::ServerRequest(req) => {
            // 审批类请求 → emit 到前端等待用户响应
            // 非审批类请求 → 自动响应（借鉴 codex-main current_time.rs 设计）
            if crate::bridge::mapper::is_approval_request(&req) {
                // 注册到 pending approvals 存储，等待前端响应
                crate::bridge::approval::register(req.clone());
                // 转换为前端可直接使用的扁平结构（避免暴露 ServerRequest 枚举）
                let event_data = crate::bridge::mapper::to_approval_event(&req);
                let _ = app_handle.emit(event_names::APPROVAL_REQUEST, &event_data);
            } else {
                // 非审批类请求 — 尝试自动响应（如 CurrentTimeRead 返回本地时间）
                // 借鉴 codex-main 的 current_time.rs：这些请求不需要用户介入
                match crate::bridge::mapper::try_auto_respond(&req) {
                    Some((request_id, result)) => {
                        log::debug!(
                            "Auto-responding to non-approval server request (id={request_id:?})"
                        );
                        // 异步回传响应 — dispatch_event 是同步函数，
                        // 用 tokio::spawn 避免 await 阻塞事件循环
                        tokio::spawn(async move {
                            match crate::state::handle() {
                                Ok(sender) => {
                                    if let Err(e) = sender
                                        .respond_to_server_request(request_id, result)
                                    {
                                        log::warn!(
                                            "Failed to auto-respond to server request: {e}"
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::warn!(
                                        "Cannot auto-respond — runtime not initialized: {e}"
                                    );
                                }
                            }
                        });
                    }
                    None => {
                        // 不支持自动响应的请求类型 — 记录日志并跳过
                        // 这些请求通常由 codex-rs 内部处理，桌面客户端不会接收到
                        log::debug!(
                            "Non-approval server request received (id={:?}), \
                             no auto-responder available — skipping",
                            req.id()
                        );
                    }
                }
            }
        }

        InProcessServerEvent::Lagged { skipped } => {
            // 背压警告：事件循环处理速度跟不上服务器发送速度
            // 丢弃的事件无法恢复，但 TurnCompleted 时会触发 backfill
            log::warn!(
                "Event loop lagged — {skipped} events dropped due to backpressure. \
                 TurnCompleted will trigger backfill."
            );
            let _ = app_handle.emit(event_names::LAGGED, skipped);
        }
    }
}

/// emit 运行时断开连接事件。
///
/// 当 `next_event()` 返回 `None` 时调用，表示运行时已关闭。
/// 前端收到此事件后应：
/// - 显示"连接已断开"提示
/// - 禁用输入框
/// - 提供重连按钮（未来 Remote 模式）
///
/// # 参数
///
/// - `app_handle` — Tauri 应用句柄
/// - `reason` — 断开原因（用于日志和前端显示）
pub fn emit_disconnected(app_handle: &AppHandle, reason: &str) {
    log::warn!("Codex runtime disconnected: {reason}");
    let _ = app_handle.emit(event_names::DISCONNECTED, reason);
}

/// 从 thread 生命周期通知中提取 `thread_id`。
///
/// 用于在 thread 关闭/删除/归档时触发 pending requests 清理。
/// 借鉴 codex-main 的 `cancel_requests_for_thread` 触发时机：
/// 这些事件表示 thread 已无法继续审批，pending 请求应被清理。
///
/// ## 支持的通知类型
///
/// - `ThreadClosed` — thread 被关闭（用户主动关闭或会话结束）
/// - `ThreadDeleted` — thread 被删除（资源回收）
/// - `ThreadArchived` — thread 被归档（只读状态，无法继续审批）
///
/// 其他通知类型（如 `ThreadStarted`、`ThreadUnarchived`）不触发清理：
/// - `ThreadStarted` — thread 刚创建，不可能有 pending 请求
/// - `ThreadUnarchived` — 从归档恢复，pending 请求已在上次归档时清理
///
/// # 参数
///
/// - `notif` — server notification 引用
///
/// # 返回
///
/// 返回 `Option<String>`：
/// - `Some(thread_id)` — 是生命周期事件，返回 thread_id
/// - `None` — 不是需要清理的生命周期事件
fn thread_id_from_lifecycle_notification(
    notif: &codex_app_server_protocol::ServerNotification,
) -> Option<String> {
    use codex_app_server_protocol::ServerNotification;
    match notif {
        ServerNotification::ThreadClosed(n) => Some(n.thread_id.clone()),
        ServerNotification::ThreadDeleted(n) => Some(n.thread_id.clone()),
        ServerNotification::ThreadArchived(n) => Some(n.thread_id.clone()),
        _ => None,
    }
}

/// 背压恢复：从 rollout 文件恢复被丢弃的 turn items。
///
/// 借鉴 codex-main 的设计：TurnCompleted 通知不携带 items（`items: vec![]`），
/// 客户端必须主动调 `thread/items/list` 拉取完整的 turn items。
///
/// 当 `Lagged` 事件发生时，`TurnCompleted` 通知可能也被丢弃。
/// 此函数在每次收到 `TurnCompleted` 时调用，通过 `thread/items/list`
/// 命令拉取该 turn 的所有 items，并 emit `codex:items:backfilled` 事件
/// 让前端 merge 到消息列表，保证前端看到完整的 turn 历史记录。
///
/// ## 实现说明
///
/// 1. 从 `TurnCompleted` 通知中提取 `thread_id` 和 `turn_id`
/// 2. 异步调用 `thread/items/list` 请求获取该 turn 的所有 items
/// 3. emit `codex:items:backfilled` 事件给前端，前端 merge 到消息列表
///
/// 由于 `dispatch_event` 是同步函数，使用 `tokio::spawn` 异步执行 backfill。
/// backfill 失败只记录警告日志，不影响主事件流。
///
/// # 参数
///
/// - `app_handle` — Tauri 应用句柄（用于 emit 补发的事件）
/// - `notif` — TurnCompleted 通知（包含 thread_id 和 turn_id）
fn maybe_backfill_turn_completed_items(
    app_handle: &AppHandle,
    notif: &codex_app_server_protocol::ServerNotification,
) {
    // 从 ServerNotification 中提取 TurnCompletedNotification
    let turn_completed = match notif {
        codex_app_server_protocol::ServerNotification::TurnCompleted(notif) => notif,
        _ => return,
    };

    let thread_id = turn_completed.thread_id.clone();
    let turn_id = turn_completed.turn.id.clone();

    log::debug!(
        "TurnCompleted received — backfilling items for thread={thread_id} turn={turn_id}"
    );

    // 异步执行 backfill — dispatch_event 是同步函数，不能直接 await
    let app_handle = app_handle.clone();
    tokio::spawn(async move {
        match backfill_turn_items(&thread_id, &turn_id).await {
            Ok(items) => {
                if !items.is_empty() {
                    log::debug!(
                        "Backfill complete — {items_len} items recovered for \
                         thread={thread_id} turn={turn_id}",
                        items_len = items.len()
                    );
                    // emit 补发的 items 给前端，前端 merge 到消息列表
                    let payload = serde_json::json!({
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "items": items,
                    });
                    let _ = app_handle.emit("codex:items:backfilled", &payload);
                }
            }
            Err(e) => {
                log::warn!(
                    "Backfill failed for thread={thread_id} turn={turn_id}: {e}"
                );
            }
        }
    });
}

/// 异步拉取指定 turn 的所有 items。
///
/// 通过 `thread/items/list` 命令分页拉取，直到没有更多页。
/// 返回的 items 是原始 JSON Value 数组，前端自行解析为 ThreadItem。
async fn backfill_turn_items(
    thread_id: &str,
    turn_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let sender = crate::state::handle().map_err(|e| e.to_string())?;

    let mut all_items: Vec<serde_json::Value> = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        // 构造 thread/items/list 请求参数
        let params = serde_json::json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "cursor": cursor,
            "limit": 100,
            "sortDirection": "ascending",
        });

        let request = codex_app_server_protocol::ClientRequest::ThreadItemsList {
            request_id: crate::state::sequencer().next_id(),
            params: serde_json::from_value(params)
                .map_err(|e| format!("failed to construct ThreadItemsListParams: {e}"))?,
        };

        // 使用 30s 超时 — 与 send_request_with_timeout 的默认超时一致
        let response = crate::bridge::request::send_request_with_timeout(
            &sender,
            request,
            std::time::Duration::from_secs(30),
        )
        .await
        .map_err(|e| format!("thread/items/list request failed: {e}"))?;

        // 提取 items 数组
        let empty_vec: Vec<serde_json::Value> = Vec::new();
        let data = response
            .get("data")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty_vec);
        all_items.extend(data.iter().cloned());

        // 检查是否还有更多页
        let next_cursor = response
            .get("nextCursor")
            .and_then(|v| v.as_str())
            .map(String::from);

        match next_cursor {
            Some(next) if !next.is_empty() => {
                cursor = Some(next);
            }
            _ => break,
        }
    }

    Ok(all_items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_use_codex_prefix() {
        // 所有事件名应以 "codex:" 前缀开头，避免与其他 Tauri 事件冲突
        assert!(event_names::NOTIFICATION.starts_with("codex:"));
        assert!(event_names::APPROVAL_REQUEST.starts_with("codex:"));
        assert!(event_names::LAGGED.starts_with("codex:"));
        assert!(event_names::DISCONNECTED.starts_with("codex:"));
    }

    #[test]
    fn event_names_are_unique() {
        let names = [
            event_names::NOTIFICATION,
            event_names::APPROVAL_REQUEST,
            event_names::LAGGED,
            event_names::DISCONNECTED,
        ];
        let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(names.len(), unique.len(), "Duplicate event names found");
    }
}
