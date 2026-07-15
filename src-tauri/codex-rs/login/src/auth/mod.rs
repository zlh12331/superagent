//! 认证模块：统一管理 Codex 支持的多种认证方式。
//!
//! 模块结构：
//! - [`manager`]：核心认证管理器 [`AuthManager`] 与统一认证抽象 [`CodexAuth`]。
//! - [`storage`]：`auth.json` 的读写与多种存储后端（文件 / keyring / 临时内存）。
//! - [`default_client`]：构建默认 HTTP 客户端、User-Agent、originator 等。
//! - [`agent_identity`]：Agent Identity 认证的注册、引导与 JWKS 校验。
//! - [`personal_access_token`]：Personal Access Token (PAT) 认证。
//! - [`bedrock_api_key`]：Amazon Bedrock API Key 认证。
//! - [`external_bearer`]：外部 bearer token 刷新器（用于自定义 provider）。
//! - [`revoke`]：登出时的 OAuth token 撤销。
//! - [`access_token`]：根据前缀分类 access token。
//! - [`util`]：错误消息解析等工具函数。

mod access_token;
mod agent_identity;
mod bedrock_api_key;
pub mod default_client;
pub mod error;
mod personal_access_token;
mod storage;
mod util;

mod external_bearer;
mod manager;
mod revoke;

pub use bedrock_api_key::BedrockApiKeyAuth;
pub use bedrock_api_key::login_with_bedrock_api_key;
pub use error::RefreshTokenFailedError;
pub use error::RefreshTokenFailedReason;
pub use manager::*;
