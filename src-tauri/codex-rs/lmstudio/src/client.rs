//! LM Studio HTTP 客户端模块。
//!
//! 封装与本地 LM Studio 服务的 HTTP 交互：探测可达性、查询模型列表、
//! 下载缺失模型以及触发模型加载。同时支持通过 `lms` CLI 完成模型下载。

use codex_core::config::Config;
use codex_model_provider_info::LMSTUDIO_OSS_PROVIDER_ID;
use std::io;
use std::path::Path;

/// 与本地 LM Studio 实例交互的客户端。
#[derive(Clone)]
pub struct LMStudioClient {
    /// 底层 reqwest 客户端
    client: reqwest::Client,
    /// LM Studio 服务的 base URL（如 "http://localhost:1234"）
    base_url: String,
}

/// 当 LM Studio 服务不可达时返回的错误信息（含安装/启动指引）。
const LMSTUDIO_CONNECTION_ERROR: &str = "LM Studio is not responding. Install from https://lmstudio.ai/download and run 'lms server start'.";

impl LMStudioClient {
    /// 基于 Config 中的 provider 定义构造客户端，并验证服务可达。
    pub async fn try_from_provider(config: &Config) -> std::io::Result<Self> {
        let provider = config
            .model_providers
            .get(LMSTUDIO_OSS_PROVIDER_ID)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("Built-in provider {LMSTUDIO_OSS_PROVIDER_ID} not found",),
                )
            })?;
        let base_url = provider.base_url.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "oss provider must have a base_url",
            )
        })?;

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let client = LMStudioClient {
            client,
            base_url: base_url.to_string(),
        };
        client.check_server().await?;

        Ok(client)
    }

    /// 通过访问 `/models` 端点探测服务是否可达。
    async fn check_server(&self) -> io::Result<()> {
        let url = format!("{}/models", self.base_url.trim_end_matches('/'));
        let response = self.client.get(&url).send().await;

        if let Ok(resp) = response {
            if resp.status().is_success() {
                Ok(())
            } else {
                Err(io::Error::other(format!(
                    "Server returned error: {} {LMSTUDIO_CONNECTION_ERROR}",
                    resp.status()
                )))
            }
        } else {
            Err(io::Error::other(LMSTUDIO_CONNECTION_ERROR))
        }
    }

    /// 通过发送一个 `max_tokens=1` 的空请求求来加载指定模型。
    ///
    /// 这是一种触发 LM Studio 后台加载模型的简单方式：发送一个最小化的推理请求，
    /// LM Studio 收到后会预先加载该模型。
    pub async fn load_model(&self, model: &str) -> io::Result<()> {
        let url = format!("{}/responses", self.base_url.trim_end_matches('/'));

        let request_body = serde_json::json!({
            "model": model,
            "input": "",
            "max_output_tokens": 1
        });

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| io::Error::other(format!("Request failed: {e}")))?;

        if response.status().is_success() {
            tracing::info!("Successfully loaded model '{model}'");
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "Failed to load model: {}",
                response.status()
            )))
        }
    }

    /// 返回 LM Studio 服务上可用的模型 ID 列表。
    pub async fn fetch_models(&self) -> io::Result<Vec<String>> {
        let url = format!("{}/models", self.base_url.trim_end_matches('/'));
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| io::Error::other(format!("Request failed: {e}")))?;

        if response.status().is_success() {
            let json: serde_json::Value = response.json().await.map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("JSON parse error: {e}"))
            })?;
            let models = json["data"]
                .as_array()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "No 'data' array in response")
                })?
                .iter()
                .filter_map(|model| model["id"].as_str())
                .map(std::string::ToString::to_string)
                .collect();
            Ok(models)
        } else {
            Err(io::Error::other(format!(
                "Failed to fetch models: {}",
                response.status()
            )))
        }
    }

    /// 查找 `lms` 可执行文件，若不在 PATH 中则尝试回退路径。
    fn find_lms() -> std::io::Result<String> {
        Self::find_lms_with_home_dir(/*home_dir*/ None)
    }

    /// 带可选 home_dir 的 `lms` 查找实现，便于单元测试注入路径。
    fn find_lms_with_home_dir(home_dir: Option<&str>) -> std::io::Result<String> {
        // 优先在 PATH 中查找 `lms`
        if which::which("lms").is_ok() {
            return Ok("lms".to_string());
        }

        // 若 PATH 中未找到，则尝试平台特定的回退路径
        let home = match home_dir {
            Some(dir) => dir.to_string(),
            None => {
                #[cfg(unix)]
                {
                    std::env::var("HOME").unwrap_or_default()
                }
                #[cfg(windows)]
                {
                    std::env::var("USERPROFILE").unwrap_or_default()
                }
            }
        };

        #[cfg(unix)]
        let fallback_path = format!("{home}/.lmstudio/bin/lms");

        #[cfg(windows)]
        let fallback_path = format!("{home}/.lmstudio/bin/lms.exe");

        if Path::new(&fallback_path).exists() {
            Ok(fallback_path)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "LM Studio not found. Please install LM Studio from https://lmstudio.ai/",
            ))
        }
    }

    /// 通过 `lms get --yes <model>` 命令下载指定模型。
    pub async fn download_model(&self, model: &str) -> std::io::Result<()> {
        let lms = Self::find_lms()?;
        eprintln!("Downloading model: {model}");

        let status = std::process::Command::new(&lms)
            .args(["get", "--yes", model])
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| {
                std::io::Error::other(format!("Failed to execute '{lms} get --yes {model}': {e}"))
            })?;

        if !status.success() {
            return Err(std::io::Error::other(format!(
                "Model download failed with exit code: {}",
                status.code().unwrap_or(-1)
            )));
        }

        tracing::info!("Successfully downloaded model '{model}'");
        Ok(())
    }

    /// 低层构造器：直接传入原始 host root（如 "http://localhost:1234"）。
    #[cfg(test)]
    fn from_host_root(host_root: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            base_url: host_root.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use super::*;

    #[tokio::test]
    async fn test_fetch_models_happy_path() {
        if std::env::var(codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR).is_ok() {
            tracing::info!(
                "{} is set; skipping test_fetch_models_happy_path",
                codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR
            );
            return;
        }

        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_raw(
                    serde_json::json!({
                        "data": [
                            {"id": "openai/gpt-oss-20b"},
                        ]
                    })
                    .to_string(),
                    "application/json",
                ),
            )
            .mount(&server)
            .await;

        let client = LMStudioClient::from_host_root(server.uri());
        let models = client.fetch_models().await.expect("fetch models");
        assert!(models.contains(&"openai/gpt-oss-20b".to_string()));
    }

    #[tokio::test]
    async fn test_fetch_models_no_data_array() {
        if std::env::var(codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR).is_ok() {
            tracing::info!(
                "{} is set; skipping test_fetch_models_no_data_array",
                codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR
            );
            return;
        }

        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_raw(serde_json::json!({}).to_string(), "application/json"),
            )
            .mount(&server)
            .await;

        let client = LMStudioClient::from_host_root(server.uri());
        let result = client.fetch_models().await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("No 'data' array in response")
        );
    }

    #[tokio::test]
    async fn test_fetch_models_server_error() {
        if std::env::var(codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR).is_ok() {
            tracing::info!(
                "{} is set; skipping test_fetch_models_server_error",
                codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR
            );
            return;
        }

        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(wiremock::ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let client = LMStudioClient::from_host_root(server.uri());
        let result = client.fetch_models().await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Failed to fetch models: 500")
        );
    }

    #[tokio::test]
    async fn test_check_server_happy_path() {
        if std::env::var(codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR).is_ok() {
            tracing::info!(
                "{} is set; skipping test_check_server_happy_path",
                codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR
            );
            return;
        }

        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = LMStudioClient::from_host_root(server.uri());
        client
            .check_server()
            .await
            .expect("server check should pass");
    }

    #[tokio::test]
    async fn test_check_server_error() {
        if std::env::var(codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR).is_ok() {
            tracing::info!(
                "{} is set; skipping test_check_server_error",
                codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR
            );
            return;
        }

        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(wiremock::ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let client = LMStudioClient::from_host_root(server.uri());
        let result = client.check_server().await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Server returned error: 404")
        );
    }

    #[test]
    fn test_find_lms() {
        let result = LMStudioClient::find_lms();

        match result {
            Ok(_) => {
                // lms was found in PATH - that's fine
            }
            Err(e) => {
                // Expected error when LM Studio not installed
                assert!(e.to_string().contains("LM Studio not found"));
            }
        }
    }

    #[test]
    fn test_find_lms_with_mock_home() {
        // Test fallback path construction without touching env vars
        #[cfg(unix)]
        {
            let result = LMStudioClient::find_lms_with_home_dir(Some("/test/home"));
            if let Err(e) = result {
                assert!(e.to_string().contains("LM Studio not found"));
            }
        }

        #[cfg(windows)]
        {
            let result = LMStudioClient::find_lms_with_home_dir(Some("C:\\test\\home"));
            if let Err(e) = result {
                assert!(e.to_string().contains("LM Studio not found"));
            }
        }
    }

    #[test]
    fn test_from_host_root() {
        let client = LMStudioClient::from_host_root("http://localhost:1234");
        assert_eq!(client.base_url, "http://localhost:1234");

        let client = LMStudioClient::from_host_root("https://example.com:8080/api");
        assert_eq!(client.base_url, "https://example.com:8080/api");
    }
}
