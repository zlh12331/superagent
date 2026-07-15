use starlark::Error as StarlarkError;
use thiserror::Error;

/// 本 crate 的统一 `Result` 别名。
pub type Result<T> = std::result::Result<T, Error>;

/// 源文件中的文本位置（行号、列号，均从 1 开始）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextPosition {
    /// 行号（从 1 开始）。
    pub line: usize,
    /// 列号（从 1 开始）。
    pub column: usize,
}

/// 源文件中的文本范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextRange {
    /// 起始位置（含）。
    pub start: TextPosition,
    /// 结束位置（不含）。
    pub end: TextPosition,
}

/// 错误在源文件中的定位信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorLocation {
    /// 源文件路径或标识符。
    pub path: String,
    /// 错误对应的文本范围。
    pub range: TextRange,
}

/// execpolicy 解析与评估过程中可能发生的错误。
#[derive(Debug, Error)]
pub enum Error {
    /// 无效的 decision 字符串。
    #[error("invalid decision: {0}")]
    InvalidDecision(String),
    /// 无效的 pattern 元素。
    #[error("invalid pattern element: {0}")]
    InvalidPattern(String),
    /// 无效的示例（example）。
    #[error("invalid example: {0}")]
    InvalidExample(String),
    /// 无效的规则定义。
    #[error("invalid rule: {0}")]
    InvalidRule(String),
    /// 期望每个正例（match example）至少被一条规则匹配，但存在未匹配的正例。
    #[error(
        "expected every example to match at least one rule. rules: {rules:?}; unmatched examples: \
         {examples:?}"
    )]
    ExampleDidNotMatch {
        /// 参与匹配的规则字符串表示。
        rules: Vec<String>,
        /// 未被任何规则匹配的正例。
        examples: Vec<String>,
        /// 错误位置（若可定位）。
        location: Option<ErrorLocation>,
    },
    /// 期望反例（not_match example）不被任何规则匹配，但实际被匹配。
    #[error("expected example to not match rule `{rule}`: {example}")]
    ExampleDidMatch {
        /// 误匹配了反例的规则字符串表示。
        rule: String,
        /// 被规则匹配的反例。
        example: String,
        /// 错误位置（若可定位）。
        location: Option<ErrorLocation>,
    },
    /// 来自 Starlark 解析器的底层错误。
    #[error("starlark error: {0}")]
    Starlark(StarlarkError),
}

impl Error {
    /// 为错误附加位置信息。
    ///
    /// 仅对 `ExampleDidNotMatch` 与 `ExampleDidMatch` 生效；其他错误原样返回。
    pub fn with_location(self, location: ErrorLocation) -> Self {
        match self {
            Error::ExampleDidNotMatch {
                rules,
                examples,
                location: None,
            } => Error::ExampleDidNotMatch {
                rules,
                examples,
                location: Some(location),
            },
            Error::ExampleDidMatch {
                rule,
                example,
                location: None,
            } => Error::ExampleDidMatch {
                rule,
                example,
                location: Some(location),
            },
            other => other,
        }
    }

    /// 返回错误的位置信息（若存在）。
    ///
    /// 对 `Starlark` 错误，会尝试从其 span 解析出位置信息。
    pub fn location(&self) -> Option<ErrorLocation> {
        match self {
            Error::ExampleDidNotMatch { location, .. }
            | Error::ExampleDidMatch { location, .. } => location.clone(),
            Error::Starlark(err) => err.span().map(|span| {
                let resolved = span.resolve_span();
                ErrorLocation {
                    path: span.filename().to_string(),
                    range: TextRange {
                        start: TextPosition {
                            line: resolved.begin.line + 1,
                            column: resolved.begin.column + 1,
                        },
                        end: TextPosition {
                            line: resolved.end.line + 1,
                            column: resolved.end.column + 1,
                        },
                    },
                }
            }),
            _ => None,
        }
    }
}
