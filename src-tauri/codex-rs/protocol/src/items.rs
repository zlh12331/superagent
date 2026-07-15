//! Turn item 类型定义。
//!
//! [`TurnItem`] 是一次对话 turn 中产生的各种条目的统一枚举，涵盖用户消息、
//! Agent 消息、命令执行、MCP tool 调用、文件变更、图像生成等。每个变体对应
//! 一个具体的 Item 结构体，携带该条目的完整状态信息。
//!
//! 本模块同时提供将 Item 转换为旧版 [`EventMsg`] 的辅助方法，便于在过渡期
//! 同时支持新旧协议。

use crate::AgentPath;
use crate::ThreadId;
use crate::dynamic_tools::DynamicToolCallOutputContentItem;
use crate::mcp::CallToolResult;
use crate::memory_citation::MemoryCitation;
use crate::models::ContentItem;
use crate::models::ImageDetail;
use crate::models::MessagePhase;
use crate::models::ResponseItem;
use crate::models::WebSearchAction;
use crate::openai_models::ReasoningEffort as ReasoningEffortConfig;
use crate::parse_command::ParsedCommand;
use crate::protocol::AgentMessageEvent;
use crate::protocol::AgentReasoningEvent;
use crate::protocol::AgentReasoningRawContentEvent;
use crate::protocol::AgentStatus;
use crate::protocol::CollabAgentRef;
use crate::protocol::ContextCompactedEvent;
use crate::protocol::EventMsg;
use crate::protocol::ExecCommandSource;
use crate::protocol::FileChange;
use crate::protocol::ImageGenerationEndEvent;
use crate::protocol::McpInvocation;
use crate::protocol::McpToolCallBeginEvent;
use crate::protocol::McpToolCallEndEvent;
use crate::protocol::PatchApplyBeginEvent;
use crate::protocol::PatchApplyEndEvent;
use crate::protocol::PatchApplyStatus;
use crate::protocol::SubAgentActivityKind;
use crate::protocol::UserMessageEvent;
use crate::protocol::ViewImageToolCallEvent;
use crate::protocol::WebSearchEndEvent;
use crate::user_input::ByteRange;
use crate::user_input::TextElement;
use crate::user_input::UserInput;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use quick_xml::de::from_str as from_xml_str;
use quick_xml::se::to_string as to_xml_string;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use ts_rs::TS;

/// 一次 turn 中产生的条目类型。
///
/// 作为 turn-item 流的统一载体，每个变体表示一种条目（用户消息、Agent 消息、
/// 命令执行、MCP 调用等）。客户端通过 `type` tag 区分并渲染对应 UI。
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
#[serde(tag = "type")]
#[ts(tag = "type")]
pub enum TurnItem {
    /// 用户输入的消息。
    UserMessage(UserMessageItem),
    /// hook 注入的提示词片段。
    HookPrompt(HookPromptItem),
    /// Agent 生成的消息。
    AgentMessage(AgentMessageItem),
    /// Agent 生成的计划文本。
    Plan(PlanItem),
    /// Agent 的推理过程摘要。
    Reasoning(ReasoningItem),
    /// 命令执行条目（含状态与输出）。
    CommandExecution(CommandExecutionItem),
    /// 动态 tool 调用条目。
    DynamicToolCall(DynamicToolCallItem),
    /// 协作 Agent tool 调用条目。
    CollabAgentToolCall(CollabAgentToolCallItem),
    /// 子 Agent 活动条目。
    SubAgentActivity(SubAgentActivityItem),
    /// 网络搜索条目。
    WebSearch(WebSearchItem),
    /// 图像查看条目。
    ImageView(ImageViewItem),
    /// 睡眠等待条目。
    Sleep(SleepItem),
    /// 图像生成条目。
    ImageGeneration(ImageGenerationItem),
    /// 文件变更（补丁应用）条目。
    FileChange(FileChangeItem),
    /// MCP tool 调用条目。
    McpToolCall(McpToolCallItem),
    /// 上下文压缩条目。
    ContextCompaction(ContextCompactionItem),
}

/// 用户消息条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct UserMessageItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 关联的客户端 ID（多客户端场景下使用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_id: Option<String>,
    /// 消息内容列表（文本、图像等混合输入）。
    pub content: Vec<UserInput>,
}

/// hook 注入的提示词条目，由一个或多个片段组成。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
pub struct HookPromptItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 提示词片段列表。
    pub fragments: Vec<HookPromptFragment>,
}

/// 单个 hook 提示词片段，关联到具体的 hook 运行实例。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct HookPromptFragment {
    /// 片段文本内容。
    pub text: String,
    /// 关联的 hook 运行 ID。
    pub hook_run_id: String,
}

/// `hook_prompt` XML 元素的序列化 / 反序列化中间结构。
///
/// 用于将 [`HookPromptFragment`] 与 `quick-xml` 互通：`@hook_run_id` 作为属性，
/// `$text` 作为元素文本内容。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename = "hook_prompt")]
struct HookPromptXml {
    #[serde(rename = "@hook_run_id")]
    hook_run_id: String,
    #[serde(rename = "$text")]
    text: String,
}

/// Agent 消息内容类型。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
#[serde(tag = "type")]
#[ts(tag = "type")]
pub enum AgentMessageContent {
    /// 文本内容。
    Text { text: String },
}

/// Agent 生成的消息载荷，用于 turn-item 流。
///
/// `phase` 为可选字段，因为并非所有 provider / model 都会输出它。消费方应在
/// 存在时使用，缺省时保持旧版完成语义。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct AgentMessageItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 消息内容列表。
    pub content: Vec<AgentMessageContent>,
    /// 可选的阶段元数据，来自 `ResponseItem::Message`。
    ///
    /// 当前用于 TUI 渲染，区分 turn 中途的评论与最终回答，避免状态指示器抖动。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub phase: Option<MessagePhase>,
    /// 可选的 memory citation 信息。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub memory_citation: Option<MemoryCitation>,
}

/// Agent 生成的计划条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct PlanItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 计划文本内容。
    pub text: String,
}

/// Agent 推理过程条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct ReasoningItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 推理摘要文本列表（按顺序）。
    pub summary_text: Vec<String>,
    /// 原始推理内容（仅在开启 `show_raw_agent_reasoning` 时使用）。
    #[serde(default)]
    pub raw_content: Vec<String>,
}

/// 命令执行状态。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandExecutionStatus {
    /// 执行中。
    InProgress,
    /// 已完成。
    Completed,
    /// 执行失败。
    Failed,
    /// 被用户拒绝。
    Declined,
}

/// 命令执行条目，携带命令、状态与输出信息。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq)]
pub struct CommandExecutionItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 关联的进程 ID（若适用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub process_id: Option<String>,
    /// 命令 token 序列。
    pub command: Vec<String>,
    /// 工作目录。
    pub cwd: PathUri,
    /// 解析后的命令结构。
    pub parsed_cmd: Vec<ParsedCommand>,
    /// 命令来源（shell、unified exec 等）。
    pub source: ExecCommandSource,
    /// 交互式输入内容（若命令接受用户输入）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub interaction_input: Option<String>,
    /// 执行状态。
    pub status: CommandExecutionStatus,
    /// 标准输出内容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stdout: Option<String>,
    /// 标准错误内容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stderr: Option<String>,
    /// 聚合输出（stdout + stderr 合并）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub aggregated_output: Option<String>,
    /// 退出码。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exit_code: Option<i32>,
    /// 执行耗时（ISO 8601 duration 字符串）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "string", optional)]
    pub duration: Option<Duration>,
    /// 格式化后的输出（供 UI 展示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub formatted_output: Option<String>,
}

/// 动态 tool 调用状态。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DynamicToolCallStatus {
    /// 调用中。
    InProgress,
    /// 已完成。
    Completed,
    /// 调用失败。
    Failed,
}

/// 动态 tool 调用条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq)]
pub struct DynamicToolCallItem {
    /// 条目唯一 ID。
    pub id: String,
    /// tool 命名空间（可选）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub namespace: Option<String>,
    /// tool 名称。
    pub tool: String,
    /// 调用参数（JSON 值）。
    pub arguments: serde_json::Value,
    /// 调用状态。
    pub status: DynamicToolCallStatus,
    /// 输出内容项列表。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub content_items: Option<Vec<DynamicToolCallOutputContentItem>>,
    /// 是否成功。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub success: Option<bool>,
    /// 错误信息。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    /// 调用耗时（ISO 8601 duration 字符串）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "string", optional)]
    pub duration: Option<Duration>,
}

/// 协作 Agent tool 类型。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CollabAgentTool {
    /// 创建 Agent。
    SpawnAgent,
    /// 发送输入。
    SendInput,
    /// 恢复 Agent。
    ResumeAgent,
    /// 等待。
    Wait,
    /// 关闭 Agent。
    CloseAgent,
}

/// 协作 Agent tool 调用状态。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CollabAgentToolCallStatus {
    /// 调用中。
    InProgress,
    /// 已完成。
    Completed,
    /// 调用失败。
    Failed,
}

/// 协作 Agent tool 调用条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq)]
pub struct CollabAgentToolCallItem {
    /// 条目唯一 ID。
    pub id: String,
    /// tool 类型。
    pub tool: CollabAgentTool,
    /// 调用状态。
    pub status: CollabAgentToolCallStatus,
    /// 发送方 thread ID。
    pub sender_thread_id: ThreadId,
    /// 接收方 thread ID 列表。
    #[serde(default)]
    pub receiver_thread_ids: Vec<ThreadId>,
    /// 接收方 Agent 引用列表。
    #[serde(default)]
    pub receiver_agents: Vec<CollabAgentRef>,
    /// 可选的提示词。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt: Option<String>,
    /// 可选的模型名称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// 可选的推理力度配置。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reasoning_effort: Option<ReasoningEffortConfig>,
    /// 各 Agent 的状态映射。
    #[serde(default)]
    pub agents_states: HashMap<ThreadId, AgentStatus>,
}

/// 子 Agent 活动条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
pub struct SubAgentActivityItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 活动类型。
    pub kind: SubAgentActivityKind,
    /// 子 Agent 的 thread ID。
    pub agent_thread_id: ThreadId,
    /// 子 Agent 的路径。
    pub agent_path: AgentPath,
}

/// 网络搜索条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq)]
pub struct WebSearchItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 搜索查询字符串。
    pub query: String,
    /// 搜索动作。
    pub action: WebSearchAction,
}

/// 图像查看条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq)]
pub struct ImageViewItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 在所选执行环境中解析后的路径。
    ///
    /// 此核心协议类型不直接暴露在 app-server API 中；app-server 在其边界处
    /// 将路径转换为 `LegacyAppPathString`。
    pub path: PathUri,
}

/// 睡眠等待条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
pub struct SleepItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 睡眠时长（毫秒）。
    pub duration_ms: u64,
}

/// 图像生成条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq)]
pub struct ImageGenerationItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 生成状态字符串。
    pub status: String,
    /// 修订后的提示词（若 model 返回）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub revised_prompt: Option<String>,
    /// 生成结果（URL 或 base64 数据）。
    pub result: String,
    /// 保存到本地的路径（若已保存）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub saved_path: Option<AbsolutePathBuf>,
}

/// 文件变更条目（补丁应用）。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq)]
pub struct FileChangeItem {
    /// 条目唯一 ID。
    pub id: String,
    /// 文件变更映射（路径 → 变更内容）。
    pub changes: HashMap<PathBuf, FileChange>,
    /// 补丁应用状态。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<PatchApplyStatus>,
    /// 是否自动审批通过。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_approved: Option<bool>,
    /// 命令标准输出。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stdout: Option<String>,
    /// 命令标准错误。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stderr: Option<String>,
}

/// MCP tool 调用条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct McpToolCallItem {
    /// 条目唯一 ID。
    pub id: String,
    /// MCP server 名称。
    pub server: String,
    /// tool 名称。
    pub tool: String,
    /// 调用参数（JSON 值）。
    pub arguments: serde_json::Value,
    /// 关联的 connector ID（若适用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub connector_id: Option<String>,
    /// MCP app resource URI。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mcp_app_resource_uri: Option<String>,
    /// 关联的 link ID。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link_id: Option<String>,
    /// app 名称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub app_name: Option<String>,
    /// template ID。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template_id: Option<String>,
    /// 动作名称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub action_name: Option<String>,
    /// plugin ID。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plugin_id: Option<String>,
    /// 调用状态。
    pub status: McpToolCallStatus,
    /// 调用结果（成功时）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<CallToolResult>,
    /// 调用错误（失败时）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<McpToolCallError>,
    /// 调用耗时（ISO 8601 duration 字符串）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "string", optional)]
    pub duration: Option<Duration>,
}

/// MCP tool 调用状态。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum McpToolCallStatus {
    /// 调用中。
    InProgress,
    /// 已完成。
    Completed,
    /// 调用失败。
    Failed,
}

/// MCP tool 调用错误信息。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct McpToolCallError {
    /// 错误消息。
    pub message: String,
}

/// 上下文压缩条目。
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct ContextCompactionItem {
    /// 条目唯一 ID。
    pub id: String,
}

impl ContextCompactionItem {
    /// 创建一个新的上下文压缩条目，自动生成 UUID。
    pub fn new() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// 转换为旧版 `ContextCompacted` 事件。
    pub fn as_legacy_event(&self) -> EventMsg {
        EventMsg::ContextCompacted(ContextCompactedEvent {})
    }
}

impl Default for ContextCompactionItem {
    fn default() -> Self {
        Self::new()
    }
}

impl UserMessageItem {
    /// 创建一个新的用户消息条目，自动生成 UUID。
    pub fn new(content: &[UserInput]) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            client_id: None,
            content: content.to_vec(),
        }
    }

    /// 转换为旧版 `UserMessage` 事件。
    ///
    /// 旧版用户消息事件只将文本输入拼接到 `message` 字段，并将 text element
    /// 的字节范围重新基于拼接后的文本计算。
    pub fn as_legacy_event(&self) -> EventMsg {
        // 旧版用户消息事件只将文本输入拼接到 `message` 字段，
        // 并将 text element 的字节范围重新基于拼接后的文本计算。
        EventMsg::UserMessage(UserMessageEvent {
            client_id: self.client_id.clone(),
            message: self.message(),
            images: Some(self.image_urls()),
            image_details: self.image_details(),
            local_images: self.local_image_paths(),
            local_image_details: self.local_image_details(),
            text_elements: self.text_elements(),
        })
    }

    /// 将所有文本输入拼接为单一字符串，非文本输入被忽略。
    pub fn message(&self) -> String {
        self.content
            .iter()
            .map(|c| match c {
                UserInput::Text { text, .. } => text.clone(),
                _ => String::new(),
            })
            .collect::<Vec<String>>()
            .join("")
    }

    /// 收集所有 text element，将相对范围转换为基于拼接后文本的绝对范围。
    pub fn text_elements(&self) -> Vec<TextElement> {
        let mut out = Vec::new();
        let mut offset = 0usize;
        for input in &self.content {
            if let UserInput::Text {
                text,
                text_elements,
                ..
            } = input
            {
                // text element 的范围相对于各自的文本块；此处累加偏移量，
                // 使其与 `message()` 返回的拼接文本对齐。
                for elem in text_elements {
                    let byte_range = ByteRange {
                        start: offset + elem.byte_range.start,
                        end: offset + elem.byte_range.end,
                    };
                    out.push(TextElement::new(
                        byte_range,
                        elem.placeholder(text).map(str::to_string),
                    ));
                }
                offset += text.len();
            }
        }
        out
    }

    /// 收集所有远程图像 URL。
    pub fn image_urls(&self) -> Vec<String> {
        self.content
            .iter()
            .filter_map(|c| match c {
                UserInput::Image { image_url, .. } => Some(image_url.clone()),
                _ => None,
            })
            .collect()
    }

    /// 收集所有远程图像的 detail 配置，去除尾部默认值。
    pub fn image_details(&self) -> Vec<Option<ImageDetail>> {
        trim_trailing_default_image_details(
            self.content
                .iter()
                .filter_map(|c| match c {
                    UserInput::Image { detail, .. } => Some(*detail),
                    _ => None,
                })
                .collect(),
        )
    }

    /// 收集所有本地图像路径。
    pub fn local_image_paths(&self) -> Vec<std::path::PathBuf> {
        self.content
            .iter()
            .filter_map(|c| match c {
                UserInput::LocalImage { path, .. } => Some(path.clone()),
                _ => None,
            })
            .collect()
    }

    /// 收集所有本地图像的 detail 配置，去除尾部默认值。
    pub fn local_image_details(&self) -> Vec<Option<ImageDetail>> {
        trim_trailing_default_image_details(
            self.content
                .iter()
                .filter_map(|c| match c {
                    UserInput::LocalImage { detail, .. } => Some(*detail),
                    _ => None,
                })
                .collect(),
        )
    }
}

/// 去除尾部连续的 `None` 默认图像 detail，减少序列化体积。
fn trim_trailing_default_image_details(
    mut details: Vec<Option<ImageDetail>>,
) -> Vec<Option<ImageDetail>> {
    while matches!(details.last(), Some(None)) {
        details.pop();
    }
    details
}

impl HookPromptItem {
    /// 由片段列表构造 [`HookPromptItem`]，`id` 为 `None` 时自动生成 UUID。
    pub fn from_fragments(id: Option<&String>, fragments: Vec<HookPromptFragment>) -> Self {
        Self {
            id: id
                .cloned()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            fragments,
        }
    }
}

impl HookPromptFragment {
    /// 由单个 hook 的文本和运行 ID 构造 [`HookPromptFragment`]。
    pub fn from_single_hook(text: impl Into<String>, hook_run_id: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            hook_run_id: hook_run_id.into(),
        }
    }
}

/// 将 hook 提示词片段列表序列化为 [`ResponseItem::Message`]。
///
/// 每个 fragment 会被编码为 XML 形式的 `ContentItem::InputText`，跳过
/// `hook_run_id` 为空白的片段。若所有片段均被跳过，返回 `None`。
pub fn build_hook_prompt_message(fragments: &[HookPromptFragment]) -> Option<ResponseItem> {
    let content = fragments
        .iter()
        .filter(|fragment| !fragment.hook_run_id.trim().is_empty())
        .filter_map(|fragment| {
            serialize_hook_prompt_fragment(&fragment.text, &fragment.hook_run_id)
                .map(|text| ContentItem::InputText { text })
        })
        .collect::<Vec<_>>();

    if content.is_empty() {
        return None;
    }

    Some(ResponseItem::Message {
        id: Some(uuid::Uuid::new_v4().to_string()),
        role: "user".to_string(),
        content,
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    })
}

/// 从消息内容项中解析出 [`HookPromptItem`]。
///
/// 每个 `ContentItem::InputText` 会被尝试解析为 hook fragment。任一非文本项
/// 或解析失败会导致整体返回 `None`。若解析出的片段列表为空也返回 `None`。
pub fn parse_hook_prompt_message(
    id: Option<&String>,
    content: &[ContentItem],
) -> Option<HookPromptItem> {
    let fragments = content
        .iter()
        .map(|content_item| {
            let ContentItem::InputText { text } = content_item else {
                return None;
            };
            parse_hook_prompt_fragment(text)
        })
        .collect::<Option<Vec<_>>>()?;

    if fragments.is_empty() {
        return None;
    }

    Some(HookPromptItem::from_fragments(id, fragments))
}

/// 从单个 XML 文本中解析出 [`HookPromptFragment`]。
///
/// 文本需为 `<hook_prompt hook_run_id="...">text</hook_prompt>` 形式。
/// `hook_run_id` 为空白时返回 `None`。
pub fn parse_hook_prompt_fragment(text: &str) -> Option<HookPromptFragment> {
    let trimmed = text.trim();
    let HookPromptXml { text, hook_run_id } = from_xml_str::<HookPromptXml>(trimmed).ok()?;
    if hook_run_id.trim().is_empty() {
        return None;
    }

    Some(HookPromptFragment { text, hook_run_id })
}

/// 将单个 hook fragment 序列化为 XML 字符串。
///
/// `hook_run_id` 为空白时返回 `None`。
fn serialize_hook_prompt_fragment(text: &str, hook_run_id: &str) -> Option<String> {
    if hook_run_id.trim().is_empty() {
        return None;
    }
    to_xml_string(&HookPromptXml {
        text: text.to_string(),
        hook_run_id: hook_run_id.to_string(),
    })
    .ok()
}

impl AgentMessageItem {
    /// 创建一个新的 Agent 消息条目，自动生成 UUID，`phase` 和 `memory_citation` 默认为 `None`。
    pub fn new(content: &[AgentMessageContent]) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            content: content.to_vec(),
            phase: None,
            memory_citation: None,
        }
    }

    /// 将每个内容项转换为旧版 `AgentMessage` 事件。
    pub fn as_legacy_events(&self) -> Vec<EventMsg> {
        self.content
            .iter()
            .map(|c| match c {
                AgentMessageContent::Text { text } => EventMsg::AgentMessage(AgentMessageEvent {
                    message: text.clone(),
                    phase: self.phase.clone(),
                    memory_citation: self.memory_citation.clone(),
                }),
            })
            .collect()
    }
}

impl ReasoningItem {
    /// 将推理摘要与原始内容转换为旧版事件列表。
    ///
    /// `show_raw_agent_reasoning` 为真时，额外追加 `AgentReasoningRawContent` 事件。
    pub fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg> {
        let mut events = Vec::new();
        for summary in &self.summary_text {
            events.push(EventMsg::AgentReasoning(AgentReasoningEvent {
                text: summary.clone(),
            }));
        }

        if show_raw_agent_reasoning {
            for entry in &self.raw_content {
                events.push(EventMsg::AgentReasoningRawContent(
                    AgentReasoningRawContentEvent {
                        text: entry.clone(),
                    },
                ));
            }
        }

        events
    }
}

impl WebSearchItem {
    /// 转换为旧版 `WebSearchEnd` 事件。
    pub fn as_legacy_event(&self) -> EventMsg {
        EventMsg::WebSearchEnd(WebSearchEndEvent {
            call_id: self.id.clone(),
            query: self.query.clone(),
            action: self.action.clone(),
        })
    }
}

impl ImageGenerationItem {
    /// 转换为旧版 `ImageGenerationEnd` 事件。
    pub fn as_legacy_event(&self) -> EventMsg {
        EventMsg::ImageGenerationEnd(ImageGenerationEndEvent {
            call_id: self.id.clone(),
            status: self.status.clone(),
            revised_prompt: self.revised_prompt.clone(),
            result: self.result.clone(),
            saved_path: self.saved_path.clone(),
        })
    }
}

impl FileChangeItem {
    /// 转换为旧版 `PatchApplyBegin` 事件。
    pub fn as_legacy_begin_event(&self, turn_id: String) -> EventMsg {
        EventMsg::PatchApplyBegin(PatchApplyBeginEvent {
            call_id: self.id.clone(),
            turn_id,
            auto_approved: self.auto_approved.unwrap_or(false),
            changes: self.changes.clone(),
        })
    }

    /// 转换为旧版 `PatchApplyEnd` 事件。
    ///
    /// 当 `status` 为 `None`（尚未结束）时返回 `None`。
    pub fn as_legacy_end_event(&self, turn_id: String) -> Option<EventMsg> {
        let status = self.status.clone()?;
        Some(EventMsg::PatchApplyEnd(PatchApplyEndEvent {
            call_id: self.id.clone(),
            turn_id,
            stdout: self.stdout.clone().unwrap_or_default(),
            stderr: self.stderr.clone().unwrap_or_default(),
            success: status == PatchApplyStatus::Completed,
            changes: self.changes.clone(),
            status,
        }))
    }
}

impl McpToolCallItem {
    /// 转换为旧版 `McpToolCallBegin` 事件。
    pub fn as_legacy_begin_event(&self) -> EventMsg {
        EventMsg::McpToolCallBegin(McpToolCallBeginEvent {
            call_id: self.id.clone(),
            invocation: McpInvocation {
                server: self.server.clone(),
                tool: self.tool.clone(),
                arguments: (!self.arguments.is_null()).then(|| self.arguments.clone()),
            },
            connector_id: self.connector_id.clone(),
            mcp_app_resource_uri: self.mcp_app_resource_uri.clone(),
            link_id: self.link_id.clone(),
            app_name: self.app_name.clone(),
            template_id: self.template_id.clone(),
            action_name: self.action_name.clone(),
            plugin_id: self.plugin_id.clone(),
        })
    }

    /// 转换为旧版 `McpToolCallEnd` 事件。
    ///
    /// 当 `result` 与 `error` 均为 `None`（调用尚未结束），或 `duration` 为
    /// `None` 时返回 `None`。
    pub fn as_legacy_end_event(&self) -> Option<EventMsg> {
        let result = match (&self.result, &self.error) {
            (Some(result), _) => Ok(result.clone()),
            (None, Some(error)) => Err(error.message.clone()),
            (None, None) => return None,
        };

        Some(EventMsg::McpToolCallEnd(McpToolCallEndEvent {
            call_id: self.id.clone(),
            invocation: McpInvocation {
                server: self.server.clone(),
                tool: self.tool.clone(),
                arguments: (!self.arguments.is_null()).then(|| self.arguments.clone()),
            },
            mcp_app_resource_uri: self.mcp_app_resource_uri.clone(),
            connector_id: self.connector_id.clone(),
            link_id: self.link_id.clone(),
            app_name: self.app_name.clone(),
            template_id: self.template_id.clone(),
            action_name: self.action_name.clone(),
            plugin_id: self.plugin_id.clone(),
            duration: self.duration?,
            result,
        }))
    }
}

impl TurnItem {
    /// 返回该条目的唯一 ID，无论变体类型。
    pub fn id(&self) -> String {
        match self {
            TurnItem::UserMessage(item) => item.id.clone(),
            TurnItem::HookPrompt(item) => item.id.clone(),
            TurnItem::AgentMessage(item) => item.id.clone(),
            TurnItem::Plan(item) => item.id.clone(),
            TurnItem::Reasoning(item) => item.id.clone(),
            TurnItem::CommandExecution(item) => item.id.clone(),
            TurnItem::DynamicToolCall(item) => item.id.clone(),
            TurnItem::CollabAgentToolCall(item) => item.id.clone(),
            TurnItem::SubAgentActivity(item) => item.id.clone(),
            TurnItem::WebSearch(item) => item.id.clone(),
            TurnItem::ImageView(item) => item.id.clone(),
            TurnItem::Sleep(item) => item.id.clone(),
            TurnItem::ImageGeneration(item) => item.id.clone(),
            TurnItem::FileChange(item) => item.id.clone(),
            TurnItem::McpToolCall(item) => item.id.clone(),
            TurnItem::ContextCompaction(item) => item.id.clone(),
        }
    }

    /// 将条目转换为旧版事件列表。
    ///
    /// 某些变体（`HookPrompt`、`Plan`、`CommandExecution` 等）在旧版协议中
    /// 没有对应事件，返回空向量。`show_raw_agent_reasoning` 仅影响
    /// `Reasoning` 变体是否输出原始推理内容。
    pub fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg> {
        match self {
            TurnItem::UserMessage(item) => vec![item.as_legacy_event()],
            TurnItem::HookPrompt(_) => Vec::new(),
            TurnItem::AgentMessage(item) => item.as_legacy_events(),
            TurnItem::Plan(_) => Vec::new(),
            TurnItem::CommandExecution(_)
            | TurnItem::DynamicToolCall(_)
            | TurnItem::CollabAgentToolCall(_) => Vec::new(),
            TurnItem::SubAgentActivity(_) => Vec::new(),
            TurnItem::WebSearch(item) => vec![item.as_legacy_event()],
            TurnItem::ImageView(item) => {
                vec![EventMsg::ViewImageToolCall(ViewImageToolCallEvent {
                    call_id: item.id.clone(),
                    path: item.path.clone(),
                })]
            }
            TurnItem::Sleep(_) => Vec::new(),
            TurnItem::ImageGeneration(item) => vec![item.as_legacy_event()],
            TurnItem::FileChange(item) => item
                .as_legacy_end_event(String::new())
                .into_iter()
                .collect(),
            TurnItem::McpToolCall(item) => item.as_legacy_end_event().into_iter().collect(),
            TurnItem::Reasoning(item) => item.as_legacy_events(show_raw_agent_reasoning),
            TurnItem::ContextCompaction(item) => vec![item.as_legacy_event()],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn hook_prompt_roundtrips_multiple_fragments() {
        let original = vec![
            HookPromptFragment::from_single_hook("Retry with care & joy.", "hook-run-1"),
            HookPromptFragment::from_single_hook("Then summarize cleanly.", "hook-run-2"),
        ];
        let message = build_hook_prompt_message(&original).expect("hook prompt");

        let ResponseItem::Message { content, .. } = message else {
            panic!("expected hook prompt message");
        };

        let parsed = parse_hook_prompt_message(/*id*/ None, &content).expect("parsed hook prompt");
        assert_eq!(parsed.fragments, original);
    }

    #[test]
    fn hook_prompt_parses_legacy_single_hook_run_id() {
        let parsed = parse_hook_prompt_fragment(
            r#"<hook_prompt hook_run_id="hook-run-1">Retry with tests.</hook_prompt>"#,
        )
        .expect("legacy hook prompt");

        assert_eq!(
            parsed,
            HookPromptFragment {
                text: "Retry with tests.".to_string(),
                hook_run_id: "hook-run-1".to_string(),
            }
        );
    }
}
