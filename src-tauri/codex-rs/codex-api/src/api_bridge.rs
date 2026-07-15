use crate::TransportError;
use crate::error::ApiError;
use crate::rate_limits::parse_promo_message;
use crate::rate_limits::parse_rate_limit_for_limit;
use crate::rate_limits::parse_rate_limit_reached_type;
use base64::Engine;
use chrono::DateTime;
use chrono::Utc;
use codex_protocol::auth::PlanType;
use codex_protocol::error::CodexErr;
use codex_protocol::error::RetryLimitReachedError;
use codex_protocol::error::UnexpectedResponseError;
use codex_protocol::error::UsageLimitReachedError;
use http::HeaderMap;
use serde::Deserialize;
use serde_json::Value;

/// 将 API 层的 [`ApiError`] 转换为领域层的 [`CodexErr`]。
///
/// 该函数是 codex-api 与 codex-core 之间的错误边界，负责将各种 API 错误
/// （上下文超限、配额耗尽、速率限制、传输错误、HTTP 状态码等）映射为
/// `CodexErr` 的对应变体。对于 HTTP 错误，会进一步解析响应体与响应头，
/// 识别特殊场景（server_is_overloaded、cyber_policy、usage_limit_reached、
/// Cloudflare 拦截等）并映射到更具体的错误类型。
///
/// # 参数
///
/// - `err`: API 层返回的错误
///
/// # 返回值
///
/// 返回对应的 `CodexErr` 变体。
pub fn map_api_error(err: ApiError) -> CodexErr {
    match err {
        ApiError::ContextWindowExceeded => CodexErr::ContextWindowExceeded,
        ApiError::QuotaExceeded => CodexErr::QuotaExceeded,
        ApiError::UsageNotIncluded => CodexErr::UsageNotIncluded,
        ApiError::Retryable { message, delay } => CodexErr::Stream(message, delay),
        ApiError::Stream(msg) => CodexErr::Stream(msg, None),
        ApiError::ServerOverloaded => CodexErr::ServerOverloaded,
        ApiError::Api { status, message } => {
            let user_message = api_error_user_message(status, &message);
            CodexErr::UnexpectedStatus(UnexpectedResponseError {
                status,
                body: message,
                user_message,
                url: None,
                cf_ray: None,
                request_id: None,
                identity_authorization_error: None,
                identity_error_code: None,
            })
        }
        ApiError::InvalidRequest { message } => CodexErr::InvalidRequest(message),
        ApiError::CyberPolicy { message } => CodexErr::CyberPolicy { message },
        ApiError::Transport(transport) => match transport {
            TransportError::Http {
                status,
                url,
                headers,
                body,
            } => {
                let body_text = body.unwrap_or_default();

                if status == http::StatusCode::SERVICE_UNAVAILABLE
                    && let Ok(value) = serde_json::from_str::<serde_json::Value>(&body_text)
                    && matches!(
                        value
                            .get("error")
                            .and_then(|error| error.get("code"))
                            .and_then(serde_json::Value::as_str),
                        Some("server_is_overloaded" | "slow_down")
                    )
                {
                    return CodexErr::ServerOverloaded;
                }

                if status == http::StatusCode::BAD_REQUEST {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&body_text)
                        && let Some(error) = parsed.get("error")
                        && error.get("code").and_then(Value::as_str)
                            == Some(CYBER_POLICY_ERROR_CODE)
                    {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .filter(|message| !message.trim().is_empty())
                            .map(str::to_string)
                            .unwrap_or_else(|| CYBER_POLICY_FALLBACK_MESSAGE.to_string());
                        CodexErr::CyberPolicy { message }
                    } else if body_text
                        .contains("The image data you provided does not represent a valid image")
                    {
                        CodexErr::InvalidImageRequest()
                    } else {
                        CodexErr::InvalidRequest(body_text)
                    }
                } else if status == http::StatusCode::INTERNAL_SERVER_ERROR {
                    CodexErr::InternalServerError
                } else if status == http::StatusCode::TOO_MANY_REQUESTS {
                    if let Ok(err) = serde_json::from_str::<UsageErrorResponse>(&body_text) {
                        if err.error.error_type.as_deref() == Some("usage_limit_reached") {
                            let limit_id = extract_header(headers.as_ref(), ACTIVE_LIMIT_HEADER);
                            let rate_limits = headers.as_ref().and_then(|map| {
                                parse_rate_limit_for_limit(map, limit_id.as_deref())
                            });
                            let promo_message = headers.as_ref().and_then(parse_promo_message);
                            let rate_limit_reached_type =
                                headers.as_ref().and_then(parse_rate_limit_reached_type);
                            let resets_at = err
                                .error
                                .resets_at
                                .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds, 0));
                            return CodexErr::UsageLimitReached(UsageLimitReachedError {
                                plan_type: err.error.plan_type,
                                resets_at,
                                rate_limits: rate_limits.map(Box::new),
                                promo_message,
                                rate_limit_reached_type,
                            });
                        } else if err.error.error_type.as_deref() == Some("usage_not_included") {
                            return CodexErr::UsageNotIncluded;
                        }
                    }

                    CodexErr::RetryLimit(RetryLimitReachedError {
                        status,
                        request_id: extract_request_tracking_id(headers.as_ref()),
                    })
                } else {
                    CodexErr::UnexpectedStatus(UnexpectedResponseError {
                        status,
                        user_message: api_error_user_message(status, &body_text),
                        body: body_text,
                        url,
                        cf_ray: extract_header(headers.as_ref(), CF_RAY_HEADER),
                        request_id: extract_request_id(headers.as_ref()),
                        identity_authorization_error: extract_header(
                            headers.as_ref(),
                            X_OPENAI_AUTHORIZATION_ERROR_HEADER,
                        ),
                        identity_error_code: extract_x_error_json_code(headers.as_ref()),
                    })
                }
            }
            TransportError::RetryLimit => CodexErr::RetryLimit(RetryLimitReachedError {
                status: http::StatusCode::INTERNAL_SERVER_ERROR,
                request_id: None,
            }),
            TransportError::Timeout => CodexErr::RequestTimeout,
            TransportError::Network(msg) | TransportError::Build(msg) => {
                CodexErr::Stream(msg, None)
            }
        },
        ApiError::RateLimit(msg) => CodexErr::Stream(msg, None),
    }
}

const ACTIVE_LIMIT_HEADER: &str = "x-codex-active-limit";
const REQUEST_ID_HEADER: &str = "x-request-id";
const OAI_REQUEST_ID_HEADER: &str = "x-oai-request-id";
const CF_RAY_HEADER: &str = "cf-ray";
const X_OPENAI_AUTHORIZATION_ERROR_HEADER: &str = "x-openai-authorization-error";
const X_ERROR_JSON_HEADER: &str = "x-error-json";
/// cyber_policy 错误码：请求被识别为可能的网络安全风险。
const CYBER_POLICY_ERROR_CODE: &str = "cyber_policy";
/// cyber_policy 错误的兜底文案，当响应体未提供 message 时使用。
const CYBER_POLICY_FALLBACK_MESSAGE: &str =
    "This request has been flagged for possible cybersecurity risk.";
/// Cloudflare 拦截时下发给用户的提示文案。
const CLOUDFLARE_BLOCKED_MESSAGE: &str =
    "Access blocked by Cloudflare. This usually happens when connecting from a restricted region";

#[cfg(test)]
#[path = "api_bridge_tests.rs"]
mod tests;

/// 提取请求追踪 ID：优先 `x-request-id` / `x-oai-request-id`，回退到 `cf-ray`。
fn extract_request_tracking_id(headers: Option<&HeaderMap>) -> Option<String> {
    extract_request_id(headers).or_else(|| extract_header(headers, CF_RAY_HEADER))
}

/// 根据状态码与响应体生成面向用户的错误消息。
///
/// 当前仅识别 Cloudflare 拦截场景（403 + body 含 "Cloudflare" 与 "blocked"），
/// 其他情况返回 `None`。
fn api_error_user_message(status: http::StatusCode, body: &str) -> Option<String> {
    if status == http::StatusCode::FORBIDDEN
        && body.contains("Cloudflare")
        && body.contains("blocked")
    {
        Some(format!("{CLOUDFLARE_BLOCKED_MESSAGE} (status {status})"))
    } else {
        None
    }
}

/// 提取请求 ID：优先 `x-request-id`，回退到 `x-oai-request-id`。
fn extract_request_id(headers: Option<&HeaderMap>) -> Option<String> {
    extract_header(headers, REQUEST_ID_HEADER)
        .or_else(|| extract_header(headers, OAI_REQUEST_ID_HEADER))
}

/// 从 `HeaderMap` 中按名称提取单个 header 值并转为 `String`。
fn extract_header(headers: Option<&HeaderMap>, name: &str) -> Option<String> {
    headers.and_then(|map| {
        map.get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    })
}

/// 解析 `x-error-json` header（base64 编码的 JSON）中的 error.code 字段。
///
/// 该 header 通常由 OpenAI 后端在 identity 相关错误时返回，包含更具体的
/// 错误码信息。
fn extract_x_error_json_code(headers: Option<&HeaderMap>) -> Option<String> {
    let encoded = extract_header(headers, X_ERROR_JSON_HEADER)?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let parsed = serde_json::from_slice::<Value>(&decoded).ok()?;
    parsed
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// 用量限制错误的响应体结构（用于解析 429 响应）。
#[derive(Debug, Deserialize)]
struct UsageErrorResponse {
    error: UsageErrorBody,
}

/// 用量限制错误的响应体内部结构。
#[derive(Debug, Deserialize)]
struct UsageErrorBody {
    /// 错误类型，例如 `usage_limit_reached`、`usage_not_included`。
    #[serde(rename = "type")]
    error_type: Option<String>,
    plan_type: Option<PlanType>,
    /// 限额重置时间（Unix 秒）。
    resets_at: Option<i64>,
}
