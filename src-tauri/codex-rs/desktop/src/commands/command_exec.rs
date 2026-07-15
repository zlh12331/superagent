//! 命令执行（command_exec）域 Tauri 命令。
//!
//! 提供沙箱内命令执行能力：执行一次性命令、写入 stdin、终止命令、
//! 调整 PTY 大小。
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

/// `command/exec` 命令的参数。
///
/// 在服务器沙箱内执行一个独立的命令（argv 向量）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecArgs {
    /// 命令 argv 向量（如 `["ls", "-la"]`，必填，不能为空）。
    pub command: Vec<String>,
    /// 客户端提供的进程 ID，用于后续的 write/terminate/resize 调用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
    /// 是否启用 PTY 模式。启用后隐含 streamStdin 和 streamStdoutStderr。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tty: Option<bool>,
    /// 是否允许后续 `command/exec/write` 写入 stdin。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_stdin: Option<bool>,
    /// 是否通过通知流式传输 stdout/stderr。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_stdout_stderr: Option<bool>,
    /// 工作目录。为空时使用服务器默认值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 超时时间（毫秒）。为空时使用服务器默认值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
}

/// `command/exec/write` 命令的参数。
///
/// 向正在运行的 `command/exec` 会话写入 stdin 数据或关闭 stdin。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecWriteArgs {
    /// 客户端提供的进程 ID（必填）。
    pub process_id: String,
    /// 要写入的 stdin 数据，base64 编码。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_base64: Option<String>,
    /// 写入后是否关闭 stdin。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_stdin: Option<bool>,
}

/// `command/exec/terminate` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecTerminateArgs {
    /// 要终止的进程 ID（必填）。
    pub process_id: String,
}

/// `command/exec/resize` 命令的参数。
///
/// 调整 PTY 模式下运行中的命令会话终端大小。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecResizeArgs {
    /// 要调整大小的进程 ID（必填）。
    pub process_id: String,
    /// 终端行数（高度）。
    pub rows: u32,
    /// 终端列数（宽度）。
    pub cols: u32,
}

// =============================================================================
// 命令实现
// =============================================================================

/// 执行一次性命令。
///
/// 调用 codex-rs 的 `command/exec` 方法，在服务器沙箱内执行一个
/// 独立的命令。支持 PTY 模式和 stdin/stdout 流式传输。
///
/// # 参数
///
/// - `args` — 命令参数（argv 向量、进程 ID、模式标志等）
///
/// # 错误
///
/// - [`AppError::Validation`] — `command` 为空数组
#[tauri::command]
#[specta::specta]
pub async fn command_exec(args: CommandExecArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.command.is_empty() {
        return Err(AppError::validation("command cannot be empty"));
    }

    let params = serde_json::json!({
        "command": args.command,
        "processId": args.process_id,
        "tty": args.tty,
        "streamStdin": args.stream_stdin,
        "streamStdoutStderr": args.stream_stdout_stderr,
        "cwd": args.cwd,
        "timeoutMs": args.timeout_ms,
    });

    let request = ClientRequest::OneOffCommandExec {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct CommandExecParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 写入 stdin 或关闭 stdin。
///
/// 调用 codex-rs 的 `command/exec/write` 方法，向正在运行的
/// `command/exec` 会话写入 base64 编码的 stdin 数据，或关闭 stdin。
///
/// # 参数
///
/// - `args` — 包含 `processId` 和可选的 `deltaBase64`、`closeStdin`
///
/// # 错误
///
/// - [`AppError::Validation`] — `processId` 为空
#[tauri::command]
#[specta::specta]
pub async fn command_exec_write(args: CommandExecWriteArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.process_id.trim().is_empty() {
        return Err(AppError::validation("process_id cannot be empty"));
    }

    let params = serde_json::json!({
        "processId": args.process_id,
        "deltaBase64": args.delta_base64,
        "closeStdin": args.close_stdin,
    });

    let request = ClientRequest::CommandExecWrite {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct CommandExecWriteParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 终止正在运行的命令。
///
/// 调用 codex-rs 的 `command/exec/terminate` 方法，终止指定进程 ID
/// 对应的运行中命令会话。
///
/// # 参数
///
/// - `args` — 包含 `processId`
///
/// # 错误
///
/// - [`AppError::Validation`] — `processId` 为空
#[tauri::command]
#[specta::specta]
pub async fn command_exec_terminate(args: CommandExecTerminateArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.process_id.trim().is_empty() {
        return Err(AppError::validation("process_id cannot be empty"));
    }

    let params = serde_json::json!({
        "processId": args.process_id,
    });

    let request = ClientRequest::CommandExecTerminate {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct CommandExecTerminateParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 调整 PTY 终端大小。
///
/// 调用 codex-rs 的 `command/exec/resize` 方法，调整 PTY 模式下
/// 运行中的命令会话的终端大小。params 中的 `size` 字段是嵌套对象，
/// 包含 `rows` 和 `cols`。
///
/// # 参数
///
/// - `args` — 包含 `processId`、`rows` 和 `cols`
///
/// # 错误
///
/// - [`AppError::Validation`] — `processId` 为空或 `rows`/`cols` 为 0
#[tauri::command]
#[specta::specta]
pub async fn command_exec_resize(args: CommandExecResizeArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.process_id.trim().is_empty() {
        return Err(AppError::validation("process_id cannot be empty"));
    }
    if args.rows == 0 || args.cols == 0 {
        return Err(AppError::validation("rows and cols must be greater than 0"));
    }

    // size 是嵌套的 CommandExecTerminalSize { rows: u16, cols: u16 }
    let params = serde_json::json!({
        "processId": args.process_id,
        "size": {
            "rows": args.rows,
            "cols": args.cols,
        },
    });

    let request = ClientRequest::CommandExecResize {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct CommandExecResizeParams: {e}"))
        })?,
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
    fn command_exec_args_serializes_correctly() {
        let args = CommandExecArgs {
            command: vec!["ls".to_string(), "-la".to_string()],
            process_id: Some("proc-1".to_string()),
            tty: Some(true),
            stream_stdin: None,
            stream_stdout_stderr: None,
            cwd: Some("/home/user".to_string()),
            timeout_ms: Some(30000.0),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["command"][0], "ls");
        assert_eq!(json["command"][1], "-la");
        assert_eq!(json["processId"], "proc-1");
        assert_eq!(json["tty"], true);
        assert_eq!(json["cwd"], "/home/user");
        assert_eq!(json["timeoutMs"].as_f64().unwrap(), 30000.0);
    }

    #[test]
    fn command_exec_args_omits_optional_fields() {
        let args = CommandExecArgs {
            command: vec!["echo".to_string()],
            process_id: None,
            tty: None,
            stream_stdin: None,
            stream_stdout_stderr: None,
            cwd: None,
            timeout_ms: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert!(!json.contains("processId"));
        assert!(!json.contains("tty"));
        assert!(!json.contains("cwd"));
    }

    #[test]
    fn command_exec_write_args_deserializes_from_camel_case() {
        let json = serde_json::json!({
            "processId": "proc-2",
            "deltaBase64": "aGVsbG8=",
            "closeStdin": true
        });
        let args: CommandExecWriteArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.process_id, "proc-2");
        assert_eq!(args.delta_base64, Some("aGVsbG8=".to_string()));
        assert_eq!(args.close_stdin, Some(true));
    }

    #[test]
    fn command_exec_terminate_args_serializes_correctly() {
        let args = CommandExecTerminateArgs {
            process_id: "proc-3".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["processId"], "proc-3");
    }

    #[test]
    fn command_exec_resize_args_serializes_correctly() {
        let args = CommandExecResizeArgs {
            process_id: "proc-4".to_string(),
            rows: 24,
            cols: 80,
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["processId"], "proc-4");
        assert_eq!(json["rows"], 24);
        assert_eq!(json["cols"], 80);
    }

    #[test]
    fn sequencer_produces_unique_ids_across_calls() {
        let seq = RequestIdSequencer::new();
        let id1 = seq.next_id();
        let id2 = seq.next_id();
        assert_ne!(id1, id2);
    }
}
