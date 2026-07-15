//! MCP（Model Context Protocol）域 Tauri 命令。
//!
//! 提供 MCP 服务器管理能力：OAuth 登录、状态列表、资源读取、工具调用、
//! 服务器刷新等。
//! 每个命令只做参数验证 + 调用 bridge 层 + 返回结果，
//! 不包含业务逻辑（业务逻辑在 codex-rs 内部）。
//!
//! ## 设计说明
//!
//! ### 输入：DTO（Data Transfer Object）
//!
//! codex-rs 的 Params 类型只实现了 `ts_rs::TS`，没有实现 `specta::Type`，
//! 因此无法直接用作 tauri-specta 命令参数。我们为每个命令创建轻量级
//! DTO 结构体，只包含简单类型 + `specta::Type` derive。
//! 命令内部将 DTO 转换为 codex-rs 的 Params。
//!
//! ### 输出：`String`（JSON 字符串）
//!
//! codex-rs 的 Response 类型包含大量复杂嵌套类型，镜像这些类型到
//! specta 类型工作量巨大且容易过时。因此命令返回序列化后的 JSON
//! 字符串（`String`），前端调用后 `JSON.parse()` 即可得到结构化数据。

use codex_app_server_protocol::ClientRequest;
use serde::Deserialize;
use serde::Serialize;
use specta::Type;

#[cfg(test)]
use crate::bridge::request::RequestIdSequencer;
use crate::bridge::request::send_request;
use crate::error::AppError;
use crate::state;

// =============================================================================
// DTO — 命令参数（实现 specta::Type，用于生成 TypeScript 绑定）
// =============================================================================

/// `mcpServer/oauth/login` 命令的参数。
///
/// 启动指定 MCP 服务器的 OAuth 登录流程。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerOauthLoginArgs {
    /// MCP 服务器名称（必填）。
    pub name: String,
    /// 关联的线程 ID。为空时使用全局作用域。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// OAuth 授权范围列表。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    /// 登录超时时间（秒）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<f64>,
}

/// `mcpServerStatus/list` 命令的参数。
///
/// 分页列出所有 MCP 服务器的状态信息。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatusListArgs {
    /// 分页游标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 每页数量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// 关联的线程 ID。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

/// `mcpServer/resource/read` 命令的参数。
///
/// 读取指定 MCP 服务器上的资源内容。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceReadArgs {
    /// 关联的线程 ID。为空时使用全局作用域。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// MCP 服务器名称（必填）。
    pub server: String,
    /// 资源 URI（必填）。
    pub uri: String,
}

/// `mcpServer/tool/call` 命令的参数。
///
/// 调用指定 MCP 服务器上的工具。
///
/// `arguments` 为工具调用参数的 JSON 字符串，由前端 `JSON.stringify` 后传入。
/// 使用 `String` 而非 `serde_json::Value` 是为了规避 specta BigInt 禁令。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerToolCallArgs {
    /// 关联的线程 ID（必填）。
    pub thread_id: String,
    /// MCP 服务器名称（必填）。
    pub server: String,
    /// 要调用的工具名称（必填）。
    pub tool: String,
    /// 工具调用参数的 JSON 字符串（前端 `JSON.stringify` 后传入，是一个 JSON 对象）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
}

/// `config/mcpServer/reload` 命令的参数（无字段）。
///
/// 刷新 MCP 服务器配置，重新加载所有已注册的 MCP 服务器。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRefreshArgs {}

// =============================================================================
// 命令实现
// =============================================================================

/// 启动 MCP 服务器的 OAuth 登录。
///
/// 调用 codex-rs 的 `mcpServer/oauth/login` 方法，返回授权 URL
/// 供前端在浏览器中打开。
///
/// # 参数
///
/// - `args` — 包含 `name` 和可选的 `threadId`、`scopes`、`timeoutSecs`
///
/// # 错误
///
/// - [`AppError::Validation`] — `name` 为空
#[tauri::command]
#[specta::specta]
pub async fn mcp_server_oauth_login(args: McpServerOauthLoginArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.name.trim().is_empty() {
        return Err(AppError::validation("name cannot be empty"));
    }

    let params = serde_json::json!({
        "name": args.name,
        "threadId": args.thread_id,
        "scopes": args.scopes,
        "timeoutSecs": args.timeout_secs,
    });

    let request = ClientRequest::McpServerOauthLogin {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct McpServerOauthLoginParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 列出 MCP 服务器状态。
///
/// 调用 codex-rs 的 `mcpServerStatus/list` 方法，分页返回所有 MCP
/// 服务器的状态、工具和资源信息。
///
/// # 参数
///
/// - `args` — 分页参数（游标、每页数量、线程 ID）
#[tauri::command]
#[specta::specta]
pub async fn mcp_server_status_list(args: McpServerStatusListArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    let params = serde_json::json!({
        "cursor": args.cursor,
        "limit": args.limit,
        "threadId": args.thread_id,
    });

    let request = ClientRequest::McpServerStatusList {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ListMcpServerStatusParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 读取 MCP 资源内容。
///
/// 调用 codex-rs 的 `mcpServer/resource/read` 方法，获取指定 MCP 服务器
/// 上特定 URI 的资源内容。
///
/// # 参数
///
/// - `args` — 包含 `server`、`uri` 和可选的 `threadId`
///
/// # 错误
///
/// - [`AppError::Validation`] — `server` 或 `uri` 为空
#[tauri::command]
#[specta::specta]
pub async fn mcp_resource_read(args: McpResourceReadArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.server.trim().is_empty() {
        return Err(AppError::validation("server cannot be empty"));
    }
    if args.uri.trim().is_empty() {
        return Err(AppError::validation("uri cannot be empty"));
    }

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "server": args.server,
        "uri": args.uri,
    });

    let request = ClientRequest::McpResourceRead {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct McpResourceReadParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 调用 MCP 服务器工具。
///
/// 调用 codex-rs 的 `mcpServer/tool/call` 方法，在指定线程上执行
/// MCP 服务器提供的工具。
///
/// # 参数
///
/// - `args` — 包含 `threadId`、`server`、`tool` 和可选的 `arguments`
///
/// # 错误
///
/// - [`AppError::Validation`] — `threadId`、`server` 或 `tool` 为空
#[tauri::command]
#[specta::specta]
pub async fn mcp_server_tool_call(args: McpServerToolCallArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.thread_id.trim().is_empty() {
        return Err(AppError::validation("thread_id cannot be empty"));
    }
    if args.server.trim().is_empty() {
        return Err(AppError::validation("server cannot be empty"));
    }
    if args.tool.trim().is_empty() {
        return Err(AppError::validation("tool cannot be empty"));
    }

    // 解析 arguments JSON 字符串为 serde_json::Value（如果有）
    let arguments: Option<serde_json::Value> = match args.arguments {
        Some(json_str) => {
            let parsed: serde_json::Value = serde_json::from_str(&json_str)
                .map_err(|e| AppError::validation(format!("invalid arguments JSON: {e}")))?;
            Some(parsed)
        }
        None => None,
    };

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "server": args.server,
        "tool": args.tool,
        "arguments": arguments,
    });

    let request = ClientRequest::McpServerToolCall {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct McpServerToolCallParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 刷新 MCP 服务器配置。
///
/// 调用 codex-rs 的 `config/mcpServer/reload` 方法，重新加载所有
/// 已注册的 MCP 服务器配置。
///
/// # 参数
///
/// - `_args` — 无参数（空结构体）
#[tauri::command]
#[specta::specta]
pub async fn mcp_server_refresh(_args: McpServerRefreshArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    // params 类型为 Option<()>，使用 Null 表示无参数
    let params: Option<()> = serde_json::from_value(serde_json::Value::Null).map_err(|e| {
        AppError::validation(format!("failed to construct McpServerRefreshParams: {e}"))
    })?;

    let request = ClientRequest::McpServerRefresh {
        request_id: state::sequencer().next_id(),
        params,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_server_oauth_login_args_serializes_correctly() {
        let args = McpServerOauthLoginArgs {
            name: "my-server".to_string(),
            thread_id: Some("thread-001".to_string()),
            scopes: Some(vec!["read".to_string(), "write".to_string()]),
            timeout_secs: Some(300.0),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["name"], "my-server");
        assert_eq!(json["threadId"], "thread-001");
        assert_eq!(json["timeoutSecs"].as_f64().unwrap(), 300.0);
    }

    #[test]
    fn mcp_server_oauth_login_args_omits_optional_fields() {
        let args = McpServerOauthLoginArgs {
            name: "my-server".to_string(),
            thread_id: None,
            scopes: None,
            timeout_secs: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert!(!json.contains("threadId"));
        assert!(!json.contains("scopes"));
        assert!(!json.contains("timeoutSecs"));
    }

    #[test]
    fn mcp_server_status_list_args_serializes_correctly() {
        let args = McpServerStatusListArgs {
            cursor: Some("abc".to_string()),
            limit: Some(50),
            thread_id: None,
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["cursor"], "abc");
        assert_eq!(json["limit"], 50);
    }

    #[test]
    fn mcp_resource_read_args_deserializes_from_camel_case() {
        let json = serde_json::json!({
            "threadId": "thread-002",
            "server": "my-server",
            "uri": "file:///path/to/resource"
        });
        let args: McpResourceReadArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.thread_id, Some("thread-002".to_string()));
        assert_eq!(args.server, "my-server");
        assert_eq!(args.uri, "file:///path/to/resource");
    }

    #[test]
    fn mcp_server_tool_call_args_serializes_correctly() {
        let args = McpServerToolCallArgs {
            thread_id: "thread-003".to_string(),
            server: "my-server".to_string(),
            tool: "search".to_string(),
            arguments: Some(r#"{"query":"hello"}"#.to_string()),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["threadId"], "thread-003");
        assert_eq!(json["server"], "my-server");
        assert_eq!(json["tool"], "search");
        assert_eq!(json["arguments"], "{\"query\":\"hello\"}");
    }

    #[test]
    fn mcp_server_refresh_args_is_empty_struct() {
        let args = McpServerRefreshArgs {};
        let json = serde_json::to_string(&args).unwrap();
        assert_eq!(json, "{}");
    }

    #[test]
    fn sequencer_produces_unique_ids_across_calls() {
        let seq = RequestIdSequencer::new();
        let id1 = seq.next_id();
        let id2 = seq.next_id();
        assert_ne!(id1, id2);
    }
}
