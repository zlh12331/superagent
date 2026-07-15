//! 从配置层中聚合 hook 启用与可信哈希状态。
//!
//! 仅 user 与 session-flags 层允许覆盖用户偏好；project、managed 和 plugin
//! 层可以发现 hook，但不允许写入用户 hook 状态，避免不可信来源篡改启用状态。

use std::collections::HashMap;

use codex_config::ConfigLayerSource;
use codex_config::ConfigLayerStack;
use codex_config::ConfigLayerStackOrdering;
use codex_config::HookStateToml;
use codex_config::TomlValue;

/// 从允许覆盖用户偏好的配置层中聚合有效的 hook 状态。
///
/// 此函数仅读取 user 与 session-flags 层（包括被禁用的层），
/// 与 skills 配置的行为保持一致。project、managed 和 plugin 层
/// 可以发现 hook，但不能写入用户 hook 状态。
///
/// # 参数
/// - `config_layer_stack`：可选的配置层栈引用
///
/// # 返回
/// 以持久化 key 为索引的 hook 状态映射；若栈为空则返回空 map。
pub fn hook_states_from_stack(
    config_layer_stack: Option<&ConfigLayerStack>,
) -> HashMap<String, HookStateToml> {
    let Some(config_layer_stack) = config_layer_stack else {
        return HashMap::new();
    };

    let mut states: HashMap<String, HookStateToml> = HashMap::new();
    for layer in config_layer_stack.get_layers(
        ConfigLayerStackOrdering::LowestPrecedenceFirst,
        /*include_disabled*/ true,
    ) {
        if !matches!(
            layer.name,
            ConfigLayerSource::User { .. } | ConfigLayerSource::SessionFlags
        ) {
            continue;
        }

        let Some(state_value) = layer
            .config
            .get("hooks")
            .and_then(|hooks| hooks.get("state"))
        else {
            continue;
        };
        let TomlValue::Table(state_by_key) = state_value else {
            continue;
        };

        for (key, state_value) in state_by_key {
            let state: HookStateToml = match state_value.clone().try_into() {
                Ok(state) => state,
                Err(_) => {
                    continue;
                }
            };
            let key = key.trim();
            if key.is_empty() {
                continue;
            }
            // 后续层按字段覆盖，避免之后单独写入某个 hook 状态时
            // 意外清除已有的启用状态覆盖。
            let effective_state = states.entry(key.to_string()).or_default();
            if let Some(enabled) = state.enabled {
                effective_state.enabled = Some(enabled);
            }
            if let Some(trusted_hash) = state.trusted_hash {
                effective_state.trusted_hash = Some(trusted_hash);
            }
        }
    }

    states
}

#[cfg(test)]
mod tests {
    use codex_config::ConfigLayerEntry;
    use codex_config::TomlValue;
    use codex_utils_absolute_path::test_support::PathBufExt;
    use codex_utils_absolute_path::test_support::test_path_buf;
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn hook_states_from_stack_respects_layer_precedence() {
        let key = "file:/tmp/hooks.json:pre_tool_use:0:0";
        let stack = ConfigLayerStack::new(
            vec![
                ConfigLayerEntry::new(
                    ConfigLayerSource::User {
                        file: test_path_buf("/tmp/config.toml").abs(),
                        profile: None,
                    },
                    config_with_hook_override(key, Some(/*enabled*/ false)),
                ),
                ConfigLayerEntry::new(
                    ConfigLayerSource::SessionFlags,
                    config_with_hook_override(key, Some(/*enabled*/ true)),
                ),
            ],
            Default::default(),
            Default::default(),
        )
        .expect("config layer stack");

        assert_eq!(
            hook_states_from_stack(Some(&stack)),
            HashMap::from([(
                key.to_string(),
                HookStateToml {
                    enabled: Some(true),
                    trusted_hash: None,
                },
            )])
        );
    }

    #[test]
    fn hook_states_from_stack_merges_fields_across_layers() {
        let key = "file:/tmp/hooks.json:pre_tool_use:0:0";
        let stack = ConfigLayerStack::new(
            vec![
                ConfigLayerEntry::new(
                    ConfigLayerSource::User {
                        file: test_path_buf("/tmp/config.toml").abs(),
                        profile: None,
                    },
                    config_with_hook_state(
                        key,
                        HookStateToml {
                            enabled: Some(/*enabled*/ false),
                            trusted_hash: None,
                        },
                    ),
                ),
                ConfigLayerEntry::new(
                    ConfigLayerSource::SessionFlags,
                    config_with_hook_state(
                        key,
                        HookStateToml {
                            enabled: None,
                            trusted_hash: Some("sha256:trusted".to_string()),
                        },
                    ),
                ),
            ],
            Default::default(),
            Default::default(),
        )
        .expect("config layer stack");

        assert_eq!(
            hook_states_from_stack(Some(&stack)),
            HashMap::from([(
                key.to_string(),
                HookStateToml {
                    enabled: Some(false),
                    trusted_hash: Some("sha256:trusted".to_string()),
                },
            )])
        );
    }

    #[test]
    fn hook_states_from_stack_ignores_malformed_hook_events() {
        let key = "file:/tmp/hooks.json:pre_tool_use:0:0";
        let config: TomlValue = serde_json::from_value(serde_json::json!({
            "hooks": {
                "state": {
                    (key): {
                        "enabled": false,
                    },
                },
                "SessionStart": "not a matcher list",
            },
        }))
        .expect("config TOML should deserialize");
        let stack = ConfigLayerStack::new(
            vec![ConfigLayerEntry::new(
                ConfigLayerSource::User {
                    file: test_path_buf("/tmp/config.toml").abs(),
                    profile: None,
                },
                config,
            )],
            Default::default(),
            Default::default(),
        )
        .expect("config layer stack");

        assert_eq!(
            hook_states_from_stack(Some(&stack)),
            HashMap::from([(
                key.to_string(),
                HookStateToml {
                    enabled: Some(false),
                    trusted_hash: None,
                },
            )])
        );
    }

    #[test]
    fn hook_states_from_stack_ignores_malformed_state_entries() {
        let key = "file:/tmp/hooks.json:pre_tool_use:0:0";
        let config: TomlValue = serde_json::from_value(serde_json::json!({
            "hooks": {
                "state": {
                    (key): {
                        "enabled": false,
                    },
                    "malformed": {
                        "enabled": "not a bool",
                    },
                },
            },
        }))
        .expect("config TOML should deserialize");
        let stack = ConfigLayerStack::new(
            vec![ConfigLayerEntry::new(
                ConfigLayerSource::User {
                    file: test_path_buf("/tmp/config.toml").abs(),
                    profile: None,
                },
                config,
            )],
            Default::default(),
            Default::default(),
        )
        .expect("config layer stack");

        assert_eq!(
            hook_states_from_stack(Some(&stack)),
            HashMap::from([(
                key.to_string(),
                HookStateToml {
                    enabled: Some(false),
                    trusted_hash: None,
                },
            )])
        );
    }

    fn config_with_hook_override(key: &str, enabled: Option<bool>) -> TomlValue {
        config_with_hook_state(
            key,
            HookStateToml {
                enabled,
                trusted_hash: None,
            },
        )
    }

    fn config_with_hook_state(key: &str, state: HookStateToml) -> TomlValue {
        let hook_state = serde_json::to_value(state).expect("hook state should serialize");
        serde_json::from_value(serde_json::json!({
            "hooks": {
                "state": {
                    (key): hook_state,
                },
            },
        }))
        .expect("config TOML should deserialize")
    }
}
