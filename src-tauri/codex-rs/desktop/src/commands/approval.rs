//! Approval 域 Tauri 命令。
//!
//! 提供审批响应能力：列出 pending 请求、批准、拒绝。
//! 每个命令只做参数验证 + 调用 bridge 层 + 返回结果，
//! 不包含业务逻辑（pending 存储和回传逻辑在 `bridge::approval`）。
//!
//! ## 事件流
//!
//! ```text
//! codex-rs ServerRequest
//!     ↓
//! bridge::event::dispatch_event → approval::register + emit("codex:approval:request")
//!     ↓
//! 前端显示审批对话框
//!     ↓
//! 用户点击"批准" → approval_respond 命令
//! 用户点击"拒绝" → approval_reject 命令
//!     ↓
//! bridge::approval::respond / reject
//!     ↓
//! sender.respond_to_server_request / fail_server_request
//!     ↓
//! codex-rs 收到响应，继续或中止 turn
//! ```
//!
//! ## 设计说明
//!
//! ### 输入：DTO + JSON 字符串
//!
//! `RequestId` 和 `JSONRPCErrorError` 是 codex-rs 协议类型，
//! 只实现了 `ts_rs::TS`，没有实现 `specta::Type`，无法直接用作
//! tauri-specta 命令参数。因此使用 JSON 字符串承载（与 thread.rs
//! 中 `params_json` 的处理方式一致）。
//!
//! 前端通过 `JSON.stringify()` 将复杂对象转为 JSON 字符串传入，
//! 命令内部用 `serde_json::from_str` 反序列化。
//!
//! ### 输出：`()` 或 `String`
//!
//! - `approval_respond` / `approval_reject` 返回 `()` — 成功/失败由
//!   `Result<(), AppError>` 表达，无需返回数据
//! - `approval_list_pending` 返回 `String` — JSON 序列化后的
//!   `Vec<RequestId>`，前端 `JSON.parse()` 后得到数组

use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::RequestId;
use serde::Deserialize;
use serde::Serialize;
use specta::Type;

use crate::error::AppError;

// =============================================================================
// DTO — 命令参数（实现 specta::Type，用于生成 TypeScript 绑定）
// =============================================================================

/// `approval/respond` 命令的参数。
///
/// 批准一个 pending server request，将 JSON-RPC result 回传给 codex-rs。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRespondArgs {
    /// 要批准的 request ID（JSON 序列化后的字符串）。
    ///
    /// 前端通过 `JSON.stringify(requestId)` 生成。
    /// `RequestId` 是枚举类型（`Integer(i64)` 或 `String(String)`），
    /// 序列化后为 JSON 数字或 JSON 字符串。
    ///
    /// **示例**：
    /// - 整数 ID 42 → `requestIdJson = "42"`
    /// - 字符串 ID "abc" → `requestIdJson = "\"abc\""`
    pub request_id_json: String,

    /// JSON-RPC result payload（JSON 字符串）。
    ///
    /// 具体结构取决于 `ServerRequest` 类型。例如：
    /// - `CommandExecutionRequestApproval` → `{ "approved": true }`
    /// - `FileChangeRequestApproval` → `{ "approved": true }`
    /// - `CurrentTimeRead` → `{ "time": "2026-01-01T00:00:00Z" }`
    ///
    /// 前端构造好 result 对象后通过 `JSON.stringify(result)` 传入。
    pub result_json: String,
}

/// `approval/reject` 命令的参数。
///
/// 拒绝一个 pending server request，将 JSON-RPC error 回传给 codex-rs。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRejectArgs {
    /// 要拒绝的 request ID（JSON 序列化后的字符串）。
    /// 格式同 [`ApprovalRespondArgs::request_id_json`]。
    pub request_id_json: String,

    /// JSON-RPC error 对象（JSON 字符串）。
    ///
    /// 格式：`{ "code": -32601, "message": "...", "data": null }`
    ///
    /// 常用错误码：
    /// - `-32601` — Method not found
    /// - `-32602` — Invalid params
    /// - `-32603` — Internal error
    /// - `-32000` — Server error（通用）
    ///
    /// 前端通过 `JSON.stringify(error)` 传入。
    pub error_json: String,
}

// =============================================================================
// Tauri 命令
// =============================================================================

/// 批准一个 pending server request。
///
/// 从全局 pending 存储中取出 request（如果存在），
/// 然后通过 `sender.respond_to_server_request` 将 JSON-RPC result
/// 回传给 codex-rs，使其继续执行被审批的操作。
///
/// # 参数
///
/// - `args` — 包含 `request_id_json` 和 `result_json`
///
/// # 错误
///
/// - [`AppError::Validation`] — JSON 反序列化失败
/// - [`AppError::NotInitialized`] — codex 运行时未初始化
/// - [`AppError::NotFound`] — request_id 不在 pending 存储中（已响应或从未注册）
/// - [`AppError::AppServerError`] — 回传响应时传输失败
#[tauri::command]
#[specta::specta]
pub async fn approval_respond(args: ApprovalRespondArgs) -> Result<(), AppError> {
    // 反序列化 request_id — 前端传入的是 JSON 字符串
    let request_id: RequestId = serde_json::from_str(&args.request_id_json)
        .map_err(|e| AppError::validation(format!("invalid request_id_json: {e}")))?;

    // 反序列化 result — 前端传入的是 JSON 字符串
    let result: serde_json::Value = serde_json::from_str(&args.result_json)
        .map_err(|e| AppError::validation(format!("invalid result_json: {e}")))?;

    // 委托给 bridge 层执行实际响应
    crate::bridge::approval::respond(request_id, result)
}

/// 拒绝一个 pending server request。
///
/// 从全局 pending 存储中取出 request，然后通过
/// `sender.fail_server_request` 将 JSON-RPC error 回传给 codex-rs，
/// 使其中止被拒绝的操作。
///
/// # 参数
///
/// - `args` — 包含 `request_id_json` 和 `error_json`
///
/// # 错误
///
/// - [`AppError::Validation`] — JSON 反序列化失败
/// - [`AppError::NotInitialized`] — codex 运行时未初始化
/// - [`AppError::NotFound`] — request_id 不在 pending 存储中
/// - [`AppError::AppServerError`] — 回传错误时传输失败
#[tauri::command]
#[specta::specta]
pub async fn approval_reject(args: ApprovalRejectArgs) -> Result<(), AppError> {
    // 反序列化 request_id
    let request_id: RequestId = serde_json::from_str(&args.request_id_json)
        .map_err(|e| AppError::validation(format!("invalid request_id_json: {e}")))?;

    // 反序列化 JSON-RPC error 对象
    let error: JSONRPCErrorError = serde_json::from_str(&args.error_json)
        .map_err(|e| AppError::validation(format!("invalid error_json: {e}")))?;

    // 委托给 bridge 层执行实际拒绝
    crate::bridge::approval::reject(request_id, error)
}

/// 列出所有 pending approval request 的 ID。
///
/// 前端在页面刷新后可以调用此命令，恢复审批对话框。
/// 返回的 ID 列表对应尚未响应的 `ServerRequest`。
///
/// # 返回
///
/// 返回 JSON 字符串，反序列化后为 `RequestId[]`。
/// 例如：`"[1, 2, 3]"`（整数 ID 列表）。
///
/// # 错误
///
/// - [`AppError::Serialization`] — 序列化失败（理论上不应发生）
#[tauri::command]
#[specta::specta]
pub async fn approval_list_pending() -> Result<String, AppError> {
    let ids = crate::bridge::approval::list_pending_ids();
    serde_json::to_string(&ids)
        .map_err(|e| AppError::serialization(format!("failed to serialize pending IDs: {e}")))
}

// =============================================================================
// 单元测试
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_respond_args_deserializes_correctly() {
        let json = serde_json::json!({
            "requestIdJson": "42",
            "resultJson": "{\"approved\": true}"
        });
        let args: ApprovalRespondArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.request_id_json, "42");
        assert_eq!(args.result_json, "{\"approved\": true}");
    }

    #[test]
    fn approval_reject_args_deserializes_correctly() {
        let json = serde_json::json!({
            "requestIdJson": "42",
            "errorJson": "{\"code\": -32601, \"message\": \"not found\", \"data\": null}"
        });
        let args: ApprovalRejectArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.request_id_json, "42");
        assert!(args.error_json.contains("-32601"));
    }

    #[test]
    fn approval_respond_args_serializes_with_camel_case() {
        let args = ApprovalRespondArgs {
            request_id_json: "42".to_string(),
            result_json: "{}".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        // 确保字段名是 camelCase（前端约定）
        assert!(json.get("requestIdJson").is_some());
        assert!(json.get("resultJson").is_some());
        // 不应有 snake_case 字段
        assert!(json.get("request_id_json").is_none());
    }
}
