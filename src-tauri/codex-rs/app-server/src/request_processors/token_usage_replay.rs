//! 当客户端 attach 到一个已存在的 thread 时，重放已持久化的 token usage 快照。
//!
//! message processor 决定何时允许 replay，并保持 JSON-RPC response 的顺序。
//! 本模块负责 notification 构造以及归因规则，将最新持久化的 `TokenCount`
//! 映射回 v2 的 turn id。
//!
//! rollout 历史中可能包含显式 turn id 或生成的 turn id。当显式 id 与
//! rebuilt thread 不匹配时，replay 会回退到持久化 `TokenCount` 时处于
//! 活跃状态的 turn position，以确保 notification 仍能指向对应的
//! rebuilt turn。

use std::sync::Arc;

use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::Thread;
use codex_app_server_protocol::ThreadHistoryBuilder;
use codex_app_server_protocol::ThreadTokenUsage;
use codex_app_server_protocol::ThreadTokenUsageUpdatedNotification;
use codex_app_server_protocol::Turn;
use codex_app_server_protocol::TurnStatus;
use codex_core::CodexThread;
use codex_protocol::ThreadId;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::RolloutItem;

use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::OutgoingMessageSender;

/// 向 attach 到某 thread 的 connection 发送 restored token usage 更新。
///
/// 这是 lifecycle replay 而非 model event：rollout 已包含原始 `TokenCount`，
/// 若在此处通过 `send_event` 发射会造成已持久化 usage 记录的重复。
/// 将 replay 限定在 connection 范围内，也能避免在其它订阅者可能正在
/// 渲染实时 turn 事件时，因历史 usage 更新而产生意外。
pub(super) async fn send_thread_token_usage_update_to_connection(
    outgoing: &Arc<OutgoingMessageSender>,
    connection_id: ConnectionId,
    thread_id: ThreadId,
    thread: &Thread,
    conversation: &CodexThread,
    token_usage_turn_id: Option<String>,
) {
    let Some(info) = conversation.token_usage_info().await else {
        return;
    };
    let notification = ThreadTokenUsageUpdatedNotification {
        thread_id: thread_id.to_string(),
        turn_id: token_usage_turn_id.unwrap_or_else(|| latest_token_usage_turn_id(thread)),
        token_usage: ThreadTokenUsage::from(info),
    };
    outgoing
        .send_server_notification_to_connections(
            &[connection_id],
            ServerNotification::ThreadTokenUsageUpdated(notification),
        )
        .await;
}

/// 标识 `TokenCount` 记录出现时处于活跃状态的 turn。
///
/// 当 id 仍出现在 rebuilt thread 中时优先使用 id。position 是一种回退方案，
/// 用于那些隐式 turn id 在重建过程中被重新生成的历史记录。
struct TokenUsageTurnOwner {
    id: String,
    position: Option<usize>,
}

pub(super) fn latest_token_usage_turn_id_from_rollout_items(
    rollout_items: &[RolloutItem],
    turns: &[Turn],
) -> Option<String> {
    let mut builder = ThreadHistoryBuilder::new();
    let mut token_usage_turn_owner = None;

    for item in rollout_items {
        if matches!(item, RolloutItem::EventMsg(EventMsg::TokenCount(_))) {
            token_usage_turn_owner =
                builder
                    .active_turn_snapshot()
                    .map(|turn| TokenUsageTurnOwner {
                        id: turn.id,
                        position: builder.active_turn_position(),
                    });
        }
        builder.handle_rollout_item(item);
    }

    let owner = token_usage_turn_owner?;
    if turns.iter().any(|turn| turn.id == owner.id) {
        Some(owner.id)
    } else {
        owner
            .position
            .and_then(|position| turns.get(position))
            .map(|turn| turn.id.clone())
    }
}

/// Chooses a fallback turn id that should own a replayed token usage update.
///
/// Normal replay derives the owner from the rollout position of the latest
/// `TokenCount` event. This fallback only preserves a stable wire shape for
/// unusual histories where that rollout information cannot be read.
fn latest_token_usage_turn_id(thread: &Thread) -> String {
    thread
        .turns
        .iter()
        .rev()
        .find(|turn| matches!(turn.status, TurnStatus::Completed | TurnStatus::Failed))
        .or_else(|| thread.turns.last())
        .map(|turn| turn.id.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_app_server_protocol::build_turns_from_rollout_items;
    use codex_protocol::protocol::AgentMessageEvent;
    use codex_protocol::protocol::TokenCountEvent;
    use codex_protocol::protocol::UserMessageEvent;
    use pretty_assertions::assert_eq;

    #[test]
    fn replay_attribution_uses_already_loaded_history() {
        let rollout_items = token_usage_history();
        let turns = build_turns_from_rollout_items(&rollout_items);

        assert_eq!(
            latest_token_usage_turn_id_from_rollout_items(&rollout_items, turns.as_slice()),
            Some(turns[0].id.clone())
        );
    }

    #[test]
    fn replay_attribution_falls_back_to_rebuilt_turn_position() {
        let rollout_items = token_usage_history();
        let mut turns = build_turns_from_rollout_items(&rollout_items);
        turns[0].id = "rebuilt-turn-id".to_string();

        assert_eq!(
            latest_token_usage_turn_id_from_rollout_items(&rollout_items, turns.as_slice()),
            Some("rebuilt-turn-id".to_string())
        );
    }

    fn token_usage_history() -> Vec<RolloutItem> {
        vec![
            RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
                client_id: None,
                message: "first turn".to_string(),
                images: None,
                local_images: Vec::new(),
                text_elements: Vec::new(),
                ..Default::default()
            })),
            RolloutItem::EventMsg(EventMsg::AgentMessage(AgentMessageEvent {
                message: "first answer".to_string(),
                phase: None,
                memory_citation: None,
            })),
            RolloutItem::EventMsg(EventMsg::TokenCount(TokenCountEvent {
                info: None,
                rate_limits: None,
            })),
            RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
                client_id: None,
                message: "second turn".to_string(),
                images: None,
                local_images: Vec::new(),
                text_elements: Vec::new(),
                ..Default::default()
            })),
        ]
    }
}
