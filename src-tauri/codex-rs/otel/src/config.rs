//! OTEL exporter 配置与校验。
//!
//! 定义 exporter 相关的配置类型（[`OtelExporter`]、[`OtelSettings`]、
//! [`OtelTlsConfig`] 等）以及用于解析内置 Statsig exporter 的
//! [`resolve_exporter`] 函数。同时提供 span 属性的校验入口
//! [`validate_span_attributes`]。

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;

use codex_utils_absolute_path::AbsolutePathBuf;
use serde::Deserialize;
use serde::Serialize;

/// 内置 Statsig metrics 摄取的 OTLP HTTP 端点。
pub(crate) const STATSIG_OTLP_HTTP_ENDPOINT: &str = "https://ab.chatgpt.com/otlp/v1/metrics";
/// Statsig API 使用的请求头名称。
pub(crate) const STATSIG_API_KEY_HEADER: &str = "statsig-api-key";
/// 内置 Statsig exporter 使用的 API key。
pub(crate) const STATSIG_API_KEY: &str = "client-MkRuleRQBd6qakfnDYqJVR9JuXcY57Ljly3vi5JVUIO";

/// 解析 exporter 配置，将内置的 Statsig 默认值展开为具体的 OTLP HTTP 配置。
///
/// 在 debug 构建下，内置 Statsig 默认会被禁用（返回 [`OtelExporter::None`]），
/// 避免本地开发与测试产生不必要的 OTEL 流量；release 构建下才会展开为
/// 指向 Statsig 端点的 OTLP HTTP exporter。其他 exporter 原样返回。
pub(crate) fn resolve_exporter(exporter: &OtelExporter) -> OtelExporter {
    match exporter {
        OtelExporter::Statsig => {
            // debug 构建下禁用内置 Statsig 默认值，避免本地开发与测试
            // 在未显式配置 exporter 时产生尽力而为的 OTEL 流量。
            if cfg!(debug_assertions) {
                return OtelExporter::None;
            }

            OtelExporter::OtlpHttp {
                endpoint: STATSIG_OTLP_HTTP_ENDPOINT.to_string(),
                headers: HashMap::from([(
                    STATSIG_API_KEY_HEADER.to_string(),
                    STATSIG_API_KEY.to_string(),
                )]),
                protocol: OtelHttpProtocol::Json,
                tls: None,
            }
        }
        _ => exporter.clone(),
    }
}

/// 在 span 属性附加到导出的 span 之前校验其合法性。
///
/// 目前仅校验键不能为空字符串。校验失败时返回 [`std::io::Error`]。
pub fn validate_span_attributes(attributes: &BTreeMap<String, String>) -> std::io::Result<()> {
    if attributes.keys().any(String::is_empty) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "configured span attribute key must not be empty",
        ));
    }

    Ok(())
}

/// OTEL 全局配置集合，描述 provider 构建所需的全部参数。
#[derive(Clone, Debug)]
pub struct OtelSettings {
    /// 运行环境标识（如 `production`、`development`）。
    pub environment: String,
    /// 服务名，用作 OTEL resource 的 `service.name`。
    pub service_name: String,
    /// 服务版本号，用作 OTEL resource 的 `service.version`。
    pub service_version: String,
    /// Codex 配置目录路径。
    pub codex_home: PathBuf,
    /// 日志 exporter 配置。
    pub exporter: OtelExporter,
    /// trace exporter 配置。
    pub trace_exporter: OtelExporter,
    /// metrics exporter 配置。
    pub metrics_exporter: OtelExporter,
    /// 是否启用运行时指标采集。
    pub runtime_metrics: bool,
    /// 附加到每个导出 span 的自定义属性。
    pub span_attributes: BTreeMap<String, String>,
    /// W3C tracestate 配置，按 key 分组的二级映射。
    pub tracestate: BTreeMap<String, BTreeMap<String, String>>,
}

/// 解析后的 Statsig metrics 配置。
///
/// 另一个进程可凭此配置在不接收通用 exporter 凭证的情况下重建内置
/// metrics exporter 配置。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatsigMetricsSettings {
    /// 运行环境标识。
    pub environment: String,
}

/// OTLP HTTP 传输使用的负载编码协议。
#[derive(Clone, Debug)]
pub enum OtelHttpProtocol {
    /// 使用二进制 protobuf 编码的 HTTP 协议。
    Binary,
    /// 使用 JSON 负载的 HTTP 协议。
    Json,
}

/// OTLP exporter 的 TLS 配置，支持自定义 CA 证书与 mTLS 双向认证。
#[derive(Clone, Debug, Default)]
pub struct OtelTlsConfig {
    /// 自定义 CA 证书路径（用于校验服务端证书）。
    pub ca_certificate: Option<AbsolutePathBuf>,
    /// 客户端证书路径（mTLS 双向认证时使用）。
    pub client_certificate: Option<AbsolutePathBuf>,
    /// 客户端私钥路径（mTLS 双向认证时使用）。
    pub client_private_key: Option<AbsolutePathBuf>,
}

/// OTEL 数据导出目标配置。
#[derive(Clone, Debug)]
pub enum OtelExporter {
    /// 不导出任何数据。
    None,
    /// 使用 Codex 内部默认值的 Statsig metrics 摄取 exporter。
    ///
    /// 该选项仅用于 metrics。
    Statsig,
    /// OTLP gRPC exporter。
    OtlpGrpc {
        /// gRPC 端点地址。
        endpoint: String,
        /// 附加到请求的自定义头。
        headers: HashMap<String, String>,
        /// 可选的 TLS 配置。
        tls: Option<OtelTlsConfig>,
    },
    /// OTLP HTTP exporter。
    OtlpHttp {
        /// HTTP 端点地址。
        endpoint: String,
        /// 附加到请求的自定义头。
        headers: HashMap<String, String>,
        /// HTTP 负载编码协议。
        protocol: OtelHttpProtocol,
        /// 可选的 TLS 配置。
        tls: Option<OtelTlsConfig>,
    },
}

#[cfg(test)]
mod tests {
    use super::OtelExporter;
    use super::resolve_exporter;

    #[test]
    fn statsig_default_metrics_exporter_is_disabled_in_debug_builds() {
        assert!(matches!(
            resolve_exporter(&OtelExporter::Statsig),
            OtelExporter::None
        ));
    }
}
