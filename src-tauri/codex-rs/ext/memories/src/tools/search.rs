//! Search 工具模块。
//!
//! 该模块实现 `memories/search` 工具，在 memory 文件中搜索子串匹配。

use codex_extension_api::JsonToolOutput;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolName;
use codex_extension_api::ToolSpec;
use codex_otel::MetricsClient;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::DEFAULT_SEARCH_MAX_RESULTS;
use crate::MAX_SEARCH_RESULTS;
use crate::SEARCH_TOOL_NAME;
use crate::backend::MemoriesBackend;
use crate::backend::SearchMatchMode;
use crate::backend::SearchMemoriesRequest;
use crate::backend::SearchMemoriesResponse;
use crate::metrics::record_tool_call;
use crate::metrics::scope_from_optional_path;
use crate::metrics::truncated_tag;

use super::backend_error_to_function_call;
use super::clamp_max_results;
use super::memory_function_tool;
use super::memory_tool_name;
use super::parse_args;

/// `search` 工具的输入参数。
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    /// 搜索查询列表（至少 1 个）
    #[schemars(length(min = 1))]
    queries: Vec<String>,
    /// 匹配模式（默认为 `Any`）
    match_mode: Option<SearchMatchMode>,
    /// 搜索范围路径（`None` 表示全部）
    path: Option<String>,
    /// 分页游标
    cursor: Option<String>,
    /// 上下文行数（默认为 0）
    #[schemars(range(min = 0))]
    context_lines: Option<usize>,
    /// 是否区分大小写（默认为 `true`）
    case_sensitive: Option<bool>,
    /// 是否归一化（默认为 `false`）
    normalized: Option<bool>,
    /// 最大返回结果数（最小为 1）
    #[schemars(range(min = 1))]
    max_results: Option<usize>,
}

/// `search` 工具执行器。
#[derive(Clone)]
pub(super) struct SearchTool<B> {
    /// memories backend
    pub(super) backend: B,
    /// 遥测客户端
    pub(super) metrics_client: Option<MetricsClient>,
}

impl<B> ToolExecutor<ToolCall> for SearchTool<B>
where
    B: MemoriesBackend,
{
    fn tool_name(&self) -> ToolName {
        memory_tool_name(SEARCH_TOOL_NAME)
    }

    fn spec(&self) -> ToolSpec {
        memory_function_tool::<SearchArgs, SearchMemoriesResponse>(
            SEARCH_TOOL_NAME,
            "Search Codex memory files for substring matches, optionally normalizing separators or requiring all query substrings on the same line or within a line window.",
        )
    }

    fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_> {
        Box::pin(self.handle_call(call))
    }
}

impl<B> SearchTool<B>
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
        let args: SearchArgs = parse_args(&call)?;
        let scope = scope_from_optional_path(args.path.as_deref(), "all");
        let response = backend.search(args.into_request()).await;
        record_tool_call(
            self.metrics_client.as_ref(),
            SEARCH_TOOL_NAME,
            scope,
            response.is_ok(),
            truncated_tag(response.as_ref().ok().map(|response| response.truncated)),
        );
        let response = response.map_err(backend_error_to_function_call)?;
        Ok(Box::new(JsonToolOutput::new(json!(response))))
    }
}

impl SearchArgs {
    /// 将工具参数转换为 backend 请求。
    ///
    /// 为可选字段填充默认值：
    /// - `match_mode`：`Any`
    /// - `context_lines`：0
    /// - `case_sensitive`：`true`
    /// - `normalized`：`false`
    fn into_request(self) -> SearchMemoriesRequest {
        SearchMemoriesRequest {
            queries: self.queries,
            match_mode: self.match_mode.unwrap_or(SearchMatchMode::Any),
            path: self.path,
            cursor: self.cursor,
            context_lines: self.context_lines.unwrap_or(0),
            case_sensitive: self.case_sensitive.unwrap_or(true),
            normalized: self.normalized.unwrap_or(false),
            max_results: clamp_max_results(
                self.max_results,
                DEFAULT_SEARCH_MAX_RESULTS,
                MAX_SEARCH_RESULTS,
            ),
        }
    }
}
