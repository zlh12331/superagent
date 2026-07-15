use serde::Deserialize;
use serde::Serialize;

/// 图片生成（generation）请求载荷。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ImageGenerationRequest {
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<ImageBackground>,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<ImageQuality>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
}

/// 图片编辑（edit）请求载荷。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ImageEditRequest {
    pub images: Vec<ImageUrl>,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<ImageBackground>,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<ImageQuality>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
}

/// 图片 URL 包装结构。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImageUrl {
    pub image_url: String,
}

/// 图片背景选项枚举。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageBackground {
    Transparent,
    Opaque,
    Auto,
}

/// 图片质量选项枚举。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageQuality {
    Low,
    Medium,
    High,
    Auto,
}

/// 图片生成 / 编辑响应。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ImageResponse {
    /// 响应创建时间（Unix 秒）。
    pub created: u64,
    pub data: Vec<ImageData>,
    #[serde(default)]
    pub background: Option<ImageBackground>,
    #[serde(default)]
    pub quality: Option<ImageQuality>,
    #[serde(default)]
    pub size: Option<String>,
}

/// 单张生成的图片数据。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ImageData {
    /// Base64 编码的图片数据。
    pub b64_json: String,
}
