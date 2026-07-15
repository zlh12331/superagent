//! 基于"user turn"边界的 rollout 截断辅助函数。
//!
//! 在 core 中，"user turn" 通过扫描 `ResponseItem::Message` item 并使用
//! `event_mapping::parse_turn_item(...)` 解析来检测。

use crate::context_manager::is_user_turn_boundary;
use crate::event_mapping;
use codex_app_server_protocol::TurnStatus;
use codex_app_server_protocol::build_turns_from_rollout_items;
use codex_protocol::error::CodexErr;
use codex_protocol::error::Result as CodexResult;
use codex_protocol::items::TurnItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::InitialHistory;
use codex_protocol::protocol::InterAgentCommunication;
use codex_protocol::protocol::RolloutItem;

/// 判断初始历史中是否包含先前的 user turn。
pub(crate) fn initial_history_has_prior_user_turns(conversation_history: &InitialHistory) -> bool {
    conversation_history.scan_rollout_items(rollout_item_is_user_turn_boundary)
}

fn rollout_item_is_user_turn_boundary(item: &RolloutItem) -> bool {
    match item {
        RolloutItem::ResponseItem(item) => is_user_turn_boundary(item),
        RolloutItem::InterAgentCommunication(_) => true,
        _ => false,
    }
}

/// 返回 rollout 中 user message 边界的索引列表。
///
/// user message 边界是 `RolloutItem::ResponseItem(ResponseItem::Message { .. })`
/// 且其解析后的 turn item 为 `TurnItem::UserMessage`。
///
/// Rollout 可能包含 `ThreadRolledBack` 标记。这些标记表示最后 N 个 user turn 已从
/// 有效线程历史中移除；此处应用这些标记，使索引基于回滚后的历史而非原始流。
pub(crate) fn user_message_positions_in_rollout(items: &[RolloutItem]) -> Vec<usize> {
    let mut user_positions = Vec::new();
    for (idx, item) in items.iter().enumerate() {
        match item {
            RolloutItem::ResponseItem(item @ ResponseItem::Message { .. })
                if matches!(
                    event_mapping::parse_turn_item(item),
                    Some(TurnItem::UserMessage(_))
                ) =>
            {
                user_positions.push(idx);
            }
            RolloutItem::EventMsg(EventMsg::ThreadRolledBack(rollback)) => {
                let num_turns = usize::try_from(rollback.num_turns).unwrap_or(usize::MAX);
                let new_len = user_positions.len().saturating_sub(num_turns);
                user_positions.truncate(new_len);
            }
            _ => {}
        }
    }
    user_positions
}

/// 返回 rollout 中 fork-turn 边界的索引列表。
///
/// fork-turn 边界是以下之一：
/// - 真实的 user message 边界，或
/// - `trigger_turn` 为 `true` 的 inter-agent communication，或
/// - 具有相同标记的旧版 assistant inter-agent 信封。
///
/// 与 `user_message_positions_in_rollout` 类似，此处应用 `ThreadRolledBack` 标记，
/// 使索引反映回滚后的有效历史。回滚按 instruction turn 计数，因此回滚会从最早的
/// 被回滚 instruction-turn 边界开始移除陈旧后缀，而非简单地截断混合的 fork-boundary 列表。
pub(crate) fn fork_turn_positions_in_rollout(items: &[RolloutItem]) -> Vec<usize> {
    let mut rollback_turn_positions = Vec::new();
    let mut fork_turn_positions = Vec::new();
    for (idx, item) in items.iter().enumerate() {
        match item {
            RolloutItem::ResponseItem(item) => {
                let has_delivery_metadata = matches!(item, ResponseItem::AgentMessage { .. })
                    && idx.checked_sub(1).is_some_and(|previous_idx| {
                        matches!(
                            items.get(previous_idx),
                            Some(RolloutItem::InterAgentCommunicationMetadata { .. })
                        )
                    });
                if is_user_turn_boundary(item) && !has_delivery_metadata {
                    rollback_turn_positions.push(idx);
                }
                if is_real_user_message_boundary(item) || is_trigger_turn_boundary(item) {
                    fork_turn_positions.push(idx);
                }
            }
            RolloutItem::InterAgentCommunication(communication) => {
                rollback_turn_positions.push(idx);
                if communication.trigger_turn {
                    fork_turn_positions.push(idx);
                }
            }
            RolloutItem::InterAgentCommunicationMetadata { trigger_turn } => {
                rollback_turn_positions.push(idx);
                if *trigger_turn {
                    fork_turn_positions.push(idx);
                }
            }
            RolloutItem::EventMsg(EventMsg::ThreadRolledBack(rollback)) => {
                let num_turns = usize::try_from(rollback.num_turns).unwrap_or(usize::MAX);
                if num_turns == 0 {
                    continue;
                }
                let Some(rollback_start_idx) = rollback_turn_positions
                    .len()
                    .checked_sub(num_turns)
                    .map(|rollback_start| rollback_turn_positions[rollback_start])
                    .or_else(|| rollback_turn_positions.first().copied())
                else {
                    continue;
                };
                let new_rollback_len = rollback_turn_positions.len().saturating_sub(num_turns);
                rollback_turn_positions.truncate(new_rollback_len);
                fork_turn_positions.retain(|position| *position < rollback_start_idx);
            }
            _ => {}
        }
    }
    fork_turn_positions
}

/// 返回在第 n 个 user message 之前严格截断的 `items` 前缀。
///
/// 边界索引从 `items` 开头 0-based 计数（因此 `n_from_start = 0` 返回的前缀
/// 排除第一个 user message 及其后的所有内容）。
///
/// 若 `n_from_start` 为 `usize::MAX`，返回完整 rollout（不截断）。
/// 若 user message 数量小于等于 `n_from_start`，返回完整 rollout 不变。
pub(crate) fn truncate_rollout_before_nth_user_message_from_start(
    items: &[RolloutItem],
    n_from_start: usize,
) -> Vec<RolloutItem> {
    if n_from_start == usize::MAX {
        return items.to_vec();
    }

    let user_positions = user_message_positions_in_rollout(items);

    // If fewer than or equal to n user messages exist, keep the full rollout.
    if user_positions.len() <= n_from_start {
        return items.to_vec();
    }

    // Cut strictly before the nth user message (do not keep the nth itself).
    let cut_idx = user_positions[n_from_start];
    items[..cut_idx].to_vec()
}

/// 返回在请求的已持久化终态 turn 之后结束的 rollout 前缀。
///
/// 该 turn 必须仍存在于回滚后的有效历史中，且必须有显式的已持久化 TurnStarted 边界。
/// 投影旧版 rollout 时生成的合成 ID 不受支持，因为它们不提供稳定的 fork 原始 rollout 边界。
pub fn truncate_rollout_after_turn_id(
    items: &[RolloutItem],
    last_turn_id: &str,
) -> CodexResult<Vec<RolloutItem>> {
    let turns = build_turns_from_rollout_items(items);
    let turn = turns
        .iter()
        .find(|turn| turn.id == last_turn_id)
        .ok_or_else(|| {
            CodexErr::InvalidRequest(format!(
                "lastTurnId '{last_turn_id}' was not found in the source thread"
            ))
        })?;

    let target_start_index = items
        .iter()
        .position(|item| {
            matches!(
                item,
                RolloutItem::EventMsg(EventMsg::TurnStarted(event))
                    if event.turn_id == last_turn_id
            )
        })
        .ok_or_else(|| {
            CodexErr::InvalidRequest(format!(
                "lastTurnId '{last_turn_id}' is not a persisted canonical turn in the source thread"
            ))
        })?;

    if matches!(turn.status, TurnStatus::InProgress) {
        return Err(CodexErr::InvalidRequest(format!(
            "lastTurnId '{last_turn_id}' identifies an in-progress turn"
        )));
    }

    let cut_index = items
        .iter()
        .enumerate()
        .skip(target_start_index.saturating_add(1))
        .find_map(|(index, item)| {
            matches!(item, RolloutItem::EventMsg(EventMsg::TurnStarted(_))).then_some(index)
        })
        .unwrap_or(items.len());
    Ok(items[..cut_index].to_vec())
}

/// 返回保留最后 `n_from_end` 个 fork turn 的 `items` 后缀。
///
/// 若 fork turn 数量小于等于 `n_from_end`，则从第一个 fork-turn 边界开始保留，
/// 并仍会丢弃 turn 前的启动上下文。
pub(crate) fn truncate_rollout_to_last_n_fork_turns(
    items: &[RolloutItem],
    n_from_end: usize,
) -> Vec<RolloutItem> {
    if n_from_end == 0 {
        return Vec::new();
    }

    let fork_turn_positions = fork_turn_positions_in_rollout(items);
    let Some(keep_idx) = fork_turn_positions
        .len()
        .checked_sub(n_from_end)
        .map(|position| fork_turn_positions[position])
        .or_else(|| fork_turn_positions.first().copied())
    else {
        return Vec::new();
    };
    items[keep_idx..].to_vec()
}

fn is_real_user_message_boundary(item: &ResponseItem) -> bool {
    matches!(
        event_mapping::parse_turn_item(item),
        Some(TurnItem::UserMessage(_))
    )
}

fn is_trigger_turn_boundary(item: &ResponseItem) -> bool {
    let ResponseItem::Message { role, content, .. } = item else {
        return false;
    };

    role == "assistant"
        && InterAgentCommunication::from_message_content(content)
            .is_some_and(|communication| communication.trigger_turn)
}

#[cfg(test)]
#[path = "thread_rollout_truncation_tests.rs"]
mod tests;
