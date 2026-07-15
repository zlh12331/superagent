//! 插件 hook 声明（declarations）聚合。
//!
//! 与运行时状态无关，仅描述插件 bundle 声明了哪些 hook handler，
//! 用于 UI 列表等需要枚举持久化 key 的场景。

use codex_plugin::PluginHookSource;
use codex_protocol::protocol::HookEventName;

/// 单个插件 hook handler 的最小声明信息。
///
/// 仅包含持久化 key 和事件类型，不携带任何运行时状态（如启用状态或可信状态）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginHookDeclaration {
    /// 与配置层中持久化 key 一致的标识符。
    pub key: String,
    /// 该 handler 对应的钩子事件类型。
    pub event_name: HookEventName,
}

/// 列出插件 bundle 声明的 hook handler，不投影任何运行时状态。
///
/// 会遍历所有来源，按 matcher 组展开为扁平的声明列表，
/// 用于 UI 或外部工具展示已声明但未运行的 handler。
///
/// # 参数
/// - `hook_sources`：插件提供的 hook 来源集合
///
/// # 返回
/// 包含每个声明 handler 元数据的列表，顺序与声明顺序一致。
pub fn plugin_hook_declarations(hook_sources: &[PluginHookSource]) -> Vec<PluginHookDeclaration> {
    let mut declarations = Vec::new();

    for source in hook_sources {
        let key_source = plugin_hook_key_source(
            source.plugin_id.as_key().as_str(),
            source.source_relative_path.as_str(),
        );
        for (event_name, groups) in source.hooks.clone().into_matcher_groups() {
            for (group_index, group) in groups.iter().enumerate() {
                for (handler_index, _) in group.hooks.iter().enumerate() {
                    declarations.push(PluginHookDeclaration {
                        key: crate::hook_key(&key_source, event_name, group_index, handler_index),
                        event_name,
                    });
                }
            }
        }
    }

    declarations
}

/// 构造插件 hook 来源的 key 前缀，由插件 id 与源相对路径拼接而成。
pub(crate) fn plugin_hook_key_source(plugin_id: &str, source_relative_path: &str) -> String {
    format!("{plugin_id}:{source_relative_path}")
}

#[cfg(test)]
mod tests {
    use codex_config::HookEventsToml;
    use codex_config::HookHandlerConfig;
    use codex_config::MatcherGroup;
    use codex_plugin::PluginId;
    use codex_utils_absolute_path::test_support::PathBufExt;
    use codex_utils_absolute_path::test_support::test_path_buf;
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn lists_declared_plugin_handlers_with_persisted_hook_keys() {
        let plugin_root = test_path_buf("/tmp/plugin").abs();
        let source_path = plugin_root.join("hooks/hooks.json");
        let declarations = plugin_hook_declarations(&[PluginHookSource {
            plugin_id: PluginId::parse("demo@test").expect("plugin id"),
            plugin_root: plugin_root.clone(),
            plugin_data_root: plugin_root.join("data"),
            source_path,
            source_relative_path: "hooks/hooks.json".to_string(),
            hooks: HookEventsToml {
                pre_tool_use: vec![MatcherGroup {
                    matcher: None,
                    hooks: vec![
                        HookHandlerConfig::Prompt {},
                        HookHandlerConfig::Command {
                            command: "echo hi".to_string(),
                            command_windows: None,
                            timeout_sec: None,
                            r#async: false,
                            status_message: None,
                        },
                    ],
                }],
                session_start: vec![MatcherGroup {
                    matcher: None,
                    hooks: vec![HookHandlerConfig::Agent {}],
                }],
                ..Default::default()
            },
        }]);

        assert_eq!(
            declarations,
            vec![
                PluginHookDeclaration {
                    key: "demo@test:hooks/hooks.json:pre_tool_use:0:0".to_string(),
                    event_name: HookEventName::PreToolUse,
                },
                PluginHookDeclaration {
                    key: "demo@test:hooks/hooks.json:pre_tool_use:0:1".to_string(),
                    event_name: HookEventName::PreToolUse,
                },
                PluginHookDeclaration {
                    key: "demo@test:hooks/hooks.json:session_start:0:0".to_string(),
                    event_name: HookEventName::SessionStart,
                },
            ]
        );
    }
}
