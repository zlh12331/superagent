use crate::ToolDefinition;
use crate::parse_tool_input_schema;
use serde_json::Value as JsonValue;
use serde_json::json;

/// 将 MCP（Model Context Protocol）工具解析为统一的 [`ToolDefinition`]。
///
/// # 参数
/// - `tool`: MCP 工具引用
///
/// # 返回值
/// 返回解析成功的工具定义；若输入 schema 解析失败则返回 [`serde_json::Error`]。
pub fn parse_mcp_tool(tool: &rmcp::model::Tool) -> Result<ToolDefinition, serde_json::Error> {
    let mut serialized_input_schema = serde_json::Value::Object(tool.input_schema.as_ref().clone());

    // OpenAI 模型要求 schema 中必须包含 "properties" 字段。某些 MCP server
    // 会省略该字段（或设为 null），因此这里插入一个空对象以与 Agents SDK 行为保持一致。
    if let serde_json::Value::Object(obj) = &mut serialized_input_schema
        && obj.get("properties").is_none_or(serde_json::Value::is_null)
    {
        obj.insert(
            "properties".to_string(),
            serde_json::Value::Object(serde_json::Map::new()),
        );
    }

    let input_schema = parse_tool_input_schema(&serialized_input_schema)?;
    let structured_content_schema = tool
        .output_schema
        .as_ref()
        .map(|output_schema| serde_json::Value::Object(output_schema.as_ref().clone()))
        .unwrap_or_else(|| JsonValue::Object(serde_json::Map::new()));

    Ok(ToolDefinition {
        name: tool.name.to_string(),
        description: tool.description.clone().map(Into::into).unwrap_or_default(),
        input_schema,
        output_schema: Some(mcp_call_tool_result_output_schema(
            structured_content_schema,
        )),
        defer_loading: false,
    })
}

/// 构造 MCP `call_tool` 结果的输出 schema。
///
/// # 参数
/// - `structured_content_schema`: 工具返回的结构化内容 schema
///
/// # 返回值
/// 返回描述 MCP 调用结果（包含 `content`、`structuredContent`、`isError`、`_meta` 字段）的 JSON schema。
pub fn mcp_call_tool_result_output_schema(structured_content_schema: JsonValue) -> JsonValue {
    json!({
        "type": "object",
        "properties": {
            "content": {
                "type": "array",
                "items": {
                    "type": "object"
                }
            },
            "structuredContent": structured_content_schema,
            "isError": {
                "type": "boolean"
            },
            "_meta": {
                "type": "object"
            }
        },
        "required": ["content"],
        "additionalProperties": false
    })
}

#[cfg(test)]
#[path = "mcp_tool_tests.rs"]
mod tests;
