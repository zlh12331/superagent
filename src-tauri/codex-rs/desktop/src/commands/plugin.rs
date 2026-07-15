//! Plugin 域 Tauri 命令。
//!
//! 插件管理能力：列出插件、安装插件、卸载插件、读取插件详情。
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

/// `plugin/list` 命令的参数。
///
/// 列出可用的插件，可按工作目录和市场类型过滤。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginListArgs {
    /// 工作目录列表，用于发现仓库级市场。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwds: Option<Vec<String>>,
    /// 市场类型过滤（如 `"local"`、`"remote"`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_kinds: Option<Vec<String>>,
}

/// `plugin/install` 命令的参数。
///
/// 安装指定插件。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallArgs {
    /// 本地市场路径。与 `remoteMarketplaceName` 互斥。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_path: Option<String>,
    /// 远程市场名称。与 `marketplacePath` 互斥。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_marketplace_name: Option<String>,
    /// 要安装的插件名称（必填）。
    pub plugin_name: String,
}

/// `plugin/uninstall` 命令的参数。
///
/// 卸载指定插件。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginUninstallArgs {
    /// 要卸载的插件 ID（必填）。
    pub plugin_id: String,
}

/// `plugin/read` 命令的参数。
///
/// 读取指定插件的详细信息。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginReadArgs {
    /// 本地市场路径。与 `remoteMarketplaceName` 互斥。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_path: Option<String>,
    /// 远程市场名称。与 `marketplacePath` 互斥。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_marketplace_name: Option<String>,
    /// 要读取的插件名称（必填）。
    pub plugin_name: String,
}

// =============================================================================
// 命令实现
// =============================================================================

/// 列出可用插件。
///
/// 调用 codex-rs 的 `plugin/list` 方法，返回所有可用插件列表。
/// 可通过 `cwds` 和 `marketplaceKinds` 过滤。
///
/// # 参数
///
/// - `args` — 包含可选的 `cwds` 和 `marketplaceKinds`
#[tauri::command]
#[specta::specta]
pub async fn plugin_list(args: PluginListArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    let params = serde_json::json!({
        "cwds": args.cwds,
        "marketplaceKinds": args.marketplace_kinds,
    });

    let request = ClientRequest::PluginList {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct PluginListParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 安装插件。
///
/// 调用 codex-rs 的 `plugin/install` 方法，从指定市场安装插件。
/// `marketplacePath` 和 `remoteMarketplaceName` 二选一。
///
/// # 参数
///
/// - `args` — 包含 `pluginName` 和可选的 `marketplacePath` 或 `remoteMarketplaceName`
///
/// # 错误
///
/// - [`AppError::Validation`] — `pluginName` 为空
#[tauri::command]
#[specta::specta]
pub async fn plugin_install(args: PluginInstallArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.plugin_name.trim().is_empty() {
        return Err(AppError::validation("plugin_name cannot be empty"));
    }

    let params = serde_json::json!({
        "marketplacePath": args.marketplace_path,
        "remoteMarketplaceName": args.remote_marketplace_name,
        "pluginName": args.plugin_name,
    });

    let request = ClientRequest::PluginInstall {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct PluginInstallParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 卸载插件。
///
/// 调用 codex-rs 的 `plugin/uninstall` 方法，卸载指定 ID 的插件。
///
/// # 参数
///
/// - `args` — 包含 `pluginId`
///
/// # 错误
///
/// - [`AppError::Validation`] — `pluginId` 为空
#[tauri::command]
#[specta::specta]
pub async fn plugin_uninstall(args: PluginUninstallArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.plugin_id.trim().is_empty() {
        return Err(AppError::validation("plugin_id cannot be empty"));
    }

    let params = serde_json::json!({
        "pluginId": args.plugin_id,
    });

    let request = ClientRequest::PluginUninstall {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct PluginUninstallParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 读取插件详情。
///
/// 调用 codex-rs 的 `plugin/read` 方法，获取指定插件的详细信息。
///
/// # 参数
///
/// - `args` — 包含 `pluginName` 和可选的 `marketplacePath` 或 `remoteMarketplaceName`
///
/// # 错误
///
/// - [`AppError::Validation`] — `pluginName` 为空
#[tauri::command]
#[specta::specta]
pub async fn plugin_read(args: PluginReadArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.plugin_name.trim().is_empty() {
        return Err(AppError::validation("plugin_name cannot be empty"));
    }

    let params = serde_json::json!({
        "marketplacePath": args.marketplace_path,
        "remoteMarketplaceName": args.remote_marketplace_name,
        "pluginName": args.plugin_name,
    });

    let request = ClientRequest::PluginRead {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct PluginReadParams: {e}"))
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
    fn plugin_list_args_omits_optional_fields() {
        let args = PluginListArgs {
            cwds: None,
            marketplace_kinds: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert_eq!(json, "{}");
    }

    #[test]
    fn plugin_list_args_serializes_correctly() {
        let args = PluginListArgs {
            cwds: Some(vec!["/home/user/project".to_string()]),
            marketplace_kinds: Some(vec!["local".to_string()]),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["cwds"][0], "/home/user/project");
        assert_eq!(json["marketplaceKinds"][0], "local");
    }

    #[test]
    fn plugin_install_args_deserializes_from_camel_case() {
        let json = serde_json::json!({
            "marketplacePath": "/path/to/marketplace",
            "pluginName": "my-plugin"
        });
        let args: PluginInstallArgs = serde_json::from_value(json).unwrap();
        assert_eq!(
            args.marketplace_path,
            Some("/path/to/marketplace".to_string())
        );
        assert_eq!(args.plugin_name, "my-plugin");
    }

    #[test]
    fn plugin_install_args_with_remote_marketplace() {
        let args = PluginInstallArgs {
            marketplace_path: None,
            remote_marketplace_name: Some("official".to_string()),
            plugin_name: "my-plugin".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["remoteMarketplaceName"], "official");
        assert_eq!(json["pluginName"], "my-plugin");
    }

    #[test]
    fn plugin_uninstall_args_serializes_correctly() {
        let args = PluginUninstallArgs {
            plugin_id: "plugin-001".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["pluginId"], "plugin-001");
    }

    #[test]
    fn plugin_read_args_omits_optional_fields() {
        let args = PluginReadArgs {
            marketplace_path: None,
            remote_marketplace_name: None,
            plugin_name: "my-plugin".to_string(),
        };
        let json = serde_json::to_string(&args).unwrap();
        assert!(!json.contains("marketplacePath"));
        assert!(!json.contains("remoteMarketplaceName"));
    }

    #[test]
    fn sequencer_produces_unique_ids_across_calls() {
        let seq = RequestIdSequencer::new();
        let id1 = seq.next_id();
        let id2 = seq.next_id();
        assert_ne!(id1, id2);
    }
}
