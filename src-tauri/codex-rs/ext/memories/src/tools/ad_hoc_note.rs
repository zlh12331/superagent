//! Add ad-hoc note 工具模块。
//!
//! 该模块实现 `memories/add_ad_hoc_note` 工具，用于创建临时记忆笔记。

use codex_extension_api::JsonToolOutput;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolName;
use codex_extension_api::ToolSpec;
use codex_otel::MetricsClient;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use crate::ADD_AD_HOC_NOTE_TOOL_NAME;
use crate::backend::AddAdHocMemoryNoteRequest;
use crate::backend::AddAdHocMemoryNoteResponse;
use crate::backend::MemoriesBackend;
use crate::metrics::record_tool_call;

use super::backend_error_to_function_call;
use super::memory_function_tool;
use super::memory_tool_name;
use super::parse_args;

/// `add_ad_hoc_note` 工具的输入参数。
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddAdHocNoteArgs {
    /// 笔记文件名，格式为 `YYYY-MM-DDTHH-MM-SS-<slug>.md`。
    /// slug 仅允许小写字母、数字和连字符。
    #[schemars(
        length(min = 24, max = 128),
        regex(pattern = r"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,79}\.md$")
    )]
    filename: String,
    /// 要写入的 Markdown 笔记内容（原样存储）。
    #[schemars(length(min = 1))]
    note: String,
}

/// `add_ad_hoc_note` 工具执行器。
#[derive(Clone)]
pub(super) struct AddAdHocNoteTool<B> {
    /// memories backend
    pub(super) backend: B,
    /// 遥测客户端
    pub(super) metrics_client: Option<MetricsClient>,
}

impl<B> ToolExecutor<ToolCall> for AddAdHocNoteTool<B>
where
    B: MemoriesBackend,
{
    fn tool_name(&self) -> ToolName {
        memory_tool_name(ADD_AD_HOC_NOTE_TOOL_NAME)
    }

    fn spec(&self) -> ToolSpec {
        memory_function_tool::<AddAdHocNoteArgs, AddAdHocMemoryNoteResponse>(
            ADD_AD_HOC_NOTE_TOOL_NAME,
            "Create one append-only ad-hoc memory note after the user explicitly asks Codex to remember, forget, or update something.",
        )
    }

    fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_> {
        Box::pin(self.handle_call(call))
    }
}

impl<B> AddAdHocNoteTool<B>
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
        let args: AddAdHocNoteArgs = parse_args(&call)?;
        let response = backend
            .add_ad_hoc_note(AddAdHocMemoryNoteRequest {
                filename: args.filename,
                note: args.note,
            })
            .await;
        record_tool_call(
            self.metrics_client.as_ref(),
            ADD_AD_HOC_NOTE_TOOL_NAME,
            "ad_hoc_notes",
            response.is_ok(),
            "not_applicable",
        );
        let response = response.map_err(backend_error_to_function_call)?;
        Ok(Box::new(JsonToolOutput::new(json!(response))))
    }
}
