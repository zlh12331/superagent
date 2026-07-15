//! Memories 工具模块入口。
//!
//! 该模块将 memories backend 操作封装为 Responses API 工具，
//! 并提供工具名称构造、spec 生成和参数解析的公共辅助函数。

use std::sync::Arc;

use codex_extension_api::FunctionCallError;
use codex_extension_api::ResponsesApiTool;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolName;
use codex_extension_api::ToolSpec;
use codex_extension_api::parse_tool_input_schema;
use codex_otel::MetricsClient;
use codex_tools::ResponsesApiNamespace;
use codex_tools::ResponsesApiNamespaceTool;
use codex_tools::default_namespace_description;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::MEMORY_TOOLS_NAMESPACE;
use crate::backend::MemoriesBackend;
use crate::backend::MemoriesBackendError;
use crate::schema;

// 工具实现子模块
mod ad_hoc_note;
mod list;
mod read;
mod search;

/// 创建 memories 工具集。
///
/// 返回 4 个工具执行器：`add_ad_hoc_note`、`list`、`read`、`search`。
///
/// # 泛型
/// - `B`：memories backend 类型
///
/// # 参数
/// - `backend`：memories backend 实例
/// - `metrics_client`：遥测客户端（可选）
pub(crate) fn memory_tools<B>(
    backend: B,
    metrics_client: Option<MetricsClient>,
) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
where
    B: MemoriesBackend,
{
    vec![
        Arc::new(ad_hoc_note::AddAdHocNoteTool {
            backend: backend.clone(),
            metrics_client: metrics_client.clone(),
        }),
        Arc::new(list::ListTool {
            backend: backend.clone(),
            metrics_client: metrics_client.clone(),
        }),
        Arc::new(read::ReadTool {
            backend: backend.clone(),
            metrics_client: metrics_client.clone(),
        }),
        Arc::new(search::SearchTool {
            backend,
            metrics_client,
        }),
    ]
}

/// 构造 memories 命名空间下的工具名称。
pub(super) fn memory_tool_name(name: &str) -> ToolName {
    ToolName::namespaced(MEMORY_TOOLS_NAMESPACE, name)
}

/// 构造 memories 命名空间下的函数工具 spec。
///
/// # 泛型
/// - `I`：输入参数类型（需实现 `JsonSchema`）
/// - `O`：输出响应类型（需实现 `JsonSchema`）
///
/// # 参数
/// - `name`：工具名称
/// - `description`：工具描述
pub(super) fn memory_function_tool<I: JsonSchema, O: JsonSchema>(
    name: &str,
    description: &str,
) -> ToolSpec {
    let tool = ResponsesApiTool {
        name: name.to_string(),
        description: description.to_string(),
        strict: false,
        defer_loading: None,
        parameters: parse_tool_input_schema(&schema::input_schema_for::<I>())
            .unwrap_or_else(|err| panic!("generated input schema for {name} should parse: {err}")),
        output_schema: Some(schema::output_schema_for::<O>()),
    };

    ToolSpec::Namespace(ResponsesApiNamespace {
        name: MEMORY_TOOLS_NAMESPACE.to_string(),
        description: default_namespace_description(MEMORY_TOOLS_NAMESPACE),
        tools: vec![ResponsesApiNamespaceTool::Function(tool)],
    })
}

/// 解析工具调用参数。
///
/// # 泛型
/// - `T`：目标反序列化类型
///
/// # 参数
/// - `call`：工具调用
///
/// # 返回
/// 成功时返回解析后的参数；失败时返回 `FunctionCallError`。
fn parse_args<T: for<'de> Deserialize<'de>>(call: &ToolCall) -> Result<T, FunctionCallError> {
    let arguments = call.function_arguments()?;
    let value = if arguments.trim().is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(arguments)
            .map_err(|err| FunctionCallError::RespondToModel(err.to_string()))?
    };
    serde_json::from_value(value).map_err(|err| FunctionCallError::RespondToModel(err.to_string()))
}

/// 将请求的 max_results 限制在 `[1, max]` 范围内，未指定时使用默认值。
fn clamp_max_results(requested: Option<usize>, default: usize, max: usize) -> usize {
    requested.unwrap_or(default).clamp(1, max)
}

/// 将 backend 错误转换为工具调用错误。
///
/// 用户可见的错误（如路径无效、文件未找到）转换为 `RespondToModel`，
/// 系统级错误（如 IO 错误）转换为 `Fatal`。
fn backend_error_to_function_call(err: MemoriesBackendError) -> FunctionCallError {
    match err {
        MemoriesBackendError::InvalidPath { .. }
        | MemoriesBackendError::InvalidCursor { .. }
        | MemoriesBackendError::InvalidFilename { .. }
        | MemoriesBackendError::NotFound { .. }
        | MemoriesBackendError::InvalidLineOffset
        | MemoriesBackendError::InvalidMaxLines
        | MemoriesBackendError::LineOffsetExceedsFileLength
        | MemoriesBackendError::NotFile { .. }
        | MemoriesBackendError::EmptyQuery
        | MemoriesBackendError::EmptyAdHocNote
        | MemoriesBackendError::AdHocNoteAlreadyExists { .. }
        | MemoriesBackendError::InvalidMatchWindow => {
            FunctionCallError::RespondToModel(err.to_string())
        }
        MemoriesBackendError::Io(_) => FunctionCallError::Fatal(err.to_string()),
    }
}
