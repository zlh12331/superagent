use codex_client::Request;
use codex_client::RequestCompression;
use codex_client::RetryOn;
use codex_client::RetryPolicy;
use http::Method;
use http::header::HeaderMap;
use std::collections::HashMap;
use std::time::Duration;
use url::Url;

/// provider 级别的高层重试配置。
///
/// 通过 [`RetryConfig::to_policy`] 转换为 `codex-client` 使用的 `RetryPolicy`，
/// 驱动 unary 与 streaming 调用的传输层重试。
#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// 最大重试次数（含首次尝试）。
    pub max_attempts: u64,
    /// 重试退避的基准延迟。
    pub base_delay: Duration,
    /// 是否对 429 状态码重试。
    pub retry_429: bool,
    /// 是否对 5xx 状态码重试。
    pub retry_5xx: bool,
    /// 是否对传输层错误重试。
    pub retry_transport: bool,
}

impl RetryConfig {
    /// 将高层配置转换为 `codex-client` 的 `RetryPolicy`。
    pub fn to_policy(&self) -> RetryPolicy {
        RetryPolicy {
            max_attempts: self.max_attempts,
            base_delay: self.base_delay,
            retry_on: RetryOn {
                retry_429: self.retry_429,
                retry_5xx: self.retry_5xx,
                retry_transport: self.retry_transport,
            },
        }
    }
}

/// HTTP 端点配置，用于与具体的 API 部署通信。
///
/// 封装 base URL、默认 headers、query params、重试策略、流空闲超时，
/// 并提供构造请求的辅助方法。
#[derive(Debug, Clone)]
pub struct Provider {
    /// provider 名称（如 `openai`、`azure`），用于 Azure 识别等。
    pub name: String,
    /// API 基础 URL。
    pub base_url: String,
    /// 附加到所有请求 URL 的默认 query 参数。
    pub query_params: Option<HashMap<String, String>>,
    /// 附加到所有请求的默认 headers。
    pub headers: HeaderMap,
    /// 重试策略。
    pub retry: RetryConfig,
    /// 流式请求的空闲超时时间。
    pub stream_idle_timeout: Duration,
}

impl Provider {
    /// 根据 path 构造完整的请求 URL（含 query params）。
    ///
    /// `path` 前导的 `/` 与 `base_url` 末尾的 `/` 会被规范化处理。
    pub fn url_for_path(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        let mut url = if path.is_empty() {
            base.to_string()
        } else {
            format!("{base}/{path}")
        };

        if let Some(params) = &self.query_params
            && !params.is_empty()
        {
            let qs = params
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("&");
            url.push('?');
            url.push_str(&qs);
        }

        url
    }

    /// 根据 method 与 path 构造一个 `codex-client` 请求。
    ///
    /// 自动填充 base URL、query params 与默认 headers；body / compression /
    /// timeout 留空，由调用方按需设置。
    pub fn build_request(&self, method: Method, path: &str) -> Request {
        Request {
            method,
            url: self.url_for_path(path),
            headers: self.headers.clone(),
            body: None,
            compression: RequestCompression::None,
            timeout: None,
        }
    }

    /// 判断该 provider 是否为 Azure Responses 端点。
    ///
    /// 基于 [`Provider::name`] 与 [`Provider::base_url`] 综合判断。
    pub fn is_azure_responses_endpoint(&self) -> bool {
        is_azure_responses_provider(&self.name, Some(&self.base_url))
    }

    /// 根据 path 构造 WebSocket URL。
    ///
    /// 将 `http` / `https` scheme 转换为 `ws` / `wss`；已经是 `ws` / `wss`
    /// 或其他 scheme 的 URL 原样返回。
    pub fn websocket_url_for_path(&self, path: &str) -> Result<Url, url::ParseError> {
        let mut url = Url::parse(&self.url_for_path(path))?;

        let scheme = match url.scheme() {
            "http" => "ws",
            "https" => "wss",
            "ws" | "wss" => return Ok(url),
            _ => return Ok(url),
        };
        let _ = url.set_scheme(scheme);
        Ok(url)
    }
}

/// 判断给定 name 与 base_url 是否为 Azure Responses provider。
///
/// 当 name（大小写不敏感）为 `azure`，或 base_url 匹配 Azure 已知域名标记时
/// 返回 `true`。
pub fn is_azure_responses_provider(name: &str, base_url: Option<&str>) -> bool {
    if name.eq_ignore_ascii_case("azure") {
        true
    } else if let Some(base_url) = base_url {
        matches_azure_responses_base_url(base_url)
    } else {
        false
    }
}

/// 检查 base_url 是否匹配 Azure 已知的域名标记。
///
/// 匹配以下任一标记即判定为 Azure：
/// `openai.azure.`、`cognitiveservices.azure.`、`aoai.azure.`、
/// `azure-api.`、`azurefd.`、`windows.net/openai`。
fn matches_azure_responses_base_url(base_url: &str) -> bool {
    let base_url = base_url.to_ascii_lowercase();
    const AZURE_MARKERS: [&str; 6] = [
        "openai.azure.",
        "cognitiveservices.azure.",
        "aoai.azure.",
        "azure-api.",
        "azurefd.",
        "windows.net/openai",
    ];
    AZURE_MARKERS.iter().any(|marker| base_url.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_azure_responses_base_urls() {
        let positive_cases = [
            "https://foo.openai.azure.com/openai",
            "https://foo.openai.azure.us/openai/deployments/bar",
            "https://foo.cognitiveservices.azure.cn/openai",
            "https://foo.aoai.azure.com/openai",
            "https://foo.openai.azure-api.net/openai",
            "https://foo.z01.azurefd.net/",
        ];

        for base_url in positive_cases {
            assert!(
                is_azure_responses_provider("test", Some(base_url)),
                "expected {base_url} to be detected as Azure"
            );
        }

        assert!(is_azure_responses_provider(
            "Azure",
            Some("https://example.com")
        ));

        let negative_cases = [
            "https://api.openai.com/v1",
            "https://example.com/openai",
            "https://myproxy.azurewebsites.net/openai",
        ];

        for base_url in negative_cases {
            assert!(
                !is_azure_responses_provider("test", Some(base_url)),
                "expected {base_url} not to be detected as Azure"
            );
        }
    }
}
