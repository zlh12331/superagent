//! Realtime prompt 组装模块。
//!
//! 为 realtime(语音对话)模式构造 backend prompt,
//! 优先级顺序为:
//! 1. 显式 config prompt(非空);
//! 2. 调用方传入的 prompt(`Some(Some(s))` 或 `Some(None)` 表示清空);
//! 3. 默认 `BACKEND_PROMPT`,其中 `{{ user_first_name }}` 占位符
//!    会被替换为当前用户名(realname 优先,fallback 至 username,
//!    再 fallback 至 `"there"`)。

use codex_prompts::BACKEND_PROMPT;
const DEFAULT_USER_FIRST_NAME: &str = "there";
const USER_FIRST_NAME_PLACEHOLDER: &str = "{{ user_first_name }}";

pub(crate) fn prepare_realtime_backend_prompt(
    prompt: Option<Option<String>>,
    config_prompt: Option<String>,
) -> String {
    if let Some(config_prompt) = config_prompt
        && !config_prompt.trim().is_empty()
    {
        return config_prompt;
    }

    match prompt {
        Some(Some(prompt)) => return prompt,
        Some(None) => return String::new(),
        None => {}
    }

    BACKEND_PROMPT
        .trim_end()
        .replace(USER_FIRST_NAME_PLACEHOLDER, &current_user_first_name())
}

fn current_user_first_name() -> String {
    [whoami::realname(), whoami::username()]
        .into_iter()
        .filter_map(|name| name.split_whitespace().next().map(str::to_string))
        .find(|name| !name.is_empty())
        .unwrap_or_else(|| DEFAULT_USER_FIRST_NAME.to_string())
}

#[cfg(test)]
mod tests {
    use super::prepare_realtime_backend_prompt;

    #[test]
    fn prepare_realtime_backend_prompt_prefers_config_override() {
        assert_eq!(
            prepare_realtime_backend_prompt(
                Some(Some("prompt from request".to_string())),
                Some("prompt from config".to_string()),
            ),
            "prompt from config"
        );
    }

    #[test]
    fn prepare_realtime_backend_prompt_uses_request_prompt() {
        assert_eq!(
            prepare_realtime_backend_prompt(
                Some(Some("prompt from request".to_string())),
                /*config_prompt*/ None,
            ),
            "prompt from request"
        );
    }

    #[test]
    fn prepare_realtime_backend_prompt_preserves_empty_request_prompt() {
        assert_eq!(
            prepare_realtime_backend_prompt(Some(Some(String::new())), /*config_prompt*/ None),
            ""
        );
        assert_eq!(
            prepare_realtime_backend_prompt(Some(None), /*config_prompt*/ None),
            ""
        );
    }

    #[test]
    fn prepare_realtime_backend_prompt_renders_default() {
        let prompt =
            prepare_realtime_backend_prompt(/*prompt*/ None, /*config_prompt*/ None);

        assert!(prompt.starts_with("## Identity, tone, and role"));
        assert!(prompt.contains("You are Codex, an OpenAI general-purpose agentic assistant"));
        assert!(prompt.contains("The user's name is "));
        assert!(!prompt.contains("{{ user_first_name }}"));
    }
}
