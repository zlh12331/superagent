//! 认证模块的工具函数。
//!
//! 当前仅包含错误响应消息解析，供 token 刷新、撤销等流程复用。

use tracing::debug;

/// 尝试从服务器错误响应中提取人类可读的错误消息。
///
/// 解析顺序：
/// 1. 若响应为 JSON 且包含 `error.message` 字段，则返回该字段值。
/// 2. 若响应为空字符串，返回 "Unknown error"。
/// 3. 否则返回原始响应文本。
pub(crate) fn try_parse_error_message(text: &str) -> String {
    debug!("Parsing server error response: {}", text);
    let json = serde_json::from_str::<serde_json::Value>(text).unwrap_or_default();
    if let Some(error) = json.get("error")
        && let Some(message) = error.get("message")
        && let Some(message_str) = message.as_str()
    {
        return message_str.to_string();
    }
    if text.is_empty() {
        return "Unknown error".to_string();
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::try_parse_error_message;

    #[test]
    fn try_parse_error_message_extracts_openai_error_message() {
        let text = r#"{
  "error": {
    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
    "type": "invalid_request_error",
    "param": null,
    "code": "refresh_token_reused"
  }
}"#;
        let message = try_parse_error_message(text);
        assert_eq!(
            message,
            "Your refresh token has already been used to generate a new access token. Please try signing in again."
        );
    }

    #[test]
    fn try_parse_error_message_falls_back_to_raw_text() {
        let text = r#"{"message": "test"}"#;
        let message = try_parse_error_message(text);
        assert_eq!(message, r#"{"message": "test"}"#);
    }
}
