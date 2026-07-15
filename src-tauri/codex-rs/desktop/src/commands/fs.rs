//! 文件系统（fs）域 Tauri 命令。
//!
//! 提供对主机文件系统的操作能力：读写文件、创建目录、获取元数据、
//! 列目录、删除、复制、监听变更等。
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

/// `fs/readFile` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsReadFileArgs {
    /// 要读取的文件绝对路径（必填）。
    pub path: String,
}

/// `fs/writeFile` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteFileArgs {
    /// 要写入的文件绝对路径（必填）。
    pub path: String,
    /// 文件内容，base64 编码（必填）。
    pub data_base64: String,
}

/// `fs/createDirectory` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsCreateDirectoryArgs {
    /// 要创建的目录绝对路径（必填）。
    pub path: String,
    /// 是否递归创建父目录。默认 true。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
}

/// `fs/getMetadata` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsGetMetadataArgs {
    /// 要查询元数据的路径（必填）。
    pub path: String,
}

/// `fs/readDirectory` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsReadDirectoryArgs {
    /// 要列出的目录绝对路径（必填）。
    pub path: String,
}

/// `fs/remove` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsRemoveArgs {
    /// 要删除的路径（必填）。
    pub path: String,
    /// 是否递归删除目录。默认 true。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
    /// 路径不存在时是否忽略。默认 true。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

/// `fs/copy` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsCopyArgs {
    /// 源文件绝对路径（必填）。
    pub source_path: String,
    /// 目标文件绝对路径（必填）。
    pub destination_path: String,
    /// 复制目录时是否递归。默认 false。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
}

/// `fs/watch` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsWatchArgs {
    /// 连接作用域内的监听标识符，用于后续的 `fs/unwatch`（必填）。
    pub watch_id: String,
    /// 要监听的文件或目录绝对路径（必填）。
    pub path: String,
}

/// `fs/unwatch` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsUnwatchArgs {
    /// 之前通过 `fs/watch` 注册的监听标识符（必填）。
    pub watch_id: String,
}

// =============================================================================
// 命令实现
// =============================================================================

/// 读取文件内容。
///
/// 调用 codex-rs 的 `fs/readFile` 方法，返回 base64 编码的文件内容。
///
/// # 参数
///
/// - `args` — 包含 `path`
///
/// # 错误
///
/// - [`AppError::Validation`] — `path` 为空
#[tauri::command]
#[specta::specta]
pub async fn fs_read_file(args: FsReadFileArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.path.trim().is_empty() {
        return Err(AppError::validation("path cannot be empty"));
    }

    let params = serde_json::json!({
        "path": args.path,
    });

    let request = ClientRequest::FsReadFile {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct FsReadFileParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 写入文件内容。
///
/// 调用 codex-rs 的 `fs/writeFile` 方法，将 base64 编码的数据写入指定路径。
///
/// # 参数
///
/// - `args` — 包含 `path` 和 `dataBase64`
///
/// # 错误
///
/// - [`AppError::Validation`] — `path` 为空
#[tauri::command]
#[specta::specta]
pub async fn fs_write_file(args: FsWriteFileArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.path.trim().is_empty() {
        return Err(AppError::validation("path cannot be empty"));
    }

    let params = serde_json::json!({
        "path": args.path,
        "dataBase64": args.data_base64,
    });

    let request = ClientRequest::FsWriteFile {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct FsWriteFileParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 创建目录。
///
/// 调用 codex-rs 的 `fs/createDirectory` 方法，可选是否递归创建父目录。
///
/// # 参数
///
/// - `args` — 包含 `path` 和可选的 `recursive`
///
/// # 错误
///
/// - [`AppError::Validation`] — `path` 为空
#[tauri::command]
#[specta::specta]
pub async fn fs_create_directory(args: FsCreateDirectoryArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.path.trim().is_empty() {
        return Err(AppError::validation("path cannot be empty"));
    }

    let params = serde_json::json!({
        "path": args.path,
        "recursive": args.recursive,
    });

    let request = ClientRequest::FsCreateDirectory {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct FsCreateDirectoryParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 获取文件或目录的元数据。
///
/// 调用 codex-rs 的 `fs/getMetadata` 方法，返回是否为目录/文件/符号链接
/// 以及创建和修改时间。
///
/// # 参数
///
/// - `args` — 包含 `path`
///
/// # 错误
///
/// - [`AppError::Validation`] — `path` 为空
#[tauri::command]
#[specta::specta]
pub async fn fs_get_metadata(args: FsGetMetadataArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.path.trim().is_empty() {
        return Err(AppError::validation("path cannot be empty"));
    }

    let params = serde_json::json!({
        "path": args.path,
    });

    let request = ClientRequest::FsGetMetadata {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct FsGetMetadataParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 列出目录内容。
///
/// 调用 codex-rs 的 `fs/readDirectory` 方法，返回直接子条目列表。
///
/// # 参数
///
/// - `args` — 包含 `path`
///
/// # 错误
///
/// - [`AppError::Validation`] — `path` 为空
#[tauri::command]
#[specta::specta]
pub async fn fs_read_directory(args: FsReadDirectoryArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.path.trim().is_empty() {
        return Err(AppError::validation("path cannot be empty"));
    }

    let params = serde_json::json!({
        "path": args.path,
    });

    let request = ClientRequest::FsReadDirectory {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct FsReadDirectoryParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 删除文件或目录。
///
/// 调用 codex-rs 的 `fs/remove` 方法，可选是否递归删除和强制删除。
///
/// # 参数
///
/// - `args` — 包含 `path` 和可选的 `recursive`、`force`
///
/// # 错误
///
/// - [`AppError::Validation`] — `path` 为空
#[tauri::command]
#[specta::specta]
pub async fn fs_remove(args: FsRemoveArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.path.trim().is_empty() {
        return Err(AppError::validation("path cannot be empty"));
    }

    let params = serde_json::json!({
        "path": args.path,
        "recursive": args.recursive,
        "force": args.force,
    });

    let request = ClientRequest::FsRemove {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct FsRemoveParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 复制文件或目录。
///
/// 调用 codex-rs 的 `fs/copy` 方法，复制目录时需要设置 `recursive`。
///
/// # 参数
///
/// - `args` — 包含 `sourcePath`、`destinationPath` 和可选的 `recursive`
///
/// # 错误
///
/// - [`AppError::Validation`] — `sourcePath` 或 `destinationPath` 为空
#[tauri::command]
#[specta::specta]
pub async fn fs_copy(args: FsCopyArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.source_path.trim().is_empty() {
        return Err(AppError::validation("source_path cannot be empty"));
    }
    if args.destination_path.trim().is_empty() {
        return Err(AppError::validation("destination_path cannot be empty"));
    }

    let params = serde_json::json!({
        "sourcePath": args.source_path,
        "destinationPath": args.destination_path,
        "recursive": args.recursive,
    });

    let request = ClientRequest::FsCopy {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params)
            .map_err(|e| AppError::validation(format!("failed to construct FsCopyParams: {e}")))?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 开始监听文件系统变更。
///
/// 调用 codex-rs 的 `fs/watch` 方法，注册一个文件或目录的监听器。
/// 后续变更通过 `fs/changed` 通知推送。
///
/// # 参数
///
/// - `args` — 包含 `watchId` 和 `path`
///
/// # 错误
///
/// - [`AppError::Validation`] — `watchId` 或 `path` 为空
#[tauri::command]
#[specta::specta]
pub async fn fs_watch(args: FsWatchArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.watch_id.trim().is_empty() {
        return Err(AppError::validation("watch_id cannot be empty"));
    }
    if args.path.trim().is_empty() {
        return Err(AppError::validation("path cannot be empty"));
    }

    let params = serde_json::json!({
        "watchId": args.watch_id,
        "path": args.path,
    });

    let request = ClientRequest::FsWatch {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params)
            .map_err(|e| AppError::validation(format!("failed to construct FsWatchParams: {e}")))?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 停止监听文件系统变更。
///
/// 调用 codex-rs 的 `fs/unwatch` 方法，取消之前通过 `fs/watch` 注册的监听器。
///
/// # 参数
///
/// - `args` — 包含 `watchId`
///
/// # 错误
///
/// - [`AppError::Validation`] — `watchId` 为空
#[tauri::command]
#[specta::specta]
pub async fn fs_unwatch(args: FsUnwatchArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.watch_id.trim().is_empty() {
        return Err(AppError::validation("watch_id cannot be empty"));
    }

    let params = serde_json::json!({
        "watchId": args.watch_id,
    });

    let request = ClientRequest::FsUnwatch {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct FsUnwatchParams: {e}"))
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
    fn fs_read_file_args_serializes_correctly() {
        let args = FsReadFileArgs {
            path: "/home/user/file.txt".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["path"], "/home/user/file.txt");
    }

    #[test]
    fn fs_write_file_args_serializes_correctly() {
        let args = FsWriteFileArgs {
            path: "/home/user/out.txt".to_string(),
            data_base64: "aGVsbG8=".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["path"], "/home/user/out.txt");
        assert_eq!(json["dataBase64"], "aGVsbG8=");
    }

    #[test]
    fn fs_create_directory_args_omits_optional_recursive() {
        let args = FsCreateDirectoryArgs {
            path: "/home/user/newdir".to_string(),
            recursive: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert!(!json.contains("recursive"));
    }

    #[test]
    fn fs_remove_args_includes_all_optional_fields() {
        let args = FsRemoveArgs {
            path: "/home/user/gone".to_string(),
            recursive: Some(true),
            force: Some(false),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["recursive"], true);
        assert_eq!(json["force"], false);
    }

    #[test]
    fn fs_copy_args_serializes_correctly() {
        let args = FsCopyArgs {
            source_path: "/a/b".to_string(),
            destination_path: "/c/d".to_string(),
            recursive: Some(true),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["sourcePath"], "/a/b");
        assert_eq!(json["destinationPath"], "/c/d");
        assert_eq!(json["recursive"], true);
    }

    #[test]
    fn fs_watch_args_deserializes_from_camel_case() {
        let json = serde_json::json!({
            "watchId": "w-1",
            "path": "/home/user"
        });
        let args: FsWatchArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.watch_id, "w-1");
        assert_eq!(args.path, "/home/user");
    }

    #[test]
    fn fs_unwatch_args_serializes_correctly() {
        let args = FsUnwatchArgs {
            watch_id: "w-1".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["watchId"], "w-1");
    }

    #[test]
    fn sequencer_produces_unique_ids_across_calls() {
        let seq = RequestIdSequencer::new();
        let id1 = seq.next_id();
        let id2 = seq.next_id();
        assert_ne!(id1, id2);
    }
}
