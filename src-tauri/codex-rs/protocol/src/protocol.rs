//! 定义客户端与 Agent 之间 Codex 会话使用的协议。
//!
//! 采用 SQ（Submission Queue，提交队列）/ EQ（Event Queue，事件队列）模式，在
//! 用户与 Agent 之间进行异步通信：客户端将 [`Submission`] 放入 SQ，Agent 处理
//! 后通过 EQ 推送 [`Event`] 回客户端。该模式解耦了请求与响应，支持并发处理与
//! 流式输出。

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::fmt;
use std::ops::Mul;
use std::path::Path;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use strum_macros::EnumIter;

use crate::AgentPath;
use crate::SessionId;
use crate::ThreadId;
use crate::approvals::ElicitationRequestEvent;
use crate::capabilities::SelectedCapabilityRoot;
use crate::config_types::ApprovalsReviewer;
use crate::config_types::CollaborationMode;
use crate::config_types::ModeKind;
use crate::config_types::MultiAgentMode;
use crate::config_types::Personality;
use crate::config_types::ReasoningSummary as ReasoningSummaryConfig;
use crate::config_types::WindowsSandboxLevel;
use crate::dynamic_tools::DynamicToolCallOutputContentItem;
use crate::dynamic_tools::DynamicToolCallRequest;
use crate::dynamic_tools::DynamicToolResponse;
use crate::dynamic_tools::DynamicToolSpec;
use crate::items::TurnItem;
use crate::mcp::CallToolResult;
use crate::mcp::RequestId;
use crate::memory_citation::MemoryCitation;
use crate::models::ActivePermissionProfile;
use crate::models::AgentMessageInputContent;
use crate::models::BaseInstructions;
use crate::models::ContentItem;
use crate::models::ImageDetail;
use crate::models::InternalChatMessageMetadataPassthrough;
use crate::models::MessagePhase;
use crate::models::PermissionProfile;
use crate::models::ResponseInputItem;
use crate::models::ResponseItem;
use crate::models::SandboxEnforcement;
use crate::models::WebSearchAction;
use crate::num_format::format_with_separators;
use crate::openai_models::ReasoningEffort as ReasoningEffortConfig;
use crate::parse_command::ParsedCommand;
use crate::plan_tool::UpdatePlanArgs;
use crate::request_permissions::RequestPermissionsEvent;
use crate::request_permissions::RequestPermissionsResponse;
use crate::request_user_input::RequestUserInputResponse;
use crate::user_input::UserInput;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de::Error as _;
use serde_json::Value;
use serde_with::serde_as;
use strum_macros::Display;
use tracing::error;
use ts_rs::TS;

pub use crate::approvals::ApplyPatchApprovalRequestEvent;
pub use crate::approvals::ElicitationAction;
pub use crate::approvals::ExecApprovalRequestEvent;
pub use crate::approvals::ExecPolicyAmendment;
pub use crate::approvals::GuardianAssessmentAction;
pub use crate::approvals::GuardianAssessmentDecisionSource;
pub use crate::approvals::GuardianAssessmentEvent;
pub use crate::approvals::GuardianAssessmentOutcome;
pub use crate::approvals::GuardianAssessmentStatus;
pub use crate::approvals::GuardianCommandSource;
pub use crate::approvals::GuardianRiskLevel;
pub use crate::approvals::GuardianUserAuthorization;
pub use crate::approvals::NetworkApprovalContext;
pub use crate::approvals::NetworkApprovalProtocol;
pub use crate::approvals::NetworkPolicyAmendment;
pub use crate::approvals::NetworkPolicyRuleAction;
pub use crate::permissions::FileSystemAccessMode;
pub use crate::permissions::FileSystemPath;
pub use crate::permissions::FileSystemSandboxEntry;
pub use crate::permissions::FileSystemSandboxKind;
pub use crate::permissions::FileSystemSandboxPolicy;
pub use crate::permissions::FileSystemSpecialPath;
pub use crate::permissions::NetworkSandboxPolicy;
use crate::permissions::default_read_only_subpaths_for_writable_root;
pub use crate::request_permissions::RequestPermissionsArgs;
pub use crate::request_user_input::RequestUserInputEvent;

/// 特殊上下文块的开 / 闭标签常量。
///
/// 集中定义这些标签以避免在各 crate 中硬编码字符串，保证一致性。
pub const USER_INSTRUCTIONS_OPEN_TAG: &str = "<user_instructions>";
pub const USER_INSTRUCTIONS_CLOSE_TAG: &str = "</user_instructions>";
pub const ENVIRONMENT_CONTEXT_OPEN_TAG: &str = "<environment_context>";
pub const ENVIRONMENT_CONTEXT_CLOSE_TAG: &str = "</environment_context>";
pub const APPS_INSTRUCTIONS_OPEN_TAG: &str = "<apps_instructions>";
pub const APPS_INSTRUCTIONS_CLOSE_TAG: &str = "</apps_instructions>";
pub const SKILLS_INSTRUCTIONS_OPEN_TAG: &str = "<skills_instructions>";
pub const SKILLS_INSTRUCTIONS_CLOSE_TAG: &str = "</skills_instructions>";
pub const PLUGINS_INSTRUCTIONS_OPEN_TAG: &str = "<plugins_instructions>";
pub const PLUGINS_INSTRUCTIONS_CLOSE_TAG: &str = "</plugins_instructions>";
pub const COLLABORATION_MODE_OPEN_TAG: &str = "<collaboration_mode>";
pub const COLLABORATION_MODE_CLOSE_TAG: &str = "</collaboration_mode>";
pub const MULTI_AGENT_MODE_OPEN_TAG: &str = "<multi_agent_mode>";
pub const MULTI_AGENT_MODE_CLOSE_TAG: &str = "</multi_agent_mode>";
pub const REALTIME_CONVERSATION_OPEN_TAG: &str = "<realtime_conversation>";
pub const REALTIME_CONVERSATION_CLOSE_TAG: &str = "</realtime_conversation>";
pub const CONTEXT_WINDOW_OPEN_TAG: &str = "<context_window>";
pub const CONTEXT_WINDOW_CLOSE_TAG: &str = "</context_window>";
pub const CONTEXT_WINDOW_GUIDANCE_OPEN_TAG: &str = "<context_window_guidance>";
pub const CONTEXT_WINDOW_GUIDANCE_CLOSE_TAG: &str = "</context_window_guidance>";
pub const USER_MESSAGE_BEGIN: &str = "## My request for Codex:";

// TODO(anp): 当 PathUri 支持环境标识后，用 `PathUri` 替换 `TurnEnvironmentSelection`。
/// 单个执行环境的选定信息。
///
/// 表示本轮对话选择使用的具体环境及其工作目录。未来当 `PathUri` 携带环境标识后，
/// 该类型将被 `PathUri` 替代。
#[derive(Debug, Clone, PartialEq)]
pub struct TurnEnvironmentSelection {
    /// 环境标识符。
    pub environment_id: String,
    /// 该环境的当前工作目录。
    pub cwd: PathUri,
}

/// 本轮对话选定的环境集合。
///
/// 包含一个 legacy 兜底工作目录与若干环境选择项，用于在多环境场景下统一描述
/// 本轮对话的执行上下文。
#[derive(Debug, Clone, PartialEq)]
pub struct TurnEnvironmentSelections {
    /// 旧版兜底工作目录（在无环境标识时使用）。
    pub legacy_fallback_cwd: AbsolutePathBuf,
    /// 本轮选定的环境列表。
    pub environments: Vec<TurnEnvironmentSelection>,
}

impl TurnEnvironmentSelections {
    /// 构造一个新的环境选择集合。
    pub fn new(
        legacy_fallback_cwd: AbsolutePathBuf,
        environments: Vec<TurnEnvironmentSelection>,
    ) -> Self {
        Self {
            legacy_fallback_cwd,
            environments,
        }
    }
}

/// Git commit SHA（短或长形式）。
///
/// 透明序列化为字符串，用于在协议中传递代码版本信息。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema, TS)]
#[serde(transparent)]
#[ts(type = "string")]
pub struct GitSha(pub String);

impl GitSha {
    /// 由字符串构造 `GitSha`。
    pub fn new(sha: &str) -> Self {
        Self(sha.to_string())
    }
}

/// 提交队列（SQ）条目，表示用户向 Agent 提交的一次请求。
///
/// Agent 处理后会通过 EQ 推送与 `id` 关联的 [`Event`]。
#[derive(Debug, Clone)]
pub struct Submission {
    /// 唯一标识，用于与对应的 [`Event`] 建立关联。
    pub id: String,
    /// 本次提交的具体操作负载。
    pub op: Op,
    /// 客户端为 `Op::UserInput` 对应的用户消息提供的标识，便于客户端侧去重与追踪。
    pub client_user_message_id: Option<String>,
    /// 可选的 W3C trace 上下文，在异步提交交接过程中传播分布式追踪信息。
    pub trace: Option<W3cTraceContext>,
}

/// W3C Trace Context 载体。
///
/// 用于在异步提交流转过程中传递 `traceparent` 与 `tracestate`，支持分布式追踪。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct W3cTraceContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub traceparent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tracestate: Option<String>,
}

/// 刷新 MCP 服务器时携带的配置负载。
#[derive(Debug, Clone, PartialEq)]
pub struct McpServerRefreshConfig {
    /// 经过 source 与 thread 级解析后得到的完整运行时 server map。
    pub mcp_servers: Value,
    /// 与本快照配合使用的 OAuth 凭证存储模式。
    pub mcp_oauth_credentials_store_mode: Value,
    /// 使用的 keyring 后端类型。
    pub auth_keyring_backend_kind: Value,
}

/// 实时会话启动参数。
///
/// 描述一次 realtime 会话所需的全部参数，包括传输方式、输出模态、语音、模型覆盖等。
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationStartParams {
    /// 是否由客户端通过显式 append 调用来管理 Codex 响应交接。
    pub client_managed_handoffs: bool,
    /// 是否将 Codex 的自动响应作为 realtime 会话条目发送，而非通过 handoff append 发送。
    pub codex_responses_as_items: bool,
    /// 当 `codex_responses_as_items` 为真时，为自动响应条目添加的可选前缀。
    pub codex_response_item_prefix: Option<String>,
    /// 当 `codex_responses_as_items` 为假时，随 `conversation.handoff.append` 发送的
    /// V1 Codex commentary 的可选前缀；最终答案不带该前缀。
    pub codex_response_handoff_prefix: Option<String>,
    /// 仅对本会话覆盖已配置的 realtime 模型。
    pub model: Option<String>,
    /// 选择 realtime 会话输出文本还是音频。
    pub output_modality: RealtimeOutputModality,
    /// 是否将 Codex 启动上下文附加到 realtime 后端 prompt。
    pub include_startup_context: bool,
    /// 可选的 prompt 覆盖（外层 `None` 表示不覆盖，`Some(None)` 表示清空）。
    pub prompt: Option<Option<String>>,
    /// 复用的已有 realtime 会话 ID（若不复用则为 `None`）。
    pub realtime_session_id: Option<String>,
    /// 传输方式覆盖。
    pub transport: Option<ConversationStartTransport>,
    /// 仅对本会话覆盖已配置的 realtime 协议版本。
    pub version: Option<RealtimeConversationVersion>,
    /// 语音覆盖。
    pub voice: Option<RealtimeVoice>,
}

/// 实时会话传输方式。
#[derive(Debug, Clone, PartialEq)]
pub enum ConversationStartTransport {
    /// 使用 WebSocket 传输。
    Websocket,
    /// 使用 WebRTC 传输，附带 SDP 描述。
    Webrtc { sdp: String },
}

/// 实时会话输出模态。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeOutputModality {
    /// 文本输出。
    Text,
    /// 音频输出。
    Audio,
}

/// Realtime 可选语音。
///
/// 列举了 realtime 后端支持的内置语音变体，序列化为 snake_case 字符串。
#[derive(
    Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash, JsonSchema, TS, Ord, PartialOrd,
)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum RealtimeVoice {
    Alloy,
    Arbor,
    Ash,
    Ballad,
    Breeze,
    Cedar,
    Coral,
    Cove,
    Echo,
    Ember,
    Juniper,
    Maple,
    Marin,
    Sage,
    Shimmer,
    Sol,
    Spruce,
    Vale,
    Verse,
}

impl RealtimeVoice {
    /// 返回该语音在线协议上使用的字符串名称。
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Alloy => "alloy",
            Self::Arbor => "arbor",
            Self::Ash => "ash",
            Self::Ballad => "ballad",
            Self::Breeze => "breeze",
            Self::Cedar => "cedar",
            Self::Coral => "coral",
            Self::Cove => "cove",
            Self::Echo => "echo",
            Self::Ember => "ember",
            Self::Juniper => "juniper",
            Self::Maple => "maple",
            Self::Marin => "marin",
            Self::Sage => "sage",
            Self::Shimmer => "shimmer",
            Self::Sol => "sol",
            Self::Spruce => "spruce",
            Self::Vale => "vale",
            Self::Verse => "verse",
        }
    }
}

/// Realtime 可用语音列表。
///
/// 包含 v1 / v2 两个协议版本各自支持的语音以及默认语音。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RealtimeVoicesList {
    /// v1 协议支持的语音列表。
    pub v1: Vec<RealtimeVoice>,
    /// v2 协议支持的语音列表。
    pub v2: Vec<RealtimeVoice>,
    /// v1 协议的默认语音。
    pub default_v1: RealtimeVoice,
    /// v2 协议的默认语音。
    pub default_v2: RealtimeVoice,
}

impl RealtimeVoicesList {
    /// 返回内置的语音列表及默认值。
    pub fn builtin() -> Self {
        Self {
            v1: vec![
                RealtimeVoice::Juniper,
                RealtimeVoice::Maple,
                RealtimeVoice::Spruce,
                RealtimeVoice::Ember,
                RealtimeVoice::Vale,
                RealtimeVoice::Breeze,
                RealtimeVoice::Arbor,
                RealtimeVoice::Sol,
                RealtimeVoice::Cove,
            ],
            v2: vec![
                RealtimeVoice::Alloy,
                RealtimeVoice::Ash,
                RealtimeVoice::Ballad,
                RealtimeVoice::Coral,
                RealtimeVoice::Echo,
                RealtimeVoice::Sage,
                RealtimeVoice::Shimmer,
                RealtimeVoice::Verse,
                RealtimeVoice::Marin,
                RealtimeVoice::Cedar,
            ],
            default_v1: RealtimeVoice::Cove,
            default_v2: RealtimeVoice::Marin,
        }
    }
}

/// Realtime 音频帧。
///
/// 携带一帧 PCM 音频数据及其采样信息。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeAudioFrame {
    /// Base64 编码的音频数据。
    pub data: String,
    /// 采样率（Hz）。
    pub sample_rate: u32,
    /// 声道数。
    pub num_channels: u16,
    /// 每个声道的采样数（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub samples_per_channel: Option<u32>,
    /// 关联的 realtime 条目 ID（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
}

/// Realtime 转写增量。
///
/// 表示一段流式转写文本的增量片段。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeTranscriptDelta {
    /// 本帧新增的转写文本。
    pub delta: String,
}

/// Realtime 转写完成事件负载。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeTranscriptDone {
    /// 最终的完整转写文本。
    pub text: String,
}

/// Realtime 转写历史条目。
///
/// 用于在 handoff 等场景下携带一段完整的历史对话转写。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeTranscriptEntry {
    /// 角色（如 `user` / `assistant`）。
    pub role: String,
    /// 该角色的完整文本。
    pub text: String,
}

/// Realtime handoff 请求事件负载。
///
/// 当 realtime 会话请求将控制权交接回 Codex 主流程时携带。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeHandoffRequested {
    /// 本次 handoff 的唯一标识。
    pub handoff_id: String,
    /// 触发 handoff 的 realtime 条目 ID。
    pub item_id: String,
    /// 用户输入侧的转写文本。
    pub input_transcript: String,
    /// 当前活跃的转写历史条目列表。
    pub active_transcript: Vec<RealtimeTranscriptEntry>,
}

/// Realtime noop 请求事件负载。
///
/// 表示模型发起了一次空操作调用，需要客户端确认。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeNoopRequested {
    /// 关联的工具调用 ID。
    pub call_id: String,
    /// 关联的 realtime 条目 ID。
    pub item_id: String,
}

/// Realtime 用户语音开始事件负载。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeInputAudioSpeechStarted {
    /// 关联的 realtime 条目 ID（可选）。
    pub item_id: Option<String>,
}

/// Realtime 响应被取消事件负载。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeResponseCancelled {
    /// 被取消的响应 ID（可选）。
    pub response_id: Option<String>,
}

/// Realtime 响应创建事件负载。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeResponseCreated {
    /// 新建的响应 ID（可选）。
    pub response_id: Option<String>,
}

/// Realtime 响应完成事件负载。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeResponseDone {
    /// 完成的响应 ID（可选）。
    pub response_id: Option<String>,
}

/// Realtime 会话事件。
///
/// 涵盖 realtime 会话生命周期内的全部事件类型，由 realtime 后端推送至客户端。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub enum RealtimeEvent {
    /// 会话已更新，携带新的 instructions。
    SessionUpdated {
        realtime_session_id: String,
        instructions: Option<String>,
    },
    /// 检测到用户语音开始。
    InputAudioSpeechStarted(RealtimeInputAudioSpeechStarted),
    /// 输入侧转写增量。
    InputTranscriptDelta(RealtimeTranscriptDelta),
    /// 输入侧转写完成。
    InputTranscriptDone(RealtimeTranscriptDone),
    /// 输出侧转写增量。
    OutputTranscriptDelta(RealtimeTranscriptDelta),
    /// 输出侧转写完成。
    OutputTranscriptDone(RealtimeTranscriptDone),
    /// 一帧音频输出。
    AudioOut(RealtimeAudioFrame),
    /// 响应已创建。
    ResponseCreated(RealtimeResponseCreated),
    /// 响应已取消。
    ResponseCancelled(RealtimeResponseCancelled),
    /// 响应已完成。
    ResponseDone(RealtimeResponseDone),
    /// 会话条目已添加。
    ConversationItemAdded(Value),
    /// 会话条目已结束。
    ConversationItemDone {
        item_id: String,
    },
    /// handoff 请求。
    HandoffRequested(RealtimeHandoffRequested),
    /// noop 请求。
    NoopRequested(RealtimeNoopRequested),
    /// 错误信息。
    Error(String),
}

/// Realtime 音频输入参数。
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationAudioParams {
    /// 一帧音频数据。
    pub frame: RealtimeAudioFrame,
}

/// Realtime 文本输入参数。
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationTextParams {
    /// 文本内容。
    pub text: String,
    /// 文本角色。
    pub role: ConversationTextRole,
}

/// Realtime 文本角色。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ConversationTextRole {
    #[default]
    /// 用户角色。
    User,
    /// 开发者角色。
    Developer,
    /// 助手角色。
    Assistant,
}

/// Realtime 语音合成参数。
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationSpeechParams {
    /// 待合成的可朗读文本。
    pub text: String,
}

/// 持久化的 thread 级设置覆盖，可在用户输入前应用，也可独立应用。所有字段均为
/// `Option`，`None` 表示不修改对应设置。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThreadSettingsOverrides {
    /// 更新的兜底 `cwd` 与环境列表，作为一对完整设置一起提供。
    pub environments: Option<TurnEnvironmentSelections>,

    /// 更新的运行时工作区根，用于物化符号化的 `:workspace_roots` 文件系统权限。
    pub workspace_roots: Option<Vec<AbsolutePathBuf>>,

    /// 更新的 profile 定义工作区根，用于状态汇总与每轮配置重建。
    pub profile_workspace_roots: Option<Vec<AbsolutePathBuf>>,

    /// 更新的命令审批策略。
    pub approval_policy: Option<AskForApproval>,

    /// 更新的审批提示审核者。
    pub approvals_reviewer: Option<ApprovalsReviewer>,

    /// 更新的工具调用 sandbox 策略。
    pub sandbox_policy: Option<SandboxPolicy>,

    /// 更新的工具调用权限 profile。
    pub permission_profile: Option<PermissionProfile>,

    /// 产生 `permission_profile` 的命名或内置 profile；当本次更新是选择某个
    /// profile 而非直接提供原始权限时设置。
    pub active_permission_profile: Option<ActivePermissionProfile>,

    /// 更新的 Windows sandbox 级别。
    pub windows_sandbox_level: Option<WindowsSandboxLevel>,

    /// 更新的 model slug；设置后会自动派生模型信息。
    pub model: Option<String>,

    /// 更新的 reasoning effort（仅对支持 reasoning 的模型生效）。
    ///
    /// 三态语义：`Some(Some(_))` 设置具体 effort；`Some(None)` 清除；`None` 不变。
    pub effort: Option<Option<ReasoningEffortConfig>>,

    /// 更新的 reasoning summary 偏好（仅对支持 reasoning 的模型生效）。
    pub summary: Option<ReasoningSummaryConfig>,

    /// 更新的 service tier 偏好。
    ///
    /// 三态语义：`Some(Some(_))` 设置具体 tier；`Some(None)` 清除；`None` 不变。
    pub service_tier: Option<Option<String>>,

    /// 实验性：设置预设的 collaboration mode。设置后优先级高于 model、effort
    /// 与 developer instructions。
    pub collaboration_mode: Option<CollaborationMode>,

    /// 更新的 personality 偏好。
    pub personality: Option<Personality>,
}

/// 客户端提供上下文的来源分类，影响上下文在 prompt 中的信任级别与处理方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdditionalContextKind {
    /// 不可信来源（如用户粘贴的外部内容）。
    Untrusted,
    /// 应用来源（如 Codex 自身集成提供的内容）。
    Application,
}

/// 客户端提供的上下文条目，以不透明的 source identifier 为键。`value` 为内容，
/// `kind` 决定其信任级别。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdditionalContextEntry {
    /// 上下文内容。
    pub value: String,
    /// 来源分类。
    pub kind: AdditionalContextKind,
}

/// 提交操作枚举。
///
/// 客户端通过 [`Submission::op`] 携带一个 `Op` 来描述本次提交的具体意图。
/// `#[non_exhaustive]` 表示未来可能新增变体，外部匹配需保留兜底分支。
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
#[non_exhaustive]
pub enum Op {
    /// 中止当前任务，但不终止后台终端进程。
    ///
    /// 服务端会回复 [`EventMsg::TurnAborted`]。
    Interrupt,

    /// 终止此 thread 的所有正在运行的后台终端进程。
    ///
    /// 当调用方明确希望停止长生命周期的后台 shell 时使用。
    CleanBackgroundTerminals,

    /// 启动一个 realtime 会话流。
    RealtimeConversationStart(ConversationStartParams),

    /// 向运行中的 realtime 会话流发送音频输入。
    RealtimeConversationAudio(ConversationAudioParams),

    /// 向运行中的 realtime 会话流发送文本输入。
    RealtimeConversationText(ConversationTextParams),

    /// 向运行中的 realtime 会话流追加可朗读文本。
    RealtimeConversationSpeech(ConversationSpeechParams),

    /// 关闭运行中的 realtime 会话流。
    RealtimeConversationClose,

    /// 请求 realtime 会话流支持的语音列表。
    RealtimeConversationListVoices,

    /// 用户输入，可选地先应用 thread 级设置覆盖。
    UserInput {
        /// 用户输入条目，详见 `InputItem`。
        items: Vec<UserInput>,
        /// 可选的 JSON Schema，用于约束本轮 assistant 最终消息的格式。
        final_output_json_schema: Option<Value>,
        /// 可选的本轮级 Responses API `client_metadata`。
        responsesapi_client_metadata: Option<HashMap<String, String>>,
        /// 客户端提供的上下文片段，以不透明的 source identifier 为键。
        additional_context: BTreeMap<String, AdditionalContextEntry>,

        /// 在输入前应用的持久化 thread 级设置覆盖。
        thread_settings: ThreadSettingsOverrides,
    },

    /// 应用持久化 thread 级设置覆盖，但不启动新一轮对话。复用与 turn start
    /// 相同的提交队列，以保证两种变更之间的调用顺序。
    ThreadSettings {
        /// 待应用的持久化 thread 级设置覆盖。
        thread_settings: ThreadSettingsOverrides,
    },

    /// Agent 间通信，需记录为 agent-message 历史，同时仍走正常 thread 提交生命周期。
    InterAgentCommunication {
        communication: InterAgentCommunication,
    },

    /// 审批命令执行请求。
    ExecApproval {
        /// 待审批的 submission ID。
        id: String,
        /// 与审批事件关联的 turn ID（若可用）。
        turn_id: Option<String>,
        /// 用户对该请求的决定。
        decision: ReviewDecision,
    },

    /// 审批代码补丁请求。
    PatchApproval {
        /// 待审批的 submission ID。
        id: String,
        /// 用户对该请求的决定。
        decision: ReviewDecision,
    },

    /// 解析（响应）一个 MCP elicitation 请求。
    ResolveElicitation {
        /// 发起请求的 MCP server 名称。
        server_name: String,
        /// MCP server 侧的请求标识。
        request_id: RequestId,
        /// 用户对该请求的决定。
        decision: ElicitationAction,
        /// 当请求被接受时提供的结构化用户输入。
        content: Option<Value>,
        /// 与该响应关联的可选客户端 metadata。
        meta: Option<Value>,
    },

    /// 响应 `request_user_input` 工具调用。
    UserInputAnswer {
        /// 进行中请求的 turn ID。
        id: String,
        /// 用户提供的回答。
        response: RequestUserInputResponse,
    },

    /// 响应 `request_permissions` 工具调用。
    RequestPermissionsResponse {
        /// 进行中请求的 call ID。
        id: String,
        /// 用户授予的权限。
        response: RequestPermissionsResponse,
    },

    /// 响应 dynamic tool 调用请求。
    DynamicToolResponse {
        /// 进行中请求的 call ID。
        id: String,
        /// 工具输出负载。
        response: DynamicToolResponse,
    },

    /// 请求 MCP server 重新初始化并刷新缓存的工具列表。
    RefreshMcpServers { config: McpServerRefreshConfig },

    /// 为当前会话重新加载用户 config 层覆盖。无需重启 thread 即可更新运行时
    /// 由 config 派生的行为（例如 app 启用 / 禁用状态）。
    ReloadUserConfig,

    /// 请求 Agent 总结当前对话上下文。Agent 会基于既有上下文（对话历史或上一次
    /// response id）生成摘要，并通过 AgentMessage 事件返回。
    Compact,

    /// 设置本 thread 是否仍可进行 memory 生成。仅持久化 thread 级 memory mode
    /// metadata，不涉及模型调用。
    SetThreadMemoryMode { mode: ThreadMemoryMode },

    /// 请求 Codex 从内存上下文中丢弃最近 N 轮用户对话。不会尝试回滚本地文件
    /// 系统变更，调用方需自行撤销磁盘上的编辑。
    ThreadRollback { num_turns: u32 },

    /// 请求 Agent 进行代码审查。
    Review { review_request: ReviewRequest },

    /// 记录用户批准对某个被 Guardian 拒绝的具体动作进行一次重试。
    ApproveGuardianDeniedAction { event: GuardianAssessmentEvent },

    /// 请求关闭 codex 实例。
    Shutdown,

    /// 执行用户发起的一次性 shell 命令（通过 `!cmd` 触发）。命令字符串使用
    /// 用户默认 shell 执行，可包含 shell 语法（管道、重定向等）。输出通过
    /// `ExecCommand*` 事件流式返回，`TurnComplete` 后 UI 重新获得控制权。
    RunUserShellCommand {
        /// 去掉 `!` 后的原始命令字符串。
        command: String,
    },
}

/// Thread 的 memory 生成模式。
///
/// 控制本 thread 是否仍可参与 memory 生成流程。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ThreadMemoryMode {
    /// 允许 memory 生成。
    Enabled,
    /// 禁止 memory 生成。
    Disabled,
}

/// Thread 历史记录模式。
///
/// 控制会话历史的存储与查询方式：`Legacy` 为旧版全量加载，`Paginated` 为分页加载。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum ThreadHistoryMode {
    #[default]
    /// 旧版全量加载模式。
    Legacy,
    /// 分页加载模式。
    Paginated,
}

impl ThreadHistoryMode {
    /// 返回该模式的字符串表示，用于序列化或日志输出。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Paginated => "paginated",
        }
    }
}

impl FromStr for ThreadHistoryMode {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "legacy" => Ok(Self::Legacy),
            "paginated" => Ok(Self::Paginated),
            _ => Err(format!("unknown thread history mode `{value}`")),
        }
    }
}

impl From<Vec<UserInput>> for Op {
    fn from(value: Vec<UserInput>) -> Self {
        Op::UserInput {
            items: value,
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: ThreadSettingsOverrides::default(),
        }
    }
}

/// Agent 间通信消息。
///
/// 用于在多 Agent 之间传递消息。消息可明文（`content`）或加密
/// （`encrypted_content`），并可携带透传的内部 chat metadata。当 `trigger_turn`
/// 为真时，该消息会触发接收方的一轮对话。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema, TS)]
pub struct InterAgentCommunication {
    /// 可选的消息 ID，用于关联与去重。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    /// 消息作者路径。
    pub author: AgentPath,
    /// 主接收方路径。
    pub recipient: AgentPath,
    /// 其他接收方路径列表（抄送）。
    #[serde(default)]
    pub other_recipients: Vec<AgentPath>,
    /// 明文消息内容。
    pub content: String,
    /// 加密消息内容（与 `content` 互斥）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub encrypted_content: Option<String>,
    /// 透传的内部 chat metadata，用于跨层传递追踪信息。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    /// 是否触发接收方的一轮对话。
    pub trigger_turn: bool,
}

impl InterAgentCommunication {
    /// 构造一条明文 Agent 间通信消息。
    pub fn new(
        author: AgentPath,
        recipient: AgentPath,
        other_recipients: Vec<AgentPath>,
        content: String,
        trigger_turn: bool,
    ) -> Self {
        Self {
            id: None,
            author,
            recipient,
            other_recipients,
            content,
            encrypted_content: None,
            internal_chat_message_metadata_passthrough: None,
            trigger_turn,
        }
    }

    /// 构造一条加密 Agent 间通信消息。
    pub fn new_encrypted(
        author: AgentPath,
        recipient: AgentPath,
        other_recipients: Vec<AgentPath>,
        encrypted_content: String,
        trigger_turn: bool,
    ) -> Self {
        Self {
            id: None,
            author,
            recipient,
            other_recipients,
            content: String::new(),
            encrypted_content: Some(encrypted_content),
            internal_chat_message_metadata_passthrough: None,
            trigger_turn,
        }
    }

    /// 当内部 metadata 中缺少 turn ID 时，将其设置为给定值。
    pub fn set_turn_id_if_missing(&mut self, turn_id: &str) {
        InternalChatMessageMetadataPassthrough::set_turn_id_if_missing(
            &mut self.internal_chat_message_metadata_passthrough,
            turn_id,
        );
    }

    /// 转换为 Responses API 的输入条目（assistant commentary）。
    ///
    /// 会清除 `id` 与透传 metadata，避免在历史回放中重复记录。
    pub fn to_response_input_item(&self) -> ResponseInputItem {
        let mut communication = self.clone();
        communication.id = None;
        communication.internal_chat_message_metadata_passthrough = None;
        ResponseInputItem::Message {
            role: "assistant".to_string(),
            content: vec![ContentItem::OutputText {
                text: serde_json::to_string(&communication).unwrap_or_default(),
            }],
            phase: Some(MessagePhase::Commentary),
        }
    }

    /// 转换为模型输入条目。
    ///
    /// 加密消息会被拆分为描述性头与加密负载两部分；明文消息则直接以文本形式提供。
    pub fn to_model_input_item(&self) -> ResponseItem {
        let content = match &self.encrypted_content {
            Some(encrypted_content) => {
                let message_type = if self.trigger_turn {
                    "NEW_TASK"
                } else {
                    "MESSAGE"
                };
                vec![
                    AgentMessageInputContent::InputText {
                        text: format!(
                            "Message Type: {message_type}\nTask name: {}\nSender: {}\nPayload:\n",
                            self.recipient, self.author
                        ),
                    },
                    AgentMessageInputContent::EncryptedContent {
                        encrypted_content: encrypted_content.clone(),
                    },
                ]
            }
            None => vec![AgentMessageInputContent::InputText {
                text: self.content.clone(),
            }],
        };
        ResponseItem::AgentMessage {
            id: self.id.clone(),
            author: self.author.to_string(),
            recipient: self.recipient.to_string(),
            content,
            internal_chat_message_metadata_passthrough: self
                .internal_chat_message_metadata_passthrough
                .clone(),
        }
    }

    /// 判断给定内容是否可解析为 Agent 间通信消息。
    pub fn is_message_content(content: &[ContentItem]) -> bool {
        Self::from_message_content(content).is_some()
    }

    /// 尝试从消息内容中反序列化出 Agent 间通信消息。
    ///
    /// 仅当内容为单个文本条目时尝试解析；否则返回 `None`。
    pub fn from_message_content(content: &[ContentItem]) -> Option<Self> {
        match content {
            [ContentItem::InputText { text }] | [ContentItem::OutputText { text }] => {
                serde_json::from_str(text).ok()
            }
            _ => None,
        }
    }
}

impl Op {
    /// 返回该 `Op` 变体的静态字符串标识，用于日志与可观测性。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Interrupt => "interrupt",
            Self::CleanBackgroundTerminals => "clean_background_terminals",
            Self::RealtimeConversationStart(_) => "realtime_conversation_start",
            Self::RealtimeConversationAudio(_) => "realtime_conversation_audio",
            Self::RealtimeConversationText(_) => "realtime_conversation_text",
            Self::RealtimeConversationSpeech(_) => "realtime_conversation_speech",
            Self::RealtimeConversationClose => "realtime_conversation_close",
            Self::RealtimeConversationListVoices => "realtime_conversation_list_voices",
            Self::UserInput { .. } => "user_input",
            Self::ThreadSettings { .. } => "thread_settings",
            Self::InterAgentCommunication { .. } => "inter_agent_communication",
            Self::ExecApproval { .. } => "exec_approval",
            Self::PatchApproval { .. } => "patch_approval",
            Self::ResolveElicitation { .. } => "resolve_elicitation",
            Self::UserInputAnswer { .. } => "user_input_answer",
            Self::RequestPermissionsResponse { .. } => "request_permissions_response",
            Self::DynamicToolResponse { .. } => "dynamic_tool_response",
            Self::RefreshMcpServers { .. } => "refresh_mcp_servers",
            Self::ReloadUserConfig => "reload_user_config",
            Self::Compact => "compact",
            Self::SetThreadMemoryMode { .. } => "set_thread_memory_mode",
            Self::ThreadRollback { .. } => "thread_rollback",
            Self::Review { .. } => "review",
            Self::ApproveGuardianDeniedAction { .. } => "approve_guardian_denied_action",
            Self::Shutdown => "shutdown",
            Self::RunUserShellCommand { .. } => "run_user_shell_command",
        }
    }
}

/// 决定 Codex 提议的命令在何种条件下需要请用户审批。
#[derive(
    Debug,
    Clone,
    Copy,
    Default,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    Display,
    JsonSchema,
    TS,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum AskForApproval {
    /// 仅当命令被 `is_safe_command()` 判定为"已知安全"且**仅读取文件**时才
    /// 自动批准；其余一律需要用户审批。
    #[serde(rename = "untrusted")]
    #[strum(serialize = "untrusted")]
    UnlessTrusted,

    /// 由模型决定何时请求用户审批。
    #[serde(alias = "on-failure")]
    #[default]
    OnRequest,

    /// 对各类审批流进行细粒度控制。字段为 `true` 表示允许对应类别的请求；
    /// 为 `false` 时直接拒绝，不再提示用户。
    #[strum(serialize = "granular")]
    Granular(GranularApprovalConfig),

    /// 永不请求用户审批。失败立即返回给模型，不会升级到用户。
    Never,
}

/// 细粒度审批配置。
///
/// 每个布尔字段控制一类审批提示是否允许出现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
pub struct GranularApprovalConfig {
    /// 是否允许 shell 命令审批请求（含内联的 `with_additional_permissions`
    /// 与 `require_escalated` 请求）。
    pub sandbox_approval: bool,
    /// 是否允许 execpolicy `prompt` 规则触发的提示。
    pub rules: bool,
    /// 是否允许 skill 脚本执行触发的审批提示。
    #[serde(default)]
    pub skill_approval: bool,
    /// 是否允许 `request_permissions` 工具触发的提示。
    #[serde(default)]
    pub request_permissions: bool,
    /// 是否允许 MCP elicitation 提示。
    pub mcp_elicitations: bool,
}

impl GranularApprovalConfig {
    /// 是否允许 sandbox 审批。
    pub const fn allows_sandbox_approval(self) -> bool {
        self.sandbox_approval
    }

    /// 是否允许 execpolicy 规则审批。
    pub const fn allows_rules_approval(self) -> bool {
        self.rules
    }

    /// 是否允许 skill 脚本审批。
    pub const fn allows_skill_approval(self) -> bool {
        self.skill_approval
    }

    /// 是否允许 `request_permissions` 审批。
    pub const fn allows_request_permissions(self) -> bool {
        self.request_permissions
    }

    /// 是否允许 MCP elicitation 审批。
    pub const fn allows_mcp_elicitations(self) -> bool {
        self.mcp_elicitations
    }
}

/// 表示 Agent 是否拥有出站网络访问权限。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Display, Default, JsonSchema, TS,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum NetworkAccess {
    #[default]
    /// 受限（默认）。
    Restricted,
    /// 允许出站网络。
    Enabled,
}

impl NetworkAccess {
    /// 是否为启用状态。
    pub fn is_enabled(self) -> bool {
        matches!(self, NetworkAccess::Enabled)
    }
}

/// 决定模型 shell 命令的执行限制（sandbox 策略）。序列化为带 `type` tag 的
/// kebab-case 对象。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Display, JsonSchema, TS)]
#[strum(serialize_all = "kebab-case")]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SandboxPolicy {
    /// 无任何限制。请谨慎使用。
    #[serde(rename = "danger-full-access")]
    DangerFullAccess,

    /// 只读访问配置。
    #[serde(rename = "read-only")]
    ReadOnly {
        /// 是否允许出站网络，默认 `false`。
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        network_access: bool,
    },

    /// 表示进程已位于外部 sandbox 中。允许完整磁盘访问，但仍受指定网络设置约束。
    #[serde(rename = "external-sandbox")]
    ExternalSandbox {
        /// 外部 sandbox 是否允许出站网络流量。
        #[serde(default)]
        network_access: NetworkAccess,
    },

    /// 与 `ReadOnly` 相同，但额外允许写入当前工作目录（"workspace"）。
    #[serde(rename = "workspace-write")]
    WorkspaceWrite {
        /// 除 cwd 与可能的 TMPDIR 之外，sandbox 内可写的额外目录。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        writable_roots: Vec<AbsolutePathBuf>,

        /// 是否允许出站网络，默认 `false`。
        #[serde(default)]
        network_access: bool,

        /// 为 `true` 时不将用户级 `TMPDIR` 环境变量加入默认可写根，默认 `false`。
        #[serde(default)]
        exclude_tmpdir_env_var: bool,

        /// 为 `true` 时在 UNIX 上不将 `/tmp` 加入默认可写根，默认 `false`。
        #[serde(default)]
        exclude_slash_tmp: bool,
    },
}

/// 可写根路径及其下需保持只读的子路径列表。主要用于保护可写根下可能被用于
/// 提权的目录（如 `.codex`、`.git`，尤其是 `.git/hooks`）不被 Agent 修改。
#[derive(Debug, Clone, PartialEq, Eq, JsonSchema)]
pub struct WritableRoot {
    /// 可写根路径。
    pub root: AbsolutePathBuf,

    /// 只读子路径列表（构造时保证均位于 `root` 之下）。
    pub read_only_subpaths: Vec<AbsolutePathBuf>,

    /// 受保护的 metadata 名称列表；除非策略显式授予写权限，否则这些名称不得
    /// 在 `root` 下被创建或替换。
    pub protected_metadata_names: Vec<String>,
}

impl WritableRoot {
    /// 判断给定路径是否可写。
    ///
    /// 规则：必须位于 `root` 之下；不能位于任何只读子路径之下；不能命中
    /// 受保护 metadata 名称。
    pub fn is_path_writable(&self, path: &Path) -> bool {
        // 检查路径是否位于 root 之下。
        // 路径必须位于可写根之下。
        if !path.starts_with(&self.root) {
            return false;
        }

        // 检查路径是否位于任何只读子路径之下。
        // 路径不能位于任何只读子路径之下。
        for subpath in &self.read_only_subpaths {
            if path.starts_with(subpath) {
                return false;
            }
        }

        if self.path_contains_protected_metadata_name(path) {
            return false;
        }

        true
    }

    fn path_contains_protected_metadata_name(&self, path: &Path) -> bool {
        let Ok(relative_path) = path.strip_prefix(&self.root) else {
            return false;
        };

        let Some(first_component) = relative_path.components().next() else {
            return false;
        };

        self.protected_metadata_names
            .iter()
            .any(|name| first_component.as_os_str() == std::ffi::OsStr::new(name))
    }
}

impl FromStr for SandboxPolicy {
    type Err = serde_json::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        serde_json::from_str(s)
    }
}

impl FromStr for FileSystemSandboxPolicy {
    type Err = serde_json::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        serde_json::from_str(s)
    }
}

impl FromStr for NetworkSandboxPolicy {
    type Err = serde_json::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        serde_json::from_str(s)
    }
}

impl SandboxPolicy {
    /// 返回只读磁盘访问且无网络的策略。
    pub fn new_read_only_policy() -> Self {
        SandboxPolicy::ReadOnly {
            network_access: false,
        }
    }

    /// 返回可读整盘、仅可写 cwd 与（macOS 上）用户级 tmp 目录、无网络的策略。
    pub fn new_workspace_write_policy() -> Self {
        SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![],
            network_access: false,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        }
    }

    /// 是否拥有整盘读权限（所有策略均为是）。
    pub fn has_full_disk_read_access(&self) -> bool {
        true
    }

    /// 是否拥有整盘写权限。
    pub fn has_full_disk_write_access(&self) -> bool {
        match self {
            SandboxPolicy::DangerFullAccess => true,
            SandboxPolicy::ExternalSandbox { .. } => true,
            SandboxPolicy::ReadOnly { .. } => false,
            SandboxPolicy::WorkspaceWrite { .. } => false,
        }
    }

    /// 是否拥有完整网络访问权限。
    pub fn has_full_network_access(&self) -> bool {
        match self {
            SandboxPolicy::DangerFullAccess => true,
            SandboxPolicy::ExternalSandbox { network_access } => network_access.is_enabled(),
            SandboxPolicy::ReadOnly { network_access, .. } => *network_access,
            SandboxPolicy::WorkspaceWrite { network_access, .. } => *network_access,
        }
    }

    /// 返回（结合当前工作目录计算的）可写根列表，以及每个可写根下需保持只读
    /// 的子路径。
    pub fn get_writable_roots_with_cwd(&self, cwd: &Path) -> Vec<WritableRoot> {
        match self {
            SandboxPolicy::DangerFullAccess => Vec::new(),
            SandboxPolicy::ExternalSandbox { .. } => Vec::new(),
            SandboxPolicy::ReadOnly { .. } => Vec::new(),
            SandboxPolicy::WorkspaceWrite {
                writable_roots,
                exclude_tmpdir_env_var,
                exclude_slash_tmp,
                network_access: _,
            } => {
                // 从显式配置的 writable roots 开始。
                let mut roots: Vec<AbsolutePathBuf> = writable_roots.clone();

                // Always include defaults: cwd, /tmp (if present on Unix), and
                // on macOS, the per-user TMPDIR unless explicitly excluded.
                // TODO(mbolin): cwd param should be AbsolutePathBuf.
                let cwd_absolute = AbsolutePathBuf::from_absolute_path(cwd);
                match cwd_absolute {
                    Ok(cwd) => {
                        roots.push(cwd);
                    }
                    Err(e) => {
                        error!(
                            "Ignoring invalid cwd {:?} for sandbox writable root: {}",
                            cwd, e
                        );
                    }
                }

                // Include /tmp on Unix unless explicitly excluded.
                if cfg!(unix) && !exclude_slash_tmp {
                    match AbsolutePathBuf::from_absolute_path("/tmp") {
                        Ok(slash_tmp) => {
                            if slash_tmp.as_path().is_dir() {
                                roots.push(slash_tmp);
                            }
                        }
                        Err(e) => {
                            error!("Ignoring invalid /tmp for sandbox writable root: {e}");
                        }
                    }
                }

                // Include $TMPDIR unless explicitly excluded. On macOS, TMPDIR
                // is per-user, so writes to TMPDIR should not be readable by
                // other users on the system.
                //
                // By comparison, TMPDIR is not guaranteed to be defined on
                // Linux or Windows, but supporting it here gives users a way to
                // provide the model with their own temporary directory without
                // having to hardcode it in the config.
                if !exclude_tmpdir_env_var
                    && let Some(tmpdir) = std::env::var_os("TMPDIR")
                    && !tmpdir.is_empty()
                {
                    match AbsolutePathBuf::from_absolute_path(PathBuf::from(&tmpdir)) {
                        Ok(tmpdir_path) => {
                            roots.push(tmpdir_path);
                        }
                        Err(e) => {
                            error!(
                                "Ignoring invalid TMPDIR value {tmpdir:?} for sandbox writable root: {e}",
                            );
                        }
                    }
                }

                // For each root, compute subpaths that should remain read-only.
                let cwd_root = AbsolutePathBuf::from_absolute_path(cwd).ok();
                roots
                    .into_iter()
                    .map(|writable_root| {
                        let protect_missing_dot_codex = cwd_root
                            .as_ref()
                            .is_some_and(|cwd_root| cwd_root == &writable_root);
                        WritableRoot {
                            read_only_subpaths: default_read_only_subpaths_for_writable_root(
                                &writable_root,
                                protect_missing_dot_codex,
                            ),
                            protected_metadata_names: Vec::new(),
                            root: writable_root,
                        }
                    })
                    .collect()
            }
        }
    }
}

/// 事件队列条目（来自 Agent 的事件）。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Event {
    /// 与本事件关联的 submission `id`。
    pub id: String,
    /// 事件负载。
    pub msg: EventMsg,
}

/// Agent 响应事件。
/// 注意：所有变体均不得使用 `Option` 类型，否则会破坏扩展层的 code-gen。
#[derive(Debug, Clone, Deserialize, Serialize, Display, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type")]
#[strum(serialize_all = "snake_case")]
pub enum EventMsg {
    /// 执行 submission 时出错。
    Error(ErrorEvent),

    /// 处理 submission 时产生的告警。与 `Error` 不同，turn 会继续进行，
    /// 但仍需通知用户。
    Warning(WarningEvent),

    /// Guardian 自动审批审查器产生的告警。
    GuardianWarning(WarningEvent),

    /// Realtime 会话生命周期开始事件。
    RealtimeConversationStarted(RealtimeConversationStartedEvent),

    /// Realtime 会话流式 payload 事件。
    RealtimeConversationRealtime(RealtimeConversationRealtimeEvent),

    /// Realtime 会话生命周期关闭事件。
    RealtimeConversationClosed(RealtimeConversationClosedEvent),

    /// Realtime session description protocol payload。
    RealtimeConversationSdp(RealtimeConversationSdpEvent),

    /// 模型路由从请求的模型切换到其他模型。
    ModelReroute(ModelRerouteEvent),

    /// 后端建议本轮进行额外的账户验证。
    ModelVerification(ModelVerificationEvent),

    /// 后端 moderation metadata，用于第一方 turn 展示。
    TurnModerationMetadata(TurnModerationMetadataEvent),

    /// 后端表示响应输出正在等待安全审核。
    SafetyBuffering(SafetyBufferingEvent),

    /// 对话历史被压缩（自动或手动触发）。
    ContextCompacted(ContextCompactedEvent),

    /// 对话历史被回滚，丢弃了最近 N 轮用户对话。
    ThreadRolledBack(ThreadRolledBackEvent),

    /// Agent 已开始一个 turn。
    /// v1 wire 格式使用 `task_started`；同时接受 `turn_started` 以兼容 v2。
    #[serde(rename = "task_started", alias = "turn_started")]
    TurnStarted(TurnStartedEvent),

    /// 关联 submission 中的持久化 thread 级设置覆盖已被应用到会话配置。
    ThreadSettingsApplied(ThreadSettingsAppliedEvent),

    /// Agent 已完成所有动作。
    /// v1 wire 格式使用 `task_complete`；同时接受 `turn_complete` 以兼容 v2。
    #[serde(rename = "task_complete", alias = "turn_complete")]
    TurnComplete(TurnCompleteEvent),

    /// 当前会话的 token 用量更新（含累计与上一轮）。
    /// 字段为 `Option` 表示未知，UI 在为 `None` 时不应展示。
    TokenCount(TokenCountEvent),

    /// Agent 文本输出消息。
    AgentMessage(AgentMessageEvent),

    /// 用户 / 系统输入消息（发送给模型的内容）。
    UserMessage(UserMessageEvent),

    /// Agent 推理事件。
    AgentReasoning(AgentReasoningEvent),

    /// Agent 原始思维链（chain-of-thought）。
    AgentReasoningRawContent(AgentReasoningRawContentEvent),

    /// 模型开始新的推理摘要段（例如新的带标题块）时发出。
    AgentReasoningSectionBreak(AgentReasoningSectionBreakEvent),

    /// 对客户端 configure 消息的确认。
    SessionConfigured(SessionConfiguredEvent),

    /// 更新后的 thread 长期目标 metadata。
    ThreadGoalUpdated(ThreadGoalUpdatedEvent),

    /// MCP 启动过程的增量进度更新。
    McpStartupUpdate(McpStartupUpdateEvent),

    /// MCP 启动完成的汇总信息。
    McpStartupComplete(McpStartupCompleteEvent),

    McpToolCallBegin(McpToolCallBeginEvent),

    McpToolCallEnd(McpToolCallEndEvent),

    WebSearchBegin(WebSearchBeginEvent),

    WebSearchEnd(WebSearchEndEvent),

    ImageGenerationBegin(ImageGenerationBeginEvent),

    ImageGenerationEnd(ImageGenerationEndEvent),

    /// 服务端即将执行命令时发出。
    ExecCommandBegin(ExecCommandBeginEvent),

    /// 运行中命令的增量输出块。
    ExecCommandOutputDelta(ExecCommandOutputDeltaEvent),

    /// 进行中命令的终端交互（已发送 stdin 且观察到 stdout）。
    TerminalInteraction(TerminalInteractionEvent),

    ExecCommandEnd(ExecCommandEndEvent),

    /// Agent 通过 view_image 工具附加了本地图像时发出。
    ViewImageToolCall(ViewImageToolCallEvent),

    ExecApprovalRequest(ExecApprovalRequestEvent),

    RequestPermissions(RequestPermissionsEvent),

    RequestUserInput(RequestUserInputEvent),

    DynamicToolCallRequest(DynamicToolCallRequest),

    DynamicToolCallResponse(DynamicToolCallResponseEvent),

    ElicitationRequest(ElicitationRequestEvent),

    ApplyPatchApprovalRequest(ApplyPatchApprovalRequestEvent),

    /// 经 Guardian 审查的审批请求的结构化生命周期事件。
    GuardianAssessment(GuardianAssessmentEvent),

    /// 提示用户某项正在使用的功能已被废弃，应逐步迁移。
    DeprecationNotice(DeprecationNoticeEvent),

    /// 模型流发生错误或断开，系统正在处理（如带退避的重试）。
    StreamError(StreamErrorEvent),

    /// Agent 即将应用代码补丁时发出。镜像 `ExecCommandBegin`，
    /// 便于前端展示进度指示器。
    PatchApplyBegin(PatchApplyBeginEvent),

    /// `apply_patch` 调用最新的模型生成结构化变更。
    PatchApplyUpdated(PatchApplyUpdatedEvent),

    /// 补丁应用完成时发出。
    PatchApplyEnd(PatchApplyEndEvent),

    TurnDiff(TurnDiffEvent),

    /// realtime 会话流支持的语音列表。
    RealtimeConversationListVoicesResponse(RealtimeConversationListVoicesResponseEvent),

    PlanUpdate(UpdatePlanArgs),

    TurnAborted(TurnAbortedEvent),

    /// Agent 关闭完成时发出。
    ShutdownComplete,

    /// 进入 review 模式。
    EnteredReviewMode(ReviewRequest),

    /// 退出 review 模式，可能携带最终结果用于应用。
    ExitedReviewMode(ExitedReviewModeEvent),

    RawResponseItem(RawResponseItemEvent),

    ItemStarted(ItemStartedEvent),
    ItemCompleted(ItemCompletedEvent),
    HookStarted(HookStartedEvent),
    HookCompleted(HookCompletedEvent),

    AgentMessageContentDelta(AgentMessageContentDeltaEvent),
    PlanDelta(PlanDeltaEvent),
    ReasoningContentDelta(ReasoningContentDeltaEvent),
    ReasoningRawContentDelta(ReasoningRawContentDeltaEvent),

    /// Collab 交互：子 Agent 生成开始。
    CollabAgentSpawnBegin(CollabAgentSpawnBeginEvent),
    /// Collab 交互：子 Agent 生成结束。
    CollabAgentSpawnEnd(CollabAgentSpawnEndEvent),
    /// Collab 交互：Agent 间交互开始。
    CollabAgentInteractionBegin(CollabAgentInteractionBeginEvent),
    /// Collab 交互：Agent 间交互结束。
    CollabAgentInteractionEnd(CollabAgentInteractionEndEvent),
    /// Collab 交互：等待开始。
    CollabWaitingBegin(CollabWaitingBeginEvent),
    /// Collab 交互：等待结束。
    CollabWaitingEnd(CollabWaitingEndEvent),
    /// Collab 交互：关闭开始。
    CollabCloseBegin(CollabCloseBeginEvent),
    /// Collab 交互：关闭结束。
    CollabCloseEnd(CollabCloseEndEvent),
    /// Collab 交互：恢复开始。
    CollabResumeBegin(CollabResumeBeginEvent),
    /// Collab 交互：恢复结束。
    CollabResumeEnd(CollabResumeEndEvent),

    /// 基于路径的 v2 子 Agent 活动事件。
    SubAgentActivity(SubAgentActivityEvent),
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS, EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum HookEventName {
    PreToolUse,
    PermissionRequest,
    PostToolUse,
    PreCompact,
    PostCompact,
    SessionStart,
    UserPromptSubmit,
    SubagentStart,
    SubagentStop,
    Stop,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HookHandlerType {
    Command,
    Prompt,
    Agent,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HookExecutionMode {
    Sync,
    Async,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HookScope {
    Thread,
    Turn,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HookSource {
    System,
    User,
    Project,
    Mdm,
    SessionFlags,
    Plugin,
    CloudRequirements,
    CloudManagedConfig,
    LegacyManagedConfigFile,
    LegacyManagedConfigMdm,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HookTrustStatus {
    Managed,
    Untrusted,
    Trusted,
    Modified,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HookRunStatus {
    Running,
    Completed,
    Failed,
    Blocked,
    Stopped,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HookOutputEntryKind {
    Warning,
    Stop,
    Feedback,
    Context,
    Error,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub struct HookOutputEntry {
    pub kind: HookOutputEntryKind,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub struct HookRunSummary {
    pub id: String,
    pub event_name: HookEventName,
    pub handler_type: HookHandlerType,
    pub execution_mode: HookExecutionMode,
    pub scope: HookScope,
    pub source_path: AbsolutePathBuf,
    #[serde(default)]
    pub source: HookSource,
    pub display_order: i64,
    pub status: HookRunStatus,
    pub status_message: Option<String>,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub completed_at: Option<i64>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<i64>,
    pub entries: Vec<HookOutputEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub struct HookStartedEvent {
    pub turn_id: Option<String>,
    pub run: HookRunSummary,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub struct HookCompletedEvent {
    pub turn_id: Option<String>,
    pub run: HookRunSummary,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeConversationVersion {
    V1,
    #[default]
    V2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct RealtimeConversationStartedEvent {
    pub realtime_session_id: Option<String>,
    pub version: RealtimeConversationVersion,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct RealtimeConversationRealtimeEvent {
    pub payload: RealtimeEvent,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct RealtimeConversationClosedEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct RealtimeConversationSdpEvent {
    pub sdp: String,
}

impl From<CollabAgentSpawnBeginEvent> for EventMsg {
    fn from(event: CollabAgentSpawnBeginEvent) -> Self {
        EventMsg::CollabAgentSpawnBegin(event)
    }
}

impl From<CollabAgentSpawnEndEvent> for EventMsg {
    fn from(event: CollabAgentSpawnEndEvent) -> Self {
        EventMsg::CollabAgentSpawnEnd(event)
    }
}

impl From<CollabAgentInteractionBeginEvent> for EventMsg {
    fn from(event: CollabAgentInteractionBeginEvent) -> Self {
        EventMsg::CollabAgentInteractionBegin(event)
    }
}

impl From<CollabAgentInteractionEndEvent> for EventMsg {
    fn from(event: CollabAgentInteractionEndEvent) -> Self {
        EventMsg::CollabAgentInteractionEnd(event)
    }
}

impl From<CollabWaitingBeginEvent> for EventMsg {
    fn from(event: CollabWaitingBeginEvent) -> Self {
        EventMsg::CollabWaitingBegin(event)
    }
}

impl From<CollabWaitingEndEvent> for EventMsg {
    fn from(event: CollabWaitingEndEvent) -> Self {
        EventMsg::CollabWaitingEnd(event)
    }
}

impl From<CollabCloseBeginEvent> for EventMsg {
    fn from(event: CollabCloseBeginEvent) -> Self {
        EventMsg::CollabCloseBegin(event)
    }
}

impl From<CollabCloseEndEvent> for EventMsg {
    fn from(event: CollabCloseEndEvent) -> Self {
        EventMsg::CollabCloseEnd(event)
    }
}

impl From<CollabResumeBeginEvent> for EventMsg {
    fn from(event: CollabResumeBeginEvent) -> Self {
        EventMsg::CollabResumeBegin(event)
    }
}

impl From<CollabResumeEndEvent> for EventMsg {
    fn from(event: CollabResumeEndEvent) -> Self {
        EventMsg::CollabResumeEnd(event)
    }
}

impl From<SubAgentActivityEvent> for EventMsg {
    fn from(event: SubAgentActivityEvent) -> Self {
        EventMsg::SubAgentActivity(event)
    }
}

/// Agent 生命周期状态，由已发出的事件推导而来。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentStatus {
    /// Agent 正在等待初始化。
    #[default]
    PendingInit,
    /// Agent 正在运行。
    Running,
    /// Agent 当前 turn 被中断，可能接收更多输入。
    Interrupted,
    /// Agent 已完成。携带最终的 assistant 消息。
    Completed(Option<String>),
    /// Agent 遇到错误。
    Errored(String),
    /// Agent 已被关闭。
    Shutdown,
    /// Agent 未找到。
    NotFound,
}

/// 不接受同 turn 内 steering 的 turn 类型。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum NonSteerableTurnKind {
    Review,
    Compact,
}

/// 暴露给客户端的 Codex 错误信息。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum CodexErrorInfo {
    ContextWindowExceeded,
    SessionBudgetExceeded,
    UsageLimitExceeded,
    ServerOverloaded,
    CyberPolicy,
    HttpConnectionFailed {
        http_status_code: Option<u16>,
    },
    /// 连接 response SSE 流失败。
    ResponseStreamConnectionFailed {
        http_status_code: Option<u16>,
    },
    InternalServerError,
    Unauthorized,
    BadRequest,
    SandboxError,
    /// response SSE 流在 turn 完成前断开。
    ResponseStreamDisconnected {
        http_status_code: Option<u16>,
    },
    /// 已达到 response 重试次数上限。
    ResponseTooManyFailedAttempts {
        http_status_code: Option<u16>,
    },
    /// 当 `turn/start` 或 `turn/steer` 在当前活动 turn 不支持同 turn steering
    /// 时（例如 `/review` 或手动 `/compact`）返回。
    ActiveTurnNotSteerable {
        turn_kind: NonSteerableTurnKind,
    },
    ThreadRollbackFailed,
    Other,
}

impl CodexErrorInfo {
    /// 重放历史时此错误是否应将当前 turn 标记为失败。
    pub fn affects_turn_status(&self) -> bool {
        match self {
            Self::ThreadRollbackFailed | Self::ActiveTurnNotSteerable { .. } => false,
            Self::ContextWindowExceeded
            | Self::SessionBudgetExceeded
            | Self::UsageLimitExceeded
            | Self::ServerOverloaded
            | Self::CyberPolicy
            | Self::HttpConnectionFailed { .. }
            | Self::ResponseStreamConnectionFailed { .. }
            | Self::InternalServerError
            | Self::Unauthorized
            | Self::BadRequest
            | Self::SandboxError
            | Self::ResponseStreamDisconnected { .. }
            | Self::ResponseTooManyFailedAttempts { .. }
            | Self::Other => true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct RawResponseItemEvent {
    pub item: ResponseItem,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct ItemStartedEvent {
    pub thread_id: ThreadId,
    pub turn_id: String,
    pub item: TurnItem,
    pub started_at_ms: i64,
}

impl HasLegacyEvent for ItemStartedEvent {
    fn as_legacy_events(&self, _: bool) -> Vec<EventMsg> {
        match &self.item {
            TurnItem::WebSearch(item) => vec![EventMsg::WebSearchBegin(WebSearchBeginEvent {
                call_id: item.id.clone(),
            })],
            TurnItem::ImageView(_) => Vec::new(),
            TurnItem::ImageGeneration(item) => {
                vec![EventMsg::ImageGenerationBegin(ImageGenerationBeginEvent {
                    call_id: item.id.clone(),
                })]
            }
            TurnItem::FileChange(item) => vec![item.as_legacy_begin_event(self.turn_id.clone())],
            TurnItem::McpToolCall(item) => vec![item.as_legacy_begin_event()],
            _ => Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct ItemCompletedEvent {
    pub thread_id: ThreadId,
    pub turn_id: String,
    pub item: TurnItem,
    // Old rollout files may contain ItemCompleted events for PlanItem without
    // this field. Default to 0 so those persisted rollouts still deserialize
    // after tightening the core event contract.
    #[serde(default = "default_item_completed_at_ms")]
    pub completed_at_ms: i64,
}

const fn default_item_completed_at_ms() -> i64 {
    0
}

pub trait HasLegacyEvent {
    fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>;
}

impl HasLegacyEvent for ItemCompletedEvent {
    fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg> {
        match &self.item {
            TurnItem::FileChange(item) => item
                .as_legacy_end_event(self.turn_id.clone())
                .into_iter()
                .collect(),
            _ => self.item.as_legacy_events(show_raw_agent_reasoning),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct AgentMessageContentDeltaEvent {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
}

impl HasLegacyEvent for AgentMessageContentDeltaEvent {
    fn as_legacy_events(&self, _: bool) -> Vec<EventMsg> {
        Vec::new()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct PlanDeltaEvent {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct ReasoningContentDeltaEvent {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
    // load with default value so it's backward compatible with the old format.
    #[serde(default)]
    pub summary_index: i64,
}

impl HasLegacyEvent for ReasoningContentDeltaEvent {
    fn as_legacy_events(&self, _: bool) -> Vec<EventMsg> {
        Vec::new()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
pub struct ReasoningRawContentDeltaEvent {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
    // load with default value so it's backward compatible with the old format.
    #[serde(default)]
    pub content_index: i64,
}

impl HasLegacyEvent for ReasoningRawContentDeltaEvent {
    fn as_legacy_events(&self, _: bool) -> Vec<EventMsg> {
        Vec::new()
    }
}

impl HasLegacyEvent for EventMsg {
    fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg> {
        match self {
            EventMsg::ItemStarted(event) => event.as_legacy_events(show_raw_agent_reasoning),
            EventMsg::ItemCompleted(event) => event.as_legacy_events(show_raw_agent_reasoning),
            EventMsg::AgentMessageContentDelta(event) => {
                event.as_legacy_events(show_raw_agent_reasoning)
            }
            EventMsg::ReasoningContentDelta(event) => {
                event.as_legacy_events(show_raw_agent_reasoning)
            }
            EventMsg::ReasoningRawContentDelta(event) => {
                event.as_legacy_events(show_raw_agent_reasoning)
            }
            _ => Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ExitedReviewModeEvent {
    pub review_output: Option<ReviewOutputEvent>,
}

// Individual event payload types matching each `EventMsg` variant.

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ErrorEvent {
    pub message: String,
    #[serde(default)]
    pub codex_error_info: Option<CodexErrorInfo>,
}

impl ErrorEvent {
    /// 重放历史时此错误是否应将当前 turn 标记为失败。
    pub fn affects_turn_status(&self) -> bool {
        self.codex_error_info
            .as_ref()
            .is_none_or(CodexErrorInfo::affects_turn_status)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct WarningEvent {
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ModelRerouteReason {
    HighRiskCyberActivity,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct ModelRerouteEvent {
    pub from_model: String,
    pub to_model: String,
    pub reason: ModelRerouteReason,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ModelVerification {
    TrustedAccessForCyber,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct ModelVerificationEvent {
    pub verifications: Vec<ModelVerification>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct TurnModerationMetadataEvent {
    pub metadata: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct SafetyBufferingEvent {
    pub model: String,
    pub use_cases: Vec<String>,
    pub reasons: Vec<String>,
    pub show_buffering_ui: bool,
    pub faster_model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ContextCompactedEvent;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct TurnCompleteEvent {
    pub turn_id: String,
    pub last_agent_message: Option<String>,
    /// turn 完成的 Unix 时间戳（秒）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null", optional)]
    pub completed_at: Option<i64>,
    /// turn 开始到完成之间的耗时（毫秒），若已知。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null", optional)]
    pub duration_ms: Option<i64>,
    /// turn 开始到第一个 model token 之间的耗时（毫秒），若已知。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null", optional)]
    pub time_to_first_token_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct TurnStartedEvent {
    pub turn_id: String,
    // 为 rollout 消费者保留，用于将 turn 与 telemetry trace 关联。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trace_id: Option<String>,
    /// turn 开始的 Unix 时间戳（秒）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null", optional)]
    pub started_at: Option<i64>,
    // TODO(aibrahim): make this not optional
    pub model_context_window: Option<i64>,
    #[serde(default)]
    pub collaboration_mode_kind: ModeKind,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ThreadSettingsAppliedEvent {
    pub thread_settings: ThreadSettingsSnapshot,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ThreadSettingsSnapshot {
    pub model: String,
    pub model_provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    pub approval_policy: AskForApproval,
    pub approvals_reviewer: ApprovalsReviewer,
    pub permission_profile: PermissionProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_permission_profile: Option<ActivePermissionProfile>,
    pub cwd: AbsolutePathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffortConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<ReasoningSummaryConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personality: Option<Personality>,
    pub collaboration_mode: CollaborationMode,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq, JsonSchema, TS)]
pub struct TokenUsage {
    #[ts(type = "number")]
    pub input_tokens: i64,
    #[ts(type = "number")]
    pub cached_input_tokens: i64,
    #[ts(type = "number")]
    pub output_tokens: i64,
    #[ts(type = "number")]
    pub reasoning_output_tokens: i64,
    #[ts(type = "number")]
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct TokenUsageInfo {
    pub total_token_usage: TokenUsage,
    pub last_token_usage: TokenUsage,
    // TODO(aibrahim): make this not optional
    #[ts(type = "number | null")]
    pub model_context_window: Option<i64>,
}

impl TokenUsageInfo {
    pub fn new_or_append(
        info: &Option<TokenUsageInfo>,
        last: &Option<TokenUsage>,
        model_context_window: Option<i64>,
    ) -> Option<Self> {
        if info.is_none() && last.is_none() {
            return None;
        }

        let mut info = match info {
            Some(info) => info.clone(),
            None => Self {
                total_token_usage: TokenUsage::default(),
                last_token_usage: TokenUsage::default(),
                model_context_window,
            },
        };
        if let Some(last) = last {
            info.append_last_usage(last);
        }
        if let Some(model_context_window) = model_context_window {
            info.model_context_window = Some(model_context_window);
        }
        Some(info)
    }

    pub fn append_last_usage(&mut self, last: &TokenUsage) {
        self.total_token_usage.add_assign(last);
        self.last_token_usage = last.clone();
    }

    pub fn fill_to_context_window(&mut self, context_window: i64) {
        let previous_total = self.total_token_usage.total_tokens;
        let delta = (context_window - previous_total).max(0);

        self.model_context_window = Some(context_window);
        self.total_token_usage = TokenUsage {
            total_tokens: context_window,
            ..TokenUsage::default()
        };
        self.last_token_usage = TokenUsage {
            total_tokens: delta,
            ..TokenUsage::default()
        };
    }

    pub fn full_context_window(context_window: i64) -> Self {
        let mut info = Self {
            total_token_usage: TokenUsage::default(),
            last_token_usage: TokenUsage::default(),
            model_context_window: Some(context_window),
        };
        info.fill_to_context_window(context_window);
        info
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct TokenCountEvent {
    pub info: Option<TokenUsageInfo>,
    pub rate_limits: Option<RateLimitSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema, TS)]
pub struct RateLimitSnapshot {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub primary: Option<RateLimitWindow>,
    pub secondary: Option<RateLimitWindow>,
    pub credits: Option<CreditsSnapshot>,
    pub individual_limit: Option<SpendControlLimitSnapshot>,
    pub plan_type: Option<crate::account::PlanType>,
    pub rate_limit_reached_type: Option<RateLimitReachedType>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum RateLimitReachedType {
    RateLimitReached,
    WorkspaceOwnerCreditsDepleted,
    WorkspaceMemberCreditsDepleted,
    WorkspaceOwnerUsageLimitReached,
    WorkspaceMemberUsageLimitReached,
}

impl FromStr for RateLimitReachedType {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "rate_limit_reached" => Ok(Self::RateLimitReached),
            "workspace_owner_credits_depleted" => Ok(Self::WorkspaceOwnerCreditsDepleted),
            "workspace_member_credits_depleted" => Ok(Self::WorkspaceMemberCreditsDepleted),
            "workspace_owner_usage_limit_reached" => Ok(Self::WorkspaceOwnerUsageLimitReached),
            "workspace_member_usage_limit_reached" => Ok(Self::WorkspaceMemberUsageLimitReached),
            other => Err(format!("unknown rate limit reached type: {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema, TS)]
pub struct RateLimitWindow {
    /// 窗口已消耗的百分比（0-100）。
    pub used_percent: f64,
    /// 滚动窗口时长（分钟）。
    #[ts(type = "number | null")]
    pub window_minutes: Option<i64>,
    /// 窗口重置的 Unix 时间戳（秒）。
    #[ts(type = "number | null")]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema, TS)]
pub struct CreditsSnapshot {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema, TS)]
pub struct SpendControlLimitSnapshot {
    pub limit: String,
    pub used: String,
    pub remaining_percent: i32,
    pub resets_at: i64,
}

// Includes prompts, tools and space to call compact.
const BASELINE_TOKENS: i64 = 12000;

impl TokenUsage {
    pub fn is_zero(&self) -> bool {
        self.total_tokens == 0
    }

    pub fn cached_input(&self) -> i64 {
        self.cached_input_tokens.max(0)
    }

    pub fn non_cached_input(&self) -> i64 {
        (self.input_tokens - self.cached_input()).max(0)
    }

    /// 主要用于展示为单一绝对值的计数：非缓存 input + output。
    pub fn blended_total(&self) -> i64 {
        (self.non_cached_input() + self.output_tokens.max(0)).max(0)
    }

    pub fn tokens_in_context_window(&self) -> i64 {
        self.total_tokens
    }

    /// 估算模型上下文窗口中剩余的可由用户控制部分的百分比。
    ///
    /// `context_window` 为模型上下文窗口总大小。`BASELINE_TOKENS` 用于扣除
    /// 始终存在的 token（如系统提示词与固定的工具指令），使百分比反映
    /// 用户可影响的部分。
    ///
    /// 通过同时从分子与分母中减去 baseline 进行归一化，使得首个 prompt
    /// 之后 UI 显示 100% 剩余，并随用户填充有效窗口趋向 0%。
    pub fn percent_of_context_window_remaining(&self, context_window: i64) -> i64 {
        if context_window <= BASELINE_TOKENS {
            return 0;
        }

        let effective_window = context_window - BASELINE_TOKENS;
        let used = (self.tokens_in_context_window() - BASELINE_TOKENS).max(0);
        let remaining = (effective_window - used).max(0);
        ((remaining as f64 / effective_window as f64) * 100.0)
            .clamp(0.0, 100.0)
            .round() as i64
    }

    /// 原地按元素累加 token 计数。
    pub fn add_assign(&mut self, other: &TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_output_tokens += other.reasoning_output_tokens;
        self.total_tokens += other.total_tokens;
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct FinalOutput {
    pub token_usage: TokenUsage,
}

impl From<TokenUsage> for FinalOutput {
    fn from(token_usage: TokenUsage) -> Self {
        Self { token_usage }
    }
}

impl fmt::Display for FinalOutput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let token_usage = &self.token_usage;

        write!(
            f,
            "Token usage: total={} input={}{} output={}{}",
            format_with_separators(token_usage.blended_total()),
            format_with_separators(token_usage.non_cached_input()),
            if token_usage.cached_input() > 0 {
                format!(
                    " (+ {} cached)",
                    format_with_separators(token_usage.cached_input())
                )
            } else {
                String::new()
            },
            format_with_separators(token_usage.output_tokens),
            if token_usage.reasoning_output_tokens > 0 {
                format!(
                    " (reasoning {})",
                    format_with_separators(token_usage.reasoning_output_tokens)
                )
            } else {
                String::new()
            }
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct AgentMessageEvent {
    pub message: String,
    #[serde(default)]
    pub phase: Option<MessagePhase>,
    #[serde(default)]
    pub memory_citation: Option<MemoryCitation>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
pub struct UserMessageEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub message: String,
    /// 来自 `UserInput::Image` 的图像 URL。这些 URL 可安全地在旧版 UI 历史
    /// 事件中重放，对应发送给模型的图像。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    /// `images` 的 detail hint，按相同索引对应。缺失项表示使用默认 detail。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_details: Vec<Option<ImageDetail>>,
    /// 来自 `UserInput::LocalImage` 的本地文件路径。保留以便 UI 在编辑历史时
    /// 重新附加图像。本地图像 prompt 可能包含路径的展示形式，但不应被视为
    /// API 可用的 URL。
    #[serde(default)]
    pub local_images: Vec<std::path::PathBuf>,
    /// `local_images` 的 detail hint，按相同索引对应。缺失项表示使用默认 detail。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub local_image_details: Vec<Option<ImageDetail>>,
    /// UI 在 `message` 中定义的 span，用于渲染或持久化特殊元素。
    #[serde(default)]
    pub text_elements: Vec<crate::user_input::TextElement>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct AgentReasoningEvent {
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct AgentReasoningRawContentEvent {
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct AgentReasoningSectionBreakEvent {
    // load with default value so it's backward compatible with the old format.
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub summary_index: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
pub struct McpInvocation {
    /// MCP server 在配置中定义的名称。
    pub server: String,
    /// MCP server 提供的 tool 名称。
    pub tool: String,
    /// tool 调用参数。
    pub arguments: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
pub struct McpToolCallBeginEvent {
    /// 调用标识，用于与 McpToolCallEnd 事件配对。
    pub call_id: String,
    pub invocation: McpInvocation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub connector_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mcp_app_resource_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub app_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub action_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plugin_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
pub struct McpToolCallEndEvent {
    /// 对应的 McpToolCallBegin 的标识，表示该调用已完成。
    pub call_id: String,
    pub invocation: McpInvocation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub connector_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mcp_app_resource_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub app_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub action_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plugin_id: Option<String>,
    #[ts(type = "string")]
    pub duration: Duration,
    /// tool 调用结果。注意：可能是错误。
    pub result: Result<CallToolResult, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
pub struct DynamicToolCallResponseEvent {
    /// 对应的 DynamicToolCallRequest 的标识。
    pub call_id: String,
    /// 本 dynamic tool 调用所属的 turn ID。
    pub turn_id: String,
    #[serde(default)]
    pub completed_at_ms: i64,
    /// dynamic tool 命名空间（若提供）。
    #[serde(default)]
    pub namespace: Option<String>,
    /// dynamic tool 名称。
    pub tool: String,
    /// dynamic tool 调用参数。
    pub arguments: serde_json::Value,
    /// dynamic tool 响应的内容条目。
    pub content_items: Vec<DynamicToolCallOutputContentItem>,
    /// tool 调用是否成功。
    pub success: bool,
    /// tool 调用失败（在产生响应前）时的可选错误文本。
    pub error: Option<String>,
    /// dynamic tool 调用耗时。
    #[ts(type = "string")]
    pub duration: Duration,
}

impl McpToolCallEndEvent {
    pub fn is_success(&self) -> bool {
        match &self.result {
            Ok(result) => !result.is_error.unwrap_or(false),
            Err(_) => false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct WebSearchBeginEvent {
    pub call_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct WebSearchEndEvent {
    pub call_id: String,
    pub query: String,
    pub action: WebSearchAction,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ImageGenerationBeginEvent {
    pub call_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ImageGenerationEndEvent {
    pub call_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub revised_prompt: Option<String>,
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub saved_path: Option<AbsolutePathBuf>,
}

// Conversation kept for backward compatibility.
/// `Op::GetHistory` 的响应负载，包含当前会话的内存 transcript。
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ConversationPathResponseEvent {
    pub conversation_id: ThreadId,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ResumedHistory {
    pub conversation_id: ThreadId,
    pub history: Arc<Vec<RolloutItem>>,
    pub rollout_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub enum InitialHistory {
    New,
    Cleared,
    Resumed(ResumedHistory),
    Forked(Vec<RolloutItem>),
}

impl InitialHistory {
    pub fn scan_rollout_items(&self, mut predicate: impl FnMut(&RolloutItem) -> bool) -> bool {
        match self {
            InitialHistory::New | InitialHistory::Cleared => false,
            InitialHistory::Resumed(resumed) => resumed.history.iter().any(&mut predicate),
            InitialHistory::Forked(items) => items.iter().any(predicate),
        }
    }

    pub fn forked_from_id(&self) -> Option<ThreadId> {
        match self {
            InitialHistory::New | InitialHistory::Cleared => None,
            InitialHistory::Resumed(resumed) => {
                resumed.history.iter().find_map(|item| match item {
                    RolloutItem::SessionMeta(meta_line) => meta_line.meta.forked_from_id,
                    _ => None,
                })
            }
            InitialHistory::Forked(items) => items.iter().find_map(|item| match item {
                RolloutItem::SessionMeta(meta_line) => Some(meta_line.meta.id),
                _ => None,
            }),
        }
    }

    pub fn session_cwd(&self) -> Option<PathBuf> {
        match self {
            InitialHistory::New | InitialHistory::Cleared => None,
            InitialHistory::Resumed(resumed) => session_cwd_from_items(&resumed.history),
            InitialHistory::Forked(items) => session_cwd_from_items(items),
        }
    }

    pub fn get_rollout_items(&self) -> &[RolloutItem] {
        match self {
            InitialHistory::New | InitialHistory::Cleared => &[],
            InitialHistory::Resumed(resumed) => &resumed.history,
            InitialHistory::Forked(items) => items,
        }
    }

    pub fn get_event_msgs(&self) -> Option<Vec<EventMsg>> {
        match self {
            InitialHistory::New | InitialHistory::Cleared => None,
            InitialHistory::Resumed(resumed) => Some(
                resumed
                    .history
                    .iter()
                    .filter_map(|ri| match ri {
                        RolloutItem::EventMsg(ev) => Some(ev.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
            InitialHistory::Forked(items) => Some(
                items
                    .iter()
                    .filter_map(|ri| match ri {
                        RolloutItem::EventMsg(ev) => Some(ev.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
        }
    }

    pub fn get_base_instructions(&self) -> Option<BaseInstructions> {
        // TODO: SessionMeta should (in theory) always be first in the history, so we can probably only check the first item?
        match self {
            InitialHistory::New | InitialHistory::Cleared => None,
            InitialHistory::Resumed(resumed) => {
                resumed.history.iter().find_map(|item| match item {
                    RolloutItem::SessionMeta(meta_line) => meta_line.meta.base_instructions.clone(),
                    _ => None,
                })
            }
            InitialHistory::Forked(items) => items.iter().find_map(|item| match item {
                RolloutItem::SessionMeta(meta_line) => meta_line.meta.base_instructions.clone(),
                _ => None,
            }),
        }
    }

    pub fn get_dynamic_tools(&self) -> Option<Vec<DynamicToolSpec>> {
        match self {
            InitialHistory::New | InitialHistory::Cleared => None,
            InitialHistory::Resumed(resumed) => {
                resumed.history.iter().find_map(|item| match item {
                    RolloutItem::SessionMeta(meta_line) => meta_line.meta.dynamic_tools.clone(),
                    _ => None,
                })
            }
            InitialHistory::Forked(items) => items.iter().find_map(|item| match item {
                RolloutItem::SessionMeta(meta_line) => meta_line.meta.dynamic_tools.clone(),
                _ => None,
            }),
        }
    }

    pub fn get_selected_capability_roots(&self) -> Vec<SelectedCapabilityRoot> {
        self.get_session_meta()
            .map(|meta| meta.selected_capability_roots.clone())
            .unwrap_or_default()
    }

    pub fn get_multi_agent_version(&self) -> Option<MultiAgentVersion> {
        match self {
            InitialHistory::New | InitialHistory::Cleared => None,
            InitialHistory::Resumed(resumed) => {
                multi_agent_version_from_items(&resumed.history, Some(resumed.conversation_id))
            }
            InitialHistory::Forked(items) => {
                multi_agent_version_from_items(items, /*thread_id*/ None)
            }
        }
    }

    pub fn get_history_mode(&self, default_history_mode: ThreadHistoryMode) -> ThreadHistoryMode {
        match self {
            InitialHistory::New | InitialHistory::Cleared | InitialHistory::Forked(_) => {
                default_history_mode
            }
            InitialHistory::Resumed(_) => self
                .get_resumed_session_meta()
                .map(|meta| meta.history_mode)
                .unwrap_or(default_history_mode),
        }
    }

    pub fn get_latest_effective_multi_agent_mode(&self) -> Option<MultiAgentMode> {
        let items = match self {
            InitialHistory::New | InitialHistory::Cleared => return None,
            InitialHistory::Resumed(resumed) => &resumed.history,
            InitialHistory::Forked(items) => items,
        };
        items
            .iter()
            .rev()
            .find_map(|item| match item {
                RolloutItem::TurnContext(turn_context) => Some(turn_context),
                RolloutItem::SessionMeta(_)
                | RolloutItem::ResponseItem(_)
                | RolloutItem::InterAgentCommunication(_)
                | RolloutItem::InterAgentCommunicationMetadata { .. }
                | RolloutItem::Compacted(_)
                | RolloutItem::WorldState(_)
                | RolloutItem::EventMsg(_) => None,
            })
            .and_then(|turn_context| turn_context.multi_agent_mode)
    }

    pub fn get_resumed_session_sources(&self) -> Option<(SessionSource, Option<ThreadSource>)> {
        let meta = self.get_resumed_session_meta()?;
        Some((meta.source.clone(), meta.thread_source.clone()))
    }

    pub fn get_resumed_thread_source(&self) -> Option<ThreadSource> {
        self.get_resumed_session_meta()
            .and_then(|meta| meta.thread_source.clone())
    }

    pub fn get_session_originator(&self) -> Option<String> {
        self.get_session_meta()
            .map(|meta| meta.originator.clone())
            .filter(|originator| !originator.is_empty())
    }

    pub fn get_resumed_parent_thread_id(&self) -> Option<ThreadId> {
        self.get_resumed_session_meta()
            .and_then(|meta| meta.parent_thread_id)
    }

    fn get_session_meta(&self) -> Option<&SessionMeta> {
        match self {
            InitialHistory::New | InitialHistory::Cleared => None,
            InitialHistory::Resumed(resumed) => {
                resumed.history.iter().find_map(|item| match item {
                    RolloutItem::SessionMeta(meta_line) => Some(&meta_line.meta),
                    _ => None,
                })
            }
            InitialHistory::Forked(items) => items.iter().find_map(|item| match item {
                RolloutItem::SessionMeta(meta_line) => Some(&meta_line.meta),
                _ => None,
            }),
        }
    }

    fn get_resumed_session_meta(&self) -> Option<&SessionMeta> {
        match self {
            InitialHistory::New | InitialHistory::Cleared | InitialHistory::Forked(_) => None,
            InitialHistory::Resumed(resumed) => {
                resumed.history.iter().find_map(|item| match item {
                    RolloutItem::SessionMeta(meta_line) => Some(&meta_line.meta),
                    _ => None,
                })
            }
        }
    }
}

fn session_cwd_from_items(items: &[RolloutItem]) -> Option<PathBuf> {
    items.iter().find_map(|item| match item {
        RolloutItem::SessionMeta(meta_line) => Some(meta_line.meta.cwd.clone()),
        _ => None,
    })
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema, TS, Default)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum SessionSource {
    Cli,
    #[default]
    VSCode,
    Exec,
    Mcp,
    Custom(String),
    Internal(InternalSessionSource),
    SubAgent(SubAgentSource),
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema, TS)]
#[serde(try_from = "String", into = "String")]
#[schemars(with = "String")]
#[ts(type = "string")]
pub enum ThreadSource {
    User,
    Subagent,
    Feature(String),
    MemoryConsolidation,
}

impl ThreadSource {
    pub fn as_str(&self) -> &str {
        match self {
            ThreadSource::User => "user",
            ThreadSource::Subagent => "subagent",
            ThreadSource::Feature(feature) => feature,
            ThreadSource::MemoryConsolidation => "memory_consolidation",
        }
    }
}

impl fmt::Display for ThreadSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl TryFrom<String> for ThreadSource {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

impl From<ThreadSource> for String {
    fn from(value: ThreadSource) -> Self {
        value.to_string()
    }
}

impl FromStr for ThreadSource {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "user" => Ok(ThreadSource::User),
            "subagent" => Ok(ThreadSource::Subagent),
            "memory_consolidation" => Ok(ThreadSource::MemoryConsolidation),
            other => Ok(ThreadSource::Feature(other.to_string())),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum InternalSessionSource {
    MemoryConsolidation,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum SubAgentSource {
    Review,
    Compact,
    ThreadSpawn {
        parent_thread_id: ThreadId,
        depth: i32,
        #[serde(default)]
        agent_path: Option<AgentPath>,
        #[serde(default)]
        agent_nickname: Option<String>,
        #[serde(default, alias = "agent_type")]
        agent_role: Option<String>,
    },
    MemoryConsolidation,
    Other(String),
}

impl fmt::Display for SessionSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionSource::Cli => f.write_str("cli"),
            SessionSource::VSCode => f.write_str("vscode"),
            SessionSource::Exec => f.write_str("exec"),
            SessionSource::Mcp => f.write_str("mcp"),
            SessionSource::Custom(source) => f.write_str(source),
            SessionSource::Internal(source) => write!(f, "internal_{source}"),
            SessionSource::SubAgent(sub_source) => write!(f, "subagent_{sub_source}"),
            SessionSource::Unknown => f.write_str("unknown"),
        }
    }
}

impl SessionSource {
    pub fn from_startup_arg(value: &str) -> Result<Self, &'static str> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err("session source must not be empty");
        }

        let normalized = trimmed.to_ascii_lowercase();
        Ok(match normalized.as_str() {
            "cli" => SessionSource::Cli,
            "vscode" => SessionSource::VSCode,
            "exec" => SessionSource::Exec,
            "mcp" | "appserver" | "app-server" | "app_server" => SessionSource::Mcp,
            "unknown" => SessionSource::Unknown,
            _ => SessionSource::Custom(normalized),
        })
    }

    pub fn is_internal(&self) -> bool {
        matches!(self, SessionSource::Internal(_))
    }

    pub fn is_non_root_agent(&self) -> bool {
        matches!(
            self,
            SessionSource::Internal(_) | SessionSource::SubAgent(_)
        )
    }

    pub fn get_nickname(&self) -> Option<String> {
        match self {
            SessionSource::SubAgent(SubAgentSource::ThreadSpawn { agent_nickname, .. }) => {
                agent_nickname.clone()
            }
            _ => None,
        }
    }

    pub fn get_agent_role(&self) -> Option<String> {
        match self {
            SessionSource::SubAgent(SubAgentSource::ThreadSpawn { agent_role, .. }) => {
                agent_role.clone()
            }
            _ => None,
        }
    }

    pub fn get_agent_path(&self) -> Option<AgentPath> {
        match self {
            SessionSource::SubAgent(SubAgentSource::ThreadSpawn { agent_path, .. }) => {
                agent_path.clone()
            }
            _ => None,
        }
    }

    pub fn restriction_product(&self) -> Option<Product> {
        match self {
            SessionSource::Custom(source) => Product::from_session_source_name(source),
            SessionSource::Cli
            | SessionSource::VSCode
            | SessionSource::Exec
            | SessionSource::Mcp
            | SessionSource::Unknown => Some(Product::Codex),
            SessionSource::Internal(_) | SessionSource::SubAgent(_) => None,
        }
    }

    pub fn matches_product_restriction(&self, products: &[Product]) -> bool {
        products.is_empty()
            || self
                .restriction_product()
                .is_some_and(|product| product.matches_product_restriction(products))
    }

    pub fn parent_thread_id(&self) -> Option<ThreadId> {
        match self {
            SessionSource::SubAgent(subagent_source) => subagent_source.parent_thread_id(),
            SessionSource::Cli
            | SessionSource::VSCode
            | SessionSource::Exec
            | SessionSource::Mcp
            | SessionSource::Custom(_)
            | SessionSource::Internal(_)
            | SessionSource::Unknown => None,
        }
    }
}

impl fmt::Display for SubAgentSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SubAgentSource::Review => f.write_str("review"),
            SubAgentSource::Compact => f.write_str("compact"),
            SubAgentSource::MemoryConsolidation => f.write_str("memory_consolidation"),
            SubAgentSource::ThreadSpawn {
                parent_thread_id,
                depth,
                ..
            } => {
                write!(f, "thread_spawn_{parent_thread_id}_d{depth}")
            }
            SubAgentSource::Other(other) => f.write_str(other),
        }
    }
}

impl SubAgentSource {
    pub fn kind(&self) -> &str {
        match self {
            SubAgentSource::Review => "review",
            SubAgentSource::Compact => "compact",
            SubAgentSource::ThreadSpawn { .. } => "thread_spawn",
            SubAgentSource::MemoryConsolidation => "memory_consolidation",
            SubAgentSource::Other(other) => other,
        }
    }

    pub fn parent_thread_id(&self) -> Option<ThreadId> {
        match self {
            SubAgentSource::ThreadSpawn {
                parent_thread_id, ..
            } => Some(*parent_thread_id),
            SubAgentSource::Review
            | SubAgentSource::Compact
            | SubAgentSource::MemoryConsolidation
            | SubAgentSource::Other(_) => None,
        }
    }
}

impl fmt::Display for InternalSessionSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InternalSessionSource::MemoryConsolidation => f.write_str("memory_consolidation"),
        }
    }
}

fn multi_agent_version_from_items(
    items: &[RolloutItem],
    thread_id: Option<ThreadId>,
) -> Option<MultiAgentVersion> {
    let session_meta_version = items.iter().rev().find_map(|item| match item {
        RolloutItem::SessionMeta(meta_line)
            if thread_id.is_none_or(|thread_id| meta_line.meta.id == thread_id) =>
        {
            meta_line.meta.multi_agent_version
        }
        _ => None,
    });

    session_meta_version.or_else(|| {
        items.iter().rev().find_map(|item| match item {
            RolloutItem::TurnContext(turn_context) => turn_context.multi_agent_version,
            RolloutItem::SessionMeta(_)
            | RolloutItem::ResponseItem(_)
            | RolloutItem::InterAgentCommunication(_)
            | RolloutItem::InterAgentCommunicationMetadata { .. }
            | RolloutItem::Compacted(_)
            | RolloutItem::WorldState(_)
            | RolloutItem::EventMsg(_) => None,
        })
    })
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum MultiAgentVersion {
    Disabled,
    V1,
    V2,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema, TS)]
pub struct SessionContextWindow {
    /// 本 context window 的 UUIDv7 标识。
    pub window_id: String,
}

impl SessionContextWindow {
    pub fn new(window_id: String) -> Self {
        Self { window_id }
    }
}

/// SessionMeta 包含会话级数据，不对应具体 turn。
///
/// 注意：此处曾存在 `instructions` 字段用于存储 user_instructions，
/// 现已移至 TurnContext。base_instructions 存储会话的基础指令，
/// 在无 config 覆盖时使用。
#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema, TS)]
pub struct SessionMeta {
    pub session_id: SessionId,
    pub id: ThreadId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forked_from_id: Option<ThreadId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<ThreadId>,
    pub timestamp: String,
    pub cwd: PathBuf,
    pub originator: String,
    pub cli_version: String,
    #[serde(default)]
    pub source: SessionSource,
    /// 本 thread 的可选 analytics source 分类。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_source: Option<ThreadSource>,
    /// 由 AgentControl 派生的子 Agent 的可选随机唯一昵称。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_nickname: Option<String>,
    /// 由 AgentControl 派生的子 Agent 的可选角色（agent_role）。
    #[serde(default, alias = "agent_type", skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
    /// 由 AgentControl 派生的子 Agent 的可选 canonical agent 路径。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_path: Option<String>,
    pub model_provider: Option<String>,
    /// 会话的 base_instructions。创建新会话时*应当*始终存在，
    /// 但旧会话可能缺失。若不存在，则回退到 ModelsManager 渲染的 base_instructions。
    pub base_instructions: Option<BaseInstructions>,
    #[serde(
        default,
        deserialize_with = "crate::dynamic_tools::deserialize_dynamic_tool_specs",
        skip_serializing_if = "Option::is_none"
    )]
    pub dynamic_tools: Option<Vec<DynamicToolSpec>>,
    /// 由宿主平台为本 thread 选定的 capability roots。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_capability_roots: Vec<SelectedCapabilityRoot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mode: Option<String>,
    #[serde(default)]
    pub history_mode: ThreadHistoryMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_agent_version: Option<MultiAgentVersion>,
    /// 初始 context window 标识，供在 compaction 前读取 rollout JSONL 的消费者使用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<SessionContextWindow>,
}

impl Default for SessionMeta {
    fn default() -> Self {
        let id = ThreadId::default();
        SessionMeta {
            session_id: id.into(),
            id,
            forked_from_id: None,
            parent_thread_id: None,
            timestamp: String::new(),
            cwd: PathBuf::new(),
            originator: String::new(),
            cli_version: String::new(),
            source: SessionSource::default(),
            thread_source: None,
            agent_nickname: None,
            agent_role: None,
            agent_path: None,
            model_provider: None,
            base_instructions: None,
            dynamic_tools: None,
            selected_capability_roots: Vec::new(),
            memory_mode: None,
            history_mode: ThreadHistoryMode::default(),
            multi_agent_version: None,
            context_window: None,
        }
    }
}

#[derive(Serialize, Debug, Clone, JsonSchema, TS)]
pub struct SessionMetaLine {
    #[serde(flatten)]
    pub meta: SessionMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<GitInfo>,
}

impl<'de> Deserialize<'de> for SessionMetaLine {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct SessionMetaLineFields {
            #[serde(flatten)]
            meta: SessionMeta,
            git: Option<GitInfo>,
        }

        let mut value = Value::deserialize(deserializer)?;
        let fields = value
            .as_object_mut()
            .ok_or_else(|| D::Error::custom("session metadata must be an object"))?;
        if !fields.contains_key("session_id") {
            let thread_id = fields
                .get("id")
                .cloned()
                .ok_or_else(|| D::Error::missing_field("id"))?;
            fields.insert("session_id".to_string(), thread_id);
        }
        let SessionMetaLineFields { meta, git } =
            serde_json::from_value(value).map_err(D::Error::custom)?;
        Ok(Self { meta, git })
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema, TS)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum RolloutItem {
    SessionMeta(SessionMetaLine),
    ResponseItem(ResponseItem),
    /// 旧版交付条目，重建为模型可见的 `agent_message`。
    InterAgentCommunication(InterAgentCommunication),
    /// 本地交付 metadata，不属于 Responses API 条目。
    InterAgentCommunicationMetadata {
        trigger_turn: bool,
    },
    Compacted(CompactedItem),
    TurnContext(TurnContextItem),
    WorldState(WorldStateItem),
    EventMsg(EventMsg),
}

/// 持久化的比较状态，用于恢复模型可见的 world-state diff。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema, TS)]
pub struct WorldStateItem {
    /// 完整快照建立新的 baseline；patch 更新当前 baseline。
    pub full: bool,
    pub state: Value,
}

impl WorldStateItem {
    pub fn full(state: Value) -> Self {
        Self { full: true, state }
    }

    pub fn patch(state: Value) -> Self {
        Self { full: false, state }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, JsonSchema, TS)]
pub struct CompactedItem {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_history: Option<Vec<ResponseItem>>,
    /// 本 context window 在 thread 内的单调位置。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_number: Option<u64>,
    /// 本 thread window 链中首个 context window 的 UUIDv7 标识。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_window_id: Option<String>,
    /// 紧邻此前的 context window 的 UUIDv7 标识。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_window_id: Option<String>,
    /// 本 context window 的 UUIDv7 标识。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

impl From<CompactedItem> for ResponseItem {
    fn from(value: CompactedItem) -> Self {
        ResponseItem::Message {
            id: None,
            role: "assistant".to_string(),
            content: vec![ContentItem::OutputText {
                text: value.message,
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema, TS)]
pub struct TurnContextNetworkItem {
    pub allowed_domains: Vec<String>,
    pub denied_domains: Vec<String>,
}

/// 每个真实用户 turn 计算出模型可见的上下文更新后持久化一次；
/// 在 turn 中途 compaction 后、replacement history 重新建立完整上下文时
/// 再持久化一次，以便 resume/fork 重放时能恢复最新的 durable baseline。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema, TS)]
pub struct TurnContextItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub cwd: AbsolutePathBuf,
    /// 有效 workspace roots，用于物化 `permission_profile` 中的符号化
    /// `:workspace_roots` 文件系统权限。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_roots: Option<Vec<AbsolutePathBuf>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    pub approval_policy: AskForApproval,
    pub sandbox_policy: SandboxPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_profile: Option<PermissionProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<TurnContextNetworkItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_system_sandbox_policy: Option<FileSystemSandboxPolicy>,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comp_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personality: Option<Personality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_mode: Option<CollaborationMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_agent_version: Option<MultiAgentVersion>,
    /// 有效的模型可见 mode，用作 durable context-diff 的 baseline。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_agent_mode: Option<MultiAgentMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realtime_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<ReasoningEffortConfig>,
    // 仅用于兼容性的字段，写入默认值以便旧版 Codex 能反序列化 turn-context rollout 条目。
    // 上下文重建时已不再读取此字段，应在未来的 schema 清理中移除。
    pub summary: ReasoningSummaryConfig,
}

impl TurnContextItem {
    pub fn permission_profile(&self) -> PermissionProfile {
        self.permission_profile.clone().unwrap_or_else(|| {
            let file_system_sandbox_policy =
                self.file_system_sandbox_policy.clone().unwrap_or_else(|| {
                    FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd(
                        &self.sandbox_policy,
                        self.cwd.as_path(),
                    )
                });
            PermissionProfile::from_runtime_permissions_with_enforcement(
                SandboxEnforcement::from_legacy_sandbox_policy(&self.sandbox_policy),
                &file_system_sandbox_policy,
                NetworkSandboxPolicy::from(&self.sandbox_policy),
            )
        })
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(tag = "mode", content = "limit", rename_all = "snake_case")]
pub enum TruncationPolicy {
    Bytes(usize),
    Tokens(usize),
}

impl From<crate::openai_models::TruncationPolicyConfig> for TruncationPolicy {
    fn from(config: crate::openai_models::TruncationPolicyConfig) -> Self {
        match config.mode {
            crate::openai_models::TruncationMode::Bytes => Self::Bytes(config.limit as usize),
            crate::openai_models::TruncationMode::Tokens => Self::Tokens(config.limit as usize),
        }
    }
}

impl TruncationPolicy {
    pub fn token_budget(&self) -> usize {
        match self {
            TruncationPolicy::Bytes(bytes) => {
                usize::try_from(codex_utils_string::approx_tokens_from_byte_count(*bytes))
                    .unwrap_or(usize::MAX)
            }
            TruncationPolicy::Tokens(tokens) => *tokens,
        }
    }

    pub fn byte_budget(&self) -> usize {
        match self {
            TruncationPolicy::Bytes(bytes) => *bytes,
            TruncationPolicy::Tokens(tokens) => {
                codex_utils_string::approx_bytes_for_tokens(*tokens)
            }
        }
    }
}

impl Mul<f64> for TruncationPolicy {
    type Output = Self;

    fn mul(self, multiplier: f64) -> Self::Output {
        match self {
            TruncationPolicy::Bytes(bytes) => {
                TruncationPolicy::Bytes((bytes as f64 * multiplier).ceil() as usize)
            }
            TruncationPolicy::Tokens(tokens) => {
                TruncationPolicy::Tokens((tokens as f64 * multiplier).ceil() as usize)
            }
        }
    }
}

#[derive(Serialize, Deserialize, Clone, JsonSchema)]
pub struct RolloutLine {
    pub timestamp: String,
    #[serde(flatten)]
    pub item: RolloutItem,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema, TS)]
pub struct GitInfo {
    /// 当前 commit hash（SHA）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_hash: Option<GitSha>,
    /// 当前分支名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// 仓库 URL（若从 remote 可获取）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDelivery {
    Inline,
    Detached,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type")]
pub enum ReviewTarget {
    /// 审查工作区：staged、unstaged 与 untracked 文件。
    UncommittedChanges,

    /// 审查当前分支与指定 base branch 之间的差异。
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    BaseBranch { branch: String },

    /// 审查指定 commit 引入的变更。
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Commit {
        sha: String,
        /// 可选的人类可读标签（如 commit subject），供 UI 使用。
        title: Option<String>,
    },

    /// 用户提供的任意指令。
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Custom { instructions: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
/// 发送给 review 会话的审查请求。
pub struct ReviewRequest {
    pub target: ReviewTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub user_facing_hint: Option<String>,
}

/// 由子 review 会话产出的结构化审查结果。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct ReviewOutputEvent {
    pub findings: Vec<ReviewFinding>,
    pub overall_correctness: String,
    pub overall_explanation: String,
    pub overall_confidence_score: f32,
}

impl Default for ReviewOutputEvent {
    fn default() -> Self {
        Self {
            findings: Vec::new(),
            overall_correctness: String::default(),
            overall_explanation: String::default(),
            overall_confidence_score: 0.0,
        }
    }
}

/// 单个 review 发现，描述观察到的问题或建议。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct ReviewFinding {
    pub title: String,
    pub body: String,
    pub confidence_score: f32,
    pub priority: i32,
    pub code_location: ReviewCodeLocation,
}

/// 与 review 发现相关的代码位置。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct ReviewCodeLocation {
    pub absolute_file_path: PathBuf,
    pub line_range: ReviewLineRange,
}

/// 与该发现关联的文件内闭包行范围。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct ReviewLineRange {
    pub start: u32,
    pub end: u32,
}

#[derive(
    Debug, Clone, Copy, Display, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum ExecCommandSource {
    #[default]
    Agent,
    UserShell,
    UnifiedExecStartup,
    UnifiedExecInteraction,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ExecCommandStatus {
    Completed,
    Failed,
    Declined,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ExecCommandBeginEvent {
    /// 调用标识，用于与 ExecCommandEnd 事件配对。
    pub call_id: String,
    /// 底层 PTY 进程的标识（若可用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub process_id: Option<String>,
    /// 本命令所属的 turn ID。
    pub turn_id: String,
    #[serde(default)]
    pub started_at_ms: i64,
    /// 待执行的命令。
    pub command: Vec<String>,
    /// 命令的工作目录（若非 Agent 的默认 cwd）。
    pub cwd: PathUri,
    pub parsed_cmd: Vec<ParsedCommand>,
    /// 命令来源。默认为 Agent，以便向后兼容。
    #[serde(default)]
    pub source: ExecCommandSource,
    /// 发送给 unified exec session 的原始输入（若为交互事件）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub interaction_input: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ExecCommandEndEvent {
    /// 对应的 ExecCommandBegin 的标识，表示该命令已完成。
    pub call_id: String,
    /// 底层 PTY 进程的标识（若可用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub process_id: Option<String>,
    /// 本命令所属的 turn ID。
    pub turn_id: String,
    #[serde(default)]
    pub completed_at_ms: i64,
    /// 已执行的命令。
    pub command: Vec<String>,
    /// 命令的工作目录（若非 Agent 的默认 cwd）。
    pub cwd: PathUri,
    pub parsed_cmd: Vec<ParsedCommand>,
    /// 命令来源。默认为 Agent，以便向后兼容。
    #[serde(default)]
    pub source: ExecCommandSource,
    /// 发送给 unified exec session 的原始输入（若为交互事件）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub interaction_input: Option<String>,

    /// 捕获的 stdout。
    pub stdout: String,
    /// 捕获的 stderr。
    pub stderr: String,
    /// 捕获的聚合输出。
    #[serde(default)]
    pub aggregated_output: String,
    /// 命令的退出码。
    pub exit_code: i32,
    /// 命令执行耗时。
    #[ts(type = "string")]
    pub duration: Duration,
    /// 命令的格式化输出（模型所见）。
    pub formatted_output: String,
    /// 本命令执行的完成状态。
    pub status: ExecCommandStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ViewImageToolCallEvent {
    /// 发起本次 tool 调用的标识。
    pub call_id: String,
    /// 为所选环境解析出的文件系统路径。
    ///
    /// 此 core 事件不会直接暴露在 app-server API 中。app-server 在构造
    /// 其公开条目时将此路径转换为 `LegacyAppPathString`。
    pub path: PathUri,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ExecOutputStream {
    Stdout,
    Stderr,
}

#[serde_as]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct ExecCommandOutputDeltaEvent {
    /// 产生此块的 ExecCommandBegin 的标识。
    pub call_id: String,
    /// 产生此块的流。
    pub stream: ExecOutputStream,
    /// 流的原始字节（可能不是合法 UTF-8）。
    #[serde_as(as = "serde_with::base64::Base64")]
    #[schemars(with = "String")]
    #[ts(type = "string")]
    pub chunk: Vec<u8>,
}

#[serde_as]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct TerminalInteractionEvent {
    /// 产生此块的 ExecCommandBegin 的标识。
    pub call_id: String,
    /// 运行中命令关联的进程 ID。
    pub process_id: String,
    /// 发送给运行中 session 的 stdin。
    pub stdin: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct DeprecationNoticeEvent {
    /// 被废弃内容的简短摘要。
    pub summary: String,
    /// 可选的额外指引（如迁移步骤或原因说明）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ThreadRolledBackEvent {
    /// 从上下文中移除的用户 turn 数。
    pub num_turns: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct StreamErrorEvent {
    pub message: String,
    #[serde(default)]
    pub codex_error_info: Option<CodexErrorInfo>,
    /// 底层流失败的可选详情（通常与重试耗尽后作为终态错误展示的
    /// 人类可读消息相同）。
    #[serde(default)]
    pub additional_details: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct StreamInfoEvent {
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct PatchApplyBeginEvent {
    /// 调用标识，用于与 PatchApplyEnd 事件配对。
    pub call_id: String,
    /// 本补丁所属的 turn ID。
    /// 使用 `#[serde(default)]` 以向后兼容。
    #[serde(default)]
    pub turn_id: String,
    /// 为 `true` 表示此补丁未经过 ApplyPatchApprovalRequest。
    pub auto_approved: bool,
    /// 待应用的变更。
    pub changes: HashMap<PathBuf, FileChange>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct PatchApplyUpdatedEvent {
    /// 发起 `apply_patch` tool 调用的标识。
    pub call_id: String,
    /// 从模型生成的 patch 输入中解析出的、截至目前的结构化文件变更。
    pub changes: HashMap<PathBuf, FileChange>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct PatchApplyEndEvent {
    /// 对应的 PatchApplyBegin 的标识，表示该补丁应用已完成。
    pub call_id: String,
    /// 本补丁所属的 turn ID。
    /// 使用 `#[serde(default)]` 以向后兼容。
    #[serde(default)]
    pub turn_id: String,
    /// 捕获的 stdout（apply_patch 打印的摘要）。
    pub stdout: String,
    /// 捕获的 stderr（解析错误、IO 失败等）。
    pub stderr: String,
    /// 补丁是否应用成功。
    pub success: bool,
    /// 已应用的变更（与 PatchApplyBeginEvent::changes 镜像）。
    #[serde(default)]
    pub changes: HashMap<PathBuf, FileChange>,
    /// 本补丁应用的完成状态。
    pub status: PatchApplyStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PatchApplyStatus {
    Completed,
    Failed,
    Declined,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct TurnDiffEvent {
    pub unified_diff: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct McpStartupUpdateEvent {
    /// 正在启动的 server 名称。
    pub server: String,
    /// 当前启动状态。
    pub status: McpStartupStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case", tag = "state")]
#[ts(rename_all = "snake_case", tag = "state")]
pub enum McpStartupStatus {
    Starting,
    Ready,
    Failed {
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        reason: Option<McpStartupFailureReason>,
    },
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum McpStartupFailureReason {
    ReauthenticationRequired,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS, Default)]
pub struct McpStartupCompleteEvent {
    pub ready: Vec<String>,
    pub failed: Vec<McpStartupFailure>,
    pub cancelled: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct McpStartupFailure {
    pub server: String,
    pub error: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum McpAuthStatus {
    Unsupported,
    NotLoggedIn,
    BearerToken,
    OAuth,
}

impl fmt::Display for McpAuthStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            McpAuthStatus::Unsupported => "Unsupported",
            McpAuthStatus::NotLoggedIn => "Not logged in",
            McpAuthStatus::BearerToken => "Bearer token",
            McpAuthStatus::OAuth => "OAuth",
        };
        f.write_str(text)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct RealtimeConversationListVoicesResponseEvent {
    pub voices: RealtimeVoicesList,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum Product {
    #[serde(alias = "CHATGPT")]
    Chatgpt,
    #[serde(alias = "CODEX")]
    Codex,
    #[serde(alias = "ATLAS")]
    Atlas,
}
impl Product {
    pub fn to_app_platform(self) -> &'static str {
        match self {
            Self::Chatgpt => "chat",
            Self::Codex => "codex",
            Self::Atlas => "atlas",
        }
    }

    pub fn from_session_source_name(value: &str) -> Option<Self> {
        let normalized = value.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "chatgpt" => Some(Self::Chatgpt),
            "codex" => Some(Self::Codex),
            "atlas" => Some(Self::Atlas),
            _ => None,
        }
    }

    pub fn matches_product_restriction(&self, products: &[Product]) -> bool {
        products.is_empty() || products.contains(self)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum SkillScope {
    User,
    Repo,
    System,
    Admin,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    /// 旧版 short_description，来自 SKILL.md。优先使用 SKILL.json interface.short_description。
    pub short_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub interface: Option<SkillInterface>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dependencies: Option<SkillDependencies>,
    pub path: AbsolutePathBuf,
    pub scope: SkillScope,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct SkillInterface {
    #[ts(optional)]
    pub display_name: Option<String>,
    #[ts(optional)]
    pub short_description: Option<String>,
    #[ts(optional)]
    pub icon_small: Option<AbsolutePathBuf>,
    #[ts(optional)]
    pub icon_large: Option<AbsolutePathBuf>,
    #[ts(optional)]
    pub brand_color: Option<String>,
    #[ts(optional)]
    pub default_prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct SkillDependencies {
    pub tools: Vec<SkillToolDependency>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct SkillToolDependency {
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub r#type: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub transport: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS, PartialEq, Eq)]
pub struct SessionNetworkProxyRuntime {
    pub http_addr: String,
    pub socks_addr: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema, TS)]
pub struct SessionConfiguredEvent {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forked_from_id: Option<ThreadId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<ThreadId>,
    /// 本 thread 的可选 analytics source 分类。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_source: Option<ThreadSource>,

    /// 面向用户的 thread 名称（可能未设置）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread_name: Option<String>,

    /// 告知客户端当前查询的模型。
    pub model: String,

    pub model_provider_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,

    /// 执行审批的升级时机。
    pub approval_policy: AskForApproval,

    /// 配置审批请求在升级后路由给谁审查。不会禁用独立的安全检查，
    /// 例如 ARC。
    #[serde(default)]
    pub approvals_reviewer: ApprovalsReviewer,

    /// 会话中执行命令的 canonical 有效权限。
    pub permission_profile: PermissionProfile,

    /// 产生 `permission_profile` 的命名或隐式内建 profile（若已知）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_permission_profile: Option<ActivePermissionProfile>,

    /// 应作为会话*根*的工作目录。
    pub cwd: AbsolutePathBuf,

    /// 模型在推理用户请求时投入的 effort。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffortConfig>,

    /// 恢复会话时的可选初始消息（以事件形式）。
    /// 存在时 UI 可据此填充历史。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_messages: Option<Vec<EventMsg>>,

    /// 当为本会话启动托管 proxy 时的运行时 proxy 绑定地址。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub network_proxy: Option<SessionNetworkProxyRuntime>,

    /// rollout 存储路径。对于临时 thread 可为 `None`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollout_path: Option<PathBuf>,
}

impl<'de> Deserialize<'de> for SessionConfiguredEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            session_id: SessionId,
            #[serde(default)]
            thread_id: Option<ThreadId>,
            forked_from_id: Option<ThreadId>,
            parent_thread_id: Option<ThreadId>,
            #[serde(default)]
            thread_source: Option<ThreadSource>,
            #[serde(default)]
            thread_name: Option<String>,
            model: String,
            model_provider_id: String,
            service_tier: Option<String>,
            approval_policy: AskForApproval,
            #[serde(default)]
            approvals_reviewer: ApprovalsReviewer,
            // `SessionConfiguredEvent` 会被持久化到 rollout 历史中。旧版 rollout
            // 仅包含 `sandbox_policy`，因此在反序列化时同时接受该字段，并立即
            // 将其投影为 canonical 的 `permission_profile`。
            sandbox_policy: Option<SandboxPolicy>,
            permission_profile: Option<PermissionProfile>,
            #[serde(default)]
            active_permission_profile: Option<ActivePermissionProfile>,
            cwd: AbsolutePathBuf,
            reasoning_effort: Option<ReasoningEffortConfig>,
            initial_messages: Option<Vec<EventMsg>>,
            network_proxy: Option<SessionNetworkProxyRuntime>,
            rollout_path: Option<PathBuf>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let permission_profile = match (wire.permission_profile, wire.sandbox_policy) {
            (Some(permission_profile), _) => permission_profile,
            (None, Some(sandbox_policy)) => PermissionProfile::from_legacy_sandbox_policy_for_cwd(
                &sandbox_policy,
                wire.cwd.as_path(),
            ),
            (None, None) => {
                return Err(serde::de::Error::missing_field("permission_profile"));
            }
        };

        Ok(Self {
            session_id: wire.session_id,
            thread_id: wire.thread_id.unwrap_or_else(|| wire.session_id.into()),
            forked_from_id: wire.forked_from_id,
            parent_thread_id: wire.parent_thread_id,
            thread_source: wire.thread_source,
            thread_name: wire.thread_name,
            model: wire.model,
            model_provider_id: wire.model_provider_id,
            service_tier: wire.service_tier,
            approval_policy: wire.approval_policy,
            approvals_reviewer: wire.approvals_reviewer,
            permission_profile,
            active_permission_profile: wire.active_permission_profile,
            cwd: wire.cwd,
            reasoning_effort: wire.reasoning_effort,
            initial_messages: wire.initial_messages,
            network_proxy: wire.network_proxy,
            rollout_path: wire.rollout_path,
        })
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "protocol/")]
pub enum ThreadGoalStatus {
    Active,
    Paused,
    Blocked,
    UsageLimited,
    BudgetLimited,
    Complete,
}

pub const MAX_THREAD_GOAL_OBJECTIVE_CHARS: usize = 4_000;

pub fn validate_thread_goal_objective(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("goal objective must not be empty".to_string());
    }
    if value.chars().count() > MAX_THREAD_GOAL_OBJECTIVE_CHARS {
        return Err(format!(
            "goal objective must be at most {MAX_THREAD_GOAL_OBJECTIVE_CHARS} characters"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "protocol/")]
pub struct ThreadGoal {
    pub thread_id: ThreadId,
    pub objective: String,
    pub status: ThreadGoalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub token_budget: Option<i64>,
    pub tokens_used: i64,
    pub time_used_seconds: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "protocol/")]
pub struct ThreadGoalUpdatedEvent {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<String>,
    pub goal: ThreadGoal,
}

/// 用户对 ExecApprovalRequest 的审批决定。
#[derive(Debug, Default, Clone, Deserialize, Serialize, PartialEq, Eq, Display, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    /// 用户已批准此命令，agent 应当执行它。
    Approved,

    /// 用户已批准此命令，并希望应用提议的 execpolicy 修订，以便未来匹配的
    /// 命令可直接放行。
    ApprovedExecpolicyAmendment {
        proposed_execpolicy_amendment: ExecPolicyAmendment,
    },

    /// 用户已批准此请求，并希望同一 session-scoped 审批缓存中的后续相同
    /// 提示在本会话剩余时间内被自动批准。
    ApprovedForSession,

    /// 用户选择为未来对同一 host 的请求持久化一条 network policy 规则
    /// （allow/deny）。
    NetworkPolicyAmendment {
        network_policy_amendment: NetworkPolicyAmendment,
    },

    /// 用户已拒绝此命令，agent 不应执行它，但应继续会话并尝试其他方案。
    #[default]
    Denied,

    /// 自动审批审查在得出结论前超时。
    TimedOut,

    /// 用户已拒绝此命令，agent 在用户下一条命令之前不应执行任何操作。
    Abort,
}

impl ReviewDecision {
    /// 返回该决定的不透明（opaque）字符串表示，不包含任何 PII。无法使用 `serde`
    /// 的 ignored flag，因为某些场景需要保留该序列化结果。
    pub fn to_opaque_string(&self) -> &'static str {
        match self {
            ReviewDecision::Approved => "approved",
            ReviewDecision::ApprovedExecpolicyAmendment { .. } => "approved_with_amendment",
            ReviewDecision::ApprovedForSession => "approved_for_session",
            ReviewDecision::NetworkPolicyAmendment {
                network_policy_amendment,
            } => match network_policy_amendment.action {
                NetworkPolicyRuleAction::Allow => "approved_with_network_policy_allow",
                NetworkPolicyRuleAction::Deny => "denied_with_network_policy_deny",
            },
            ReviewDecision::Denied => "denied",
            ReviewDecision::TimedOut => "timed_out",
            ReviewDecision::Abort => "abort",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type")]
pub enum FileChange {
    Add {
        content: String,
    },
    Delete {
        content: String,
    },
    Update {
        unified_diff: String,
        move_path: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct Chunk {
    /// 原始文件中首行的 1-based 行号。
    pub orig_index: u32,
    pub deleted_lines: Vec<String>,
    pub inserted_lines: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct TurnAbortedEvent {
    pub turn_id: Option<String>,
    pub reason: TurnAbortReason,
    /// turn 被中止的 Unix 时间戳（秒）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null", optional)]
    pub completed_at: Option<i64>,
    /// turn 开始到中止之间的耗时（毫秒），若已知。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null", optional)]
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum TurnAbortReason {
    Interrupted,
    Replaced,
    ReviewEnded,
    BudgetLimited,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabAgentSpawnBeginEvent {
    /// collab 工具调用的标识。
    pub call_id: String,
    #[serde(default)]
    pub started_at_ms: i64,
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// 发送给 agent 的初始 prompt。可以为空，以避免开头泄漏 chain-of-thought。
    pub prompt: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffortConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct CollabAgentRef {
    /// 接收方 / 新 agent 的 thread ID。
    pub thread_id: ThreadId,
    /// 由 AgentControl 派生的子 Agent 的可选昵称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_nickname: Option<String>,
    /// 由 AgentControl 派生的子 Agent 的可选角色（agent_role）。
    #[serde(default, alias = "agent_type", skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct CollabAgentStatusEntry {
    /// 接收方 / 新 agent 的 thread ID。
    pub thread_id: ThreadId,
    /// 由 AgentControl 派生的子 Agent 的可选昵称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_nickname: Option<String>,
    /// 由 AgentControl 派生的子 Agent 的可选角色（agent_role）。
    #[serde(default, alias = "agent_type", skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
    /// 该 agent 最近一次的已知状态。
    pub status: AgentStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabAgentSpawnEndEvent {
    /// collab 工具调用的标识。
    pub call_id: String,
    #[serde(default)]
    pub completed_at_ms: i64,
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// 新创建的 agent 的 thread ID（若创建成功）。
    pub new_thread_id: Option<ThreadId>,
    /// 分配给新 agent 的可选昵称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_agent_nickname: Option<String>,
    /// 分配给新 agent 的可选角色。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_agent_role: Option<String>,
    /// 发送给 agent 的初始 prompt。可以为空，以避免开头泄漏 chain-of-thought。
    pub prompt: String,
    /// 派生的 agent 在经过继承与角色 override 后实际使用的 model。
    pub model: String,
    /// 派生的 agent 在经过继承与角色 override 后实际使用的 reasoning effort。
    pub reasoning_effort: ReasoningEffortConfig,
    /// 向发送方 agent 报告的新 agent 最近一次的已知状态。
    pub status: AgentStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabAgentInteractionBeginEvent {
    /// collab 工具调用的标识。
    pub call_id: String,
    #[serde(default)]
    pub started_at_ms: i64,
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// 接收方的 thread ID。
    pub receiver_thread_id: ThreadId,
    /// 由发送方传递给接收方的 prompt。可以为空，以避免开头泄漏 chain-of-thought。
    pub prompt: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabAgentInteractionEndEvent {
    /// collab 工具调用的标识。
    pub call_id: String,
    #[serde(default)]
    pub completed_at_ms: i64,
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// 接收方的 thread ID。
    pub receiver_thread_id: ThreadId,
    /// 分配给接收方 agent 的可选昵称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_agent_nickname: Option<String>,
    /// 分配给接收方 agent 的可选角色。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_agent_role: Option<String>,
    /// 由发送方传递给接收方的 prompt。可以为空，以避免开头泄漏 chain-of-thought。
    pub prompt: String,
    /// 向发送方 agent 报告的接收方 agent 最近一次的已知状态。
    pub status: AgentStatus,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum SubAgentActivityKind {
    Started,
    Interacted,
    Interrupted,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct SubAgentActivityEvent {
    pub event_id: String,
    #[serde(default)]
    pub occurred_at_ms: i64,
    /// 受影响的子 agent 的 thread ID。
    pub agent_thread_id: ThreadId,
    /// 受影响的子 agent 的 canonical v2 path。
    pub agent_path: AgentPath,
    pub kind: SubAgentActivityKind,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabWaitingBeginEvent {
    #[serde(default)]
    pub started_at_ms: i64,
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// 各接收方的 thread ID 列表。
    pub receiver_thread_ids: Vec<ThreadId>,
    /// 接收方的可选昵称 / 角色列表。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub receiver_agents: Vec<CollabAgentRef>,
    /// waiting 调用的 ID。
    pub call_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabWaitingEndEvent {
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// waiting 调用的 ID。
    pub call_id: String,
    #[serde(default)]
    pub completed_at_ms: i64,
    /// 接收方 metadata 与最终状态的配对列表（可选）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_statuses: Vec<CollabAgentStatusEntry>,
    /// 向发送方 agent 报告的各接收方 agent 最近一次的已知状态。
    pub statuses: HashMap<ThreadId, AgentStatus>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabCloseBeginEvent {
    /// collab 工具调用的标识。
    pub call_id: String,
    #[serde(default)]
    pub started_at_ms: i64,
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// 接收方的 thread ID。
    pub receiver_thread_id: ThreadId,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabCloseEndEvent {
    /// collab 工具调用的标识。
    pub call_id: String,
    #[serde(default)]
    pub completed_at_ms: i64,
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// 接收方的 thread ID。
    pub receiver_thread_id: ThreadId,
    /// 分配给接收方 agent 的可选昵称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_agent_nickname: Option<String>,
    /// 分配给接收方 agent 的可选角色。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_agent_role: Option<String>,
    /// 在 close 之前向发送方 agent 报告的接收方 agent 最近一次的已知状态。
    pub status: AgentStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabResumeBeginEvent {
    /// collab 工具调用的标识。
    pub call_id: String,
    #[serde(default)]
    pub started_at_ms: i64,
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// 接收方的 thread ID。
    pub receiver_thread_id: ThreadId,
    /// 分配给接收方 agent 的可选昵称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_agent_nickname: Option<String>,
    /// 分配给接收方 agent 的可选角色。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_agent_role: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct CollabResumeEndEvent {
    /// collab 工具调用的标识。
    pub call_id: String,
    #[serde(default)]
    pub completed_at_ms: i64,
    /// 发送方的 thread ID。
    pub sender_thread_id: ThreadId,
    /// 接收方的 thread ID。
    pub receiver_thread_id: ThreadId,
    /// 分配给接收方 agent 的可选昵称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_agent_nickname: Option<String>,
    /// 分配给接收方 agent 的可选角色。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_agent_role: Option<String>,
    /// 在 resume 之后向发送方 agent 报告的接收方 agent 最近一次的已知状态。
    pub status: AgentStatus,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::FileChangeItem;
    use crate::items::ImageGenerationItem;
    use crate::items::McpToolCallItem;
    use crate::items::McpToolCallStatus;
    use crate::items::UserMessageItem;
    use crate::items::WebSearchItem;
    use crate::mcp::CallToolResult;
    use crate::permissions::FileSystemAccessMode;
    use crate::permissions::FileSystemPath;
    use crate::permissions::FileSystemSandboxEntry;
    use crate::permissions::FileSystemSandboxPolicy;
    use crate::permissions::FileSystemSpecialPath;
    use crate::permissions::NetworkSandboxPolicy;
    use anyhow::Result;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use codex_utils_absolute_path::test_support::PathBufExt;
    use codex_utils_absolute_path::test_support::test_path_buf;
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use std::path::PathBuf;
    use tempfile::NamedTempFile;
    use tempfile::TempDir;

    #[test]
    fn feature_thread_source_serializes_as_its_app_owned_label() -> Result<()> {
        let source = ThreadSource::Feature("automation".to_string());

        assert_eq!(serde_json::to_value(&source)?, json!("automation"));
        assert_eq!(
            serde_json::from_value::<ThreadSource>(json!("automation"))?,
            source
        );
        Ok(())
    }

    #[test]
    fn session_meta_normalizes_legacy_dynamic_tools() -> Result<()> {
        let mut value = serde_json::to_value(SessionMeta::default())?;
        value["dynamic_tools"] = json!([
            {
                "namespace": "legacy_app",
                "name": "lookup_ticket",
                "description": "Look up a ticket",
                "inputSchema": {"type": "object", "properties": {}},
                "exposeToContext": false
            },
            {
                "namespace": "legacy_app",
                "name": "update_ticket",
                "description": "Update a ticket",
                "inputSchema": {"type": "object", "properties": {}},
                "deferLoading": false,
                "exposeToContext": false
            }
        ]);

        let meta: SessionMeta = serde_json::from_value(value)?;

        assert_eq!(
            meta.dynamic_tools,
            Some(vec![DynamicToolSpec::Namespace(
                crate::dynamic_tools::DynamicToolNamespaceSpec {
                    name: "legacy_app".to_string(),
                    description: String::new(),
                    tools: vec![
                        crate::dynamic_tools::DynamicToolNamespaceTool::Function(
                            crate::dynamic_tools::DynamicToolFunctionSpec {
                                name: "lookup_ticket".to_string(),
                                description: "Look up a ticket".to_string(),
                                input_schema: json!({"type": "object", "properties": {}}),
                                defer_loading: true,
                            },
                        ),
                        crate::dynamic_tools::DynamicToolNamespaceTool::Function(
                            crate::dynamic_tools::DynamicToolFunctionSpec {
                                name: "update_ticket".to_string(),
                                description: "Update a ticket".to_string(),
                                input_schema: json!({"type": "object", "properties": {}}),
                                defer_loading: false,
                            },
                        ),
                    ],
                },
            )])
        );
        Ok(())
    }

    fn sorted_writable_roots(roots: Vec<WritableRoot>) -> Vec<(PathBuf, Vec<PathBuf>)> {
        let mut sorted_roots: Vec<(PathBuf, Vec<PathBuf>)> = roots
            .into_iter()
            .map(|root| {
                let mut read_only_subpaths: Vec<PathBuf> = root
                    .read_only_subpaths
                    .into_iter()
                    .map(|path| path.to_path_buf())
                    .collect();
                read_only_subpaths.sort();
                (root.root.to_path_buf(), read_only_subpaths)
            })
            .collect();
        sorted_roots.sort_by(|left, right| left.0.cmp(&right.0));
        sorted_roots
    }

    fn sandbox_policy_allows_read(policy: &SandboxPolicy, _path: &Path, _cwd: &Path) -> bool {
        policy.has_full_disk_read_access()
    }

    fn sandbox_policy_allows_write(policy: &SandboxPolicy, path: &Path, cwd: &Path) -> bool {
        if policy.has_full_disk_write_access() {
            return true;
        }

        policy
            .get_writable_roots_with_cwd(cwd)
            .iter()
            .any(|root| root.is_path_writable(path))
    }

    #[test]
    fn session_source_from_startup_arg_maps_known_values() {
        assert_eq!(
            SessionSource::from_startup_arg("vscode").unwrap(),
            SessionSource::VSCode
        );
        assert_eq!(
            SessionSource::from_startup_arg("app-server").unwrap(),
            SessionSource::Mcp
        );
    }

    #[test]
    fn inter_agent_communication_response_input_item_preserves_commentary_phase() {
        let mut communication = InterAgentCommunication {
            id: Some("amsg_1".to_string()),
            author: AgentPath::root(),
            recipient: AgentPath::root().join("reviewer").expect("recipient path"),
            other_recipients: vec![AgentPath::root().join("worker").expect("recipient path")],
            content: "review the diff".to_string(),
            encrypted_content: None,
            internal_chat_message_metadata_passthrough: None,
            trigger_turn: true,
        };
        communication.set_turn_id_if_missing("turn-1");
        let mut serialized_communication = communication.clone();
        serialized_communication.id = None;
        serialized_communication.internal_chat_message_metadata_passthrough = None;

        assert_eq!(
            communication.to_response_input_item(),
            ResponseInputItem::Message {
                role: "assistant".to_string(),
                content: vec![ContentItem::OutputText {
                    text: serde_json::to_string(&serialized_communication)
                        .expect("serialize communication"),
                }],
                phase: Some(MessagePhase::Commentary),
            }
        );
    }

    #[test]
    fn queued_encrypted_inter_agent_communication_renders_message_envelope() {
        let communication = InterAgentCommunication::new_encrypted(
            AgentPath::root().join("worker").expect("author path"),
            AgentPath::root(),
            Vec::new(),
            "encrypted payload".to_string(),
            /*trigger_turn*/ false,
        );

        assert_eq!(
            communication.to_model_input_item(),
            ResponseItem::AgentMessage {
                id: None,
                author: "/root/worker".to_string(),
                recipient: "/root".to_string(),
                content: vec![
                    AgentMessageInputContent::InputText {
                        text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/worker\nPayload:\n"
                            .to_string(),
                    },
                    AgentMessageInputContent::EncryptedContent {
                        encrypted_content: "encrypted payload".to_string(),
                    },
                ],
                internal_chat_message_metadata_passthrough: None,
            }
        );
    }

    #[test]
    fn session_source_from_startup_arg_normalizes_custom_values() {
        assert_eq!(
            SessionSource::from_startup_arg("atlas").unwrap(),
            SessionSource::Custom("atlas".to_string())
        );
        assert_eq!(
            SessionSource::from_startup_arg(" Atlas ").unwrap(),
            SessionSource::Custom("atlas".to_string())
        );
    }

    #[test]
    fn session_source_restriction_product_defaults_non_subagent_sources_to_codex() {
        assert_eq!(
            SessionSource::Cli.restriction_product(),
            Some(Product::Codex)
        );
        assert_eq!(
            SessionSource::VSCode.restriction_product(),
            Some(Product::Codex)
        );
        assert_eq!(
            SessionSource::Exec.restriction_product(),
            Some(Product::Codex)
        );
        assert_eq!(
            SessionSource::Mcp.restriction_product(),
            Some(Product::Codex)
        );
        assert_eq!(
            SessionSource::Unknown.restriction_product(),
            Some(Product::Codex)
        );
    }

    #[test]
    fn session_source_restriction_product_does_not_guess_subagent_products() {
        assert_eq!(
            SessionSource::SubAgent(SubAgentSource::Review).restriction_product(),
            None
        );
        assert_eq!(
            SessionSource::Internal(InternalSessionSource::MemoryConsolidation)
                .restriction_product(),
            None
        );
    }

    #[test]
    fn session_source_restriction_product_maps_custom_sources_to_products() {
        assert_eq!(
            SessionSource::Custom("chatgpt".to_string()).restriction_product(),
            Some(Product::Chatgpt)
        );
        assert_eq!(
            SessionSource::Custom("ATLAS".to_string()).restriction_product(),
            Some(Product::Atlas)
        );
        assert_eq!(
            SessionSource::Custom("codex".to_string()).restriction_product(),
            Some(Product::Codex)
        );
        assert_eq!(
            SessionSource::Custom("atlas-dev".to_string()).restriction_product(),
            None
        );
    }

    #[test]
    fn session_source_matches_product_restriction() {
        assert!(
            SessionSource::Custom("chatgpt".to_string())
                .matches_product_restriction(&[Product::Chatgpt])
        );
        assert!(
            !SessionSource::Custom("chatgpt".to_string())
                .matches_product_restriction(&[Product::Codex])
        );
        assert!(SessionSource::VSCode.matches_product_restriction(&[Product::Codex]));
        assert!(
            !SessionSource::Custom("atlas-dev".to_string())
                .matches_product_restriction(&[Product::Atlas])
        );
        assert!(SessionSource::Custom("atlas-dev".to_string()).matches_product_restriction(&[]));
    }

    fn sandbox_policy_probe_paths(policy: &SandboxPolicy, cwd: &Path) -> Vec<PathBuf> {
        let mut paths = vec![cwd.to_path_buf()];
        for root in policy.get_writable_roots_with_cwd(cwd) {
            paths.push(root.root.to_path_buf());
            paths.extend(
                root.read_only_subpaths
                    .into_iter()
                    .map(|path| path.to_path_buf()),
            );
        }
        paths.sort();
        paths.dedup();
        paths
    }

    fn assert_same_sandbox_policy_semantics(
        expected: &SandboxPolicy,
        actual: &SandboxPolicy,
        cwd: &Path,
    ) {
        assert_eq!(
            actual.has_full_disk_read_access(),
            expected.has_full_disk_read_access()
        );
        assert_eq!(
            actual.has_full_disk_write_access(),
            expected.has_full_disk_write_access()
        );
        assert_eq!(
            actual.has_full_network_access(),
            expected.has_full_network_access()
        );
        let mut probe_paths = sandbox_policy_probe_paths(expected, cwd);
        probe_paths.extend(sandbox_policy_probe_paths(actual, cwd));
        probe_paths.sort();
        probe_paths.dedup();

        for path in probe_paths {
            assert_eq!(
                sandbox_policy_allows_read(actual, &path, cwd),
                sandbox_policy_allows_read(expected, &path, cwd),
                "read access mismatch for {}",
                path.display()
            );
            assert_eq!(
                sandbox_policy_allows_write(actual, &path, cwd),
                sandbox_policy_allows_write(expected, &path, cwd),
                "write access mismatch for {}",
                path.display()
            );
        }
    }

    #[test]
    fn external_sandbox_reports_full_access_flags() {
        let restricted = SandboxPolicy::ExternalSandbox {
            network_access: NetworkAccess::Restricted,
        };
        assert!(restricted.has_full_disk_write_access());
        assert!(!restricted.has_full_network_access());

        let enabled = SandboxPolicy::ExternalSandbox {
            network_access: NetworkAccess::Enabled,
        };
        assert!(enabled.has_full_disk_write_access());
        assert!(enabled.has_full_network_access());
    }

    #[test]
    fn read_only_reports_network_access_flags() {
        let restricted = SandboxPolicy::new_read_only_policy();
        assert!(!restricted.has_full_network_access());

        let enabled = SandboxPolicy::ReadOnly {
            network_access: true,
        };
        assert!(enabled.has_full_network_access());
    }

    #[test]
    fn granular_approval_config_mcp_elicitation_flag_is_field_driven() {
        assert!(
            GranularApprovalConfig {
                sandbox_approval: false,
                rules: false,
                skill_approval: false,
                request_permissions: false,
                mcp_elicitations: true,
            }
            .allows_mcp_elicitations()
        );
        assert!(
            !GranularApprovalConfig {
                sandbox_approval: false,
                rules: false,
                skill_approval: false,
                request_permissions: false,
                mcp_elicitations: false,
            }
            .allows_mcp_elicitations()
        );
    }

    #[test]
    fn granular_approval_config_skill_approval_flag_is_field_driven() {
        assert!(
            GranularApprovalConfig {
                sandbox_approval: false,
                rules: false,
                skill_approval: true,
                request_permissions: false,
                mcp_elicitations: false,
            }
            .allows_skill_approval()
        );
        assert!(
            !GranularApprovalConfig {
                sandbox_approval: false,
                rules: false,
                skill_approval: false,
                request_permissions: false,
                mcp_elicitations: false,
            }
            .allows_skill_approval()
        );
    }

    #[test]
    fn granular_approval_config_request_permissions_flag_is_field_driven() {
        assert!(
            GranularApprovalConfig {
                sandbox_approval: false,
                rules: false,
                skill_approval: false,
                request_permissions: true,
                mcp_elicitations: false,
            }
            .allows_request_permissions()
        );
        assert!(
            !GranularApprovalConfig {
                sandbox_approval: false,
                rules: false,
                skill_approval: false,
                request_permissions: false,
                mcp_elicitations: false,
            }
            .allows_request_permissions()
        );
    }

    #[test]
    fn granular_approval_config_defaults_missing_optional_flags_to_false() {
        let decoded = serde_json::from_value::<GranularApprovalConfig>(serde_json::json!({
            "sandbox_approval": true,
            "rules": false,
            "mcp_elicitations": true,
        }))
        .expect("granular approval config should deserialize");

        assert_eq!(
            decoded,
            GranularApprovalConfig {
                sandbox_approval: true,
                rules: false,
                skill_approval: false,
                request_permissions: false,
                mcp_elicitations: true,
            }
        );
    }

    #[test]
    fn restricted_file_system_policy_reports_full_access_from_root_entries() {
        let read_only = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::Root,
            },
            access: FileSystemAccessMode::Read,
        }]);
        assert!(read_only.has_full_disk_read_access());
        assert!(!read_only.has_full_disk_write_access());
        assert!(!read_only.include_platform_defaults());

        let writable = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::Root,
            },
            access: FileSystemAccessMode::Write,
        }]);
        assert!(writable.has_full_disk_read_access());
        assert!(writable.has_full_disk_write_access());
    }

    #[test]
    fn restricted_file_system_policy_treats_root_with_carveouts_as_scoped_access() {
        let cwd = TempDir::new().expect("tempdir");
        let canonical_cwd = codex_utils_absolute_path::canonicalize_preserving_symlinks(cwd.path())
            .expect("canonicalize cwd");
        let root = AbsolutePathBuf::from_absolute_path(&canonical_cwd)
            .expect("absolute canonical tempdir")
            .as_path()
            .ancestors()
            .last()
            .and_then(|path| AbsolutePathBuf::from_absolute_path(path).ok())
            .expect("filesystem root");
        let blocked = AbsolutePathBuf::resolve_path_against_base("blocked", cwd.path());
        let expected_blocked = AbsolutePathBuf::from_absolute_path(
            codex_utils_absolute_path::canonicalize_preserving_symlinks(cwd.path())
                .expect("canonicalize cwd")
                .join("blocked"),
        )
        .expect("canonical blocked");
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: blocked },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        assert!(!policy.has_full_disk_read_access());
        assert!(!policy.has_full_disk_write_access());
        assert_eq!(
            policy.get_readable_roots_with_cwd(cwd.path()),
            vec![root.clone()]
        );
        assert_eq!(
            policy.get_unreadable_roots_with_cwd(cwd.path()),
            vec![expected_blocked.clone()]
        );

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(writable_roots[0].root, root);
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .iter()
                .any(|path| path.as_path() == expected_blocked.as_path())
        );
    }

    #[test]
    fn restricted_file_system_policy_derives_effective_paths() {
        let cwd = TempDir::new().expect("tempdir");
        std::fs::create_dir_all(cwd.path().join(".agents")).expect("create .agents");
        std::fs::create_dir_all(cwd.path().join(".codex")).expect("create .codex");
        let canonical_cwd = codex_utils_absolute_path::canonicalize_preserving_symlinks(cwd.path())
            .expect("canonicalize cwd");
        let cwd_absolute =
            AbsolutePathBuf::from_absolute_path(&canonical_cwd).expect("absolute tempdir");
        let secret = AbsolutePathBuf::resolve_path_against_base("secret", cwd.path());
        let expected_secret = AbsolutePathBuf::from_absolute_path(canonical_cwd.join("secret"))
            .expect("canonical secret");
        let expected_agents = AbsolutePathBuf::from_absolute_path(canonical_cwd.join(".agents"))
            .expect("canonical .agents");
        let expected_codex = AbsolutePathBuf::from_absolute_path(canonical_cwd.join(".codex"))
            .expect("canonical .codex");
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Minimal,
                },
                access: FileSystemAccessMode::Read,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: secret },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        assert!(!policy.has_full_disk_read_access());
        assert!(!policy.has_full_disk_write_access());
        assert!(policy.include_platform_defaults());
        assert_eq!(
            policy.get_readable_roots_with_cwd(cwd.path()),
            vec![cwd_absolute.clone()]
        );
        assert_eq!(
            policy.get_unreadable_roots_with_cwd(cwd.path()),
            vec![expected_secret.clone()]
        );

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(writable_roots[0].root, cwd_absolute);
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .iter()
                .any(|path| path.as_path() == expected_secret.as_path())
        );
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .iter()
                .any(|path| path.as_path() == expected_agents.as_path())
        );
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .iter()
                .any(|path| path.as_path() == expected_codex.as_path())
        );
    }

    #[test]
    fn restricted_file_system_policy_treats_read_entries_as_read_only_subpaths() {
        let cwd = TempDir::new().expect("tempdir");
        let canonical_cwd = codex_utils_absolute_path::canonicalize_preserving_symlinks(cwd.path())
            .expect("canonicalize cwd");
        let docs = AbsolutePathBuf::resolve_path_against_base("docs", cwd.path());
        let docs_public = AbsolutePathBuf::resolve_path_against_base("docs/public", cwd.path());
        let expected_docs = AbsolutePathBuf::from_absolute_path(canonical_cwd.join("docs"))
            .expect("canonical docs");
        let expected_docs_public =
            AbsolutePathBuf::from_absolute_path(canonical_cwd.join("docs/public"))
                .expect("canonical docs/public");
        let expected_dot_codex = AbsolutePathBuf::from_absolute_path(canonical_cwd.join(".codex"))
            .expect("canonical .codex");
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: docs },
                access: FileSystemAccessMode::Read,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: docs_public },
                access: FileSystemAccessMode::Write,
            },
        ]);

        assert!(!policy.has_full_disk_write_access());
        assert_eq!(
            sorted_writable_roots(policy.get_writable_roots_with_cwd(cwd.path())),
            vec![
                (
                    canonical_cwd,
                    vec![
                        expected_dot_codex.to_path_buf(),
                        expected_docs.to_path_buf()
                    ],
                ),
                (expected_docs_public.to_path_buf(), Vec::new()),
            ]
        );
    }

    #[test]
    fn file_system_policy_rejects_legacy_bridge_for_non_workspace_writes() {
        let cwd = if cfg!(windows) {
            Path::new(r"C:\workspace")
        } else {
            Path::new("/tmp/workspace")
        };
        let external_write_path = if cfg!(windows) {
            AbsolutePathBuf::from_absolute_path(r"C:\temp").expect("absolute windows temp path")
        } else {
            AbsolutePathBuf::from_absolute_path("/tmp").expect("absolute tmp path")
        };
        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Path {
                path: external_write_path,
            },
            access: FileSystemAccessMode::Write,
        }]);

        let err = policy
            .to_legacy_sandbox_policy(NetworkSandboxPolicy::Restricted, cwd)
            .expect_err("non-workspace writes should be rejected");

        assert!(
            err.to_string()
                .contains("filesystem writes outside the workspace root"),
            "{err}"
        );
    }

    #[test]
    fn legacy_sandbox_policy_semantics_survive_split_bridge() {
        let cwd = TempDir::new().expect("tempdir");
        let writable_root = AbsolutePathBuf::resolve_path_against_base("writable", cwd.path());
        let policies = [
            SandboxPolicy::DangerFullAccess,
            SandboxPolicy::ExternalSandbox {
                network_access: NetworkAccess::Restricted,
            },
            SandboxPolicy::ExternalSandbox {
                network_access: NetworkAccess::Enabled,
            },
            SandboxPolicy::ReadOnly {
                network_access: false,
            },
            SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            },
            SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![writable_root],
                network_access: true,
                exclude_tmpdir_env_var: false,
                exclude_slash_tmp: true,
            },
        ];

        for expected in policies {
            let actual =
                FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd(&expected, cwd.path())
                    .to_legacy_sandbox_policy(NetworkSandboxPolicy::from(&expected), cwd.path())
                    .expect("legacy bridge should preserve legacy policy semantics");

            assert_same_sandbox_policy_semantics(&expected, &actual, cwd.path());
        }
    }

    #[test]
    fn item_started_event_from_web_search_emits_begin_event() {
        let event = ItemStartedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            item: TurnItem::WebSearch(WebSearchItem {
                id: "search-1".into(),
                query: "find docs".into(),
                action: WebSearchAction::Search {
                    query: Some("find docs".into()),
                    queries: None,
                },
            }),
            started_at_ms: 0,
        };

        let legacy_events = event.as_legacy_events(/*show_raw_agent_reasoning*/ false);
        assert_eq!(legacy_events.len(), 1);
        match &legacy_events[0] {
            EventMsg::WebSearchBegin(event) => assert_eq!(event.call_id, "search-1"),
            _ => panic!("expected WebSearchBegin event"),
        }
    }

    #[test]
    fn item_started_event_from_non_web_search_emits_no_legacy_events() {
        let event = ItemStartedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            item: TurnItem::UserMessage(UserMessageItem::new(&[])),
            started_at_ms: 0,
        };

        assert!(
            event
                .as_legacy_events(/*show_raw_agent_reasoning*/ false)
                .is_empty()
        );
    }

    #[test]
    fn item_started_event_from_image_generation_emits_begin_event() {
        let event = ItemStartedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            item: TurnItem::ImageGeneration(ImageGenerationItem {
                id: "ig-1".into(),
                status: "in_progress".into(),
                revised_prompt: None,
                result: String::new(),
                saved_path: None,
            }),
            started_at_ms: 0,
        };

        let legacy_events = event.as_legacy_events(/*show_raw_agent_reasoning*/ false);
        assert_eq!(legacy_events.len(), 1);
        match &legacy_events[0] {
            EventMsg::ImageGenerationBegin(event) => assert_eq!(event.call_id, "ig-1"),
            _ => panic!("expected ImageGenerationBegin event"),
        }
    }

    #[test]
    fn item_started_event_from_file_change_emits_patch_begin_event() {
        let event = ItemStartedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            started_at_ms: 0,
            item: TurnItem::FileChange(FileChangeItem {
                id: "patch-1".into(),
                changes: [(
                    PathBuf::from("new.txt"),
                    FileChange::Add {
                        content: "hello".into(),
                    },
                )]
                .into_iter()
                .collect(),
                status: None,
                auto_approved: Some(true),
                stdout: None,
                stderr: None,
            }),
        };

        let legacy_events = event.as_legacy_events(/*show_raw_agent_reasoning*/ false);
        assert_eq!(legacy_events.len(), 1);
        match &legacy_events[0] {
            EventMsg::PatchApplyBegin(event) => {
                assert_eq!(event.call_id, "patch-1");
                assert_eq!(event.turn_id, "turn-1");
                assert!(event.auto_approved);
                assert!(event.changes.contains_key(&PathBuf::from("new.txt")));
            }
            _ => panic!("expected PatchApplyBegin event"),
        }
    }

    #[test]
    fn item_started_event_from_mcp_tool_call_emits_begin_event() {
        let event = ItemStartedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            started_at_ms: 0,
            item: TurnItem::McpToolCall(McpToolCallItem {
                id: "mcp-1".into(),
                server: "server".into(),
                tool: "tool".into(),
                arguments: json!({"arg": "value"}),
                connector_id: Some("connector".into()),
                mcp_app_resource_uri: Some("app://connector".into()),
                link_id: Some("link_123".into()),
                app_name: Some("Calendar".into()),
                template_id: Some("calendar_template".into()),
                action_name: Some("create_event".into()),
                plugin_id: Some("sample@test".into()),
                status: McpToolCallStatus::InProgress,
                result: None,
                error: None,
                duration: None,
            }),
        };

        let legacy_events = event.as_legacy_events(/*show_raw_agent_reasoning*/ false);
        assert_eq!(legacy_events.len(), 1);
        match &legacy_events[0] {
            EventMsg::McpToolCallBegin(event) => {
                assert_eq!(event.call_id, "mcp-1");
                assert_eq!(event.invocation.server, "server");
                assert_eq!(event.invocation.tool, "tool");
                assert_eq!(event.connector_id.as_deref(), Some("connector"));
                assert_eq!(
                    event.mcp_app_resource_uri.as_deref(),
                    Some("app://connector")
                );
                assert_eq!(event.link_id.as_deref(), Some("link_123"));
                assert_eq!(event.app_name.as_deref(), Some("Calendar"));
                assert_eq!(event.action_name.as_deref(), Some("create_event"));
                assert_eq!(event.plugin_id.as_deref(), Some("sample@test"));
            }
            _ => panic!("expected McpToolCallBegin event"),
        }
    }

    #[test]
    fn item_completed_event_from_image_generation_emits_end_event() {
        let event = ItemCompletedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            item: TurnItem::ImageGeneration(ImageGenerationItem {
                id: "ig-1".into(),
                status: "completed".into(),
                revised_prompt: Some("A tiny blue square".into()),
                result: "Zm9v".into(),
                saved_path: Some(test_path_buf("/tmp/ig-1.png").abs()),
            }),
            completed_at_ms: 0,
        };

        let legacy_events = event.as_legacy_events(/*show_raw_agent_reasoning*/ false);
        assert_eq!(legacy_events.len(), 1);
        match &legacy_events[0] {
            EventMsg::ImageGenerationEnd(event) => {
                assert_eq!(event.call_id, "ig-1");
                assert_eq!(event.status, "completed");
                assert_eq!(event.revised_prompt.as_deref(), Some("A tiny blue square"));
                assert_eq!(event.result, "Zm9v");
                assert_eq!(
                    event.saved_path.as_ref().map(AbsolutePathBuf::as_path),
                    Some(test_path_buf("/tmp/ig-1.png").as_path())
                );
            }
            _ => panic!("expected ImageGenerationEnd event"),
        }
    }

    #[test]
    fn item_completed_event_from_file_change_emits_patch_end_event() {
        let event = ItemCompletedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            completed_at_ms: 0,
            item: TurnItem::FileChange(FileChangeItem {
                id: "patch-1".into(),
                changes: [(
                    PathBuf::from("new.txt"),
                    FileChange::Add {
                        content: "hello".into(),
                    },
                )]
                .into_iter()
                .collect(),
                status: Some(PatchApplyStatus::Completed),
                auto_approved: None,
                stdout: Some("Done!".into()),
                stderr: Some(String::new()),
            }),
        };

        let legacy_events = event.as_legacy_events(/*show_raw_agent_reasoning*/ false);
        assert_eq!(legacy_events.len(), 1);
        match &legacy_events[0] {
            EventMsg::PatchApplyEnd(event) => {
                assert_eq!(event.call_id, "patch-1");
                assert_eq!(event.turn_id, "turn-1");
                assert_eq!(event.stdout, "Done!");
                assert!(event.success);
                assert_eq!(event.status, PatchApplyStatus::Completed);
                assert!(event.changes.contains_key(&PathBuf::from("new.txt")));
            }
            _ => panic!("expected PatchApplyEnd event"),
        }
    }

    #[test]
    fn item_completed_event_from_mcp_tool_call_emits_end_event() {
        let event = ItemCompletedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            completed_at_ms: 0,
            item: TurnItem::McpToolCall(McpToolCallItem {
                id: "mcp-1".into(),
                server: "server".into(),
                tool: "tool".into(),
                arguments: json!({"arg": "value"}),
                connector_id: Some("connector".into()),
                mcp_app_resource_uri: Some("app://connector".into()),
                link_id: Some("link_123".into()),
                app_name: Some("Calendar".into()),
                template_id: Some("calendar_template".into()),
                action_name: Some("create_event".into()),
                plugin_id: Some("sample@test".into()),
                status: McpToolCallStatus::Completed,
                result: Some(CallToolResult {
                    content: vec![json!({"type": "text", "text": "ok"})],
                    structured_content: None,
                    is_error: Some(false),
                    meta: None,
                }),
                error: None,
                duration: Some(Duration::from_millis(42)),
            }),
        };

        let legacy_events = event.as_legacy_events(/*show_raw_agent_reasoning*/ false);
        assert_eq!(legacy_events.len(), 1);
        match &legacy_events[0] {
            EventMsg::McpToolCallEnd(event) => {
                assert_eq!(event.call_id, "mcp-1");
                assert_eq!(event.invocation.server, "server");
                assert_eq!(event.invocation.tool, "tool");
                assert_eq!(event.connector_id.as_deref(), Some("connector"));
                assert_eq!(
                    event.mcp_app_resource_uri.as_deref(),
                    Some("app://connector")
                );
                assert_eq!(event.link_id.as_deref(), Some("link_123"));
                assert_eq!(event.app_name.as_deref(), Some("Calendar"));
                assert_eq!(event.action_name.as_deref(), Some("create_event"));
                assert_eq!(event.plugin_id.as_deref(), Some("sample@test"));
                assert_eq!(event.duration, Duration::from_millis(42));
                assert!(event.is_success());
            }
            _ => panic!("expected McpToolCallEnd event"),
        }
    }

    #[test]
    fn item_started_event_requires_started_at_ms() {
        let mut value = serde_json::to_value(ItemStartedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            item: TurnItem::UserMessage(UserMessageItem::new(&[])),
            started_at_ms: 123,
        })
        .unwrap();
        value.as_object_mut().unwrap().remove("started_at_ms");

        assert!(serde_json::from_value::<ItemStartedEvent>(value).is_err());
    }

    #[test]
    fn item_completed_event_defaults_missing_completed_at_ms() {
        let mut value = serde_json::to_value(ItemCompletedEvent {
            thread_id: ThreadId::new(),
            turn_id: "turn-1".into(),
            item: TurnItem::UserMessage(UserMessageItem::new(&[])),
            completed_at_ms: 123,
        })
        .unwrap();
        value.as_object_mut().unwrap().remove("completed_at_ms");

        let event = serde_json::from_value::<ItemCompletedEvent>(value).unwrap();
        assert_eq!(event.completed_at_ms, 0);
    }
    #[test]
    fn rollback_failed_error_does_not_affect_turn_status() {
        let event = ErrorEvent {
            message: "rollback failed".into(),
            codex_error_info: Some(CodexErrorInfo::ThreadRollbackFailed),
        };
        assert!(!event.affects_turn_status());
    }

    #[test]
    fn active_turn_not_steerable_error_does_not_affect_turn_status() {
        let event = ErrorEvent {
            message: "cannot steer a review turn".into(),
            codex_error_info: Some(CodexErrorInfo::ActiveTurnNotSteerable {
                turn_kind: NonSteerableTurnKind::Review,
            }),
        };
        assert!(!event.affects_turn_status());
    }

    #[test]
    fn generic_error_affects_turn_status() {
        let event = ErrorEvent {
            message: "generic".into(),
            codex_error_info: Some(CodexErrorInfo::Other),
        };
        assert!(event.affects_turn_status());
    }

    #[test]
    fn realtime_conversation_started_event_uses_realtime_session_id() {
        let event = RealtimeConversationStartedEvent {
            realtime_session_id: Some("conv_1".to_string()),
            version: RealtimeConversationVersion::V2,
        };

        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "realtime_session_id": "conv_1",
                "version": "v2"
            })
        );
    }

    #[test]
    fn realtime_voice_list_is_stable() {
        assert_eq!(
            RealtimeVoicesList::builtin(),
            RealtimeVoicesList {
                v1: vec![
                    RealtimeVoice::Juniper,
                    RealtimeVoice::Maple,
                    RealtimeVoice::Spruce,
                    RealtimeVoice::Ember,
                    RealtimeVoice::Vale,
                    RealtimeVoice::Breeze,
                    RealtimeVoice::Arbor,
                    RealtimeVoice::Sol,
                    RealtimeVoice::Cove,
                ],
                v2: vec![
                    RealtimeVoice::Alloy,
                    RealtimeVoice::Ash,
                    RealtimeVoice::Ballad,
                    RealtimeVoice::Coral,
                    RealtimeVoice::Echo,
                    RealtimeVoice::Sage,
                    RealtimeVoice::Shimmer,
                    RealtimeVoice::Verse,
                    RealtimeVoice::Marin,
                    RealtimeVoice::Cedar,
                ],
                default_v1: RealtimeVoice::Cove,
                default_v2: RealtimeVoice::Marin,
            }
        );
    }

    #[test]
    fn user_input_text_serializes_empty_text_elements() -> Result<()> {
        let input = UserInput::Text {
            text: "hello".to_string(),
            text_elements: Vec::new(),
        };

        let json_input = serde_json::to_value(input)?;
        assert_eq!(
            json_input,
            json!({
                "type": "text",
                "text": "hello",
                "text_elements": [],
            })
        );

        Ok(())
    }

    #[test]
    fn user_message_event_serializes_empty_metadata_vectors() -> Result<()> {
        let event = UserMessageEvent {
            client_id: None,
            message: "hello".to_string(),
            images: None,
            local_images: Vec::new(),
            text_elements: Vec::new(),
            ..Default::default()
        };

        let json_event = serde_json::to_value(event)?;
        assert_eq!(
            json_event,
            json!({
                "message": "hello",
                "local_images": [],
                "text_elements": [],
            })
        );

        Ok(())
    }

    #[test]
    fn user_message_event_deserializes_without_image_detail_fields() -> Result<()> {
        let event: UserMessageEvent = serde_json::from_value(json!({
            "message": "hello",
            "images": ["https://example.com/image.png"],
            "local_images": ["/tmp/local.png"],
            "text_elements": [],
        }))?;

        assert_eq!(event.message, "hello");
        assert_eq!(
            event.images,
            Some(vec!["https://example.com/image.png".to_string()])
        );
        assert_eq!(event.image_details, Vec::<Option<ImageDetail>>::new());
        assert_eq!(event.local_images, vec![PathBuf::from("/tmp/local.png")]);
        assert_eq!(event.local_image_details, Vec::<Option<ImageDetail>>::new());
        assert_eq!(event.text_elements, Vec::new());

        Ok(())
    }

    #[test]
    fn user_message_item_legacy_event_preserves_image_details() {
        let local_path = PathBuf::from("/tmp/local.png");
        let mut item = UserMessageItem::new(&[
            crate::user_input::UserInput::Image {
                image_url: "https://example.com/first.png".to_string(),
                detail: Some(ImageDetail::Original),
            },
            crate::user_input::UserInput::Image {
                image_url: "https://example.com/second.png".to_string(),
                detail: None,
            },
            crate::user_input::UserInput::LocalImage {
                path: local_path.clone(),
                detail: Some(ImageDetail::Original),
            },
        ]);
        item.client_id = Some("client-message-1".to_string());

        let EventMsg::UserMessage(event) = item.as_legacy_event() else {
            panic!("expected user message event");
        };

        assert_eq!(
            event.images,
            Some(vec![
                "https://example.com/first.png".to_string(),
                "https://example.com/second.png".to_string(),
            ])
        );
        assert_eq!(event.client_id, Some("client-message-1".to_string()));
        assert_eq!(event.image_details, vec![Some(ImageDetail::Original)]);
        assert_eq!(event.local_images, vec![local_path]);
        assert_eq!(event.local_image_details, vec![Some(ImageDetail::Original)]);
    }

    #[test]
    fn turn_aborted_event_deserializes_without_turn_id() -> Result<()> {
        let event: EventMsg = serde_json::from_value(json!({
            "type": "turn_aborted",
            "reason": "interrupted",
        }))?;

        match event {
            EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id, reason, ..
            }) => {
                assert_eq!(turn_id, None);
                assert_eq!(reason, TurnAbortReason::Interrupted);
            }
            _ => panic!("expected turn_aborted event"),
        }

        Ok(())
    }

    #[test]
    fn session_meta_defaults_legacy_history_mode() -> Result<()> {
        let session_meta: SessionMeta = serde_json::from_value(json!({
            "session_id": "00000000-0000-0000-0000-000000000001",
            "id": "00000000-0000-0000-0000-000000000001",
            "timestamp": "2026-01-01T00:00:00Z",
            "cwd": "/tmp",
            "originator": "codex",
            "cli_version": "0.0.0",
            "model_provider": null,
            "base_instructions": null
        }))?;

        assert_eq!(session_meta.history_mode, ThreadHistoryMode::Legacy);
        let serialized = serde_json::to_value(&session_meta)?;
        assert_eq!(serialized["history_mode"], json!("legacy"));
        let mut unknown = serialized;
        unknown["history_mode"] = json!("future");
        assert!(serde_json::from_value::<SessionMeta>(unknown).is_err());
        Ok(())
    }

    #[test]
    fn resumed_history_uses_persisted_history_mode() -> Result<()> {
        let thread_id = ThreadId::from_string("00000000-0000-0000-0000-000000000001")?;
        let session_meta = RolloutItem::SessionMeta(SessionMetaLine {
            meta: SessionMeta {
                session_id: thread_id.into(),
                id: thread_id,
                history_mode: ThreadHistoryMode::Paginated,
                ..SessionMeta::default()
            },
            git: None,
        });
        let history = InitialHistory::Resumed(ResumedHistory {
            conversation_id: thread_id,
            history: Arc::new(vec![session_meta.clone()]),
            rollout_path: None,
        });

        assert_eq!(
            history.get_history_mode(ThreadHistoryMode::Legacy),
            ThreadHistoryMode::Paginated
        );
        assert_eq!(
            InitialHistory::Forked(vec![session_meta]).get_history_mode(ThreadHistoryMode::Legacy),
            ThreadHistoryMode::Legacy
        );
        assert_eq!(
            InitialHistory::New.get_history_mode(ThreadHistoryMode::Paginated),
            ThreadHistoryMode::Paginated
        );
        assert_eq!(
            InitialHistory::Resumed(ResumedHistory {
                conversation_id: thread_id,
                history: Arc::new(Vec::new()),
                rollout_path: None,
            })
            .get_history_mode(ThreadHistoryMode::Paginated),
            ThreadHistoryMode::Paginated
        );
        Ok(())
    }

    #[test]
    fn turn_context_item_deserializes_without_network() -> Result<()> {
        let item: TurnContextItem = serde_json::from_value(json!({
            "cwd": test_path_buf("/tmp"),
            "approval_policy": "never",
            "sandbox_policy": { "type": "danger-full-access" },
            "model": "gpt-5",
            "summary": "auto",
        }))?;

        assert_eq!(item.network, None);
        assert_eq!(item.file_system_sandbox_policy, None);
        assert_eq!(item.comp_hash, None);
        Ok(())
    }

    #[test]
    fn turn_context_item_deserializes_legacy_on_failure_as_on_request() -> Result<()> {
        let item: TurnContextItem = serde_json::from_value(json!({
            "cwd": test_path_buf("/tmp"),
            "approval_policy": "on-failure",
            "sandbox_policy": { "type": "danger-full-access" },
            "model": "gpt-5",
            "summary": "auto",
        }))?;

        assert_eq!(item.approval_policy, AskForApproval::OnRequest);
        Ok(())
    }

    #[test]
    fn multi_agent_version_uses_newest_present_session_meta_value() -> Result<()> {
        let thread_id = ThreadId::from_string("67e55044-10b1-426f-9247-bb680e5fe0c8")?;
        let older_meta = SessionMetaLine {
            meta: SessionMeta {
                session_id: thread_id.into(),
                id: thread_id,
                multi_agent_version: Some(MultiAgentVersion::V2),
                ..Default::default()
            },
            git: None,
        };
        let newer_meta_without_version = SessionMetaLine {
            meta: SessionMeta {
                session_id: thread_id.into(),
                id: thread_id,
                multi_agent_version: None,
                ..Default::default()
            },
            git: None,
        };

        assert_eq!(
            multi_agent_version_from_items(
                &[
                    RolloutItem::SessionMeta(older_meta),
                    RolloutItem::SessionMeta(newer_meta_without_version),
                ],
                Some(thread_id),
            ),
            Some(MultiAgentVersion::V2)
        );
        Ok(())
    }

    #[test]
    fn latest_effective_multi_agent_mode_uses_latest_turn_context_even_when_unset() -> Result<()> {
        let turn_context_item = |multi_agent_mode| -> Result<RolloutItem> {
            let mut value = json!({
                "cwd": test_path_buf("/tmp"),
                "approval_policy": "never",
                "sandbox_policy": { "type": "danger-full-access" },
                "model": "gpt-5",
                "summary": "auto",
            });
            value["multi_agent_mode"] = serde_json::to_value(multi_agent_mode)?;
            Ok(RolloutItem::TurnContext(serde_json::from_value(value)?))
        };

        assert_eq!(
            InitialHistory::Forked(vec![
                turn_context_item(Some(MultiAgentMode::Proactive))?,
                turn_context_item(/*multi_agent_mode*/ None)?,
            ])
            .get_latest_effective_multi_agent_mode(),
            None
        );
        Ok(())
    }

    #[test]
    fn turn_context_item_serializes_network_when_present() -> Result<()> {
        let item = TurnContextItem {
            turn_id: None,
            cwd: test_path_buf("/tmp").abs(),
            workspace_roots: None,
            current_date: None,
            timezone: None,
            approval_policy: AskForApproval::Never,
            sandbox_policy: SandboxPolicy::DangerFullAccess,
            permission_profile: None,
            network: Some(TurnContextNetworkItem {
                allowed_domains: vec!["api.example.com".to_string()],
                denied_domains: vec!["blocked.example.com".to_string()],
            }),
            file_system_sandbox_policy: Some(FileSystemSandboxPolicy::restricted(vec![
                FileSystemSandboxEntry {
                    path: FileSystemPath::GlobPattern {
                        pattern: "/tmp/private/**/*.txt".to_string(),
                    },
                    access: FileSystemAccessMode::Deny,
                },
            ])),
            model: "gpt-5".to_string(),
            comp_hash: None,
            personality: None,
            collaboration_mode: None,
            multi_agent_version: None,
            multi_agent_mode: None,
            realtime_active: None,
            effort: None,
            summary: ReasoningSummaryConfig::Auto,
        };

        let value = serde_json::to_value(item)?;
        assert_eq!(
            value["network"],
            json!({
                "allowed_domains": ["api.example.com"],
                "denied_domains": ["blocked.example.com"],
            })
        );
        assert_eq!(
            value["file_system_sandbox_policy"],
            json!({
                "kind": "restricted",
                "entries": [{
                    "path": {
                        "type": "glob_pattern",
                        "pattern": "/tmp/private/**/*.txt"
                    },
                    "access": "deny"
                }]
            })
        );
        assert_eq!(value["summary"], json!("auto"));
        Ok(())
    }

    /// Serialize Event to verify that its JSON representation has the expected
    /// amount of nesting.
    #[test]
    fn serialize_event() -> Result<()> {
        let session_id = SessionId::from_string("67e55044-10b1-426f-9247-bb680e5fe0c7")?;
        let thread_id = ThreadId::from_string("67e55044-10b1-426f-9247-bb680e5fe0c8")?;
        let rollout_file = NamedTempFile::new()?;
        let permission_profile = PermissionProfile::read_only();
        let event = Event {
            id: "1234".to_string(),
            msg: EventMsg::SessionConfigured(SessionConfiguredEvent {
                session_id,
                thread_id,
                forked_from_id: None,
                parent_thread_id: None,
                thread_source: None,
                thread_name: None,
                model: "codex-mini-latest".to_string(),
                model_provider_id: "openai".to_string(),
                service_tier: None,
                approval_policy: AskForApproval::Never,
                approvals_reviewer: ApprovalsReviewer::User,
                permission_profile: permission_profile.clone(),
                active_permission_profile: None,
                cwd: test_path_buf("/home/user/project").abs(),
                reasoning_effort: Some(ReasoningEffortConfig::default()),
                initial_messages: None,
                network_proxy: None,
                rollout_path: Some(rollout_file.path().to_path_buf()),
            }),
        };

        let expected = json!({
            "id": "1234",
            "msg": {
                "type": "session_configured",
                "session_id": "67e55044-10b1-426f-9247-bb680e5fe0c7",
                "thread_id": "67e55044-10b1-426f-9247-bb680e5fe0c8",
                "model": "codex-mini-latest",
                "model_provider_id": "openai",
                "approval_policy": "never",
                "approvals_reviewer": "user",
                "permission_profile": permission_profile,
                "cwd": test_path_buf("/home/user/project"),
                "reasoning_effort": "medium",
                "rollout_path": format!("{}", rollout_file.path().display()),
            }
        });
        assert_eq!(expected, serde_json::to_value(&event)?);
        Ok(())
    }

    #[test]
    fn deserialize_legacy_session_configured_event_uses_sandbox_policy() -> Result<()> {
        let cwd = test_path_buf("/home/user/project");
        let value = json!({
            "session_id": "67e55044-10b1-426f-9247-bb680e5fe0c8",
            "model": "codex-mini-latest",
            "model_provider_id": "openai",
            "approval_policy": "never",
            "approvals_reviewer": "user",
            "sandbox_policy": {
                "type": "read-only"
            },
            "cwd": cwd,
        });

        let event: SessionConfiguredEvent = serde_json::from_value(value)?;
        assert_eq!(event.permission_profile, PermissionProfile::read_only());
        Ok(())
    }

    #[test]
    fn vec_u8_as_base64_serialization_and_deserialization() -> Result<()> {
        let event = ExecCommandOutputDeltaEvent {
            call_id: "call21".to_string(),
            stream: ExecOutputStream::Stdout,
            chunk: vec![1, 2, 3, 4, 5],
        };
        let serialized = serde_json::to_string(&event)?;
        assert_eq!(
            r#"{"call_id":"call21","stream":"stdout","chunk":"AQIDBAU="}"#,
            serialized,
        );

        let deserialized: ExecCommandOutputDeltaEvent = serde_json::from_str(&serialized)?;
        assert_eq!(deserialized, event);
        Ok(())
    }

    #[test]
    fn serialize_mcp_startup_update_event() -> Result<()> {
        let event = Event {
            id: "init".to_string(),
            msg: EventMsg::McpStartupUpdate(McpStartupUpdateEvent {
                server: "srv".to_string(),
                status: McpStartupStatus::Failed {
                    error: "boom".to_string(),
                    reason: Some(McpStartupFailureReason::ReauthenticationRequired),
                },
            }),
        };

        let value = serde_json::to_value(&event)?;
        assert_eq!(value["msg"]["type"], "mcp_startup_update");
        assert_eq!(value["msg"]["server"], "srv");
        assert_eq!(value["msg"]["status"]["state"], "failed");
        assert_eq!(value["msg"]["status"]["error"], "boom");
        assert_eq!(
            value["msg"]["status"]["reason"],
            "reauthentication_required"
        );
        Ok(())
    }

    #[test]
    fn serialize_mcp_startup_complete_event() -> Result<()> {
        let event = Event {
            id: "init".to_string(),
            msg: EventMsg::McpStartupComplete(McpStartupCompleteEvent {
                ready: vec!["a".to_string()],
                failed: vec![McpStartupFailure {
                    server: "b".to_string(),
                    error: "bad".to_string(),
                }],
                cancelled: vec!["c".to_string()],
            }),
        };

        let value = serde_json::to_value(&event)?;
        assert_eq!(value["msg"]["type"], "mcp_startup_complete");
        assert_eq!(value["msg"]["ready"][0], "a");
        assert_eq!(value["msg"]["failed"][0]["server"], "b");
        assert_eq!(value["msg"]["failed"][0]["error"], "bad");
        assert_eq!(value["msg"]["cancelled"][0], "c");
        Ok(())
    }

    #[test]
    fn token_usage_info_new_or_append_updates_context_window_when_provided() {
        let initial = Some(TokenUsageInfo {
            total_token_usage: TokenUsage::default(),
            last_token_usage: TokenUsage::default(),
            model_context_window: Some(258_400),
        });
        let last = Some(TokenUsage {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 10,
        });

        let info = TokenUsageInfo::new_or_append(&initial, &last, Some(128_000))
            .expect("new_or_append should return info");

        assert_eq!(info.model_context_window, Some(128_000));
    }

    #[test]
    fn token_usage_info_new_or_append_preserves_context_window_when_not_provided() {
        let initial = Some(TokenUsageInfo {
            total_token_usage: TokenUsage::default(),
            last_token_usage: TokenUsage::default(),
            model_context_window: Some(258_400),
        });
        let last = Some(TokenUsage {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 10,
        });

        let info =
            TokenUsageInfo::new_or_append(&initial, &last, /*model_context_window*/ None)
                .expect("new_or_append should return info");

        assert_eq!(info.model_context_window, Some(258_400));
    }
}
