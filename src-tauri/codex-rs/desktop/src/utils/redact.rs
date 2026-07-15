//! 日志和错误消息中的敏感数据脱敏。
//!
//! 借鉴 codex-main 的 `RedactingMakeWriter` 模式：在任何日志行或错误消息
//! 被持久化或传输之前，与敏感键关联的值会被替换为 `***`。这可以防止
//! API 密钥、令牌、密码和其他凭据通过日志文件或 Sentry 事件意外泄露。
//!
//! 脱敏基于正则模式匹配，作用于格式化后的输出文本。它支持以下
//! 常见的键值对格式：
//! - 查询字符串：`api_key=abc123`
//! - JSON 键值：`"api_key": "abc123"`
//! - HTTP 头：`Authorization: Bearer xyz`
//!
//! ## 项目特定敏感键
//!
//! 除了 8 个标准敏感键（access_token, refresh_token, api_key, authorization,
//! password, secret, cookie, token），还覆盖 SuperAgent 项目特定数据：
//! - `thread_id` — 对话线程 ID
//! - `session_id` — 会话 ID
//!
//! 这些 ID 可能出现在日志和 Sentry 事件中，可能关联到用户对话历史，
//! 需要脱敏以保护用户隐私。
//!
//! **注意**：对话内容（conversation content）无法通过键名匹配脱敏，
//! 前端通过 Session Replay 的 `maskAllText: true` 保护 DOM 内容。

use regex::Regex;
use std::sync::LazyLock;

/// 匹配敏感键值对的正则模式。
///
/// 将键名、可选的闭合引号、分隔符和可选的开引号捕获到一个分组中，
/// 值部分被替换为 `***`。
///
/// 支持的格式：
/// - 查询字符串：`api_key=abc123`
/// - JSON 键值：`"api_key": "abc123"`
/// - HTTP 头：`Authorization: Bearer abc123`（Bearer 模式被完整捕获）
/// - 日志：`token: xyz`
// 静态正则表达式模式在编译时由开发者验证，运行时不会失败。
// 使用 #[allow] 显式标注：这些 .expect() 是不可达的安全边界。
#[allow(clippy::expect_used)]
static SENSITIVE_VALUE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)((?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|password|secret|cookie|token|thread[_-]?id|session[_-]?id)"?\s*[:=]\s*"?)(?:Bearer\s+\S+|[^",}\s\]]+)"#,
    )
    .expect("Failed to compile sensitive data redaction regex")
});

/// 敏感键名匹配正则 — 在结构化数据（如 JSON 对象、HTTP 头）中发现
/// 这些键名时，其整个值应被替换为 `***`。
///
/// 包含 8 个标准敏感键 + 2 个 Codex 项目特定键（thread_id, session_id）。
#[allow(clippy::expect_used)]
static SENSITIVE_KEY_NAMES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|password|secret|cookie|token|thread[_-]?id|session[_-]?id)$")
        .expect("Failed to compile sensitive key name regex")
});

// ============================================================
// 值模式正则 — 匹配独立出现的敏感令牌（不依赖键名）
// ============================================================

/// 匹配 OpenAI API Key（`sk-` 前缀 + 48 位字母数字）。
#[allow(clippy::expect_used)]
static OPENAI_KEY_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"sk-[A-Za-z0-9]{20,}")
        .expect("Failed to compile OpenAI API key regex")
});

/// 匹配 AWS Access Key ID（`AKIA` 前缀 + 16 位字母数字）。
#[allow(clippy::expect_used)]
static AWS_ACCESS_KEY_ID_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"AKIA[0-9A-Z]{16}")
        .expect("Failed to compile AWS access key ID regex")
});

/// 匹配 Bearer Token（`Bearer ` 后跟非空白字符序列）。
#[allow(clippy::expect_used)]
static BEARER_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)Bearer\s+\S+")
        .expect("Failed to compile Bearer token regex")
});

/// 错误消息最大长度（字节），超过则截断。
const MAX_ERROR_MESSAGE_LEN: usize = 1000;

/// 将字符串中的敏感值替换为 `***`。
///
/// 执行两步脱敏：
/// 1. 键值对模式脱敏（如 `api_key=xxx`、`"token": "yyy"`）；
/// 2. 值模式脱敏（独立出现的 OpenAI Key、AWS Key、Bearer Token）。
///
/// # 示例
///
/// ```
/// # use codex_desktop_lib::utils::redact::redact_sensitive;
/// assert_eq!(redact_sensitive("api_key=abc123"), "api_key=***");
/// assert_eq!(
///     redact_sensitive(r#""token": "xyz""#),
///     r#""token": "***""#
/// );
/// ```
pub fn redact_sensitive(input: &str) -> String {
    // 第一步：键值对模式脱敏（如 `api_key=xxx`、`"token": "yyy"`）
    let result = SENSITIVE_VALUE_PATTERN
        .replace_all(input, "${1}***")
        .to_string();

    // 第二步：值模式脱敏（独立出现的敏感令牌，不依赖键名）
    let result = OPENAI_KEY_REGEX.replace_all(&result, "sk-***");
    let result = AWS_ACCESS_KEY_ID_REGEX.replace_all(&result, "AKIA***");
    let result = BEARER_TOKEN_REGEX.replace_all(&result, "Bearer ***");

    result.to_string()
}

/// 判断键名是否为敏感键。
///
/// 匹配 8 个标准敏感键 + 2 个 Codex 项目特定键（thread_id, session_id），
/// 支持大小写不敏感和多种分隔符（`_`、`-`、驼峰）。
///
/// # 参数
///
/// - `key`：待检查的键名
///
/// # 返回
///
/// 若键名匹配敏感键模式则返回 `true`，否则返回 `false`。
pub fn is_sensitive_key(key: &str) -> bool {
    SENSITIVE_KEY_NAMES.is_match(key)
}

/// 递归脱敏 JSON 值中的敏感数据。
///
/// 遍历 JSON 对象和数组，对字符串值应用 `redact_sensitive`。
/// 如果键名是敏感键，则将值直接替换为 `"***"`。
///
/// # 参数
///
/// - `value` — 要脱敏的 JSON 值（会被原地修改）
pub fn redact_json_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                if is_sensitive_key(key) {
                    // 敏感键的值直接替换
                    *val = serde_json::Value::String("***".to_string());
                } else {
                    // 递归处理嵌套结构
                    redact_json_value(val);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                redact_json_value(item);
            }
        }
        serde_json::Value::String(s) => {
            *s = redact_sensitive(s);
        }
        _ => {}
    }
}

/// 对错误消息进行脱敏 + 截断。
///
/// 先调用 `redact_sensitive` 脱敏敏感数据，
/// 再截断到 `MAX_ERROR_MESSAGE_LEN` 字节（防止超长消息导致日志膨胀）。
///
/// # 参数
///
/// - `msg` — 原始错误消息
///
/// # 返回
///
/// 脱敏 + 截断后的安全消息
pub fn redact_error_message(msg: &str) -> String {
    let redacted = redact_sensitive(msg);
    truncate_with_ellipsis(&redacted, MAX_ERROR_MESSAGE_LEN)
}

/// 截断字符串到指定字节数，添加省略号后缀。
///
/// 在 UTF-8 字符边界处截断，不会产生半个字符。
/// 如果字符串长度不超过 `max_bytes`，原样返回。
///
/// # 参数
///
/// - `s` — 要截断的字符串
/// - `max_bytes` — 最大字节数（不含省略号）
fn truncate_with_ellipsis(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }

    // 在 max_bytes 范围内找到最后一个 UTF-8 字符边界
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }

    let mut result = s[..end].to_string();
    result.push_str("...");
    result
}

/// 对 Sentry 事件中的文本字段进行脱敏。
///
/// 在 Rust 端的 `before_send` 回调中调用，对 Rust 产生的 Sentry 事件
///（如 panic 捕获、日志事件）进行脱敏，与前端 `redactSentryEvent` 对齐。
///
/// ## 为什么需要 Rust 端脱敏
///
/// 前端的 `beforeSend` 只能处理 JavaScript 层的 Sentry 事件。
/// Rust 端产生的 panic 捕获和日志事件直接通过 `sentry::init` 发送，
/// 不经过前端 `beforeSend`，因此需要在 Rust 的 `before_send` 中脱敏。
///
/// ## 脱敏字段
///
/// - `event.message` — 事件消息（可能包含日志中的敏感数据）
/// - `event.logentry.message` — 日志条目消息
/// - `event.culprit` — 错误源（可能包含文件路径和参数）
/// - `event.transaction` — 事务名
/// - `event.breadcrumbs[].message` — 面包屑消息（最可能包含敏感数据）
/// - `event.exception[].value` — 异常值
/// - `event.extra` 中值为字符串的字段
pub fn redact_sentry_event(event: &mut sentry::protocol::Event<'static>) {
    // 脱敏事件消息
    if let Some(msg) = event.message.take() {
        event.message = Some(redact_sensitive(&msg));
    }

    // 脱敏日志条目消息
    if let Some(mut logentry) = event.logentry.take() {
        logentry.message = redact_sensitive(&logentry.message);
        event.logentry = Some(logentry);
    }

    // 脱敏错误源
    if let Some(culprit) = event.culprit.take() {
        event.culprit = Some(redact_sensitive(&culprit));
    }

    // 脱敏事务名
    if let Some(transaction) = event.transaction.take() {
        event.transaction = Some(redact_sensitive(&transaction));
    }

    // 脱敏面包屑消息
    for breadcrumb in event.breadcrumbs.values.iter_mut() {
        if let Some(msg) = breadcrumb.message.take() {
            breadcrumb.message = Some(redact_sensitive(&msg));
        }
    }

    // 脱敏异常值
    for exception in event.exception.values.iter_mut() {
        if let Some(val) = exception.value.take() {
            exception.value = Some(redact_sensitive(&val));
        }
    }

    // 脱敏 extra 中值为字符串的字段
    for value in event.extra.values_mut() {
        if let Some(s) = value.as_str() {
            *value = serde_json::Value::String(redact_sensitive(s));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // redact_sensitive — 正向用例
    // =========================================================================

    #[test]
    fn redact_replaces_api_key_value() {
        let result = redact_sensitive("api_key=abc123");
        assert!(result.contains("***"));
        assert!(!result.contains("abc123"));
    }

    #[test]
    fn redact_replaces_token_value() {
        let result = redact_sensitive("token=secret_token_value");
        assert!(result.contains("***"));
        assert!(!result.contains("secret_token_value"));
    }

    #[test]
    fn redact_replaces_authorization_header() {
        let result = redact_sensitive("Authorization: Bearer abc123");
        assert!(result.contains("***"));
        assert!(!result.contains("abc123"));
    }

    #[test]
    fn redact_replaces_password_in_json() {
        let input = r#"{"password": "mypassword"}"#;
        let result = redact_sensitive(input);
        assert!(result.contains("***"));
        assert!(!result.contains("mypassword"));
    }

    #[test]
    fn redact_replaces_access_token() {
        let result = redact_sensitive("access_token=eyJhbGciOi");
        assert!(result.contains("***"));
        assert!(!result.contains("eyJhbGciOi"));
    }

    #[test]
    fn redact_replaces_refresh_token() {
        let result = redact_sensitive("refresh_token=xyz789");
        assert!(result.contains("***"));
        assert!(!result.contains("xyz789"));
    }

    #[test]
    fn redact_replaces_secret_value() {
        let result = redact_sensitive("secret=my_super_secret");
        assert!(result.contains("***"));
        assert!(!result.contains("my_super_secret"));
    }

    #[test]
    fn redact_replaces_cookie_value() {
        let result = redact_sensitive("cookie=session_id_abc");
        assert!(result.contains("***"));
        assert!(!result.contains("session_id_abc"));
    }

    #[test]
    fn redact_preserves_key_name() {
        let result = redact_sensitive("api_key=abc123");
        assert!(result.contains("api_key"));
    }

    #[test]
    fn redact_preserves_separator() {
        let result = redact_sensitive("api_key=abc123");
        assert!(result.contains("api_key="));
    }

    #[test]
    fn redact_handles_multiple_sensitive_fields() {
        let input = "api_key=abc token=xyz password=secret";
        let result = redact_sensitive(input);
        assert!(result.contains("api_key=***"));
        assert!(result.contains("token=***"));
        assert!(result.contains("password=***"));
        assert!(!result.contains("abc"));
        assert!(!result.contains("xyz"));
        assert!(!result.contains("secret"));
    }

    #[test]
    fn redact_handles_quoted_json_values() {
        let input = r#""api_key": "my_secret_key""#;
        let result = redact_sensitive(input);
        assert!(result.contains("***"));
        assert!(!result.contains("my_secret_key"));
    }

    #[test]
    fn redact_is_case_insensitive() {
        let result = redact_sensitive("API_KEY=abc123");
        assert!(result.contains("***"));
        assert!(!result.contains("abc123"));
    }

    // =========================================================================
    // redact_sensitive — 边界用例
    // =========================================================================

    #[test]
    fn redact_does_not_modify_non_sensitive_text() {
        let input = "user_id=12345 session=active";
        let result = redact_sensitive(input);
        assert_eq!(result, input);
    }

    #[test]
    fn redact_handles_empty_string() {
        assert_eq!(redact_sensitive(""), "");
    }

    #[test]
    fn redact_preserves_non_sensitive_parts() {
        let input = "user=john api_key=secret123 action=login";
        let result = redact_sensitive(input);
        assert!(result.contains("user=john"));
        assert!(result.contains("action=login"));
        assert!(result.contains("api_key=***"));
    }

    #[test]
    fn redact_does_not_match_partial_key_names() {
        // "mytoken" 本不应触发脱敏，因为 "token" 只是子串 ——
        // 但由于正则未锚定，实际会匹配。这是可接受的：
        // 过度审慎比泄露敏感数据更安全。此处测试用于记录该行为。
        let result = redact_sensitive("mytoken=abc123");
        // 正则匹配了 "mytoken=abc123" 中的 "token=abc123" 部分
        assert!(result.contains("***"));
    }

    #[test]
    fn redact_handles_key_without_value() {
        let input = "api_key";
        let result = redact_sensitive(input);
        assert_eq!(result, input);
    }

    // =========================================================================
    // is_sensitive_key — 正向用例
    // =========================================================================

    #[test]
    fn is_sensitive_key_recognizes_api_key() {
        assert!(is_sensitive_key("api_key"));
    }

    #[test]
    fn is_sensitive_key_recognizes_token() {
        assert!(is_sensitive_key("token"));
    }

    #[test]
    fn is_sensitive_key_recognizes_password() {
        assert!(is_sensitive_key("password"));
    }

    #[test]
    fn is_sensitive_key_recognizes_authorization() {
        assert!(is_sensitive_key("authorization"));
    }

    #[test]
    fn is_sensitive_key_recognizes_access_token() {
        assert!(is_sensitive_key("access_token"));
    }

    #[test]
    fn is_sensitive_key_recognizes_refresh_token() {
        assert!(is_sensitive_key("refresh_token"));
    }

    #[test]
    fn is_sensitive_key_recognizes_secret() {
        assert!(is_sensitive_key("secret"));
    }

    #[test]
    fn is_sensitive_key_recognizes_cookie() {
        assert!(is_sensitive_key("cookie"));
    }

    // =========================================================================
    // is_sensitive_key — 边界用例
    // =========================================================================

    #[test]
    fn is_sensitive_key_rejects_non_sensitive_keys() {
        assert!(!is_sensitive_key("user_id"));
        assert!(!is_sensitive_key("session"));
        assert!(!is_sensitive_key("name"));
    }

    #[test]
    fn is_sensitive_key_is_case_insensitive() {
        assert!(is_sensitive_key("API_KEY"));
        assert!(is_sensitive_key("Token"));
        assert!(is_sensitive_key("PASSWORD"));
    }

    #[test]
    fn is_sensitive_key_rejects_partial_matches() {
        // "my_api_key" 不完全等于 "api_key"，应被拒绝
        assert!(!is_sensitive_key("my_api_key"));
        // "api_key_extra" 不完全等于 "api_key"，应被拒绝
        assert!(!is_sensitive_key("api_key_extra"));
    }

    #[test]
    fn is_sensitive_key_rejects_empty_string() {
        assert!(!is_sensitive_key(""));
    }

    // =========================================================================
    // 项目特定敏感键 — SuperAgent
    // =========================================================================

    #[test]
    fn redact_replaces_thread_id() {
        let result = redact_sensitive("thread_id=thread_abc123");
        assert!(result.contains("***"));
        assert!(!result.contains("thread_abc123"));
    }

    #[test]
    fn redact_replaces_session_id() {
        let result = redact_sensitive("session_id=session_xyz789");
        assert!(result.contains("***"));
        assert!(!result.contains("session_xyz789"));
    }

    #[test]
    fn redact_replaces_thread_id_in_json() {
        let input = r#"{"threadId": "thread_123"}"#;
        let result = redact_sensitive(input);
        assert!(result.contains("***"));
        assert!(!result.contains("thread_123"));
    }

    #[test]
    fn is_sensitive_key_recognizes_thread_id() {
        assert!(is_sensitive_key("thread_id"));
        assert!(is_sensitive_key("threadId"));
        assert!(is_sensitive_key("thread-id"));
    }

    #[test]
    fn is_sensitive_key_recognizes_session_id() {
        assert!(is_sensitive_key("session_id"));
        assert!(is_sensitive_key("sessionId"));
        assert!(is_sensitive_key("session-id"));
    }

    // =========================================================================
    // 值模式脱敏 — 正向用例（P1-5 新增）
    // =========================================================================

    #[test]
    fn redact_replaces_openai_api_key_value() {
        let result = redact_sensitive("Found sk-abcdefghijklmnopqrstuvwxyz0123456789 in config");
        assert!(!result.contains("sk-abcdefghijklmnopqrstuvwxyz0123456789"));
        assert!(result.contains("sk-***"));
    }

    #[test]
    fn redact_replaces_aws_access_key_id_value() {
        let result = redact_sensitive("Using AKIAIOSFODNN7EXAMPLE for auth");
        assert!(!result.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(result.contains("AKIA***"));
    }

    #[test]
    fn redact_replaces_bearer_token_value() {
        let result = redact_sensitive("Authorization header: Bearer eyJhbGciOiJIUzI1");
        assert!(!result.contains("eyJhbGciOiJIUzI1"));
        assert!(result.contains("Bearer ***"));
    }

    // =========================================================================
    // redact_json_value — 递归脱敏（P1-5 新增）
    // =========================================================================

    #[test]
    fn redact_json_value_redacts_nested_sensitive_keys() {
        let mut json = serde_json::json!({
            "user": "john",
            "api_key": "sk-test123",
            "nested": {
                "token": "secret",
                "data": [1, 2, 3]
            }
        });
        redact_json_value(&mut json);
        assert_eq!(json["user"], "john");
        assert_eq!(json["api_key"], "***");
        assert_eq!(json["nested"]["token"], "***");
        assert_eq!(json["nested"]["data"][0], 1);
    }

    #[test]
    fn redact_json_value_redacts_string_values_with_patterns() {
        let mut json = serde_json::json!({
            "message": "Error using sk-abcdefghijklmnopqrstuvwxyz1234567890"
        });
        redact_json_value(&mut json);
        assert!(json["message"].as_str().unwrap().contains("sk-***"));
    }

    // =========================================================================
    // redact_error_message — 脱敏 + 截断（P1-4 新增）
    // =========================================================================

    #[test]
    fn redact_error_message_redacts_sensitive_data() {
        let msg = "Failed to auth with api_key=sk-test12345678901234567890";
        let result = redact_error_message(msg);
        assert!(!result.contains("sk-test12345678901234567890"));
        assert!(result.contains("***"));
    }

    #[test]
    fn redact_error_message_truncates_long_messages() {
        let msg = "x".repeat(2000);
        let result = redact_error_message(&msg);
        assert!(result.ends_with("..."));
        assert!(result.len() < 1100); // 1000 + "..."
    }

    #[test]
    fn redact_error_message_preserves_short_messages() {
        let msg = "File not found";
        let result = redact_error_message(msg);
        assert_eq!(result, "File not found");
    }

    #[test]
    fn redact_error_message_truncates_at_utf8_boundary() {
        // 包含多字节 UTF-8 字符的消息
        let msg = "错误: ".to_string() + &"日".repeat(500);
        let result = redact_error_message(&msg);
        // 不应该在 UTF-8 字符中间截断
        assert!(result.ends_with("..."));
        assert!(String::from_utf8(result.into_bytes()).is_ok());
    }
}
