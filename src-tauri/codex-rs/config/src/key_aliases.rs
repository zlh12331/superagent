//! 配置 key 别名规范化。
//!
//! 处理 TOML 配置中已废弃 key 到规范 key 的重命名。当配置 schema 演进时，
//! 旧 key 通过别名映射到新 key，保证向后兼容而无需用户立即迁移配置。
//!
//! 当前别名：
//! - `memories.no_memories_if_mcp_or_web_search` → `memories.disable_on_external_context`

use toml::Value as TomlValue;
use toml::map::Map as TomlMap;

/// 单条 key 别名定义。
///
/// 描述在 `table_path` 指定的 TOML 表内，从 `legacy_key` 重命名为
/// `canonical_key` 的映射关系。
#[derive(Debug, Clone, Copy)]
struct ConfigKeyAlias {
    /// 别名所在的 TOML 表路径（如 `["memories"]`）。
    table_path: &'static [&'static str],
    /// 已废弃的旧 key 名。
    legacy_key: &'static str,
    /// 规范的新 key 名。
    canonical_key: &'static str,
}

/// 全部已知的 key 别名表。
const CONFIG_KEY_ALIASES: &[ConfigKeyAlias] = &[ConfigKeyAlias {
    table_path: &["memories"],
    legacy_key: "no_memories_if_mcp_or_web_search",
    canonical_key: "disable_on_external_context",
}];

/// 在指定路径的 TOML 表内就地应用 key 别名重命名。
///
/// 遍历别名表，若 `path` 匹配某别名的 `table_path` 且 `table` 中存在旧 key，
/// 则把旧 key 的值移动到新 key（新 key 已存在时不覆盖）。
pub(crate) fn normalize_key_aliases(path: &[String], table: &mut TomlMap<String, TomlValue>) {
    for alias in CONFIG_KEY_ALIASES {
        if path
            .iter()
            .map(String::as_str)
            .eq(alias.table_path.iter().copied())
            && let Some(value) = table.remove(alias.legacy_key)
        {
            table
                .entry(alias.canonical_key.to_string())
                .or_insert(value);
        }
    }
}

/// 递归返回应用 key 别名规范化后的 TOML 值副本。
///
/// Table 会克隆并在每个表层级应用 `normalize_key_aliases`；Array 元素递归
/// 处理；标量原样克隆。`path` 跟踪当前递归位置以匹配别名定义的表路径。
pub(crate) fn normalized_with_key_aliases(value: &TomlValue, path: &[String]) -> TomlValue {
    match value {
        TomlValue::Table(table) => {
            let mut normalized = TomlMap::new();
            for (key, child) in table {
                let mut child_path = path.to_vec();
                child_path.push(key.clone());
                normalized.insert(key.clone(), normalized_with_key_aliases(child, &child_path));
            }
            normalize_key_aliases(path, &mut normalized);
            TomlValue::Table(normalized)
        }
        TomlValue::Array(items) => TomlValue::Array(
            items
                .iter()
                .map(|item| normalized_with_key_aliases(item, path))
                .collect(),
        ),
        _ => value.clone(),
    }
}
