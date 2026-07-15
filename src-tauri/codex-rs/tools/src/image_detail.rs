use codex_protocol::models::DEFAULT_IMAGE_DETAIL;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::ImageDetail;
use codex_protocol::openai_models::ModelInfo;

/// 判断指定模型是否支持请求原始（Original）图像细节级别。
///
/// # 参数
/// - `model_info`: 模型信息
///
/// # 返回值
/// 返回 `true` 表示模型支持 `ImageDetail::Original`。
pub fn can_request_original_image_detail(model_info: &ModelInfo) -> bool {
    model_info.supports_image_detail_original
}

/// 规范化输出图像的细节级别，确保 `Original` 仅在模型支持时才被保留。
///
/// # 参数
/// - `model_info`: 模型信息
/// - `detail`: 待规范化的图像细节级别
///
/// # 返回值
/// 返回规范化后的细节级别；若模型不支持 `Original` 或入参为 `None`，则返回 `None`。
pub fn normalize_output_image_detail(
    model_info: &ModelInfo,
    detail: Option<ImageDetail>,
) -> Option<ImageDetail> {
    match detail {
        Some(ImageDetail::Original) if can_request_original_image_detail(model_info) => {
            Some(ImageDetail::Original)
        }
        Some(ImageDetail::Original) | None => None,
        Some(ImageDetail::Auto | ImageDetail::Low | ImageDetail::High) => detail,
    }
}

/// 当模型不支持 `Original` 细节级别时，将工具调用输出中的 `Original` 替换为默认值。
///
/// # 参数
/// - `can_request_original_image_detail`: 是否支持 `Original` 细节级别
/// - `items`: 工具调用输出内容条目切片，会被原地修改
pub fn sanitize_original_image_detail(
    can_request_original_image_detail: bool,
    items: &mut [FunctionCallOutputContentItem],
) {
    if can_request_original_image_detail {
        return;
    }

    for item in items {
        if let FunctionCallOutputContentItem::InputImage { detail, .. } = item
            && matches!(detail, Some(ImageDetail::Original))
        {
            *detail = Some(DEFAULT_IMAGE_DETAIL);
        }
    }
}

#[cfg(test)]
#[path = "image_detail_tests.rs"]
mod tests;
