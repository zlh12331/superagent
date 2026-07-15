//! 跨事件复用的辅助函数与子代理上下文类型。
//!
//! 提供 matcher 校验、文本处理、序列化失败事件构造等通用能力，
//! 供各事件子模块在解析命令输出或聚合结果时复用。

use codex_protocol::protocol::HookCompletedEvent;
use codex_protocol::protocol::HookEventName;
use codex_protocol::protocol::HookOutputEntry;
use codex_protocol::protocol::HookOutputEntryKind;
use codex_protocol::protocol::HookRunStatus;
use codex_protocol::protocol::HookRunSummary;

use crate::engine::ConfiguredHandler;
use crate::engine::dispatcher;

/// 标识当前 hook 在某个线程派生的子代理内运行时的上下文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentHookContext {
    /// 子代理 ID。
    pub agent_id: String,
    /// 子代理类型。
    pub agent_type: String,
}

/// 将多个文本块用空行连接为单个字符串；空集合返回 `None`。
pub(crate) fn join_text_chunks(chunks: Vec<String>) -> Option<String> {
    if chunks.is_empty() {
        None
    } else {
        Some(chunks.join("\n\n"))
    }
}

/// 返回去除首尾空白后的字符串；若结果为空则返回 `None`。
pub(crate) fn trimmed_non_empty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 同时追加一条上下文输出条目与模型可见的附加上下文文本。
pub(crate) fn append_additional_context(
    entries: &mut Vec<HookOutputEntry>,
    additional_contexts_for_model: &mut Vec<String>,
    additional_context: String,
) {
    entries.push(HookOutputEntry {
        kind: HookOutputEntryKind::Context,
        text: additional_context.clone(),
    });
    additional_contexts_for_model.push(additional_context);
}

/// 将多组附加上下文扁平化为单个向量。
pub(crate) fn flatten_additional_contexts<'a>(
    additional_contexts: impl IntoIterator<Item = &'a [String]>,
) -> Vec<String> {
    additional_contexts
        .into_iter()
        .flat_map(|chunk| chunk.iter().cloned())
        .collect()
}

/// 为序列化失败的情况构造一组 [`HookCompletedEvent`]。
///
/// 每个 handler 对应一个状态为 Failed、duration 为 0 的事件，
/// 错误信息通过 Error 类型的输出条目传递。
pub(crate) fn serialization_failure_hook_events(
    handlers: Vec<ConfiguredHandler>,
    turn_id: Option<String>,
    error_message: String,
) -> Vec<HookCompletedEvent> {
    handlers
        .into_iter()
        .map(|handler| {
            let mut run = dispatcher::running_summary(&handler);
            run.status = HookRunStatus::Failed;
            run.completed_at = Some(run.started_at);
            run.duration_ms = Some(0);
            run.entries = vec![HookOutputEntry {
                kind: HookOutputEntryKind::Error,
                text: error_message.clone(),
            }];
            HookCompletedEvent {
                turn_id: turn_id.clone(),
                run,
            }
        })
        .collect()
}

/// 类似 [`serialization_failure_hook_events`]，但额外将 `tool_use_id` 注入到 run id 中。
pub(crate) fn serialization_failure_hook_events_for_tool_use(
    handlers: Vec<ConfiguredHandler>,
    turn_id: Option<String>,
    error_message: String,
    tool_use_id: &str,
) -> Vec<HookCompletedEvent> {
    serialization_failure_hook_events(handlers, turn_id, error_message)
        .into_iter()
        .map(|event| hook_completed_for_tool_use(event, tool_use_id))
        .collect()
}

/// 将 `tool_use_id` 追加到某个已完成事件的 run id 后面。
pub(crate) fn hook_completed_for_tool_use(
    mut event: HookCompletedEvent,
    tool_use_id: &str,
) -> HookCompletedEvent {
    event.run = hook_run_for_tool_use(event.run, tool_use_id);
    event
}

/// 将 `tool_use_id` 追加到 run id 后面，用于工具使用相关事件。
pub(crate) fn hook_run_for_tool_use(mut run: HookRunSummary, tool_use_id: &str) -> HookRunSummary {
    run.id = format!("{}:{tool_use_id}", run.id);
    run
}

/// 根据事件类型决定是否使用 matcher。
///
/// 对于不支持 matcher 的事件（UserPromptSubmit / Stop），始终返回 `None`。
pub(crate) fn matcher_pattern_for_event(
    event_name: HookEventName,
    matcher: Option<&str>,
) -> Option<&str> {
    match event_name {
        HookEventName::PreToolUse
        | HookEventName::PermissionRequest
        | HookEventName::PostToolUse
        | HookEventName::SessionStart
        | HookEventName::SubagentStart
        | HookEventName::SubagentStop
        | HookEventName::PreCompact
        | HookEventName::PostCompact => matcher,
        HookEventName::UserPromptSubmit | HookEventName::Stop => None,
    }
}

/// 校验 matcher 表达式是否合法。
///
/// 通配符与字面量 matcher 视为合法；其余当作正则表达式编译。
pub(crate) fn validate_matcher_pattern(matcher: &str) -> Result<(), regex::Error> {
    if is_match_all_matcher(matcher) || is_exact_matcher(matcher) {
        return Ok(());
    }
    regex::Regex::new(matcher).map(|_| ())
}

/// 判断输入是否匹配给定的 matcher。
///
/// - `None` 或通配符：匹配所有输入。
/// - 字面量（含 `|` 分隔）：精确匹配任一候选。
/// - 其他：作为正则表达式匹配。
pub(crate) fn matches_matcher(matcher: Option<&str>, input: Option<&str>) -> bool {
    match matcher {
        None => true,
        Some(matcher) if is_match_all_matcher(matcher) => true,
        Some(matcher) if is_exact_matcher(matcher) => input
            .map(|input| matcher.split('|').any(|candidate| candidate == input))
            .unwrap_or(false),
        Some(matcher) => input
            .and_then(|input| {
                regex::Regex::new(matcher)
                    .ok()
                    .map(|regex| regex.is_match(input))
            })
            .unwrap_or(false),
    }
}

/// 构造 matcher 校验时使用的输入候选列表，规范名优先。
pub(crate) fn matcher_inputs<'a>(
    tool_name: &'a str,
    matcher_aliases: &'a [String],
) -> Vec<&'a str> {
    // 规范名放在首位，确保 matcher 预览与执行时使用与 hook stdin
    // 序列化相同的主要身份标识。
    std::iter::once(tool_name)
        .chain(matcher_aliases.iter().map(String::as_str))
        .collect()
}

/// 判断是否为“匹配所有”的 matcher（空串或 `*`）。
fn is_match_all_matcher(matcher: &str) -> bool {
    matcher.is_empty() || matcher == "*"
}

/// 判断是否为字面量 matcher（仅含字母数字、下划线或 `|`）。
fn is_exact_matcher(matcher: &str) -> bool {
    matcher
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '|')
}

#[cfg(test)]
mod tests {
    use codex_protocol::protocol::HookEventName;
    use pretty_assertions::assert_eq;

    use super::matcher_pattern_for_event;
    use super::matches_matcher;
    use super::validate_matcher_pattern;

    #[test]
    fn matcher_omitted_matches_all_occurrences() {
        assert!(matches_matcher(/*matcher*/ None, Some("Bash")));
        assert!(matches_matcher(/*matcher*/ None, Some("Write")));
    }

    #[test]
    fn matcher_star_matches_all_occurrences() {
        assert!(matches_matcher(Some("*"), Some("Bash")));
        assert!(matches_matcher(Some("*"), Some("Edit")));
        assert_eq!(validate_matcher_pattern("*"), Ok(()));
    }

    #[test]
    fn matcher_empty_string_matches_all_occurrences() {
        assert!(matches_matcher(Some(""), Some("Bash")));
        assert!(matches_matcher(Some(""), Some("SessionStart")));
        assert_eq!(validate_matcher_pattern(""), Ok(()));
    }

    #[test]
    fn exact_matcher_supports_pipe_alternatives() {
        assert!(matches_matcher(Some("Edit|Write"), Some("Edit")));
        assert!(matches_matcher(Some("Edit|Write"), Some("Write")));
        assert!(!matches_matcher(Some("Edit|Write"), Some("Bash")));
        assert_eq!(validate_matcher_pattern("Edit|Write"), Ok(()));
    }

    #[test]
    fn literal_matcher_uses_exact_matching() {
        assert!(matches_matcher(Some("Bash"), Some("Bash")));
        assert!(!matches_matcher(Some("Bash"), Some("BashOutput")));
        assert!(matches_matcher(
            Some("mcp__memory__create_entities"),
            Some("mcp__memory__create_entities")
        ));
        assert!(!matches_matcher(
            Some("mcp__memory"),
            Some("mcp__memory__create_entities")
        ));
        assert_eq!(validate_matcher_pattern("mcp__memory"), Ok(()));
    }

    #[test]
    fn matcher_uses_regex_when_it_contains_regex_characters() {
        assert!(matches_matcher(Some("^Bash"), Some("BashOutput")));
        assert_eq!(validate_matcher_pattern("^Bash"), Ok(()));
    }

    #[test]
    fn mcp_matchers_support_regex_wildcards() {
        assert!(matches_matcher(
            Some("mcp__memory__.*"),
            Some("mcp__memory__create_entities")
        ));
        assert!(matches_matcher(
            Some("mcp__.*__write.*"),
            Some("mcp__filesystem__write_file")
        ));
        assert!(!matches_matcher(
            Some("mcp__.*__write.*"),
            Some("mcp__filesystem__read_file")
        ));
        assert_eq!(validate_matcher_pattern("mcp__memory__.*"), Ok(()));
    }

    #[test]
    fn matcher_supports_anchored_regexes() {
        assert!(matches_matcher(Some("^Bash$"), Some("Bash")));
        assert!(!matches_matcher(Some("^Bash$"), Some("BashOutput")));
        assert_eq!(validate_matcher_pattern("^Bash$"), Ok(()));
    }

    #[test]
    fn invalid_regex_is_rejected() {
        assert!(validate_matcher_pattern("[").is_err());
        assert!(!matches_matcher(Some("["), Some("Bash")));
    }

    #[test]
    fn unsupported_events_ignore_matchers() {
        assert_eq!(
            matcher_pattern_for_event(HookEventName::UserPromptSubmit, Some("^hello")),
            None
        );
        assert_eq!(
            matcher_pattern_for_event(HookEventName::Stop, Some("^done$")),
            None
        );
    }

    #[test]
    fn supported_events_keep_matchers() {
        assert_eq!(
            matcher_pattern_for_event(HookEventName::PreToolUse, Some("Bash")),
            Some("Bash")
        );
        assert_eq!(
            matcher_pattern_for_event(HookEventName::PostToolUse, Some("Edit|Write")),
            Some("Edit|Write")
        );
        assert_eq!(
            matcher_pattern_for_event(HookEventName::SessionStart, Some("startup|resume")),
            Some("startup|resume")
        );
        assert_eq!(
            matcher_pattern_for_event(HookEventName::PreCompact, Some("^auto$")),
            Some("^auto$")
        );
        assert_eq!(
            matcher_pattern_for_event(HookEventName::PostCompact, Some("manual|auto")),
            Some("manual|auto")
        );
    }
}
