//! List 工具模块。
//!
//! 该模块实现 `memories/list` 工具，列出 memories store 中的文件和目录。

use codex_extension_api::JsonToolOutput;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolName;
use codex_extension_api::ToolSpec;
use codex_otel::MetricsClient;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::DEFAULT_LIST_MAX_RESULTS;
use crate::LIST_TOOL_NAME;
use crate::MAX_LIST_RESULTS;
use crate::backend::ListMemoriesRequest;
use crate::backend::ListMemoriesResponse;
use crate::backend::MemoriesBackend;
use crate::metrics::record_tool_call;
use crate::metrics::scope_from_optional_path;
use crate::metrics::truncated_tag;

use super::backend_error_to_function_call;
use super::clamp_max_results;
use super::memory_function_tool;
use super::memory_tool_name;
use super::parse_args;

/// `list` 工具的输入参数。
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    /// 相对路径（`None` 表示根目录）
    path: Option<String>,
    /// 分页游标
    cursor: Option<String>,
    /// 最大返回结果数（最小为 1）
    #[schemars(range(min = 1))]
    max_results: Option<usize>,
}

/// `list` 工具执行器。
#[derive(Clone)]
pub(super) struct ListTool<B> {
    /// memories backend
    pub(super) backend: B,
    /// 遥测客户端
    pub(super) metrics_client: Option<MetricsClient>,
}

impl<B> ToolExecutor<ToolCall> for ListTool<B>
where
    B: MemoriesBackend,
{
    fn tool_name(&self) -> ToolName {
        memory_tool_name(LIST_TOOL_NAME)
    }

    fn spec(&self) -> ToolSpec {
        memory_function_tool::<ListArgs, ListMemoriesResponse>(
            LIST_TOOL_NAME,
            "List immediate files and directories under a path in the Codex memories store.",
        )
    }

    fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_> {
        Box::pin(self.handle_call(call))
    }
}

impl<B> ListTool<B>
where
    B: MemoriesBackend,
{
    /// 处理工具调用：解析参数、调用 backend、记录指标。
    async fn handle_call(
        &self,
        call: ToolCall,
    ) -> Result<Box<dyn codex_extension_api::ToolOutput>, codex_extension_api::FunctionCallError>
    {
        let backend = self.backend.clone();
        let args: ListArgs = parse_args(&call)?;
        let scope = scope_from_optional_path(args.path.as_deref(), "root");
        let response = backend
            .list(ListMemoriesRequest {
                path: args.path,
                cursor: args.cursor,
                max_results: clamp_max_results(
                    args.max_results,
                    DEFAULT_LIST_MAX_RESULTS,
                    MAX_LIST_RESULTS,
                ),
            })
            .await;
        record_tool_call(
            self.metrics_client.as_ref(),
            LIST_TOOL_NAME,
            scope,
            response.is_ok(),
            truncated_tag(response.as_ref().ok().map(|response| response.truncated)),
        );
        let response = response.map_err(backend_error_to_function_call)?;
        Ok(Box::new(JsonToolOutput::new(json!(response))))
    }
}
