//! Ollama 本地模型集成库。
//!
//! 提供 Codex 与本地 Ollama 服务交互的能力，包括：
//! - 通过 [`OllamaClient`] 与 Ollama 服务通信
//! - 在使用 `--oss` 时准备本地 OSS 环境（[`ensure_oss_ready`]）
//! - 拉取缺失模型并报告进度（[`pull`] 模块）
//! - 校验 Ollama 版本是否支持 Responses API（[`ensure_responses_supported`]）

mod client;
mod line_buffer;
mod parser;
mod pull;
mod url;

pub use client::OllamaClient;
use codex_core::config::Config;
use codex_model_provider_info::ModelProviderInfo;
pub use pull::CliProgressReporter;
pub use pull::PullEvent;
pub use pull::PullProgressReporter;
pub use pull::TuiProgressReporter;
use semver::Version;

/// 当使用 `--oss` 但未显式指定 `-m` 时使用的默认 OSS 模型。
pub const DEFAULT_OSS_MODEL: &str = "gpt-oss:20b";

/// 在选择 `--oss` 时准备本地 OSS 环境。
///
/// - 确保本地 Ollama 服务可达。
/// - 检查模型是否已存在于本地，若缺失则拉取。
pub async fn ensure_oss_ready(config: &Config) -> std::io::Result<()> {
    // 仅当请求模型为默认 OSS 模型（或未提供 -m）时才下载
    let model = match config.model.as_ref() {
        Some(model) => model,
        None => DEFAULT_OSS_MODEL,
    };

    // 验证本地 Ollama 可达
    let ollama_client = crate::OllamaClient::try_from_oss_provider(config).await?;

    // 若模型本地不存在则拉取
    match ollama_client.fetch_models().await {
        Ok(models) => {
            if !models.iter().any(|m| m == model) {
                let mut reporter = crate::CliProgressReporter::new();
                ollama_client
                    .pull_with_reporter(model, &mut reporter)
                    .await?;
            }
        }
        Err(err) => {
            // 非致命错误；上层仍可继续并稍后呈现错误
            tracing::warn!("Failed to query local models from Ollama: {}.", err);
        }
    }

    Ok(())
}

// 支持 Responses API 所需的最低 Ollama 版本
fn min_responses_version() -> Version {
    Version::new(0, 13, 4)
}

// 判断给定版本是否支持 Responses API：
// 开发版本 0.0.0 视为支持；否则需不低于最低版本
fn supports_responses(version: &Version) -> bool {
    *version == Version::new(0, 0, 0) || *version >= min_responses_version()
}

/// 确保运行中的 Ollama 服务版本足够新，支持 Responses API。
///
/// 当版本端点缺失或无法解析时返回 `Ok(())`。
pub async fn ensure_responses_supported(provider: &ModelProviderInfo) -> std::io::Result<()> {
    let client = crate::OllamaClient::try_from_provider(provider).await?;
    let Some(version) = client.fetch_version().await? else {
        return Ok(());
    };

    if supports_responses(&version) {
        return Ok(());
    }

    let min = min_responses_version();
    Err(std::io::Error::other(format!(
        "Ollama {version} is too old. Codex requires Ollama {min} or newer."
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_responses_for_dev_zero() {
        assert!(supports_responses(&Version::new(0, 0, 0)));
    }

    #[test]
    fn does_not_support_responses_before_cutoff() {
        assert!(!supports_responses(&Version::new(0, 13, 3)));
    }

    #[test]
    fn supports_responses_at_or_after_cutoff() {
        assert!(supports_responses(&Version::new(0, 13, 4)));
        assert!(supports_responses(&Version::new(0, 14, 0)));
    }
}
