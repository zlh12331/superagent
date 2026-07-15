//! TOML 配置指纹生成。
//!
//! 提供 TOML 配置树的稳定版本指纹（`sha256:<hex>`），用于检测配置内容
//! 是否发生变化（例如 layer 合并后比对指纹以决定是否需要重新加载）。
//!
//! 指纹基于 canonical JSON 序列化：将 TOML 转 JSON 后对 object 的 key
//! 递归排序，再序列化为字节流并计算 SHA-256，确保不同 key 顺序的等价
//! 配置产生相同指纹。

use crate::ConfigLayerMetadata;
use serde_json::Value as JsonValue;
use sha2::Digest;
use sha2::Sha256;
use std::collections::HashMap;
use toml::Value as TomlValue;

/// 递归记录 TOML 树中每个叶子节点的来源（layer 元信息）。
///
/// 遍历 TOML 值树，将每个标量叶子的"点分路径"（如 `a.b.0.c`）映射到
/// 其所属 layer 的 `ConfigLayerMetadata`。Table 的 key 直接追加到路径，
/// Array 的元素以数字索引追加。空路径（根节点本身）不记录。
///
/// # 参数
/// - `value`: TOML 值树
/// - `meta`: 当前 layer 的元信息
/// - `path`: 当前递归路径（按引用传递以避免重复分配）
/// - `origins`: 输出的路径 → 元信息映射
pub(super) fn record_origins(
    value: &TomlValue,
    meta: &ConfigLayerMetadata,
    path: &mut Vec<String>,
    origins: &mut HashMap<String, ConfigLayerMetadata>,
) {
    match value {
        TomlValue::Table(table) => {
            for (key, val) in table {
                path.push(key.clone());
                record_origins(val, meta, path, origins);
                path.pop();
            }
        }
        TomlValue::Array(items) => {
            for (idx, item) in (0_i32..).zip(items.iter()) {
                path.push(idx.to_string());
                record_origins(item, meta, path, origins);
                path.pop();
            }
        }
        _ => {
            if !path.is_empty() {
                origins.insert(path.join("."), meta.clone());
            }
        }
    }
}

/// 计算 TOML 值的稳定版本指纹，返回 `sha256:<hex>` 格式字符串。
///
/// 流程：TOML → JSON → canonical JSON（key 递归排序）→ 字节序列 → SHA-256。
/// 任何序列化失败都会退化为空字节流，从而产生空输入的指纹而非 panic。
pub fn version_for_toml(value: &TomlValue) -> String {
    let json = serde_json::to_value(value).unwrap_or(JsonValue::Null);
    let canonical = canonical_json(&json);
    let serialized = serde_json::to_vec(&canonical).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(serialized);
    let hash = hasher.finalize();
    let hex = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hex}")
}

/// 将 JSON 值规范化为 key 递归排序的等价形式。
///
/// Object 的 key 按字典序排序后重建；Array 与标量原样保留（Array 元素
/// 仍递归规范化）。排序确保不同插入顺序的等价对象产生相同序列化输出。
fn canonical_json(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(map) => {
            let mut sorted = serde_json::Map::new();
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(val) = map.get(&key) {
                    sorted.insert(key, canonical_json(val));
                }
            }
            JsonValue::Object(sorted)
        }
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}
