//! Tauri 应用的共享类型与校验函数。
//!
//! 本模块集中定义了跨模块复用的常量、数据结构和输入校验函数，
//! 包括用户偏好设置（[`AppPreferences`]）、崩溃报告数据（[`CrashReportData`]）、
//! 恢复操作错误类型（[`RecoveryError`]）以及文件名/字符串/主题校验函数。
//!
//! 所有类型均派生了 `Serialize`/`Deserialize` 和 `specta::Type`，
//! 以便通过 tauri-specta 自动生成前端 TypeScript 类型定义。

use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::LazyLock;

use crate::error::AppError;

/// 快速面板的默认全局快捷键。
///
/// 使用 `CommandOrControl` 前缀以跨平台兼容（macOS 为 Command，Windows/Linux 为 Ctrl）。
pub const DEFAULT_QUICK_PANE_SHORTCUT: &str = "CommandOrControl+Shift+.";

/// 紧急恢复数据文件的最大字节数（10MB）。
///
/// 超过此大小的恢复数据会被拒绝写入，防止磁盘空间被异常大的数据耗尽。
pub const MAX_RECOVERY_DATA_BYTES: u32 = 10_485_760;

/// 预编译的文件名校验正则模式。
///
/// 仅允许字母、数字、下划线、连字符，以及单个可选的扩展名段。
/// 例如：`document`、`my-file_v2.json` 合法；`path/to`、`file.tar.gz` 非法。
// 静态正则模式编译时验证，运行时不可达失败路径
#[allow(clippy::expect_used)]
pub static FILENAME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$")
        .expect("Failed to compile filename regex pattern")
});

// ============================================================================
// 偏好设置（Preferences）
// ============================================================================

/// 返回默认主题值 `"system"`。
///
/// 同时被 `AppPreferences::default()` 和 serde 反序列化使用：
/// 当 JSON 中缺少 `theme` 字段时，serde 会调用此函数填充默认值，
/// 保证 `theme` 字段始终有值。
fn default_theme() -> String {
    "system".to_string()
}

/// 用户偏好设置，会持久化到磁盘（`preferences.json`）。
///
/// 仅包含需要在会话之间保留的设置项。所有字段都通过 tauri-specta
/// 暴露给前端，前端可直接读写这些字段。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppPreferences {
    /// UI 主题模式：`"light"`、`"dark"` 或 `"system"`（跟随系统）。
    ///
    /// 缺失时使用 `default_theme()` 填充 `"system"`。
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 快速面板的全局快捷键（如 `"CommandOrControl+Shift+."`）。
    ///
    /// 若为 `None`，使用 [`DEFAULT_QUICK_PANE_SHORTCUT`] 默认值。
    pub quick_pane_shortcut: Option<String>,
    /// 用户偏好的界面语言代码（如 `"en"`、`"zh"`、`"ja"`）。
    ///
    /// 若为 `None`，使用系统区域设置自动检测。
    pub language: Option<String>,
    /// 崩溃报告授权状态：
    /// - `None`：尚未询问用户
    /// - `Some(true)`：用户已授权
    /// - `Some(false)`：用户已拒绝
    pub crash_reporting_consent: Option<bool>,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            quick_pane_shortcut: None,     // None 表示使用默认快捷键
            language: None,                // None 表示使用系统语言
            crash_reporting_consent: None, // None 表示尚未询问授权
        }
    }
}

// ============================================================================
// 崩溃报告（Crash Reporting）
// ============================================================================

/// 崩溃报告数据，由 panic hook 捕获并写入磁盘。
///
/// 应用下次启动时，前端会读取此数据并在用户已授权的情况下发送给 Sentry。
/// JSON 文件路径由 [`crate::commands::crash_report`] 模块管理。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CrashReportData {
    /// 崩溃类型标识（当前固定为 `"rust_panic"`）
    pub crash_type: String,
    /// panic 消息文本（已脱敏）
    pub message: String,
    /// 源码位置（`文件:行号:列号`），可能为 `None`
    pub location: Option<String>,
    /// 完整的调用栈回溯字符串（已脱敏）
    pub backtrace: String,
    /// Unix 时间戳（自 epoch 起的秒数，浮点数）
    pub timestamp: f64,
    /// 崩溃发生时的应用版本号
    pub app_version: String,
}

// ============================================================================
// 恢复操作错误（Recovery Errors）
// ============================================================================

/// 恢复操作的错误类型，使用类型化变体以便前端精确匹配。
///
/// 使用 `tag = "kind"` 与 [`AppError`](crate::error::AppError) 的 serde tag 保持一致，
/// 前端可通过单一的 `kind` 判别字段处理所有错误类型。
#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize, Type)]
#[serde(tag = "kind")]
pub enum RecoveryError {
    /// 文件不存在（属于预期场景，非故障）
    #[error("File not found")]
    FileNotFound,
    /// 文件名校验失败
    #[error("Validation error: {message}")]
    ValidationError { message: String },
    /// 数据超出大小限制
    #[error("Data too large (max {max_bytes} bytes)")]
    DataTooLarge { max_bytes: u32 },
    /// 文件系统读写错误
    #[error("IO error: {message}")]
    IoError { message: String },
    /// JSON 序列化/反序列化错误
    #[error("Parse error: {message}")]
    ParseError { message: String },
}

// ============================================================================
// 校验函数（Validation Functions）
// ============================================================================

/// 校验文件名是否安全用于文件系统操作。
///
/// 仅允许字母、数字、下划线、连字符和单个扩展名段。
/// 阻止路径分隔符（`/`、`\`）、空格、特殊字符（`:`、`*`、`?` 等），
/// 防止路径遍历攻击和跨平台文件名兼容问题。
///
/// # 校验规则
///
/// 1. 非空；
/// 2. 字符数不超过 100；
/// 3. 匹配 [`FILENAME_PATTERN`] 正则。
pub fn validate_filename(filename: &str) -> Result<(), AppError> {
    if filename.is_empty() {
        return Err(AppError::validation("Filename cannot be empty"));
    }

    if filename.chars().count() > 100 {
        return Err(AppError::validation(
            "Filename too long (max 100 characters)",
        ));
    }

    if !FILENAME_PATTERN.is_match(filename) {
        return Err(AppError::validation(
            "Invalid filename: only alphanumeric characters, dashes, underscores, and dots allowed",
        ));
    }

    Ok(())
}

/// 校验字符串输入的长度（按字符数计，非字节数）。
///
/// 使用 `chars().count()` 而非 `len()`，确保多字节字符（如中文、emoji）
/// 被正确计数。例如 `"你好"` 是 2 个字符但 6 个字节。
///
/// # 参数
///
/// - `input`：待校验的字符串
/// - `max_len`：最大允许字符数
/// - `field_name`：字段名（用于错误消息，如 `"Name"`）
pub fn validate_string_input(
    input: &str,
    max_len: usize,
    field_name: &str,
) -> Result<(), AppError> {
    let char_count = input.chars().count();
    if char_count > max_len {
        return Err(AppError::validation(format!(
            "{field_name} too long (max {max_len} characters)"
        )));
    }
    Ok(())
}

/// 校验主题值是否合法。
///
/// 仅接受 `"light"`、`"dark"` 或 `"system"` 三个值。
/// 不支持大小写变体（如 `"Light"` 会被拒绝），保证配置值的一致性。
pub fn validate_theme(theme: &str) -> Result<(), AppError> {
    match theme {
        "light" | "dark" | "system" => Ok(()),
        _ => Err(AppError::validation(
            "Invalid theme: must be 'light', 'dark', or 'system'",
        )),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::*;

    // =========================================================================
    // validate_filename — 正向用例
    // =========================================================================

    #[test]
    fn validate_filename_accepts_simple_name() {
        assert!(validate_filename("document").is_ok());
    }

    #[test]
    fn validate_filename_accepts_name_with_dashes() {
        assert!(validate_filename("my-document").is_ok());
    }

    #[test]
    fn validate_filename_accepts_name_with_underscores() {
        assert!(validate_filename("my_document").is_ok());
    }

    #[test]
    fn validate_filename_accepts_alphanumeric_mix() {
        assert!(validate_filename("file123").is_ok());
    }

    #[test]
    fn validate_filename_accepts_single_extension() {
        assert!(validate_filename("document.json").is_ok());
        assert!(validate_filename("archive_v2.txt").is_ok());
    }

    #[test]
    fn validate_filename_accepts_uppercase_chars() {
        assert!(validate_filename("MyDocument").is_ok());
    }

    // =========================================================================
    // validate_filename — 边界用例
    // =========================================================================

    #[test]
    fn validate_filename_accepts_single_char() {
        assert!(validate_filename("a").is_ok());
    }

    #[test]
    fn validate_filename_accepts_exactly_100_chars() {
        let name = "a".repeat(100);
        assert!(validate_filename(&name).is_ok());
    }

    #[test]
    fn validate_filename_rejects_empty_string() {
        let result = validate_filename("");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("cannot be empty"));
    }

    #[test]
    fn validate_filename_rejects_101_chars() {
        let name = "a".repeat(101);
        let result = validate_filename(&name);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("too long"));
    }

    // =========================================================================
    // validate_filename — 异常用例
    // =========================================================================

    #[test]
    fn validate_filename_rejects_path_separator_slash() {
        assert!(validate_filename("path/to/file").is_err());
    }

    #[test]
    fn validate_filename_rejects_backslash() {
        assert!(validate_filename("path\\file").is_err());
    }

    #[test]
    fn validate_filename_rejects_colon() {
        assert!(validate_filename("file:name").is_err());
    }

    #[test]
    fn validate_filename_rejects_asterisk() {
        assert!(validate_filename("file*name").is_err());
    }

    #[test]
    fn validate_filename_rejects_question_mark() {
        assert!(validate_filename("file?name").is_err());
    }

    #[test]
    fn validate_filename_rejects_double_quote() {
        assert!(validate_filename("file\"name").is_err());
    }

    #[test]
    fn validate_filename_rejects_angle_brackets() {
        assert!(validate_filename("file<name>").is_err());
    }

    #[test]
    fn validate_filename_rejects_pipe() {
        assert!(validate_filename("file|name").is_err());
    }

    #[test]
    fn validate_filename_rejects_double_extension() {
        // 正则仅允许单个扩展名段，因此双扩展名会被拒绝
        assert!(validate_filename("file.tar.gz").is_err());
    }

    #[test]
    fn validate_filename_rejects_leading_dot() {
        assert!(validate_filename(".hidden").is_err());
    }

    #[test]
    fn validate_filename_rejects_spaces() {
        assert!(validate_filename("my file").is_err());
    }

    // =========================================================================
    // validate_string_input — 正向/边界/异常用例
    // =========================================================================

    #[test]
    fn validate_string_input_accepts_within_limit() {
        assert!(validate_string_input("hello", 100, "Name").is_ok());
    }

    #[test]
    fn validate_string_input_accepts_exact_max_length() {
        let input = "a".repeat(50);
        assert!(validate_string_input(&input, 50, "Field").is_ok());
    }

    #[test]
    fn validate_string_input_accepts_empty_string() {
        assert!(validate_string_input("", 100, "Name").is_ok());
    }

    #[test]
    fn validate_string_input_accepts_multibyte_chars() {
        // CJK 字符：每个字符计为 1，而非 3 个字节
        let input = "你好世界"; // 4 个字符
        assert!(validate_string_input(input, 10, "Name").is_ok());
    }

    #[test]
    fn validate_string_input_rejects_exceeding_limit() {
        let input = "a".repeat(101);
        let result = validate_string_input(&input, 100, "Name");
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("too long"));
        assert!(err_msg.contains("Name"));
    }

    #[test]
    fn validate_string_input_rejects_exceeding_multibyte_limit() {
        let input = "你好".repeat(51); // 102 个字符
        let result = validate_string_input(&input, 100, "Name");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("too long"));
    }

    // =========================================================================
    // validate_theme — 正向/边界/异常用例
    // =========================================================================

    #[test]
    fn validate_theme_accepts_light() {
        assert!(validate_theme("light").is_ok());
    }

    #[test]
    fn validate_theme_accepts_dark() {
        assert!(validate_theme("dark").is_ok());
    }

    #[test]
    fn validate_theme_accepts_system() {
        assert!(validate_theme("system").is_ok());
    }

    #[test]
    fn validate_theme_rejects_empty_string() {
        let result = validate_theme("");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Invalid theme"));
    }

    #[test]
    fn validate_theme_rejects_invalid_value() {
        let result = validate_theme("purple");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Invalid theme"));
    }

    #[test]
    fn validate_theme_rejects_case_variants() {
        assert!(validate_theme("Light").is_err());
        assert!(validate_theme("DARK").is_err());
        assert!(validate_theme("System").is_err());
    }

    // =========================================================================
    // AppPreferences::default — 正向用例
    // =========================================================================

    #[test]
    fn app_preferences_default_has_system_theme() {
        let prefs = AppPreferences::default();
        assert_eq!(prefs.theme, "system");
    }

    #[test]
    fn app_preferences_default_has_none_shortcut() {
        let prefs = AppPreferences::default();
        assert!(prefs.quick_pane_shortcut.is_none());
    }

    #[test]
    fn app_preferences_default_has_none_language() {
        let prefs = AppPreferences::default();
        assert!(prefs.language.is_none());
    }

    #[test]
    fn app_preferences_default_has_none_crash_consent() {
        let prefs = AppPreferences::default();
        assert!(prefs.crash_reporting_consent.is_none());
    }

    #[test]
    fn app_preferences_serializes_to_json() {
        let prefs = AppPreferences::default();
        let json = serde_json::to_string(&prefs).expect("Failed to serialize");
        assert!(json.contains("system"));
        // 验证序列化-反序列化往返一致性
        let deserialized: AppPreferences =
            serde_json::from_str(&json).expect("Failed to deserialize");
        assert_eq!(deserialized.theme, prefs.theme);
    }

    // =========================================================================
    // RecoveryError — Display trait 用例
    // =========================================================================

    #[test]
    fn recovery_error_file_not_found_display() {
        let err = RecoveryError::FileNotFound;
        assert_eq!(format!("{err}"), "File not found");
    }

    #[test]
    fn recovery_error_validation_display() {
        let err = RecoveryError::ValidationError {
            message: "bad input".to_string(),
        };
        assert_eq!(format!("{err}"), "Validation error: bad input");
    }

    #[test]
    fn recovery_error_data_too_large_display() {
        let err = RecoveryError::DataTooLarge {
            max_bytes: 10485760,
        };
        assert!(format!("{err}").contains("10485760"));
    }

    #[test]
    fn recovery_error_io_error_display() {
        let err = RecoveryError::IoError {
            message: "disk full".to_string(),
        };
        assert_eq!(format!("{err}"), "IO error: disk full");
    }

    #[test]
    fn recovery_error_parse_error_display() {
        let err = RecoveryError::ParseError {
            message: "invalid json".to_string(),
        };
        assert_eq!(format!("{err}"), "Parse error: invalid json");
    }

    #[test]
    fn recovery_error_serializes_with_tag() {
        let err = RecoveryError::FileNotFound;
        let json = serde_json::to_string(&err).expect("Failed to serialize");
        assert!(json.contains("\"kind\":\"FileNotFound\""));
    }

    // =========================================================================
    // DEFAULT_QUICK_PANE_SHORTCUT 常量
    // =========================================================================

    #[test]
    fn default_quick_pane_shortcut_is_valid() {
        assert!(!DEFAULT_QUICK_PANE_SHORTCUT.is_empty());
        assert!(DEFAULT_QUICK_PANE_SHORTCUT.contains("CommandOrControl"));
    }
}
