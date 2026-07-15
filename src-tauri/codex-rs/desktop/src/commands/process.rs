//! Process 域 Tauri 命令。
//!
//! 提供独立进程管理能力：启动进程、写入 stdin、终止进程、调整 PTY 大小。
//! 与 `command_exec` 不同，`process` 命令在主机上直接执行，不经过
//! Codex 沙箱。
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

/// `process/spawn` 命令的参数。
///
/// 在主机上启动一个独立进程（argv 向量），不经过 Codex 沙箱。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSpawnArgs {
    /// 命令 argv 向量（如 `["node", "server.js"]`，必填，不能为空）。
    pub command: Vec<String>,
    /// 客户端提供的进程句柄，用于后续的 writeStdin/kill/resizePty 调用（必填）。
    pub process_handle: String,
    /// 绝对工作目录（必填）。
    pub cwd: String,
    /// 是否启用 PTY 模式。启用后隐含 streamStdin 和 streamStdoutStderr。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tty: Option<bool>,
    /// 是否允许后续 `process/writeStdin` 写入 stdin。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_stdin: Option<bool>,
    /// 是否通过通知流式传输 stdout/stderr。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_stdout_stderr: Option<bool>,
}

/// `process/writeStdin` 命令的参数。
///
/// 向正在运行的 `process/spawn` 会话写入 stdin 数据或关闭 stdin。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProcessWriteStdinArgs {
    /// 客户端提供的进程句柄（必填）。
    pub process_handle: String,
    /// 要写入的 stdin 数据，base64 编码。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_base64: Option<String>,
    /// 写入后是否关闭 stdin。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_stdin: Option<bool>,
}

/// `process/kill` 命令的参数。
///
/// 终止指定进程句柄对应的运行中进程。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProcessKillArgs {
    /// 要终止的进程句柄（必填）。
    pub process_handle: String,
}

/// `process/resizePty` 命令的参数。
///
/// 调整 PTY 模式下运行中的进程终端大小。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResizePtyArgs {
    /// 要调整大小的进程句柄（必填）。
    pub process_handle: String,
    /// 终端行数（高度）。
    pub rows: u32,
    /// 终端列数（宽度）。
    pub cols: u32,
}

// =============================================================================
// 命令实现
// =============================================================================

/// 启动独立进程。
///
/// 调用 codex-rs 的 `process/spawn` 方法，在主机上启动一个独立进程。
/// 与 `command/exec` 不同，此命令不经过 Codex 沙箱。
///
/// # 参数
///
/// - `args` — 进程参数（argv 向量、进程句柄、工作目录等）
///
/// # 错误
///
/// - [`AppError::Validation`] — `command` 为空或 `processHandle`/`cwd` 为空
#[tauri::command]
#[specta::specta]
pub async fn process_spawn(args: ProcessSpawnArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.command.is_empty() {
        return Err(AppError::validation("command cannot be empty"));
    }
    if args.process_handle.trim().is_empty() {
        return Err(AppError::validation("process_handle cannot be empty"));
    }
    if args.cwd.trim().is_empty() {
        return Err(AppError::validation("cwd cannot be empty"));
    }

    let params = serde_json::json!({
        "command": args.command,
        "processHandle": args.process_handle,
        "cwd": args.cwd,
        "tty": args.tty,
        "streamStdin": args.stream_stdin,
        "streamStdoutStderr": args.stream_stdout_stderr,
    });

    let request = ClientRequest::ProcessSpawn {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ProcessSpawnParams: {e}"))
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
/// 调用 codex-rs 的 `process/writeStdin` 方法，向正在运行的
/// `process/spawn` 会话写入 base64 编码的 stdin 数据，或关闭 stdin。
///
/// # 参数
///
/// - `args` — 包含 `processHandle` 和可选的 `deltaBase64`、`closeStdin`
///
/// # 错误
///
/// - [`AppError::Validation`] — `processHandle` 为空
#[tauri::command]
#[specta::specta]
pub async fn process_write_stdin(args: ProcessWriteStdinArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.process_handle.trim().is_empty() {
        return Err(AppError::validation("process_handle cannot be empty"));
    }

    let params = serde_json::json!({
        "processHandle": args.process_handle,
        "deltaBase64": args.delta_base64,
        "closeStdin": args.close_stdin,
    });

    let request = ClientRequest::ProcessWriteStdin {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ProcessWriteStdinParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 终止运行中的进程。
///
/// 调用 codex-rs 的 `process/kill` 方法，终止指定进程句柄对应的
/// 运行中进程。
///
/// # 参数
///
/// - `args` — 包含 `processHandle`
///
/// # 错误
///
/// - [`AppError::Validation`] — `processHandle` 为空
#[tauri::command]
#[specta::specta]
pub async fn process_kill(args: ProcessKillArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.process_handle.trim().is_empty() {
        return Err(AppError::validation("process_handle cannot be empty"));
    }

    let params = serde_json::json!({
        "processHandle": args.process_handle,
    });

    let request = ClientRequest::ProcessKill {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ProcessKillParams: {e}"))
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
/// 调用 codex-rs 的 `process/resizePty` 方法，调整 PTY 模式下
/// 运行中的进程的终端大小。params 中的 `size` 字段是嵌套对象，
/// 包含 `rows` 和 `cols`。
///
/// # 参数
///
/// - `args` — 包含 `processHandle`、`rows` 和 `cols`
///
/// # 错误
///
/// - [`AppError::Validation`] — `processHandle` 为空或 `rows`/`cols` 为 0
#[tauri::command]
#[specta::specta]
pub async fn process_resize_pty(args: ProcessResizePtyArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.process_handle.trim().is_empty() {
        return Err(AppError::validation("process_handle cannot be empty"));
    }
    if args.rows == 0 || args.cols == 0 {
        return Err(AppError::validation("rows and cols must be greater than 0"));
    }

    // size 是嵌套的 ProcessTerminalSize { rows: u16, cols: u16 }
    let params = serde_json::json!({
        "processHandle": args.process_handle,
        "size": {
            "rows": args.rows,
            "cols": args.cols,
        },
    });

    let request = ClientRequest::ProcessResizePty {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ProcessResizePtyParams: {e}"))
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
    fn process_spawn_args_serializes_correctly() {
        let args = ProcessSpawnArgs {
            command: vec!["node".to_string(), "server.js".to_string()],
            process_handle: "handle-1".to_string(),
            cwd: "/home/user/project".to_string(),
            tty: Some(true),
            stream_stdin: None,
            stream_stdout_stderr: None,
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["command"][0], "node");
        assert_eq!(json["command"][1], "server.js");
        assert_eq!(json["processHandle"], "handle-1");
        assert_eq!(json["cwd"], "/home/user/project");
        assert_eq!(json["tty"], true);
    }

    #[test]
    fn process_spawn_args_omits_optional_fields() {
        let args = ProcessSpawnArgs {
            command: vec!["echo".to_string()],
            process_handle: "handle-2".to_string(),
            cwd: "/tmp".to_string(),
            tty: None,
            stream_stdin: None,
            stream_stdout_stderr: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert!(!json.contains("tty"));
        assert!(!json.contains("streamStdin"));
    }

    #[test]
    fn process_write_stdin_args_deserializes_from_camel_case() {
        let json = serde_json::json!({
            "processHandle": "handle-3",
            "deltaBase64": "aGVsbG8=",
            "closeStdin": true
        });
        let args: ProcessWriteStdinArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.process_handle, "handle-3");
        assert_eq!(args.delta_base64, Some("aGVsbG8=".to_string()));
        assert_eq!(args.close_stdin, Some(true));
    }

    #[test]
    fn process_kill_args_serializes_correctly() {
        let args = ProcessKillArgs {
            process_handle: "handle-4".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["processHandle"], "handle-4");
    }

    #[test]
    fn process_resize_pty_args_serializes_correctly() {
        let args = ProcessResizePtyArgs {
            process_handle: "handle-5".to_string(),
            rows: 30,
            cols: 120,
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["processHandle"], "handle-5");
        assert_eq!(json["rows"], 30);
        assert_eq!(json["cols"], 120);
    }

    #[test]
    fn sequencer_produces_unique_ids_across_calls() {
        let seq = RequestIdSequencer::new();
        let id1 = seq.next_id();
        let id2 = seq.next_id();
        assert_ne!(id1, id2);
    }
}
