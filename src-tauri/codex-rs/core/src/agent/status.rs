//! agent 状态(status)模块。
//!
//! 根据上游 emit 的事件推导 agent 的状态变迁,
//! 并提供"是否终态"的判定,供上层在等待 subagent 完成时使用。

use codex_protocol::protocol::AgentStatus;
use codex_protocol::protocol::EventMsg;

/// 从单个已 emit 的事件推导下一个 agent 状态。
///
/// 返回 `None` 表示该事件不影响状态追踪(例如输出增量事件)。
pub(crate) fn agent_status_from_event(msg: &EventMsg) -> Option<AgentStatus> {
    match msg {
        EventMsg::TurnStarted(_) => Some(AgentStatus::Running),
        EventMsg::TurnComplete(ev) => Some(AgentStatus::Completed(ev.last_agent_message.clone())),
        EventMsg::TurnAborted(ev) => match ev.reason {
            codex_protocol::protocol::TurnAbortReason::Interrupted
            | codex_protocol::protocol::TurnAbortReason::BudgetLimited => {
                Some(AgentStatus::Interrupted)
            }
            _ => Some(AgentStatus::Errored(format!("{:?}", ev.reason))),
        },
        EventMsg::Error(ev) => Some(AgentStatus::Errored(ev.message.clone())),
        EventMsg::ShutdownComplete => Some(AgentStatus::Shutdown),
        _ => None,
    }
}

/// 判断给定状态是否为终态(不可再变迁)。
///
/// `PendingInit` / `Running` / `Interrupted` 均为非终态;
/// 其余状态(`Completed` / `Errored` / `Shutdown`)为终态。
pub(crate) fn is_final(status: &AgentStatus) -> bool {
    !matches!(
        status,
        AgentStatus::PendingInit | AgentStatus::Running | AgentStatus::Interrupted
    )
}
