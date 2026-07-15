use std::fmt;
use std::future::Future;
use std::time::Duration;

use serde_json::Value as JsonValue;
use tokio_util::sync::CancellationToken;

/// 标识 session runtime 中的一个执行 cell。
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct CellId(String);

impl CellId {
    pub(crate) fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CellId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 为正在运行的 cell 选择下一个可观察的前沿。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ObserveMode {
    YieldAfter(Duration),
    PendingFrontier,
}

/// 一个可观察的 cell lifecycle event。
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CellEvent {
    Yielded {
        content_items: Vec<OutputItem>,
    },
    Pending {
        content_items: Vec<OutputItem>,
        pending_tool_call_ids: Vec<String>,
    },
    Completed {
        content_items: Vec<OutputItem>,
        error_text: Option<String>,
    },
    Terminated {
        content_items: Vec<OutputItem>,
    },
}

/// cell 自上次观察以来发出的 Output。
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum OutputItem {
    Text {
        text: String,
    },
    Image {
        image_url: String,
        detail: Option<ImageDetail>,
    },
}

/// output image 的请求保真度级别。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ImageDetail {
    Auto,
    Low,
    High,
    Original,
}

/// 用于创建 cell 的 Transport-neutral 输入。
///
/// 拥有该请求的 session 在接受请求时分配 cell ID。
pub(crate) struct CreateCellRequest {
    pub(crate) tool_call_id: String,
    pub(crate) enabled_tools: Vec<ToolDefinition>,
    pub(crate) source: String,
}

/// 暴露给 cell 内运行代码的 Tool metadata。
pub(crate) struct ToolDefinition {
    pub(crate) name: String,
    pub(crate) tool_name: ToolName,
    pub(crate) description: String,
    pub(crate) kind: ToolKind,
}

/// 带有可选 namespace 的 tool name。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolName {
    pub(crate) name: String,
    pub(crate) namespace: Option<String>,
}

/// tool 的 JavaScript 调用约定。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ToolKind {
    Function,
    Freeform,
}

/// 正在运行的 cell 发出的 nested tool request。
pub(crate) struct NestedToolCall {
    pub(crate) cell_id: CellId,
    pub(crate) runtime_tool_call_id: String,
    pub(crate) tool_name: ToolName,
    pub(crate) tool_kind: ToolKind,
    pub(crate) input: Option<JsonValue>,
}

/// 由 [`super::SessionRuntime`] 拥有的 cells 使用的 Host callbacks。
///
/// 实现必须遵守 cancellation tokens。`cell_closed` 在
/// runtime 停止向该 cell 路由请求之后被调用。
pub(crate) trait SessionRuntimeDelegate: Send + Sync + 'static {
    fn invoke_tool(
        &self,
        invocation: NestedToolCall,
        cancellation_token: CancellationToken,
    ) -> impl Future<Output = Result<JsonValue, String>> + Send;

    fn notify(
        &self,
        call_id: String,
        cell_id: CellId,
        text: String,
        cancellation_token: CancellationToken,
    ) -> impl Future<Output = Result<(), String>> + Send;

    fn cell_closed(&self, cell_id: &CellId);
}

/// session runtime 操作报告的失败类型。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Error {
    ShuttingDown,
    CellIdSpaceExhausted,
    DuplicateCell(CellId),
    MissingCell(CellId),
    BusyObserver(CellId),
    AlreadyTerminating(CellId),
    ClosedCell(CellId),
    Runtime(String),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ShuttingDown => formatter.write_str("code mode session is shutting down"),
            Self::CellIdSpaceExhausted => {
                formatter.write_str("code mode session exhausted its cell ID space")
            }
            Self::DuplicateCell(cell_id) => write!(formatter, "exec cell {cell_id} already exists"),
            Self::MissingCell(cell_id) => write!(formatter, "exec cell {cell_id} not found"),
            Self::BusyObserver(cell_id) => {
                write!(
                    formatter,
                    "exec cell {cell_id} already has an active observer"
                )
            }
            Self::AlreadyTerminating(cell_id) => {
                write!(formatter, "exec cell {cell_id} is already terminating")
            }
            Self::ClosedCell(cell_id) => {
                write!(formatter, "exec cell {cell_id} closed unexpectedly")
            }
            Self::Runtime(error_text) => formatter.write_str(error_text),
        }
    }
}

impl std::error::Error for Error {}
