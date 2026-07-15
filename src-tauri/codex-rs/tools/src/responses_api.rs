use crate::JsonSchema;
use crate::ToolDefinition;
use crate::ToolName;
use crate::parse_dynamic_tool;
use crate::parse_mcp_tool;
use codex_protocol::dynamic_tools::DynamicToolFunctionSpec;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

/// 自由格式工具，用于无固定参数 schema 的工具调用。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FreeformTool {
    /// 工具名称。
    pub name: String,
    /// 工具描述。
    pub description: String,
    /// 工具输出格式说明。
    pub format: FreeformToolFormat,
}

/// 自由格式工具的输出格式定义。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FreeformToolFormat {
    /// 格式类型，例如 `code`。
    pub r#type: String,
    /// 语法名称，例如 `python`。
    pub syntax: String,
    /// 格式的具体定义说明。
    pub definition: String,
}

/// Responses API 工具的完整定义，包括参数 schema 与可选的输出 schema。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ResponsesApiTool {
    /// 工具名称。
    pub name: String,
    /// 工具描述。
    pub description: String,
    /// TODO: 校验。当 strict 为 true 时，JSON schema、
    /// `required` 与 `additional_properties` 必须存在；`properties` 中所有字段
    /// 必须出现在 `required` 中。
    pub strict: bool,
    /// 是否延迟加载该工具，`Some(true)` 表示延迟加载。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defer_loading: Option<bool>,
    /// 工具参数的 JSON schema。
    pub parameters: JsonSchema,
    /// 工具输出 schema，仅用于内部，序列化时跳过。
    #[serde(skip)]
    pub output_schema: Option<Value>,
}

/// 可加载工具规格，可以是单个函数工具或一个命名空间。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type")]
#[allow(clippy::large_enum_variant)]
pub enum LoadableToolSpec {
    /// 单个函数工具。
    #[allow(dead_code)]
    #[serde(rename = "function")]
    Function(ResponsesApiTool),
    /// 命名空间工具集合。
    #[serde(rename = "namespace")]
    Namespace(ResponsesApiNamespace),
}

/// Responses API 命名空间，将一组相关工具聚合在一起。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ResponsesApiNamespace {
    /// 命名空间名称。
    pub name: String,
    /// 命名空间描述。
    pub description: String,
    /// 命名空间下的工具列表。
    pub tools: Vec<ResponsesApiNamespaceTool>,
}

/// 生成命名空间的默认描述文本。
///
/// # 参数
/// - `namespace_name`: 命名空间名称
///
/// # 返回值
/// 返回形如 `"Tools in the {namespace_name} namespace."` 的描述字符串。
pub fn default_namespace_description(namespace_name: &str) -> String {
    format!("Tools in the {namespace_name} namespace.")
}

/// 命名空间下的具体工具类型，目前仅支持 function。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type")]
pub enum ResponsesApiNamespaceTool {
    /// 函数类型工具。
    #[serde(rename = "function")]
    Function(ResponsesApiTool),
}

/// 将动态工具规格转换为 Responses API 工具。
///
/// # 参数
/// - `tool`: 动态工具函数规格引用
///
/// # 返回值
/// 返回转换后的 [`ResponsesApiTool`]；若解析失败则返回 [`serde_json::Error`]。
pub fn dynamic_tool_to_responses_api_tool(
    tool: &DynamicToolFunctionSpec,
) -> Result<ResponsesApiTool, serde_json::Error> {
    Ok(tool_definition_to_responses_api_tool(parse_dynamic_tool(
        tool,
    )?))
}

/// 合并同名的命名空间工具，将工具列表聚合到一起。
///
/// # 参数
/// - `specs`: 可加载工具规格迭代器
///
/// # 返回值
/// 返回合并后的工具规格列表，其中同名命名空间仅出现一次。
pub fn coalesce_loadable_tool_specs(
    specs: impl IntoIterator<Item = LoadableToolSpec>,
) -> Vec<LoadableToolSpec> {
    let mut coalesced_specs = Vec::new();
    for spec in specs {
        match spec {
            LoadableToolSpec::Function(tool) => {
                coalesced_specs.push(LoadableToolSpec::Function(tool));
            }
            LoadableToolSpec::Namespace(mut namespace) => {
                if let Some(existing_namespace) =
                    coalesced_specs.iter_mut().find_map(|spec| match spec {
                        LoadableToolSpec::Namespace(existing_namespace)
                            if existing_namespace.name == namespace.name =>
                        {
                            Some(existing_namespace)
                        }
                        LoadableToolSpec::Function(_) | LoadableToolSpec::Namespace(_) => None,
                    })
                {
                    existing_namespace.tools.append(&mut namespace.tools);
                } else {
                    coalesced_specs.push(LoadableToolSpec::Namespace(namespace));
                }
            }
        }
    }
    coalesced_specs
}

/// 将 MCP 工具转换为 Responses API 工具。
///
/// # 参数
/// - `tool_name`: 目标工具名（用于重命名）
/// - `tool`: MCP 工具引用
///
/// # 返回值
/// 返回转换后的 [`ResponsesApiTool`]；若解析失败则返回 [`serde_json::Error`]。
pub fn mcp_tool_to_responses_api_tool(
    tool_name: &ToolName,
    tool: &rmcp::model::Tool,
) -> Result<ResponsesApiTool, serde_json::Error> {
    Ok(tool_definition_to_responses_api_tool(
        parse_mcp_tool(tool)?.renamed(tool_name.name.clone()),
    ))
}

/// 将 MCP 工具转换为延迟加载的 Responses API 工具。
///
/// # 参数
/// - `tool_name`: 目标工具名（用于重命名）
/// - `tool`: MCP 工具引用
///
/// # 返回值
/// 返回标记为延迟加载的 [`ResponsesApiTool`]；若解析失败则返回 [`serde_json::Error`]。
pub fn mcp_tool_to_deferred_responses_api_tool(
    tool_name: &ToolName,
    tool: &rmcp::model::Tool,
) -> Result<ResponsesApiTool, serde_json::Error> {
    Ok(tool_definition_to_responses_api_tool(
        parse_mcp_tool(tool)?
            .renamed(tool_name.name.clone())
            .into_deferred(),
    ))
}

/// 将统一的 [`ToolDefinition`] 转换为 Responses API 工具。
///
/// # 参数
/// - `tool_definition`: 统一的工具定义
///
/// # 返回值
/// 返回对应的 [`ResponsesApiTool`]，默认 `strict` 为 `false`。
pub fn tool_definition_to_responses_api_tool(tool_definition: ToolDefinition) -> ResponsesApiTool {
    ResponsesApiTool {
        name: tool_definition.name,
        description: tool_definition.description,
        strict: false,
        defer_loading: tool_definition.defer_loading.then_some(true),
        parameters: tool_definition.input_schema,
        output_schema: tool_definition.output_schema,
    }
}

#[cfg(test)]
#[path = "responses_api_tests.rs"]
mod tests;
