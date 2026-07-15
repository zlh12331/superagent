//! 根据 access token 前缀进行分类。
//!
//! Codex 支持两种通过 access token 字符串登录的方式：
//! - 以 `at-` 为前缀的 Personal Access Token (PAT)。
//! - 不带前缀的 Agent Identity JWT。

/// Personal Access Token 的字符串前缀。
const PERSONAL_ACCESS_TOKEN_PREFIX: &str = "at-";

/// 分类后的 access token。
///
/// 通过 [`classify_codex_access_token`] 生成，决定后续走 PAT 还是 JWT 登录路径。
pub(super) enum CodexAccessToken<'a> {
    /// Personal Access Token（以 `at-` 为前缀）。
    PersonalAccessToken(&'a str),
    /// Agent Identity JWT（无前缀）。
    AgentIdentityJwt(&'a str),
}

/// 根据 access token 字符串前缀判断其类型。
///
/// - 以 `at-` 开头：视为 Personal Access Token。
/// - 其他情况：视为 Agent Identity JWT。
pub(super) fn classify_codex_access_token(access_token: &str) -> CodexAccessToken<'_> {
    if access_token.starts_with(PERSONAL_ACCESS_TOKEN_PREFIX) {
        CodexAccessToken::PersonalAccessToken(access_token)
    } else {
        CodexAccessToken::AgentIdentityJwt(access_token)
    }
}

#[cfg(test)]
#[path = "access_token_tests.rs"]
mod tests;
