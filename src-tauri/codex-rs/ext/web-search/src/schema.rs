//! Web search 命令的 JSON Schema 生成模块。
//!
//! 该模块为 `SearchCommands` 类型生成 JSON Schema，供 Responses API 工具定义使用。
//! 生成的 schema 采用 Draft 2019-09 规范，并将所有子 schema 内联以避免引用依赖。
//! 生成时不为 `Option` 字段添加 null 类型，并保留字段元数据/描述。

use codex_api::SearchCommands;
use schemars::r#gen::SchemaSettings;
use serde_json::Map;
use serde_json::Value;

/// 为 `SearchCommands` 生成工具输入 schema。
///
/// # 返回
/// 返回精简后的 schema 对象，仅保留工具相关的顶层字段。
pub(crate) fn commands_schema() -> Value {
    let schema = SchemaSettings::draft2019_09()
        .with(|settings| {
            settings.inline_subschemas = true;
            settings.option_add_null_type = false;
        })
        .into_generator()
        .into_root_schema_for::<SearchCommands>();
    let schema = match serde_json::to_value(schema) {
        Ok(schema) => schema,
        Err(err) => panic!("search commands schema should serialize: {err}"),
    };
    let Value::Object(mut schema) = schema else {
        unreachable!("search commands schema must be an object");
    };

    // 仅提取工具定义需要的字段
    let mut tool_schema = Map::new();
    for key in [
        "properties",
        "required",
        "type",
        "additionalProperties",
        "$defs",
        "definitions",
    ] {
        if let Some(value) = schema.remove(key) {
            tool_schema.insert(key.to_string(), value);
        }
    }
    Value::Object(tool_schema)
}
