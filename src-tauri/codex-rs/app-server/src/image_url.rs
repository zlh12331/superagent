/// 当客户端传入远程图片 URL 时返回的错误提示文案。
///
/// 协议要求图片以 inline data URL 形式提供，远程 URL 不被支持。
pub(crate) const REMOTE_IMAGE_URL_ERROR: &str =
    "remote image URLs are not supported; use an inline data URL instead";

/// 判断给定的图片 URL 是否为远程 URL（`http:` 或 `https:`）。
///
/// 通过第一个 `:` 之前的部分识别 scheme，大小写不敏感。
///
/// # 参数
///
/// - `image_url`: 待判断的图片 URL 字符串
///
/// # 返回值
///
/// 当 scheme 为 `http` 或 `https`（大小写不敏感）时返回 `true`，否则 `false`。
pub(crate) fn is_remote_image_url(image_url: &str) -> bool {
    image_url.split_once(':').is_some_and(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    })
}
