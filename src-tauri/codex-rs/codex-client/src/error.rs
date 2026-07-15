use http::HeaderMap;
use http::StatusCode;
use thiserror::Error;

/// 传输层错误，覆盖 HTTP 状态、重试上限、超时与网络异常等场景。
#[derive(Debug, Error)]
pub enum TransportError {
    /// HTTP 响应非 2xx，附带状态码、URL、headers 与响应体。
    #[error("http {status}: {body:?}")]
    Http {
        status: StatusCode,
        url: Option<String>,
        headers: Option<HeaderMap>,
        body: Option<String>,
    },
    /// 已达到重试上限仍未成功。
    #[error("retry limit reached")]
    RetryLimit,
    /// 请求超时。
    #[error("timeout")]
    Timeout,
    /// 网络层错误（DNS、连接、读写等）。
    #[error("network error: {0}")]
    Network(String),
    /// 请求构建错误（参数非法、序列化失败等）。
    #[error("request build error: {0}")]
    Build(String),
}

/// 流式响应错误，区分底层流故障与空闲超时。
#[derive(Debug, Error)]
pub enum StreamError {
    /// 底层流读取失败，附带错误描述。
    #[error("stream failed: {0}")]
    Stream(String),
    /// 流在指定空闲时间内未产生任何数据。
    #[error("timeout")]
    Timeout,
}
