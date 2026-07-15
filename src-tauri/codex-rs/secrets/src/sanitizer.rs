//! 密钥脱敏（redaction）模块。
//!
//! 提供基于正则表达式的 best-effort 密钥识别与替换能力，用于在日志、错误信息等
//! 文本中擦除常见的密钥格式（OpenAI key、AWS access key、Bearer token、键值对等）。

use regex::Regex;
use std::sync::LazyLock;

/// 匹配 OpenAI 风格密钥（`sk-` 开头，后跟至少 20 位字母数字）。
static OPENAI_KEY_REGEX: LazyLock<Regex> = LazyLock::new(|| compile_regex(r"sk-[A-Za-z0-9]{20,}"));
/// 匹配 AWS access key id（`AKIA` 开头，后跟 16 位大写字母数字）。
static AWS_ACCESS_KEY_ID_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"\bAKIA[0-9A-Z]{16}\b"));
/// 匹配 HTTP `Bearer` token（不区分大小写，后跟至少 16 位字符）。
static BEARER_TOKEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{16,}\b"));
/// 匹配形如 `api_key=xxx`、`token:xxx`、`password="xxx"` 的键值对赋值。
static SECRET_ASSIGNMENT_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    compile_regex(r#"(?i)\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}"#)
});

/// 尽最大努力从输入字符串中移除常见密钥与凭据。
///
/// 依据若干预定义正则匹配 OpenAI key、AWS access key、Bearer token 以及键值对赋值，
/// 命中部分会被替换为 `[REDACTED_SECRET]`。该方法为 best-effort，不保证能识别全部密钥。
///
/// - `input`：待脱敏的原始字符串。
///
/// 返回脱敏后的字符串。
pub fn redact_secrets(input: String) -> String {
    let redacted = OPENAI_KEY_REGEX.replace_all(&input, "[REDACTED_SECRET]");
    let redacted = AWS_ACCESS_KEY_ID_REGEX.replace_all(&redacted, "[REDACTED_SECRET]");
    // 保留 `Bearer ` 前缀，便于日志可读性。
    let redacted = BEARER_TOKEN_REGEX.replace_all(&redacted, "Bearer [REDACTED_SECRET]");
    // 保留键名与赋值符号，仅擦除值部分。
    let redacted = SECRET_ASSIGNMENT_REGEX.replace_all(&redacted, "$1$2$3[REDACTED_SECRET]");

    redacted.to_string()
}

/// 编译正则表达式，模式非法时 panic。
///
/// 所有模式均由 [`redact_secrets`] 使用前通过 `load_regex` 测试覆盖，因此 panic 是可接受的。
fn compile_regex(pattern: &str) -> Regex {
    match Regex::new(pattern) {
        Ok(regex) => regex,
        // panic 是可接受的，因为所有模式都由 `load_regex` 测试覆盖。
        Err(err) => panic!("invalid regex pattern `{pattern}`: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_regex() {
        // 该测试的唯一目的就是编译所有正则，防止运行时 panic。
        let _ = redact_secrets("secret".to_string());
    }
}
