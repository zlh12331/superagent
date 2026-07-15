//! 从 rollout item 提取并更新 thread 元数据。
//!
//! 本模块负责将 [`RolloutItem`] 中影响 thread 元数据的事件（如 SessionMeta、
//! TurnContext、UserMessage、TokenCount、ThreadGoalUpdated 等）应用到
//! [`ThreadMetadata`]，作为 SQLite 镜像的来源。

use crate::model::ThreadMetadata;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::RolloutItem;
use codex_protocol::protocol::SessionMetaLine;
use codex_protocol::protocol::TurnContextItem;
use codex_protocol::protocol::USER_MESSAGE_BEGIN;
use codex_protocol::protocol::UserMessageEvent;
use serde::Serialize;
use serde_json::Value;

/// 仅含图片的用户消息使用的占位文本。
const IMAGE_ONLY_USER_MESSAGE_PLACEHOLDER: &str = "[Image]";

/// 将单个 rollout item 应用到 thread 元数据结构。
///
/// 根据 item 类型分别调用对应的应用函数，并在末尾确保 `model_provider` 不为空：
/// 若为空则填充为 `default_provider`。
///
/// # 参数
/// - `metadata`: 待更新的 thread 元数据
/// - `item`: rollout item 引用
/// - `default_provider`: 默认模型 provider ID，仅在 `metadata.model_provider` 为空时使用
pub fn apply_rollout_item(
    metadata: &mut ThreadMetadata,
    item: &RolloutItem,
    default_provider: &str,
) {
    match item {
        RolloutItem::SessionMeta(meta_line) => apply_session_meta_from_item(metadata, meta_line),
        RolloutItem::TurnContext(turn_ctx) => apply_turn_context(metadata, turn_ctx),
        RolloutItem::EventMsg(event) => apply_event_msg(metadata, event),
        RolloutItem::ResponseItem(item) => apply_response_item(metadata, item),
        RolloutItem::InterAgentCommunication(_)
        | RolloutItem::InterAgentCommunicationMetadata { .. } => {}
        RolloutItem::Compacted(_) => {}
        RolloutItem::WorldState(_) => {}
    }
    if metadata.model_provider.is_empty() {
        metadata.model_provider = default_provider.to_string();
    }
}

/// 判断该 rollout item 是否会影响存储在 SQLite 中的 thread 元数据。
///
/// 用于回填流程中跳过不影响元数据的 item，减少不必要的写操作。
///
/// # 参数
/// - `item`: rollout item 引用
///
/// # 返回值
/// 若该 item 类型会修改 thread 元数据则返回 `true`，否则返回 `false`。
pub fn rollout_item_affects_thread_metadata(item: &RolloutItem) -> bool {
    match item {
        RolloutItem::SessionMeta(_) | RolloutItem::TurnContext(_) => true,
        RolloutItem::EventMsg(
            EventMsg::TokenCount(_) | EventMsg::UserMessage(_) | EventMsg::ThreadGoalUpdated(_),
        ) => true,
        RolloutItem::EventMsg(_)
        | RolloutItem::ResponseItem(_)
        | RolloutItem::InterAgentCommunication(_)
        | RolloutItem::InterAgentCommunicationMetadata { .. }
        | RolloutItem::Compacted(_)
        | RolloutItem::WorldState(_) => false,
    }
}

fn apply_session_meta_from_item(metadata: &mut ThreadMetadata, meta_line: &SessionMetaLine) {
    if metadata.id != meta_line.meta.id {
        // 忽略与规范 thread ID 不匹配的 session_meta 行，
        // 例如 fork 出来的 rollout 中嵌入的源会话元数据。
        return;
    }
    metadata.id = meta_line.meta.id;
    metadata.source = enum_to_string(&meta_line.meta.source);
    // 后续的 SessionMeta 行不会重新定义规范的 history_mode。
    metadata.thread_source = meta_line.meta.thread_source.clone();
    metadata.agent_nickname = meta_line.meta.agent_nickname.clone();
    metadata.agent_role = meta_line.meta.agent_role.clone();
    metadata.agent_path = meta_line.meta.agent_path.clone();
    if let Some(provider) = meta_line.meta.model_provider.as_deref() {
        metadata.model_provider = provider.to_string();
    }
    if !meta_line.meta.cli_version.is_empty() {
        metadata.cli_version = meta_line.meta.cli_version.clone();
    }
    if !meta_line.meta.cwd.as_os_str().is_empty() {
        metadata.cwd = meta_line.meta.cwd.clone();
    }
    if let Some(git) = meta_line.git.as_ref() {
        metadata.git_sha = git.commit_hash.as_ref().map(|sha| sha.0.clone());
        metadata.git_branch = git.branch.clone();
        metadata.git_origin_url = git.repository_url.clone();
    }
}

fn apply_turn_context(metadata: &mut ThreadMetadata, turn_ctx: &TurnContextItem) {
    if metadata.cwd.as_os_str().is_empty() {
        metadata.cwd = turn_ctx.cwd.clone().into_path_buf();
    }
    metadata.model = Some(turn_ctx.model.clone());
    metadata.reasoning_effort = turn_ctx.effort.clone();
    metadata.sandbox_policy =
        serde_json::to_string(&turn_ctx.permission_profile()).unwrap_or_default();
    metadata.approval_mode = enum_to_string(&turn_ctx.approval_policy);
}

fn apply_event_msg(metadata: &mut ThreadMetadata, event: &EventMsg) {
    match event {
        EventMsg::TokenCount(token_count) => {
            if let Some(info) = token_count.info.as_ref() {
                metadata.tokens_used = info.total_token_usage.total_tokens.max(0);
            }
        }
        EventMsg::UserMessage(user) => {
            let preview = user_message_preview(user);
            if metadata.first_user_message.is_none() {
                metadata.first_user_message = preview.clone();
            }
            set_preview_if_empty(metadata, preview);
            if metadata.title.is_empty() {
                let title = strip_user_message_prefix(user.message.as_str());
                if !title.is_empty() {
                    metadata.title = title.to_string();
                }
            }
        }
        EventMsg::ThreadGoalUpdated(event) => {
            let objective = event.goal.objective.trim();
            if !objective.is_empty() {
                set_preview_if_empty(metadata, Some(objective.to_string()));
            }
        }
        _ => {}
    }
}

fn apply_response_item(_metadata: &mut ThreadMetadata, _item: &ResponseItem) {}

fn set_preview_if_empty(metadata: &mut ThreadMetadata, preview: Option<String>) {
    if metadata.preview.is_none() {
        metadata.preview = preview;
    }
}

fn strip_user_message_prefix(text: &str) -> &str {
    match text.find(USER_MESSAGE_BEGIN) {
        Some(idx) => text[idx + USER_MESSAGE_BEGIN.len()..].trim(),
        None => text.trim(),
    }
}

fn user_message_preview(user: &UserMessageEvent) -> Option<String> {
    let message = strip_user_message_prefix(user.message.as_str());
    if !message.is_empty() {
        return Some(message.to_string());
    }
    if user
        .images
        .as_ref()
        .is_some_and(|images| !images.is_empty())
        || !user.local_images.is_empty()
    {
        return Some(IMAGE_ONLY_USER_MESSAGE_PLACEHOLDER.to_string());
    }
    None
}

/// 将枚举值序列化为字符串表示，用于元数据存储。
///
/// 优先使用 serde JSON 序列化提取字符串值；非字符串值退化为 `to_string()`；
/// 序列化失败时返回空字符串。
pub(crate) fn enum_to_string<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::apply_rollout_item;
    use crate::model::ThreadMetadata;
    use chrono::DateTime;
    use chrono::Utc;
    use codex_protocol::ThreadId;
    use codex_protocol::models::ContentItem;
    use codex_protocol::models::PermissionProfile;
    use codex_protocol::models::ResponseItem;
    use codex_protocol::openai_models::ReasoningEffort;
    use codex_protocol::protocol::AskForApproval;
    use codex_protocol::protocol::EventMsg;
    use codex_protocol::protocol::RolloutItem;
    use codex_protocol::protocol::SandboxPolicy;
    use codex_protocol::protocol::SessionMeta;
    use codex_protocol::protocol::SessionMetaLine;
    use codex_protocol::protocol::SessionSource;
    use codex_protocol::protocol::ThreadGoal;
    use codex_protocol::protocol::ThreadGoalStatus;
    use codex_protocol::protocol::ThreadGoalUpdatedEvent;
    use codex_protocol::protocol::ThreadHistoryMode;
    use codex_protocol::protocol::TurnContextItem;
    use codex_protocol::protocol::USER_MESSAGE_BEGIN;
    use codex_protocol::protocol::UserMessageEvent;

    use pretty_assertions::assert_eq;
    use std::path::PathBuf;
    use uuid::Uuid;

    #[test]
    fn response_item_user_messages_do_not_set_title_or_first_user_message() {
        let mut metadata = metadata_for_test();
        let item = RolloutItem::ResponseItem(ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText {
                text: "hello from response item".to_string(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        });

        apply_rollout_item(&mut metadata, &item, "test-provider");

        assert_eq!(metadata.first_user_message, None);
        assert_eq!(metadata.preview, None);
        assert_eq!(metadata.title, "");
    }

    #[test]
    fn event_msg_user_messages_set_title_and_first_user_message() {
        let mut metadata = metadata_for_test();
        let item = RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
            client_id: None,
            message: format!("{USER_MESSAGE_BEGIN} actual user request"),
            images: Some(vec![]),
            local_images: vec![],
            text_elements: vec![],
            ..Default::default()
        }));

        apply_rollout_item(&mut metadata, &item, "test-provider");

        assert_eq!(
            metadata.first_user_message.as_deref(),
            Some("actual user request")
        );
        assert_eq!(metadata.preview.as_deref(), Some("actual user request"));
        assert_eq!(metadata.title, "actual user request");
    }

    #[test]
    fn event_msg_image_only_user_message_sets_image_placeholder_preview() {
        let mut metadata = metadata_for_test();
        let item = RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
            client_id: None,
            message: String::new(),
            images: Some(vec!["https://example.com/image.png".to_string()]),
            local_images: vec![],
            text_elements: vec![],
            ..Default::default()
        }));

        apply_rollout_item(&mut metadata, &item, "test-provider");

        assert_eq!(
            metadata.first_user_message.as_deref(),
            Some(super::IMAGE_ONLY_USER_MESSAGE_PLACEHOLDER)
        );
        assert_eq!(
            metadata.preview.as_deref(),
            Some(super::IMAGE_ONLY_USER_MESSAGE_PLACEHOLDER)
        );
        assert_eq!(metadata.title, "");
    }

    #[test]
    fn event_msg_blank_user_message_without_images_keeps_first_user_message_empty() {
        let mut metadata = metadata_for_test();
        let item = RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
            client_id: None,
            message: "   ".to_string(),
            images: Some(vec![]),
            local_images: vec![],
            text_elements: vec![],
            ..Default::default()
        }));

        apply_rollout_item(&mut metadata, &item, "test-provider");

        assert_eq!(metadata.first_user_message, None);
        assert_eq!(metadata.preview, None);
        assert_eq!(metadata.title, "");
    }

    #[test]
    fn event_msg_thread_goal_sets_preview_only_and_later_user_sets_message_title() {
        let mut metadata = metadata_for_test();
        let goal_item =
            RolloutItem::EventMsg(EventMsg::ThreadGoalUpdated(ThreadGoalUpdatedEvent {
                thread_id: metadata.id,
                turn_id: None,
                goal: ThreadGoal {
                    thread_id: metadata.id,
                    objective: "optimize the benchmark".to_string(),
                    status: ThreadGoalStatus::Active,
                    token_budget: None,
                    tokens_used: 0,
                    time_used_seconds: 0,
                    created_at: 1,
                    updated_at: 1,
                },
            }));

        apply_rollout_item(&mut metadata, &goal_item, "test-provider");

        assert_eq!(metadata.preview.as_deref(), Some("optimize the benchmark"));
        assert_eq!(metadata.first_user_message, None);
        assert_eq!(metadata.title, "");

        let user_item = RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
            client_id: None,
            message: format!("{USER_MESSAGE_BEGIN} next normal prompt"),
            images: Some(vec![]),
            local_images: vec![],
            text_elements: vec![],
            ..Default::default()
        }));

        apply_rollout_item(&mut metadata, &user_item, "test-provider");

        assert_eq!(metadata.preview.as_deref(), Some("optimize the benchmark"));
        assert_eq!(
            metadata.first_user_message.as_deref(),
            Some("next normal prompt")
        );
        assert_eq!(metadata.title, "next normal prompt");
    }

    #[test]
    fn turn_context_does_not_override_session_cwd() {
        let mut metadata = metadata_for_test();
        metadata.cwd = PathBuf::new();
        let thread_id = metadata.id;

        apply_rollout_item(
            &mut metadata,
            &RolloutItem::SessionMeta(SessionMetaLine {
                meta: SessionMeta {
                    session_id: thread_id.into(),
                    id: thread_id,
                    forked_from_id: Some(
                        ThreadId::from_string(&Uuid::now_v7().to_string()).expect("thread id"),
                    ),
                    parent_thread_id: None,
                    timestamp: "2026-02-26T00:00:00.000Z".to_string(),
                    cwd: PathBuf::from("/child/worktree"),
                    originator: "codex_cli_rs".to_string(),
                    cli_version: "0.0.0".to_string(),
                    source: SessionSource::Cli,
                    thread_source: None,
                    agent_path: None,
                    agent_nickname: None,
                    agent_role: None,
                    model_provider: Some("openai".to_string()),
                    base_instructions: None,
                    dynamic_tools: None,
                    selected_capability_roots: Vec::new(),
                    memory_mode: None,
                    history_mode: Default::default(),
                    multi_agent_version: None,
                    context_window: None,
                },
                git: None,
            }),
            "test-provider",
        );
        apply_rollout_item(
            &mut metadata,
            &RolloutItem::TurnContext(TurnContextItem {
                turn_id: Some("turn-1".to_string()),
                cwd: serde_json::from_value(serde_json::json!(
                    std::env::current_dir()
                        .expect("current directory")
                        .join("parent/workspace")
                ))
                .expect("absolute parent cwd"),
                workspace_roots: None,
                current_date: None,
                timezone: None,
                approval_policy: AskForApproval::Never,
                sandbox_policy: SandboxPolicy::DangerFullAccess,
                permission_profile: None,
                network: None,
                file_system_sandbox_policy: None,
                model: "gpt-5".to_string(),
                comp_hash: None,
                personality: None,
                collaboration_mode: None,
                multi_agent_version: None,
                multi_agent_mode: None,
                realtime_active: None,
                effort: None,
                summary: codex_protocol::config_types::ReasoningSummary::Auto,
            }),
            "test-provider",
        );

        assert_eq!(metadata.cwd, PathBuf::from("/child/worktree"));
        let permission_profile: PermissionProfile = PermissionProfile::Disabled;
        assert_eq!(
            metadata.sandbox_policy,
            serde_json::to_string(&permission_profile).expect("serialize permission profile")
        );
        assert_eq!(metadata.approval_mode, "never");
    }

    #[test]
    fn turn_context_sets_permission_profile_metadata() {
        let mut metadata = metadata_for_test();
        let permission_profile = PermissionProfile::workspace_write();

        apply_rollout_item(
            &mut metadata,
            &RolloutItem::TurnContext(TurnContextItem {
                turn_id: Some("turn-1".to_string()),
                cwd: serde_json::from_value(serde_json::json!(
                    std::env::current_dir()
                        .expect("current directory")
                        .join("workspace")
                ))
                .expect("absolute workspace cwd"),
                workspace_roots: None,
                current_date: None,
                timezone: None,
                approval_policy: AskForApproval::OnRequest,
                sandbox_policy: SandboxPolicy::DangerFullAccess,
                permission_profile: Some(permission_profile.clone()),
                network: None,
                file_system_sandbox_policy: None,
                model: "gpt-5".to_string(),
                comp_hash: None,
                personality: None,
                collaboration_mode: None,
                multi_agent_version: None,
                multi_agent_mode: None,
                realtime_active: None,
                effort: None,
                summary: codex_protocol::config_types::ReasoningSummary::Auto,
            }),
            "test-provider",
        );

        assert_eq!(
            metadata.sandbox_policy,
            serde_json::to_string(&permission_profile).expect("serialize permission profile")
        );
    }

    #[test]
    fn turn_context_sets_cwd_when_session_cwd_missing() {
        let mut metadata = metadata_for_test();
        metadata.cwd = PathBuf::new();
        let fallback_cwd = std::env::current_dir()
            .expect("current directory")
            .join("fallback/workspace");

        apply_rollout_item(
            &mut metadata,
            &RolloutItem::TurnContext(TurnContextItem {
                turn_id: Some("turn-1".to_string()),
                cwd: serde_json::from_value(serde_json::json!(&fallback_cwd))
                    .expect("absolute fallback cwd"),
                workspace_roots: None,
                current_date: None,
                timezone: None,
                approval_policy: AskForApproval::OnRequest,
                sandbox_policy: SandboxPolicy::new_read_only_policy(),
                permission_profile: None,
                network: None,
                file_system_sandbox_policy: None,
                model: "gpt-5".to_string(),
                comp_hash: None,
                personality: None,
                collaboration_mode: None,
                multi_agent_version: None,
                multi_agent_mode: None,
                realtime_active: None,
                effort: Some(ReasoningEffort::High),
                summary: codex_protocol::config_types::ReasoningSummary::Auto,
            }),
            "test-provider",
        );

        assert_eq!(metadata.cwd, fallback_cwd);
    }

    #[test]
    fn turn_context_sets_model_and_reasoning_effort() {
        let mut metadata = metadata_for_test();

        apply_rollout_item(
            &mut metadata,
            &RolloutItem::TurnContext(TurnContextItem {
                turn_id: Some("turn-1".to_string()),
                cwd: serde_json::from_value(serde_json::json!(
                    std::env::current_dir()
                        .expect("current directory")
                        .join("fallback/workspace")
                ))
                .expect("absolute fallback cwd"),
                workspace_roots: None,
                current_date: None,
                timezone: None,
                approval_policy: AskForApproval::OnRequest,
                sandbox_policy: SandboxPolicy::new_read_only_policy(),
                permission_profile: None,
                network: None,
                file_system_sandbox_policy: None,
                model: "gpt-5".to_string(),
                comp_hash: None,
                personality: None,
                collaboration_mode: None,
                multi_agent_version: None,
                multi_agent_mode: None,
                realtime_active: None,
                effort: Some(ReasoningEffort::High),
                summary: codex_protocol::config_types::ReasoningSummary::Auto,
            }),
            "test-provider",
        );

        assert_eq!(metadata.model.as_deref(), Some("gpt-5"));
        assert_eq!(metadata.reasoning_effort, Some(ReasoningEffort::High));
    }

    #[test]
    fn session_meta_does_not_set_model_or_reasoning_effort() {
        let mut metadata = metadata_for_test();
        metadata.history_mode = ThreadHistoryMode::Paginated;
        let thread_id = metadata.id;

        apply_rollout_item(
            &mut metadata,
            &RolloutItem::SessionMeta(SessionMetaLine {
                meta: SessionMeta {
                    session_id: thread_id.into(),
                    id: thread_id,
                    forked_from_id: None,
                    parent_thread_id: None,
                    timestamp: "2026-02-26T00:00:00.000Z".to_string(),
                    cwd: PathBuf::from("/workspace"),
                    originator: "codex_cli_rs".to_string(),
                    cli_version: "0.0.0".to_string(),
                    source: SessionSource::Cli,
                    thread_source: None,
                    agent_path: None,
                    agent_nickname: None,
                    agent_role: None,
                    model_provider: Some("openai".to_string()),
                    base_instructions: None,
                    dynamic_tools: None,
                    selected_capability_roots: Vec::new(),
                    memory_mode: None,
                    history_mode: ThreadHistoryMode::Legacy,
                    multi_agent_version: None,
                    context_window: None,
                },
                git: None,
            }),
            "test-provider",
        );

        assert_eq!(metadata.model, None);
        assert_eq!(metadata.reasoning_effort, None);
        assert_eq!(metadata.history_mode, ThreadHistoryMode::Paginated);
    }

    fn metadata_for_test() -> ThreadMetadata {
        let id = ThreadId::from_string(&Uuid::from_u128(42).to_string()).expect("thread id");
        let created_at = DateTime::<Utc>::from_timestamp(1_735_689_600, 0).expect("timestamp");
        ThreadMetadata {
            id,
            rollout_path: PathBuf::from("/tmp/a.jsonl"),
            created_at,
            updated_at: created_at,
            recency_at: created_at,
            source: "cli".to_string(),
            history_mode: Default::default(),
            thread_source: None,
            agent_path: None,
            agent_nickname: None,
            agent_role: None,
            model_provider: "openai".to_string(),
            model: None,
            reasoning_effort: None,
            cwd: PathBuf::from("/tmp"),
            cli_version: "0.0.0".to_string(),
            title: String::new(),
            preview: None,
            sandbox_policy: "read-only".to_string(),
            approval_mode: "on-request".to_string(),
            tokens_used: 1,
            first_user_message: None,
            archived_at: None,
            git_sha: None,
            git_branch: None,
            git_origin_url: None,
        }
    }

    #[test]
    fn diff_fields_detects_changes() {
        let mut base = metadata_for_test();
        base.id = ThreadId::from_string(&Uuid::now_v7().to_string()).expect("thread id");
        base.title = "hello".to_string();
        let mut other = base.clone();
        other.tokens_used = 2;
        other.title = "world".to_string();
        let diffs = base.diff_fields(&other);
        assert_eq!(diffs, vec!["title", "tokens_used"]);
    }
}
