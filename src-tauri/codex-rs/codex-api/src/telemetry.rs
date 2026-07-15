use crate::error::ApiError;
use codex_client::Request;
use codex_client::RequestTelemetry;
use codex_client::Response;
use codex_client::RetryPolicy;
use codex_client::StreamResponse;
use codex_client::TransportError;
use codex_client::run_with_retry;
use http::StatusCode;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Error;
use tokio_tungstenite::tungstenite::Message;

/// SSE 传输的通用遥测 trait。
///
/// 实现方可在 [`SseTelemetry::on_sse_poll`] 中记录每次 SSE 轮询的结果与耗时，
/// 用于监控流式响应的健康状况。
pub trait SseTelemetry: Send + Sync {
    /// 每次 SSE 轮询完成后调用。
    ///
    /// # 参数
    ///
    /// - `result`: 轮询结果（`Ok(Some(event))` / `Ok(None)` / `Err(elapsed)`）
    /// - `duration`: 本次轮询耗时
    fn on_sse_poll(
        &self,
        result: &Result<
            Option<
                Result<
                    eventsource_stream::Event,
                    eventsource_stream::EventStreamError<TransportError>,
                >,
            >,
            tokio::time::error::Elapsed,
        >,
        duration: Duration,
    );
}

/// Responses WebSocket 传输的遥测 trait。
///
/// 实现方可记录 WebSocket 请求与事件的耗时及错误，用于监控 WebSocket
/// 传输的健康状况。
pub trait WebsocketTelemetry: Send + Sync {
    /// 每次 WebSocket 请求（建连 + 发送）完成后调用。
    ///
    /// # 参数
    ///
    /// - `duration`: 请求耗时
    /// - `error`: 可选的错误（成功时为 `None`）
    /// - `connection_reused`: 是否复用了已有连接
    fn on_ws_request(&self, duration: Duration, error: Option<&ApiError>, connection_reused: bool);

    /// 每次 WebSocket 事件轮询完成后调用。
    ///
    /// # 参数
    ///
    /// - `result`: 轮询结果（`Ok(Some(message))` / `Ok(None)` / `Err(api_error)`）
    /// - `duration`: 本次轮询耗时
    fn on_ws_event(
        &self,
        result: &Result<Option<Result<Message, Error>>, ApiError>,
        duration: Duration,
    );
}

/// 内部 trait：为响应类型提供统一的 `status()` 访问。
pub(crate) trait WithStatus {
    fn status(&self) -> StatusCode;
}

/// 从 `TransportError` 中提取 HTTP 状态码（仅 `Http` 变体携带）。
fn http_status(err: &TransportError) -> Option<StatusCode> {
    match err {
        TransportError::Http { status, .. } => Some(*status),
        _ => None,
    }
}

impl WithStatus for Response {
    fn status(&self) -> StatusCode {
        self.status
    }
}

impl WithStatus for StreamResponse {
    fn status(&self) -> StatusCode {
        self.status
    }
}

/// 包装 `run_with_retry`，为每次尝试附加请求遥测。
///
/// 同时适用于 unary 与 streaming HTTP 调用：每次尝试记录 attempt 序号、
/// HTTP 状态码（或错误）、耗时，并通过 `RequestTelemetry` 上报。
///
/// # 类型参数
///
/// - `T`: 响应类型，需实现 [`WithStatus`]
/// - `F`: 发送函数类型，需 `Clone`
/// - `Fut`: 发送函数返回的 future 类型
///
/// # 参数
///
/// - `policy`: 重试策略
/// - `telemetry`: 可选的请求遥测句柄
/// - `make_request`: 构造每次尝试请求的闭包
/// - `send`: 发送请求的异步函数
pub(crate) async fn run_with_request_telemetry<T, F, Fut>(
    policy: RetryPolicy,
    telemetry: Option<Arc<dyn RequestTelemetry>>,
    make_request: impl FnMut() -> Request,
    send: F,
) -> Result<T, TransportError>
where
    T: WithStatus,
    F: Clone + Fn(Request) -> Fut,
    Fut: Future<Output = Result<T, TransportError>>,
{
    // 包装 run_with_retry，为 unary 与 streaming HTTP 调用附加每次尝试的遥测。
    run_with_retry(policy, make_request, move |req, attempt| {
        let telemetry = telemetry.clone();
        let send = send.clone();
        async move {
            let start = Instant::now();
            let result = send(req).await;
            if let Some(t) = telemetry.as_ref() {
                let (status, err) = match &result {
                    Ok(resp) => (Some(resp.status()), None),
                    Err(err) => (http_status(err), Some(err)),
                };
                t.on_request(attempt, status, err, start.elapsed());
            }
            result
        }
    })
    .await
}
