use codex_app_server_protocol::AuthMode as ApiAuthMode;
use codex_protocol::auth::AuthMode;

/// 将 `codex-protocol` 拥有的领域认证模式转换为 `codex-app-server-protocol` 拥有的 app-server 线协议类型。
///
/// 两类类型保持独立，避免 app-server 协议的所有权泄漏到领域 crate 中。
/// 由于本 crate 不拥有任何一方类型，受 Rust orphan rules 限制，必须使用显式转换函数
/// 而不能实现 `From` trait。
///
/// # 参数
///
/// - `auth_mode`: 领域层认证模式（`codex_protocol::auth::AuthMode`）
///
/// # 返回值
///
/// 返回对应的 app-server 协议认证模式（`ApiAuthMode`），枚举值一一对应：
/// - `ApiKey` → `ApiKey`
/// - `Chatgpt` → `Chatgpt`
/// - `ChatgptAuthTokens` → `ChatgptAuthTokens`
/// - `AgentIdentity` → `AgentIdentity`
/// - `PersonalAccessToken` → `PersonalAccessToken`
/// - `BedrockApiKey` → `BedrockApiKey`
pub(crate) fn auth_mode_to_api(auth_mode: AuthMode) -> ApiAuthMode {
    match auth_mode {
        AuthMode::ApiKey => ApiAuthMode::ApiKey,
        AuthMode::Chatgpt => ApiAuthMode::Chatgpt,
        AuthMode::ChatgptAuthTokens => ApiAuthMode::ChatgptAuthTokens,
        AuthMode::AgentIdentity => ApiAuthMode::AgentIdentity,
        AuthMode::PersonalAccessToken => ApiAuthMode::PersonalAccessToken,
        AuthMode::BedrockApiKey => ApiAuthMode::BedrockApiKey,
    }
}
