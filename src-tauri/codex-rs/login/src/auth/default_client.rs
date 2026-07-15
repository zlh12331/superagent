//! 默认 Codex HTTP 客户端构建模块。
//!
//! 负责维护共享的 `User-Agent`、`originator`、可选的 residency header，
//! 并提供 reqwest 客户端与 `CodexHttpClient` 的统一构建入口。
//!
//! 其他 crate 应通过 [`crate::default_client`] 或 [`codex_login::default_client`] 引用本模块。

use codex_client::BuildCustomCaTransportError;
use codex_client::BuildRouteAwareHttpClientError;
use codex_client::ClientRouteClass;
use codex_client::CodexHttpClient;
pub use codex_client::CodexRequestBuilder;
use codex_client::build_reqwest_client_for_route;
use codex_client::build_reqwest_client_with_custom_ca;
use codex_client::with_chatgpt_cloudflare_cookie_store;
use codex_terminal_detection::user_agent;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderValue;
use reqwest::header::USER_AGENT;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::RwLock;

use crate::outbound_proxy::AuthRouteConfig;

/// 设置此值可为 User-Agent 字符串追加后缀。
///
/// 使用全局单例来承载此状态并不理想。
/// 该字段主要用于区分不同的 MCP 客户端。
/// 由于每个进程至多只能有一个 MCP server，将其作为全局静态变量应当是安全的。
/// 但后续使用方仍需谨慎对待这一约定。
/// 此外，我们希望确保该值能作用于所有客户端，但要做到这一点需要大量管线改造，
/// 且容易遗漏某些代码路径。
/// 参见 https://github.com/openai/codex/pull/3388/files 了解这种改造的具体形态。
/// 最后，我们希望所有 MCP 客户端都能应用此设置，而无需知道特定的环境变量，
/// 也无需将 MCP initialize 请求中已指定的数据再重复设置一遍。
///
/// 后缀与其余 User-Agent 字符串之间会自动添加一个空格。
/// 完整的 user agent 字符串会通过 MCP initialize 响应返回。
/// 括号由 Codex 自动添加，此字段仅需指定放在括号内的内容。
pub static USER_AGENT_SUFFIX: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// 默认的 originator 标识，用于标识 Codex CLI Rust 实现。
pub const DEFAULT_ORIGINATOR: &str = "codex_cli_rs";

/// 用于覆盖内部 originator 的环境变量名。
pub const CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR: &str = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";

/// 用于传递 residency（数据驻留）要求的 HTTP header 名。
pub const RESIDENCY_HEADER_NAME: &str = "x-openai-internal-codex-residency";

pub use codex_config::ResidencyRequirement;

/// originator 的解析结果，同时缓存原始字符串与可用的 `HeaderValue`。
///
/// `value` 用于日志或拼接 User-Agent，`header_value` 可直接作为 HTTP header 使用。
#[derive(Debug, Clone)]
pub struct Originator {
    /// originator 的原始字符串值。
    pub value: String,
    /// 已转换为合法 `HeaderValue` 的形式，避免重复解析。
    pub header_value: HeaderValue,
}
static ORIGINATOR: LazyLock<RwLock<Option<Originator>>> = LazyLock::new(|| RwLock::new(None));
static REQUIREMENTS_RESIDENCY: LazyLock<RwLock<Option<ResidencyRequirement>>> =
    LazyLock::new(|| RwLock::new(None));

/// 设置默认 originator 时可能出现的错误。
#[derive(Debug)]
pub enum SetOriginatorError {
    /// 提供的值无法转换为合法的 `HeaderValue`。
    InvalidHeaderValue,
    /// originator 已被初始化，不能重复设置。
    AlreadyInitialized,
}

/// 根据环境变量或显式入参解析出最终的 [`Originator`]。
///
/// 解析顺序：`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 环境变量 > `provided` 参数 > 默认值。
/// 当给定值无法转换为合法 `HeaderValue` 时回退到 [`DEFAULT_ORIGINATOR`]。
fn get_originator_value(provided: Option<String>) -> Originator {
    let value = std::env::var(CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR)
        .ok()
        .or(provided)
        .unwrap_or(DEFAULT_ORIGINATOR.to_string());

    match HeaderValue::from_str(&value) {
        Ok(header_value) => Originator {
            value,
            header_value,
        },
        Err(e) => {
            tracing::error!("Unable to turn originator override {value} into header value: {e}");
            Originator {
                value: DEFAULT_ORIGINATOR.to_string(),
                header_value: HeaderValue::from_static(DEFAULT_ORIGINATOR),
            }
        }
    }
}

/// 设置进程级的默认 originator，仅允许设置一次。
///
/// 返回 `Err(SetOriginatorError::InvalidHeaderValue)` 表示值非法；
/// 返回 `Err(SetOriginatorError::AlreadyInitialized)` 表示已被设置过。
pub fn set_default_originator(value: String) -> Result<(), SetOriginatorError> {
    if HeaderValue::from_str(&value).is_err() {
        return Err(SetOriginatorError::InvalidHeaderValue);
    }
    let originator = get_originator_value(Some(value));
    let Ok(mut guard) = ORIGINATOR.write() else {
        return Err(SetOriginatorError::AlreadyInitialized);
    };
    if guard.is_some() {
        return Err(SetOriginatorError::AlreadyInitialized);
    }
    *guard = Some(originator);
    Ok(())
}

/// 设置默认客户端的 residency（数据驻留）要求。
///
/// 若全局锁已中毒则记录警告并直接返回，不修改状态。
pub fn set_default_client_residency_requirement(enforce_residency: Option<ResidencyRequirement>) {
    let Ok(mut guard) = REQUIREMENTS_RESIDENCY.write() else {
        tracing::warn!("Failed to acquire requirements residency lock");
        return;
    };
    *guard = enforce_residency;
}

/// 返回当前生效的 [`Originator`]。
///
/// 优先返回已设置的全局值；若未显式设置但环境变量存在，则按环境变量初始化；
/// 否则按默认流程构建。
pub fn originator() -> Originator {
    if let Ok(guard) = ORIGINATOR.read()
        && let Some(originator) = guard.as_ref()
    {
        return originator.clone();
    }

    if std::env::var(CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR).is_ok() {
        let originator = get_originator_value(/*provided*/ None);
        if let Ok(mut guard) = ORIGINATOR.write() {
            match guard.as_ref() {
                Some(originator) => return originator.clone(),
                None => *guard = Some(originator.clone()),
            }
        }
        return originator;
    }

    get_originator_value(/*provided*/ None)
}

/// 判断给定 originator 是否属于 Codex 第一方（CLI / TUI / VSCode 等）。
pub fn is_first_party_originator(originator_value: &str) -> bool {
    originator_value == DEFAULT_ORIGINATOR
        || originator_value == "codex-tui"
        || originator_value == "codex_vscode"
        || originator_value.starts_with("Codex ")
}

/// 判断给定 originator 是否属于 Codex 第一方 Chat 类客户端（Atlas / ChatGPT 桌面端）。
pub fn is_first_party_chat_originator(originator_value: &str) -> bool {
    originator_value == "codex_atlas" || originator_value == "codex_chatgpt_desktop"
}

/// 拼接 Codex 客户端的 User-Agent 字符串。
///
/// 形如 `originator/version (os_type os_version; arch) terminal-info (suffix)`，
/// 其中 `suffix` 来自 [`USER_AGENT_SUFFIX`]，可为空。
pub fn get_codex_user_agent() -> String {
    let build_version = env!("CARGO_PKG_VERSION");
    let os_info = os_info::get();
    let originator = originator();
    let prefix = format!(
        "{}/{build_version} ({} {}; {}) {}",
        originator.value.as_str(),
        os_info.os_type(),
        os_info.version(),
        os_info.architecture().unwrap_or("unknown"),
        user_agent()
    );
    let suffix = USER_AGENT_SUFFIX
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    let suffix = suffix
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map_or_else(String::new, |value| format!(" ({value})"));

    let candidate = format!("{prefix}{suffix}");
    sanitize_user_agent(candidate, &prefix)
}

/// 对 User-Agent 字符串进行清洗。
///
/// 非法字符将被替换为下划线。
///
/// 若清洗后仍无法解析，则回退到 `fallback`；若 `fallback` 也非法，则回退到 [`originator`] 的值。
fn sanitize_user_agent(candidate: String, fallback: &str) -> String {
    if HeaderValue::from_str(candidate.as_str()).is_ok() {
        return candidate;
    }

    let sanitized: String = candidate
        .chars()
        .map(|ch| if matches!(ch, ' '..='~') { ch } else { '_' })
        .collect();
    if !sanitized.is_empty() && HeaderValue::from_str(sanitized.as_str()).is_ok() {
        tracing::warn!(
            "Sanitized Codex user agent because provided suffix contained invalid header characters"
        );
        sanitized
    } else if HeaderValue::from_str(fallback).is_ok() {
        tracing::warn!(
            "Falling back to base Codex user agent because provided suffix could not be sanitized"
        );
        fallback.to_string()
    } else {
        tracing::warn!(
            "Falling back to default Codex originator because base user agent string is invalid"
        );
        originator().value
    }
}

/// 创建一个带默认 `originator` 与 `User-Agent` 头的 HTTP 客户端。
///
/// 此默认路径保留 reqwest 既有的代理行为，不会启用 Codex 的路由感知（route-aware）系统代理 / PAC 解析。
pub fn create_client() -> CodexHttpClient {
    let inner = build_reqwest_client();
    CodexHttpClient::new(inner)
}

/// 构建用于普通 Codex HTTP 流量的默认 reqwest 客户端。
///
/// 该函数以 Codex 默认 User-Agent、默认 header 与沙箱相关代理策略为基础，
/// 并叠加来自 `CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE` 的自定义 CA 处理。
/// 为了与既有调用点保持兼容，此函数不可失败：当自定义 CA 加载或 builder 构建失败时，
/// 会记录日志并回退到 `reqwest::Client::new()`。
///
/// 此默认路径保留 reqwest 既有的代理行为，不会启用 Codex 的路由感知系统代理 / PAC 解析。
/// 持有路由配置的认证调用方必须使用 [`build_default_auth_reqwest_client`] 或 [`create_default_auth_client`]。
pub fn build_reqwest_client() -> reqwest::Client {
    try_build_reqwest_client().unwrap_or_else(|error| {
        tracing::warn!(error = %error, "failed to build default reqwest client");
        with_chatgpt_cloudflare_cookie_store(reqwest::Client::builder())
            .build()
            .unwrap_or_else(|fallback_error| {
                tracing::warn!(
                    error = %fallback_error,
                    "failed to build fallback reqwest client with ChatGPT Cloudflare cookie store"
                );
                reqwest::Client::new()
            })
    })
}

/// 尝试构建用于普通 Codex HTTP 流量的默认 reqwest 客户端。
///
/// 需要结构化自定义 CA 加载失败（而非旧式日志回退）的调用方可以直接使用此函数。
pub fn try_build_reqwest_client() -> Result<reqwest::Client, BuildCustomCaTransportError> {
    build_reqwest_client_with_custom_ca(default_reqwest_client_builder())
}

/// 构建默认 reqwest 客户端的 `ClientBuilder`。
///
/// 在沙箱环境（`CODEX_SANDBOX=seatbelt`）下显式禁用代理，
/// 否则保留系统默认代理并附加 ChatGPT Cloudflare cookie store。
fn default_reqwest_client_builder() -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder().default_headers(default_headers());
    if is_sandboxed() {
        builder = builder.no_proxy();
    }
    with_chatgpt_cloudflare_cookie_store(builder)
}

/// 为认证端点构建一个不带 Codex 默认 header 的原始 reqwest 客户端。
///
/// 用于 OAuth 回调服务器等只需要路由解析能力、而不需要 Codex 业务 header 的场景。
pub(crate) fn build_raw_auth_reqwest_client(
    endpoint: &str,
    auth_route_config: Option<&AuthRouteConfig>,
) -> Result<reqwest::Client, BuildRouteAwareHttpClientError> {
    build_reqwest_client_for_route(
        reqwest::Client::builder(),
        endpoint,
        ClientRouteClass::Auth,
        auth_route_config.map(AuthRouteConfig::route_config),
    )
}

/// 为认证端点构建默认的 Codex reqwest 客户端。
///
/// 当未提供 `auth_route_config`，或当前进程运行在沙箱中时，回退到 [`build_reqwest_client`]，
/// 以保留沙箱既有的 no-proxy 策略；否则按路由配置构建客户端。
pub(crate) fn build_default_auth_reqwest_client(
    endpoint: &str,
    auth_route_config: Option<&AuthRouteConfig>,
) -> Result<reqwest::Client, BuildRouteAwareHttpClientError> {
    let Some(route_config) = auth_route_config.map(AuthRouteConfig::route_config) else {
        return Ok(build_reqwest_client());
    };

    if is_sandboxed() {
        // 保留沙箱既有的 no-proxy 策略；沙箱命令出站流量由 network-proxy 单独路由。
        return Ok(build_reqwest_client());
    }
    build_reqwest_client_for_route(
        default_reqwest_client_builder(),
        endpoint,
        ClientRouteClass::Auth,
        Some(route_config),
    )
}

/// 为认证端点构建默认的 Codex HTTP 客户端包装（`CodexHttpClient`）。
///
/// 内部调用 [`build_default_auth_reqwest_client`]，并将结果包装为 `CodexHttpClient`。
pub(crate) fn create_default_auth_client(
    endpoint: &str,
    auth_route_config: Option<&AuthRouteConfig>,
) -> Result<CodexHttpClient, BuildRouteAwareHttpClientError> {
    build_default_auth_reqwest_client(endpoint, auth_route_config).map(CodexHttpClient::new)
}

/// 返回所有 Codex 出站请求应携带的默认 header 集合。
///
/// 包括 `originator`、`User-Agent`，以及当 residency（数据驻留）要求被设置时的
/// `x-openai-internal-codex-residency` header。
pub fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("originator", originator().header_value);
    if let Ok(user_agent) = HeaderValue::from_str(&get_codex_user_agent()) {
        headers.insert(USER_AGENT, user_agent);
    }
    if let Ok(guard) = REQUIREMENTS_RESIDENCY.read()
        && let Some(requirement) = guard.as_ref()
        && !headers.contains_key(RESIDENCY_HEADER_NAME)
    {
        let value = match requirement {
            ResidencyRequirement::Us => HeaderValue::from_static("us"),
        };
        headers.insert(RESIDENCY_HEADER_NAME, value);
    }
    headers
}

/// 判断当前进程是否运行在 seatbelt 沙箱中。
fn is_sandboxed() -> bool {
    std::env::var("CODEX_SANDBOX").as_deref() == Ok("seatbelt")
}

#[cfg(test)]
#[path = "default_client_tests.rs"]
mod tests;
