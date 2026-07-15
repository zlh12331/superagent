//! Personal Access Token (PAT) 认证。
//!
//! PAT 是以 `at-` 为前缀的字符串，可通过 `/whoami` 端点获取关联的
//! ChatGPT 账户元数据（account_id、plan_type 等）。
//!
//! 主要导出：
//! - [`PersonalAccessTokenAuth`]：PAT 认证信息（含 token 与元数据）。

use codex_client::CodexHttpClient;
use codex_protocol::account::PlanType as AccountPlanType;
use codex_protocol::auth::PlanType as InternalPlanType;
use serde::Deserialize;
use std::env;
use std::fmt;

use crate::default_client::create_default_auth_client;
use crate::outbound_proxy::AuthRouteConfig;

/// 生产环境 AuthAPI 基础 URL。
const PROD_AUTHAPI_BASE_URL: &str = "https://auth.openai.com/api/accounts";
/// 覆盖 AuthAPI 基础 URL 的环境变量名。
const CODEX_AUTHAPI_BASE_URL_ENV_VAR: &str = "CODEX_AUTHAPI_BASE_URL";
/// whoami 端点路径。
const WHOAMI_PATH: &str = "/v1/user-auth-credential/whoami";

/// 从 `/whoami` 端点返回的 PAT 关联元数据。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct PersonalAccessTokenMetadata {
    /// 用户邮箱（如果可用）。
    email: Option<String>,
    /// ChatGPT 用户 ID。
    chatgpt_user_id: String,
    /// ChatGPT 工作区（account）ID。
    chatgpt_account_id: String,
    /// ChatGPT 订阅计划类型原始字符串。
    chatgpt_plan_type: String,
    /// 是否为 FedRAMP 账户。
    chatgpt_account_is_fedramp: bool,
}

/// Personal Access Token 认证信息。
///
/// 包含 token 字符串与从 `/whoami` 端点获取的账户元数据。
/// Debug 实现会遮蔽 token 以避免泄露到日志。
#[derive(Clone, PartialEq, Eq)]
pub struct PersonalAccessTokenAuth {
    /// PAT 字符串（以 `at-` 为前缀）。
    access_token: String,
    /// 从 `/whoami` 端点获取的账户元数据。
    metadata: PersonalAccessTokenMetadata,
}

impl fmt::Debug for PersonalAccessTokenAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PersonalAccessTokenAuth")
            .field("access_token", &"<redacted>")
            .field("metadata", &self.metadata)
            .finish()
    }
}

impl PersonalAccessTokenAuth {
    /// 加载 PAT 认证信息。
    ///
    /// 向 `/whoami` 端点发送带 bearer token 的请求，获取账户元数据。
    ///
    /// 参数：
    /// - `access_token`：PAT 字符串。
    /// - `auth_route_config`：认证层代理路由配置（可选）。
    pub(super) async fn load(
        access_token: &str,
        auth_route_config: Option<&AuthRouteConfig>,
    ) -> std::io::Result<Self> {
        let authapi_base_url = env::var(CODEX_AUTHAPI_BASE_URL_ENV_VAR)
            .ok()
            .map(|base_url| base_url.trim().trim_end_matches('/').to_string())
            .filter(|base_url| !base_url.is_empty())
            .unwrap_or_else(|| PROD_AUTHAPI_BASE_URL.to_string());
        let endpoint = whoami_endpoint(&authapi_base_url);
        let client = create_default_auth_client(&endpoint, auth_route_config)?;
        hydrate_personal_access_token(&client, &endpoint, access_token).await
    }

    /// 返回 access token 字符串。
    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    /// 返回 ChatGPT 工作区（account）ID。
    pub fn account_id(&self) -> &str {
        &self.metadata.chatgpt_account_id
    }

    /// 返回 ChatGPT 用户 ID。
    pub fn chatgpt_user_id(&self) -> &str {
        &self.metadata.chatgpt_user_id
    }

    /// 返回用户邮箱（如果可用）。
    pub fn email(&self) -> Option<&str> {
        self.metadata.email.as_deref()
    }

    /// 返回账户的订阅计划类型。
    pub fn plan_type(&self) -> AccountPlanType {
        InternalPlanType::from_raw_value(&self.metadata.chatgpt_plan_type).into()
    }

    /// 判断是否为 FedRAMP 账户。
    pub fn is_fedramp_account(&self) -> bool {
        self.metadata.chatgpt_account_is_fedramp
    }
}

/// 通过 `/whoami` 端点获取 PAT 关联的账户元数据。
///
/// 参数：
/// - `client`：HTTP 客户端。
/// - `endpoint`：whoami 端点完整 URL。
/// - `access_token`：PAT 字符串。
async fn hydrate_personal_access_token(
    client: &CodexHttpClient,
    endpoint: &str,
    access_token: &str,
) -> std::io::Result<PersonalAccessTokenAuth> {
    let response = client
        .get(endpoint)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|err| {
            std::io::Error::other(format!(
                "failed to request personal access token metadata: {err}"
            ))
        })?;
    if !response.status().is_success() {
        return Err(std::io::Error::other(format!(
            "personal access token metadata request failed with status {}",
            response.status()
        )));
    }

    let metadata = response
        .json::<PersonalAccessTokenMetadata>()
        .await
        .map_err(|err| {
            std::io::Error::other(format!(
                "failed to decode personal access token metadata: {err}"
            ))
        })?;
    Ok(PersonalAccessTokenAuth {
        access_token: access_token.to_string(),
        metadata,
    })
}

/// 拼接 whoami 端点完整 URL。
fn whoami_endpoint(authapi_base_url: &str) -> String {
    format!("{}{WHOAMI_PATH}", authapi_base_url.trim_end_matches('/'))
}

#[cfg(test)]
#[path = "personal_access_token_tests.rs"]
mod tests;
