//! `config.toml` 的 JSON Schema 生成模块。
//!
//! 本模块基于 `schemars` 将 codex-rs 的配置类型（`ConfigToml`、
//! `RawMcpServerConfig`、feature 配置等）导出为 JSON Schema（draft-07），
//! 用于：
//! - 在 IDE 中提供配置补全与校验
//! - 生成 `config-schema.json` fixture 文件供文档与测试使用
//! - 在 UI 中渲染配置表单
//!
//! 核心函数：
//! - [`config_schema`]: 生成完整的 `config.toml` 根 schema
//! - [`features_schema`]: 生成 `[features]` 表的 schema（仅含已知 + legacy key）
//! - [`mcp_servers_schema`]: 生成 `[mcp_servers]` 表的 schema
//! - [`canonicalize`]: 对 JSON 值按键排序，生成规范形式用于指纹与对比

use crate::config_toml::ConfigToml;
use crate::types::RawMcpServerConfig;
use codex_features::FEATURES;
use codex_features::legacy_feature_keys;
use schemars::r#gen::SchemaGenerator;
use schemars::r#gen::SchemaSettings;
use schemars::schema::InstanceType;
use schemars::schema::ObjectValidation;
use schemars::schema::RootSchema;
use schemars::schema::Schema;
use schemars::schema::SchemaObject;
use schemars::schema::SubschemaValidation;
use serde_json::Map;
use serde_json::Value;
use std::path::Path;

/// 生成 `[features]` 表的 JSON Schema，仅包含已知 feature key 与 legacy key。
///
/// 每个 feature 根据其类型映射到不同的 schema：
/// - 大多数 feature 映射为 `bool`
/// - `CodeMode`、`MultiAgentV2`、`TokenBudget`、`RolloutBudget`、
///   `CurrentTimeReminder`、`NetworkProxy` 映射为带配置字段的 object
///   （通过 `FeatureToml<T>` 包装）
/// - `AppsMcpPathOverride` 使用 `removed_apps_mcp_path_override_schema`
///   生成兼容旧版的 `bool | object` 联合类型
/// - `Artifact` feature 被跳过（不暴露到 schema）
///
/// `additionalProperties` 设为 `false`，确保未知 feature key 在 IDE 中被拒绝。
pub fn features_schema(schema_gen: &mut SchemaGenerator) -> Schema {
    let mut object = SchemaObject {
        instance_type: Some(InstanceType::Object.into()),
        ..Default::default()
    };

    let mut validation = ObjectValidation::default();
    for feature in FEATURES {
        // Artifact feature 已废弃，不暴露到 schema 中。
        if feature.id == codex_features::Feature::Artifact {
            continue;
        }
        if feature.id == codex_features::Feature::CodeMode {
            validation.properties.insert(
                feature.key.to_string(),
                schema_gen.subschema_for::<codex_features::FeatureToml<
                    codex_features::CodeModeConfigToml,
                >>(),
            );
            continue;
        }
        if feature.id == codex_features::Feature::MultiAgentV2 {
            validation.properties.insert(
                feature.key.to_string(),
                schema_gen.subschema_for::<codex_features::FeatureToml<
                    codex_features::MultiAgentV2ConfigToml,
                >>(),
            );
            continue;
        }
        if feature.id == codex_features::Feature::TokenBudget {
            validation.properties.insert(
                feature.key.to_string(),
                schema_gen.subschema_for::<codex_features::FeatureToml<
                    codex_features::TokenBudgetConfigToml,
                >>(),
            );
            continue;
        }
        if feature.id == codex_features::Feature::RolloutBudget {
            validation.properties.insert(
                feature.key.to_string(),
                schema_gen.subschema_for::<codex_features::FeatureToml<
                    codex_features::RolloutBudgetConfigToml,
                >>(),
            );
            continue;
        }
        if feature.id == codex_features::Feature::CurrentTimeReminder {
            validation.properties.insert(
                feature.key.to_string(),
                schema_gen.subschema_for::<codex_features::FeatureToml<
                    codex_features::CurrentTimeReminderConfigToml,
                >>(),
            );
            continue;
        }
        if feature.id == codex_features::Feature::AppsMcpPathOverride {
            validation.properties.insert(
                feature.key.to_string(),
                removed_apps_mcp_path_override_schema(schema_gen),
            );
            continue;
        }
        if feature.id == codex_features::Feature::NetworkProxy {
            validation.properties.insert(
                feature.key.to_string(),
                schema_gen.subschema_for::<codex_features::FeatureToml<
                    codex_features::NetworkProxyConfigToml,
                >>(),
            );
            continue;
        }
        // 默认：简单布尔开关。
        validation
            .properties
            .insert(feature.key.to_string(), schema_gen.subschema_for::<bool>());
    }
    // 将 legacy feature key 也加入 schema，全部映射为 bool，
    // 以保持对旧配置文件的向前兼容。
    for legacy_key in legacy_feature_keys() {
        validation
            .properties
            .insert(legacy_key.to_string(), schema_gen.subschema_for::<bool>());
    }
    validation.additional_properties = Some(Box::new(Schema::Bool(false)));
    object.object = Some(Box::new(validation));

    Schema::Object(object)
}

/// 为已移除的 `apps_mcp_path_override` feature 生成兼容性 schema。
///
/// 该 feature 历史上支持 `bool`（简单开关）和 `{ enabled, path }`（带配置）
/// 两种形式。即使 feature 已被移除，schema 仍接受这两种形式以避免
/// 旧配置文件加载失败。运行时会忽略该值。
fn removed_apps_mcp_path_override_schema(schema_gen: &mut SchemaGenerator) -> Schema {
    let mut config_validation = ObjectValidation::default();
    config_validation
        .properties
        .insert("enabled".to_string(), schema_gen.subschema_for::<bool>());
    config_validation
        .properties
        .insert("path".to_string(), schema_gen.subschema_for::<String>());
    config_validation.additional_properties = Some(Box::new(Schema::Bool(false)));

    let config = Schema::Object(SchemaObject {
        instance_type: Some(InstanceType::Object.into()),
        object: Some(Box::new(config_validation)),
        ..Default::default()
    });
    // 使用 anyOf 表示 `bool | object` 联合类型。
    Schema::Object(SchemaObject {
        subschemas: Some(Box::new(SubschemaValidation {
            any_of: Some(vec![schema_gen.subschema_for::<bool>(), config]),
            ..Default::default()
        })),
        ..Default::default()
    })
}

/// 生成 `[mcp_servers]` 表的 JSON Schema，使用原始输入形状 `RawMcpServerConfig`。
///
/// 该表是一个 map，key 为 server 名称，value 为 server 配置。
/// `additionalProperties` 直接使用 `RawMcpServerConfig` 的 schema，
/// 允许任意 server 名称。
pub fn mcp_servers_schema(schema_gen: &mut SchemaGenerator) -> Schema {
    let mut object = SchemaObject {
        instance_type: Some(InstanceType::Object.into()),
        ..Default::default()
    };

    let validation = ObjectValidation {
        additional_properties: Some(Box::new(schema_gen.subschema_for::<RawMcpServerConfig>())),
        ..Default::default()
    };
    object.object = Some(Box::new(validation));

    Schema::Object(object)
}

/// 生成 `config.toml` 的完整 JSON Schema（draft-07）。
///
/// 使用 `SchemaSettings::draft07()` 创建生成器，并禁用
/// `option_add_null_type`（即 `Option<T>` 字段不会自动允许 `null` 值，
/// 只通过字段存在性表示可选）。
pub fn config_schema() -> RootSchema {
    SchemaSettings::draft07()
        .with(|settings| {
            settings.option_add_null_type = false;
        })
        .into_generator()
        .into_root_schema_for::<ConfigToml>()
}

/// 对 JSON 值进行规范化：递归地对所有 object 的 key 按字典序排序。
///
/// 用于生成配置 schema 的规范形式，确保不同运行或不同序列化顺序下
/// 产生的 JSON 字节序列一致，便于：
/// - 生成稳定的配置指纹
/// - 在测试中对比 schema 快照
/// - 在版本控制中减少无意义的 diff
pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by_key(|(key, _)| *key);
            let mut sorted = Map::with_capacity(map.len());
            for (key, child) in entries {
                sorted.insert(key.clone(), canonicalize(child));
            }
            Value::Object(sorted)
        }
        _ => value.clone(),
    }
}

/// 将配置 schema 渲染为格式化的 JSON 字节序列。
///
/// 流程：生成 schema → 转为 `serde_json::Value` → `canonicalize` 排序键 →
/// 序列化为 pretty JSON。返回的字节序列是确定性的，可直接用于快照测试
/// 或写入 fixture 文件。
///
/// # Errors
/// 当 schema 序列化失败时返回 `anyhow::Error`（理论上不会发生，因为
/// `RootSchema` 是可序列化类型）。
pub fn config_schema_json() -> anyhow::Result<Vec<u8>> {
    let schema = config_schema();
    let value = serde_json::to_value(schema)?;
    let value = canonicalize(&value);
    let json = serde_json::to_vec_pretty(&value)?;
    Ok(json)
}

/// 将配置 schema 写入磁盘文件。
///
/// 用于生成 `config-schema.json` fixture，供文档、IDE 配置校验
/// 和测试使用。
///
/// # 参数
/// - `out_path`: 输出文件路径
///
/// # Errors
/// 当 schema 序列化或文件写入失败时返回错误。
pub fn write_config_schema(out_path: &Path) -> anyhow::Result<()> {
    let json = config_schema_json()?;
    std::fs::write(out_path, json)?;
    Ok(())
}
