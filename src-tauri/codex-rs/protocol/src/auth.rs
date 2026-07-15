//! 认证相关协议类型。
//!
//! 定义 OpenAI-backed provider 的认证模式、订阅计划类型，以及 refresh token
//! 失败相关的错误类型。这些类型在协议层用于传递认证状态与失败原因。

use serde::Deserialize;
use serde::Serialize;
use strum_macros::Display;
use thiserror::Error;

/// Authentication mode for OpenAI-backed providers.
///
/// OpenAI-backed provider 的认证模式。不同模式决定了凭证的来源、刷新方式以及
/// 是否走 Codex 后端服务。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Display, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// OpenAI API key provided by the caller and stored by Codex.
    ///
    /// 由调用方提供、Codex 存储的 OpenAI API Key。
    ApiKey,
    /// ChatGPT OAuth managed by Codex (tokens persisted and refreshed by Codex).
    ///
    /// 由 Codex 管理的 ChatGPT OAuth（token 由 Codex 持久化并刷新）。
    Chatgpt,
    /// ChatGPT auth tokens supplied by an external host application.
    ///
    /// 由外部宿主应用提供的 ChatGPT auth token。
    #[serde(rename = "chatgptAuthTokens")]
    #[strum(serialize = "chatgptAuthTokens")]
    ChatgptAuthTokens,
    /// Programmatic Codex auth backed by a registered Agent Identity.
    ///
    /// 基于已注册 Agent Identity 的编程式 Codex 认证。
    #[serde(rename = "agentIdentity")]
    #[strum(serialize = "agentIdentity")]
    AgentIdentity,
    /// Programmatic Codex auth backed by a personal access token.
    ///
    /// 基于个人 access token 的编程式 Codex 认证。
    #[serde(rename = "personalAccessToken")]
    #[strum(serialize = "personalAccessToken")]
    PersonalAccessToken,
    /// Amazon Bedrock bearer token managed by Codex.
    ///
    /// 由 Codex 管理的 Amazon Bedrock bearer token。
    #[serde(rename = "bedrockApiKey")]
    #[strum(serialize = "bedrockApiKey")]
    BedrockApiKey,
}

impl AuthMode {
    /// Returns whether this mode represents an authenticated human ChatGPT account.
    ///
    /// 是否表示一个已认证的人类 ChatGPT 账户。
    pub fn has_chatgpt_account(self) -> bool {
        match self {
            Self::Chatgpt | Self::ChatgptAuthTokens | Self::PersonalAccessToken => true,
            Self::ApiKey | Self::AgentIdentity | Self::BedrockApiKey => false,
        }
    }

    /// Returns whether this mode is backed by Codex services rather than a direct model API.
    ///
    /// 是否走 Codex 后端服务（而非直接调用模型 API）。
    pub fn uses_codex_backend(self) -> bool {
        match self {
            Self::Chatgpt
            | Self::ChatgptAuthTokens
            | Self::AgentIdentity
            | Self::PersonalAccessToken => true,
            Self::ApiKey | Self::BedrockApiKey => false,
        }
    }
}

/// 订阅计划类型。
///
/// `Known` 表示已识别的档位；`Unknown` 保留原始字符串以便未来扩展。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PlanType {
    /// 已识别的计划档位。
    Known(KnownPlan),
    /// 未识别的计划，保留原始字符串。
    Unknown(String),
}

impl PlanType {
    /// 从原始字符串解析 `PlanType`。
    ///
    /// 大小写不敏感；未识别的字符串归入 `Unknown`。
    pub fn from_raw_value(raw: &str) -> Self {
        match raw.to_ascii_lowercase().as_str() {
            "free" => Self::Known(KnownPlan::Free),
            "go" => Self::Known(KnownPlan::Go),
            "plus" => Self::Known(KnownPlan::Plus),
            "pro" => Self::Known(KnownPlan::Pro),
            "prolite" => Self::Known(KnownPlan::ProLite),
            "team" => Self::Known(KnownPlan::Team),
            "self_serve_business_usage_based" => {
                Self::Known(KnownPlan::SelfServeBusinessUsageBased)
            }
            "business" => Self::Known(KnownPlan::Business),
            "enterprise_cbp_usage_based" => Self::Known(KnownPlan::EnterpriseCbpUsageBased),
            "enterprise" | "hc" => Self::Known(KnownPlan::Enterprise),
            "education" | "edu" => Self::Known(KnownPlan::Edu),
            _ => Self::Unknown(raw.to_string()),
        }
    }
}

/// 已识别的订阅计划档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KnownPlan {
    Free,
    Go,
    Plus,
    Pro,
    ProLite,
    Team,
    #[serde(rename = "self_serve_business_usage_based")]
    SelfServeBusinessUsageBased,
    Business,
    #[serde(rename = "enterprise_cbp_usage_based")]
    EnterpriseCbpUsageBased,
    #[serde(alias = "hc")]
    Enterprise,
    #[serde(alias = "education")]
    Edu,
}

impl KnownPlan {
    /// 返回适合 UI 展示的名称。
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Free => "Free",
            Self::Go => "Go",
            Self::Plus => "Plus",
            Self::Pro => "Pro",
            Self::ProLite => "Pro Lite",
            Self::Team => "Team",
            Self::SelfServeBusinessUsageBased => "Self Serve Business Usage Based",
            Self::Business => "Business",
            Self::EnterpriseCbpUsageBased => "Enterprise CBP Usage Based",
            Self::Enterprise => "Enterprise",
            Self::Edu => "Edu",
        }
    }

    /// 返回在线协议上使用的原始字符串。
    pub fn raw_value(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Go => "go",
            Self::Plus => "plus",
            Self::Pro => "pro",
            Self::ProLite => "prolite",
            Self::Team => "team",
            Self::SelfServeBusinessUsageBased => "self_serve_business_usage_based",
            Self::Business => "business",
            Self::EnterpriseCbpUsageBased => "enterprise_cbp_usage_based",
            Self::Enterprise => "enterprise",
            Self::Edu => "edu",
        }
    }

    /// 是否属于工作区（workspace）类账户。
    pub fn is_workspace_account(self) -> bool {
        matches!(
            self,
            Self::Team
                | Self::SelfServeBusinessUsageBased
                | Self::Business
                | Self::EnterpriseCbpUsageBased
                | Self::Enterprise
                | Self::Edu
        )
    }
}

/// Refresh token 失败错误。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct RefreshTokenFailedError {
    /// 失败原因分类。
    pub reason: RefreshTokenFailedReason,
    /// 面向用户的描述信息。
    pub message: String,
}

impl RefreshTokenFailedError {
    /// 构造一个新的 `RefreshTokenFailedError`。
    pub fn new(reason: RefreshTokenFailedReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

/// Refresh token 失败原因分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshTokenFailedReason {
    /// Token 已过期。
    Expired,
    /// Token 使用额度耗尽。
    Exhausted,
    /// Token 已被撤销。
    Revoked,
    /// 其他未分类原因。
    Other,
}

#[cfg(test)]
mod tests {
    use super::KnownPlan;
    use super::PlanType;
    use pretty_assertions::assert_eq;

    #[test]
    fn plan_type_deserializes_raw_aliases() {
        assert_eq!(
            serde_json::from_str::<PlanType>("\"hc\"").expect("hc should deserialize"),
            PlanType::Known(KnownPlan::Enterprise)
        );
        assert_eq!(
            serde_json::from_str::<PlanType>("\"education\"")
                .expect("education should deserialize"),
            PlanType::Known(KnownPlan::Edu)
        );
    }
}
