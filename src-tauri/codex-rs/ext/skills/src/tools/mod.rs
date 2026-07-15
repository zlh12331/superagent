//! Skills 工具模块入口。
//!
//! 该模块定义了 skills 扩展对外暴露的两个工具：
//! - `skills/list`：列出指定 authority 拥有的可用 skills
//! - `skills/read`：读取指定 skill 的 resource 内容
//!
//! 工具以 Responses API namespace tool 形式暴露，使用 `skills` 作为 namespace。
//! 工具的输入/输出 schema 通过 `schemars` 自动生成。
//!
//! 安全限制：
//! - handle（package 和 resource 标识）最大 2048 字节
//! - handle 不允许为空或包含控制字符

use std::sync::Arc;

use codex_extension_api::FunctionCallError;
use codex_extension_api::JsonToolOutput;
use codex_extension_api::ResponsesApiTool;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolName;
use codex_extension_api::ToolOutput;
use codex_extension_api::ToolSpec;
use codex_extension_api::parse_tool_input_schema;
use codex_mcp::CODEX_APPS_MCP_SERVER_NAME;
use codex_mcp::McpResourceClient;
use codex_tools::ResponsesApiNamespace;
use codex_tools::ResponsesApiNamespaceTool;
use codex_tools::default_namespace_description;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::catalog::SkillAuthority;
use crate::catalog::SkillCatalog;
use crate::catalog::SkillSourceKind;
use crate::provider::SkillListQuery;
use crate::sources::SkillProviders;
use crate::state::SkillsThreadState;

mod list;
mod read;
mod schema;

/// skills 工具的 namespace 名称
const SKILLS_NAMESPACE: &str = "skills";
/// handle（package 和 resource 标识）的最大字节数
const MAX_HANDLE_BYTES: usize = 2_048;

/// 创建 skills 工具集合。
///
/// 返回 `skills/list` 和 `skills/read` 两个工具的 `ToolExecutor` 实现，
/// 共享同一个 `SkillToolContext`。
pub(crate) fn skill_tools(
    providers: SkillProviders,
    mcp_resources: Option<Arc<McpResourceClient>>,
    thread_state: Arc<SkillsThreadState>,
) -> Vec<Arc<dyn ToolExecutor<ToolCall>>> {
    let context = SkillToolContext {
        providers,
        mcp_resources,
        thread_state,
    };
    vec![
        Arc::new(list::ListTool {
            context: context.clone(),
        }),
        Arc::new(read::ReadTool { context }),
    ]
}

/// skills 工具的共享上下文。
///
/// 持有 provider 集合、MCP 资源客户端和 thread 级状态，
/// 供 `list` 和 `read` 工具共享使用。
#[derive(Clone)]
struct SkillToolContext {
    /// skill provider 集合
    providers: SkillProviders,
    /// MCP 资源客户端（用于 orchestrator skills）
    mcp_resources: Option<Arc<McpResourceClient>>,
    /// thread 级状态（含缓存）
    thread_state: Arc<SkillsThreadState>,
}

impl SkillToolContext {
    /// 获取指定 authority 的 catalog 快照。
    ///
    /// 当前仅支持 orchestrator authority，通过 thread 级缓存避免重复发现。
    async fn catalog(&self, turn_id: &str, authority: SkillToolAuthority) -> SkillCatalog {
        match authority {
            SkillToolAuthority::Orchestrator => {
                self.thread_state
                    .orchestrator_catalog_snapshot(
                        self.mcp_resources.as_deref(),
                        self.providers.list_orchestrator_for_turn(SkillListQuery {
                            turn_id: turn_id.to_string(),
                            executor_roots: Vec::new(),
                            host_snapshot: None,
                            include_host_skills: false,
                            include_bundled_skills: false,
                            include_orchestrator_skills: true,
                            mcp_resources: self.mcp_resources.clone(),
                        }),
                    )
                    .await
            }
        }
    }
}

/// 工具输入/输出中的 authority 枚举。
///
/// 当前仅支持 orchestrator，序列化为 `{"kind": "orchestrator"}` 格式。
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SkillToolAuthority {
    Orchestrator,
}

impl SkillToolAuthority {
    /// 从 `SkillAuthority` 转换为工具 authority。
    ///
    /// 仅接受 orchestrator 且 server 名为 codex-apps 的 authority。
    fn from_authority(authority: &SkillAuthority) -> Option<Self> {
        if authority
            != &SkillAuthority::new(SkillSourceKind::Orchestrator, CODEX_APPS_MCP_SERVER_NAME)
        {
            return None;
        }
        Some(Self::Orchestrator)
    }

    /// 转换为 `SkillAuthority`。
    fn into_authority(self) -> SkillAuthority {
        match self {
            Self::Orchestrator => {
                SkillAuthority::new(SkillSourceKind::Orchestrator, CODEX_APPS_MCP_SERVER_NAME)
            }
        }
    }
}

/// 生成 namespaced 的工具名称。
fn skill_tool_name(name: &str) -> ToolName {
    ToolName::namespaced(SKILLS_NAMESPACE, name)
}

/// 创建 skills namespace 下的 function tool 规格。
///
/// # 参数
/// - `name`：工具名称（不含 namespace 前缀）
/// - `description`：工具描述
///
/// # 泛型参数
/// - `I`：输入参数类型，需实现 `JsonSchema`
/// - `O`：输出类型，需实现 `JsonSchema`
fn skill_function_tool<I: JsonSchema, O: JsonSchema>(name: &str, description: &str) -> ToolSpec {
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
        name: SKILLS_NAMESPACE.to_string(),
        description: default_namespace_description(SKILLS_NAMESPACE),
        tools: vec![ResponsesApiNamespaceTool::Function(tool)],
    })
}

/// 解析工具调用参数。
///
/// 空参数视为空对象，非空参数通过 JSON 反序列化。
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

/// 验证 handle 值（package 或 resource 标识）。
///
/// handle 必须非空、不超过最大字节数、且不包含控制字符。
fn validate_handle(name: &str, value: &str, max_bytes: usize) -> Result<(), FunctionCallError> {
    if is_bounded_handle(value, max_bytes) {
        return Ok(());
    }

    Err(FunctionCallError::RespondToModel(format!(
        "{name} must be non-empty, contain no control characters, and be at most {max_bytes} bytes"
    )))
}

/// 检查 handle 值是否满足边界约束。
fn is_bounded_handle(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

/// 将序列化值包装为外部 JSON 工具输出。
///
/// 标记为 `with_external_context()` 表示输出内容为外部上下文（不参与模型推理缓存）。
fn external_json_output<T: Serialize>(value: &T) -> Result<Box<dyn ToolOutput>, FunctionCallError> {
    let value = serde_json::to_value(value).map_err(|err| {
        FunctionCallError::Fatal(format!("failed to serialize tool output: {err}"))
    })?;
    Ok(Box::new(JsonToolOutput::new(value).with_external_context()))
}
