//! Skills 工具 JSON Schema 生成模块。
//!
//! 该模块为 skills 工具的输入/输出类型生成 JSON Schema，
//! 供 Responses API 工具定义使用。生成的 schema 采用 Draft 2019-09 规范，
//! 并将所有子 schema 内联以避免引用依赖。

use schemars::JsonSchema;
use schemars::r#gen::SchemaSettings;
use serde_json::Map;
use serde_json::Value;

/// 为类型 `T` 生成工具输入 schema（不为 `Option` 字段添加 null 类型）。
pub(super) fn input_schema_for<T: JsonSchema>() -> Value {
    schema_for::<T>(/*option_add_null_type*/ false)
}

/// 为类型 `T` 生成工具输出 schema（为 `Option` 字段添加 null 类型）。
pub(super) fn output_schema_for<T: JsonSchema>() -> Value {
    schema_for::<T>(/*option_add_null_type*/ true)
}

/// 为类型 `T` 生成 JSON Schema 的内部实现。
///
/// # 参数
/// - `option_add_null_type`：是否为 `Option` 字段添加 null 类型
///
/// # 返回
/// 返回精简后的 schema 对象，仅保留工具相关的顶层字段。
fn schema_for<T: JsonSchema>(option_add_null_type: bool) -> Value {
    let schema = SchemaSettings::draft2019_09()
        .with(|settings| {
            settings.inline_subschemas = true;
            settings.option_add_null_type = option_add_null_type;
        })
        .into_generator()
        .into_root_schema_for::<T>();
    let schema_value = serde_json::to_value(schema)
        .unwrap_or_else(|err| panic!("generated skill tool schema should serialize: {err}"));
    let Value::Object(mut schema_object) = schema_value else {
        unreachable!("root tool schema must be an object");
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
        if let Some(value) = schema_object.remove(key) {
            tool_schema.insert(key.to_string(), value);
        }
    }
    Value::Object(tool_schema)
}
