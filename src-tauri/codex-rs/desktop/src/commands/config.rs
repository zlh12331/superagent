//! Config 域 Tauri 命令。
//!
//! 提供配置管理能力：读取配置、写入单个配置项、批量写入配置。
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

/// `config/read` 命令的参数。
///
/// 读取当前生效的配置，可选是否包含各配置层详情和工作目录上下文。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReadArgs {
    /// 是否包含各配置层（layers）详情。默认 false。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_layers: Option<bool>,
    /// 工作目录，用于解析项目配置层。为空时使用服务器默认值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// `config/value/write` 命令的参数。
///
/// 写入单个配置项到指定文件（默认为用户 config.toml）。
///
/// `value` 为 JSON 值的字符串表示，由前端 `JSON.stringify` 后传入。
/// 使用 `String` 而非 `serde_json::Value` 是为了规避 specta BigInt 禁令。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigValueWriteArgs {
    /// 配置键路径（如 `"model"`、`"tools.webSearch"`，必填）。
    pub key_path: String,
    /// 配置值的 JSON 字符串（前端 `JSON.stringify` 后传入）。
    pub value: String,
    /// 合并策略：`"replace"` 或 `"upsert"`（必填）。
    pub merge_strategy: String,
    /// 目标配置文件路径。为空时写入用户默认 config.toml。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

/// `config/batchWrite` 命令的参数。
///
/// 批量写入多个配置项到指定文件。
///
/// `edits` 为 `Vec<ConfigEdit>` 的 JSON 字符串，由前端 `JSON.stringify` 后传入。
/// 使用 `String` 而非 `serde_json::Value` 是为了规避 specta BigInt 禁令。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBatchWriteArgs {
    /// 批量编辑列表的 JSON 字符串（前端 `JSON.stringify` 后传入，是 `Vec<ConfigEdit>` 数组）。
    pub edits: String,
    /// 目标配置文件路径。为空时写入用户默认 config.toml。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

// =============================================================================
// 命令实现
// =============================================================================

/// 读取配置。
///
/// 调用 codex-rs 的 `config/read` 方法，返回当前生效的配置和来源信息。
///
/// # 参数
///
/// - `args` — 包含可选的 `includeLayers` 和 `cwd`
#[tauri::command]
#[specta::specta]
pub async fn config_read(args: ConfigReadArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    let params = serde_json::json!({
        "includeLayers": args.include_layers,
        "cwd": args.cwd,
    });

    let request = ClientRequest::ConfigRead {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ConfigReadParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 写入单个配置项。
///
/// 调用 codex-rs 的 `config/value/write` 方法，将指定键路径的值写入
/// 配置文件。
///
/// # 参数
///
/// - `args` — 包含 `keyPath`、`value`、`mergeStrategy` 和可选的 `filePath`
///
/// # 错误
///
/// - [`AppError::Validation`] — `keyPath` 为空或 `mergeStrategy` 无效
#[tauri::command]
#[specta::specta]
pub async fn config_value_write(args: ConfigValueWriteArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.key_path.trim().is_empty() {
        return Err(AppError::validation("key_path cannot be empty"));
    }
    // 验证合并策略
    match args.merge_strategy.as_str() {
        "replace" | "upsert" => {}
        other => {
            return Err(AppError::validation(format!(
                "invalid merge_strategy: {other}, expected 'replace' or 'upsert'"
            )));
        }
    }

    // 解析 value JSON 字符串为 serde_json::Value
    let value: serde_json::Value = serde_json::from_str(&args.value)
        .map_err(|e| AppError::validation(format!("invalid value JSON: {e}")))?;

    let params = serde_json::json!({
        "keyPath": args.key_path,
        "value": value,
        "mergeStrategy": args.merge_strategy,
        "filePath": args.file_path,
    });

    let request = ClientRequest::ConfigValueWrite {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ConfigValueWriteParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 批量写入配置项。
///
/// 调用 codex-rs 的 `config/batchWrite` 方法，一次性写入多个配置编辑。
///
/// # 参数
///
/// - `args` — 包含 `edits`（JSON 数组）和可选的 `filePath`
///
/// # 错误
///
/// - [`AppError::Validation`] — `edits` 不是数组
#[tauri::command]
#[specta::specta]
pub async fn config_batch_write(args: ConfigBatchWriteArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    // 解析 edits JSON 字符串为 serde_json::Value 并验证是数组
    let edits: serde_json::Value = serde_json::from_str(&args.edits)
        .map_err(|e| AppError::validation(format!("invalid edits JSON: {e}")))?;
    if !edits.is_array() {
        return Err(AppError::validation("edits must be a JSON array"));
    }

    let params = serde_json::json!({
        "edits": edits,
        "filePath": args.file_path,
    });

    let request = ClientRequest::ConfigBatchWrite {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ConfigBatchWriteParams: {e}"))
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
    fn config_read_args_omits_optional_fields() {
        let args = ConfigReadArgs {
            include_layers: None,
            cwd: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert_eq!(json, "{}");
    }

    #[test]
    fn config_read_args_serializes_correctly() {
        let args = ConfigReadArgs {
            include_layers: Some(true),
            cwd: Some("/home/user/project".to_string()),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["includeLayers"], true);
        assert_eq!(json["cwd"], "/home/user/project");
    }

    #[test]
    fn config_value_write_args_serializes_correctly() {
        let args = ConfigValueWriteArgs {
            key_path: "model".to_string(),
            value: r#""gpt-4o""#.to_string(),
            merge_strategy: "replace".to_string(),
            file_path: Some("/home/user/config.toml".to_string()),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["keyPath"], "model");
        assert_eq!(json["value"], "\"gpt-4o\"");
        assert_eq!(json["mergeStrategy"], "replace");
        assert_eq!(json["filePath"], "/home/user/config.toml");
    }

    #[test]
    fn config_value_write_args_omits_optional_file_path() {
        let args = ConfigValueWriteArgs {
            key_path: "model".to_string(),
            value: r#""gpt-4o""#.to_string(),
            merge_strategy: "upsert".to_string(),
            file_path: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert!(!json.contains("filePath"));
    }

    #[test]
    fn config_batch_write_args_deserializes_from_camel_case() {
        let json = serde_json::json!({
            "edits": "[{\"keyPath\":\"model\",\"value\":\"gpt-4o\",\"mergeStrategy\":\"replace\"}]",
            "filePath": "/home/user/config.toml"
        });
        let args: ConfigBatchWriteArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.file_path, Some("/home/user/config.toml".to_string()));
    }

    #[test]
    fn sequencer_produces_unique_ids_across_calls() {
        let seq = RequestIdSequencer::new();
        let id1 = seq.next_id();
        let id2 = seq.next_id();
        assert_ne!(id1, id2);
    }
}
