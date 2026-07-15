//! Amazon Bedrock API Key 认证。
//!
//! 提供 [`BedrockApiKeyAuth`] 结构与 [`login_with_bedrock_api_key`] 登录函数，
//! 将 Bedrock API Key 持久化到 `auth.json`。

use std::path::Path;

use codex_config::types::AuthCredentialsStoreMode;
use serde::Deserialize;
use serde::Serialize;

use super::manager::save_auth;
use super::storage::AuthDotJson;
use super::storage::AuthKeyringBackendKind;
use codex_protocol::auth::AuthMode;

/// 持久化在 `auth.json` 中的 Amazon Bedrock API Key 凭证。
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
pub struct BedrockApiKeyAuth {
    /// Bedrock API Key 字符串。
    pub api_key: String,
    /// Bedrock 服务区域（如 `us-east-1`）。
    pub region: String,
}

/// 将仅包含 Bedrock API Key 的认证信息写入 `auth.json`。
///
/// 参数：
/// - `codex_home`：Codex 主目录路径。
/// - `api_key`：Bedrock API Key。
/// - `region`：Bedrock 服务区域。
/// - `auth_credentials_store_mode`：凭证存储模式（文件 / keyring / auto / ephemeral）。
/// - `keyring_backend_kind`：keyring 后端类型（Direct / Secrets）。
pub fn login_with_bedrock_api_key(
    codex_home: &Path,
    api_key: &str,
    region: &str,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<()> {
    let auth_dot_json = AuthDotJson {
        auth_mode: Some(AuthMode::BedrockApiKey),
        openai_api_key: None,
        tokens: None,
        last_refresh: None,
        agent_identity: None,
        personal_access_token: None,
        bedrock_api_key: Some(BedrockApiKeyAuth {
            api_key: api_key.to_string(),
            region: region.to_string(),
        }),
    };
    save_auth(
        codex_home,
        &auth_dot_json,
        auth_credentials_store_mode,
        keyring_backend_kind,
    )
}

#[cfg(test)]
#[path = "bedrock_api_key_tests.rs"]
mod tests;
