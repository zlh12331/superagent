//! Codex 后端 HTTP 客户端。
//!
//! 提供 [`Client`] 用于与 codex-backend 交互，包括：
//! - 获取速率限制（rate limits）与重置额度（reset credits）
//! - 查询账户信息与 token 使用情况
//! - 管理云端任务（Cloud Tasks）的创建与查询
//! - 拉取云端托管配置（config bundle）
//! - 发送添加额度提醒邮件

mod client;
pub(crate) mod types;

pub use client::AddCreditsNudgeCreditType;
pub use client::Client;
pub use client::RequestError;
pub use types::AccountEntry;
pub use types::AccountsCheckResponse;
pub use types::CodeTaskDetailsResponse;
pub use types::CodeTaskDetailsResponseExt;
pub use types::CodexWorkspaceMessage;
pub use types::CodexWorkspaceMessageType;
pub use types::CodexWorkspaceMessagesResponse;
pub use types::ConfigBundleResponse;
pub use types::ConsumeRateLimitResetCreditCode;
pub use types::ConsumeRateLimitResetCreditResponse;
pub use types::DeliveredConfigToml;
pub use types::DeliveredRequirementsToml;
pub use types::DeliveredTomlFragment;
pub use types::PaginatedListTaskListItem;
pub use types::RateLimitResetCreditsSummary;
pub use types::RateLimitsWithResetCredits;
pub use types::TaskListItem;
pub use types::TokenUsageProfile;
pub use types::TokenUsageProfileDailyBucket;
pub use types::TokenUsageProfileStats;
pub use types::TurnAttemptsSiblingTurnsResponse;
