//! Hooks 模块入口。
//!
//! 该 crate 负责 Codex 的钩子（hook）系统，包括：
//! - 钩子配置加载与发现（来自配置层与插件）
//! - 命令式钩子的执行与输出解析
//! - 会话生命周期事件的分发（PreToolUse、PostToolUse、Stop 等）
//! - 输出溢出落盘（避免大输出占用模型上下文）
//! - 旧版 notify 兼容
//!
//! 对外暴露的类型主要用于构建 [`registry::Hooks`] 实例并触发各类钩子事件。

mod config_rules;
mod declarations;
mod engine;
pub(crate) mod events;
mod legacy_notify;
mod output_spill;
mod registry;
mod schema;
mod types;

use codex_protocol::protocol::HookEventName;

pub use config_rules::hook_states_from_stack;
pub use declarations::PluginHookDeclaration;
pub use declarations::plugin_hook_declarations;
pub use engine::HookListEntry;
pub use events::common::SubagentHookContext;
/// 钩子事件名称列表，与 hooks JSON 和配置文件中出现的字符串保持一致。
pub const HOOK_EVENT_NAMES: [&str; 10] = [
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "UserPromptSubmit",
    "SubagentStart",
    "SubagentStop",
    "Stop",
];

/// 在分发时会用到 matcher 字段的事件名称集合。
///
/// 其他事件即便出现在 hooks JSON 中，Codex 也会忽略其 matcher 字段，
/// 因为这些事件并不会针对某个工具、压缩触发器或会话启动来源进行分发。
pub const HOOK_EVENT_NAMES_WITH_MATCHERS: [&str; 8] = [
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "SubagentStart",
    "SubagentStop",
];

pub use events::compact::PostCompactRequest;
pub use events::compact::PreCompactOutcome;
pub use events::compact::PreCompactRequest;
pub use events::compact::StatelessHookOutcome;
pub use events::permission_request::PermissionRequestDecision;
pub use events::permission_request::PermissionRequestOutcome;
pub use events::permission_request::PermissionRequestRequest;
pub use events::post_tool_use::PostToolUseOutcome;
pub use events::post_tool_use::PostToolUseRequest;
pub use events::pre_tool_use::PreToolUseOutcome;
pub use events::pre_tool_use::PreToolUseRequest;
pub use events::session_start::SessionStartOutcome;
pub use events::session_start::SessionStartRequest;
pub use events::session_start::SessionStartSource;
pub use events::session_start::StartHookTarget;
pub use events::stop::StopHookTarget;
pub use events::stop::StopOutcome;
pub use events::stop::StopRequest;
pub use events::user_prompt_submit::UserPromptSubmitOutcome;
pub use events::user_prompt_submit::UserPromptSubmitRequest;
pub use legacy_notify::legacy_notify_json;
pub use legacy_notify::notify_hook;
pub use registry::HookListOutcome;
pub use registry::Hooks;
pub use registry::HooksConfig;
pub use registry::command_from_argv;
pub use registry::list_hooks;
pub use schema::write_schema_fixtures;
pub use types::Hook;
pub use types::HookEvent;
pub use types::HookEventAfterAgent;
pub use types::HookPayload;
pub use types::HookResponse;
pub use types::HookResult;

/// 返回用于持久化 hook-state key 的事件标签字符串。
///
/// 这些 snake_case 形式的标签用于在配置层中标识不同事件的启用状态与可信哈希。
pub fn hook_event_key_label(event_name: HookEventName) -> &'static str {
    match event_name {
        HookEventName::PreToolUse => "pre_tool_use",
        HookEventName::PermissionRequest => "permission_request",
        HookEventName::PostToolUse => "post_tool_use",
        HookEventName::PreCompact => "pre_compact",
        HookEventName::PostCompact => "post_compact",
        HookEventName::SessionStart => "session_start",
        HookEventName::UserPromptSubmit => "user_prompt_submit",
        HookEventName::SubagentStart => "subagent_start",
        HookEventName::SubagentStop => "subagent_stop",
        HookEventName::Stop => "stop",
    }
}

/// 为单个已发现的 hook handler 构造持久化配置状态 key。
///
/// 形如 `{key_source}:{event_label}:{group_index}:{handler_index}`，
/// 用于在配置层中唯一定位某个事件组下的具体 handler。
///
/// # 参数
/// - `key_source`：来源标识，通常为文件路径或插件标识
/// - `event_name`：钩子事件类型
/// - `group_index`：matcher 组索引
/// - `handler_index`：组内 handler 序号
pub fn hook_key(
    key_source: &str,
    event_name: HookEventName,
    group_index: usize,
    handler_index: usize,
) -> String {
    format!(
        "{key_source}:{}:{group_index}:{handler_index}",
        hook_event_key_label(event_name)
    )
}
