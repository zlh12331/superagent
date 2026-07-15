//! Web search 对话历史构建模块。
//!
//! 该模块负责从完整的对话历史中提取用于独立 web 搜索的上下文消息。
//! 保留最近 2 条用户文本消息以及它们之间不超过 1000 token 的助手文本输出，
//! 为搜索请求提供必要的上下文。

use codex_api::SearchInput;
use codex_core::parse_turn_item;
use codex_protocol::items::TurnItem;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::models::plaintext_agent_message_content;
use codex_tools::retain_tail_from_last_n_user_messages;
use codex_tools::truncate_assistant_output_text_to_token_budget;

/// 助手上下文的 token 上限
const ASSISTANT_CONTEXT_TOKEN_LIMIT: usize = 1_000;
/// assistant 角色标识
const ASSISTANT_ROLE: &str = "assistant";
/// user 角色标识
const USER_ROLE: &str = "user";

/// 构建独立 web 搜索的对话尾部。
///
/// 保留逻辑：
/// - 保留前一条用户文本消息
/// - 保留该用户消息之后不超过 1k token 的助手文本输出
/// - 保留当前用户文本消息
///
/// # 参数
/// - `items`：完整的对话历史
///
/// # 返回
/// 返回 `Some(SearchInput)` 当存在至少一条可见消息，否则返回 `None`。
pub(crate) fn recent_input(items: &[ResponseItem]) -> Option<SearchInput> {
    let mut messages = Vec::new();
    for item in items {
        push_visible_message(&mut messages, item);
    }

    // 保留最后 2 条用户消息及其后的助手消息
    retain_tail_from_last_n_user_messages(&mut messages, /*user_message_count*/ 2);
    // 截断助手输出到 token 上限
    truncate_assistant_output_text_to_token_budget(&mut messages, ASSISTANT_CONTEXT_TOKEN_LIMIT);
    (!messages.is_empty()).then_some(SearchInput::Items(messages))
}

/// 将可见消息推入消息列表。
///
/// 处理三类消息：
/// - assistant 消息：直接克隆并清除 id
/// - agent 消息：提取纯文本内容并转为 assistant 消息格式
/// - user 消息：仅保留 `InputText` 内容项，且必须是 `TurnItem::UserMessage` 类型
fn push_visible_message(messages: &mut Vec<ResponseItem>, item: &ResponseItem) {
    match item {
        ResponseItem::Message { role, .. } if role == ASSISTANT_ROLE => {
            let mut message = item.clone();
            message.set_id(/*new_id*/ None);
            messages.push(message);
        }
        // 将 agent 消息转换为 assistant 消息格式
        ResponseItem::AgentMessage {
            author,
            content,
            internal_chat_message_metadata_passthrough: metadata,
            ..
        } => {
            if let Some(text) = plaintext_agent_message_content(content) {
                messages.push(ResponseItem::Message {
                    id: None,
                    role: ASSISTANT_ROLE.to_string(),
                    content: vec![ContentItem::OutputText {
                        text: format!("Agent message from {author}:\n{text}"),
                    }],
                    phase: None,
                    internal_chat_message_metadata_passthrough: metadata.clone(),
                });
            }
        }
        // 仅保留作为 TurnItem::UserMessage 的用户消息，且仅保留文本内容
        ResponseItem::Message {
            id: _,
            role,
            content,
            phase,
            internal_chat_message_metadata_passthrough: metadata,
        } if role == USER_ROLE
            && matches!(parse_turn_item(item), Some(TurnItem::UserMessage(_))) =>
        {
            let content = content
                .iter()
                .filter(|item| matches!(item, ContentItem::InputText { .. }))
                .cloned()
                .collect::<Vec<_>>();
            if !content.is_empty() {
                messages.push(ResponseItem::Message {
                    id: None,
                    role: role.clone(),
                    content,
                    phase: phase.clone(),
                    internal_chat_message_metadata_passthrough: metadata.clone(),
                });
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use codex_api::SearchInput;
    use codex_protocol::models::ContentItem;
    use codex_protocol::models::ResponseItem;
    use pretty_assertions::assert_eq;

    use super::ASSISTANT_ROLE;
    use super::USER_ROLE;
    use super::recent_input;

    fn message(role: &str, text: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: role.to_string(),
            content: vec![if role == ASSISTANT_ROLE {
                ContentItem::OutputText {
                    text: text.to_string(),
                }
            } else {
                ContentItem::InputText {
                    text: text.to_string(),
                }
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    #[test]
    fn keeps_current_user_and_previous_visible_turn() {
        let mut previous_user = message(USER_ROLE, "previous user");
        previous_user.set_id(Some("msg_previous_user".to_string()));
        let mut previous_assistant = message(ASSISTANT_ROLE, "previous assistant");
        previous_assistant.set_id(Some("msg_previous_assistant".to_string()));
        let items = vec![
            message("system", "system"),
            message(USER_ROLE, "old user"),
            message(ASSISTANT_ROLE, "old assistant"),
            previous_user,
            ResponseItem::FunctionCall {
                id: None,
                name: "tool".to_string(),
                namespace: None,
                arguments: "{}".to_string(),
                call_id: "call-1".to_string(),
                internal_chat_message_metadata_passthrough: None,
            },
            previous_assistant,
            message("developer", "developer"),
            message(USER_ROLE, "current user"),
            message(ASSISTANT_ROLE, "current commentary"),
        ];

        assert_eq!(
            recent_input(&items),
            Some(SearchInput::Items(vec![
                message(USER_ROLE, "previous user"),
                message(ASSISTANT_ROLE, "previous assistant"),
                message(USER_ROLE, "current user"),
            ]))
        );
    }

    #[test]
    fn keeps_only_text_from_recent_user_messages() {
        let previous_user = ResponseItem::Message {
            id: None,
            role: USER_ROLE.to_string(),
            content: vec![
                ContentItem::InputText {
                    text: "previous user".to_string(),
                },
                ContentItem::InputImage {
                    image_url: "data:image/png;base64,image".to_string(),
                    detail: None,
                },
            ],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        };
        let items = vec![
            previous_user,
            message(ASSISTANT_ROLE, "previous assistant"),
            message(USER_ROLE, "current user"),
        ];

        assert_eq!(
            recent_input(&items),
            Some(SearchInput::Items(vec![
                message(USER_ROLE, "previous user"),
                message(ASSISTANT_ROLE, "previous assistant"),
                message(USER_ROLE, "current user"),
            ]))
        );
    }

    #[test]
    fn ignores_contextual_user_messages_when_selecting_recent_turns() {
        let items = vec![
            message(USER_ROLE, "previous user"),
            message(ASSISTANT_ROLE, "previous assistant"),
            message(
                USER_ROLE,
                "<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>",
            ),
            message(USER_ROLE, "current user"),
        ];

        assert_eq!(
            recent_input(&items),
            Some(SearchInput::Items(vec![
                message(USER_ROLE, "previous user"),
                message(ASSISTANT_ROLE, "previous assistant"),
                message(USER_ROLE, "current user"),
            ]))
        );
    }
}
