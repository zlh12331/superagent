use crate::FunctionCallError;
use crate::ToolName;
use crate::ToolPayload;
use codex_file_system::ExecutorFileSystem;
use codex_file_system::FileSystemSandboxContext;
use codex_protocol::items::ImageGenerationItem;
use codex_protocol::items::WebSearchItem;
use codex_protocol::models::ResponseItem;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_output_truncation::TruncationPolicy;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// 调用扩展工具时可用的原始响应历史快照。
#[derive(Clone, Debug, Default)]
pub struct ConversationHistory {
    items: Arc<[ResponseItem]>,
}

impl ConversationHistory {
    /// 构造一个对话历史快照。
    ///
    /// # 参数
    /// - `items`: 历史响应条目列表
    pub fn new(items: Vec<ResponseItem>) -> Self {
        Self {
            items: items.into(),
        }
    }

    /// 获取历史响应条目切片。
    pub fn items(&self) -> &[ResponseItem] {
        &self.items
    }
}

/// 扩展工具发出可见 turn item 生命周期事件时返回的 Future。
pub type TurnItemEmissionFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// 扩展工具可发布到宿主生命周期的可见 turn item。
#[derive(Clone, Debug, PartialEq)]
pub enum ExtensionTurnItem {
    /// 网页搜索结果条目。
    WebSearch(WebSearchItem),
    /// 图像生成结果条目。
    ImageGeneration(ImageGenerationItem),
}

/// 宿主提供的扩展工具能力：发布可见 turn item。
///
/// 实现者负责将生命周期事件通过宿主常规的 item 事件管道及客户端投递流程传递。
pub trait TurnItemEmitter: Send + Sync {
    /// 发出一个可见 turn item 的开始事件。
    fn emit_started<'a>(&'a self, item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>;

    /// 发出一个已完成 turn item 的事件。
    fn emit_completed<'a>(&'a self, item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>;
}

/// 宿主拥有的、对扩展工具可见的 turn 环境摘要。
#[derive(Clone)]
pub struct ToolEnvironment {
    /// 稳定的宿主环境 ID，用于路由 executor 范围内的能力。
    pub environment_id: String,
    /// 该环境当前 turn 的有效工作目录。
    pub cwd: AbsolutePathBuf,
    /// 该环境的文件系统实现。
    pub file_system: Arc<dyn ExecutorFileSystem>,
    /// 文件系统操作所使用的沙盒上下文。
    pub file_system_sandbox_context: FileSystemSandboxContext,
}

/// 当调用方不暴露可见 item 发布能力时使用的空实现 turn item 发射器。
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopTurnItemEmitter;

impl TurnItemEmitter for NoopTurnItemEmitter {
    fn emit_started<'a>(&'a self, _item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a> {
        Box::pin(std::future::ready(()))
    }

    fn emit_completed<'a>(&'a self, _item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a> {
        Box::pin(std::future::ready(()))
    }
}

/// 一次工具调用的完整上下文，包含会话信息与执行载荷。
#[derive(Clone)]
pub struct ToolCall {
    /// 当前 turn 的 ID。
    pub turn_id: String,
    /// 本次工具调用的 ID。
    pub call_id: String,
    /// 工具名称。
    pub tool_name: ToolName,
    /// 当前模型名称。
    pub model: String,
    /// 输出截断策略。
    pub truncation_policy: TruncationPolicy,
    /// 对话历史快照。
    pub conversation_history: ConversationHistory,
    /// turn item 发射器，由宿主提供。
    pub turn_item_emitter: Arc<dyn TurnItemEmitter>,
    /// 可用的工具执行环境列表。
    pub environments: Vec<ToolEnvironment>,
    /// 工具调用载荷。
    pub payload: ToolPayload,
}

impl std::fmt::Debug for ToolCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolCall")
            .field("turn_id", &self.turn_id)
            .field("call_id", &self.call_id)
            .field("tool_name", &self.tool_name)
            .field("model", &self.model)
            .field("truncation_policy", &self.truncation_policy)
            .field("conversation_history", &self.conversation_history)
            .field("turn_item_emitter", &"<host turn item emitter>")
            .field("environment_count", &self.environments.len())
            .field("payload", &self.payload)
            .finish()
    }
}

impl ToolCall {
    /// 获取函数调用的参数字符串。
    ///
    /// # 返回值
    /// 当载荷为 `Function` 时返回参数字符串引用；否则返回 [`FunctionCallError::Fatal`]。
    pub fn function_arguments(&self) -> Result<&str, FunctionCallError> {
        match &self.payload {
            ToolPayload::Function { arguments } => Ok(arguments),
            _ => Err(FunctionCallError::Fatal(format!(
                "tool {} invoked with incompatible payload",
                self.tool_name
            ))),
        }
    }
}
