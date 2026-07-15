use crate::rate_limits::RateLimitError;
use codex_client::TransportError;
use http::StatusCode;
use std::time::Duration;
use thiserror::Error;

/// codex-api 层的统一错误类型。
///
/// 涵盖传输错误、API HTTP 错误、流式错误、上下文超限、配额耗尽、速率限制、
/// 无效请求、cyber policy、服务器过载等场景。通过 [`crate::api_bridge::map_api_error`]
/// 可转换为领域层的 `CodexErr`。
#[derive(Debug, Error)]
pub enum ApiError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("api error {status}: {message}")]
    Api { status: StatusCode, message: String },
    #[error("stream error: {0}")]
    Stream(String),
    #[error("context window exceeded")]
    ContextWindowExceeded,
    #[error("quota exceeded")]
    QuotaExceeded,
    #[error("usage not included")]
    UsageNotIncluded,
    #[error("retryable error: {message}")]
    Retryable {
        message: String,
        delay: Option<Duration>,
    },
    #[error("rate limit: {0}")]
    RateLimit(String),
    #[error("invalid request: {message}")]
    InvalidRequest { message: String },
    #[error("cyber policy: {message}")]
    CyberPolicy { message: String },
    #[error("server overloaded")]
    ServerOverloaded,
}

impl From<RateLimitError> for ApiError {
    fn from(err: RateLimitError) -> Self {
        Self::RateLimit(err.to_string())
    }
}
