//! OTLP exporter 底层构建工具。
//!
//! 提供 HTTP/gRPC 客户端构建、TLS 配置组装、超时解析等辅助函数，
//! 供 [`crate::provider`] 与 [`crate::metrics::client`] 在构建 exporter 时复用。

use crate::config::OtelTlsConfig;
use codex_utils_absolute_path::AbsolutePathBuf;
use http::Uri;
use opentelemetry_otlp::OTEL_EXPORTER_OTLP_TIMEOUT;
use opentelemetry_otlp::OTEL_EXPORTER_OTLP_TIMEOUT_DEFAULT;
use opentelemetry_otlp::tonic_types::transport::Certificate as TonicCertificate;
use opentelemetry_otlp::tonic_types::transport::ClientTlsConfig;
use opentelemetry_otlp::tonic_types::transport::Identity as TonicIdentity;
use reqwest::Certificate as ReqwestCertificate;
use reqwest::Identity as ReqwestIdentity;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use std::env;
use std::error::Error;
use std::fs;
use std::io;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::Duration;

/// 将字符串键值对集合转换为 [`HeaderMap`]，跳过无法解析的键或值。
pub(crate) fn build_header_map(headers: &std::collections::HashMap<String, String>) -> HeaderMap {
    let mut header_map = HeaderMap::new();
    for (key, value) in headers {
        if let Ok(name) = HeaderName::from_bytes(key.as_bytes())
            && let Ok(val) = HeaderValue::from_str(value)
        {
            header_map.insert(name, val);
        }
    }
    header_map
}

/// 在端点 host 基础上组装 gRPC TLS 配置，支持自定义 CA 证书与 mTLS 双向认证。
///
/// `endpoint` 用于解析出 host 名作为 SNI 域名；`tls_config` 携带可选的
/// CA 证书与客户端证书/私钥路径。
pub(crate) fn build_grpc_tls_config(
    endpoint: &str,
    tls_config: ClientTlsConfig,
    tls: &OtelTlsConfig,
) -> Result<ClientTlsConfig, Box<dyn Error>> {
    let uri: Uri = endpoint.parse()?;
    let host = uri.host().ok_or_else(|| {
        config_error(format!(
            "OTLP gRPC endpoint {endpoint} does not include a host"
        ))
    })?;

    let mut config = tls_config.domain_name(host.to_owned());

    if let Some(path) = tls.ca_certificate.as_ref() {
        let (pem, _) = read_bytes(path)?;
        config = config.ca_certificate(TonicCertificate::from_pem(pem));
    }

    match (&tls.client_certificate, &tls.client_private_key) {
        (Some(cert_path), Some(key_path)) => {
            let (cert_pem, _) = read_bytes(cert_path)?;
            let (key_pem, _) = read_bytes(key_path)?;
            config = config.identity(TonicIdentity::from_pem(cert_pem, key_pem));
        }
        (Some(_), None) | (None, Some(_)) => {
            return Err(config_error(
                "client_certificate and client_private_key must both be provided for mTLS",
            ));
        }
        (None, None) => {}
    }

    Ok(config)
}

/// 构建带 TLS 配置的阻塞式 HTTP 客户端，用于 OTLP HTTP exporter。
///
/// 使用 `reqwest::blocking::Client`，因为 OTEL exporter 运行在专用 OS 线程上，
/// 这些线程不一定由 tokio 驱动。
pub(crate) fn build_http_client(
    tls: &OtelTlsConfig,
    timeout_var: &str,
) -> Result<reqwest::blocking::Client, Box<dyn Error>> {
    if current_tokio_runtime_is_multi_thread() {
        tokio::task::block_in_place(|| build_http_client_inner(tls, timeout_var))
    } else if tokio::runtime::Handle::try_current().is_ok() {
        let tls = tls.clone();
        let timeout_var = timeout_var.to_string();
        std::thread::spawn(move || {
            build_http_client_inner(&tls, &timeout_var).map_err(|err| err.to_string())
        })
        .join()
        .map_err(|_| config_error("failed to join OTLP blocking HTTP client builder thread"))?
        .map_err(config_error)
    } else {
        build_http_client_inner(tls, timeout_var)
    }
}

/// 判断当前 tokio 运行时是否为多线程模式。
pub(crate) fn current_tokio_runtime_is_multi_thread() -> bool {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread,
        Err(_) => false,
    }
}

/// 实际构建阻塞式 HTTP 客户端的内部实现。
///
/// 根据 TLS 配置加载 CA 证书与客户端身份，并设置请求超时。
fn build_http_client_inner(
    tls: &OtelTlsConfig,
    timeout_var: &str,
) -> Result<reqwest::blocking::Client, Box<dyn Error>> {
    let mut builder =
        reqwest::blocking::Client::builder().timeout(resolve_otlp_timeout(timeout_var));

    if let Some(path) = tls.ca_certificate.as_ref() {
        let (pem, location) = read_bytes(path)?;
        let certificate = ReqwestCertificate::from_pem(pem.as_slice()).map_err(|error| {
            config_error(format!(
                "failed to parse certificate {}: {error}",
                location.display()
            ))
        })?;
        builder = builder
            .tls_built_in_root_certs(false)
            .add_root_certificate(certificate);
    }

    match (&tls.client_certificate, &tls.client_private_key) {
        (Some(cert_path), Some(key_path)) => {
            let (mut cert_pem, cert_location) = read_bytes(cert_path)?;
            let (key_pem, key_location) = read_bytes(key_path)?;
            cert_pem.extend_from_slice(key_pem.as_slice());
            let identity = ReqwestIdentity::from_pem(cert_pem.as_slice()).map_err(|error| {
                config_error(format!(
                    "failed to parse client identity using {} and {}: {error}",
                    cert_location.display(),
                    key_location.display()
                ))
            })?;
            builder = builder.identity(identity).https_only(true);
        }
        (Some(_), None) | (None, Some(_)) => {
            return Err(config_error(
                "client_certificate and client_private_key must both be provided for mTLS",
            ));
        }
        (None, None) => {}
    }

    builder
        .build()
        .map_err(|error| Box::new(error) as Box<dyn Error>)
}

/// 构建异步 HTTP 客户端，用于 OTLP HTTP exporter（traces 等）。
///
/// 与 [`build_http_client`] 类似，但返回异步 [`reqwest::Client`]。
pub(crate) fn build_async_http_client(
    tls: Option<&OtelTlsConfig>,
    timeout_var: &str,
) -> Result<reqwest::Client, Box<dyn Error>> {
    let mut builder = reqwest::Client::builder().timeout(resolve_otlp_timeout(timeout_var));

    if let Some(tls) = tls {
        if let Some(path) = tls.ca_certificate.as_ref() {
            let (pem, location) = read_bytes(path)?;
            let certificate = ReqwestCertificate::from_pem(pem.as_slice()).map_err(|error| {
                config_error(format!(
                    "failed to parse certificate {}: {error}",
                    location.display()
                ))
            })?;
            builder = builder
                .tls_built_in_root_certs(false)
                .add_root_certificate(certificate);
        }

        match (&tls.client_certificate, &tls.client_private_key) {
            (Some(cert_path), Some(key_path)) => {
                let (mut cert_pem, cert_location) = read_bytes(cert_path)?;
                let (key_pem, key_location) = read_bytes(key_path)?;
                cert_pem.extend_from_slice(key_pem.as_slice());
                let identity = ReqwestIdentity::from_pem(cert_pem.as_slice()).map_err(|error| {
                    config_error(format!(
                        "failed to parse client identity using {} and {}: {error}",
                        cert_location.display(),
                        key_location.display()
                    ))
                })?;
                builder = builder.identity(identity).https_only(true);
            }
            (Some(_), None) | (None, Some(_)) => {
                return Err(config_error(
                    "client_certificate and client_private_key must both be provided for mTLS",
                ));
            }
            (None, None) => {}
        }
    }

    builder
        .build()
        .map_err(|error| Box::new(error) as Box<dyn Error>)
}

/// 解析 OTLP 超时时长。
///
/// 优先读取 `signal_var` 指定的环境变量，其次读取通用的
/// `OTEL_EXPORTER_OTLP_TIMEOUT`，最后使用 OTEL SDK 的默认值。
pub(crate) fn resolve_otlp_timeout(signal_var: &str) -> Duration {
    if let Some(timeout) = read_timeout_env(signal_var) {
        return timeout;
    }
    if let Some(timeout) = read_timeout_env(OTEL_EXPORTER_OTLP_TIMEOUT) {
        return timeout;
    }
    OTEL_EXPORTER_OTLP_TIMEOUT_DEFAULT
}

/// 从环境变量读取超时时长（毫秒）。负值或解析失败时返回 `None`。
fn read_timeout_env(var: &str) -> Option<Duration> {
    let value = env::var(var).ok()?;
    let parsed = value.parse::<i64>().ok()?;
    if parsed < 0 {
        return None;
    }
    Some(Duration::from_millis(parsed as u64))
}

/// 读取文件全部字节，返回字节向量与文件路径（用于错误信息展示）。
fn read_bytes(path: &AbsolutePathBuf) -> Result<(Vec<u8>, PathBuf), Box<dyn Error>> {
    match fs::read(path) {
        Ok(bytes) => Ok((bytes, path.to_path_buf())),
        Err(error) => Err(Box::new(io::Error::new(
            error.kind(),
            format!("failed to read {}: {error}", path.display()),
        ))),
    }
}

/// 构造一个表示配置错误的 [`Box<dyn Error>`]。
fn config_error(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(io::Error::new(ErrorKind::InvalidData, message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tokio::runtime::Builder;

    #[test]
    fn current_tokio_runtime_is_multi_thread_detects_runtime_flavor() {
        assert!(!current_tokio_runtime_is_multi_thread());

        let current_thread_runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime");
        assert_eq!(
            current_thread_runtime.block_on(async { current_tokio_runtime_is_multi_thread() }),
            false
        );

        let multi_thread_runtime = Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("multi-thread runtime");
        assert_eq!(
            multi_thread_runtime.block_on(async { current_tokio_runtime_is_multi_thread() }),
            true
        );
    }

    #[test]
    fn build_http_client_works_in_current_thread_runtime() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime");

        let client = runtime.block_on(async {
            build_http_client(&OtelTlsConfig::default(), OTEL_EXPORTER_OTLP_TIMEOUT)
        });

        assert!(client.is_ok());
    }
}
