//! Guardian 审查模块。
//!
//! Guardian review 决定一个 `on-request` 审批是否应自动通过,而非展示给用户。
//!
//! # 总体方案
//! 1. 重构一份紧凑的 transcript,保留用户意图与最相关的近期 assistant / tool 上下文;
//! 2. 通过独立的 guardian review session 评估具体计划动作,并要求返回严格 JSON;
//!    guardian 会克隆父配置,因此继承父 turn 已有的 managed network proxy / allowlist;
//! 3. 在超时、执行失败或输出格式错误时一律 fail closed(拒绝);
//! 4. 根据 guardian 显式返回的 allow / deny 结果执行后续动作。

mod approval_request;
mod metrics;
mod prompt;
mod review;
mod review_session;

use std::time::Duration;

use codex_protocol::protocol::GuardianAssessmentDecisionSource;
use codex_protocol::protocol::GuardianAssessmentOutcome;
use serde::Deserialize;
use serde::Serialize;

pub(crate) use approval_request::GuardianApprovalRequest;
pub(crate) use approval_request::GuardianMcpAnnotations;
pub(crate) use approval_request::GuardianNetworkAccessTrigger;
#[cfg(test)]
pub(crate) use approval_request::guardian_approval_request_to_json;
pub(crate) use review::guardian_rejection_message;
pub(crate) use review::guardian_timeout_message;
pub(crate) use review::is_guardian_reviewer_source;
pub(crate) use review::new_guardian_review_id;
#[cfg(test)]
pub(crate) use review::record_guardian_denial_for_test;
pub(crate) use review::review_approval_request;
#[cfg(test)]
pub(crate) use review::review_approval_request_with_cancel;
pub(crate) use review::routes_approval_to_guardian;
pub(crate) use review::routes_approval_to_guardian_with_reviewer;
pub(crate) use review::spawn_approval_request_review;
pub(crate) use review_session::GuardianReviewSessionManager;
pub(crate) use review_session::prompt_cache_key_override_for_review_session;

/// guardian review 的超时时间。
pub(crate) const GUARDIAN_REVIEW_TIMEOUT: Duration = Duration::from_secs(90);
/// guardian reviewer 的标识名称。
pub(crate) const GUARDIAN_REVIEWER_NAME: &str = "guardian";
/// 单个 turn 内允许的连续 guardian 拒绝次数上限,超出则中断 turn。
pub(crate) const MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN: u32 = 3;
/// 单个 turn 内滑动窗口中允许的自动 review 拒绝次数上限。
pub(crate) const MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN: u32 = 10;
/// 滑动窗口大小:保留最近多少次自动 review 结果。
pub(crate) const AUTO_REVIEW_DENIAL_WINDOW_SIZE: usize = 50;
/// 当用户手动批准了一个之前被 guardian 拒绝的动作时,附加在消息前缀的提示语。
pub(crate) const AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX: &str =
    "The user has manually approved a specific action that was previously `Rejected`.";
// 以下常量限制 guardian transcript 各部分的 token 数,防止 prompt 过长。
const GUARDIAN_MAX_MESSAGE_TRANSCRIPT_TOKENS: usize = 10_000;
const GUARDIAN_MAX_TOOL_TRANSCRIPT_TOKENS: usize = 10_000;
const GUARDIAN_MAX_MESSAGE_ENTRY_TOKENS: usize = 2_000;
const GUARDIAN_MAX_TOOL_ENTRY_TOKENS: usize = 1_000;
const GUARDIAN_MAX_ACTION_STRING_TOKENS: usize = 16_000;
const GUARDIAN_RECENT_ENTRY_LIMIT: usize = 40;
/// 在 transcript 中标记某条目已被截断的标签。
const TRUNCATION_TAG: &str = "truncated";

/// guardian reviewer 必须满足的结构化输出契约。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct GuardianAssessment {
    pub(crate) risk_level: codex_protocol::protocol::GuardianRiskLevel,
    pub(crate) user_authorization: codex_protocol::protocol::GuardianUserAuthorization,
    pub(crate) outcome: GuardianAssessmentOutcome,
    pub(crate) rationale: String,
}

/// guardian 拒绝结果,包含拒绝理由与决策来源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GuardianRejection {
    pub(crate) rationale: String,
    pub(crate) source: GuardianAssessmentDecisionSource,
}

/// guardian 拒绝熔断器,按 turn 维度统计连续拒绝与滑动窗口拒绝次数,
/// 在达到阈值时中断当前 turn 以避免无限循环。
#[derive(Debug, Default)]
pub(crate) struct GuardianRejectionCircuitBreaker {
    turns: std::collections::HashMap<String, GuardianRejectionCircuitBreakerTurn>,
}

/// 单个 turn 的熔断器统计状态。
#[derive(Debug, Default)]
struct GuardianRejectionCircuitBreakerTurn {
    /// 连续拒绝次数(出现非拒绝时清零)。
    consecutive_denials: u32,
    /// 滑动窗口内的最近 review 是否拒绝(true 表示拒绝)。
    recent_denials: std::collections::VecDeque<bool>,
    /// 该 turn 是否已触发过中断,避免重复触发。
    interrupt_triggered: bool,
}

/// 熔断器记录一次拒绝 / 非拒绝后返回的动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GuardianRejectionCircuitBreakerAction {
    /// 继续运行,无需中断。
    Continue,
    /// 触发 turn 中断,附带当前连续拒绝数与窗口内拒绝数。
    InterruptTurn {
        consecutive_denials: u32,
        recent_denials: u32,
    },
}

impl GuardianRejectionCircuitBreaker {
    /// 清除指定 turn 的熔断器状态(在 turn 结束时调用)。
    pub(crate) fn clear_turn(&mut self, turn_id: &str) {
        self.turns.remove(turn_id);
    }

    /// 记录一次拒绝,并返回是否应中断当前 turn。
    pub(crate) fn record_denial(&mut self, turn_id: &str) -> GuardianRejectionCircuitBreakerAction {
        let turn = self.turns.entry(turn_id.to_string()).or_default();
        turn.consecutive_denials = turn.consecutive_denials.saturating_add(1);
        Self::record_recent_review(turn, /*denied*/ true);
        let recent_denials = turn.recent_denials.iter().filter(|denied| **denied).count() as u32;
        // 当连续拒绝或窗口内拒绝达到阈值,且本 turn 尚未触发过中断,则触发中断。
        if !turn.interrupt_triggered
            && (turn.consecutive_denials >= MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN
                || recent_denials >= MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN)
        {
            turn.interrupt_triggered = true;
            GuardianRejectionCircuitBreakerAction::InterruptTurn {
                consecutive_denials: turn.consecutive_denials,
                recent_denials,
            }
        } else {
            GuardianRejectionCircuitBreakerAction::Continue
        }
    }

    /// 记录一次非拒绝结果(批准 / timeout / 错误等),清零连续拒绝计数。
    pub(crate) fn record_non_denial(&mut self, turn_id: &str) {
        let turn = self.turns.entry(turn_id.to_string()).or_default();
        turn.consecutive_denials = 0;
        Self::record_recent_review(turn, /*denied*/ false);
    }

    /// 将一次 review 结果推入滑动窗口,超出窗口大小时弹出最旧项。
    fn record_recent_review(turn: &mut GuardianRejectionCircuitBreakerTurn, denied: bool) {
        turn.recent_denials.push_back(denied);
        if turn.recent_denials.len() > AUTO_REVIEW_DENIAL_WINDOW_SIZE {
            turn.recent_denials.pop_front();
        }
    }
}

#[cfg(test)]
use approval_request::format_guardian_action_pretty;
#[cfg(test)]
use approval_request::guardian_assessment_action;
#[cfg(test)]
use approval_request::guardian_request_turn_id;
#[cfg(test)]
use prompt::GuardianPromptMode;
#[cfg(test)]
use prompt::GuardianTranscriptCursor;
#[cfg(test)]
use prompt::GuardianTranscriptEntry;
#[cfg(test)]
use prompt::GuardianTranscriptEntryKind;
#[cfg(test)]
use prompt::build_guardian_prompt_items;
#[cfg(test)]
use prompt::build_guardian_prompt_items_with_parent_turn;
#[cfg(test)]
use prompt::collect_guardian_transcript_entries;
#[cfg(test)]
use prompt::guardian_output_schema;
#[cfg(test)]
pub(crate) use prompt::guardian_policy_prompt;
#[cfg(test)]
pub(crate) use prompt::guardian_policy_prompt_with_config;
#[cfg(test)]
use prompt::guardian_truncate_text;
#[cfg(test)]
use prompt::parse_guardian_assessment;
#[cfg(test)]
use prompt::render_guardian_transcript_entries;
#[cfg(test)]
use review::GuardianReviewOutcome;
#[cfg(test)]
use review::run_guardian_review_session_with_retry as run_guardian_review_session_for_test;
#[cfg(test)]
use review_session::build_guardian_review_session_config as build_guardian_review_session_config_for_test;

#[cfg(test)]
mod tests;
