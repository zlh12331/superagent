//! 认证管理器与多种认证凭据类型的定义。
//!
//! 本模块是 Codex CLI 登录系统的核心，统一管理 API key、ChatGPT OAuth、Agent Identity、
//! Personal Access Token、Bedrock API key 等多种认证方式。`AuthManager` 作为单一可信源，
//! 负责加载、缓存、刷新与撤销凭据，并通过 `watch::channel` 通知外部组件状态变更。
//!
//! 主要职责：
//! - 持久化与读取 `auth.json`（file / keyring / ephemeral 多后端）
//! - 在 401 Unauthorized 时按状态机策略进行恢复（reload → refresh token → external refresh）
//! - 对 ChatGPT 凭据执行 proactive refresh 与 permanent failure 缓存
//! - 对 Agent Identity bootstrap 失败做冷却去抖，避免短时间内反复尝试

use chrono::Utc;
use reqwest::StatusCode;
use serde::Deserialize;
use serde::Serialize;
#[cfg(test)]
use serial_test::serial;
use std::env;
use std::fmt::Debug;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Semaphore;
use tokio::sync::watch;
use tracing::instrument;

use codex_agent_identity::ChatGptEnvironment;
use codex_protocol::auth::AuthMode;
use codex_protocol::config_types::ForcedLoginMethod;
use codex_protocol::config_types::ModelProviderAuthInfo;

use super::access_token::CodexAccessToken;
use super::access_token::classify_codex_access_token;
use super::agent_identity::ManagedChatGptAgentIdentityBinding;
use super::agent_identity::agent_identity_authapi_base_url;
use super::agent_identity::classify_bootstrap_error;
use super::agent_identity::record_matches_managed_chatgpt_binding;
use super::agent_identity::record_needs_task_registration;
use super::agent_identity::register_managed_chatgpt_agent_identity;
use super::agent_identity::require_agent_identity_authapi_base_url;
use super::agent_identity::verified_record_from_jwt;
use super::external_bearer::BearerTokenRefresher;
use super::revoke::revoke_auth_tokens;
pub use crate::auth::agent_identity::AgentIdentityAuth;
pub use crate::auth::agent_identity::AgentIdentityAuthError;
pub use crate::auth::bedrock_api_key::BedrockApiKeyAuth;
pub use crate::auth::personal_access_token::PersonalAccessTokenAuth;
pub use crate::auth::storage::AgentIdentityAuthRecord;
pub use crate::auth::storage::AgentIdentityStorage;
pub use crate::auth::storage::AuthDotJson;
pub use crate::auth::storage::AuthKeyringBackendKind;
use crate::auth::storage::AuthStorageBackend;
use crate::auth::storage::create_auth_storage;
use crate::auth::util::try_parse_error_message;
use crate::default_client::create_client;
use crate::default_client::create_default_auth_client;
use crate::outbound_proxy::AuthRouteConfig;
use crate::token_data::TokenData;
use crate::token_data::parse_chatgpt_jwt_claims;
use crate::token_data::parse_jwt_expiration;
use codex_client::CodexHttpClient;
use codex_config::types::AuthCredentialsStoreMode;
use codex_protocol::account::PlanType as AccountPlanType;
use codex_protocol::auth::PlanType as InternalPlanType;
use codex_protocol::auth::RefreshTokenFailedError;
use codex_protocol::auth::RefreshTokenFailedReason;
use codex_protocol::protocol::SessionSource;
use serde_json::Value;
use thiserror::Error;

/// 当前用户使用的认证机制。
#[derive(Debug, Clone)]
pub enum CodexAuth {
    /// OpenAI API key（来自环境变量或 auth.json）。
    ApiKey(ApiKeyAuth),
    /// 由 Codex 管理的 ChatGPT OAuth 凭据（含 access/refresh token）。
    Chatgpt(ChatgptAuth),
    /// 外部托管的 ChatGPT access token（如桌面应用注入），无 refresh token。
    ChatgptAuthTokens(ChatgptAuthTokens),
    /// Agent Identity JWT 认证（FedRAMP / 托管 ChatGPT 自动注册）。
    AgentIdentity(AgentIdentityAuth),
    /// Personal Access Token（用户在 platform.openai.com 创建）。
    PersonalAccessToken(PersonalAccessTokenAuth),
    /// AWS Bedrock API key 认证。
    BedrockApiKey(BedrockApiKeyAuth),
}

/// 从更宽泛的 Codex auth 快照中解析 Agent Identity auth 时采用的策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentIdentityAuthPolicy {
    /// 仅当当前 auth 已经是 Agent Identity 时才使用。
    JwtOnly,
    /// 允许从托管 ChatGPT auth 注册或复用 Agent Identity auth。
    ChatGptAuth,
}

const AGENT_IDENTITY_BOOTSTRAP_FAILURE_COOLDOWN: Duration = Duration::from_secs(60 * 60);

#[derive(Debug)]
struct CachedAgentIdentityBootstrapFailure {
    account_id: String,
    authapi_base_url: String,
    retry_at: Instant,
    error: AgentIdentityAuthError,
}

#[derive(Debug, Default)]
struct AgentIdentityBootstrapCooldown {
    failure: Option<CachedAgentIdentityBootstrapFailure>,
}

impl AgentIdentityBootstrapCooldown {
    fn error_for(
        &mut self,
        account_id: &str,
        authapi_base_url: &str,
        now: Instant,
    ) -> Option<AgentIdentityAuthError> {
        let error = self
            .failure
            .as_ref()
            .filter(|failure| {
                failure.account_id == account_id
                    && failure.authapi_base_url == authapi_base_url
                    && failure.retry_at > now
            })
            .map(|failure| failure.error.clone());
        if error.is_none() {
            self.clear();
        }
        error
    }

    fn record_failure(
        &mut self,
        account_id: String,
        authapi_base_url: String,
        error: AgentIdentityAuthError,
        now: Instant,
    ) {
        self.failure = Some(CachedAgentIdentityBootstrapFailure {
            account_id,
            authapi_base_url,
            retry_at: now + AGENT_IDENTITY_BOOTSTRAP_FAILURE_COOLDOWN,
            error,
        });
    }

    fn clear(&mut self) {
        self.failure = None;
    }
}

impl PartialEq for CodexAuth {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::PersonalAccessToken(a), Self::PersonalAccessToken(b)) => a == b,
            (Self::BedrockApiKey(a), Self::BedrockApiKey(b)) => a == b,
            _ => self.api_auth_mode() == other.api_auth_mode(),
        }
    }
}

/// 仅包含 API key 的认证凭据。
#[derive(Debug, Clone)]
pub struct ApiKeyAuth {
    /// OpenAI API key 原始字符串。
    api_key: String,
}

/// 由 Codex 管理的 ChatGPT OAuth 认证，绑定到持久化存储后端。
#[derive(Debug, Clone)]
pub struct ChatgptAuth {
    /// 内存中的 ChatGPT auth 状态（含 auth.json 与 HTTP 客户端）。
    state: ChatgptAuthState,
    /// 持久化后端（file / keyring / auto）。
    storage: Arc<dyn AuthStorageBackend>,
}

/// 外部托管的 ChatGPT access token 认证（不写盘，仅在内存中）。
#[derive(Debug, Clone)]
pub struct ChatgptAuthTokens {
    /// 内存中的 ChatGPT auth 状态（含 auth.json 与 HTTP 客户端）。
    state: ChatgptAuthState,
}

/// ChatGPT auth 共享的内部状态。
#[derive(Debug, Clone)]
struct ChatgptAuthState {
    /// 当前 auth.json 快照，使用 `Arc<Mutex>` 以便跨任务共享与刷新。
    auth_dot_json: Arc<Mutex<Option<AuthDotJson>>>,
    /// 用于 refresh token 等调用的 HTTP 客户端。
    client: CodexHttpClient,
}

const TOKEN_REFRESH_INTERVAL: i64 = 8;
const CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES: i64 = 5;

const REFRESH_TOKEN_EXPIRED_MESSAGE: &str = "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.";
const REFRESH_TOKEN_REUSED_MESSAGE: &str = "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
const REFRESH_TOKEN_INVALIDATED_MESSAGE: &str = "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.";
const REFRESH_TOKEN_UNKNOWN_MESSAGE: &str =
    "Your access token could not be refreshed. Please log out and sign in again.";
const REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE: &str = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";
const REFRESH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub(super) const REVOKE_TOKEN_URL: &str = "https://auth.openai.com/oauth/revoke";
pub const REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR: &str = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
pub const REVOKE_TOKEN_URL_OVERRIDE_ENV_VAR: &str = "CODEX_REVOKE_TOKEN_URL_OVERRIDE";
pub const CLIENT_ID_OVERRIDE_ENV_VAR: &str = "CODEX_APP_SERVER_LOGIN_CLIENT_ID";
static NEXT_DUMMY_AUTH_ID: AtomicU64 = AtomicU64::new(1);

/// refresh token 流程可能产生的错误。
///
/// - `Permanent`：refresh token 已失效，需要用户重新登录。
/// - `Transient`：临时性错误（网络/IO），可重试。
#[derive(Debug, Error)]
pub enum RefreshTokenError {
    /// 永久性失败，例如 refresh token 已过期/被撤销/被复用。
    #[error("{0}")]
    Permanent(#[from] RefreshTokenFailedError),
    /// 临时性失败，例如网络错误，可重试。
    #[error(transparent)]
    Transient(#[from] std::io::Error),
}

/// 外部 auth provider 返回的 token 集合。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalAuthTokens {
    /// access_token 字符串。
    pub access_token: String,
    /// ChatGPT 元数据（可选），用于区分 API key 与 ChatGPT token。
    pub chatgpt_metadata: Option<ExternalAuthChatgptMetadata>,
}

/// 外部 auth provider 返回的 ChatGPT 元数据。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalAuthChatgptMetadata {
    /// ChatGPT account ID（即 workspace ID）。
    pub account_id: String,
    /// 账户 plan type（如 free / plus / pro / team）。
    pub plan_type: Option<String>,
}

impl ExternalAuthTokens {
    /// 构造一份仅含 access_token、不附带 ChatGPT 元数据的 token 集合。
    pub fn access_token_only(access_token: impl Into<String>) -> Self {
        Self {
            access_token: access_token.into(),
            chatgpt_metadata: None,
        }
    }

    /// 构造一份附带 ChatGPT 元数据的 token 集合。
    ///
    /// - `access_token`：access_token 字符串
    /// - `chatgpt_account_id`：ChatGPT account ID
    /// - `chatgpt_plan_type`：可选的 plan type
    pub fn chatgpt(
        access_token: impl Into<String>,
        chatgpt_account_id: impl Into<String>,
        chatgpt_plan_type: Option<String>,
    ) -> Self {
        Self {
            access_token: access_token.into(),
            chatgpt_metadata: Some(ExternalAuthChatgptMetadata {
                account_id: chatgpt_account_id.into(),
                plan_type: chatgpt_plan_type,
            }),
        }
    }

    /// 返回 ChatGPT 元数据的引用（若存在）。
    pub fn chatgpt_metadata(&self) -> Option<&ExternalAuthChatgptMetadata> {
        self.chatgpt_metadata.as_ref()
    }
}

/// 触发外部 auth 刷新的原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExternalAuthRefreshReason {
    /// 因 401 Unauthorized 触发刷新。
    Unauthorized,
}

/// 外部 auth 刷新上下文，传递给 `ExternalAuth::refresh` 以便实现方做出决策。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalAuthRefreshContext {
    /// 刷新原因。
    pub reason: ExternalAuthRefreshReason,
    /// 刷新前缓存的 account ID（可选），用于检测账户切换。
    pub previous_account_id: Option<String>,
}

/// `AuthManager` 用于外部托管 auth 流程的可插拔 auth provider。
///
/// 实现方可以选择通过 `resolve()` 立即返回 auth，或通过 `refresh()` 在需要时返回
/// 刷新后的凭据。
pub trait ExternalAuth: Send + Sync {
    /// 指明此外部 provider 提供的顶层 auth mode。
    fn auth_mode(&self) -> AuthMode;

    /// 返回缓存或立即可用的 auth；若 provider 不能从调用方视角同步解析则返回 `None`。
    fn resolve(&self) -> ExternalAuthFuture<'_, Option<ExternalAuthTokens>> {
        Box::pin(async { Ok(None) })
    }

    /// 响应 manager 驱动的刷新请求，返回刷新后的 auth tokens。
    fn refresh(
        &self,
        context: ExternalAuthRefreshContext,
    ) -> ExternalAuthFuture<'_, ExternalAuthTokens>;
}

/// `ExternalAuth` trait 使用的 boxed future 类型别名。
pub type ExternalAuthFuture<'a, T> = Pin<Box<dyn Future<Output = std::io::Result<T>> + Send + 'a>>;

impl RefreshTokenError {
    /// 返回与此错误关联的 `RefreshTokenFailedReason`（仅 `Permanent` 有，`Transient` 返回 `None`）。
    pub fn failed_reason(&self) -> Option<RefreshTokenFailedReason> {
        match self {
            Self::Permanent(error) => Some(error.reason),
            Self::Transient(_) => None,
        }
    }
}

impl From<RefreshTokenError> for std::io::Error {
    fn from(err: RefreshTokenError) -> Self {
        match err {
            RefreshTokenError::Permanent(failed) => std::io::Error::other(failed),
            RefreshTokenError::Transient(inner) => inner,
        }
    }
}

impl CodexAuth {
    async fn from_auth_dot_json(
        codex_home: &Path,
        auth_dot_json: AuthDotJson,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        chatgpt_base_url: Option<&str>,
        keyring_backend_kind: AuthKeyringBackendKind,
        agent_identity_authapi_base_url: Option<&str>,
        auth_route_config: Option<&AuthRouteConfig>,
    ) -> std::io::Result<Self> {
        let auth_mode = auth_dot_json.resolved_mode();
        if auth_mode == AuthMode::ApiKey {
            let Some(api_key) = auth_dot_json.openai_api_key.as_deref() else {
                return Err(std::io::Error::other("API key auth is missing a key."));
            };
            return Ok(Self::from_api_key(api_key));
        }
        if auth_mode == AuthMode::AgentIdentity {
            let Some(agent_identity) = auth_dot_json.agent_identity.clone() else {
                return Err(std::io::Error::other(
                    "agent identity auth is missing agent identity auth material.",
                ));
            };
            let base_url = chatgpt_base_url
                .unwrap_or(ChatGptEnvironment::default().chatgpt_base_url())
                .trim_end_matches('/')
                .to_string();
            let agent_identity_authapi_base_url =
                require_agent_identity_authapi_base_url(agent_identity_authapi_base_url)?;
            match agent_identity {
                AgentIdentityStorage::Jwt(jwt) => {
                    let auth = AgentIdentityAuth::from_jwt(
                        &jwt,
                        &base_url,
                        agent_identity_authapi_base_url,
                        auth_route_config,
                    )
                    .await?;
                    return Ok(Self::AgentIdentity(auth));
                }
                AgentIdentityStorage::Record(record) => {
                    let auth = AgentIdentityAuth::from_record(
                        record,
                        agent_identity_authapi_base_url,
                        auth_route_config,
                    )
                    .await?;
                    return Ok(Self::AgentIdentity(auth));
                }
            }
        }
        if auth_mode == AuthMode::PersonalAccessToken {
            let Some(personal_access_token) = auth_dot_json.personal_access_token.as_deref() else {
                return Err(std::io::Error::other(
                    "personal access token auth is missing a personal access token.",
                ));
            };
            return Self::from_personal_access_token(personal_access_token, auth_route_config)
                .await;
        }
        if auth_mode == AuthMode::BedrockApiKey {
            let Some(auth) = auth_dot_json.bedrock_api_key else {
                return Err(std::io::Error::other(
                    "Bedrock API key auth is missing a Bedrock API key.",
                ));
            };
            return Ok(Self::BedrockApiKey(auth));
        }

        let storage_mode = auth_dot_json.storage_mode(auth_credentials_store_mode);
        let client = create_default_auth_client(&refresh_token_endpoint(), auth_route_config)?;
        let state = ChatgptAuthState {
            auth_dot_json: Arc::new(Mutex::new(Some(auth_dot_json))),
            client,
        };

        match auth_mode {
            AuthMode::Chatgpt => {
                let storage = create_auth_storage(
                    codex_home.to_path_buf(),
                    storage_mode,
                    keyring_backend_kind,
                );
                Ok(Self::Chatgpt(ChatgptAuth { state, storage }))
            }
            AuthMode::ChatgptAuthTokens => Ok(Self::ChatgptAuthTokens(ChatgptAuthTokens { state })),
            AuthMode::ApiKey => unreachable!("api key mode is handled above"),
            AuthMode::AgentIdentity => unreachable!("agent identity mode is handled above"),
            AuthMode::PersonalAccessToken => {
                unreachable!("personal access token mode is handled above")
            }
            AuthMode::BedrockApiKey => unreachable!("bedrock api key mode is handled above"),
        }
    }

    /// 从配置好的 auth 存储后端加载 `CodexAuth`；无凭据时返回 `Ok(None)`。
    pub async fn from_auth_storage(
        codex_home: &Path,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        chatgpt_base_url: Option<&str>,
        keyring_backend_kind: AuthKeyringBackendKind,
        auth_route_config: Option<&AuthRouteConfig>,
    ) -> std::io::Result<Option<Self>> {
        let agent_identity_authapi_base_url =
            agent_identity_authapi_base_url(chatgpt_base_url).ok();
        load_auth(
            codex_home,
            /*enable_codex_api_key_env*/ false,
            auth_credentials_store_mode,
            /*forced_chatgpt_workspace_id*/ None,
            chatgpt_base_url,
            keyring_backend_kind,
            agent_identity_authapi_base_url.as_deref(),
            auth_route_config,
        )
        .await
    }

    /// 用 Agent Identity JWT 直接构造 `CodexAuth::AgentIdentity`。
    ///
    /// 会从 `chatgpt_base_url` 推导 agent identity AuthAPI base URL。
    pub async fn from_agent_identity_jwt(
        jwt: &str,
        chatgpt_base_url: Option<&str>,
        auth_route_config: Option<&AuthRouteConfig>,
    ) -> std::io::Result<Self> {
        let agent_identity_authapi_base_url = agent_identity_authapi_base_url(chatgpt_base_url)?;
        Self::from_agent_identity_jwt_with_authapi_base_url(
            jwt,
            chatgpt_base_url,
            &agent_identity_authapi_base_url,
            auth_route_config,
        )
        .await
    }

    async fn from_agent_identity_jwt_with_authapi_base_url(
        jwt: &str,
        chatgpt_base_url: Option<&str>,
        agent_identity_authapi_base_url: &str,
        auth_route_config: Option<&AuthRouteConfig>,
    ) -> std::io::Result<Self> {
        let base_url = chatgpt_base_url
            .unwrap_or(ChatGptEnvironment::default().chatgpt_base_url())
            .trim_end_matches('/')
            .to_string();
        Ok(Self::AgentIdentity(
            AgentIdentityAuth::from_jwt(
                jwt,
                &base_url,
                agent_identity_authapi_base_url,
                auth_route_config,
            )
            .await?,
        ))
    }

    /// 用 Personal Access Token 构造 `CodexAuth::PersonalAccessToken`。
    ///
    /// 会调用 `/whoami` 端点解析 account ID 等 metadata。
    pub async fn from_personal_access_token(
        access_token: &str,
        auth_route_config: Option<&AuthRouteConfig>,
    ) -> std::io::Result<Self> {
        Ok(Self::PersonalAccessToken(
            PersonalAccessTokenAuth::load(access_token, auth_route_config).await?,
        ))
    }

    /// 返回有效的 backend auth mode。
    ///
    /// 外部托管的 ChatGPT tokens 会被归一化为 [`AuthMode::Chatgpt`]。
    pub fn auth_mode(&self) -> AuthMode {
        match self {
            Self::ApiKey(_) => AuthMode::ApiKey,
            Self::Chatgpt(_) | Self::ChatgptAuthTokens(_) => AuthMode::Chatgpt,
            Self::AgentIdentity(_) => AuthMode::AgentIdentity,
            Self::PersonalAccessToken(_) => AuthMode::PersonalAccessToken,
            Self::BedrockApiKey(_) => AuthMode::BedrockApiKey,
        }
    }

    /// 返回当前认证背后的精确凭据类型（区分 ChatGPT 与外部托管 ChatGPT tokens）。
    pub fn api_auth_mode(&self) -> AuthMode {
        match self {
            Self::ApiKey(_) => AuthMode::ApiKey,
            Self::Chatgpt(_) => AuthMode::Chatgpt,
            Self::ChatgptAuthTokens(_) => AuthMode::ChatgptAuthTokens,
            Self::AgentIdentity(_) => AuthMode::AgentIdentity,
            Self::PersonalAccessToken(_) => AuthMode::PersonalAccessToken,
            Self::BedrockApiKey(_) => AuthMode::BedrockApiKey,
        }
    }

    /// 是否为 API key 认证。
    pub fn is_api_key_auth(&self) -> bool {
        self.auth_mode() == AuthMode::ApiKey
    }

    /// 是否为 Personal Access Token 认证。
    pub fn is_personal_access_token_auth(&self) -> bool {
        self.auth_mode() == AuthMode::PersonalAccessToken
    }

    /// 是否为携带 ChatGPT account ID 的认证（含 ChatGPT / ChatgptAuthTokens / AgentIdentity / PAT）。
    pub fn is_chatgpt_auth(&self) -> bool {
        self.api_auth_mode().has_chatgpt_account()
    }

    /// 是否使用 Codex backend（即非自定义 model provider）。
    pub fn uses_codex_backend(&self) -> bool {
        self.api_auth_mode().uses_codex_backend()
    }

    /// 是否为外部托管的 ChatGPT tokens（即 `CodexAuth::ChatgptAuthTokens`）。
    pub fn is_external_chatgpt_tokens(&self) -> bool {
        matches!(self, Self::ChatgptAuthTokens(_))
    }

    fn supports_unauthorized_recovery(&self) -> bool {
        matches!(self, Self::Chatgpt(_) | Self::ChatgptAuthTokens(_))
    }

    /// 返回 `None` 表示当前 `auth_mode() != AuthMode::ApiKey`。
    pub fn api_key(&self) -> Option<&str> {
        match self {
            Self::ApiKey(auth) => Some(auth.api_key.as_str()),
            Self::Chatgpt(_)
            | Self::ChatgptAuthTokens(_)
            | Self::AgentIdentity(_)
            | Self::PersonalAccessToken(_)
            | Self::BedrockApiKey(_) => None,
        }
    }

    /// 返回 token 数据；若非基于 token 的 ChatGPT auth 则返回 `Err`。
    pub fn get_token_data(&self) -> Result<TokenData, std::io::Error> {
        let auth_dot_json: Option<AuthDotJson> = self.get_current_auth_json();
        match auth_dot_json {
            Some(AuthDotJson {
                tokens: Some(tokens),
                last_refresh: Some(_),
                ..
            }) => Ok(tokens),
            _ => Err(std::io::Error::other("Token data is not available.")),
        }
    }

    /// 返回用于 bearer 认证的 token 字符串。
    ///
    /// 对 Agent Identity / Bedrock 认证返回 `Err`，因为它们不暴露 bearer token。
    pub fn get_token(&self) -> Result<String, std::io::Error> {
        match self {
            Self::ApiKey(auth) => Ok(auth.api_key.clone()),
            Self::Chatgpt(_) | Self::ChatgptAuthTokens(_) => {
                let access_token = self.get_token_data()?.access_token;
                Ok(access_token)
            }
            Self::AgentIdentity(_) => Err(std::io::Error::other(
                "agent identity auth does not expose a bearer token",
            )),
            Self::PersonalAccessToken(auth) => Ok(auth.access_token().to_string()),
            Self::BedrockApiKey(_) => Err(std::io::Error::other(
                "Bedrock API key auth does not expose a Codex bearer token",
            )),
        }
    }

    /// 返回 `None` 表示当前 Codex backend auth 不暴露 account ID。
    pub fn get_account_id(&self) -> Option<String> {
        match self {
            Self::AgentIdentity(auth) => Some(auth.account_id().to_string()),
            Self::PersonalAccessToken(auth) => Some(auth.account_id().to_string()),
            _ => self.get_current_token_data().and_then(|t| t.account_id),
        }
    }

    /// 返回 `false` 表示当前 Codex backend auth 缺少 FedRAMP claim。
    pub fn is_fedramp_account(&self) -> bool {
        match self {
            Self::AgentIdentity(auth) => auth.is_fedramp_account(),
            Self::PersonalAccessToken(auth) => auth.is_fedramp_account(),
            _ => self
                .get_current_token_data()
                .is_some_and(|t| t.id_token.is_fedramp_account()),
        }
    }

    /// 返回 `None` 表示当前 Codex backend auth 不暴露邮箱。
    pub fn get_account_email(&self) -> Option<String> {
        match self {
            Self::AgentIdentity(auth) => auth.email().map(str::to_string),
            Self::PersonalAccessToken(auth) => auth.email().map(str::to_string),
            _ => self.get_current_token_data().and_then(|t| t.id_token.email),
        }
    }

    /// 返回 `None` 表示当前 Codex backend auth 不暴露 ChatGPT user ID。
    pub fn get_chatgpt_user_id(&self) -> Option<String> {
        match self {
            Self::AgentIdentity(auth) => Some(auth.chatgpt_user_id().to_string()),
            Self::PersonalAccessToken(auth) => Some(auth.chatgpt_user_id().to_string()),
            _ => self
                .get_current_token_data()
                .and_then(|t| t.id_token.chatgpt_user_id),
        }
    }

    /// 从当前 auth 派生的账户面向产品的 plan 分类。
    ///
    /// 返回高层级 `AccountPlanType`（如 Free/Plus/Pro/Team/...），用于 UI 或产品决策。
    pub fn account_plan_type(&self) -> Option<AccountPlanType> {
        if let Self::AgentIdentity(auth) = self {
            return Some(auth.plan_type());
        }
        if let Self::PersonalAccessToken(auth) = self {
            return Some(auth.plan_type());
        }

        self.get_current_token_data().map(|t| {
            t.id_token
                .chatgpt_plan_type
                .map(AccountPlanType::from)
                .unwrap_or(AccountPlanType::Unknown)
        })
    }

    /// 当前账户是否为 workspace 账户（Team/Enterprise 等）。
    pub fn is_workspace_account(&self) -> bool {
        self.account_plan_type()
            .is_some_and(AccountPlanType::is_workspace_account)
    }

    /// 返回 `None` 表示无基于 token 的 ChatGPT auth 可用。
    fn get_current_auth_json(&self) -> Option<AuthDotJson> {
        let state = match self {
            Self::Chatgpt(auth) => &auth.state,
            Self::ChatgptAuthTokens(auth) => &auth.state,
            Self::ApiKey(_)
            | Self::AgentIdentity(_)
            | Self::PersonalAccessToken(_)
            | Self::BedrockApiKey(_) => return None,
        };
        #[expect(clippy::unwrap_used)]
        state.auth_dot_json.lock().unwrap().clone()
    }

    /// 返回 `None` 表示无基于 token 的 ChatGPT auth 可用。
    fn get_current_token_data(&self) -> Option<TokenData> {
        self.get_current_auth_json().and_then(|t| t.tokens)
    }

    fn stored_managed_chatgpt_agent_identity_record(
        &self,
        account_id: &str,
    ) -> Option<AgentIdentityAuthRecord> {
        self.get_current_auth_json()
            .and_then(|auth| auth.agent_identity)
            .and_then(|identity| identity.as_record().cloned())
            .filter(|identity| identity.account_id == account_id)
    }

    fn persist_managed_chatgpt_agent_identity_record(
        &self,
        record: AgentIdentityAuthRecord,
    ) -> std::io::Result<()> {
        if let Self::Chatgpt(chatgpt_auth) = self {
            chatgpt_auth.persist_agent_identity_record(record)?;
        }
        Ok(())
    }

    async fn agent_identity_auth(
        &self,
        policy: AgentIdentityAuthPolicy,
        agent_identity_authapi_base_url: Option<&str>,
        forced_chatgpt_workspace_id: Option<Vec<String>>,
        auth_route_config: Option<&AuthRouteConfig>,
        session_source: SessionSource,
    ) -> std::io::Result<Option<AgentIdentityAuth>> {
        match self {
            Self::AgentIdentity(auth) => Ok(Some(auth.clone())),
            Self::ApiKey(_)
            | Self::ChatgptAuthTokens(_)
            | Self::PersonalAccessToken(_)
            | Self::BedrockApiKey(_) => Ok(None),
            Self::Chatgpt(_) => {
                if policy == AgentIdentityAuthPolicy::JwtOnly {
                    return Ok(None);
                }
                self.ensure_managed_chatgpt_agent_identity(
                    require_agent_identity_authapi_base_url(agent_identity_authapi_base_url)?,
                    forced_chatgpt_workspace_id,
                    auth_route_config,
                    session_source,
                )
                .await
                .map(Some)
            }
        }
    }

    async fn ensure_managed_chatgpt_agent_identity(
        &self,
        agent_identity_authapi_base_url: &str,
        forced_chatgpt_workspace_id: Option<Vec<String>>,
        auth_route_config: Option<&AuthRouteConfig>,
        session_source: SessionSource,
    ) -> std::io::Result<AgentIdentityAuth> {
        let binding =
            ManagedChatGptAgentIdentityBinding::from_auth(self, forced_chatgpt_workspace_id)
                .ok_or_else(|| std::io::Error::other("ChatGPT auth is unavailable"))?;

        // JWT auth 会作为 CodexAuth::AgentIdentity 加载；此路径仅复用
        // 由托管 ChatGPT Agent Identity bootstrap 创建的 record。
        if let Some(record) = self.stored_managed_chatgpt_agent_identity_record(&binding.account_id)
            && record_matches_managed_chatgpt_binding(&record, &binding)
        {
            let should_persist = record_needs_task_registration(&record);
            let auth = AgentIdentityAuth::from_record(
                record,
                agent_identity_authapi_base_url,
                auth_route_config,
            )
            .await
            .map_err(|err| classify_bootstrap_error("agent task registration", err))?;
            if should_persist {
                self.persist_managed_chatgpt_agent_identity_record(auth.record().clone())?;
            }
            return Ok(auth);
        }

        let auth = register_managed_chatgpt_agent_identity(
            binding,
            agent_identity_authapi_base_url,
            session_source,
            auth_route_config,
        )
        .await?;
        self.persist_managed_chatgpt_agent_identity_record(auth.record().clone())?;
        Ok(auth)
    }

    /// 仅用于集成测试：构造一份 dummy ChatGPT auth。
    pub fn create_dummy_chatgpt_auth_for_testing() -> Self {
        let auth_dot_json = AuthDotJson {
            auth_mode: Some(AuthMode::Chatgpt),
            openai_api_key: None,
            tokens: Some(TokenData {
                id_token: Default::default(),
                access_token: "Access Token".to_string(),
                refresh_token: "test".to_string(),
                account_id: Some("account_id".to_string()),
            }),
            last_refresh: Some(Utc::now()),
            agent_identity: None,
            personal_access_token: None,
            bedrock_api_key: None,
        };

        let state = ChatgptAuthState {
            auth_dot_json: Arc::new(Mutex::new(Some(auth_dot_json))),
            client: create_client(),
        };
        let dummy_auth_id = NEXT_DUMMY_AUTH_ID.fetch_add(1, Ordering::Relaxed);
        let storage = create_auth_storage(
            PathBuf::from(format!("dummy-chatgpt-auth-{dummy_auth_id}")),
            AuthCredentialsStoreMode::Ephemeral,
            AuthKeyringBackendKind::default(),
        );
        Self::Chatgpt(ChatgptAuth { state, storage })
    }

    /// 用 API key 字符串构造 `CodexAuth::ApiKey`。
    pub fn from_api_key(api_key: &str) -> Self {
        Self::ApiKey(ApiKeyAuth {
            api_key: api_key.to_owned(),
        })
    }
}

impl ManagedChatGptAgentIdentityBinding {
    fn from_auth(auth: &CodexAuth, forced_workspace_id: Option<Vec<String>>) -> Option<Self> {
        if !auth.is_chatgpt_auth() {
            return None;
        }

        let token_data = auth.get_token_data().ok()?;
        let forced_workspace_id =
            forced_workspace_id
                .as_deref()
                .and_then(|workspace_ids| match workspace_ids {
                    [workspace_id] if !workspace_id.is_empty() => Some(workspace_id.clone()),
                    _ => None,
                });
        let account_id = forced_workspace_id
            .or(token_data
                .account_id
                .clone()
                .filter(|value| !value.is_empty()))
            .or(token_data.id_token.chatgpt_account_id.clone())?;
        let chatgpt_user_id = token_data
            .id_token
            .chatgpt_user_id
            .clone()
            .filter(|value| !value.is_empty())?;

        Some(Self {
            account_id,
            chatgpt_user_id,
            email: token_data.id_token.email.clone(),
            plan_type: auth.account_plan_type().unwrap_or(AccountPlanType::Unknown),
            chatgpt_account_is_fedramp: auth.is_fedramp_account(),
            access_token: token_data.access_token,
        })
    }
}

impl ChatgptAuth {
    fn current_auth_json(&self) -> Option<AuthDotJson> {
        #[expect(clippy::unwrap_used)]
        self.state.auth_dot_json.lock().unwrap().clone()
    }

    fn current_token_data(&self) -> Option<TokenData> {
        self.current_auth_json().and_then(|auth| auth.tokens)
    }

    fn storage(&self) -> &Arc<dyn AuthStorageBackend> {
        &self.storage
    }

    fn client(&self) -> &CodexHttpClient {
        &self.state.client
    }

    fn persist_agent_identity_record(
        &self,
        record: AgentIdentityAuthRecord,
    ) -> std::io::Result<()> {
        persist_agent_identity_record(&self.state.auth_dot_json, &self.storage, record)
    }
}

fn persist_agent_identity_record(
    auth_dot_json: &Arc<Mutex<Option<AuthDotJson>>>,
    storage: &Arc<dyn AuthStorageBackend>,
    record: AgentIdentityAuthRecord,
) -> std::io::Result<()> {
    let mut guard = auth_dot_json
        .lock()
        .map_err(|_| std::io::Error::other("failed to lock auth state"))?;
    let mut auth = storage
        .load()?
        .or_else(|| guard.clone())
        .ok_or_else(|| std::io::Error::other("auth data is not available"))?;
    auth.agent_identity = Some(AgentIdentityStorage::Record(record));
    storage.save(&auth)?;
    *guard = Some(auth);
    Ok(())
}

/// 环境变量名：OpenAI API key（兼容旧版 SDK 习惯）。
pub const OPENAI_API_KEY_ENV_VAR: &str = "OPENAI_API_KEY";
/// 环境变量名：Codex 专用 API key（优先级高于 `OPENAI_API_KEY`）。
pub const CODEX_API_KEY_ENV_VAR: &str = "CODEX_API_KEY";
/// 环境变量名：Codex access token（PAT 或 Agent Identity JWT）。
pub const CODEX_ACCESS_TOKEN_ENV_VAR: &str = "CODEX_ACCESS_TOKEN";

/// 从 `OPENAI_API_KEY` 环境变量读取非空 API key。
pub fn read_openai_api_key_from_env() -> Option<String> {
    env::var(OPENAI_API_KEY_ENV_VAR)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 从 `CODEX_API_KEY` 环境变量读取非空 API key。
pub fn read_codex_api_key_from_env() -> Option<String> {
    read_non_empty_env_var(CODEX_API_KEY_ENV_VAR)
}

/// 从 `CODEX_ACCESS_TOKEN` 环境变量读取非空 access token。
pub fn read_codex_access_token_from_env() -> Option<String> {
    read_non_empty_env_var(CODEX_ACCESS_TOKEN_ENV_VAR)
}

fn read_non_empty_env_var(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 删除 `codex_home` 下的 auth.json 文件（若存在）。
///
/// 返回 `Ok(true)` 表示删除了文件，`Ok(false)` 表示文件本就不存在。
pub fn logout(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<bool> {
    let storage = create_auth_storage(
        codex_home.to_path_buf(),
        auth_credentials_store_mode,
        keyring_backend_kind,
    );
    storage.delete()
}

/// 先尝试撤销服务端的 auth tokens，再删除本地存储。
///
/// 即使撤销失败也会继续删除本地存储，避免遗留无效凭据。
pub async fn logout_with_revoke(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    auth_route_config: Option<&AuthRouteConfig>,
) -> std::io::Result<bool> {
    let auth_dot_json = match load_auth_dot_json(
        codex_home,
        auth_credentials_store_mode,
        keyring_backend_kind,
    ) {
        Ok(auth_dot_json) => auth_dot_json,
        Err(err) => {
            tracing::warn!("failed to load stored auth during logout: {err}");
            None
        }
    };
    if let Err(err) = revoke_auth_tokens(auth_dot_json.as_ref(), auth_route_config).await {
        tracing::warn!("failed to revoke auth tokens during logout: {err}");
    }
    logout_all_stores(
        codex_home,
        auth_credentials_store_mode,
        keyring_backend_kind,
    )
}

/// 写入一份仅包含 API key 的 `auth.json`。
pub fn login_with_api_key(
    codex_home: &Path,
    api_key: &str,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<()> {
    let auth_dot_json = AuthDotJson {
        auth_mode: Some(AuthMode::ApiKey),
        openai_api_key: Some(api_key.to_string()),
        tokens: None,
        last_refresh: None,
        agent_identity: None,
        personal_access_token: None,
        bedrock_api_key: None,
    };
    save_auth(
        codex_home,
        &auth_dot_json,
        auth_credentials_store_mode,
        keyring_backend_kind,
    )
}

/// 写入一份仅包含 access token 的 `auth.json`。
///
/// 自动识别 token 类型：PAT → PersonalAccessToken；Agent Identity JWT → AgentIdentity。
/// 会校验 token 满足可选的 workspace 限制。
pub async fn login_with_access_token(
    codex_home: &Path,
    access_token: &str,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    forced_chatgpt_workspace_id: Option<&[String]>,
    chatgpt_base_url: Option<&str>,
    keyring_backend_kind: AuthKeyringBackendKind,
    auth_route_config: Option<&AuthRouteConfig>,
) -> std::io::Result<()> {
    let auth_dot_json = match classify_codex_access_token(access_token) {
        CodexAccessToken::PersonalAccessToken(access_token) => {
            let auth = PersonalAccessTokenAuth::load(access_token, auth_route_config).await?;
            ensure_personal_access_token_workspace_allowed(forced_chatgpt_workspace_id, &auth)?;
            AuthDotJson {
                // 从凭据字段推断 PAT auth，以便旧版 Codex 在回滚后仍能反序列化 auth.json。
                auth_mode: None,
                openai_api_key: None,
                tokens: None,
                last_refresh: None,
                agent_identity: None,
                personal_access_token: Some(access_token.to_string()),
                bedrock_api_key: None,
            }
        }
        CodexAccessToken::AgentIdentityJwt(jwt) => {
            let base_url = chatgpt_base_url
                .unwrap_or(ChatGptEnvironment::default().chatgpt_base_url())
                .trim_end_matches('/')
                .to_string();
            verified_record_from_jwt(jwt, &base_url, auth_route_config).await?;
            AuthDotJson {
                auth_mode: Some(AuthMode::AgentIdentity),
                openai_api_key: None,
                tokens: None,
                last_refresh: None,
                agent_identity: Some(AgentIdentityStorage::Jwt(jwt.to_string())),
                personal_access_token: None,
                bedrock_api_key: None,
            }
        }
    };
    save_auth(
        codex_home,
        &auth_dot_json,
        auth_credentials_store_mode,
        keyring_backend_kind,
    )
}

fn ensure_personal_access_token_workspace_allowed(
    expected_workspace_ids: Option<&[String]>,
    auth: &PersonalAccessTokenAuth,
) -> std::io::Result<()> {
    crate::server::ensure_workspace_account_allowed(expected_workspace_ids, auth.account_id())
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::PermissionDenied, message))
}

/// 写入一份内存中的 auth payload，用于外部托管的 ChatGPT tokens。
///
/// 使用 Ephemeral 存储后端，不写盘。
pub fn login_with_chatgpt_auth_tokens(
    codex_home: &Path,
    access_token: &str,
    chatgpt_account_id: &str,
    chatgpt_plan_type: Option<&str>,
) -> std::io::Result<()> {
    let auth_dot_json = AuthDotJson::from_external_access_token(
        access_token,
        chatgpt_account_id,
        chatgpt_plan_type,
    )?;
    save_auth(
        codex_home,
        &auth_dot_json,
        AuthCredentialsStoreMode::Ephemeral,
        AuthKeyringBackendKind::default(),
    )
}

/// 用指定后端持久化 auth payload。
pub fn save_auth(
    codex_home: &Path,
    auth: &AuthDotJson,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<()> {
    let storage = create_auth_storage(
        codex_home.to_path_buf(),
        auth_credentials_store_mode,
        keyring_backend_kind,
    );
    storage.save(auth)
}

/// 加载原始存储的 auth payload，不应用环境变量覆盖。
///
/// 无凭据时返回 `None`。生产读取请优先使用 `AuthManager`；本辅助函数仅供测试与
/// 写侧维护场景检视存储中的精确 payload 使用。
pub fn load_auth_dot_json(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<Option<AuthDotJson>> {
    let storage = create_auth_storage(
        codex_home.to_path_buf(),
        auth_credentials_store_mode,
        keyring_backend_kind,
    );
    storage.load()
}

/// 登录限制与存储配置的快照视图，供 `enforce_login_restrictions` 使用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthConfig {
    /// Codex 本地配置根目录。
    pub codex_home: PathBuf,
    /// CLI 凭据存储模式。
    pub auth_credentials_store_mode: AuthCredentialsStoreMode,
    /// keyring 后端类型。
    pub keyring_backend_kind: AuthKeyringBackendKind,
    /// 强制使用的登录方式（可选）。
    pub forced_login_method: Option<ForcedLoginMethod>,
    /// ChatGPT backend base URL（可选）。
    pub chatgpt_base_url: Option<String>,
    /// 强制要求的 ChatGPT workspace ID 列表（可选）。
    pub forced_chatgpt_workspace_id: Option<Vec<String>>,
    /// auth 专用客户端的路由配置（可选）。
    pub auth_route_config: Option<AuthRouteConfig>,
}

/// 使用 auth 自有的 HTTP 设置校验配置的登录限制。
///
/// 校验失败会自动登出当前凭据并返回 `Err`。
pub async fn enforce_login_restrictions(config: &AuthConfig) -> std::io::Result<()> {
    let agent_identity_authapi_base_url =
        agent_identity_authapi_base_url(config.chatgpt_base_url.as_deref()).ok();
    enforce_login_restrictions_with_agent_identity_authapi_base_url(
        config,
        agent_identity_authapi_base_url.as_deref(),
    )
    .await
}

async fn enforce_login_restrictions_with_agent_identity_authapi_base_url(
    config: &AuthConfig,
    agent_identity_authapi_base_url: Option<&str>,
) -> std::io::Result<()> {
    let Some(auth) = load_auth(
        &config.codex_home,
        /*enable_codex_api_key_env*/ true,
        config.auth_credentials_store_mode,
        /*forced_chatgpt_workspace_id*/ None,
        config.chatgpt_base_url.as_deref(),
        config.keyring_backend_kind,
        agent_identity_authapi_base_url,
        config.auth_route_config.as_ref(),
    )
    .await?
    else {
        return Ok(());
    };

    if let Some(required_method) = config.forced_login_method {
        let method_violation = match (required_method, auth.auth_mode()) {
            (ForcedLoginMethod::Api, AuthMode::ApiKey)
            | (ForcedLoginMethod::Api, AuthMode::BedrockApiKey) => None,
            (ForcedLoginMethod::Chatgpt, AuthMode::Chatgpt)
            | (ForcedLoginMethod::Chatgpt, AuthMode::ChatgptAuthTokens)
            | (ForcedLoginMethod::Chatgpt, AuthMode::AgentIdentity)
            | (ForcedLoginMethod::Chatgpt, AuthMode::PersonalAccessToken) => None,
            (ForcedLoginMethod::Api, AuthMode::Chatgpt)
            | (ForcedLoginMethod::Api, AuthMode::ChatgptAuthTokens)
            | (ForcedLoginMethod::Api, AuthMode::AgentIdentity)
            | (ForcedLoginMethod::Api, AuthMode::PersonalAccessToken) => Some(
                "API key login is required, but ChatGPT is currently being used. Logging out."
                    .to_string(),
            ),
            (ForcedLoginMethod::Chatgpt, AuthMode::ApiKey)
            | (ForcedLoginMethod::Chatgpt, AuthMode::BedrockApiKey) => Some(
                "ChatGPT login is required, but an API key is currently being used. Logging out."
                    .to_string(),
            ),
        };

        if let Some(message) = method_violation {
            return logout_with_message(
                &config.codex_home,
                message,
                config.auth_credentials_store_mode,
                config.keyring_backend_kind,
            );
        }
    }

    if let Some(expected_account_ids) = config.forced_chatgpt_workspace_id.as_deref() {
        let chatgpt_account_id = match &auth {
            CodexAuth::ApiKey(_) | CodexAuth::BedrockApiKey(_) => return Ok(()),
            CodexAuth::AgentIdentity(_) | CodexAuth::PersonalAccessToken(_) => {
                auth.get_account_id()
            }
            CodexAuth::Chatgpt(_) | CodexAuth::ChatgptAuthTokens(_) => {
                let token_data = match auth.get_token_data() {
                    Ok(data) => data,
                    Err(err) => {
                        return logout_with_message(
                            &config.codex_home,
                            format!(
                                "Failed to load ChatGPT credentials while enforcing workspace restrictions: {err}. Logging out."
                            ),
                            config.auth_credentials_store_mode,
                            config.keyring_backend_kind,
                        );
                    }
                };
                token_data.id_token.chatgpt_account_id
            }
        };

        // workspace 是 account ID 的对外标识。
        let chatgpt_account_id = chatgpt_account_id.as_deref();
        if !chatgpt_account_id.is_some_and(|actual| {
            expected_account_ids
                .iter()
                .any(|expected| expected == actual)
        }) {
            let expected_workspaces = expected_account_ids.join(", ");
            let message = match chatgpt_account_id {
                Some(actual) => format!(
                    "Login is restricted to workspace(s) {expected_workspaces}, but current credentials belong to {actual}. Logging out."
                ),
                None => format!(
                    "Login is restricted to workspace(s) {expected_workspaces}, but current credentials lack a workspace identifier. Logging out."
                ),
            };
            return logout_with_message(
                &config.codex_home,
                message,
                config.auth_credentials_store_mode,
                config.keyring_backend_kind,
            );
        }
    }

    Ok(())
}

fn logout_with_message(
    codex_home: &Path,
    message: String,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<()> {
    // 外部 auth tokens 存放在 ephemeral 存储中，但持久化 auth 可能来自早期登录。
    // 同时清除两者，确保强制登出能真正移除所有活动 auth。
    let removal_result = logout_all_stores(
        codex_home,
        auth_credentials_store_mode,
        keyring_backend_kind,
    );
    let error_message = match removal_result {
        Ok(_) => message,
        Err(err) => format!("{message}. Failed to remove auth.json: {err}"),
    };
    Err(std::io::Error::other(error_message))
}

fn logout_all_stores(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<bool> {
    if auth_credentials_store_mode == AuthCredentialsStoreMode::Ephemeral {
        return logout(
            codex_home,
            AuthCredentialsStoreMode::Ephemeral,
            AuthKeyringBackendKind::default(),
        );
    }
    let removed_ephemeral = logout(
        codex_home,
        AuthCredentialsStoreMode::Ephemeral,
        AuthKeyringBackendKind::default(),
    )?;
    let removed_managed = logout(
        codex_home,
        auth_credentials_store_mode,
        keyring_backend_kind,
    )?;
    Ok(removed_ephemeral || removed_managed)
}

#[allow(clippy::too_many_arguments)]
async fn load_auth(
    codex_home: &Path,
    enable_codex_api_key_env: bool,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    forced_chatgpt_workspace_id: Option<&[String]>,
    chatgpt_base_url: Option<&str>,
    keyring_backend_kind: AuthKeyringBackendKind,
    agent_identity_authapi_base_url: Option<&str>,
    auth_route_config: Option<&AuthRouteConfig>,
) -> std::io::Result<Option<CodexAuth>> {
    // API key 环境变量优先于任何其他 auth 方式。
    if enable_codex_api_key_env && let Some(api_key) = read_codex_api_key_from_env() {
        return Ok(Some(CodexAuth::from_api_key(api_key.as_str())));
    }

    // 外部 ChatGPT auth tokens 存放在内存（ephemeral）存储中。
    // 始终先检查它，确保外部 auth 优先于任何持久化凭据。
    let ephemeral_storage = create_auth_storage(
        codex_home.to_path_buf(),
        AuthCredentialsStoreMode::Ephemeral,
        AuthKeyringBackendKind::default(),
    );
    if let Some(auth_dot_json) = ephemeral_storage.load()? {
        let auth = CodexAuth::from_auth_dot_json(
            codex_home,
            auth_dot_json,
            AuthCredentialsStoreMode::Ephemeral,
            chatgpt_base_url,
            keyring_backend_kind,
            agent_identity_authapi_base_url,
            auth_route_config,
        )
        .await?;
        if let CodexAuth::PersonalAccessToken(auth) = &auth {
            ensure_personal_access_token_workspace_allowed(forced_chatgpt_workspace_id, auth)?;
        }
        return Ok(Some(auth));
    }

    if let Some(access_token) = read_codex_access_token_from_env() {
        return match classify_codex_access_token(&access_token) {
            CodexAccessToken::PersonalAccessToken(access_token) => {
                let auth = PersonalAccessTokenAuth::load(access_token, auth_route_config).await?;
                ensure_personal_access_token_workspace_allowed(forced_chatgpt_workspace_id, &auth)?;
                Ok(Some(CodexAuth::PersonalAccessToken(auth)))
            }
            CodexAccessToken::AgentIdentityJwt(jwt) => {
                CodexAuth::from_agent_identity_jwt_with_authapi_base_url(
                    jwt,
                    chatgpt_base_url,
                    require_agent_identity_authapi_base_url(agent_identity_authapi_base_url)?,
                    auth_route_config,
                )
            }
            .await
            .map(Some),
        };
    }

    // 调用方显式请求 ephemeral auth 时，无持久化 fallback。
    if auth_credentials_store_mode == AuthCredentialsStoreMode::Ephemeral {
        return Ok(None);
    }

    // 回退到配置好的持久化存储（file/keyring/auto），用于托管 auth。
    let storage = create_auth_storage(
        codex_home.to_path_buf(),
        auth_credentials_store_mode,
        keyring_backend_kind,
    );
    let auth_dot_json = match storage.load()? {
        Some(auth) => auth,
        None => return Ok(None),
    };

    let auth = CodexAuth::from_auth_dot_json(
        codex_home,
        auth_dot_json,
        auth_credentials_store_mode,
        chatgpt_base_url,
        keyring_backend_kind,
        agent_identity_authapi_base_url,
        auth_route_config,
    )
    .await?;
    if let CodexAuth::PersonalAccessToken(auth) = &auth {
        ensure_personal_access_token_workspace_allowed(forced_chatgpt_workspace_id, auth)?;
    }
    Ok(Some(auth))
}

// 将刷新后的 tokens 持久化到 auth 存储并更新 last_refresh 时间戳。
fn persist_tokens(
    storage: &Arc<dyn AuthStorageBackend>,
    id_token: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
) -> std::io::Result<AuthDotJson> {
    let mut auth_dot_json = storage
        .load()?
        .ok_or(std::io::Error::other("Token data is not available."))?;

    let tokens = auth_dot_json.tokens.get_or_insert_with(TokenData::default);
    if let Some(id_token) = id_token {
        tokens.id_token = parse_chatgpt_jwt_claims(&id_token).map_err(std::io::Error::other)?;
    }
    if let Some(access_token) = access_token {
        tokens.access_token = access_token;
    }
    if let Some(refresh_token) = refresh_token {
        tokens.refresh_token = refresh_token;
    }
    auth_dot_json.last_refresh = Some(Utc::now());
    storage.save(&auth_dot_json)?;
    Ok(auth_dot_json)
}

// 使用 refresh token 从 auth 服务请求刷新后的 ChatGPT OAuth tokens。
// 调用方负责持久化返回的 tokens。
async fn request_chatgpt_token_refresh(
    refresh_token: String,
    client: &CodexHttpClient,
) -> Result<RefreshResponse, RefreshTokenError> {
    let refresh_request = RefreshRequest {
        client_id: oauth_client_id(),
        grant_type: "refresh_token",
        refresh_token,
    };
    let endpoint = refresh_token_endpoint();

    // 使用共享 client 工厂以包含标准请求头
    let response = client
        .post(endpoint.as_str())
        .header("Content-Type", "application/json")
        .json(&refresh_request)
        .send()
        .await
        .map_err(|err| RefreshTokenError::Transient(std::io::Error::other(err)))?;

    let status = response.status();
    if status.is_success() {
        let refresh_response = response
            .json::<RefreshResponse>()
            .await
            .map_err(|err| RefreshTokenError::Transient(std::io::Error::other(err)))?;
        Ok(refresh_response)
    } else {
        let body = response.text().await.unwrap_or_default();
        tracing::error!("Failed to refresh token: {status}: {body}");
        let failed = classify_refresh_token_failure(&body);
        if status == StatusCode::UNAUTHORIZED || failed.reason != RefreshTokenFailedReason::Other {
            Err(RefreshTokenError::Permanent(failed))
        } else {
            let message = try_parse_error_message(&body);
            Err(RefreshTokenError::Transient(std::io::Error::other(
                format!("Failed to refresh token: {status}: {message}"),
            )))
        }
    }
}

fn classify_refresh_token_failure(body: &str) -> RefreshTokenFailedError {
    let code = extract_refresh_token_error_code(body);

    let normalized_code = code.as_deref().map(str::to_ascii_lowercase);
    let reason = match normalized_code.as_deref() {
        Some("refresh_token_expired") => RefreshTokenFailedReason::Expired,
        Some("refresh_token_reused") => RefreshTokenFailedReason::Exhausted,
        Some("refresh_token_invalidated") => RefreshTokenFailedReason::Revoked,
        _ => RefreshTokenFailedReason::Other,
    };

    if reason == RefreshTokenFailedReason::Other {
        tracing::warn!(
            backend_code = normalized_code.as_deref(),
            backend_body = body,
            "Encountered unknown response while refreshing token"
        );
    }

    let message = match reason {
        RefreshTokenFailedReason::Expired => REFRESH_TOKEN_EXPIRED_MESSAGE.to_string(),
        RefreshTokenFailedReason::Exhausted => REFRESH_TOKEN_REUSED_MESSAGE.to_string(),
        RefreshTokenFailedReason::Revoked => REFRESH_TOKEN_INVALIDATED_MESSAGE.to_string(),
        RefreshTokenFailedReason::Other => REFRESH_TOKEN_UNKNOWN_MESSAGE.to_string(),
    };

    RefreshTokenFailedError::new(reason, message)
}

fn extract_refresh_token_error_code(body: &str) -> Option<String> {
    if body.trim().is_empty() {
        return None;
    }

    let Value::Object(map) = serde_json::from_str::<Value>(body).ok()? else {
        return None;
    };

    if let Some(error_value) = map.get("error") {
        match error_value {
            Value::Object(obj) => {
                if let Some(code) = obj.get("code").and_then(Value::as_str) {
                    return Some(code.to_string());
                }
            }
            Value::String(code) => {
                return Some(code.to_string());
            }
            _ => {}
        }
    }

    map.get("code").and_then(Value::as_str).map(str::to_string)
}

#[derive(Serialize)]
struct RefreshRequest {
    client_id: String,
    grant_type: &'static str,
    refresh_token: String,
}

#[derive(Deserialize, Clone)]
struct RefreshResponse {
    id_token: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
}

// 共享常量：用于 token refresh 流程的 OAuth client_id（Hydra 注册的 Codex CLI 客户端）。
pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// 返回 OAuth client_id，优先读 `CODEX_APP_SERVER_LOGIN_CLIENT_ID` 环境变量覆盖。
pub fn oauth_client_id() -> String {
    std::env::var(CLIENT_ID_OVERRIDE_ENV_VAR)
        .ok()
        .filter(|client_id| !client_id.trim().is_empty())
        .unwrap_or_else(|| CLIENT_ID.to_string())
}

fn refresh_token_endpoint() -> String {
    std::env::var(REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR)
        .unwrap_or_else(|_| REFRESH_TOKEN_URL.to_string())
}

impl AuthDotJson {
    fn from_external_tokens(external: &ExternalAuthTokens) -> std::io::Result<Self> {
        let Some(chatgpt_metadata) = external.chatgpt_metadata() else {
            return Err(std::io::Error::other(
                "external auth tokens are missing ChatGPT metadata",
            ));
        };
        let mut token_info =
            parse_chatgpt_jwt_claims(&external.access_token).map_err(std::io::Error::other)?;
        token_info.chatgpt_account_id = Some(chatgpt_metadata.account_id.clone());
        token_info.chatgpt_plan_type = chatgpt_metadata
            .plan_type
            .as_deref()
            .map(InternalPlanType::from_raw_value)
            .or(token_info.chatgpt_plan_type)
            .or(Some(InternalPlanType::Unknown("unknown".to_string())));
        let tokens = TokenData {
            id_token: token_info,
            access_token: external.access_token.clone(),
            refresh_token: String::new(),
            account_id: Some(chatgpt_metadata.account_id.clone()),
        };

        Ok(Self {
            auth_mode: Some(AuthMode::ChatgptAuthTokens),
            openai_api_key: None,
            tokens: Some(tokens),
            last_refresh: Some(Utc::now()),
            agent_identity: None,
            personal_access_token: None,
            bedrock_api_key: None,
        })
    }

    fn from_external_access_token(
        access_token: &str,
        chatgpt_account_id: &str,
        chatgpt_plan_type: Option<&str>,
    ) -> std::io::Result<Self> {
        let external = ExternalAuthTokens::chatgpt(
            access_token,
            chatgpt_account_id,
            chatgpt_plan_type.map(str::to_string),
        );
        Self::from_external_tokens(&external)
    }

    pub(super) fn resolved_mode(&self) -> AuthMode {
        if let Some(mode) = self.auth_mode {
            return mode;
        }
        if self.personal_access_token.is_some() {
            return AuthMode::PersonalAccessToken;
        }
        if self.bedrock_api_key.is_some() {
            return AuthMode::BedrockApiKey;
        }
        if self.openai_api_key.is_some() {
            return AuthMode::ApiKey;
        }
        AuthMode::Chatgpt
    }

    fn storage_mode(
        &self,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
    ) -> AuthCredentialsStoreMode {
        if self.resolved_mode() == AuthMode::ChatgptAuthTokens {
            AuthCredentialsStoreMode::Ephemeral
        } else {
            auth_credentials_store_mode
        }
    }
}

/// 内部缓存的 auth 状态。
#[derive(Clone)]
struct CachedAuth {
    /// 当前缓存的 `CodexAuth` 快照（可能为 `None` 表示未登录）。
    auth: Option<CodexAuth>,
    /// 永久性 refresh 失败缓存（与当前 auth 快照绑定），
    /// 后续相同凭据的 refresh 会直接快速失败，不再发起网络请求。
    permanent_refresh_failure: Option<AuthScopedRefreshFailure>,
}

/// 与某份 `CodexAuth` 快照绑定的永久性 refresh 失败记录。
#[derive(Clone)]
struct AuthScopedRefreshFailure {
    /// 触发失败的 auth 快照。
    auth: CodexAuth,
    /// 失败原因与面向用户的消息。
    error: RefreshTokenFailedError,
}

impl Debug for CachedAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CachedAuth")
            .field(
                "auth_mode",
                &self.auth.as_ref().map(CodexAuth::api_auth_mode),
            )
            .field(
                "permanent_refresh_failure",
                &self
                    .permanent_refresh_failure
                    .as_ref()
                    .map(|failure| failure.error.reason),
            )
            .finish()
    }
}

enum UnauthorizedRecoveryStep {
    Reload,
    RefreshToken,
    ExternalRefresh,
    Done,
}

enum ReloadOutcome {
    /// 重载已完成，且缓存的 auth 发生了变化。
    ReloadedChanged,
    /// 重载已完成，但缓存的 auth 未变化。
    ReloadedNoChange,
    /// 跳过重载（无 auth 或 account ID 不匹配）。
    Skipped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UnauthorizedRecoveryMode {
    Managed,
    External,
}

// `UnauthorizedRecovery` 是一个状态机：当请求 API 收到 401 时尝试恢复认证。
// 客户端在每次重试时调用一次 `next()`。
// 对 API key 认证不做任何处理，直接将错误抛给用户。
//
// 对 ChatGPT 认证，会依次：
// 1. 尝试从磁盘重新加载 auth 数据。仅当 account ID 与当前进程一致时才重载。
// 2. 通过 OAuth token refresh 流程刷新 token。
// 若两步后服务端仍返回 401，则将错误抛给用户。
//
// 对外部 auth 源，`UnauthorizedRecovery` 仅重试一次：
//
// - 外部 ChatGPT auth tokens（`chatgptAuthTokens`）通过配置好的
//   `ExternalAuth` 请求父应用提供新 tokens，写入 ephemeral auth store，
//   再重新加载缓存的 auth 快照。
// - 自定义 model provider 的外部 bearer auth 源会重新运行 provider auth
//   命令，不触碰磁盘。
pub struct UnauthorizedRecovery {
    manager: Arc<AuthManager>,
    step: UnauthorizedRecoveryStep,
    expected_account_id: Option<String>,
    mode: UnauthorizedRecoveryMode,
}

/// `UnauthorizedRecovery::next()` 单步执行的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnauthorizedRecoveryStepResult {
    /// 是否导致 auth 状态变化；`None` 表示状态机已耗尽、未执行任何步骤。
    auth_state_changed: Option<bool>,
}

impl UnauthorizedRecoveryStepResult {
    /// 返回本步骤是否改变了 auth 状态；`None` 表示未执行。
    pub fn auth_state_changed(&self) -> Option<bool> {
        self.auth_state_changed
    }
}

impl UnauthorizedRecovery {
    fn new(manager: Arc<AuthManager>) -> Self {
        let cached_auth = manager.auth_cached();
        let expected_account_id = cached_auth.as_ref().and_then(CodexAuth::get_account_id);
        let mode = if manager.has_external_api_key_auth()
            || cached_auth
                .as_ref()
                .is_some_and(CodexAuth::is_external_chatgpt_tokens)
        {
            UnauthorizedRecoveryMode::External
        } else {
            UnauthorizedRecoveryMode::Managed
        };
        let step = match mode {
            UnauthorizedRecoveryMode::Managed => UnauthorizedRecoveryStep::Reload,
            UnauthorizedRecoveryMode::External => UnauthorizedRecoveryStep::ExternalRefresh,
        };
        Self {
            manager,
            step,
            expected_account_id,
            mode,
        }
    }

    /// 是否还有可执行的恢复步骤。
    pub fn has_next(&self) -> bool {
        if self.manager.has_external_api_key_auth() {
            return !matches!(self.step, UnauthorizedRecoveryStep::Done);
        }

        if !self
            .manager
            .auth_cached()
            .as_ref()
            .is_some_and(CodexAuth::supports_unauthorized_recovery)
        {
            return false;
        }

        if self.mode == UnauthorizedRecoveryMode::External && !self.manager.has_external_auth() {
            return false;
        }

        !matches!(self.step, UnauthorizedRecoveryStep::Done)
    }

    /// 返回当前不可用的原因字符串，供观测/日志使用。
    pub fn unavailable_reason(&self) -> &'static str {
        if self.manager.has_external_api_key_auth() {
            return if matches!(self.step, UnauthorizedRecoveryStep::Done) {
                "recovery_exhausted"
            } else {
                "ready"
            };
        }

        if self
            .manager
            .auth_cached()
            .as_ref()
            .is_some_and(CodexAuth::is_personal_access_token_auth)
        {
            return "not_refreshable_auth";
        }

        if !self
            .manager
            .auth_cached()
            .as_ref()
            .is_some_and(CodexAuth::supports_unauthorized_recovery)
        {
            return "not_chatgpt_auth";
        }

        if self.mode == UnauthorizedRecoveryMode::External && !self.manager.has_external_auth() {
            return "no_external_auth";
        }

        if matches!(self.step, UnauthorizedRecoveryStep::Done) {
            return "recovery_exhausted";
        }

        "ready"
    }

    /// 返回当前恢复模式名称（`"managed"` / `"external"`），供观测使用。
    pub fn mode_name(&self) -> &'static str {
        match self.mode {
            UnauthorizedRecoveryMode::Managed => "managed",
            UnauthorizedRecoveryMode::External => "external",
        }
    }

    /// 返回当前步骤名称（`reload` / `refresh_token` / `external_refresh` / `done`），供观测使用。
    pub fn step_name(&self) -> &'static str {
        match self.step {
            UnauthorizedRecoveryStep::Reload => "reload",
            UnauthorizedRecoveryStep::RefreshToken => "refresh_token",
            UnauthorizedRecoveryStep::ExternalRefresh => "external_refresh",
            UnauthorizedRecoveryStep::Done => "done",
        }
    }

    /// 执行下一步恢复；返回该步骤是否改变了 auth 状态。
    ///
    /// 若已无步骤可执行，则返回 `Permanent` 错误。
    pub async fn next(&mut self) -> Result<UnauthorizedRecoveryStepResult, RefreshTokenError> {
        if !self.has_next() {
            return Err(RefreshTokenError::Permanent(RefreshTokenFailedError::new(
                RefreshTokenFailedReason::Other,
                "No more recovery steps available.",
            )));
        }

        match self.step {
            UnauthorizedRecoveryStep::Reload => {
                match self
                    .manager
                    .reload_if_account_id_matches(self.expected_account_id.as_deref())
                    .await
                {
                    ReloadOutcome::ReloadedChanged => {
                        self.step = UnauthorizedRecoveryStep::RefreshToken;
                        return Ok(UnauthorizedRecoveryStepResult {
                            auth_state_changed: Some(true),
                        });
                    }
                    ReloadOutcome::ReloadedNoChange => {
                        self.step = UnauthorizedRecoveryStep::RefreshToken;
                        return Ok(UnauthorizedRecoveryStepResult {
                            auth_state_changed: Some(false),
                        });
                    }
                    ReloadOutcome::Skipped => {
                        self.step = UnauthorizedRecoveryStep::Done;
                        return Err(RefreshTokenError::Permanent(RefreshTokenFailedError::new(
                            RefreshTokenFailedReason::Other,
                            REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE.to_string(),
                        )));
                    }
                }
            }
            UnauthorizedRecoveryStep::RefreshToken => {
                self.manager.refresh_token_from_authority().await?;
                self.step = UnauthorizedRecoveryStep::Done;
                return Ok(UnauthorizedRecoveryStepResult {
                    auth_state_changed: Some(true),
                });
            }
            UnauthorizedRecoveryStep::ExternalRefresh => {
                self.manager
                    .refresh_external_auth(ExternalAuthRefreshReason::Unauthorized)
                    .await?;
                self.step = UnauthorizedRecoveryStep::Done;
                return Ok(UnauthorizedRecoveryStepResult {
                    auth_state_changed: Some(true),
                });
            }
            UnauthorizedRecoveryStep::Done => {}
        }
        Ok(UnauthorizedRecoveryStepResult {
            auth_state_changed: None,
        })
    }
}

/// 认证管理器：作为 `auth.json` 派生认证数据的单一可信源。
///
/// 启动时（或配置变更时）加载一次，后续通过克隆 `CodexAuth` 快照分发给程序其他部分，
/// 保证全程序看到一致的认证状态。
///
/// 对 `auth.json` 的外部修改**不会**被自动观察；需要显式调用 `reload()` 才会生效。
/// 这符合"避免程序不同部分在运行中看到不一致 auth 数据"的设计目标。
pub struct AuthManager {
    codex_home: PathBuf,
    inner: RwLock<CachedAuth>,
    auth_change_tx: watch::Sender<u64>,
    enable_codex_api_key_env: bool,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    forced_chatgpt_workspace_id: RwLock<Option<Vec<String>>>,
    chatgpt_base_url: Option<String>,
    agent_identity_authapi_base_url: Option<String>,
    refresh_lock: Semaphore,
    agent_identity_lock: Semaphore,
    agent_identity_bootstrap_cooldown: Mutex<AgentIdentityBootstrapCooldown>,
    external_auth: RwLock<Option<Arc<dyn ExternalAuth>>>,
    auth_route_config: Option<AuthRouteConfig>,
}

/// 构造共享 [`AuthManager`] 所需的配置视图 trait。
///
/// 实现方应返回已解析运行时配置中的 auth 相关字段。主要实现是
/// `codex_core::config::Config`，本 trait 让 `codex-login` 不直接依赖 `codex-core`。
pub trait AuthManagerConfig {
    /// 返回用于 auth 存储的 Codex home 目录。
    fn codex_home(&self) -> PathBuf;

    /// 返回 CLI auth 凭据存储模式。
    fn cli_auth_credentials_store_mode(&self) -> AuthCredentialsStoreMode;

    /// 返回 CLI auth 选择 keyring 存储时使用的后端类型。
    fn auth_keyring_backend_kind(&self) -> AuthKeyringBackendKind;

    /// 返回可选的 ChatGPT workspace ID 限制列表。
    fn forced_chatgpt_workspace_id(&self) -> Option<Vec<String>>;

    /// 返回第一方 backend 授权所用的 ChatGPT backend base URL。
    fn chatgpt_base_url(&self) -> String;

    /// 返回 auth 专用客户端的路由选择设置。
    fn auth_route_config(&self) -> Option<AuthRouteConfig>;
}

impl Debug for AuthManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthManager")
            .field("codex_home", &self.codex_home)
            .field("inner", &self.inner)
            .field("enable_codex_api_key_env", &self.enable_codex_api_key_env)
            .field(
                "auth_credentials_store_mode",
                &self.auth_credentials_store_mode,
            )
            .field("keyring_backend_kind", &self.keyring_backend_kind)
            .field(
                "forced_chatgpt_workspace_id",
                &self.forced_chatgpt_workspace_id,
            )
            .field("chatgpt_base_url", &self.chatgpt_base_url)
            .field("auth_route_config", &self.auth_route_config)
            .field("has_external_auth", &self.has_external_auth())
            .finish_non_exhaustive()
    }
}

fn default_agent_identity_authapi_base_url() -> Option<String> {
    agent_identity_authapi_base_url(/*chatgpt_base_url*/ None).ok()
}

impl AuthManager {
    /// 创建新的 manager，使用提供的首选 auth 方式加载初始 auth。
    ///
    /// 加载 auth 时的错误会被吞掉；此时 `auth()` 会返回 `None`，调用方可将其
    /// 视为未登录状态。
    pub async fn new(
        codex_home: PathBuf,
        enable_codex_api_key_env: bool,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        forced_chatgpt_workspace_id: Option<Vec<String>>,
        chatgpt_base_url: Option<String>,
        keyring_backend_kind: AuthKeyringBackendKind,
        auth_route_config: Option<AuthRouteConfig>,
    ) -> Self {
        let agent_identity_authapi_base_url =
            agent_identity_authapi_base_url(chatgpt_base_url.as_deref()).ok();
        let managed_auth = load_auth(
            &codex_home,
            enable_codex_api_key_env,
            auth_credentials_store_mode,
            forced_chatgpt_workspace_id.as_deref(),
            chatgpt_base_url.as_deref(),
            keyring_backend_kind,
            agent_identity_authapi_base_url.as_deref(),
            auth_route_config.as_ref(),
        )
        .await
        .ok()
        .flatten();
        let (auth_change_tx, _auth_change_rx) = watch::channel(0);
        Self {
            codex_home,
            inner: RwLock::new(CachedAuth {
                auth: managed_auth,
                permanent_refresh_failure: None,
            }),
            auth_change_tx,
            enable_codex_api_key_env,
            auth_credentials_store_mode,
            keyring_backend_kind,
            forced_chatgpt_workspace_id: RwLock::new(forced_chatgpt_workspace_id),
            chatgpt_base_url,
            agent_identity_authapi_base_url,
            refresh_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_bootstrap_cooldown: Mutex::default(),
            external_auth: RwLock::new(None),
            auth_route_config,
        }
    }

    /// 用指定 `CodexAuth` 构造 manager，仅用于测试。
    pub fn from_auth_for_testing(auth: CodexAuth) -> Arc<Self> {
        let cached = CachedAuth {
            auth: Some(auth),
            permanent_refresh_failure: None,
        };
        let (auth_change_tx, _auth_change_rx) = watch::channel(0);

        Arc::new(Self {
            codex_home: PathBuf::from("non-existent"),
            inner: RwLock::new(cached),
            auth_change_tx,
            enable_codex_api_key_env: false,
            auth_credentials_store_mode: AuthCredentialsStoreMode::File,
            keyring_backend_kind: AuthKeyringBackendKind::default(),
            forced_chatgpt_workspace_id: RwLock::new(None),
            chatgpt_base_url: None,
            agent_identity_authapi_base_url: default_agent_identity_authapi_base_url(),
            refresh_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_bootstrap_cooldown: Mutex::default(),
            external_auth: RwLock::new(None),
            auth_route_config: None,
        })
    }

    /// 用指定 `CodexAuth` 与 codex home 构造 manager，仅用于测试。
    pub fn from_auth_for_testing_with_home(auth: CodexAuth, codex_home: PathBuf) -> Arc<Self> {
        let cached = CachedAuth {
            auth: Some(auth),
            permanent_refresh_failure: None,
        };
        let (auth_change_tx, _auth_change_rx) = watch::channel(0);
        Arc::new(Self {
            codex_home,
            inner: RwLock::new(cached),
            auth_change_tx,
            enable_codex_api_key_env: false,
            auth_credentials_store_mode: AuthCredentialsStoreMode::File,
            keyring_backend_kind: AuthKeyringBackendKind::default(),
            forced_chatgpt_workspace_id: RwLock::new(None),
            chatgpt_base_url: None,
            agent_identity_authapi_base_url: default_agent_identity_authapi_base_url(),
            refresh_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_bootstrap_cooldown: Mutex::default(),
            external_auth: RwLock::new(None),
            auth_route_config: None,
        })
    }

    /// 用指定 `CodexAuth` 与 Agent Identity AuthAPI base URL 构造 manager，仅用于测试。
    #[doc(hidden)]
    pub fn from_auth_for_testing_with_agent_identity_authapi_base_url(
        auth: CodexAuth,
        agent_identity_authapi_base_url: String,
    ) -> Arc<Self> {
        let cached = CachedAuth {
            auth: Some(auth),
            permanent_refresh_failure: None,
        };
        let (auth_change_tx, _auth_change_rx) = watch::channel(0);
        Arc::new(Self {
            codex_home: PathBuf::from("non-existent"),
            inner: RwLock::new(cached),
            auth_change_tx,
            enable_codex_api_key_env: false,
            auth_credentials_store_mode: AuthCredentialsStoreMode::File,
            keyring_backend_kind: AuthKeyringBackendKind::default(),
            forced_chatgpt_workspace_id: RwLock::new(None),
            chatgpt_base_url: None,
            agent_identity_authapi_base_url: Some(
                agent_identity_authapi_base_url
                    .trim_end_matches('/')
                    .to_string(),
            ),
            refresh_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_bootstrap_cooldown: Mutex::default(),
            external_auth: RwLock::new(None),
            auth_route_config: None,
        })
    }

    /// 构造一个仅支持外部 bearer auth 的 manager（无 codex_home，仅内存）。
    pub fn external_bearer_only(config: ModelProviderAuthInfo) -> Arc<Self> {
        let (auth_change_tx, _auth_change_rx) = watch::channel(0);
        Arc::new(Self {
            codex_home: PathBuf::from("non-existent"),
            inner: RwLock::new(CachedAuth {
                auth: None,
                permanent_refresh_failure: None,
            }),
            auth_change_tx,
            enable_codex_api_key_env: false,
            auth_credentials_store_mode: AuthCredentialsStoreMode::File,
            keyring_backend_kind: AuthKeyringBackendKind::default(),
            forced_chatgpt_workspace_id: RwLock::new(None),
            chatgpt_base_url: None,
            agent_identity_authapi_base_url: default_agent_identity_authapi_base_url(),
            refresh_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_lock: Semaphore::new(/*permits*/ 1),
            agent_identity_bootstrap_cooldown: Mutex::default(),
            external_auth: RwLock::new(Some(
                Arc::new(BearerTokenRefresher::new(config)) as Arc<dyn ExternalAuth>
            )),
            auth_route_config: None,
        })
    }

    /// 返回当前缓存的 auth（克隆），不尝试 refresh。
    pub fn auth_cached(&self) -> Option<CodexAuth> {
        self.inner.read().ok().and_then(|c| c.auth.clone())
    }

    /// 订阅缓存 auth 变更通知，便于请求恢复等场景感知状态变化。
    pub fn auth_change_receiver(&self) -> watch::Receiver<u64> {
        self.auth_change_tx.subscribe()
    }

    /// 返回与指定 auth 快照绑定的永久 refresh 失败信息（若已缓存）。
    pub fn refresh_failure_for_auth(&self, auth: &CodexAuth) -> Option<RefreshTokenFailedError> {
        self.inner.read().ok().and_then(|cached| {
            cached
                .permanent_refresh_failure
                .as_ref()
                .filter(|failure| Self::auths_equal_for_refresh(Some(auth), Some(&failure.auth)))
                .map(|failure| failure.error.clone())
        })
    }

    /// 返回当前缓存的 auth（克隆）。可能为 `None`（未登录或加载失败）。
    ///
    /// 对需要 proactive refresh 的托管 ChatGPT auth，会先执行一次受保护的 reload，
    /// 仅当磁盘上的 auth 未变化时才发起 refresh。
    #[instrument(level = "trace", skip_all)]
    pub async fn auth(&self) -> Option<CodexAuth> {
        if let Some(auth) = self.resolve_external_api_key_auth().await {
            return Some(auth);
        }

        let auth = self.auth_cached()?;
        if Self::should_refresh_proactively(&auth)
            && let Err(err) = self.refresh_token().await
        {
            tracing::error!("Failed to refresh token: {}", err);
            return Some(auth);
        }
        self.auth_cached()
    }

    /// 解析 Agent Identity auth。
    ///
    /// - `policy`：`JwtOnly` 仅复用现有 JWT；`ChatGptAuth` 允许从托管 ChatGPT 注册/复用。
    /// - `session_source`：标识本次调用的来源（CLI / desktop / ...），用于遥测。
    ///
    /// 对托管 ChatGPT auth，会按冷却策略抑制短时间内的重复 bootstrap 尝试。
    pub async fn agent_identity_auth(
        &self,
        policy: AgentIdentityAuthPolicy,
        session_source: SessionSource,
    ) -> std::io::Result<Option<AgentIdentityAuth>> {
        let Some(auth) = self.auth().await else {
            return Ok(None);
        };
        if policy == AgentIdentityAuthPolicy::ChatGptAuth && matches!(auth, CodexAuth::Chatgpt(_)) {
            let _bootstrap_permit = self
                .agent_identity_lock
                .acquire()
                .await
                .map_err(std::io::Error::other)?;
            let forced_chatgpt_workspace_id = self.forced_chatgpt_workspace_id();
            let cooldown_key = ManagedChatGptAgentIdentityBinding::from_auth(
                &auth,
                forced_chatgpt_workspace_id.clone(),
            )
            .and_then(|binding| {
                self.agent_identity_authapi_base_url
                    .as_ref()
                    .map(|base_url| (binding.account_id, base_url.clone()))
            });
            if let Some((account_id, authapi_base_url)) = cooldown_key.as_ref()
                && let Ok(mut cooldown) = self.agent_identity_bootstrap_cooldown.lock()
                && let Some(error) =
                    cooldown.error_for(account_id, authapi_base_url, Instant::now())
            {
                tracing::warn!("agent identity bootstrap retry suppressed during shared cooldown");
                return Err(std::io::Error::other(error));
            }

            let result = auth
                .agent_identity_auth(
                    policy,
                    self.agent_identity_authapi_base_url.as_deref(),
                    forced_chatgpt_workspace_id,
                    self.auth_route_config.as_ref(),
                    session_source,
                )
                .await;
            if let Ok(mut cooldown) = self.agent_identity_bootstrap_cooldown.lock() {
                if let (Err(err), Some((account_id, authapi_base_url))) = (&result, cooldown_key)
                    && let Some(error) = AgentIdentityAuthError::bootstrap_unavailable(err).cloned()
                {
                    cooldown.record_failure(account_id, authapi_base_url, error, Instant::now());
                } else {
                    cooldown.clear();
                }
            }
            return result;
        }
        auth.agent_identity_auth(
            policy,
            self.agent_identity_authapi_base_url.as_deref(),
            self.forced_chatgpt_workspace_id(),
            self.auth_route_config.as_ref(),
            session_source,
        )
        .await
    }

    /// 强制从 auth.json 重新加载 auth 信息。返回 auth 值是否发生变化。
    pub async fn reload(&self) -> bool {
        tracing::info!("Reloading auth");
        let new_auth = self.load_auth_from_storage().await;
        self.set_cached_auth(new_auth)
    }

    async fn reload_if_account_id_matches(
        &self,
        expected_account_id: Option<&str>,
    ) -> ReloadOutcome {
        let expected_account_id = match expected_account_id {
            Some(account_id) => account_id,
            None => {
                tracing::info!("Skipping auth reload because no account id is available.");
                return ReloadOutcome::Skipped;
            }
        };

        let new_auth = self.load_auth_from_storage().await;
        let new_account_id = new_auth.as_ref().and_then(CodexAuth::get_account_id);

        if new_account_id.as_deref() != Some(expected_account_id) {
            let found_account_id = new_account_id.as_deref().unwrap_or("unknown");
            tracing::info!(
                "Skipping auth reload due to account id mismatch (expected: {expected_account_id}, found: {found_account_id})"
            );
            return ReloadOutcome::Skipped;
        }

        tracing::info!("Reloading auth for account {expected_account_id}");
        let cached_before_reload = self.auth_cached();
        let auth_changed =
            !Self::auths_equal_for_refresh(cached_before_reload.as_ref(), new_auth.as_ref());
        self.set_cached_auth(new_auth);
        if auth_changed {
            ReloadOutcome::ReloadedChanged
        } else {
            ReloadOutcome::ReloadedNoChange
        }
    }

    fn auths_equal_for_refresh(a: Option<&CodexAuth>, b: Option<&CodexAuth>) -> bool {
        match (a, b) {
            (None, None) => true,
            (Some(a), Some(b)) => match (a.api_auth_mode(), b.api_auth_mode()) {
                (AuthMode::ApiKey, AuthMode::ApiKey) => a.api_key() == b.api_key(),
                (AuthMode::Chatgpt, AuthMode::Chatgpt)
                | (AuthMode::ChatgptAuthTokens, AuthMode::ChatgptAuthTokens) => {
                    a.get_current_auth_json() == b.get_current_auth_json()
                }
                (AuthMode::AgentIdentity, AuthMode::AgentIdentity) => match (a, b) {
                    (CodexAuth::AgentIdentity(a), CodexAuth::AgentIdentity(b)) => {
                        a.record() == b.record()
                    }
                    _ => false,
                },
                (AuthMode::PersonalAccessToken, AuthMode::PersonalAccessToken) => a == b,
                (AuthMode::BedrockApiKey, AuthMode::BedrockApiKey) => a == b,
                _ => false,
            },
            _ => false,
        }
    }

    fn auths_equal(a: Option<&CodexAuth>, b: Option<&CodexAuth>) -> bool {
        match (a, b) {
            (None, None) => true,
            (Some(a), Some(b)) => a == b,
            _ => false,
        }
    }

    /// 仅当失败的 refresh 是针对仍缓存的 auth 快照发起时，才记录永久 refresh 失败。
    fn record_permanent_refresh_failure_if_unchanged(
        &self,
        attempted_auth: &CodexAuth,
        error: &RefreshTokenFailedError,
    ) {
        if let Ok(mut guard) = self.inner.write() {
            let current_auth_matches =
                Self::auths_equal_for_refresh(Some(attempted_auth), guard.auth.as_ref());
            if current_auth_matches {
                guard.permanent_refresh_failure = Some(AuthScopedRefreshFailure {
                    auth: attempted_auth.clone(),
                    error: error.clone(),
                });
            }
        }
    }

    async fn load_auth_from_storage(&self) -> Option<CodexAuth> {
        let forced_chatgpt_workspace_id = self.forced_chatgpt_workspace_id();
        load_auth(
            &self.codex_home,
            self.enable_codex_api_key_env,
            self.auth_credentials_store_mode,
            forced_chatgpt_workspace_id.as_deref(),
            self.chatgpt_base_url.as_deref(),
            self.keyring_backend_kind,
            self.agent_identity_authapi_base_url.as_deref(),
            self.auth_route_config.as_ref(),
        )
        .await
        .ok()
        .flatten()
    }

    fn set_cached_auth(&self, new_auth: Option<CodexAuth>) -> bool {
        if let Ok(mut guard) = self.inner.write() {
            let previous = guard.auth.as_ref();
            let changed = !AuthManager::auths_equal(previous, new_auth.as_ref());
            let auth_changed_for_refresh =
                !Self::auths_equal_for_refresh(previous, new_auth.as_ref());
            if auth_changed_for_refresh {
                guard.permanent_refresh_failure = None;
            }
            tracing::info!("Reloaded auth, changed: {changed}");
            guard.auth = new_auth;
            if auth_changed_for_refresh {
                self.auth_change_tx.send_modify(|revision| *revision += 1);
            }
            changed
        } else {
            false
        }
    }

    /// 设置外部 auth provider（用于外部托管 ChatGPT tokens 或外部 bearer auth）。
    pub fn set_external_auth(&self, external_auth: Arc<dyn ExternalAuth>) {
        if let Ok(mut guard) = self.external_auth.write() {
            *guard = Some(external_auth);
        }
    }

    /// 清除外部 auth provider。
    pub fn clear_external_auth(&self) {
        if let Ok(mut guard) = self.external_auth.write() {
            *guard = None;
        }
    }

    /// 设置强制 ChatGPT workspace ID 限制。
    pub fn set_forced_chatgpt_workspace_id(&self, workspace_id: Option<Vec<String>>) {
        if let Ok(mut guard) = self.forced_chatgpt_workspace_id.write()
            && *guard != workspace_id
        {
            *guard = workspace_id;
        }
    }

    /// 返回当前强制 ChatGPT workspace ID 限制的克隆。
    pub fn forced_chatgpt_workspace_id(&self) -> Option<Vec<String>> {
        self.forced_chatgpt_workspace_id
            .read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    /// 是否已配置外部 auth provider。
    pub fn has_external_auth(&self) -> bool {
        self.external_auth().is_some()
    }

    /// 当前缓存 auth 是否为外部托管的 ChatGPT tokens。
    pub fn is_external_chatgpt_auth_active(&self) -> bool {
        self.auth_cached()
            .as_ref()
            .is_some_and(CodexAuth::is_external_chatgpt_tokens)
    }

    /// 是否启用了 `CODEX_API_KEY` 环境变量读取。
    pub fn codex_api_key_env_enabled(&self) -> bool {
        self.enable_codex_api_key_env
    }

    /// 便捷构造方法：返回 `Arc` 包装的 manager。
    pub async fn shared(
        codex_home: PathBuf,
        enable_codex_api_key_env: bool,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        forced_chatgpt_workspace_id: Option<Vec<String>>,
        chatgpt_base_url: Option<String>,
        keyring_backend_kind: AuthKeyringBackendKind,
        auth_route_config: Option<AuthRouteConfig>,
    ) -> Arc<Self> {
        Arc::new(
            Self::new(
                codex_home,
                enable_codex_api_key_env,
                auth_credentials_store_mode,
                forced_chatgpt_workspace_id,
                chatgpt_base_url,
                keyring_backend_kind,
                auth_route_config,
            )
            .await,
        )
    }

    /// 便捷构造方法：从已解析的 config 构造 `Arc` 包装的 manager。
    pub async fn shared_from_config(
        config: &impl AuthManagerConfig,
        enable_codex_api_key_env: bool,
    ) -> Arc<Self> {
        Self::shared(
            config.codex_home(),
            enable_codex_api_key_env,
            config.cli_auth_credentials_store_mode(),
            config.forced_chatgpt_workspace_id(),
            Some(config.chatgpt_base_url()),
            config.auth_keyring_backend_kind(),
            config.auth_route_config(),
        )
        .await
    }

    /// 创建一个用于驱动 401 恢复流程的 `UnauthorizedRecovery` 状态机。
    pub fn unauthorized_recovery(self: &Arc<Self>) -> UnauthorizedRecovery {
        UnauthorizedRecovery::new(Arc::clone(self))
    }

    fn external_auth(&self) -> Option<Arc<dyn ExternalAuth>> {
        self.external_auth
            .read()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
    }

    fn external_auth_mode(&self) -> Option<AuthMode> {
        self.external_auth()
            .as_ref()
            .map(|external_auth| external_auth.auth_mode())
    }

    fn has_external_api_key_auth(&self) -> bool {
        self.external_auth_mode() == Some(AuthMode::ApiKey)
    }

    async fn resolve_external_api_key_auth(&self) -> Option<CodexAuth> {
        if !self.has_external_api_key_auth() {
            return None;
        }

        let external_auth = self.external_auth()?;

        match external_auth.resolve().await {
            Ok(Some(tokens)) => Some(CodexAuth::from_api_key(&tokens.access_token)),
            Ok(None) => None,
            Err(err) => {
                tracing::error!("Failed to resolve external API key auth: {err}");
                None
            }
        }
    }

    /// 尝试刷新 token：先执行受保护的 reload（仅当 account ID 匹配缓存时才重载）。
    ///
    /// 若持久化 token 与缓存不同，可认为其他实例已刷新过；若相同，则请求 token
    /// 颁发方执行刷新。
    pub async fn refresh_token(&self) -> Result<(), RefreshTokenError> {
        let _refresh_guard = self.refresh_lock.acquire().await.map_err(|_| {
            RefreshTokenError::Permanent(RefreshTokenFailedError::new(
                RefreshTokenFailedReason::Other,
                REFRESH_TOKEN_UNKNOWN_MESSAGE.to_string(),
            ))
        })?;
        let auth_before_reload = self.auth_cached();
        if auth_before_reload
            .as_ref()
            .is_some_and(|auth| auth.is_api_key_auth() || auth.is_personal_access_token_auth())
        {
            return Ok(());
        }
        let expected_account_id = auth_before_reload
            .as_ref()
            .and_then(CodexAuth::get_account_id);

        match self
            .reload_if_account_id_matches(expected_account_id.as_deref())
            .await
        {
            ReloadOutcome::ReloadedChanged => {
                tracing::info!("Skipping token refresh because auth changed after guarded reload.");
                Ok(())
            }
            ReloadOutcome::ReloadedNoChange => self.refresh_token_from_authority_impl().await,
            ReloadOutcome::Skipped => {
                Err(RefreshTokenError::Permanent(RefreshTokenFailedError::new(
                    RefreshTokenFailedReason::Other,
                    REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE.to_string(),
                )))
            }
        }
    }

    /// 请求 token 颁发方刷新当前 auth token。
    ///
    /// 成功后会从磁盘重新加载 auth 状态，使其他组件观察到新 token。
    /// 失败时将错误返回给调用方。
    pub async fn refresh_token_from_authority(&self) -> Result<(), RefreshTokenError> {
        let _refresh_guard = self.refresh_lock.acquire().await.map_err(|_| {
            RefreshTokenError::Permanent(RefreshTokenFailedError::new(
                RefreshTokenFailedReason::Other,
                REFRESH_TOKEN_UNKNOWN_MESSAGE.to_string(),
            ))
        })?;
        self.refresh_token_from_authority_impl().await
    }

    async fn refresh_token_from_authority_impl(&self) -> Result<(), RefreshTokenError> {
        tracing::info!("Refreshing token");

        let auth = match self.auth_cached() {
            Some(auth) => auth,
            None => return Ok(()),
        };
        if let Some(error) = self.refresh_failure_for_auth(&auth) {
            return Err(RefreshTokenError::Permanent(error));
        }

        let attempted_auth = auth.clone();
        let result = match auth {
            CodexAuth::ChatgptAuthTokens(_) => {
                self.refresh_external_auth(ExternalAuthRefreshReason::Unauthorized)
                    .await
            }
            CodexAuth::Chatgpt(chatgpt_auth) => {
                let token_data = chatgpt_auth.current_token_data().ok_or_else(|| {
                    RefreshTokenError::Transient(std::io::Error::other(
                        "Token data is not available.",
                    ))
                })?;
                self.refresh_and_persist_chatgpt_token(&chatgpt_auth, token_data.refresh_token)
                    .await
            }
            CodexAuth::ApiKey(_)
            | CodexAuth::AgentIdentity(_)
            | CodexAuth::PersonalAccessToken(_)
            | CodexAuth::BedrockApiKey(_) => Ok(()),
        };
        if let Err(RefreshTokenError::Permanent(error)) = &result {
            self.record_permanent_refresh_failure_if_unchanged(&attempted_auth, error);
        }
        result
    }

    /// 登出：删除磁盘上的 auth.json（若存在）。
    ///
    /// 返回 `Ok(true)` 表示删除了文件，`Ok(false)` 表示文件本就不存在。
    /// 成功后会重新加载内存缓存，使调用方立即观察到未登录状态。
    pub async fn logout(&self) -> std::io::Result<bool> {
        let removed = logout_all_stores(
            &self.codex_home,
            self.auth_credentials_store_mode,
            self.keyring_backend_kind,
        )?;
        // 始终 reload 以清除任何缓存 auth（即使文件不存在）。
        self.reload().await;
        Ok(removed)
    }

    /// 登出并尝试撤销服务端 tokens。
    ///
    /// 即使撤销失败也会继续删除本地存储，避免遗留无效凭据。
    pub async fn logout_with_revoke(&self) -> std::io::Result<bool> {
        let auth_dot_json = self
            .auth_cached()
            .and_then(|auth| auth.get_current_auth_json());
        if let Err(err) =
            revoke_auth_tokens(auth_dot_json.as_ref(), self.auth_route_config.as_ref()).await
        {
            tracing::warn!("failed to revoke auth tokens during logout: {err}");
        }
        let result = logout_all_stores(
            &self.codex_home,
            self.auth_credentials_store_mode,
            self.keyring_backend_kind,
        )?;
        // 始终 reload 以清除任何缓存 auth（即使文件不存在）。
        self.reload().await;
        Ok(result)
    }

    /// 返回当前认证背后的精确凭据类型（含外部 API key 优先逻辑）。
    pub fn get_api_auth_mode(&self) -> Option<AuthMode> {
        if self.has_external_api_key_auth() {
            return Some(AuthMode::ApiKey);
        }
        self.auth_cached().as_ref().map(CodexAuth::api_auth_mode)
    }

    /// 返回当前认证的有效 backend auth mode（含外部 API key 优先逻辑）。
    pub fn auth_mode(&self) -> Option<AuthMode> {
        if self.has_external_api_key_auth() {
            return Some(AuthMode::ApiKey);
        }
        self.auth_cached().as_ref().map(CodexAuth::auth_mode)
    }

    /// 当前 auth 是否使用 Codex backend（非自定义 model provider）。
    pub fn current_auth_uses_codex_backend(&self) -> bool {
        self.get_api_auth_mode()
            .is_some_and(AuthMode::uses_codex_backend)
    }

    fn should_refresh_proactively(auth: &CodexAuth) -> bool {
        let chatgpt_auth = match auth {
            CodexAuth::Chatgpt(chatgpt_auth) => chatgpt_auth,
            _ => return false,
        };

        let auth_dot_json = match chatgpt_auth.current_auth_json() {
            Some(auth_dot_json) => auth_dot_json,
            None => return false,
        };
        if let Some(tokens) = auth_dot_json.tokens.as_ref()
            && let Ok(Some(expires_at)) = parse_jwt_expiration(&tokens.access_token)
        {
            return expires_at
                <= Utc::now()
                    + chrono::Duration::minutes(CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES);
        }
        let last_refresh = match auth_dot_json.last_refresh {
            Some(last_refresh) => last_refresh,
            None => return false,
        };
        last_refresh < Utc::now() - chrono::Duration::days(TOKEN_REFRESH_INTERVAL)
    }

    async fn refresh_external_auth(
        &self,
        reason: ExternalAuthRefreshReason,
    ) -> Result<(), RefreshTokenError> {
        let Some(external_auth) = self.external_auth() else {
            return Err(RefreshTokenError::Transient(std::io::Error::other(
                "external auth is not configured",
            )));
        };
        let forced_chatgpt_workspace_id = self.forced_chatgpt_workspace_id();
        let previous_account_id = self
            .auth_cached()
            .as_ref()
            .and_then(CodexAuth::get_account_id);
        let context = ExternalAuthRefreshContext {
            reason,
            previous_account_id,
        };

        let refreshed = external_auth
            .refresh(context)
            .await
            .map_err(RefreshTokenError::Transient)?;
        if external_auth.auth_mode() == AuthMode::ApiKey {
            return Ok(());
        }
        let Some(chatgpt_metadata) = refreshed.chatgpt_metadata() else {
            return Err(RefreshTokenError::Transient(std::io::Error::other(
                "external auth refresh did not return ChatGPT metadata",
            )));
        };
        if let Some(expected_workspace_ids) = forced_chatgpt_workspace_id.as_deref()
            && !expected_workspace_ids.contains(&chatgpt_metadata.account_id)
        {
            return Err(RefreshTokenError::Transient(std::io::Error::other(
                format!(
                    "external auth refresh returned workspace {:?}, expected one of {:?}",
                    chatgpt_metadata.account_id, expected_workspace_ids,
                ),
            )));
        }
        let auth_dot_json =
            AuthDotJson::from_external_tokens(&refreshed).map_err(RefreshTokenError::Transient)?;
        save_auth(
            &self.codex_home,
            &auth_dot_json,
            AuthCredentialsStoreMode::Ephemeral,
            AuthKeyringBackendKind::default(),
        )
        .map_err(RefreshTokenError::Transient)?;
        self.reload().await;
        Ok(())
    }

    // 刷新 ChatGPT OAuth tokens，持久化更新后的 auth 状态，
    // 并重新加载内存缓存，使调用方立即观察到新 tokens。
    async fn refresh_and_persist_chatgpt_token(
        &self,
        auth: &ChatgptAuth,
        refresh_token: String,
    ) -> Result<(), RefreshTokenError> {
        let refresh_response = request_chatgpt_token_refresh(refresh_token, auth.client()).await?;

        persist_tokens(
            auth.storage(),
            refresh_response.id_token,
            refresh_response.access_token,
            refresh_response.refresh_token,
        )
        .map_err(RefreshTokenError::from)?;
        self.reload().await;

        Ok(())
    }
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
