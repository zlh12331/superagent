//! 命名 profile 配置类型。
//!
//! 定义 [`ConfigProfile`]——用户可在 `config.toml` 的 `[profiles.<name>]`
//! 表中声明的配置单元，用于在多组配置间快速切换。profile 中的字段会
//! 覆盖顶层 `ConfigToml` 的对应字段。

use codex_utils_absolute_path::AbsolutePathBuf;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

use crate::config_toml::ToolsToml;
use crate::types::AnalyticsConfigToml;
use crate::types::ApprovalsReviewer;
use crate::types::Personality;
use crate::types::SessionPickerViewMode;
use crate::types::WindowsToml;
use codex_features::FeaturesToml;
use codex_protocol::config_types::ReasoningSummary;
use codex_protocol::config_types::SandboxMode;
use codex_protocol::config_types::Verbosity;
use codex_protocol::config_types::WebSearchMode;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::AskForApproval;

/// 用户可在 `config.toml` 中定义为单元的通用配置选项集合。
///
/// 通过 `[profiles.<name>]` 声明，激活时覆盖顶层对应字段。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ConfigProfile {
    /// 模型选择覆盖。
    pub model: Option<String>,
    /// 新 turn 的显式 service tier（如 `default`、`priority`、`flex`；legacy `fast` 也可用）。
    pub service_tier: Option<String>,
    /// `model_providers` map 中标识 [`ModelProviderInfo`] 的 key。
    pub model_provider: Option<String>,
    /// 默认审批策略。
    pub approval_policy: Option<AskForApproval>,
    /// 审批请求路由到的 reviewer。
    pub approvals_reviewer: Option<ApprovalsReviewer>,
    /// sandbox 模式。
    pub sandbox_mode: Option<SandboxMode>,
    /// 模型推理 effort。
    pub model_reasoning_effort: Option<ReasoningEffort>,
    /// plan 模式推理 effort。
    pub plan_mode_reasoning_effort: Option<ReasoningEffort>,
    /// 推理摘要级别。
    pub model_reasoning_summary: Option<ReasoningSummary>,
    /// 模型输出 verbosity。
    pub model_verbosity: Option<Verbosity>,
    /// JSON 模型目录路径（仅启动时应用）。
    pub model_catalog_json: Option<AbsolutePathBuf>,
    /// 模型人格设置。
    pub personality: Option<Personality>,
    /// ChatGPT base URL 覆盖。
    pub chatgpt_base_url: Option<String>,
    /// 模型指令文件路径。
    pub model_instructions_file: Option<AbsolutePathBuf>,
    /// 已废弃：忽略。
    #[schemars(skip)]
    pub js_repl_node_path: Option<AbsolutePathBuf>,
    /// 已废弃：忽略。
    #[schemars(skip)]
    pub js_repl_node_module_dirs: Option<Vec<AbsolutePathBuf>>,
    /// compact prompt 文件路径（实验性）。
    pub experimental_compact_prompt_file: Option<AbsolutePathBuf>,
    /// 是否注入 `<permissions instructions>` developer block。
    pub include_permissions_instructions: Option<bool>,
    /// 是否注入 `<apps_instructions>` developer block。
    pub include_apps_instructions: Option<bool>,
    /// 是否注入 `<collaboration_mode>` developer block。
    pub include_collaboration_mode_instructions: Option<bool>,
    /// 是否注入 `<environment_context>` user block。
    pub include_environment_context: Option<bool>,
    /// 是否使用统一 exec 工具（实验性）。
    pub experimental_use_unified_exec_tool: Option<bool>,
    /// 工具配置。
    pub tools: Option<ToolsToml>,
    /// web search 模式。
    pub web_search: Option<WebSearchMode>,
    /// analytics 配置。
    pub analytics: Option<AnalyticsConfigToml>,
    /// profile 范围的 TUI 设置。
    #[serde(default)]
    pub tui: Option<ProfileTui>,
    /// profile 范围的 Windows 设置。
    #[serde(default)]
    pub windows: Option<WindowsToml>,
    /// profile 范围的 feature 开关。
    #[serde(default)]
    // 注入已知 feature key 到 schema 并禁止未知 key。
    #[schemars(schema_with = "crate::schema::features_schema")]
    pub features: Option<FeaturesToml>,
    /// 首选 OSS provider（如 `lmstudio`、`ollama`）。
    pub oss_provider: Option<String>,
}

/// 命名 profile 内支持的 TUI 设置。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct ProfileTui {
    /// resume/fork session picker 的首选布局。
    #[serde(default)]
    pub session_picker_view: Option<SessionPickerViewMode>,
}
