use bytes::Bytes;
use http::Method;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderValue;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// 已序列化、可复用的 JSON 请求体。
///
/// 内部使用引用计数的 [`Bytes`] 持有编码后的字节，clone 操作共享同一份内存分配。
/// 当请求体 trace 日志开启时，`trace_bytes` 会保留压缩前的原始 JSON 字节，
/// 便于在调试日志中查看请求体内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedJsonBody {
    bytes: Bytes,
    trace_bytes: Option<Bytes>,
    prepared: bool,
}

impl EncodedJsonBody {
    /// 将 `value` 序列化为可复用的 JSON 请求体。
    pub fn encode<T: Serialize + ?Sized>(value: &T) -> Result<Self, serde_json::Error> {
        serde_json::to_vec(value).map(|bytes| Self {
            bytes: Bytes::from(bytes),
            trace_bytes: None,
            prepared: false,
        })
    }

    /// 返回当前持有的编码字节切片。
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// 返回用于 trace 日志的字节（优先返回压缩前原始字节，否则返回当前字节）。
    pub(crate) fn trace_bytes(&self) -> &[u8] {
        self.trace_bytes.as_ref().unwrap_or(&self.bytes)
    }
}

/// 请求体压缩算法选择。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RequestCompression {
    /// 不压缩（默认）。
    #[default]
    None,
    /// 使用 zstd 压缩。
    Zstd,
}

/// 请求体枚举，支持三种形式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestBody {
    /// 未序列化的 JSON 值（在 `into_prepared` 时才会被序列化）。
    Json(Value),
    /// 已序列化的 JSON 字节（可跨重试复用，避免重复编码）。
    EncodedJson(EncodedJsonBody),
    /// 原始字节（不参与 JSON 序列化与压缩）。
    Raw(Bytes),
}

impl RequestBody {
    /// 若为 [`RequestBody::Json`] 则返回内部 JSON 值的引用，否则返回 `None`。
    pub fn json(&self) -> Option<&Value> {
        match self {
            Self::Json(value) => Some(value),
            Self::EncodedJson(_) | Self::Raw(_) => None,
        }
    }
}

/// 已准备好的请求体，包含最终 headers 与字节流。
///
/// 调用方（如 AWS SigV4 签名）可通过此结构访问 transport 实际发送的
/// headers 与 body 字节，从而保证签名内容与发送内容一致。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRequestBody {
    /// 最终发送时使用的 headers（含 Content-Type / Content-Encoding 等）。
    pub headers: HeaderMap,
    /// 最终发送的字节流；`None` 表示无 body。
    pub body: Option<Bytes>,
}

impl PreparedRequestBody {
    /// 返回 body 字节的 [`Bytes`] 克隆；若 body 为 `None` 则返回空 `Bytes`。
    pub fn body_bytes(&self) -> Bytes {
        self.body.clone().unwrap_or_default()
    }
}

/// 平台无关的 HTTP 请求抽象。
#[derive(Debug, Clone)]
pub struct Request {
    /// HTTP 方法（GET / POST / ...）。
    pub method: Method,
    /// 请求 URL。
    pub url: String,
    /// 请求 headers。
    pub headers: HeaderMap,
    /// 可选请求体。
    pub body: Option<RequestBody>,
    /// 请求体压缩算法。
    pub compression: RequestCompression,
    /// 请求超时（覆盖 client 默认值）。
    pub timeout: Option<Duration>,
}

impl Request {
    /// 创建一个不带 body 的新请求。
    pub fn new(method: Method, url: String) -> Self {
        Self {
            method,
            url,
            headers: HeaderMap::new(),
            body: None,
            compression: RequestCompression::None,
            timeout: None,
        }
    }

    /// 附加一个 JSON body（序列化失败时静默忽略）。
    pub fn with_json<T: Serialize>(mut self, body: &T) -> Self {
        self.body = serde_json::to_value(body).ok().map(RequestBody::Json);
        self
    }

    /// 附加一个原始字节 body。
    pub fn with_raw_body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = Some(RequestBody::Raw(body.into()));
        self
    }

    /// 设置请求体压缩算法。
    pub fn with_compression(mut self, compression: RequestCompression) -> Self {
        self.compression = compression;
        self
    }

    /// 一次性准备请求体并缓存最终发送字节。
    ///
    /// 返回的请求克隆时共享 body 字节，因此重试时不会重复 JSON 序列化或压缩。
    /// 请求签名（如 AWS SigV4）也能看到 transport 实际发送的 headers 与字节。
    pub fn into_prepared(mut self) -> Result<Self, String> {
        let is_json = matches!(
            self.body,
            Some(RequestBody::Json(_) | RequestBody::EncodedJson(_))
        );
        let trace_bytes = if self.compression != RequestCompression::None
            && tracing::enabled!(target: "codex_client::transport", tracing::Level::TRACE)
        {
            match self.body.as_ref() {
                Some(RequestBody::Json(body)) => Some(Bytes::from(
                    serde_json::to_vec(body).map_err(|err| err.to_string())?,
                )),
                Some(RequestBody::EncodedJson(body)) => Some(body.bytes.clone()),
                Some(RequestBody::Raw(_)) | None => None,
            }
        } else {
            None
        };
        let prepared = self.prepare_body_for_send()?;
        self.headers = prepared.headers;
        self.body = match (is_json, prepared.body) {
            (true, Some(bytes)) => Some(RequestBody::EncodedJson(EncodedJsonBody {
                bytes,
                trace_bytes,
                prepared: true,
            })),
            (false, Some(body)) => Some(RequestBody::Raw(body)),
            (_, None) => None,
        };
        self.compression = RequestCompression::None;
        Ok(self)
    }

    /// 计算请求体的最终发送字节（不修改请求本身）。
    ///
    /// AWS SigV4 等签名方案需要签名最终 body 字节（含压缩与 content headers），
    /// 此方法返回的字节与 transport 实际发送的字节一致。
    pub fn prepare_body_for_send(&self) -> Result<PreparedRequestBody, String> {
        let headers = self.headers.clone();
        match self.body.as_ref() {
            Some(RequestBody::Raw(raw_body)) => {
                if self.compression != RequestCompression::None {
                    return Err("request compression cannot be used with raw bodies".to_string());
                }
                Ok(PreparedRequestBody {
                    headers,
                    body: Some(raw_body.clone()),
                })
            }
            Some(RequestBody::Json(body)) => {
                let body = EncodedJsonBody::encode(body).map_err(|err| err.to_string())?;
                self.prepare_encoded_json(headers, &body)
            }
            Some(RequestBody::EncodedJson(body)) => self.prepare_encoded_json(headers, body),
            None => Ok(PreparedRequestBody {
                headers,
                body: None,
            }),
        }
    }

    fn prepare_encoded_json(
        &self,
        mut headers: HeaderMap,
        body: &EncodedJsonBody,
    ) -> Result<PreparedRequestBody, String> {
        if body.prepared {
            return Ok(PreparedRequestBody {
                headers,
                body: Some(body.bytes.clone()),
            });
        }

        let bytes = if self.compression != RequestCompression::None {
            if headers.contains_key(http::header::CONTENT_ENCODING) {
                return Err(
                    "request compression was requested but content-encoding is already set"
                        .to_string(),
                );
            }

            let pre_compression_bytes = body.bytes.len();
            let compression_start = std::time::Instant::now();
            let (compressed, content_encoding) = match self.compression {
                RequestCompression::None => unreachable!("guarded by compression != None"),
                RequestCompression::Zstd => (
                    zstd::stream::encode_all(std::io::Cursor::new(body.as_bytes()), 3)
                        .map_err(|err| err.to_string())?,
                    HeaderValue::from_static("zstd"),
                ),
            };
            let post_compression_bytes = compressed.len();
            let compression_duration = compression_start.elapsed();

            headers.insert(http::header::CONTENT_ENCODING, content_encoding);

            tracing::debug!(
                pre_compression_bytes,
                post_compression_bytes,
                compression_duration_ms = compression_duration.as_millis(),
                "Compressed request body with zstd"
            );

            Bytes::from(compressed)
        } else {
            body.bytes.clone()
        };

        if !headers.contains_key(http::header::CONTENT_TYPE) {
            headers.insert(
                http::header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
        }

        Ok(PreparedRequestBody {
            headers,
            body: Some(bytes),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    #[test]
    fn prepare_body_for_send_serializes_json_and_sets_content_type() {
        let request = Request::new(Method::POST, "https://example.com/v1/responses".to_string())
            .with_json(&json!({"model": "test-model"}));

        let prepared = request
            .prepare_body_for_send()
            .expect("body should prepare");

        assert_eq!(
            prepared.body,
            Some(Bytes::from_static(br#"{"model":"test-model"}"#))
        );
        assert_eq!(
            prepared
                .headers
                .get(http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
        assert_eq!(
            request.body,
            Some(RequestBody::Json(json!({"model": "test-model"})))
        );
        assert_eq!(request.compression, RequestCompression::None);
    }

    #[test]
    fn prepare_body_for_send_rejects_existing_content_encoding_when_compressing() {
        let mut request =
            Request::new(Method::POST, "https://example.com/v1/responses".to_string())
                .with_json(&json!({"model": "test-model"}))
                .with_compression(RequestCompression::Zstd);
        request.headers.insert(
            http::header::CONTENT_ENCODING,
            HeaderValue::from_static("gzip"),
        );

        let err = request
            .prepare_body_for_send()
            .expect_err("conflicting content-encoding should fail");

        assert_eq!(
            err,
            "request compression was requested but content-encoding is already set"
        );
    }

    #[test]
    fn into_prepared_stores_compressed_body_for_reuse() {
        let body =
            EncodedJsonBody::encode(&json!({"model": "test-model"})).expect("JSON should encode");
        let mut request =
            Request::new(Method::POST, "https://example.com/v1/responses".to_string())
                .with_compression(RequestCompression::Zstd);
        request.body = Some(RequestBody::EncodedJson(body));
        let request = request.into_prepared().expect("body should prepare");
        let Some(RequestBody::EncodedJson(body)) = request.body.as_ref() else {
            panic!("expected an encoded JSON body");
        };
        let decompressed = zstd::stream::decode_all(std::io::Cursor::new(body.as_bytes()))
            .expect("body should decompress");

        assert_eq!(decompressed, br#"{"model":"test-model"}"#);
        assert_eq!(request.compression, RequestCompression::None);
        assert_eq!(
            request.headers.get(http::header::CONTENT_ENCODING),
            Some(&HeaderValue::from_static("zstd"))
        );
        assert_eq!(
            request.headers.get(http::header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("application/json"))
        );
    }
}

/// 平台无关的 HTTP 响应抽象。
#[derive(Debug, Clone)]
pub struct Response {
    /// HTTP 状态码。
    pub status: http::StatusCode,
    /// 响应 headers。
    pub headers: HeaderMap,
    /// 响应 body 字节。
    pub body: Bytes,
}
