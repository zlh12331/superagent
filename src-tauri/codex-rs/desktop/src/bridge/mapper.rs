//! 纯映射函数：codex-rs 类型 ↔ 应用类型。
//!
//! 这些函数是纯函数（无 I/O、无副作用），可以独立单元测试。
//! 它们构成 codex-rs 内部表示与 Tauri 命令层暴露类型之间的转换层。
//!
//! ## 职责
//!
//! - 从 `ServerRequest` 提取 `RequestId`
//! - 判断 `ServerRequest` 是否为审批类请求
//! - 判断 `ServerNotification` 是否为 `TurnCompleted`（替代字符串反射）
//! - 序列化辅助

use serde::Serialize;

use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ServerRequest;

// ─── ApprovalEventData ─ 前端审批事件 payload ───────────────────

/// 审批事件数据 — 后端 emit 到前端的扁平结构。
///
/// 替代直接序列化 `ServerRequest` 枚举（变体名 + 嵌套结构），
/// 提供前端可直接使用的扁平字段，同时保留 `request_id_json`
/// 供前端原样回传给 `approval_respond` / `approval_reject` 命令。
///
/// ## 字段说明
///
/// - `request_id_json` — `RequestId` 序列化后的 JSON 字符串
///   （如 `"42"` 或 `"\"abc\""`），前端原样作为 `requestIdJson` 参数回传
/// - `request_id_display` — 用于 UI 显示的简短字符串（如 `"42"` 或 `"abc"`）
/// - `approval_type` — 审批类型：`"command"` / `"file_change"` / `"patch"` / `"permissions"`
/// - `payload` — 人类可读的请求内容（命令文本/文件路径/补丁内容 JSON）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalEventData {
    /// `RequestId` 序列化后的 JSON 字符串 — 前端原样回传给 approval 命令
    pub request_id_json: String,
    /// 用于 UI 显示的 request ID 字符串
    pub request_id_display: String,
    /// 审批类型（command / file_change / patch / permissions）
    pub approval_type: String,
    /// 请求内容（JSON 格式，前端用 <pre> 显示）
    pub payload: String,
}

/// 将 `ServerRequest` 转换为前端可直接使用的 `ApprovalEventData`。
///
/// 这是 bridge 层的核心职责：隔离 codex-rs 内部类型（`ServerRequest` 枚举）
/// 与前端期望的扁平结构。前端不需要知道 `ServerRequest` 有哪些变体，
/// 只需处理统一的 `ApprovalEventData`。
///
/// ## 转换逻辑
///
/// 1. 提取 `RequestId`，序列化为 JSON 字符串（前端原样回传用）
/// 2. 根据 `ServerRequest` 变体映射到 `approval_type`
/// 3. 将 `params` 序列化为 JSON 字符串作为 `payload`
///
/// # 参数
///
/// - `req` — codex-rs 发来的 server request（必须是审批类，由 `is_approval_request` 判断）
///
/// # 返回
///
/// 返回 `ApprovalEventData`，可直接 `emit` 到前端。
pub fn to_approval_event(req: &ServerRequest) -> ApprovalEventData {
    // 提取 request_id 并序列化为 JSON 字符串
    // 前端收到后原样作为 requestIdJson 参数传给 approval_respond/reject 命令
    let request_id = req.id();
    let request_id_json = serde_json::to_string(request_id)
        .unwrap_or_else(|_| "null".to_string());

    // 用于 UI 显示的简短字符串
    let request_id_display = match request_id {
        RequestId::Integer(n) => n.to_string(),
        RequestId::String(s) => s.clone(),
    };

    // 根据 ServerRequest 变体映射到 approval_type + 提取 params JSON
    let (approval_type, payload) = match req {
        ServerRequest::CommandExecutionRequestApproval { params, .. } => (
            "command",
            serde_json::to_string_pretty(params).unwrap_or_default(),
        ),
        ServerRequest::FileChangeRequestApproval { params, .. } => (
            "file_change",
            serde_json::to_string_pretty(params).unwrap_or_default(),
        ),
        ServerRequest::PermissionsRequestApproval { params, .. } => (
            "permissions",
            serde_json::to_string_pretty(params).unwrap_or_default(),
        ),
        ServerRequest::ApplyPatchApproval { params, .. } => (
            "patch",
            serde_json::to_string_pretty(params).unwrap_or_default(),
        ),
        ServerRequest::ExecCommandApproval { params, .. } => (
            "command",
            serde_json::to_string_pretty(params).unwrap_or_default(),
        ),
        // 非审批类请求 — 理论上不应到达此处
        // （event.rs 只对 is_approval_request 的请求调用此函数）
        _ => ("unknown", String::new()),
    };

    ApprovalEventData {
        request_id_json,
        request_id_display,
        approval_type: approval_type.to_string(),
        payload,
    }
}

/// 提取 `ServerRequest` 的 `RequestId`。
///
/// 这是一个语义封装函数，避免调用方直接调用 `request.id()` 后再 clone。
/// 在 approval 流程中，event.rs 收到 ServerRequest 后需要提取 ID 用于
/// 注册到 pending requests 存储。
///
/// # 参数
///
/// - `request` — server request 引用
///
/// # 返回
///
/// 返回 `RequestId` 的克隆（因为调用方通常需要持有 ID 而非引用）。
pub fn request_id_of(request: &ServerRequest) -> RequestId {
    request.id().clone()
}

/// 判断 `ServerRequest` 是否为审批类请求。
///
/// 审批类请求需要前端显示审批对话框，用户选择批准或拒绝。
/// 非审批类请求（如 `CurrentTimeRead`、`AttestationGenerate`）可以直接
/// 自动响应，不需要用户介入。
///
/// 审批类请求包括：
/// - `CommandExecutionRequestApproval` — 命令执行审批
/// - `FileChangeRequestApproval` — 文件变更审批
/// - `PermissionsRequestApproval` — 权限审批
/// - `ApplyPatchApproval` — 补丁审批（已废弃但仍在使用）
/// - `ExecCommandApproval` — 命令执行审批（已废弃但仍在使用）
///
/// # 参数
///
/// - `request` — server request 引用
pub fn is_approval_request(request: &ServerRequest) -> bool {
    matches!(
        request,
        ServerRequest::CommandExecutionRequestApproval { .. }
            | ServerRequest::FileChangeRequestApproval { .. }
            | ServerRequest::PermissionsRequestApproval { .. }
            | ServerRequest::ApplyPatchApproval { .. }
            | ServerRequest::ExecCommandApproval { .. }
    )
}

/// 尝试自动响应非审批类 `ServerRequest`。
///
/// 借鉴 codex-main 的 `current_time.rs` 设计：非审批类请求（如 `CurrentTimeRead`）
/// 由桌面客户端直接响应，不需要用户介入。
///
/// 当前支持的自动响应类型：
/// - `CurrentTimeRead` — 返回本地 Unix 时间戳（秒）
///   对应 codex-main `app-server/src/current_time.rs:28-83` 的 `AppServerTimeProvider`
///
/// 其他非审批类请求（如 `AttestationGenerate`、`ChatgptAuthTokensRefresh`）目前
/// 只记录日志，后续按需添加。这是 codex-main 的行为——这些请求由 codex-rs 内部
/// 路由到对应处理器，桌面客户端通常不会接收到。
///
/// # 参数
///
/// - `request` — 非审批类 server request（调用方需先用 `is_approval_request` 过滤）
///
/// # 返回
///
/// 返回 `Option<(RequestId, serde_json::Value)>`：
/// - `Some((id, result))` — 已构造自动响应，调用方通过 `sender.respond_to_server_request(id, result)` 回传
/// - `None` — 该请求类型暂不支持自动响应，调用方应记录日志并跳过
pub fn try_auto_respond(request: &ServerRequest) -> Option<(RequestId, serde_json::Value)> {
    match request {
        ServerRequest::CurrentTimeRead { request_id, .. } => {
            // 返回当前 Unix 时间戳（秒）— 与 codex-main 的 CurrentTimeReadResponse 结构对齐
            // CurrentTimeReadResponse { current_time_at: i64 }
            // 使用 std::time::SystemTime 避免引入 chrono 依赖
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let result = serde_json::json!({ "currentTimeAt": now });
            Some((request_id.clone(), result))
        }
        // 其他非审批类请求暂不自动响应 — 这些通常由 codex-rs 内部处理，
        // 桌面客户端不会接收到。如果未来确实需要，可在此添加分支。
        _ => None,
    }
}

/// 从 `ServerRequest` 提取 `thread_id`。
///
/// 用于按 thread 清理 pending requests — 当 thread 被关闭/归档/删除时，
/// 调用方可以用此函数找到属于该 thread 的 pending 审批请求并清理。
///
/// 借鉴 codex-main 的 `outgoing_message.rs` 中 `PendingRequestEntry.thread_id` 字段：
/// codex-main 在注册 pending request 时就记录了 thread_id，这里通过解析 params 提取。
///
/// ## 支持的请求类型
///
/// - v2 审批类：`CommandExecutionRequestApproval` / `FileChangeRequestApproval` /
///   `PermissionsRequestApproval`（params 中有 `thread_id: String` 字段）
/// - v1 legacy 审批类：`ApplyPatchApproval` / `ExecCommandApproval`
///   （params 中有 `conversation_id: ThreadId` 字段，Display 为 UUID 字符串）
///
/// 非审批类请求（如 `CurrentTimeRead`、`AttestationGenerate`）不存储在 pending requests 中，
/// 因此这里返回 `None`，调用方无需处理。
///
/// # 参数
///
/// - `request` — server request 引用
///
/// # 返回
///
/// 返回 `Option<String>`：
/// - `Some(thread_id)` — 请求包含 thread_id，已转为 owned String
/// - `None` — 该请求类型不存储在 pending requests 中，或没有 thread_id 字段
pub fn thread_id_of(request: &ServerRequest) -> Option<String> {
    match request {
        ServerRequest::CommandExecutionRequestApproval { params, .. } => {
            Some(params.thread_id.clone())
        }
        ServerRequest::FileChangeRequestApproval { params, .. } => {
            Some(params.thread_id.clone())
        }
        ServerRequest::PermissionsRequestApproval { params, .. } => {
            Some(params.thread_id.clone())
        }
        // v1 legacy 审批类 — 使用 conversation_id（ThreadId 类型，Display 为 UUID 字符串）
        ServerRequest::ApplyPatchApproval { params, .. } => {
            Some(params.conversation_id.to_string())
        }
        ServerRequest::ExecCommandApproval { params, .. } => {
            Some(params.conversation_id.to_string())
        }
        // 非审批类请求不存储在 pending requests 中，无需提取 thread_id
        _ => None,
    }
}

/// 判断 `ServerNotification` 是否为 `TurnCompleted`。
///
/// 使用 `matches!` 宏直接匹配枚举变体，替代之前的字符串反射方式
/// （`format!("{notif}") == "turn/completed"`）。这种方式：
/// - 编译期类型安全：如果 codex-rs 重命名变体，编译会报错
/// - 无运行时开销：不需要格式化字符串
/// - 不依赖 `Display` trait 的输出格式
///
/// # 参数
///
/// - `notif` — server notification 引用
pub fn is_turn_completed(notif: &ServerNotification) -> bool {
    matches!(notif, ServerNotification::TurnCompleted(_))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_of_returns_correct_id() {
        // 构造一个简单的 CurrentTimeRead request 测试 ID 提取
        let params = codex_app_server_protocol::CurrentTimeReadParams {
            thread_id: "test-thread".to_string(),
        };
        let request = ServerRequest::CurrentTimeRead {
            request_id: RequestId::Integer(42),
            params,
        };
        let id = request_id_of(&request);
        assert_eq!(id, RequestId::Integer(42));
    }

    #[test]
    fn is_approval_request_returns_false_for_current_time() {
        // CurrentTimeRead 不是审批类请求
        let params = codex_app_server_protocol::CurrentTimeReadParams {
            thread_id: "test".to_string(),
        };
        let request = ServerRequest::CurrentTimeRead {
            request_id: RequestId::Integer(2),
            params,
        };
        assert!(!is_approval_request(&request));
    }
}
