//! 用于定义已加载与有效 Codex 配置值的类型。
//!
//! 本文件主要包含简单的 struct/enum 定义，不包含业务逻辑。

// 注意：本文件应仅限于简单的 struct/enum 定义，不包含业务逻辑。

pub use crate::mcp_types::AppToolApproval;
pub use crate::mcp_types::McpServerAuth;
pub use crate::mcp_types::McpServerConfig;
pub use crate::mcp_types::McpServerDisabledReason;
pub use crate::mcp_types::McpServerEnvVar;
pub use crate::mcp_types::McpServerOAuthConfig;
pub use crate::mcp_types::McpServerToolConfig;
pub use crate::mcp_types::McpServerTransportConfig;
pub use crate::mcp_types::RawMcpServerConfig;
pub use codex_protocol::config_types::AltScreenMode;
pub use codex_protocol::config_types::ApprovalsReviewer;
use codex_protocol::config_types::EnvironmentVariablePattern;
pub use codex_protocol::config_types::ModeKind;
pub use codex_protocol::config_types::Personality;
pub use codex_protocol::config_types::ServiceTier;
use codex_protocol::config_types::ShellEnvironmentPolicy;
use codex_protocol::config_types::ShellEnvironmentPolicyInherit;
pub use codex_protocol::config_types::WebSearchMode;
use codex_utils_absolute_path::AbsolutePathBuf;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::fmt;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

pub use crate::tui_keymap::KeybindingSpec;
pub use crate::tui_keymap::KeybindingsSpec;
pub use crate::tui_keymap::MAX_FUNCTION_KEY;
pub use crate::tui_keymap::TuiApprovalKeymap;
pub use crate::tui_keymap::TuiChatKeymap;
pub use crate::tui_keymap::TuiComposerKeymap;
pub use crate::tui_keymap::TuiEditorKeymap;
pub use crate::tui_keymap::TuiGlobalKeymap;
pub use crate::tui_keymap::TuiKeymap;
pub use crate::tui_keymap::TuiListKeymap;
pub use crate::tui_keymap::TuiPagerKeymap;
pub use crate::tui_keymap::TuiVimNormalKeymap;
pub use crate::tui_keymap::TuiVimOperatorKeymap;

/// OTEL 环境字段的默认值。
pub const DEFAULT_OTEL_ENVIRONMENT: &str = "dev";
/// 每次 startup 处理的 memory rollout 候选最大数量默认值。
pub const DEFAULT_MEMORIES_MAX_ROLLOUTS_PER_STARTUP: usize = 2;
/// 用于 memory 的 thread 最大年龄（天）默认值。
pub const DEFAULT_MEMORIES_MAX_ROLLOUT_AGE_DAYS: i64 = 10;
/// 上次 thread 活动到 memory 创建之间的最小空闲时间（小时）默认值。
pub const DEFAULT_MEMORIES_MIN_ROLLOUT_IDLE_HOURS: i64 = 6;
/// memory startup 运行前 Codex 限流窗口中要求的最小剩余百分比默认值。
pub const DEFAULT_MEMORIES_MIN_RATE_LIMIT_REMAINING_PERCENT: i64 = 25;
/// 全局 consolidation 保留的最近原始 memory 最大数量默认值。
pub const DEFAULT_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION: usize = 256;
/// memory 多少天未使用后不再参与 phase 2 选择的默认值。
pub const DEFAULT_MEMORIES_MAX_UNUSED_DAYS: i64 = 30;
/// `max_raw_memories_for_consolidation` 的最小允许值。
const MIN_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION: usize = 1;
/// `max_raw_memories_for_consolidation` 的最大允许值。
const MAX_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION: usize = 4096;
/// `max_rollouts_per_startup` 的最小允许值。
const MIN_MEMORIES_MAX_ROLLOUTS_PER_STARTUP: usize = 1;
/// `max_rollouts_per_startup` 的最大允许值。
const MAX_MEMORIES_MAX_ROLLOUTS_PER_STARTUP: usize = 128;

/// 布尔字段的默认值函数：默认启用。
const fn default_enabled() -> bool {
    true
}

/// resume/fork 会话选择器的首选布局。
#[derive(Serialize, Deserialize, Debug, Default, Copy, Clone, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SessionPickerViewMode {
    /// 宽松布局，每项占用更多垂直空间。
    Comfortable,
    /// 紧凑布局（默认），每项占用较少垂直空间。
    #[default]
    Dense,
}

impl SessionPickerViewMode {
    /// 返回该布局的字符串标识。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Comfortable => "comfortable",
            Self::Dense => "dense",
        }
    }
}

impl fmt::Display for SessionPickerViewMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 决定 Codex 应将 CLI auth 凭据存储在哪里。
#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AuthCredentialsStoreMode {
    /// 将凭据持久化到 `CODEX_HOME/auth.json`。
    #[default]
    File,
    /// 将凭据持久化到 keyring。不可用时失败。
    Keyring,
    /// keyring 可用时使用 keyring；否则回退到 `CODEX_HOME` 中的文件。
    Auto,
    /// 仅在当前进程中将凭据存储在内存中。
    Ephemeral,
}

/// 决定 Codex 应在哪里存储和读取 MCP 凭据。
#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OAuthCredentialsStoreMode {
    /// keyring 可用时使用 keyring；否则使用文件。
    /// keyring 中的凭据仅 Codex 可读，除非用户通过 OS 级 keyring 访问显式授权。
    #[default]
    Auto,
    /// `CODEX_HOME/.credentials.json`
    /// 该文件对 Codex 和以同一用户身份运行的其他应用可读。
    File,
    /// keyring 可用时使用 keyring，否则失败。
    Keyring,
}

/// 决定 auth 凭据应如何使用 keyring 后端存储。
#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AuthKeyringBackendKind {
    /// 将序列化的 auth payload 直接存储在 OS keyring 中。
    Direct,
    /// 将 auth payload 存储在本地加密 secrets 文件中，文件密钥存储在 OS keyring 中。
    Secrets,
}

impl Default for AuthKeyringBackendKind {
    fn default() -> Self {
        // Windows 默认使用 Secrets 后端，其他平台使用 Direct。
        if cfg!(windows) {
            Self::Secrets
        } else {
            Self::Direct
        }
    }
}

/// Windows sandbox 模式的 TOML 表示。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum WindowsSandboxModeToml {
    /// 提权模式。
    Elevated,
    /// 非提权模式。
    Unelevated,
}

/// Windows 专属配置。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct WindowsToml {
    /// sandbox 模式。
    pub sandbox: Option<WindowsSandboxModeToml>,
    /// 默认 `true`。设为 `false` 时在 `Winsta0\\Default` 上启动最终的
    /// sandboxed 子进程，而非私有桌面。
    pub sandbox_private_desktop: Option<bool>,
}

/// 基于 URI 的文件打开器枚举。
#[derive(Serialize, Deserialize, Debug, Copy, Clone, PartialEq, JsonSchema)]
pub enum UriBasedFileOpener {
    /// VS Code。
    #[serde(rename = "vscode")]
    VsCode,

    /// VS Code Insiders。
    #[serde(rename = "vscode-insiders")]
    VsCodeInsiders,

    /// Windsurf 编辑器。
    #[serde(rename = "windsurf")]
    Windsurf,

    /// Cursor 编辑器。
    #[serde(rename = "cursor")]
    Cursor,

    /// 禁用基于 URI 的文件打开器。
    #[serde(rename = "none")]
    None,
}

impl UriBasedFileOpener {
    /// 返回该打开器对应的 URI scheme（`None` 表示禁用）。
    pub fn get_scheme(&self) -> Option<&str> {
        match self {
            UriBasedFileOpener::VsCode => Some("vscode"),
            UriBasedFileOpener::VsCodeInsiders => Some("vscode-insiders"),
            UriBasedFileOpener::Windsurf => Some("windsurf"),
            UriBasedFileOpener::Cursor => Some("cursor"),
            UriBasedFileOpener::None => None,
        }
    }
}

/// 控制是否写入以及写入什么内容到 `~/.codex/history.jsonl` 的设置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[serde(default)]
#[schemars(deny_unknown_fields)]
pub struct History {
    /// 为 `true` 时不将历史条目写入磁盘。
    pub persistence: HistoryPersistence,

    /// 若设置，历史文件的最大字节数。文件超过此限制时丢弃最旧的条目。
    pub max_bytes: Option<usize>,
}

/// 历史持久化策略。
#[derive(Serialize, Deserialize, Debug, Copy, Clone, PartialEq, Default, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryPersistence {
    /// 将所有历史条目保存到磁盘。
    #[default]
    SaveAll,
    /// 不将历史写入磁盘。
    None,
}

// ===== Analytics 配置 =====

/// 从 `config.toml` 加载的 Analytics 设置。字段为可选以便应用默认值。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct AnalyticsConfigToml {
    /// 为 `false` 时，在此 profile 中禁用所有 Codex 产品界面的 analytics。
    pub enabled: Option<bool>,
}

/// 反馈流配置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct FeedbackConfigToml {
    /// 为 `false` 时，禁用所有 Codex 产品界面的反馈流。
    pub enabled: Option<bool>,
}

/// 工具建议可发现类型。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolSuggestDiscoverableType {
    /// Connector 类型。
    Connector,
    /// Plugin 类型。
    Plugin,
}

/// 可发现的工具建议项。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Hash, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ToolSuggestDiscoverable {
    /// 类型（connector/plugin）。
    #[serde(rename = "type")]
    pub kind: ToolSuggestDiscoverableType,
    /// 标识符。
    pub id: String,
}

/// 已禁用的工具建议项。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Hash, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ToolSuggestDisabledTool {
    /// 类型（connector/plugin）。
    #[serde(rename = "type")]
    pub kind: ToolSuggestDiscoverableType,
    /// 标识符。
    pub id: String,
}

impl ToolSuggestDisabledTool {
    /// 构造一个 plugin 类型的禁用工具项。
    pub fn plugin(id: impl Into<String>) -> Self {
        Self {
            kind: ToolSuggestDiscoverableType::Plugin,
            id: id.into(),
        }
    }

    /// 构造一个 connector 类型的禁用工具项。
    pub fn connector(id: impl Into<String>) -> Self {
        Self {
            kind: ToolSuggestDiscoverableType::Connector,
            id: id.into(),
        }
    }

    /// 返回规范化后的项（id 去除首尾空白后非空时返回 `Some`，否则 `None`）。
    pub fn normalized(&self) -> Option<Self> {
        let id = self.id.trim();
        (!id.is_empty()).then(|| Self {
            kind: self.kind,
            id: id.to_string(),
        })
    }
}

/// 工具建议配置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ToolSuggestConfig {
    /// 可发现项列表。
    #[serde(default)]
    pub discoverables: Vec<ToolSuggestDiscoverable>,
    /// 已禁用工具列表。
    #[serde(default)]
    pub disabled_tools: Vec<ToolSuggestDisabledTool>,
}

/// 从 `config.toml` 加载的 Memories 设置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct MemoriesToml {
    /// 为 `true` 时，外部上下文源将 thread 的 `memory_mode` 标记为 `"polluted"`。
    #[serde(alias = "no_memories_if_mcp_or_web_search")]
    pub disable_on_external_context: Option<bool>,
    /// 为 `false` 时，新创建的 thread 在 state DB 中以 `memory_mode = "disabled"` 存储。
    pub generate_memories: Option<bool>,
    /// 为 `false` 时，跳过向 developer prompt 注入 memory 使用指令。
    pub use_memories: Option<bool>,
    /// 为 `true` 时，通过 extension tool surface 暴露专用 memory 工具。
    pub dedicated_tools: Option<bool>,
    /// 全局 consolidation 保留的最近原始 memory 最大数量。
    #[schemars(range(min = 1, max = 4096))]
    pub max_raw_memories_for_consolidation: Option<usize>,
    /// memory 多少天未使用后不再参与 phase 2 选择。
    pub max_unused_days: Option<i64>,
    /// 用于 memory 的 thread 最大年龄（天）。
    pub max_rollout_age_days: Option<i64>,
    /// 每次处理的最大 rollout 候选数量。
    #[schemars(range(min = 1, max = 128))]
    pub max_rollouts_per_startup: Option<usize>,
    /// 上次 thread 活动到 memory 创建之间的最小空闲时间（小时）。建议 > 12h。
    pub min_rollout_idle_hours: Option<i64>,
    /// memory startup 运行前 Codex 限流窗口中要求的最小剩余百分比。
    #[schemars(range(min = 0, max = 100))]
    pub min_rate_limit_remaining_percent: Option<i64>,
    /// 用于 thread 摘要的模型。
    pub extract_model: Option<String>,
    /// 用于 memory consolidation 的模型。
    pub consolidation_model: Option<String>,
}

/// 应用默认值后的有效 Memories 设置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MemoriesConfig {
    /// 是否在外部上下文存在时禁用 memory。
    pub disable_on_external_context: bool,
    /// 是否生成 memory。
    pub generate_memories: bool,
    /// 是否使用 memory。
    pub use_memories: bool,
    /// 是否暴露专用 memory 工具。
    pub dedicated_tools: bool,
    /// 全局 consolidation 保留的最近原始 memory 最大数量。
    pub max_raw_memories_for_consolidation: usize,
    /// memory 多少天未使用后不再参与选择。
    pub max_unused_days: i64,
    /// 用于 memory 的 thread 最大年龄（天）。
    pub max_rollout_age_days: i64,
    /// 每次处理的 rollout 候选最大数量。
    pub max_rollouts_per_startup: usize,
    /// 最小空闲时间（小时）。
    pub min_rollout_idle_hours: i64,
    /// 限流窗口最小剩余百分比。
    pub min_rate_limit_remaining_percent: i64,
    /// thread 摘要模型。
    pub extract_model: Option<String>,
    /// memory consolidation 模型。
    pub consolidation_model: Option<String>,
}

impl Default for MemoriesConfig {
    fn default() -> Self {
        Self {
            disable_on_external_context: false,
            generate_memories: true,
            use_memories: true,
            dedicated_tools: false,
            max_raw_memories_for_consolidation: DEFAULT_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION,
            max_unused_days: DEFAULT_MEMORIES_MAX_UNUSED_DAYS,
            max_rollout_age_days: DEFAULT_MEMORIES_MAX_ROLLOUT_AGE_DAYS,
            max_rollouts_per_startup: DEFAULT_MEMORIES_MAX_ROLLOUTS_PER_STARTUP,
            min_rollout_idle_hours: DEFAULT_MEMORIES_MIN_ROLLOUT_IDLE_HOURS,
            min_rate_limit_remaining_percent: DEFAULT_MEMORIES_MIN_RATE_LIMIT_REMAINING_PERCENT,
            extract_model: None,
            consolidation_model: None,
        }
    }
}

impl From<MemoriesToml> for MemoriesConfig {
    fn from(toml: MemoriesToml) -> Self {
        // 未指定时默认继承完整环境。
        let defaults = Self::default();
        Self {
            disable_on_external_context: toml
                .disable_on_external_context
                .unwrap_or(defaults.disable_on_external_context),
            generate_memories: toml.generate_memories.unwrap_or(defaults.generate_memories),
            use_memories: toml.use_memories.unwrap_or(defaults.use_memories),
            dedicated_tools: toml.dedicated_tools.unwrap_or(defaults.dedicated_tools),
            // 数值字段应用 clamp 以确保在合法范围内。
            max_raw_memories_for_consolidation: toml
                .max_raw_memories_for_consolidation
                .unwrap_or(defaults.max_raw_memories_for_consolidation)
                .clamp(
                    MIN_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION,
                    MAX_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION,
                ),
            max_unused_days: toml
                .max_unused_days
                .unwrap_or(defaults.max_unused_days)
                .clamp(0, 365),
            max_rollout_age_days: toml
                .max_rollout_age_days
                .unwrap_or(defaults.max_rollout_age_days)
                .clamp(0, 90),
            max_rollouts_per_startup: toml
                .max_rollouts_per_startup
                .unwrap_or(defaults.max_rollouts_per_startup)
                .clamp(
                    MIN_MEMORIES_MAX_ROLLOUTS_PER_STARTUP,
                    MAX_MEMORIES_MAX_ROLLOUTS_PER_STARTUP,
                ),
            min_rollout_idle_hours: toml
                .min_rollout_idle_hours
                .unwrap_or(defaults.min_rollout_idle_hours)
                .clamp(1, 48),
            min_rate_limit_remaining_percent: toml
                .min_rate_limit_remaining_percent
                .unwrap_or(defaults.min_rate_limit_remaining_percent)
                .clamp(0, 100),
            extract_model: toml.extract_model,
            consolidation_model: toml.consolidation_model,
        }
    }
}

/// 适用于所有 app 的默认设置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct AppsDefaultConfig {
    /// 为 `false` 时，除非被 per-app 设置覆盖，否则 app 被禁用。
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// 审批提示的 reviewer，除非被 per-app 设置覆盖。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<ApprovalsReviewer>,

    /// 是否默认允许 `destructive_hint = true` 的工具。
    #[serde(
        default = "default_enabled",
        skip_serializing_if = "std::clone::Clone::clone"
    )]
    pub destructive_enabled: bool,

    /// 是否默认允许 `open_world_hint = true` 的工具。
    #[serde(
        default = "default_enabled",
        skip_serializing_if = "std::clone::Clone::clone"
    )]
    pub open_world_enabled: bool,

    /// 工具的审批模式，除非被 per-app 或 per-tool 设置覆盖。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_tools_approval_mode: Option<AppToolApproval>,
}

/// 单个 app 工具的 per-tool 设置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct AppToolConfig {
    /// 是否启用此工具。`Some(true)` 显式允许此工具。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,

    /// 此工具的审批模式。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<AppToolApproval>,
}

/// 单个 app 的工具设置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct AppToolsConfig {
    /// 按 tool name（如 `repos/list`）索引的 per-tool 覆盖。
    #[serde(default, flatten)]
    pub tools: HashMap<String, AppToolConfig>,
}

/// 单个 app/connector 的配置值。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct AppConfig {
    /// 为 `false` 时，Codex 不展示此 app。
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// 此 app 审批提示的 reviewer，覆盖 thread 默认值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<ApprovalsReviewer>,

    /// 是否允许此 app 的 `destructive_hint = true` 工具。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructive_enabled: Option<bool>,

    /// 是否允许此 app 的 `open_world_hint = true` 工具。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_world_enabled: Option<bool>,

    /// 此 app 工具的审批模式，除非存在 tool 覆盖。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_tools_approval_mode: Option<AppToolApproval>,

    /// 此 app 是否默认启用工具。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_tools_enabled: Option<bool>,

    /// 此 app 的 per-tool 设置。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<AppToolsConfig>,
}

/// 从 `config.toml` 加载的 app/connector 设置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct AppsConfigToml {
    /// 所有 app 的默认设置。
    #[serde(default, rename = "_default", skip_serializing_if = "Option::is_none")]
    pub default: Option<AppsDefaultConfig>,

    /// 按 app ID（如 `[apps.google_drive]`）索引的 per-app 设置。
    #[serde(default, flatten)]
    pub apps: HashMap<String, AppConfig>,
}

// ===== OTEL 配置 =====

/// OTEL HTTP 协议。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum OtelHttpProtocol {
    /// 二进制 payload。
    Binary,
    /// JSON payload。
    Json,
}

/// OTEL TLS 配置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
#[serde(rename_all = "kebab-case")]
pub struct OtelTlsConfig {
    /// CA 证书路径。
    pub ca_certificate: Option<AbsolutePathBuf>,
    /// 客户端证书路径。
    pub client_certificate: Option<AbsolutePathBuf>,
    /// 客户端私钥路径。
    pub client_private_key: Option<AbsolutePathBuf>,
}

/// 选择使用哪种 OTEL exporter。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema)]
#[schemars(deny_unknown_fields)]
#[serde(rename_all = "kebab-case")]
pub enum OtelExporterKind {
    /// 不导出。
    None,
    /// 通过 Statsig 导出。
    Statsig,
    /// 通过 OTLP over HTTP 导出。
    OtlpHttp {
        /// exporter endpoint。
        endpoint: String,
        /// 附加 HTTP 头。
        #[serde(default)]
        headers: HashMap<String, String>,
        /// HTTP 协议（binary/json）。
        protocol: OtelHttpProtocol,
        /// TLS 配置。
        #[serde(default)]
        tls: Option<OtelTlsConfig>,
    },
    /// 通过 OTLP over gRPC 导出。
    OtlpGrpc {
        /// exporter endpoint。
        endpoint: String,
        /// 附加 HTTP 头。
        #[serde(default)]
        headers: HashMap<String, String>,
        /// TLS 配置。
        #[serde(default)]
        tls: Option<OtelTlsConfig>,
    },
}

/// 从 `config.toml` 加载的 OTEL 设置。字段为可选以便应用默认值。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct OtelConfigToml {
    /// 是否在 trace 中记录用户 prompt。
    pub log_user_prompt: Option<bool>,

    /// 用环境标记 trace（dev/staging/prod/test）。默认 dev。
    pub environment: Option<String>,

    /// 可选的日志 exporter。
    pub exporter: Option<OtelExporterKind>,

    /// 可选的 trace exporter。
    pub trace_exporter: Option<OtelExporterKind>,

    /// 可选的 metrics exporter。
    pub metrics_exporter: Option<OtelExporterKind>,

    /// 添加到每个导出 trace span 的属性。
    pub span_attributes: Option<BTreeMap<String, String>>,

    /// 以分号分隔的 `key:value` 字段，upsert 到 W3C tracestate 成员中。
    pub tracestate: Option<BTreeMap<String, BTreeMap<String, String>>>,
}

/// 应用默认值后的有效 OTEL 设置。
#[derive(Debug, Clone, PartialEq)]
pub struct OtelConfig {
    /// 是否记录用户 prompt。
    pub log_user_prompt: bool,
    /// 环境标识。
    pub environment: String,
    /// 日志 exporter。
    pub exporter: OtelExporterKind,
    /// trace exporter。
    pub trace_exporter: OtelExporterKind,
    /// metrics exporter。
    pub metrics_exporter: OtelExporterKind,
    /// span 属性。
    pub span_attributes: BTreeMap<String, String>,
    /// tracestate 成员。
    pub tracestate: BTreeMap<String, BTreeMap<String, String>>,
}

impl Default for OtelConfig {
    fn default() -> Self {
        OtelConfig {
            log_user_prompt: false,
            environment: DEFAULT_OTEL_ENVIRONMENT.to_owned(),
            exporter: OtelExporterKind::None,
            trace_exporter: OtelExporterKind::None,
            // metrics 默认走 Statsig。
            metrics_exporter: OtelExporterKind::Statsig,
            span_attributes: BTreeMap::new(),
            tracestate: BTreeMap::new(),
        }
    }
}

/// 通知设置，支持布尔开关或自定义事件列表。
#[derive(Serialize, Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Notifications {
    /// 布尔开关：启用/禁用所有默认通知。
    Enabled(bool),
    /// 自定义通知事件名称列表。
    Custom(Vec<String>),
}

impl Default for Notifications {
    fn default() -> Self {
        Self::Enabled(true)
    }
}

/// 通知发送方法。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum NotificationMethod {
    /// 自动选择（默认）。
    #[default]
    Auto,
    /// OSC 9 转义序列。
    Osc9,
    /// BEL 字符。
    Bel,
}

impl fmt::Display for NotificationMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NotificationMethod::Auto => write!(f, "auto"),
            NotificationMethod::Osc9 => write!(f, "osc9"),
            NotificationMethod::Bel => write!(f, "bel"),
        }
    }
}

/// 通知触发条件。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum NotificationCondition {
    /// 仅在终端未聚焦时发送 TUI 通知。
    #[default]
    Unfocused,
    /// 无论终端是否聚焦都发送 TUI 通知。
    Always,
}

impl fmt::Display for NotificationCondition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NotificationCondition::Unfocused => write!(f, "unfocused"),
            NotificationCondition::Always => write!(f, "always"),
        }
    }
}

/// 终端宠物的垂直锚点。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TuiPetAnchor {
    /// 将宠物锚定到当前 TUI composer 视口底部。
    #[default]
    Composer,
    /// 将宠物锚定到终端屏幕的物理底部。
    ScreenBottom,
}

/// TUI 通知设置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct TuiNotificationSettings {
    /// 启用来自 TUI 的桌面通知。默认 `true`。
    #[serde(default, rename = "notifications")]
    pub notifications: Notifications,

    /// 终端通知方法。默认 `auto`。
    #[serde(default, rename = "notification_method")]
    pub method: NotificationMethod,

    /// 控制 TUI 通知仅在终端未聚焦时发送还是无论焦点都发送。
    /// 默认 `unfocused`。
    #[serde(default, rename = "notification_condition")]
    pub condition: NotificationCondition,
}

/// 模型可用性 NUX（新用户体验）配置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ModelAvailabilityNuxConfig {
    /// 每个 model slug 显示 startup 可用性 NUX 的次数。
    #[serde(default, flatten)]
    pub shown_count: HashMap<String, u32>,
}

/// 当 Codex 无法识别终端特定 scrollback 大小时，resize-reflow 行数上限的回退默认值。
pub const DEFAULT_TERMINAL_RESIZE_REFLOW_FALLBACK_MAX_ROWS: usize = 1_000;

/// TUI 专属设置的集合。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct Tui {
    /// 通知设置（展开到顶层）。
    #[serde(default, flatten)]
    pub notification_settings: TuiNotificationSettings,

    /// 启用动画（欢迎屏、shimmer 效果、spinner）。默认 `true`。
    #[serde(default = "default_true")]
    pub animations: bool,

    /// 在 TUI 欢迎屏显示启动 tooltip。默认 `true`。
    #[serde(default = "default_true")]
    pub show_tooltips: bool,

    /// 默认以 Vim 模式（`Normal`）启动 composer。默认 `false`。
    #[serde(default)]
    pub vim_mode_default: bool,

    /// 以原始 scrollback 模式启动 TUI，便于复制友好的 transcript 输出。
    /// 默认 `false`。
    #[serde(default)]
    pub raw_output_mode: bool,

    /// 控制 TUI 是否使用终端的 alternate screen buffer。
    ///
    /// - `auto`（默认）：使用 alternate screen。
    /// - `always`：始终使用 alternate screen。
    /// - `never`：从不使用 alternate screen（仅 inline 模式，保留 scrollback）。
    #[serde(default)]
    pub alternate_screen: AltScreenMode,

    /// 状态栏 item 标识符的有序列表。
    ///
    /// 设置后，TUI 将选中的 item 渲染为状态栏。
    /// 未设置时，TUI 默认为：`model-with-reasoning` 和 `current-dir`。
    #[serde(default)]
    pub status_line: Option<Vec<String>>,

    /// 用活跃语法主题派生的颜色为状态栏 item 着色。默认 `true`。
    #[serde(default = "default_true")]
    pub status_line_use_colors: bool,

    /// 终端标题 item 标识符的有序列表。
    ///
    /// 设置后，TUI 将选中的 item 渲染到终端窗口/标签标题。
    /// 未设置时，TUI 默认为：`activity` 和 `project`。
    /// `activity` item 在工作时旋转，在等待用户时显示需要操作的消息。
    #[serde(default)]
    pub terminal_title: Option<Vec<String>>,

    /// 语法高亮主题名称（kebab-case）。
    ///
    /// 设置后覆盖自动的亮/暗主题检测。
    /// 在 TUI 中使用 `/theme` 或查看 `$CODEX_HOME/themes` 了解自定义主题。
    #[serde(default)]
    pub theme: Option<String>,

    /// 在终端宠物选择器中预选的宠物 ID。
    ///
    /// 自定义宠物 ID 从 `CODEX_HOME/pets/<pet-id>/pet.json` 解析。
    #[serde(default)]
    pub pet: Option<String>,

    /// 终端宠物的垂直锚点。
    ///
    /// 默认 `composer`，跟随当前 TUI composer 视口。
    #[serde(default)]
    pub pet_anchor: TuiPetAnchor,

    /// resume/fork 会话选择器的首选布局。
    #[serde(default)]
    pub session_picker_view: Option<SessionPickerViewMode>,

    /// TUI 的 keybinding 覆盖。
    ///
    /// 支持按 context 和全局重新绑定选中的 action。
    /// Context 绑定优先于 `global` 绑定。
    #[serde(default)]
    pub keymap: TuiKeymap,

    /// TUI 持久化的启动 tooltip 可用性 NUX 状态。
    #[serde(default)]
    pub model_availability_nux: ModelAvailabilityNuxConfig,

    /// 当 transcript 超过此上限时，将终端 resize-reflow 重放裁剪到最近渲染的终端行。
    /// 省略时使用 Codex 的终端特定默认值。设为 `0` 时保留所有已渲染行。
    #[serde(default)]
    #[schemars(range(min = 0))]
    pub terminal_resize_reflow_max_rows: Option<usize>,
}

/// `default_true` 辅助函数：返回 `true` 作为 serde 默认值。
const fn default_true() -> bool {
    true
}

/// 通过 TUI 和 app-server 客户端（主要是 Codex IDE 扩展）向用户展示的
/// 通知设置。注意：这些与 notifications 不同——notices 是警告、NUX 屏、
/// 确认等。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ExternalConfigMigrationPrompts {
    /// 跟踪是否已隐藏 home 级外部配置迁移提示。
    pub home: Option<bool>,
    /// 跟踪上次显示 home 级外部配置迁移提示的时间。
    pub home_last_prompted_at: Option<i64>,
    /// 跟踪哪些项目路径已退出外部配置迁移提示。
    #[serde(default)]
    pub projects: BTreeMap<String, bool>,
    /// 跟踪上次显示项目级外部配置迁移提示的时间。
    #[serde(default)]
    pub project_last_prompted_at: BTreeMap<String, i64>,
}

/// 用户确认状态跟踪。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct Notice {
    /// 跟踪用户是否已确认完全访问警告提示。
    pub hide_full_access_warning: Option<bool>,
    /// 跟踪用户是否已确认 Windows world-writable 目录警告。
    pub hide_world_writable_warning: Option<bool>,
    /// 跟踪用户是否退出 Codex 管理的 fast 默认值。
    pub fast_default_opt_out: Option<bool>,
    /// 跟踪用户是否退出限流模型切换提醒。
    pub hide_rate_limit_model_nudge: Option<bool>,
    /// 跟踪用户是否已看到模型迁移提示。
    pub hide_gpt5_1_migration_prompt: Option<bool>,
    /// 跟踪用户是否已看到 gpt-5.1-codex-max 迁移提示。
    #[serde(rename = "hide_gpt-5.1-codex-max_migration_prompt")]
    pub hide_gpt_5_1_codex_max_migration_prompt: Option<bool>,
    /// 以 old->new model slug 映射跟踪已确认的模型迁移。
    #[serde(default)]
    pub model_migrations: BTreeMap<String, String>,
    /// 跟踪应抑制外部配置迁移提示的作用域。
    #[serde(default)]
    pub external_config_migration_prompts: ExternalConfigMigrationPrompts,
}

pub use crate::skills_config::BundledSkillsConfig;
pub use crate::skills_config::SkillConfig;
pub use crate::skills_config::SkillsConfig;

/// Plugin 配置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct PluginConfig {
    /// 是否启用此 plugin。默认 `true`。
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// 此 plugin 贡献的 MCP server 的 per-server policy 覆盖。
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub mcp_servers: HashMap<String, PluginMcpServerConfig>,
}

/// plugin 提供的 MCP server 的策略设置。
///
/// 刻意排除 transport 设置：plugin manifest 拥有 MCP server 的启动方式，
/// 而用户配置拥有启用状态与工具策略。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct PluginMcpServerConfig {
    /// 为 `false` 时，Codex 跳过初始化此 plugin MCP server。
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// 此 server 工具的审批模式，除非存在 tool 覆盖。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_tools_approval_mode: Option<AppToolApproval>,

    /// 此 server 暴露的工具的显式 allow-list。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_tools: Option<Vec<String>>,

    /// 工具的显式 deny-list。这些工具在应用 `enabled_tools` 之后被移除。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_tools: Option<Vec<String>>,

    /// 按 tool name 索引的 per-tool 审批设置。
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub tools: HashMap<String, McpServerToolConfig>,
}

impl Default for PluginMcpServerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            default_tools_approval_mode: None,
            enabled_tools: None,
            disabled_tools: None,
            tools: HashMap::new(),
        }
    }
}

/// Marketplace 配置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct MarketplaceConfig {
    /// 上次 Codex 成功添加或刷新此 marketplace 的时间。
    #[serde(default)]
    pub last_updated: Option<String>,
    /// Codex 上次成功激活的此 marketplace 的 Git revision。
    #[serde(default)]
    pub last_revision: Option<String>,
    /// 安装此 marketplace 时使用的来源类型。
    #[serde(default)]
    pub source_type: Option<MarketplaceSourceType>,
    /// 添加 marketplace 时使用的来源位置。
    #[serde(default)]
    pub source: Option<String>,
    /// `source_type` 为 `git` 时要 checkout 的 Git ref。
    #[serde(default, rename = "ref")]
    pub ref_name: Option<String>,
    /// `source_type` 为 `git` 时使用的 sparse checkout 路径。
    #[serde(default)]
    pub sparse_paths: Option<Vec<String>>,
}

/// Marketplace 来源类型。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MarketplaceSourceType {
    /// Git 仓库。
    Git,
    /// 本地路径。
    Local,
}

/// `sandbox_workspace_write` 配置。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct SandboxWorkspaceWrite {
    /// 可写根目录列表。
    #[serde(default)]
    pub writable_roots: Vec<AbsolutePathBuf>,
    /// 是否允许网络访问。
    #[serde(default)]
    pub network_access: bool,
    /// 是否排除 `TMPDIR` 环境变量。
    #[serde(default)]
    pub exclude_tmpdir_env_var: bool,
    /// 是否排除 `/tmp` 目录。
    #[serde(default)]
    pub exclude_slash_tmp: bool,
}

/// 通过 shell 类工具派生进程时构建 `env` 的策略。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ShellEnvironmentPolicyToml {
    /// 环境继承策略。
    pub inherit: Option<ShellEnvironmentPolicyInherit>,

    /// 是否忽略默认的排除列表。
    pub ignore_default_excludes: Option<bool>,

    /// 正则表达式列表，匹配的环境变量将被排除。
    pub exclude: Option<Vec<String>>,

    /// 要设置的环境变量键值对。
    pub r#set: Option<HashMap<String, String>>,

    /// 正则表达式列表，仅包含匹配的环境变量。
    pub include_only: Option<Vec<String>>,

    /// 是否实验性地使用 profile。
    pub experimental_use_profile: Option<bool>,
}

impl From<ShellEnvironmentPolicyToml> for ShellEnvironmentPolicy {
    fn from(toml: ShellEnvironmentPolicyToml) -> Self {
        // 未指定时默认继承完整环境。
        let inherit = toml.inherit.unwrap_or(ShellEnvironmentPolicyInherit::All);
        let ignore_default_excludes = toml.ignore_default_excludes.unwrap_or(true);
        let exclude = toml
            .exclude
            .unwrap_or_default()
            .into_iter()
            .map(|s| EnvironmentVariablePattern::new_case_insensitive(&s))
            .collect();
        let r#set = toml.r#set.unwrap_or_default();
        let include_only = toml
            .include_only
            .unwrap_or_default()
            .into_iter()
            .map(|s| EnvironmentVariablePattern::new_case_insensitive(&s))
            .collect();
        let use_profile = toml.experimental_use_profile.unwrap_or(false);

        Self {
            inherit,
            ignore_default_excludes,
            exclude,
            r#set,
            include_only,
            use_profile,
        }
    }
}

#[cfg(test)]
#[path = "types_tests.rs"]
mod tests;
