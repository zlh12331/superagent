//! 图片预处理逻辑。
//!
//! 本模块在发送 prompt 前对 `ResponseItem` 中的图片进行预处理：
//! 拒绝远程 URL、不支持 `low` detail、按 detail 级别缩放 data URL 图片。
//! 处理失败的图片会被替换为占位文本。

use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::ImageDetail;
use codex_protocol::models::ResponseItem;
use codex_utils_image::ImageProcessingError;
use codex_utils_image::PromptImageMode;
use codex_utils_image::PromptImageResizeLimits;
use codex_utils_image::load_data_url_for_prompt;
use tracing::warn;

/// 图片处理失败时使用的占位文本。
pub(crate) const IMAGE_PROCESSING_ERROR_PLACEHOLDER: &str =
    "image content omitted because it could not be processed";
/// 图片过大时使用的占位文本。
const IMAGE_TOO_LARGE_PLACEHOLDER: &str =
    "image content omitted because it exceeded the supported size limit; use a smaller image";
/// 不支持 `low` detail 时使用的占位文本。
const UNSUPPORTED_LOW_DETAIL_PLACEHOLDER: &str = "image content omitted because detail 'low' is not supported; use 'high', 'original', or 'auto'";
/// 远程图片 URL 不支持时使用的占位文本。
const REMOTE_IMAGE_URL_PLACEHOLDER: &str =
    "image content omitted because remote image URLs are not supported";

/// `high` detail 模式下的缩放限制。
const HIGH_DETAIL_LIMITS: PromptImageResizeLimits = PromptImageResizeLimits {
    max_dimension: 2048,
    max_patches: 2_500,
};
/// `original` detail 模式下的缩放限制。
const ORIGINAL_DETAIL_LIMITS: PromptImageResizeLimits = PromptImageResizeLimits {
    max_dimension: 6000,
    max_patches: 10_000,
};

/// 图片预处理错误类型。
#[derive(Debug, thiserror::Error)]
enum ImagePreparationError {
    /// 远程图片 URL 不支持。
    #[error("remote image URLs are not supported")]
    RemoteUrlUnsupported,
    /// `low` detail 不支持。
    #[error("image detail `low` is not supported")]
    UnsupportedLowDetail,
    /// 图片处理错误。
    #[error(transparent)]
    Processing(#[from] ImageProcessingError),
}

impl ImagePreparationError {
    /// 根据错误类型返回对应的占位文本。
    fn placeholder(&self) -> &'static str {
        match self {
            ImagePreparationError::RemoteUrlUnsupported => REMOTE_IMAGE_URL_PLACEHOLDER,
            ImagePreparationError::UnsupportedLowDetail => UNSUPPORTED_LOW_DETAIL_PLACEHOLDER,
            ImagePreparationError::Processing(ImageProcessingError::ImageTooLarge { .. }) => {
                IMAGE_TOO_LARGE_PLACEHOLDER
            }
            ImagePreparationError::Processing(_) => IMAGE_PROCESSING_ERROR_PLACEHOLDER,
        }
    }
}

/// 批量预处理 `ResponseItem` 列表中的图片。
pub(crate) fn prepare_response_items(items: &mut [ResponseItem]) {
    for item in items {
        match item {
            ResponseItem::Message { content, .. } => prepare_message_content(content),
            ResponseItem::FunctionCallOutput { output, .. }
            | ResponseItem::CustomToolCallOutput { output, .. } => {
                if let Some(content) = output.content_items_mut() {
                    prepare_tool_output_content(content);
                }
            }
            ResponseItem::AdditionalTools { .. }
            | ResponseItem::Reasoning { .. }
            | ResponseItem::AgentMessage { .. }
            | ResponseItem::LocalShellCall { .. }
            | ResponseItem::FunctionCall { .. }
            | ResponseItem::ToolSearchCall { .. }
            | ResponseItem::CustomToolCall { .. }
            | ResponseItem::ToolSearchOutput { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::ImageGenerationCall { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::CompactionTrigger { .. }
            | ResponseItem::ContextCompaction { .. }
            | ResponseItem::Other => {}
        }
    }
}

/// 预处理消息内容中的图片。
fn prepare_message_content(items: &mut [ContentItem]) {
    for item in items {
        if let ContentItem::InputImage { image_url, detail } = item
            && let Err(error) = prepare_image(image_url, *detail)
        {
            warn!(%error, "failed to prepare message image");
            *item = ContentItem::InputText {
                text: error.placeholder().to_string(),
            };
        }
    }
}

/// 预处理工具输出内容中的图片。
fn prepare_tool_output_content(items: &mut [FunctionCallOutputContentItem]) {
    for item in items {
        if let FunctionCallOutputContentItem::InputImage { image_url, detail } = item
            && let Err(error) = prepare_image(image_url, *detail)
        {
            warn!(%error, "failed to prepare tool output image");
            *item = FunctionCallOutputContentItem::InputText {
                text: error.placeholder().to_string(),
            };
        }
    }
}

/// 判断是否为远程图片 URL（http/https）。
fn is_remote_image_url(image_url: &str) -> bool {
    image_url.split_once(':').is_some_and(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    })
}

/// 判断是否为 data URL。
fn is_data_url(image_url: &str) -> bool {
    image_url
        .get(.."data:".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
}

/// 处理单张图片：校验 URL 类型与 detail，按限制缩放后写回 data URL。
fn prepare_image(
    image_url: &mut String,
    detail: Option<ImageDetail>,
) -> Result<(), ImagePreparationError> {
    if is_remote_image_url(image_url) {
        return Err(ImagePreparationError::RemoteUrlUnsupported);
    }
    if !is_data_url(image_url) {
        return Ok(());
    }

    let limits = match detail {
        None | Some(ImageDetail::Auto | ImageDetail::High) => HIGH_DETAIL_LIMITS,
        Some(ImageDetail::Original) => ORIGINAL_DETAIL_LIMITS,
        Some(ImageDetail::Low) => return Err(ImagePreparationError::UnsupportedLowDetail),
    };
    let image = load_data_url_for_prompt(image_url, PromptImageMode::ResizeWithLimits(limits))?;
    *image_url = image.into_data_url();
    Ok(())
}

#[cfg(test)]
#[path = "image_preparation_tests.rs"]
mod tests;
