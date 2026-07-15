//! TOML 配置 layer 合并。
//!
//! 提供 `merge_toml_values` 将高优先级 layer（`overlay`）合并到低优先级
//! layer（`base`）上，`overlay` 的值优先。合并时按路径应用 key 别名规范化
//! 与网络域名规范化，确保不同 layer 中的等价 key 与等价域名能正确对齐。
//!
//! 架构位置：config layer stack 自底向上逐层调用本模块完成合并。

use crate::key_aliases::normalize_key_aliases;
use crate::key_aliases::normalized_with_key_aliases;
use codex_network_proxy::normalize_host;
use toml::Value as TomlValue;

/// 将 `overlay` 合并到 `base`，`overlay` 优先。
///
/// Table 递归合并：相同 key 继续深入，不同 key 直接插入；非 Table 类型
/// （或类型不匹配）时 `overlay` 直接覆盖 `base`。合并过程中按路径应用
/// key 别名规范化与网络域名规范化。
pub fn merge_toml_values(base: &mut TomlValue, overlay: &TomlValue) {
    merge_toml_values_at_path(base, overlay, &mut Vec::new());
}

/// 带路径的递归合并实现。
///
/// `path` 跟踪当前合并位置（点分路径），用于触发特定路径下的规范化逻辑
/// （如 `permissions.*.network.domains` 下的域名规范化）。
fn merge_toml_values_at_path(base: &mut TomlValue, overlay: &TomlValue, path: &mut Vec<String>) {
    if let TomlValue::Table(overlay_table) = overlay
        && let TomlValue::Table(base_table) = base
    {
        normalize_key_aliases(path, base_table);
        let mut overlay_table = overlay_table.clone();
        normalize_key_aliases(path, &mut overlay_table);
        if is_permission_network_domains_path(path) {
            normalize_network_domain_keys(base_table);
            normalize_network_domain_keys(&mut overlay_table);
        }

        for (key, value) in overlay_table {
            path.push(key.clone());
            if let Some(existing) = base_table.get_mut(&key) {
                merge_toml_values_at_path(existing, &value, path);
            } else {
                base_table.insert(key, normalized_with_key_aliases(&value, path));
            }
            path.pop();
        }
    } else {
        *base = normalized_with_key_aliases(overlay, path);
    }
}

/// 判断路径是否指向 `permissions.<profile>.network.domains` 表。
///
/// 该表下的 key 是网络域名 pattern，合并前需通过 `normalize_host` 规范化
/// 以避免因大小写/格式差异导致合并失败。
fn is_permission_network_domains_path(path: &[String]) -> bool {
    matches!(
        path,
        [permissions, _, network, domains]
            if permissions == "permissions" && network == "network" && domains == "domains"
    )
}

/// 就地规范化网络域名表的 key。
///
/// 取出全部 entry，对每个 key 调用 `normalize_host` 规范化后重新插入。
fn normalize_network_domain_keys(table: &mut toml::map::Map<String, TomlValue>) {
    let entries = std::mem::take(table);
    for (pattern, value) in entries {
        table.insert(normalize_host(&pattern), value);
    }
}

#[cfg(test)]
#[path = "merge_tests.rs"]
mod tests;
