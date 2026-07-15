//! AWS 鉴权模块：基于 AWS SDK 加载凭证并使用 SigV4 对出站 HTTP 请求签名。
//!
//! 主要对外暴露 [`AwsAuthContext`]，由调用方在配置阶段 `load` 一次后，
//! 后续每次出站请求调用 `sign` 即可。

mod config;
mod signing;

use std::time::SystemTime;

use aws_credential_types::provider::ProvideCredentials;
use aws_credential_types::provider::SharedCredentialsProvider;
use bytes::Bytes;
use http::HeaderMap;
use http::Method;
use thiserror::Error;

/// AWS 鉴权配置：用于解析凭证与签名请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwsAuthConfig {
    /// 可选 AWS profile 名（对应 `~/.aws/credentials` 中的命名 profile）。
    pub profile: Option<String>,
    /// 可选 AWS region（如 `us-east-1`）。
    pub region: Option<String>,
    /// 目标 AWS 服务名（如 `bedrock`）。不能为空。
    pub service: String,
}

/// 待签名的通用 HTTP 请求结构。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwsRequestToSign {
    /// HTTP 方法。
    pub method: Method,
    /// 完整请求 URL。
    pub url: String,
    /// 请求头。
    pub headers: HeaderMap,
    /// 请求体。
    pub body: Bytes,
}

/// 签名后返回给调用方的请求部分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwsSignedRequest {
    /// 签名后的 URL（可能含 SigV4 query 参数）。
    pub url: String,
    /// 包含 SigV4 签名头的请求头集合。
    pub headers: HeaderMap,
}

/// 凭证加载或 SigV4 签名过程中出现的错误。
#[derive(Debug, Error)]
pub enum AwsAuthError {
    /// AWS 服务名为空。
    #[error("AWS service name must not be empty")]
    EmptyService,
    /// AWS SDK 配置未解析到 credentials provider。
    #[error("AWS SDK config did not resolve a credentials provider")]
    MissingCredentialsProvider,
    /// AWS SDK 配置未解析到 region。
    #[error("AWS SDK config did not resolve a region")]
    MissingRegion,
    /// 加载 AWS 凭证失败。
    #[error("failed to load AWS credentials: {0}")]
    Credentials(#[from] aws_credential_types::provider::error::CredentialsError),
    /// 请求 URL 不是合法 URI。
    #[error("request URL is not a valid URI: {0}")]
    InvalidUri(#[source] http::uri::InvalidUri),
    /// 构造待签名 HTTP 请求失败。
    #[error("failed to construct HTTP request for signing: {0}")]
    BuildHttpRequest(#[source] http::Error),
    /// 请求头中存在非 UTF-8 值。
    #[error("request contains a non-UTF8 header value: {0}")]
    InvalidHeaderValue(#[source] http::header::ToStrError),
    /// 构造 SignableRequest 失败。
    #[error("failed to build signable request: {0}")]
    SigningRequest(#[source] aws_sigv4::http_request::SigningError),
    /// 构造 SigV4 签名参数失败。
    #[error("failed to build SigV4 signing params: {0}")]
    SigningParams(String),
    /// SigV4 签名失败。
    #[error("SigV4 signing failed: {0}")]
    SigningFailure(#[source] aws_sigv4::http_request::SigningError),
}

/// 已加载好的 AWS 鉴权上下文，可对出站 HTTP 请求签名。
#[derive(Clone)]
pub struct AwsAuthContext {
    credentials_provider: SharedCredentialsProvider,
    region: String,
    service: String,
}

impl std::fmt::Debug for AwsAuthContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AwsAuthContext")
            .field("region", &self.region)
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

impl AwsAuthContext {
    /// 根据配置加载 AWS SDK 配置、凭证 provider 与 region，构造上下文。
    pub async fn load(config: AwsAuthConfig) -> Result<Self, AwsAuthError> {
        let sdk_config = config::load_sdk_config(&config).await?;
        let credentials_provider = config::credentials_provider(&sdk_config)?;
        let region = config::resolved_region(&sdk_config)?;

        Ok(Self {
            credentials_provider,
            region,
            service: config.service.trim().to_string(),
        })
    }

    /// 返回解析得到的 AWS region。
    pub fn region(&self) -> &str {
        &self.region
    }

    /// 返回目标 AWS 服务名。
    pub fn service(&self) -> &str {
        &self.service
    }

    /// 使用当前时间对请求签名。
    pub async fn sign(&self, request: AwsRequestToSign) -> Result<AwsSignedRequest, AwsAuthError> {
        self.sign_at(request, SystemTime::now()).await
    }

    /// 与 [`sign`](Self::sign) 相同，但允许指定签名时刻（便于测试）。
    async fn sign_at(
        &self,
        request: AwsRequestToSign,
        time: SystemTime,
    ) -> Result<AwsSignedRequest, AwsAuthError> {
        let credentials = self.credentials_provider.provide_credentials().await?;
        signing::sign_request(&credentials, &self.region, &self.service, request, time)
    }
}

impl AwsAuthError {
    /// 判断该鉴权错误是否值得重试出站请求。
    ///
    /// 仅凭证 provider 超时 / 临时错误视为可重试。
    pub fn is_retryable(&self) -> bool {
        match self {
            AwsAuthError::Credentials(error) => matches!(
                error,
                aws_credential_types::provider::error::CredentialsError::ProviderTimedOut(_)
                    | aws_credential_types::provider::error::CredentialsError::ProviderError(_)
            ),
            AwsAuthError::EmptyService
            | AwsAuthError::MissingCredentialsProvider
            | AwsAuthError::MissingRegion
            | AwsAuthError::InvalidUri(_)
            | AwsAuthError::BuildHttpRequest(_)
            | AwsAuthError::InvalidHeaderValue(_)
            | AwsAuthError::SigningRequest(_)
            | AwsAuthError::SigningParams(_)
            | AwsAuthError::SigningFailure(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;
    use std::time::UNIX_EPOCH;

    use aws_credential_types::Credentials;
    use aws_credential_types::provider::error::CredentialsError;
    use pretty_assertions::assert_eq;

    use super::*;

    fn test_context(session_token: Option<&str>) -> AwsAuthContext {
        AwsAuthContext {
            credentials_provider: SharedCredentialsProvider::new(Credentials::new(
                "AKIDEXAMPLE",
                "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                session_token.map(str::to_string),
                /*expires_after*/ None,
                "unit-test",
            )),
            region: "us-east-1".to_string(),
            service: "bedrock".to_string(),
        }
    }

    fn test_request() -> AwsRequestToSign {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        headers.insert("x-test-header", http::HeaderValue::from_static("present"));
        AwsRequestToSign {
            method: Method::POST,
            url: "https://bedrock-runtime.us-east-1.amazonaws.com/v1/responses".to_string(),
            headers,
            body: Bytes::from_static(br#"{"model":"openai.gpt-oss-120b-1:0"}"#),
        }
    }

    #[tokio::test]
    async fn sign_adds_sigv4_headers_and_preserves_existing_headers() {
        let signed = test_context(/*session_token*/ None)
            .sign_at(
                test_request(),
                UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            )
            .await
            .expect("request should sign");

        assert_eq!(
            signing::header_value(&signed.headers, http::header::CONTENT_TYPE.as_str()),
            Some("application/json".to_string())
        );
        assert_eq!(
            signing::header_value(&signed.headers, "x-test-header"),
            Some("present".to_string())
        );
        assert_eq!(
            signed.url,
            "https://bedrock-runtime.us-east-1.amazonaws.com/v1/responses"
        );
        assert!(
            signing::header_value(&signed.headers, http::header::AUTHORIZATION.as_str())
                .is_some_and(|value| value.starts_with("AWS4-HMAC-SHA256 "))
        );
        assert!(signing::header_value(&signed.headers, "x-amz-date").is_some());
    }

    #[test]
    fn credentials_provider_failures_are_retryable() {
        assert!(
            AwsAuthError::Credentials(CredentialsError::provider_error("temporarily unavailable"))
                .is_retryable()
        );
        assert!(
            AwsAuthError::Credentials(CredentialsError::provider_timed_out(Duration::from_secs(1)))
                .is_retryable()
        );
    }

    #[test]
    fn deterministic_aws_auth_errors_are_not_retryable() {
        assert!(!AwsAuthError::EmptyService.is_retryable());
        assert!(
            !AwsAuthError::Credentials(CredentialsError::not_loaded_no_source()).is_retryable()
        );
        assert!(
            !AwsAuthError::Credentials(CredentialsError::invalid_configuration("bad profile"))
                .is_retryable()
        );
        assert!(
            !AwsAuthError::Credentials(CredentialsError::unhandled("unexpected response"))
                .is_retryable()
        );
    }

    #[tokio::test]
    async fn sign_includes_session_token_when_credentials_have_one() {
        let signed = test_context(Some("session-token"))
            .sign_at(
                test_request(),
                UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            )
            .await
            .expect("request should sign");

        assert_eq!(
            signing::header_value(&signed.headers, "x-amz-security-token"),
            Some("session-token".to_string())
        );
    }

    #[tokio::test]
    async fn load_rejects_empty_service_name() {
        let err = AwsAuthContext::load(AwsAuthConfig {
            profile: None,
            region: None,
            service: "   ".to_string(),
        })
        .await
        .expect_err("empty service should be rejected");

        assert_eq!(err.to_string(), "AWS service name must not be empty");
    }
}
