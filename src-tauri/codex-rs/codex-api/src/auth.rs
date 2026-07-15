use codex_client::Request;
use codex_client::TransportError;
use http::HeaderMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// 为出站请求附加认证时可能返回的错误。
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("request auth build error: {0}")]
    Build(String),
    #[error("transient auth error: {0}")]
    Transient(String),
}

impl From<AuthError> for TransportError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Build(message) => TransportError::Build(message),
            AuthError::Transient(message) => TransportError::Network(message),
        }
    }
}

/// 为 API 请求附加认证的 trait。
///
/// 仅需 header 的认证方式可以实现 [`AuthProvider::add_auth_headers`]；
/// 需要对完整请求签名的认证方式可以覆盖 [`AuthProvider::apply_auth`]。
pub trait AuthProvider: Send + Sync {
    /// 附加所有不需要请求体即可生成的认证 header。
    ///
    /// 实现应当廉价且非阻塞。该方法同时被遥测与非 HTTP 请求路径使用。
    fn add_auth_headers(&self, headers: &mut HeaderMap);

    /// 返回所有不需要请求体即可生成的认证 header。
    ///
    /// 默认实现基于 [`AuthProvider::add_auth_headers`] 构造一个新的 `HeaderMap`。
    fn to_auth_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        self.add_auth_headers(&mut headers);
        headers
    }

    /// 对完整的出站请求应用认证，返回实际发送的请求。
    ///
    /// 输入 `request` 会被 move 进来。实现可以修改该请求，或整体替换后再返回。
    ///
    /// 仅 header 的认证方式可使用默认实现；对请求签名的认证方式可覆盖此方法，
    /// 以在传输层发送请求前检查最终的 URL、headers 与 body 字节。
    ///
    /// 调用方必须始终以返回的请求为准。若返回 [`AuthError`]，则该请求不应被发送。
    fn apply_auth(&self, request: Request) -> AuthProviderFuture<'_> {
        Box::pin(async move {
            let mut request = request;
            self.add_auth_headers(&mut request.headers);
            Ok(request)
        })
    }
}

/// [`AuthProvider::apply_auth`] 返回的 future 类型别名。
pub type AuthProviderFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Request, AuthError>> + Send + 'a>>;

/// 在各 API client 之间传递的共享认证句柄类型别名。
pub type SharedAuthProvider = Arc<dyn AuthProvider>;

/// Agent identity 遥测信息，用于标识发起请求的 agent 与任务。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentIdentityTelemetry {
    pub agent_id: String,
    pub task_id: String,
}

/// 认证 header 遥测信息，记录是否附加了认证 header 及其名称。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AuthHeaderTelemetry {
    /// 是否成功附加了认证 header。
    pub attached: bool,
    /// 附加的认证 header 名称（当前仅识别 `authorization`）。
    pub name: Option<&'static str>,
}

/// 探测 `AuthProvider` 实际附加的认证 header，用于遥测上报。
///
/// 仅检查是否包含 `Authorization` header，不读取其值，避免敏感信息泄漏。
pub fn auth_header_telemetry(auth: &dyn AuthProvider) -> AuthHeaderTelemetry {
    let mut headers = HeaderMap::new();
    auth.add_auth_headers(&mut headers);
    let name = headers
        .contains_key(http::header::AUTHORIZATION)
        .then_some("authorization");
    AuthHeaderTelemetry {
        attached: name.is_some(),
        name,
    }
}
