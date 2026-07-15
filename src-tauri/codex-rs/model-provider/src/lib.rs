//! 模型 provider 抽象与认证模块。
//!
//! 该 crate 统一封装了不同模型 provider（如 ChatGPT、Amazon Bedrock）的
//! 认证、账户状态与 provider 实例创建逻辑。核心能力包括：
//! - 基于 agent identity 的认证回退（session fallback）；
//! - Bearer token 认证 provider；
//! - provider 账户状态管理与能力描述；
//! - provider 实例的创建与共享。
//!
//! 核心类型：[`ModelProvider`]、[`ProviderAccountState`]、[`BearerAuthProvider`]、
//! [`ResolvedProviderAuth`]。

mod amazon_bedrock;
mod auth;
mod bearer_auth_provider;
mod models_endpoint;
mod provider;

/// agent identity 会话回退策略：当 agent identity 不可用时，
/// 回退到当前会话的认证方式。
pub use auth::AgentIdentitySessionFallback;
/// provider 认证作用域，界定认证凭据的适用范围。
pub use auth::ProviderAuthScope;
/// 已解析的 provider 认证信息，包含具体的认证凭据与作用域。
pub use auth::ResolvedProviderAuth;
/// 根据认证模式构造对应的认证 provider。
pub use auth::auth_provider_from_auth;
/// 构造一个始终未认证的 provider，用于无需鉴权的场景。
pub use auth::unauthenticated_auth_provider;
/// 基于 Bearer token 的认证 provider 实现。
pub use bearer_auth_provider::BearerAuthProvider;
/// `BearerAuthProvider` 的别名，供核心层（core）以 `CoreAuthProvider` 名称引用。
pub use bearer_auth_provider::BearerAuthProvider as CoreAuthProvider;
/// ChatGPT Codex API 的默认 base URL 常量。
pub use codex_model_provider_info::CHATGPT_CODEX_BASE_URL;
/// provider 账户信息（如订阅类型、组织等）。
pub use codex_protocol::account::ProviderAccount;
/// 模型 provider 抽象，封装了与模型服务交互所需的认证、配置与能力。
pub use provider::ModelProvider;
/// 构造 `ModelProvider` 所返回的 future 类型别名。
pub use provider::ModelProviderFuture;
/// provider 账户相关错误类型。
pub use provider::ProviderAccountError;
/// provider 账户操作结果类型别名。
pub use provider::ProviderAccountResult;
/// provider 账户状态，描述账户当前的可用性与限制。
pub use provider::ProviderAccountState;
/// provider 能力描述，声明该 provider 支持的功能（如流式响应、工具调用等）。
pub use provider::ProviderCapabilities;
/// 可跨任务共享的 `ModelProvider`（`Arc` 包装）。
pub use provider::SharedModelProvider;
/// 根据配置创建 `ModelProvider` 实例的工厂函数。
pub use provider::create_model_provider;
