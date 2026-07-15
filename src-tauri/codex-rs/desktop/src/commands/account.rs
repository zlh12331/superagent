//! Account 域 Tauri 命令。
//!
//! 提供账户认证管理能力：登录、取消登录、登出、获取账户信息。
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
//! `LoginAccountParams` 是一个 tagged union（`#[serde(tag = "type")]`），
//! 因此在构造 JSON params 时需要根据 `login_type` 字段构造对应的
//! tagged union 结构。
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

/// `account/login/start` 命令的参数。
///
/// 支持三种登录方式：
/// - `"apiKey"` — 使用 API Key 登录（需提供 `apiKey`）
/// - `"chatgpt"` — 使用 ChatGPT OAuth 登录
/// - `"chatgptDeviceCode"` — 使用 ChatGPT 设备码登录
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoginAccountArgs {
    /// 登录类型：`"apiKey"`、`"chatgpt"` 或 `"chatgptDeviceCode"`（必填）。
    pub login_type: String,
    /// API Key（仅 `login_type = "apiKey"` 时需要）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// `account/login/cancel` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelLoginAccountArgs {
    /// 要取消的登录会话 ID（必填）。
    pub login_id: String,
}

/// `account/logout` 命令的参数（无字段）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogoutAccountArgs {}

/// `account/read` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GetAccountArgs {
    /// 是否在返回前主动刷新令牌。默认 false。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<bool>,
}

// =============================================================================
// 命令实现
// =============================================================================

/// 启动账户登录流程。
///
/// 调用 codex-rs 的 `account/login/start` 方法，根据登录类型启动
/// 不同的认证流程。`LoginAccountParams` 是一个 tagged union，
/// 我们根据 `login_type` 构造对应的 JSON 结构。
///
/// # 参数
///
/// - `args` — 包含 `loginType` 和可选的 `apiKey`
///
/// # 返回
///
/// - `apiKey` 类型：返回空响应
/// - `chatgpt` 类型：返回 `loginId` 和 `authUrl`
/// - `chatgptDeviceCode` 类型：返回 `loginId`、`verificationUrl` 和 `userCode`
///
/// # 错误
///
/// - [`AppError::Validation`] — `loginType` 无效或 `apiKey` 缺失
#[tauri::command]
#[specta::specta]
pub async fn login_account(args: LoginAccountArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    // 根据 login_type 构造 tagged union JSON
    // LoginAccountParams 使用 #[serde(tag = "type")]，因此 JSON 需要 "type" 字段
    let params = match args.login_type.as_str() {
        "apiKey" => {
            // apiKey 类型需要提供 apiKey 字段
            let api_key = args.api_key.ok_or_else(|| {
                AppError::validation("api_key is required when login_type is 'apiKey'")
            })?;
            serde_json::json!({
                "type": "apiKey",
                "apiKey": api_key,
            })
        }
        "chatgpt" => {
            // chatgpt 类型使用 OAuth 浏览器登录
            serde_json::json!({
                "type": "chatgpt",
            })
        }
        "chatgptDeviceCode" => {
            // chatgptDeviceCode 类型使用设备码登录
            serde_json::json!({
                "type": "chatgptDeviceCode",
            })
        }
        other => {
            return Err(AppError::validation(format!(
                "invalid login_type: {other}, expected 'apiKey', 'chatgpt', or 'chatgptDeviceCode'"
            )));
        }
    };

    let request = ClientRequest::LoginAccount {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct LoginAccountParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 取消正在进行的登录流程。
///
/// 调用 codex-rs 的 `account/login/cancel` 方法，取消之前通过
/// `login_account` 启动的登录会话。
///
/// # 参数
///
/// - `args` — 包含 `loginId`
///
/// # 错误
///
/// - [`AppError::Validation`] — `loginId` 为空
#[tauri::command]
#[specta::specta]
pub async fn cancel_login_account(args: CancelLoginAccountArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.login_id.trim().is_empty() {
        return Err(AppError::validation("login_id cannot be empty"));
    }

    let params = serde_json::json!({
        "loginId": args.login_id,
    });

    let request = ClientRequest::CancelLoginAccount {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct CancelLoginAccountParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 登出当前账户。
///
/// 调用 codex-rs 的 `account/logout` 方法，清除当前会话的认证状态。
///
/// # 参数
///
/// - `_args` — 无参数（空结构体）
#[tauri::command]
#[specta::specta]
pub async fn logout_account(_args: LogoutAccountArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    // params 类型为 Option<()>，使用 Null 表示无参数
    let params: Option<()> = serde_json::from_value(serde_json::Value::Null).map_err(|e| {
        AppError::validation(format!("failed to construct LogoutAccountParams: {e}"))
    })?;

    let request = ClientRequest::LogoutAccount {
        request_id: state::sequencer().next_id(),
        params,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 获取当前账户信息。
///
/// 调用 codex-rs 的 `account/read` 方法，返回当前登录的账户状态
/// 和是否需要 OpenAI 认证。
///
/// # 参数
///
/// - `args` — 包含可选的 `refreshToken`
#[tauri::command]
#[specta::specta]
pub async fn get_account(args: GetAccountArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    let params = serde_json::json!({
        "refreshToken": args.refresh_token.unwrap_or(false),
    });

    let request = ClientRequest::GetAccount {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct GetAccountParams: {e}"))
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
    fn login_account_args_api_key_type_serializes_correctly() {
        let args = LoginAccountArgs {
            login_type: "apiKey".to_string(),
            api_key: Some("sk-xxx".to_string()),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["loginType"], "apiKey");
        assert_eq!(json["apiKey"], "sk-xxx");
    }

    #[test]
    fn login_account_args_chatgpt_type_omits_api_key() {
        let args = LoginAccountArgs {
            login_type: "chatgpt".to_string(),
            api_key: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert!(!json.contains("apiKey"));
    }

    #[test]
    fn login_account_args_device_code_type_serializes_correctly() {
        let args = LoginAccountArgs {
            login_type: "chatgptDeviceCode".to_string(),
            api_key: None,
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["loginType"], "chatgptDeviceCode");
    }

    #[test]
    fn cancel_login_account_args_deserializes_from_camel_case() {
        let json = serde_json::json!({
            "loginId": "login-001"
        });
        let args: CancelLoginAccountArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.login_id, "login-001");
    }

    #[test]
    fn logout_account_args_is_empty_struct() {
        let args = LogoutAccountArgs {};
        let json = serde_json::to_string(&args).unwrap();
        assert_eq!(json, "{}");
    }

    #[test]
    fn get_account_args_omits_optional_refresh_token() {
        let args = GetAccountArgs {
            refresh_token: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert!(!json.contains("refreshToken"));
    }

    #[test]
    fn get_account_args_with_refresh_token_serializes_correctly() {
        let args = GetAccountArgs {
            refresh_token: Some(true),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["refreshToken"], true);
    }

    #[test]
    fn sequencer_produces_unique_ids_across_calls() {
        let seq = RequestIdSequencer::new();
        let id1 = seq.next_id();
        let id2 = seq.next_id();
        assert_ne!(id1, id2);
    }
}
