//! LM Studio 本地服务集成 crate。
//!
//! 提供与本地 LM Studio 服务交互的能力：探测可达性、查询可用模型、
//! 下载缺失模型以及在后台加载指定模型。
//!
//! 主要入口为 [`ensure_oss_ready`]，用于在使用 `--oss` 启动时
//! 准备本地 OSS 环境。

mod client;

pub use client::LMStudioClient;
use codex_core::config::Config;

/// 当 `--oss` 被传入且未显式指定 `-m` 时使用的默认 OSS 模型。
pub const DEFAULT_OSS_MODEL: &str = "openai/gpt-oss-20b";

/// 当选择 `--oss` 时准备本地 OSS 环境。
///
/// - 确保本地 LM Studio 服务可达
/// - 检查模型是否已存在本地，若缺失则触发下载
pub async fn ensure_oss_ready(config: &Config) -> std::io::Result<()> {
    let model = match config.model.as_ref() {
        Some(model) => model,
        None => DEFAULT_OSS_MODEL,
    };

    // 验证本地 LM Studio 服务可达
    let lmstudio_client = LMStudioClient::try_from_provider(config).await?;

    match lmstudio_client.fetch_models().await {
        Ok(models) => {
            // 若目标模型不在本地已有列表中，则触发下载
            if !models.iter().any(|m| m == model) {
                lmstudio_client.download_model(model).await?;
            }
        }
        Err(err) => {
            // 非致命错误；上层仍可继续执行并在后续阶段暴露错误
            tracing::warn!("Failed to query local models from LM Studio: {}.", err);
        }
    }

    // 在后台异步加载模型，避免阻塞主流程
    tokio::spawn({
        let client = lmstudio_client.clone();
        let model = model.to_string();
        async move {
            if let Err(e) = client.load_model(&model).await {
                tracing::warn!("Failed to load model {}: {}", model, e);
            }
        }
    });

    Ok(())
}
