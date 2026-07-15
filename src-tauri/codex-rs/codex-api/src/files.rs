use std::time::Duration;

use crate::AuthProvider;
use bytes::Bytes;
use codex_client::build_reqwest_client_with_custom_ca;
use futures::Stream;
use reqwest::StatusCode;
use reqwest::header::CONTENT_LENGTH;
use serde::Deserialize;
use tokio::time::Instant;

/// OpenAI 文件 URI 的 scheme 前缀，用于在协议中引用已上传的文件。
pub const OPENAI_FILE_URI_PREFIX: &str = "sediment://";
/// OpenAI 文件上传的最大字节数（512 MiB）。
pub const OPENAI_FILE_UPLOAD_LIMIT_BYTES: u64 = 512 * 1024 * 1024;

/// OpenAI 文件请求（创建 / 上传 / finalize）的超时时间。
const OPENAI_FILE_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// finalize 阶段的总超时时间：超过该时间仍为 `retry` 则报错。
const OPENAI_FILE_FINALIZE_TIMEOUT: Duration = Duration::from_secs(30);
/// finalize 阶段重试之间的等待时间。
const OPENAI_FILE_FINALIZE_RETRY_DELAY: Duration = Duration::from_millis(250);
/// 文件上传的 use_case 标识，固定为 `codex`。
const OPENAI_FILE_USE_CASE: &str = "codex";

/// 上传完成后的 OpenAI 文件信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedOpenAiFile {
    pub file_id: String,
    pub uri: String,
    pub download_url: String,
    pub file_name: String,
    pub file_size_bytes: u64,
    pub mime_type: Option<String>,
}

/// OpenAI 文件上传相关错误。
#[derive(Debug, thiserror::Error)]
pub enum OpenAiFileError {
    #[error(
        "file `{file_name}` is too large: {size_bytes} bytes exceeds the limit of {limit_bytes} bytes"
    )]
    FileTooLarge {
        file_name: String,
        size_bytes: u64,
        limit_bytes: u64,
    },
    #[error("failed to send OpenAI file request to {url}: {source}")]
    Request {
        url: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("OpenAI file request to {url} failed with status {status}: {body}")]
    UnexpectedStatus {
        url: String,
        status: StatusCode,
        body: String,
    },
    #[error("failed to parse OpenAI file response from {url}: {source}")]
    Decode {
        url: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("OpenAI file upload for `{file_id}` is not ready yet")]
    UploadNotReady { file_id: String },
    #[error("OpenAI file upload for `{file_id}` failed: {message}")]
    UploadFailed { file_id: String, message: String },
}

/// 创建文件上传会话的响应体。
#[derive(Deserialize)]
struct CreateFileResponse {
    file_id: String,
    upload_url: String,
}

/// finalize 阶段的响应体，包含下载链接与文件元数据。
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct DownloadLinkResponse {
    status: String,
    download_url: Option<String>,
    file_name: Option<String>,
    mime_type: Option<String>,
    error_message: Option<String>,
}

/// 根据 file_id 构造 OpenAI 文件 URI（`sediment://<file_id>`）。
pub fn openai_file_uri(file_id: &str) -> String {
    format!("{OPENAI_FILE_URI_PREFIX}{file_id}")
}

/// 上传文件到 OpenAI 文件服务。
///
/// 流程分为三步：
/// 1. POST `/files` 创建上传会话，获取 `file_id` 与 `upload_url`。
/// 2. PUT `upload_url` 上传文件内容（流式）。
/// 3. POST `/files/{file_id}/uploaded` 轮询 finalize 状态，直到成功或超时。
///
/// # 参数
///
/// - `base_url`: 文件服务基础 URL（如 `https://chatgpt.com/backend-api`）
/// - `auth`: 认证提供者
/// - `file_name`: 文件名
/// - `file_size_bytes`: 文件字节数（用于前置大小校验与 Content-Length header）
/// - `contents`: 文件内容的字节流
///
/// # 返回值
///
/// 成功返回 [`UploadedOpenAiFile`]；失败返回 [`OpenAiFileError`]。
///
/// # 错误条件
///
/// - 文件超过 [`OPENAI_FILE_UPLOAD_LIMIT_BYTES`]：`FileTooLarge`
/// - 任一 HTTP 请求失败：`Request`
/// - 任一 HTTP 响应状态非成功：`UnexpectedStatus`
/// - 响应体 JSON 解析失败：`Decode`
/// - finalize 超时仍为 `retry`：`UploadNotReady`
/// - finalize 返回错误状态：`UploadFailed`
pub async fn upload_openai_file(
    base_url: &str,
    auth: &dyn AuthProvider,
    file_name: String,
    file_size_bytes: u64,
    contents: impl Stream<Item = std::io::Result<Bytes>> + Send + 'static,
) -> Result<UploadedOpenAiFile, OpenAiFileError> {
    // 前置大小校验，避免无谓的网络请求。
    if file_size_bytes > OPENAI_FILE_UPLOAD_LIMIT_BYTES {
        return Err(OpenAiFileError::FileTooLarge {
            file_name,
            size_bytes: file_size_bytes,
            limit_bytes: OPENAI_FILE_UPLOAD_LIMIT_BYTES,
        });
    }

    // 步骤 1：创建上传会话。
    let create_url = format!("{}/files", base_url.trim_end_matches('/'));
    let create_response = authorized_request(auth, reqwest::Method::POST, &create_url)
        .json(&serde_json::json!({
            "file_name": file_name.as_str(),
            "file_size": file_size_bytes,
            "use_case": OPENAI_FILE_USE_CASE,
        }))
        .send()
        .await
        .map_err(|source| OpenAiFileError::Request {
            url: create_url.clone(),
            source,
        })?;
    let create_status = create_response.status();
    let create_body = create_response.text().await.unwrap_or_default();
    if !create_status.is_success() {
        return Err(OpenAiFileError::UnexpectedStatus {
            url: create_url,
            status: create_status,
            body: create_body,
        });
    }
    let create_payload: CreateFileResponse =
        serde_json::from_str(&create_body).map_err(|source| OpenAiFileError::Decode {
            url: create_url.clone(),
            source,
        })?;

    // 步骤 2：流式上传文件内容到 Azure Blob Storage 的 upload_url。
    let upload_response = build_reqwest_client()
        .put(&create_payload.upload_url)
        .timeout(OPENAI_FILE_REQUEST_TIMEOUT)
        .header("x-ms-blob-type", "BlockBlob")
        .header(CONTENT_LENGTH, file_size_bytes)
        .body(reqwest::Body::wrap_stream(contents))
        .send()
        .await
        .map_err(|source| OpenAiFileError::Request {
            url: create_payload.upload_url.clone(),
            source,
        })?;
    let upload_status = upload_response.status();
    let upload_body = upload_response.text().await.unwrap_or_default();
    if !upload_status.is_success() {
        return Err(OpenAiFileError::UnexpectedStatus {
            url: create_payload.upload_url.clone(),
            status: upload_status,
            body: upload_body,
        });
    }

    // 步骤 3：轮询 finalize 状态，直到 success / 失败 / 超时。
    let finalize_url = format!(
        "{}/files/{}/uploaded",
        base_url.trim_end_matches('/'),
        create_payload.file_id,
    );
    let finalize_started_at = Instant::now();
    loop {
        let finalize_response = authorized_request(auth, reqwest::Method::POST, &finalize_url)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|source| OpenAiFileError::Request {
                url: finalize_url.clone(),
                source,
            })?;
        let finalize_status = finalize_response.status();
        let finalize_body = finalize_response.text().await.unwrap_or_default();
        if !finalize_status.is_success() {
            return Err(OpenAiFileError::UnexpectedStatus {
                url: finalize_url.clone(),
                status: finalize_status,
                body: finalize_body,
            });
        }
        let finalize_payload: DownloadLinkResponse =
            serde_json::from_str(&finalize_body).map_err(|source| OpenAiFileError::Decode {
                url: finalize_url.clone(),
                source,
            })?;

        match finalize_payload.status.as_str() {
            "success" => {
                return Ok(UploadedOpenAiFile {
                    file_id: create_payload.file_id.clone(),
                    uri: openai_file_uri(&create_payload.file_id),
                    download_url: finalize_payload.download_url.ok_or_else(|| {
                        OpenAiFileError::UploadFailed {
                            file_id: create_payload.file_id.clone(),
                            message: "missing download_url".to_string(),
                        }
                    })?,
                    file_name: finalize_payload.file_name.unwrap_or(file_name),
                    file_size_bytes,
                    mime_type: finalize_payload.mime_type,
                });
            }
            "retry" => {
                // finalize 仍处理中：超过总超时则报错，否则等待后重试。
                if finalize_started_at.elapsed() >= OPENAI_FILE_FINALIZE_TIMEOUT {
                    return Err(OpenAiFileError::UploadNotReady {
                        file_id: create_payload.file_id,
                    });
                }
                tokio::time::sleep(OPENAI_FILE_FINALIZE_RETRY_DELAY).await;
            }
            _ => {
                return Err(OpenAiFileError::UploadFailed {
                    file_id: create_payload.file_id,
                    message: finalize_payload
                        .error_message
                        .unwrap_or_else(|| "upload finalization returned an error".to_string()),
                });
            }
        }
    }
}

/// 构造一个带认证 header 的 reqwest 请求构建器。
///
/// 用于文件服务的创建 / finalize 请求（不包括 PUT 上传，因为上传目标是
/// Azure Blob Storage，不需要 OpenAI 认证）。
fn authorized_request(
    auth: &dyn AuthProvider,
    method: reqwest::Method,
    url: &str,
) -> reqwest::RequestBuilder {
    let mut headers = http::HeaderMap::new();
    auth.add_auth_headers(&mut headers);

    let client = build_reqwest_client();
    client
        .request(method, url)
        .timeout(OPENAI_FILE_REQUEST_TIMEOUT)
        .headers(headers)
}

/// 构造一个支持自定义 CA 的 reqwest 客户端。
///
/// 当自定义 CA 构建失败时回退到默认客户端，并记录警告日志。
fn build_reqwest_client() -> reqwest::Client {
    build_reqwest_client_with_custom_ca(reqwest::Client::builder()).unwrap_or_else(|error| {
        tracing::warn!(error = %error, "failed to build OpenAI file upload client");
        reqwest::Client::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use reqwest::header::HeaderValue;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::Request;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::body_json;
    use wiremock::matchers::header;
    use wiremock::matchers::method;
    use wiremock::matchers::path;

    #[derive(Clone, Copy)]
    struct ChatGptTestAuth;

    impl AuthProvider for ChatGptTestAuth {
        fn add_auth_headers(&self, headers: &mut reqwest::header::HeaderMap) {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                HeaderValue::from_static("Bearer token"),
            );
            headers.insert("ChatGPT-Account-ID", HeaderValue::from_static("account_id"));
        }
    }

    fn chatgpt_auth() -> ChatGptTestAuth {
        ChatGptTestAuth
    }

    fn base_url_for(server: &MockServer) -> String {
        format!("{}/backend-api", server.uri())
    }

    #[tokio::test]
    async fn upload_openai_file_returns_canonical_uri() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/backend-api/files"))
            .and(header("chatgpt-account-id", "account_id"))
            .and(body_json(serde_json::json!({
                "file_name": "hello.txt",
                "file_size": 5,
                "use_case": "codex",
            })))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"file_id": "file_123", "upload_url": format!("{}/upload/file_123", server.uri())})),
            )
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/upload/file_123"))
            .and(header("content-length", "5"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let finalize_attempts = Arc::new(AtomicUsize::new(0));
        let finalize_attempts_responder = Arc::clone(&finalize_attempts);
        let download_url = format!("{}/download/file_123", server.uri());
        Mock::given(method("POST"))
            .and(path("/backend-api/files/file_123/uploaded"))
            .respond_with(move |_request: &Request| {
                if finalize_attempts_responder.fetch_add(1, Ordering::SeqCst) == 0 {
                    return ResponseTemplate::new(200).set_body_json(serde_json::json!({
                        "status": "retry"
                    }));
                }

                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "status": "success",
                    "download_url": download_url,
                    "file_name": "hello.txt",
                    "mime_type": "text/plain",
                    "file_size_bytes": 5
                }))
            })
            .mount(&server)
            .await;

        let base_url = base_url_for(&server);
        let contents =
            futures::stream::iter([Ok::<_, std::io::Error>(Bytes::from_static(b"hello"))]);
        let uploaded = upload_openai_file(
            &base_url,
            &chatgpt_auth(),
            "hello.txt".to_string(),
            /*file_size_bytes*/ 5,
            contents,
        )
        .await
        .expect("upload succeeds");

        assert_eq!(uploaded.file_id, "file_123");
        assert_eq!(uploaded.uri, "sediment://file_123");
        assert_eq!(
            uploaded.download_url,
            format!("{}/download/file_123", server.uri())
        );
        assert_eq!(uploaded.file_name, "hello.txt");
        assert_eq!(uploaded.mime_type, Some("text/plain".to_string()));
        assert_eq!(finalize_attempts.load(Ordering::SeqCst), 2);
    }
}
