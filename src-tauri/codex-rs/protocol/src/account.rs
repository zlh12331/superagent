//! 账户相关协议类型。
//!
//! 本模块定义了从模型 provider 返回的账户状态以及订阅计划（plan）相关的协议类型。
//! 这些类型在协议层用于传递用户的身份与订阅信息，是上层 UI 决定可用功能集的依据。

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::auth::KnownPlan;
use crate::auth::PlanType as AuthPlanType;

/// 订阅计划类型。
///
/// 反映用户在模型 provider（如 ChatGPT）上的订阅档位。`Unknown` 变体用于
/// 兜底处理未来新增的、当前未识别的档位，避免反序列化失败。
#[derive(Serialize, Deserialize, Copy, Clone, Debug, PartialEq, Eq, JsonSchema, TS, Default)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum PlanType {
    #[default]
    Free,
    Go,
    Plus,
    Pro,
    ProLite,
    Team,
    #[serde(rename = "self_serve_business_usage_based")]
    #[ts(rename = "self_serve_business_usage_based")]
    SelfServeBusinessUsageBased,
    Business,
    #[serde(rename = "enterprise_cbp_usage_based")]
    #[ts(rename = "enterprise_cbp_usage_based")]
    EnterpriseCbpUsageBased,
    Enterprise,
    Edu,
    #[serde(other)]
    Unknown,
}

/// Account state returned by a model provider before it is adapted to an app-facing wire type.
///
/// 模型 provider 在鉴权完成后返回的原始账户状态。在交付给 App 前端之前，会经由
/// 适配层转换为面向前端的 wire 类型。该枚举保留了 provider 侧原始语义，便于
/// 协议层做无歧义的账户类型分发。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderAccount {
    /// 使用 API Key 鉴权，无关联的订阅计划信息。
    ApiKey,
    /// 使用 ChatGPT 账号鉴权。
    Chatgpt {
        /// 登录邮箱，可能因隐私设置而缺失。
        email: Option<String>,
        /// 用户当前的订阅计划档位。
        plan_type: PlanType,
    },
    /// 使用 Amazon Bedrock 鉴权，附带凭证来源信息。
    AmazonBedrock {
        /// Bedrock 凭证的管理方：由 Codex 托管或由 AWS 托管。
        credential_source: AmazonBedrockCredentialSource,
    },
}

/// Amazon Bedrock 凭证来源。
///
/// 区分凭证由 Codex 内部托管还是由 AWS 直接托管，影响凭证刷新与撤销流程。
#[derive(Serialize, Deserialize, Copy, Clone, Debug, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum AmazonBedrockCredentialSource {
    /// 由 Codex 自身管理（例如 Codex 持有的 AWS 凭证）。
    CodexManaged,
    /// 由 AWS 托管（例如复用调用方的 IAM 凭证）。
    AwsManaged,
}

impl PlanType {
    /// 是否属于 Team 类计划（Team 或基于用量的自助 Team 档位）。
    pub fn is_team_like(self) -> bool {
        matches!(self, Self::Team | Self::SelfServeBusinessUsageBased)
    }

    /// 是否属于 Business 类计划（Business 或基于用量的企业档位）。
    pub fn is_business_like(self) -> bool {
        matches!(self, Self::Business | Self::EnterpriseCbpUsageBased)
    }

    /// 是否属于工作区（workspace）类账户。
    ///
    /// 工作区账户通常意味着团队 / 企业 / 教育等组织订阅，可用功能集与个人计划不同。
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

impl From<AuthPlanType> for PlanType {
    fn from(plan_type: AuthPlanType) -> Self {
        match plan_type {
            AuthPlanType::Known(plan) => plan.into(),
            AuthPlanType::Unknown(_) => Self::Unknown,
        }
    }
}

impl From<KnownPlan> for PlanType {
    fn from(plan: KnownPlan) -> Self {
        match plan {
            KnownPlan::Free => Self::Free,
            KnownPlan::Go => Self::Go,
            KnownPlan::Plus => Self::Plus,
            KnownPlan::Pro => Self::Pro,
            KnownPlan::ProLite => Self::ProLite,
            KnownPlan::Team => Self::Team,
            KnownPlan::SelfServeBusinessUsageBased => Self::SelfServeBusinessUsageBased,
            KnownPlan::Business => Self::Business,
            KnownPlan::EnterpriseCbpUsageBased => Self::EnterpriseCbpUsageBased,
            KnownPlan::Enterprise => Self::Enterprise,
            KnownPlan::Edu => Self::Edu,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PlanType;
    use crate::auth::KnownPlan;
    use crate::auth::PlanType as AuthPlanType;
    use pretty_assertions::assert_eq;

    #[test]
    fn usage_based_plan_types_use_expected_wire_names() {
        assert_eq!(
            serde_json::to_string(&PlanType::SelfServeBusinessUsageBased)
                .expect("self-serve business usage based should serialize"),
            "\"self_serve_business_usage_based\""
        );
        assert_eq!(
            serde_json::to_string(&PlanType::EnterpriseCbpUsageBased)
                .expect("enterprise cbp usage based should serialize"),
            "\"enterprise_cbp_usage_based\""
        );
        assert_eq!(
            serde_json::to_string(&PlanType::ProLite).expect("prolite should serialize"),
            "\"prolite\""
        );
        assert_eq!(
            serde_json::from_str::<PlanType>("\"self_serve_business_usage_based\"")
                .expect("self-serve business usage based should deserialize"),
            PlanType::SelfServeBusinessUsageBased
        );
        assert_eq!(
            serde_json::from_str::<PlanType>("\"prolite\"").expect("prolite should deserialize"),
            PlanType::ProLite
        );
        assert_eq!(
            serde_json::from_str::<PlanType>("\"enterprise_cbp_usage_based\"")
                .expect("enterprise cbp usage based should deserialize"),
            PlanType::EnterpriseCbpUsageBased
        );
    }

    #[test]
    fn plan_family_helpers_group_usage_based_variants_with_existing_plans() {
        assert_eq!(PlanType::Team.is_team_like(), true);
        assert_eq!(PlanType::SelfServeBusinessUsageBased.is_team_like(), true);
        assert_eq!(PlanType::Business.is_team_like(), false);

        assert_eq!(PlanType::Business.is_business_like(), true);
        assert_eq!(PlanType::EnterpriseCbpUsageBased.is_business_like(), true);
        assert_eq!(PlanType::Team.is_business_like(), false);
    }

    #[test]
    fn workspace_account_helper_includes_usage_based_workspace_plans() {
        assert_eq!(PlanType::Team.is_workspace_account(), true);
        assert_eq!(
            PlanType::SelfServeBusinessUsageBased.is_workspace_account(),
            true
        );
        assert_eq!(PlanType::Business.is_workspace_account(), true);
        assert_eq!(
            PlanType::EnterpriseCbpUsageBased.is_workspace_account(),
            true
        );
        assert_eq!(PlanType::Enterprise.is_workspace_account(), true);
        assert_eq!(PlanType::Edu.is_workspace_account(), true);
        assert_eq!(PlanType::Pro.is_workspace_account(), false);
    }

    #[test]
    fn auth_plan_type_converts_to_account_plan_type() {
        assert_eq!(
            PlanType::from(AuthPlanType::Known(KnownPlan::EnterpriseCbpUsageBased)),
            PlanType::EnterpriseCbpUsageBased
        );
        assert_eq!(
            PlanType::from(AuthPlanType::Known(KnownPlan::Enterprise)),
            PlanType::Enterprise
        );
        assert_eq!(
            PlanType::from(AuthPlanType::Unknown("mystery-tier".to_string())),
            PlanType::Unknown
        );
    }
}
