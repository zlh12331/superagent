//! Codex 后端 HTTP 客户端实现。
//!
//! [`Client`] 封装了所有与 codex-backend 交互的 HTTP 调用，
//! 支持 Codex API 与 ChatGPT backend-api 两种路径风格（[`PathStyle`]）。
//!
//! 客户端构建采用 builder 模式，可通过 `with_*` 方法设置认证、
//! User-Agent、ChatGPT 账户 ID、Fedramp 路由头等。

use crate::types::AccountsCheckResponse;
use crate::types::CodeTaskDetailsResponse;
use crate::types::CodexWorkspaceMessagesResponse;
use crate::types::ConfigBundleResponse;
use crate::types::PaginatedListTaskListItem;
use crate::types::RateLimitReachedKind as BackendRateLimitReachedKind;
use crate::types::RateLimitStatusPayload;
use crate::types::TokenUsageProfile;
use crate::types::TurnAttemptsSiblingTurnsResponse;
use anyhow::Result;
use codex_api::SharedAuthProvider;
use codex_client::build_reqwest_client_with_custom_ca;
use codex_client::with_chatgpt_cloudflare_cookie_store;
use codex_login::CodexAuth;
use codex_login::default_client::get_codex_user_agent;
use codex_protocol::account::PlanType as AccountPlanType;
use codex_protocol::protocol::CreditsSnapshot;
use codex_protocol::protocol::RateLimitReachedType;
use codex_protocol::protocol::RateLimitSnapshot;
use codex_protocol::protocol::RateLimitWindow;
use codex_protocol::protocol::SpendControlLimitSnapshot;
use reqwest::StatusCode;
use reqwest::header::CACHE_CONTROL;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use reqwest::header::USER_AGENT;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fmt;

mod rate_limit_resets;

/// 后端请求错误。
///
/// - [`UnexpectedStatus`](Self::UnexpectedStatus)：HTTP 响应状态码非 2xx。
/// - [`Other`](Self::Other)：其他错误（如网络、序列化等）。
#[derive(Debug)]
pub enum RequestError {
    UnexpectedStatus {
        method: String,
        url: String,
        status: StatusCode,
        content_type: String,
        body: String,
    },
    Other(anyhow::Error),
}

impl RequestError {
    /// 返回关联的 HTTP 状态码（仅 [`UnexpectedStatus`](Self::UnexpectedStatus) 变体有值）。
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Self::UnexpectedStatus { status, .. } => Some(*status),
            Self::Other(_) => None,
        }
    }

    /// 判断是否为 401 未授权错误。
    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(StatusCode::UNAUTHORIZED)
    }
}

impl fmt::Display for RequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedStatus {
                method,
                url,
                status,
                content_type,
                body,
            } => write!(
                f,
                "{method} {url} failed: {status}; content-type={content_type}; body={body}"
            ),
            Self::Other(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for RequestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::UnexpectedStatus { .. } => None,
            Self::Other(err) => Some(err.as_ref()),
        }
    }
}

impl From<anyhow::Error> for RequestError {
    fn from(err: anyhow::Error) -> Self {
        Self::Other(err)
    }
}

/// 添加额度提醒邮件的额度类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AddCreditsNudgeCreditType {
    /// Credits 类型。
    Credits,
    /// UsageLimit 类型。
    UsageLimit,
}

#[derive(Serialize)]
struct SendAddCreditsNudgeEmailRequest {
    credit_type: AddCreditsNudgeCreditType,
}

/// 后端 API 路径风格。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathStyle {
    /// Codex API 风格：`/api/codex/…`
    CodexApi,
    /// ChatGPT backend-api 风格：`/wham/…`
    ChatGptApi,
}

impl PathStyle {
    /// 根据 base_url 推断路径风格：包含 `/backend-api` 则为 ChatGPT 风格。
    pub fn from_base_url(base_url: &str) -> Self {
        if base_url.contains("/backend-api") {
            PathStyle::ChatGptApi
        } else {
            PathStyle::CodexApi
        }
    }
}

/// Codex 后端 HTTP 客户端。
///
/// 持有 base URL、HTTP 客户端、认证 provider 等配置，
/// 通过 builder 模式（`with_*` 方法）完成定制化构建。
#[derive(Clone)]
pub struct Client {
    /// 后端基础 URL。
    base_url: String,
    /// reqwest HTTP 客户端。
    http: reqwest::Client,
    /// 认证 provider（共享所有权）。
    auth_provider: SharedAuthProvider,
    /// User-Agent header 值（可选）。
    user_agent: Option<HeaderValue>,
    /// ChatGPT 账户 ID（可选）。
    chatgpt_account_id: Option<String>,
    /// 是否为 Fedramp 账户（影响路由头）。
    chatgpt_account_is_fedramp: bool,
    /// API 路径风格。
    path_style: PathStyle,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("base_url", &self.base_url)
            .field("auth_provider", &"<provider>")
            .field("user_agent", &self.user_agent)
            .field("chatgpt_account_id", &self.chatgpt_account_id)
            .field(
                "chatgpt_account_is_fedramp",
                &self.chatgpt_account_is_fedramp,
            )
            .field("path_style", &self.path_style)
            .finish_non_exhaustive()
    }
}

impl Client {
    /// 创建一个新的后端客户端。
    ///
    /// 会自动规范化 ChatGPT 主机名并附带 Cloudflare cookie store。
    /// 初始状态为未认证，需通过 `with_*` 方法补充认证信息。
    pub fn new(base_url: impl Into<String>) -> Result<Self> {
        let mut base_url = base_url.into();
        // 将常见 ChatGPT 主机名规范化为包含 /backend-api 以命中 WHAM 路径。
        // 同时去除末尾斜杠以保证 URL 构建的一致性。
        while base_url.ends_with('/') {
            base_url.pop();
        }
        if (base_url.starts_with("https://chatgpt.com")
            || base_url.starts_with("https://chat.openai.com"))
            && !base_url.contains("/backend-api")
        {
            base_url = format!("{base_url}/backend-api");
        }
        let http = build_reqwest_client_with_custom_ca(with_chatgpt_cloudflare_cookie_store(
            reqwest::Client::builder(),
        ))?;
        let path_style = PathStyle::from_base_url(&base_url);
        Ok(Self {
            base_url,
            http,
            auth_provider: codex_model_provider::unauthenticated_auth_provider(),
            user_agent: None,
            chatgpt_account_id: None,
            chatgpt_account_is_fedramp: false,
            path_style,
        })
    }

    /// 从认证信息创建一个新的后端客户端（便捷方法）。
    ///
    /// 等价于 [`new`](Self::new) + [`with_user_agent`](Self::with_user_agent) +
    /// [`with_auth_provider`](Self::with_auth_provider)。
    pub fn from_auth(base_url: impl Into<String>, auth: &CodexAuth) -> Result<Self> {
        Ok(Self::new(base_url)?
            .with_user_agent(get_codex_user_agent())
            .with_auth_provider(codex_model_provider::auth_provider_from_auth(auth)))
    }

    /// 设置认证 provider（builder 模式）。
    pub fn with_auth_provider(mut self, auth: SharedAuthProvider) -> Self {
        self.auth_provider = auth;
        self
    }

    /// 设置 User-Agent（builder 模式）。
    pub fn with_user_agent(mut self, ua: impl Into<String>) -> Self {
        if let Ok(hv) = HeaderValue::from_str(&ua.into()) {
            self.user_agent = Some(hv);
        }
        self
    }

    /// 设置 ChatGPT 账户 ID（builder 模式）。
    pub fn with_chatgpt_account_id(mut self, account_id: impl Into<String>) -> Self {
        self.chatgpt_account_id = Some(account_id.into());
        self
    }

    /// 启用 Fedramp 路由头（builder 模式）。
    pub fn with_fedramp_routing_header(mut self) -> Self {
        self.chatgpt_account_is_fedramp = true;
        self
    }

    /// 覆盖路径风格（builder 模式）。
    pub fn with_path_style(mut self, style: PathStyle) -> Self {
        self.path_style = style;
        self
    }

    fn headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(ua) = &self.user_agent {
            h.insert(USER_AGENT, ua.clone());
        } else {
            h.insert(USER_AGENT, HeaderValue::from_static("codex-cli"));
        }
        self.auth_provider.add_auth_headers(&mut h);
        if let Some(acc) = &self.chatgpt_account_id
            && let Ok(name) = HeaderName::from_bytes(b"ChatGPT-Account-Id")
            && let Ok(hv) = HeaderValue::from_str(acc)
        {
            h.insert(name, hv);
        }
        if self.chatgpt_account_is_fedramp
            && let Ok(name) = HeaderName::from_bytes(b"X-OpenAI-Fedramp")
        {
            h.insert(name, HeaderValue::from_static("true"));
        }
        h
    }

    async fn exec_request(
        &self,
        req: reqwest::RequestBuilder,
        method: &str,
        url: &str,
    ) -> Result<(String, String)> {
        let res = req.send().await?;
        let status = res.status();
        let ct = res
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("{method} {url} failed: {status}; content-type={ct}; body={body}");
        }
        Ok((body, ct))
    }

    async fn exec_request_detailed(
        &self,
        req: reqwest::RequestBuilder,
        method: &str,
        url: &str,
    ) -> std::result::Result<(String, String), RequestError> {
        let res = req.send().await.map_err(anyhow::Error::from)?;
        let status = res.status();
        let content_type = res
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(RequestError::UnexpectedStatus {
                method: method.to_string(),
                url: url.to_string(),
                status,
                content_type,
                body,
            });
        }
        Ok((body, content_type))
    }

    fn decode_json<T: DeserializeOwned>(&self, url: &str, ct: &str, body: &str) -> Result<T> {
        match serde_json::from_str::<T>(body) {
            Ok(v) => Ok(v),
            Err(e) => {
                anyhow::bail!("Decode error for {url}: {e}; content-type={ct}; body={body}");
            }
        }
    }

    /// 获取首选的速率限制快照（优先 `limit_id == "codex"`）。
    pub async fn get_rate_limits(&self) -> Result<RateLimitSnapshot> {
        let snapshots = self.get_rate_limits_many().await?;
        let preferred = snapshots
            .iter()
            .find(|snapshot| snapshot.limit_id.as_deref() == Some("codex"))
            .cloned();
        Ok(preferred.unwrap_or_else(|| snapshots[0].clone()))
    }

    /// 获取所有速率限制快照列表。
    pub async fn get_rate_limits_many(&self) -> Result<Vec<RateLimitSnapshot>> {
        Ok(self.get_rate_limits_with_reset_credits().await?.rate_limits)
    }

    /// 检查当前账户状态。
    pub async fn get_accounts_check(&self) -> Result<AccountsCheckResponse> {
        let url = match self.path_style {
            PathStyle::CodexApi => format!("{}/api/codex/accounts/check", self.base_url),
            PathStyle::ChatGptApi => format!("{}/wham/accounts/check", self.base_url),
        };
        let req = self.http.get(&url).headers(self.headers());
        let (body, ct) = self.exec_request(req, "GET", &url).await?;
        self.decode_json(&url, &ct, &body)
    }

    /// 获取当前用户的 token 使用情况。
    pub async fn get_token_usage_profile(&self) -> Result<TokenUsageProfile> {
        let url = self.token_usage_profile_url();
        let req = self.http.get(&url).headers(self.headers());
        let (body, ct) = self.exec_request(req, "GET", &url).await?;
        self.decode_json(&url, &ct, &body)
    }

    fn token_usage_profile_url(&self) -> String {
        match self.path_style {
            PathStyle::CodexApi => format!("{}/api/codex/profiles/me", self.base_url),
            PathStyle::ChatGptApi => format!("{}/wham/profiles/me", self.base_url),
        }
    }

    /// 发送添加额度提醒邮件。
    ///
    /// 参数：
    /// - `credit_type`：额度类型（Credits 或 UsageLimit）。
    pub async fn send_add_credits_nudge_email(
        &self,
        credit_type: AddCreditsNudgeCreditType,
    ) -> std::result::Result<(), RequestError> {
        let url = self.send_add_credits_nudge_email_url();
        let req = self
            .http
            .post(&url)
            .headers(self.headers())
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .json(&SendAddCreditsNudgeEmailRequest { credit_type });
        self.exec_request_detailed(req, "POST", &url).await?;
        Ok(())
    }

    /// 分页查询任务列表。
    ///
    /// 参数：
    /// - `limit`：返回数量上限（可选）。
    /// - `task_filter`：任务过滤条件（可选）。
    /// - `environment_id`：环境 ID（可选）。
    /// - `cursor`：分页游标（可选）。
    pub async fn list_tasks(
        &self,
        limit: Option<i32>,
        task_filter: Option<&str>,
        environment_id: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<PaginatedListTaskListItem> {
        let url = match self.path_style {
            PathStyle::CodexApi => format!("{}/api/codex/tasks/list", self.base_url),
            PathStyle::ChatGptApi => format!("{}/wham/tasks/list", self.base_url),
        };
        let req = self.http.get(&url).headers(self.headers());
        let req = if let Some(lim) = limit {
            req.query(&[("limit", lim)])
        } else {
            req
        };
        let req = if let Some(tf) = task_filter {
            req.query(&[("task_filter", tf)])
        } else {
            req
        };
        let req = if let Some(c) = cursor {
            req.query(&[("cursor", c)])
        } else {
            req
        };
        let req = if let Some(id) = environment_id {
            req.query(&[("environment_id", id)])
        } else {
            req
        };
        let (body, ct) = self.exec_request(req, "GET", &url).await?;
        self.decode_json::<PaginatedListTaskListItem>(&url, &ct, &body)
    }

    /// 获取指定任务的详细信息。
    ///
    /// 参数：
    /// - `task_id`：任务 ID。
    pub async fn get_task_details(&self, task_id: &str) -> Result<CodeTaskDetailsResponse> {
        let (parsed, _body, _ct) = self.get_task_details_with_body(task_id).await?;
        Ok(parsed)
    }

    /// 获取指定任务的详细信息，同时返回原始响应体与 content-type。
    ///
    /// 参数：
    /// - `task_id`：任务 ID。
    pub async fn get_task_details_with_body(
        &self,
        task_id: &str,
    ) -> Result<(CodeTaskDetailsResponse, String, String)> {
        let url = match self.path_style {
            PathStyle::CodexApi => format!("{}/api/codex/tasks/{}", self.base_url, task_id),
            PathStyle::ChatGptApi => format!("{}/wham/tasks/{}", self.base_url, task_id),
        };
        let req = self.http.get(&url).headers(self.headers());
        let (body, ct) = self.exec_request(req, "GET", &url).await?;
        let parsed: CodeTaskDetailsResponse = self.decode_json(&url, &ct, &body)?;
        Ok((parsed, body, ct))
    }

    /// 查询指定任务下某个 turn 的同级 turn 列表。
    ///
    /// 参数：
    /// - `task_id`：任务 ID。
    /// - `turn_id`：turn ID。
    pub async fn list_sibling_turns(
        &self,
        task_id: &str,
        turn_id: &str,
    ) -> Result<TurnAttemptsSiblingTurnsResponse> {
        let url = match self.path_style {
            PathStyle::CodexApi => format!(
                "{}/api/codex/tasks/{}/turns/{}/sibling_turns",
                self.base_url, task_id, turn_id
            ),
            PathStyle::ChatGptApi => format!(
                "{}/wham/tasks/{}/turns/{}/sibling_turns",
                self.base_url, task_id, turn_id
            ),
        };
        let req = self.http.get(&url).headers(self.headers());
        let (body, ct) = self.exec_request(req, "GET", &url).await?;
        self.decode_json::<TurnAttemptsSiblingTurnsResponse>(&url, &ct, &body)
    }

    /// 从 codex-backend 拉取已选中的云端托管 config bundle。
    ///
    /// 路径：
    /// - Codex API 风格：`GET /api/codex/config/bundle`
    /// - ChatGPT backend-api 风格：`GET /wham/config/bundle`
    pub async fn get_config_bundle(
        &self,
    ) -> std::result::Result<ConfigBundleResponse, RequestError> {
        let url = match self.path_style {
            PathStyle::CodexApi => format!("{}/api/codex/config/bundle", self.base_url),
            PathStyle::ChatGptApi => format!("{}/wham/config/bundle", self.base_url),
        };
        let req = self.http.get(&url).headers(self.headers());
        let (body, ct) = self.exec_request_detailed(req, "GET", &url).await?;
        self.decode_json::<ConfigBundleResponse>(&url, &ct, &body)
            .map_err(RequestError::from)
    }

    /// 获取工作区消息列表（带 `no-store` 缓存控制头）。
    pub async fn list_workspace_messages(
        &self,
    ) -> std::result::Result<CodexWorkspaceMessagesResponse, RequestError> {
        let url = self.workspace_messages_url();
        let req = self
            .http
            .get(&url)
            .headers(self.headers())
            .header(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        let (body, ct) = self.exec_request_detailed(req, "GET", &url).await?;
        self.decode_json::<CodexWorkspaceMessagesResponse>(&url, &ct, &body)
            .map_err(RequestError::from)
    }

    /// 创建一个新的 task（即用户 turn），根据 `path_style` 选择对应的后端路径
    /// 发起 POST 请求。返回创建的 task id。
    pub async fn create_task(&self, request_body: serde_json::Value) -> Result<String> {
        let url = match self.path_style {
            PathStyle::CodexApi => format!("{}/api/codex/tasks", self.base_url),
            PathStyle::ChatGptApi => format!("{}/wham/tasks", self.base_url),
        };
        let req = self
            .http
            .post(&url)
            .headers(self.headers())
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .json(&request_body);
        let (body, ct) = self.exec_request(req, "POST", &url).await?;
        // 从 JSON 中提取 id：优先取 `task.id`；若不存在则回退到顶层 `id`。
        match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(v) => {
                if let Some(id) = v
                    .get("task")
                    .and_then(|t| t.get("id"))
                    .and_then(|s| s.as_str())
                {
                    Ok(id.to_string())
                } else if let Some(id) = v.get("id").and_then(|s| s.as_str()) {
                    Ok(id.to_string())
                } else {
                    anyhow::bail!(
                        "POST {url} succeeded but no task id found; content-type={ct}; body={body}"
                    );
                }
            }
            Err(e) => anyhow::bail!("Decode error for {url}: {e}; content-type={ct}; body={body}"),
        }
    }

    // 速率限制辅助方法
    fn rate_limit_snapshots_from_payload(
        payload: RateLimitStatusPayload,
    ) -> Vec<RateLimitSnapshot> {
        let plan_type = Some(Self::map_plan_type(payload.plan_type));
        let rate_limit_reached_type = payload
            .rate_limit_reached_type
            .flatten()
            .and_then(|details| Self::map_rate_limit_reached_type(details.kind));
        let individual_limit = payload
            .spend_control
            .flatten()
            .and_then(|details| details.individual_limit.flatten())
            .map(|details| Self::map_individual_limit(*details));
        let mut snapshots = vec![Self::make_rate_limit_snapshot(
            Some("codex".to_string()),
            /*limit_name*/ None,
            payload.rate_limit.flatten().map(|details| *details),
            payload.credits.flatten().map(|details| *details),
            individual_limit,
            plan_type,
            rate_limit_reached_type,
        )];
        if let Some(additional) = payload.additional_rate_limits.flatten() {
            snapshots.extend(additional.into_iter().map(|details| {
                Self::make_rate_limit_snapshot(
                    Some(details.metered_feature),
                    Some(details.limit_name),
                    details.rate_limit.flatten().map(|rate_limit| *rate_limit),
                    /*credits*/ None,
                    /*individual_limit*/ None,
                    plan_type,
                    /*rate_limit_reached_type*/ None,
                )
            }));
        }
        snapshots
    }

    fn make_rate_limit_snapshot(
        limit_id: Option<String>,
        limit_name: Option<String>,
        rate_limit: Option<crate::types::RateLimitStatusDetails>,
        credits: Option<crate::types::CreditStatusDetails>,
        individual_limit: Option<SpendControlLimitSnapshot>,
        plan_type: Option<AccountPlanType>,
        rate_limit_reached_type: Option<RateLimitReachedType>,
    ) -> RateLimitSnapshot {
        let (primary, secondary) = match rate_limit {
            Some(details) => (
                Self::map_rate_limit_window(details.primary_window),
                Self::map_rate_limit_window(details.secondary_window),
            ),
            None => (None, None),
        };
        RateLimitSnapshot {
            limit_id,
            limit_name,
            primary,
            secondary,
            credits: Self::map_credits(credits),
            individual_limit,
            plan_type,
            rate_limit_reached_type,
        }
    }

    fn map_rate_limit_reached_type(
        kind: BackendRateLimitReachedKind,
    ) -> Option<RateLimitReachedType> {
        match kind {
            BackendRateLimitReachedKind::RateLimitReached => {
                Some(RateLimitReachedType::RateLimitReached)
            }
            BackendRateLimitReachedKind::WorkspaceOwnerCreditsDepleted => {
                Some(RateLimitReachedType::WorkspaceOwnerCreditsDepleted)
            }
            BackendRateLimitReachedKind::WorkspaceMemberCreditsDepleted => {
                Some(RateLimitReachedType::WorkspaceMemberCreditsDepleted)
            }
            BackendRateLimitReachedKind::WorkspaceOwnerUsageLimitReached => {
                Some(RateLimitReachedType::WorkspaceOwnerUsageLimitReached)
            }
            BackendRateLimitReachedKind::WorkspaceMemberUsageLimitReached => {
                Some(RateLimitReachedType::WorkspaceMemberUsageLimitReached)
            }
            BackendRateLimitReachedKind::Unknown => None,
        }
    }

    fn send_add_credits_nudge_email_url(&self) -> String {
        match self.path_style {
            PathStyle::CodexApi => format!(
                "{}/api/codex/accounts/send_add_credits_nudge_email",
                self.base_url
            ),
            PathStyle::ChatGptApi => {
                format!(
                    "{}/wham/accounts/send_add_credits_nudge_email",
                    self.base_url
                )
            }
        }
    }

    fn workspace_messages_url(&self) -> String {
        match self.path_style {
            PathStyle::CodexApi => format!("{}/api/codex/workspace-messages", self.base_url),
            PathStyle::ChatGptApi => format!("{}/wham/workspace-messages", self.base_url),
        }
    }

    fn map_rate_limit_window(
        window: Option<Option<Box<crate::types::RateLimitWindowSnapshot>>>,
    ) -> Option<RateLimitWindow> {
        let snapshot = window.flatten().map(|details| *details)?;

        let used_percent = f64::from(snapshot.used_percent);
        let window_minutes = Self::window_minutes_from_seconds(snapshot.limit_window_seconds);
        let resets_at = Some(i64::from(snapshot.reset_at));
        Some(RateLimitWindow {
            used_percent,
            window_minutes,
            resets_at,
        })
    }

    fn map_credits(credits: Option<crate::types::CreditStatusDetails>) -> Option<CreditsSnapshot> {
        let details = credits?;

        Some(CreditsSnapshot {
            has_credits: details.has_credits,
            unlimited: details.unlimited,
            balance: details.balance.flatten(),
        })
    }

    fn map_individual_limit(
        details: crate::types::SpendControlLimitDetails,
    ) -> SpendControlLimitSnapshot {
        SpendControlLimitSnapshot {
            limit: details.limit,
            used: details.used,
            remaining_percent: details.remaining_percent,
            resets_at: i64::from(details.reset_at),
        }
    }

    fn map_plan_type(plan_type: crate::types::PlanType) -> AccountPlanType {
        match plan_type {
            crate::types::PlanType::Free => AccountPlanType::Free,
            crate::types::PlanType::Go => AccountPlanType::Go,
            crate::types::PlanType::Plus => AccountPlanType::Plus,
            crate::types::PlanType::Pro => AccountPlanType::Pro,
            crate::types::PlanType::ProLite => AccountPlanType::ProLite,
            crate::types::PlanType::Team => AccountPlanType::Team,
            crate::types::PlanType::SelfServeBusinessUsageBased => {
                AccountPlanType::SelfServeBusinessUsageBased
            }
            crate::types::PlanType::Business => AccountPlanType::Business,
            crate::types::PlanType::EnterpriseCbpUsageBased => {
                AccountPlanType::EnterpriseCbpUsageBased
            }
            crate::types::PlanType::Enterprise => AccountPlanType::Enterprise,
            crate::types::PlanType::Edu | crate::types::PlanType::Education => AccountPlanType::Edu,
            crate::types::PlanType::Guest
            | crate::types::PlanType::FreeWorkspace
            | crate::types::PlanType::Quorum
            | crate::types::PlanType::K12
            | crate::types::PlanType::Unknown => AccountPlanType::Unknown,
        }
    }

    fn window_minutes_from_seconds(seconds: i32) -> Option<i64> {
        if seconds <= 0 {
            return None;
        }

        let seconds_i64 = i64::from(seconds);
        Some((seconds_i64 + 59) / 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_backend_openapi_models::models::AdditionalRateLimitDetails;
    use codex_backend_openapi_models::models::RateLimitReachedKind;
    use codex_backend_openapi_models::models::RateLimitReachedType as BackendRateLimitReachedType;
    use pretty_assertions::assert_eq;

    #[test]
    fn map_plan_type_supports_usage_based_business_variants() {
        assert_eq!(
            Client::map_plan_type(crate::types::PlanType::SelfServeBusinessUsageBased),
            AccountPlanType::SelfServeBusinessUsageBased
        );
        assert_eq!(
            Client::map_plan_type(crate::types::PlanType::EnterpriseCbpUsageBased),
            AccountPlanType::EnterpriseCbpUsageBased
        );
    }

    #[test]
    fn usage_payload_maps_primary_and_additional_rate_limits() {
        let payload = RateLimitStatusPayload {
            plan_type: crate::types::PlanType::Pro,
            rate_limit: Some(Some(Box::new(crate::types::RateLimitStatusDetails {
                primary_window: Some(Some(Box::new(crate::types::RateLimitWindowSnapshot {
                    used_percent: 42,
                    limit_window_seconds: 300,
                    reset_after_seconds: 0,
                    reset_at: 123,
                }))),
                secondary_window: Some(Some(Box::new(crate::types::RateLimitWindowSnapshot {
                    used_percent: 84,
                    limit_window_seconds: 3600,
                    reset_after_seconds: 0,
                    reset_at: 456,
                }))),
                ..Default::default()
            }))),
            additional_rate_limits: Some(Some(vec![AdditionalRateLimitDetails {
                limit_name: "codex_other".to_string(),
                metered_feature: "codex_other".to_string(),
                rate_limit: Some(Some(Box::new(crate::types::RateLimitStatusDetails {
                    primary_window: Some(Some(Box::new(crate::types::RateLimitWindowSnapshot {
                        used_percent: 70,
                        limit_window_seconds: 900,
                        reset_after_seconds: 0,
                        reset_at: 789,
                    }))),
                    secondary_window: None,
                    ..Default::default()
                }))),
            }])),
            credits: Some(Some(Box::new(crate::types::CreditStatusDetails {
                has_credits: true,
                unlimited: false,
                balance: Some(Some("9.99".to_string())),
                ..Default::default()
            }))),
            spend_control: Some(Some(Box::new(
                codex_backend_openapi_models::models::SpendControlStatusDetails {
                    reached: false,
                    individual_limit: Some(Some(Box::new(
                        crate::types::SpendControlLimitDetails {
                            source: None,
                            limit: "25000".to_string(),
                            used: "8000".to_string(),
                            remaining: "17000".to_string(),
                            used_percent: 32,
                            remaining_percent: 68,
                            reset_after_seconds: 3600,
                            reset_at: 789,
                        },
                    ))),
                },
            ))),
            rate_limit_reached_type: Some(Some(BackendRateLimitReachedType {
                kind: RateLimitReachedKind::WorkspaceMemberCreditsDepleted,
            })),
        };

        let snapshots = Client::rate_limit_snapshots_from_payload(payload);
        assert_eq!(snapshots.len(), 2);

        assert_eq!(snapshots[0].limit_id.as_deref(), Some("codex"));
        assert_eq!(snapshots[0].limit_name, None);
        assert_eq!(
            snapshots[0].primary.as_ref().map(|w| w.used_percent),
            Some(42.0)
        );
        assert_eq!(
            snapshots[0].secondary.as_ref().map(|w| w.used_percent),
            Some(84.0)
        );
        assert_eq!(
            snapshots[0].credits,
            Some(CreditsSnapshot {
                has_credits: true,
                unlimited: false,
                balance: Some("9.99".to_string()),
            })
        );
        assert_eq!(snapshots[0].plan_type, Some(AccountPlanType::Pro));
        assert_eq!(
            snapshots[0].rate_limit_reached_type,
            Some(RateLimitReachedType::WorkspaceMemberCreditsDepleted)
        );
        assert_eq!(
            snapshots[0].individual_limit,
            Some(SpendControlLimitSnapshot {
                limit: "25000".to_string(),
                used: "8000".to_string(),
                remaining_percent: 68,
                resets_at: 789,
            })
        );

        assert_eq!(snapshots[1].limit_id.as_deref(), Some("codex_other"));
        assert_eq!(snapshots[1].limit_name.as_deref(), Some("codex_other"));
        assert_eq!(
            snapshots[1].primary.as_ref().map(|w| w.used_percent),
            Some(70.0)
        );
        assert_eq!(snapshots[1].credits, None);
        assert_eq!(snapshots[1].individual_limit, None);
        assert_eq!(snapshots[1].plan_type, Some(AccountPlanType::Pro));
        assert_eq!(snapshots[1].rate_limit_reached_type, None);
    }

    #[test]
    fn usage_payload_maps_zero_rate_limit_when_primary_absent() {
        let payload = RateLimitStatusPayload {
            plan_type: crate::types::PlanType::Plus,
            rate_limit: None,
            additional_rate_limits: Some(Some(vec![AdditionalRateLimitDetails {
                limit_name: "codex_other".to_string(),
                metered_feature: "codex_other".to_string(),
                rate_limit: None,
            }])),
            credits: None,
            spend_control: None,
            rate_limit_reached_type: None,
        };

        let snapshots = Client::rate_limit_snapshots_from_payload(payload);
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].limit_id.as_deref(), Some("codex"));
        assert_eq!(snapshots[0].limit_name, None);
        assert_eq!(snapshots[0].primary, None);
        assert_eq!(snapshots[1].limit_id.as_deref(), Some("codex_other"));
        assert_eq!(snapshots[1].limit_name.as_deref(), Some("codex_other"));
    }

    #[test]
    fn preferred_snapshot_selection_matches_get_rate_limits_behavior() {
        let snapshots = [
            RateLimitSnapshot {
                limit_id: Some("codex_other".to_string()),
                limit_name: Some("codex_other".to_string()),
                primary: Some(RateLimitWindow {
                    used_percent: 90.0,
                    window_minutes: Some(60),
                    resets_at: Some(1),
                }),
                secondary: None,
                credits: None,
                individual_limit: None,
                plan_type: Some(AccountPlanType::Pro),
                rate_limit_reached_type: None,
            },
            RateLimitSnapshot {
                limit_id: Some("codex".to_string()),
                limit_name: Some("codex".to_string()),
                primary: Some(RateLimitWindow {
                    used_percent: 10.0,
                    window_minutes: Some(60),
                    resets_at: Some(2),
                }),
                secondary: None,
                credits: None,
                individual_limit: None,
                plan_type: Some(AccountPlanType::Pro),
                rate_limit_reached_type: None,
            },
        ];

        let preferred = snapshots
            .iter()
            .find(|snapshot| snapshot.limit_id.as_deref() == Some("codex"))
            .cloned()
            .unwrap_or_else(|| snapshots[0].clone());
        assert_eq!(preferred.limit_id.as_deref(), Some("codex"));
    }

    #[test]
    fn usage_payload_maps_every_rate_limit_reached_type() {
        let cases = [
            (
                RateLimitReachedKind::RateLimitReached,
                Some(RateLimitReachedType::RateLimitReached),
            ),
            (
                RateLimitReachedKind::WorkspaceOwnerCreditsDepleted,
                Some(RateLimitReachedType::WorkspaceOwnerCreditsDepleted),
            ),
            (
                RateLimitReachedKind::WorkspaceMemberCreditsDepleted,
                Some(RateLimitReachedType::WorkspaceMemberCreditsDepleted),
            ),
            (
                RateLimitReachedKind::WorkspaceOwnerUsageLimitReached,
                Some(RateLimitReachedType::WorkspaceOwnerUsageLimitReached),
            ),
            (
                RateLimitReachedKind::WorkspaceMemberUsageLimitReached,
                Some(RateLimitReachedType::WorkspaceMemberUsageLimitReached),
            ),
            (RateLimitReachedKind::Unknown, None),
        ];

        for (kind, expected) in cases {
            let payload = RateLimitStatusPayload {
                plan_type: crate::types::PlanType::Plus,
                rate_limit: None,
                credits: None,
                spend_control: None,
                additional_rate_limits: None,
                rate_limit_reached_type: Some(Some(BackendRateLimitReachedType { kind })),
            };

            let snapshots = Client::rate_limit_snapshots_from_payload(payload);
            assert_eq!(snapshots[0].rate_limit_reached_type, expected);
        }
    }

    #[test]
    fn usage_payload_preserves_absent_rate_limit_reached_type() {
        let payload = RateLimitStatusPayload {
            plan_type: crate::types::PlanType::Plus,
            rate_limit: None,
            credits: None,
            spend_control: None,
            additional_rate_limits: None,
            rate_limit_reached_type: None,
        };

        let snapshots = Client::rate_limit_snapshots_from_payload(payload);
        assert_eq!(snapshots[0].rate_limit_reached_type, None);
    }

    #[test]
    fn add_credits_nudge_email_uses_expected_paths_and_bodies() {
        let codex_client = test_client("https://example.test", PathStyle::CodexApi);
        assert_eq!(
            codex_client.send_add_credits_nudge_email_url(),
            "https://example.test/api/codex/accounts/send_add_credits_nudge_email"
        );

        let chatgpt_client = test_client("https://chatgpt.com/backend-api", PathStyle::ChatGptApi);
        assert_eq!(
            chatgpt_client.send_add_credits_nudge_email_url(),
            "https://chatgpt.com/backend-api/wham/accounts/send_add_credits_nudge_email"
        );

        assert_eq!(
            serde_json::to_value(SendAddCreditsNudgeEmailRequest {
                credit_type: AddCreditsNudgeCreditType::Credits,
            })
            .unwrap(),
            serde_json::json!({ "credit_type": "credits" })
        );
        assert_eq!(
            serde_json::to_value(SendAddCreditsNudgeEmailRequest {
                credit_type: AddCreditsNudgeCreditType::UsageLimit,
            })
            .unwrap(),
            serde_json::json!({ "credit_type": "usage_limit" })
        );
    }

    #[test]
    fn token_usage_profile_uses_expected_paths() {
        let codex_client = test_client("https://example.test", PathStyle::CodexApi);
        assert_eq!(
            codex_client.token_usage_profile_url(),
            "https://example.test/api/codex/profiles/me"
        );

        let chatgpt_client = test_client("https://chatgpt.com/backend-api", PathStyle::ChatGptApi);
        assert_eq!(
            chatgpt_client.token_usage_profile_url(),
            "https://chatgpt.com/backend-api/wham/profiles/me"
        );
    }

    #[test]
    fn workspace_messages_uses_expected_paths() {
        let codex_client = test_client("https://example.test", PathStyle::CodexApi);
        assert_eq!(
            codex_client.workspace_messages_url(),
            "https://example.test/api/codex/workspace-messages"
        );

        let chatgpt_client = test_client("https://chatgpt.com/backend-api", PathStyle::ChatGptApi);
        assert_eq!(
            chatgpt_client.workspace_messages_url(),
            "https://chatgpt.com/backend-api/wham/workspace-messages"
        );
    }

    fn test_client(base_url: &str, path_style: PathStyle) -> Client {
        Client {
            base_url: base_url.to_string(),
            http: reqwest::Client::new(),
            auth_provider: codex_model_provider::unauthenticated_auth_provider(),
            user_agent: None,
            chatgpt_account_id: None,
            chatgpt_account_is_fedramp: false,
            path_style,
        }
    }
}
