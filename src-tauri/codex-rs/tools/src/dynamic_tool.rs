use crate::ToolDefinition;
use crate::parse_tool_input_schema;
use codex_protocol::dynamic_tools::DynamicToolFunctionSpec;

/// 将动态工具函数规格解析为统一的 [`ToolDefinition`]。
///
/// # 参数
/// - `tool`: 动态工具函数规格引用
///
/// # 返回值
/// 返回解析成功的工具定义；若输入 schema 解析失败则返回序列化错误。
pub fn parse_dynamic_tool(
    tool: &DynamicToolFunctionSpec,
) -> Result<ToolDefinition, serde_json::Error> {
    Ok(ToolDefinition {
        name: tool.name.clone(),
        description: tool.description.clone(),
        input_schema: parse_tool_input_schema(&tool.input_schema)?,
        output_schema: None,
        defer_loading: tool.defer_loading,
    })
}

#[cfg(test)]
#[path = "dynamic_tool_tests.rs"]
mod tests;
