//! 登出时使用的 OAuth token 撤销（best-effort）。
//!
//! 托管式 ChatGPT 认证会将 OAuth token 存储在本地。
//! 登出时尝试撤销 refresh token（若不存在则退而撤销 access token），
//! 即使撤销请求失败，调用方仍会删除本地凭证。

use serde::Serialize;
use std::time::Duration;

use codex_client::CodexHttpClient;
use codex_protocol::auth::AuthMode;

use super::manager::REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR;
use super::manager::REVOKE_TOKEN_URL;
use super::manager::REVOKE_TOKEN_URL_OVERRIDE_ENV_VAR;
use super::manager::oauth_client_id;
use super::storage::AuthDotJson;
use super::util::try_parse_error_message;
use crate::default_client::create_default_auth_client;
use crate::outbound_proxy::AuthRouteConfig;
use crate::token_data::TokenData;

/// 撤销请求的 HTTP 超时时间。
const REVOKE_HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// 待撤销 token 的类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RevokeTokenKind {
    /// 访问令牌。
    Access,
    /// 刷新令牌。
    Refresh,
}

impl RevokeTokenKind {
    /// 返回 token 类型提示字符串（用于 token_type_hint 字段）。
    fn as_str(self) -> &'static str {
        match self {
            Self::Access => "access_token",
            Self::Refresh => "refresh_token",
        }
    }

    /// 返回需要附带的 client_id（仅撤销 refresh token 时需要）。
    fn client_id(self) -> Option<String> {
        match self {
            Self::Access => None,
            Self::Refresh => Some(oauth_client_id()),
        }
    }
}

/// 撤销 token 请求的请求体。
#[derive(Serialize)]
struct RevokeTokenRequest<'a> {
    /// 待撤销的 token 字符串。
    token: &'a str,
    /// token 类型提示。
    token_type_hint: &'static str,
    /// OAuth 客户端 ID（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
}

/// 撤销认证 token。
///
/// 从 `auth.json` 中提取可撤销的 token（优先 refresh token，退而 access token），
/// 向撤销端点发送 POST 请求。若无可撤销 token，直接返回 `Ok(())`。
///
/// 参数：
/// - `auth_dot_json`：本地存储的认证信息（可选）。
/// - `auth_route_config`：认证层代理路由配置（可选）。
pub(super) async fn revoke_auth_tokens(
    auth_dot_json: Option<&AuthDotJson>,
    auth_route_config: Option<&AuthRouteConfig>,
) -> Result<(), std::io::Error> {
    let Some((token, kind)) = auth_dot_json.and_then(revocable_token) else {
        return Ok(());
    };

    let endpoint = revoke_token_endpoint();
    let client = create_default_auth_client(&endpoint, auth_route_config)?;
    revoke_oauth_token(&client, endpoint.as_str(), token, kind, REVOKE_HTTP_TIMEOUT).await
}

/// 从 `auth.json` 中提取可撤销的 token。
///
/// 优先返回 refresh token；若 refresh token 为空则返回 access token。
fn revocable_token(auth_dot_json: &AuthDotJson) -> Option<(&str, RevokeTokenKind)> {
    let tokens = managed_chatgpt_tokens(auth_dot_json)?;
    if !tokens.refresh_token.is_empty() {
        Some((tokens.refresh_token.as_str(), RevokeTokenKind::Refresh))
    } else if !tokens.access_token.is_empty() {
        Some((tokens.access_token.as_str(), RevokeTokenKind::Access))
    } else {
        None
    }
}

/// 返回托管式 ChatGPT 认证的 token 数据（仅当 auth_mode 为 Chatgpt 时）。
fn managed_chatgpt_tokens(auth_dot_json: &AuthDotJson) -> Option<&TokenData> {
    if resolved_auth_mode(auth_dot_json) == AuthMode::Chatgpt {
        auth_dot_json.tokens.as_ref()
    } else {
        None
    }
}

/// 解析 `auth.json` 中的有效认证模式。
///
/// 若显式声明了 auth_mode 则直接使用；否则根据字段是否存在推断
/// （有 OPENAI_API_KEY 视为 ApiKey，否则视为 Chatgpt）。
fn resolved_auth_mode(auth_dot_json: &AuthDotJson) -> AuthMode {
    if let Some(mode) = auth_dot_json.auth_mode {
        return mode;
    }
    if auth_dot_json.openai_api_key.is_some() {
        return AuthMode::ApiKey;
    }
    AuthMode::Chatgpt
}

/// 向撤销端点发送 POST 请求撤销指定 token。
///
/// 参数：
/// - `client`：HTTP 客户端。
/// - `endpoint`：撤销端点完整 URL。
/// - `token`：待撤销的 token。
/// - `kind`：token 类型（access / refresh）。
/// - `timeout`：请求超时时间。
async fn revoke_oauth_token(
    client: &CodexHttpClient,
    endpoint: &str,
    token: &str,
    kind: RevokeTokenKind,
    timeout: Duration,
) -> Result<(), std::io::Error> {
    let request = RevokeTokenRequest {
        token,
        token_type_hint: kind.as_str(),
        client_id: kind.client_id(),
    };

    let response = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .timeout(timeout)
        .json(&request)
        .send()
        .await
        .map_err(std::io::Error::other)?;

    let status = response.status();
    if status.is_success() {
        return Ok(());
    }

    let body = response.text().await.unwrap_or_default();
    let message = try_parse_error_message(&body);
    Err(std::io::Error::other(format!(
        "failed to revoke {}: {}: {}",
        kind.as_str(),
        status,
        message
    )))
}

/// 解析撤销端点 URL。
///
/// 优先级：
/// 1. `CODEX_REVOKE_TOKEN_URL_OVERRIDE` 环境变量。
/// 2. 从 `CODEX_REFRESH_TOKEN_URL_OVERRIDE` 推导（替换路径为 `/oauth/revoke`）。
/// 3. 默认 `REVOKE_TOKEN_URL`。
fn revoke_token_endpoint() -> String {
    if let Ok(endpoint) = std::env::var(REVOKE_TOKEN_URL_OVERRIDE_ENV_VAR) {
        return endpoint;
    }

    if let Ok(refresh_endpoint) = std::env::var(REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR)
        && let Some(endpoint) = derive_revoke_token_endpoint(&refresh_endpoint)
    {
        return endpoint;
    }

    REVOKE_TOKEN_URL.to_string()
}

/// 从 refresh token 端点 URL 推导撤销端点 URL。
///
/// 保留 scheme 与 host，将路径替换为 `/oauth/revoke`，清除 query。
fn derive_revoke_token_endpoint(refresh_endpoint: &str) -> Option<String> {
    let mut url = url::Url::parse(refresh_endpoint).ok()?;
    url.set_path("/oauth/revoke");
    url.set_query(None);
    Some(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_test_support::skip_if_no_network;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::method;
    use wiremock::matchers::path;

    #[test]
    fn derives_revoke_url_from_refresh_token_override() {
        assert_eq!(
            derive_revoke_token_endpoint("http://127.0.0.1:1234/oauth/token?unified=true"),
            Some("http://127.0.0.1:1234/oauth/revoke".to_string())
        );
    }

    #[tokio::test]
    async fn revoke_request_times_out() {
        skip_if_no_network!();

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/revoke"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(60)))
            .mount(&server)
            .await;

        let client = CodexHttpClient::new(reqwest::Client::new());
        let endpoint = format!("{}/oauth/revoke", server.uri());
        let error = revoke_oauth_token(
            &client,
            endpoint.as_str(),
            "refresh-token",
            RevokeTokenKind::Refresh,
            Duration::from_millis(20),
        )
        .await
        .expect_err("stalled revoke request should time out");

        let reqwest_error = error
            .get_ref()
            .and_then(|error| error.downcast_ref::<reqwest::Error>())
            .expect("timeout error should preserve reqwest error");
        assert!(reqwest_error.is_timeout());
    }
}
