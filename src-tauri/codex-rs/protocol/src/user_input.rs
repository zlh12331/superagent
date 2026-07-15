//! 用户输入类型。
//!
//! 定义 [`UserInput`]——用户提交给 Agent 的输入枚举，涵盖文本、图片、本地图片、
//! skill 选择、结构化 mention 等变体。文本变体支持 `TextElement` 标记，用于在
//! 不修改原文的情况下表示图片占位等富输入元素。

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::models::ImageDetail;

/// Conservative cap so one user message cannot monopolize a large context window.
///
/// 单条用户消息的保守字符上限，防止单条消息占满大上下文窗口。
pub const MAX_USER_INPUT_TEXT_CHARS: usize = 1 << 20;

/// User input
///
/// 用户输入枚举。`#[non_exhaustive]` 表示未来可能新增变体，外部匹配需保留兜底。
#[non_exhaustive]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserInput {
    /// 文本输入。
    Text {
        /// 文本内容。
        text: String,
        /// UI-defined spans within `text` that should be treated as special elements.
        /// These are byte ranges into the UTF-8 `text` buffer and are used to render
        /// or persist rich input markers (e.g., image placeholders) across history
        /// and resume without mutating the literal text.
        ///
        /// UI 定义的、`text` 中需作为特殊元素处理的区间。这些区间是 UTF-8
        /// `text` 缓冲区的字节范围，用于在历史与恢复过程中渲染或持久化富
        /// 输入标记（如图片占位），而不修改原始文本。
        #[serde(default)]
        text_elements: Vec<TextElement>,
    },
    /// Pre‑encoded data: URI image.
    ///
    /// 预编码的 data: URI 图片。
    Image {
        /// 图片 URL（data: URI）。
        image_url: String,
        /// 图片细节级别。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        detail: Option<ImageDetail>,
    },

    /// Local image path provided by the user.  This will be converted to an
    /// `Image` variant (base64 data URL) during request serialization.
    ///
    /// 用户提供的本地图片路径；在请求序列化时会转换为 `Image` 变体（base64 data URL）。
    LocalImage {
        /// 本地图片路径。
        path: std::path::PathBuf,
        /// 图片细节级别。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        detail: Option<ImageDetail>,
    },

    /// Skill selected by the user (name + path to SKILL.md).
    ///
    /// 用户选择的 skill（名称 + SKILL.md 路径）。
    Skill {
        /// skill 名称。
        name: String,
        /// SKILL.md 路径。
        path: std::path::PathBuf,
    },
    /// Explicit structured mention selected by the user.
    ///
    /// `path` identifies the exact mention target, for example
    /// `app://<connector-id>` or `plugin://<plugin-name>@<marketplace-name>`.
    ///
    /// 用户选择的显式结构化 mention。`path` 标识具体 mention 目标，例如
    /// `app://<connector-id>` 或 `plugin://<plugin-name>@<marketplace-name>`。
    Mention {
        /// mention 显示名称。
        name: String,
        /// mention 目标路径。
        path: String,
    },
}

/// 文本中的特殊元素标记。
///
/// 通过字节范围指向父文本缓冲区中的一段内容，并可附带可读占位文本。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS, JsonSchema)]
pub struct TextElement {
    /// Byte range in the parent `text` buffer that this element occupies.
    ///
    /// 该元素在父 `text` 缓冲区中占据的字节范围。
    pub byte_range: ByteRange,
    /// Optional human-readable placeholder for the element, displayed in the UI.
    ///
    /// 可选的人类可读占位文本，用于 UI 展示。
    placeholder: Option<String>,
}

impl TextElement {
    /// 构造一个新的 `TextElement`。
    pub fn new(byte_range: ByteRange, placeholder: Option<String>) -> Self {
        Self {
            byte_range,
            placeholder,
        }
    }

    /// 返回该元素的一个副本，其中 byte range 被重新映射。
    ///
    /// placeholder 保持原样不变；调用方需确保新范围在新文本中仍指向同一
    /// 逻辑元素（以及同一 placeholder）。
    ///
    /// 返回一个字节范围被重新映射的副本。占位文本保持不变；调用方需确保新
    /// 范围在新文本中仍指向同一逻辑元素（与同一占位）。
    pub fn map_range<F>(&self, map: F) -> Self
    where
        F: FnOnce(ByteRange) -> ByteRange,
    {
        Self {
            byte_range: map(self.byte_range),
            placeholder: self.placeholder.clone(),
        }
    }

    /// 设置占位文本。
    pub fn set_placeholder(&mut self, placeholder: Option<String>) {
        self.placeholder = placeholder;
    }

    /// 返回已存储的 placeholder，不回退到 text buffer。
    ///
    /// 仅限在等价协议类型的 `From<TextElement>` 实现内部使用（此时源文本
    /// 不可用）。其他场景应优先使用 `placeholder(text)`。
    ///
    /// 返回已存储的占位文本，不回退到文本缓冲区。仅用于等价协议类型上
    /// `From<TextElement>` 实现内部（此时源文本不可用）；其他场景应优先使用
    /// `placeholder(text)`。
    #[doc(hidden)]
    pub fn _placeholder_for_conversion_only(&self) -> Option<&str> {
        self.placeholder.as_deref()
    }

    /// 返回占位文本；若未存储则回退到从 `text` 中按字节范围截取。
    pub fn placeholder<'a>(&'a self, text: &'a str) -> Option<&'a str> {
        self.placeholder
            .as_deref()
            .or_else(|| text.get(self.byte_range.start..self.byte_range.end))
    }
}

/// UTF-8 文本缓冲区中的字节范围。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, TS, JsonSchema)]
pub struct ByteRange {
    /// UTF-8 文本缓冲区中的 start byte offset（包含）。
    ///
    /// 起始字节偏移（包含）。
    pub start: usize,
    /// End byte offset (exclusive) within the UTF-8 text buffer.
    ///
    /// 结束字节偏移（不包含）。
    pub end: usize,
}

impl From<std::ops::Range<usize>> for ByteRange {
    fn from(range: std::ops::Range<usize>) -> Self {
        Self {
            start: range.start,
            end: range.end,
        }
    }
}
