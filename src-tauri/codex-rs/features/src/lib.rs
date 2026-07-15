//! 集中化的功能开关（feature flags）与元数据。
//!
//! 本 crate 定义了功能注册表，以及从配置类输入解析生效功能集合的逻辑。
//! 每个功能通过 [`Feature`] 枚举标识，并通过 [`FeatureSpec`] 描述其
//! 键名、生命周期阶段（[`Stage`]）与默认启用状态。

use codex_otel::SessionTelemetry;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::WarningEvent;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use toml::Table;

mod feature_configs;
mod legacy;
/// Code Mode 功能的 TOML 配置类型。
pub use feature_configs::CodeModeConfigToml;
/// 当前时间提醒功能的 TOML 配置类型。
pub use feature_configs::CurrentTimeReminderConfigToml;
/// 当前时间提醒的投递模式。
pub use feature_configs::CurrentTimeReminderDeliveryMode;
/// 当前时间来源。
pub use feature_configs::CurrentTimeSource;
/// Multi-Agent V2 功能的 TOML 配置类型。
pub use feature_configs::MultiAgentV2ConfigToml;
/// 网络代理功能的 TOML 配置类型。
pub use feature_configs::NetworkProxyConfigToml;
/// 网络代理域名权限配置。
pub use feature_configs::NetworkProxyDomainPermissionToml;
/// 网络代理模式。
pub use feature_configs::NetworkProxyModeToml;
/// 网络代理 Unix socket 权限配置。
pub use feature_configs::NetworkProxyUnixSocketPermissionToml;
use feature_configs::RemovedAppsMcpPathOverrideConfigToml;
/// Rollout 预算功能的 TOML 配置类型。
pub use feature_configs::RolloutBudgetConfigToml;
/// Token 预算功能的 TOML 配置类型。
pub use feature_configs::TokenBudgetConfigToml;
use legacy::LegacyFeatureToggles;
/// 获取所有遗留功能键名。
pub use legacy::legacy_feature_keys;

/// 功能的高级生命周期阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// 仍在开发中、尚未准备好对外使用的功能。
    UnderDevelopment,
    /// 通过 `/experimental` 菜单向用户开放的实验性功能。
    Experimental {
        name: &'static str,
        menu_description: &'static str,
        announcement: &'static str,
    },
    /// 稳定功能。保留开关以便按需启用/禁用。
    Stable,
    /// 已弃用、不应再使用的功能。
    Deprecated,
    /// 开关已失效，但为向后兼容而保留。
    Removed,
}

impl Stage {
    /// 返回实验性功能在菜单中显示的名称，非实验性功能返回 `None`。
    pub fn experimental_menu_name(self) -> Option<&'static str> {
        match self {
            Stage::Experimental { name, .. } => Some(name),
            Stage::UnderDevelopment | Stage::Stable | Stage::Deprecated | Stage::Removed => None,
        }
    }

    /// 返回实验性功能在菜单中显示的描述，非实验性功能返回 `None`。
    pub fn experimental_menu_description(self) -> Option<&'static str> {
        match self {
            Stage::Experimental {
                menu_description, ..
            } => Some(menu_description),
            Stage::UnderDevelopment | Stage::Stable | Stage::Deprecated | Stage::Removed => None,
        }
    }

    /// 返回实验性功能的公告文本，非实验性功能或公告为空时返回 `None`。
    pub fn experimental_announcement(self) -> Option<&'static str> {
        match self {
            Stage::Experimental {
                announcement: "", ..
            } => None,
            Stage::Experimental { announcement, .. } => Some(announcement),
            Stage::UnderDevelopment | Stage::Stable | Stage::Deprecated | Stage::Removed => None,
        }
    }
}

/// 通过配置切换的唯一功能标识枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Feature {
    // 稳定功能
    /// 启用默认 shell 工具。
    ShellTool,
    /// 启用从 hooks.json 文件加载的 Claude 风格生命周期钩子。
    CodexHooks,
    /// 当选择 keyring 存储时，将 CLI 鉴权信息保存到加密的本地密钥后端。
    SecretAuthStorage,

    // 实验性功能
    /// 启用由进程内 V8 运行时支撑的 JavaScript code mode。
    CodeMode,
    /// 在独立宿主进程中运行 JavaScript code mode。
    CodeModeHost,
    /// 将模型可见工具限制为 code mode 入口（`exec`、`wait`）。
    CodeModeOnly,
    /// 使用单一统一的 PTY 支撑的 exec 工具。
    UnifiedExec,
    /// 通过 zsh exec 桥接路由 shell 工具执行。
    ShellZshFork,
    /// 允许 unified exec 与 zsh exec 桥接组合使用。
    ///
    /// 此开关仅为组合门控。单独启用它不会自动开启
    /// `unified_exec` 或 `shell_zsh_fork`，因为这两个功能有
    /// 独立的 rollout 和企业控制。
    UnifiedExecZshFork,
    /// 已移除的兼容开关。终端尺寸变化时的回滚重排现在始终启用。
    TerminalResizeReflow,
    /// 在 TUI 开发者指令中添加终端特定的可视化指引。
    TerminalVisualizationInstructions,
    /// 在生成 apply_patch 输入时流式传输结构化进度。
    ApplyPatchStreamingEvents,
    /// 允许 exec 工具在保持沙箱化的同时请求额外权限。
    ExecPermissionApprovals,
    /// 暴露内置的 request_permissions 工具。
    RequestPermissionsTool,
    /// 允许模型请求获取实时内容的 web 搜索。
    WebSearchRequest,
    /// 允许模型请求获取缓存内容的 web 搜索。
    /// 优先级高于 `WebSearchRequest`。
    WebSearchCached,
    /// 暴露由扩展支撑的独立 web 搜索工具。
    StandaloneWebSearch,
    /// 使用旧的 Landlock Linux 沙箱回退，而非默认的 bubblewrap 管道。
    UseLegacyLandlock,
    /// 实验性 shell 快照。
    ShellSnapshot,
    /// 允许在选定的执行器仍在启动时就开始 turn。
    DeferredExecutor,
    /// 通过手动读取器启用运行时指标快照。
    RuntimeMetrics,
    /// 启用启动时内存提取与基于文件的内存合并。
    MemoryTool,
    /// 压缩冷的本地 thread-store rollout 文件。
    LocalThreadStoreCompression,
    /// 启用 Chronicle 旁车进程，用于被动屏幕上下文记忆。
    Chronicle,
    /// 向 codex-backend 发送流式请求时压缩请求体（zstd）。
    EnableRequestCompression,
    /// 为沙箱化会话启动受管网络代理。
    NetworkProxy,
    /// 让 Codex 自有的网络客户端遵循宿主系统代理设置。
    RespectSystemProxy,
    /// 启用协作工具。
    Collab,
    /// 启用基于任务路径的多 agent 路由。
    MultiAgentV2,
    /// 已移除的兼容开关，保留为空操作。
    MultiAgentMode,
    /// 启用 CSV 支撑的 agent 作业工具。
    SpawnCsv,
    /// 启用 apps。
    Apps,
    /// 启用 MCP apps。
    EnableMcpApps,
    /// 已移除的兼容开关，用于旧版 Apps MCP 路径覆盖。
    AppsMcpPathOverride,
    /// 已移除的兼容开关，因 tool_search 现已始终启用而保留为空操作。
    ToolSearch,
    /// 已移除的兼容开关。当 tool_search 可用时 MCP 工具始终延迟。
    ToolSearchAlwaysDeferMcpTools,
    /// 暴露 MCP 模型可见命名空间，不带旧版 `mcp__` 前缀。
    NonPrefixedMcpToolNames,
    /// 启用 apps 的可发现工具建议。
    ToolSuggest,
    /// 启用插件。
    Plugins,
    /// 已移除的兼容开关，用于插件捆绑的生命周期钩子。
    PluginHooks,
    /// 允许桌面应用中的应用内浏览器面板。
    ///
    /// 仅需求门控：应从需求设置，而非用户配置。
    InAppBrowser,
    /// 允许桌面应用中的 Browser Use agent 集成。
    ///
    /// 仅需求门控：应从需求设置，而非用户配置。
    BrowserUse,
    /// 允许 Browser Use 集成访问完整的 Chrome DevTools Protocol 接口。
    ///
    /// 仅需求门控：应从需求设置，而非用户配置。
    BrowserUseFullCdpAccess,
    /// 允许 Browser Use 与外部浏览器集成。
    ///
    /// 仅需求门控：应从需求设置，而非用户配置。
    BrowserUseExternal,
    /// 允许 Codex Computer Use。
    ///
    /// 仅需求门控：应从需求设置，而非用户配置。
    ComputerUse,
    /// 启用 PS 支撑的远程插件目录。
    RemotePlugin,
    /// 启用远程插件分享流程。
    PluginSharing,
    /// 已移除的兼容开关，保留为空操作。
    ExternalMigration,
    /// 允许模型调用内置图像生成工具。
    ImageGeneration,
    /// 用独立 image-generation 扩展替换托管式图像生成。
    ImageGenExt,
    /// 已移除的兼容开关，用于始终开启的集中式图像准备。
    ResizeAllImages,
    /// 为客户端创建的历史项生成 Responses API item ID。
    ItemIds,
    /// 允许提示并安装缺失的 MCP 依赖。
    SkillMcpDependencyInstall,
    /// 已移除的兼容开关，用于已删除的技能环境变量依赖提示。
    SkillEnvVarDependencyPrompt,
    /// 启用 TUI 中默认使用的统一提及弹窗。
    MentionsV2,
    /// 允许在 Default 协作模式中使用 request_user_input。
    DefaultModeRequestUserInput,
    /// 启用审批提示的自动审查。
    GuardianApproval,
    /// 启用持久化的 thread 目标与自动目标延续。
    Goals,
    /// 将当前 context-window 元数据添加到模型可见上下文。
    TokenBudget,
    /// 跨会话 agent 线程跟踪并报告共享 token 预算。
    RolloutBudget,
    /// 将当前时间提醒添加到模型可见上下文。
    CurrentTimeReminder,
    /// 通过 MCP elicitation 请求路径路由 MCP 工具审批提示。
    ToolCallMcpElicitation,
    /// 通过 MCP URL elicitation 提示 Codex Apps 连接器鉴权失败。
    AuthElicitation,
    /// 在 TUI 中启用人格选择。
    Personality,
    /// 启用原生 artifact 工具。
    Artifact,
    /// 在 TUI 和请求层中启用 Fast 模式选择。
    FastMode,
    /// 在 TUI 中启用实验性实时语音对话模式。
    RealtimeConversation,
    /// 当 turn 正在运行时阻止系统空闲休眠。
    PreventIdleSleep,
    /// 在普通 Responses API 上启用远程压缩 v2。
    RemoteCompactionV2,
    /// 为 ChatGPT 鉴权的会话使用 Agent Identity。
    UseAgentIdentity,
    /// 启用工作区依赖支持。
    WorkspaceDependencies,

    // 已移除
    /// 已移除的兼容开关，保留为空操作以便旧配置仍能解析 `undo`。
    GhostCommit,
    /// 已移除的兼容开关，用于已删除的 JavaScript REPL 功能。
    JsRepl,
    /// 已移除的兼容开关，用于已删除的 JavaScript REPL 仅工具模式。
    JsReplToolsOnly,
    /// 旧版搜索工具功能开关，为向后兼容而保留。
    SearchTool,
    /// 已移除的旧版 Linux bubblewrap 选择开关，保留为空操作以便旧
    /// wrapper 和配置仍能解析。
    UseLinuxSandboxBwrap,
    /// 允许模型请求审批并提出 exec 规则。
    RequestRule,
    /// 在 Windows 上启用 Windows 沙箱（受限令牌）。
    WindowsSandbox,
    /// 使用提升的 Windows 沙箱管道（setup + runner）。
    WindowsSandboxElevated,
    /// 旧版远程模型开关，为向后兼容而保留。
    RemoteModels,
    /// 已移除的旧版 git commit 归属指引开关。
    CodexGitCommit,
    /// 将 rollout 元数据持久化到本地 SQLite 数据库。
    Sqlite,
    /// 已移除的兼容开关，用于已删除的 apply_patch 回退功能。
    ApplyPatchFreeform,
    /// 已移除的兼容开关，用于已删除的不可用工具占位回填。
    UnavailableDummyTools,
    /// Steer 功能开关——启用时 Enter 立即提交而非排队。
    /// 为配置向后兼容而保留；行为始终为 steer 启用。
    Steer,
    /// 启用协作模式（Plan、Default）。
    /// 为配置向后兼容而保留；行为始终为协作模式启用。
    CollaborationModes,
    /// 已移除的兼容开关，用于已删除的远程控制功能。
    RemoteControl,
    /// 已移除的兼容开关，保留为空操作以便旧 wrapper 仍能
    /// 传递 `--enable image_detail_original`。
    ImageDetailOriginal,
    /// 已移除的兼容开关。TUI 现在始终使用 app-server 实现。
    TuiAppServer,
    /// 已移除的兼容开关，因工作区所有者使用提示现已始终启用而保留为空操作。
    WorkspaceOwnerUsageNudge,
    /// 旧版 rollout 开关，用于 Responses API WebSocket 传输实验。
    ResponsesWebsockets,
    /// 旧版 rollout 开关，用于 Responses API WebSocket 传输 v2 实验。
    ResponsesWebsocketsV2,
}

impl Feature {
    /// 返回此功能在配置中使用的键名。
    pub fn key(self) -> &'static str {
        self.info().key
    }

    /// 返回此功能的生命周期阶段。
    pub fn stage(self) -> Stage {
        self.info().stage
    }

    /// 返回此功能是否默认启用。
    pub fn default_enabled(self) -> bool {
        self.info().default_enabled
    }

    fn info(self) -> &'static FeatureSpec {
        FEATURES
            .iter()
            .find(|spec| spec.id == self)
            .unwrap_or_else(|| unreachable!("missing FeatureSpec for {self:?}"))
    }
}

/// 记录一次遗留功能键的使用情况。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct LegacyFeatureUsage {
    pub alias: String,
    pub feature: Feature,
    pub summary: String,
    pub details: Option<String>,
}

/// 持有生效的已启用功能集合。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Features {
    enabled: BTreeSet<Feature>,
    legacy_usages: BTreeSet<LegacyFeatureUsage>,
}

/// 功能覆盖项，允许调用方在解析后强制调整个别功能的状态。
#[derive(Debug, Clone, Default)]
pub struct FeatureOverrides {
    pub web_search_request: Option<bool>,
}

/// 功能配置来源，描述从哪个 TOML 层级读取功能配置。
#[derive(Debug, Clone, Copy, Default)]
pub struct FeatureConfigSource<'a> {
    pub features: Option<&'a FeaturesToml>,
    pub experimental_use_unified_exec_tool: Option<bool>,
}

impl FeatureOverrides {
    fn apply(self, features: &mut Features) {
        if let Some(enabled) = self.web_search_request {
            if enabled {
                features.enable(Feature::WebSearchRequest);
            } else {
                features.disable(Feature::WebSearchRequest);
            }
            features.record_legacy_usage("web_search_request", Feature::WebSearchRequest);
        }
    }
}

impl Features {
    /// 以内置默认值创建功能集合。
    pub fn with_defaults() -> Self {
        let mut set = BTreeSet::new();
        for spec in FEATURES {
            if spec.default_enabled {
                set.insert(spec.id);
            }
        }
        Self {
            enabled: set,
            legacy_usages: BTreeSet::new(),
        }
    }

    /// 判断指定功能是否已启用。
    pub fn enabled(&self, f: Feature) -> bool {
        self.enabled.contains(&f)
    }

    /// 判断 Apps 功能是否在具备 ChatGPT 鉴权时启用。
    pub fn apps_enabled_for_auth(&self, has_chatgpt_auth: bool) -> bool {
        self.enabled(Feature::Apps) && has_chatgpt_auth
    }

    /// 判断是否使用旧版 Landlock 沙箱。
    pub fn use_legacy_landlock(&self) -> bool {
        self.enabled(Feature::UseLegacyLandlock)
    }

    /// 启用指定功能，返回可链式调用的自身引用。
    pub fn enable(&mut self, f: Feature) -> &mut Self {
        self.enabled.insert(f);
        self
    }

    /// 禁用指定功能，返回可链式调用的自身引用。
    pub fn disable(&mut self, f: Feature) -> &mut Self {
        self.enabled.remove(&f);
        self
    }

    /// 根据布尔值启用或禁用指定功能。
    pub fn set_enabled(&mut self, f: Feature, enabled: bool) -> &mut Self {
        if enabled {
            self.enable(f)
        } else {
            self.disable(f)
        }
    }

    /// 强制记录一次遗留功能使用（即使别名与规范键名相同）。
    pub fn record_legacy_usage_force(&mut self, alias: &str, feature: Feature) {
        let (summary, details) = legacy_usage_notice(alias, feature);
        self.legacy_usages.insert(LegacyFeatureUsage {
            alias: alias.to_string(),
            feature,
            summary,
            details,
        });
    }

    /// 记录一次遗留功能使用（当别名与规范键名相同时跳过）。
    pub fn record_legacy_usage(&mut self, alias: &str, feature: Feature) {
        if alias == feature.key() {
            return;
        }
        self.record_legacy_usage_force(alias, feature);
    }

    /// 返回所有已记录的遗留功能使用情况的迭代器。
    pub fn legacy_feature_usages(&self) -> impl Iterator<Item = &LegacyFeatureUsage> + '_ {
        self.legacy_usages.iter()
    }

    /// 向 OpenTelemetry 发射功能状态指标。
    pub fn emit_metrics(&self, otel: &SessionTelemetry) {
        for feature in FEATURES {
            if matches!(feature.stage, Stage::Removed) {
                continue;
            }
            if self.enabled(feature.id) != feature.default_enabled {
                otel.counter(
                    "codex.feature.state",
                    /*inc*/ 1,
                    &[
                        ("feature", feature.key),
                        ("value", &self.enabled(feature.id).to_string()),
                    ],
                );
            }
        }
    }

    /// 应用一组键 -> 布尔值切换（例如来自 TOML）。
    pub fn apply_map(&mut self, m: &BTreeMap<String, bool>) {
        for (k, v) in m {
            match k.as_str() {
                "web_search_request" => {
                    self.record_legacy_usage_force(
                        "features.web_search_request",
                        Feature::WebSearchRequest,
                    );
                }
                "web_search_cached" => {
                    self.record_legacy_usage_force(
                        "features.web_search_cached",
                        Feature::WebSearchCached,
                    );
                }
                "tui_app_server" => {
                    continue;
                }
                "undo" => {
                    continue;
                }
                "js_repl" => {
                    continue;
                }
                "js_repl_tools_only" => {
                    continue;
                }
                "remote_control" => {
                    continue;
                }
                "apply_patch_freeform" => {
                    continue;
                }
                "tool_search" | "tool_search_always_defer_mcp_tools" | "apps_mcp_path_override" => {
                    continue;
                }
                "image_detail_original" | "resize_all_images" => {
                    continue;
                }
                "plugin_hooks" => {
                    continue;
                }
                "skill_env_var_dependency_prompt" => {
                    continue;
                }
                "terminal_resize_reflow" => {
                    continue;
                }
                "use_legacy_landlock" => {
                    self.record_legacy_usage_force(
                        "features.use_legacy_landlock",
                        Feature::UseLegacyLandlock,
                    );
                }
                _ => {}
            }
            match feature_for_key(k) {
                Some(feat) => {
                    if matches!(feat, Feature::TuiAppServer) {
                        continue;
                    }
                    if k != feat.key() {
                        self.record_legacy_usage(k.as_str(), feat);
                    }
                    if *v {
                        self.enable(feat);
                    } else {
                        self.disable(feat);
                    }
                }
                None => {
                    tracing::warn!("unknown feature key in config: {k}");
                }
            }
        }
    }

    /// 从多个配置来源合并解析生效的功能集合。
    ///
    /// 参数顺序为：基础配置、profile 配置、覆盖项。
    pub fn from_sources(
        base: FeatureConfigSource<'_>,
        profile: FeatureConfigSource<'_>,
        overrides: FeatureOverrides,
    ) -> Self {
        let mut features = Features::with_defaults();

        for source in [base, profile] {
            LegacyFeatureToggles {
                experimental_use_unified_exec_tool: source.experimental_use_unified_exec_tool,
            }
            .apply(&mut features);

            if let Some(feature_entries) = source.features {
                features.apply_toml(feature_entries);
            }
        }

        overrides.apply(&mut features);
        features.normalize_dependencies();

        features
    }

    /// 返回所有已启用功能的列表。
    pub fn enabled_features(&self) -> Vec<Feature> {
        self.enabled.iter().copied().collect()
    }

    /// 规范化功能间的依赖关系（例如启用 SpawnCsv 时自动启用 Collab）。
    pub fn normalize_dependencies(&mut self) {
        if self.enabled(Feature::SpawnCsv) && !self.enabled(Feature::Collab) {
            self.enable(Feature::Collab);
        }
        if self.enabled(Feature::CodeModeOnly) && !self.enabled(Feature::CodeMode) {
            self.enable(Feature::CodeMode);
        }
    }
}

fn legacy_usage_notice(alias: &str, feature: Feature) -> (String, Option<String>) {
    let canonical = feature.key();
    match feature {
        Feature::WebSearchRequest | Feature::WebSearchCached => {
            let label = match alias {
                "web_search" => "[features].web_search",
                "features.web_search_request" | "web_search_request" => {
                    "[features].web_search_request"
                }
                "features.web_search_cached" | "web_search_cached" => {
                    "[features].web_search_cached"
                }
                _ => alias,
            };
            let summary =
                format!("`{label}` is deprecated because web search is enabled by default.");
            (summary, Some(web_search_details().to_string()))
        }
        Feature::UseLegacyLandlock => {
            let label = match alias {
                "features.use_legacy_landlock" | "use_legacy_landlock" => {
                    "[features].use_legacy_landlock"
                }
                _ => alias,
            };
            let summary = format!("`{label}` is deprecated and will be removed soon.");
            let details =
                "Remove this setting to stop opting into the legacy Linux sandbox behavior."
                    .to_string();
            (summary, Some(details))
        }
        _ => {
            let label = if alias.contains('.') || alias.starts_with('[') {
                alias.to_string()
            } else {
                format!("[features].{alias}")
            };
            let summary = format!("`{label}` is deprecated. Use `[features].{canonical}` instead.");
            let details = if alias == canonical {
                None
            } else {
                Some(format!(
                    "Enable it with `--enable {canonical}` or `[features].{canonical}` in config.toml. See https://developers.openai.com/codex/config-basic#feature-flags for details."
                ))
            };
            (summary, details)
        }
    }
}

fn web_search_details() -> &'static str {
    "Set `web_search` to `\"live\"`, `\"indexed\"`, `\"cached\"`, or `\"disabled\"` at the top level (or under a profile) in config.toml if you want to override it."
}

/// 根据键名查找功能，支持规范键名与遗留别名。
pub fn feature_for_key(key: &str) -> Option<Feature> {
    for spec in FEATURES {
        if spec.key == key {
            return Some(spec.id);
        }
    }
    legacy::feature_for_key(key)
}

/// 根据规范键名查找功能（不包含遗留别名）。
pub fn canonical_feature_for_key(key: &str) -> Option<Feature> {
    FEATURES
        .iter()
        .find(|spec| spec.key == key)
        .map(|spec| spec.id)
}

/// 判断给定字符串是否为已知的功能切换键名。
pub fn is_known_feature_key(key: &str) -> bool {
    feature_for_key(key).is_some()
}

/// 可从 TOML 反序列化的功能表。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, JsonSchema)]
pub struct FeaturesToml {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_mode: Option<FeatureToml<CodeModeConfigToml>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_agent_v2: Option<FeatureToml<MultiAgentV2ConfigToml>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<FeatureToml<TokenBudgetConfigToml>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollout_budget: Option<FeatureToml<RolloutBudgetConfigToml>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_time_reminder: Option<FeatureToml<CurrentTimeReminderConfigToml>>,
    #[serde(default, rename = "apps_mcp_path_override", skip_serializing)]
    #[schemars(skip)]
    removed_apps_mcp_path_override: Option<FeatureToml<RemovedAppsMcpPathOverrideConfigToml>>,
    pub network_proxy: Option<FeatureToml<NetworkProxyConfigToml>>,
    /// 以规范或遗留功能名作为键的布尔功能切换。
    #[serde(flatten)]
    entries: BTreeMap<String, bool>,
}

impl Features {
    fn apply_toml(&mut self, features: &FeaturesToml) {
        let entries = features.entries();
        self.apply_map(&entries);
    }
}

impl FeaturesToml {
    /// 清除仅用于兼容、不再影响运行时行为的条目。
    pub fn clear_removed_compatibility_entries(&mut self) {
        self.removed_apps_mcp_path_override = None;
        self.entries.remove("apps_mcp_path_override");
    }

    /// 返回所有功能条目（含结构化配置功能展开后的布尔值）。
    pub fn entries(&self) -> BTreeMap<String, bool> {
        let mut entries = self.entries.clone();
        if let Some(enabled) = self.code_mode.as_ref().and_then(FeatureToml::enabled) {
            entries.insert(Feature::CodeMode.key().to_string(), enabled);
        }
        if let Some(enabled) = self.multi_agent_v2.as_ref().and_then(FeatureToml::enabled) {
            entries.insert(Feature::MultiAgentV2.key().to_string(), enabled);
        }
        if let Some(enabled) = self.token_budget.as_ref().and_then(FeatureToml::enabled) {
            entries.insert(Feature::TokenBudget.key().to_string(), enabled);
        }
        if let Some(enabled) = self.rollout_budget.as_ref().and_then(FeatureToml::enabled) {
            entries.insert(Feature::RolloutBudget.key().to_string(), enabled);
        }
        if let Some(enabled) = self
            .current_time_reminder
            .as_ref()
            .and_then(FeatureToml::enabled)
        {
            entries.insert(Feature::CurrentTimeReminder.key().to_string(), enabled);
        }
        if let Some(enabled) = self.network_proxy.as_ref().and_then(FeatureToml::enabled) {
            entries.insert(Feature::NetworkProxy.key().to_string(), enabled);
        }
        entries
    }

    /// 将解析后的启用状态写回此 TOML 结构，便于持久化。
    pub fn materialize_resolved_enabled(&mut self, features: &Features) {
        self.clear_removed_compatibility_entries();
        let Self {
            code_mode,
            multi_agent_v2,
            token_budget,
            rollout_budget,
            current_time_reminder,
            removed_apps_mcp_path_override: _,
            network_proxy,
            entries,
        } = self;
        for key in legacy::legacy_feature_keys() {
            entries.remove(key);
        }
        for spec in FEATURES {
            let enabled = features.enabled(spec.id);
            if spec.id == Feature::CodeMode {
                materialize_resolved_feature_enabled(code_mode, enabled);
            } else if spec.id == Feature::MultiAgentV2 {
                materialize_resolved_feature_enabled(multi_agent_v2, enabled);
            } else if spec.id == Feature::TokenBudget {
                materialize_resolved_feature_enabled(token_budget, enabled);
            } else if spec.id == Feature::RolloutBudget {
                materialize_resolved_feature_enabled(rollout_budget, enabled);
            } else if spec.id == Feature::CurrentTimeReminder {
                materialize_resolved_feature_enabled(current_time_reminder, enabled);
            } else if spec.id == Feature::NetworkProxy {
                materialize_resolved_feature_enabled(network_proxy, enabled);
            } else {
                entries.insert(spec.key.to_string(), enabled);
            }
        }
    }
}

fn materialize_resolved_feature_enabled<T: FeatureConfig>(
    feature: &mut Option<FeatureToml<T>>,
    enabled: bool,
) {
    match feature {
        Some(feature) => feature.set_enabled(enabled),
        None => *feature = Some(FeatureToml::Enabled(enabled)),
    }
}

impl From<BTreeMap<String, bool>> for FeaturesToml {
    fn from(entries: BTreeMap<String, bool>) -> Self {
        Self {
            entries,
            ..Default::default()
        }
    }
}

// 用于需要比单纯启用/禁用更多配置的功能，在 `[features]` 下使用自定义配置结构体。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[serde(untagged)]
pub enum FeatureToml<T> {
    Enabled(bool),
    Config(T),
}

impl<T: FeatureConfig> FeatureToml<T> {
    /// 返回此功能是否启用，`None` 表示未指定。
    pub fn enabled(&self) -> Option<bool> {
        match self {
            Self::Enabled(enabled) => Some(*enabled),
            Self::Config(config) => config.enabled(),
        }
    }

    /// 设置此功能的启用状态。
    pub fn set_enabled(&mut self, enabled: bool) {
        match self {
            Self::Enabled(value) => *value = enabled,
            Self::Config(config) => config.set_enabled(enabled),
        }
    }
}

// 当功能需要比单纯启用/禁用更多配置时，由自定义功能配置结构体实现的 trait。
pub trait FeatureConfig {
    fn enabled(&self) -> Option<bool>;
    fn set_enabled(&mut self, enabled: bool);
}

/// 所有功能定义的单一、易读注册表项。
#[derive(Debug, Clone, Copy)]
pub struct FeatureSpec {
    pub id: Feature,
    pub key: &'static str,
    pub stage: Stage,
    pub default_enabled: bool,
}

/// 所有功能定义的完整注册表。
pub const FEATURES: &[FeatureSpec] = &[
    // 稳定功能。
    FeatureSpec {
        id: Feature::GhostCommit,
        key: "undo",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ShellTool,
        key: "shell_tool",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::SecretAuthStorage,
        key: "secret_auth_storage",
        stage: Stage::Stable,
        default_enabled: cfg!(windows),
    },
    FeatureSpec {
        id: Feature::UnifiedExec,
        key: "unified_exec",
        stage: Stage::Stable,
        default_enabled: !cfg!(windows),
    },
    FeatureSpec {
        id: Feature::ShellZshFork,
        key: "shell_zsh_fork",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::UnifiedExecZshFork,
        key: "unified_exec_zsh_fork",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ShellSnapshot,
        key: "shell_snapshot",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::DeferredExecutor,
        key: "deferred_executor",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::JsRepl,
        key: "js_repl",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::CodeMode,
        key: "code_mode",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::CodeModeHost,
        key: "code_mode_host",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::CodeModeOnly,
        key: "code_mode_only",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::JsReplToolsOnly,
        key: "js_repl_tools_only",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::TerminalResizeReflow,
        key: "terminal_resize_reflow",
        stage: Stage::Removed,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::WebSearchRequest,
        key: "web_search_request",
        stage: Stage::Deprecated,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::WebSearchCached,
        key: "web_search_cached",
        stage: Stage::Deprecated,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::StandaloneWebSearch,
        key: "standalone_web_search",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::SearchTool,
        key: "search_tool",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::CodexGitCommit,
        key: "codex_git_commit",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::RuntimeMetrics,
        key: "runtime_metrics",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::Sqlite,
        key: "sqlite",
        stage: Stage::Removed,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::MemoryTool,
        key: "memories",
        stage: Stage::Experimental {
            name: "Memories",
            menu_description: "Allow Codex to create new memories from conversations and bring relevant memories into new conversations.",
            announcement: "NEW: Codex can now generate and use memories. Try it now with `/memories`",
        },
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::LocalThreadStoreCompression,
        key: "local_thread_store_compression",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::Chronicle,
        key: "chronicle",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ApplyPatchFreeform,
        key: "apply_patch_freeform",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ApplyPatchStreamingEvents,
        key: "apply_patch_streaming_events",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ExecPermissionApprovals,
        key: "exec_permission_approvals",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::CodexHooks,
        key: "hooks",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::RequestPermissionsTool,
        key: "request_permissions_tool",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::UseLinuxSandboxBwrap,
        key: "use_linux_sandbox_bwrap",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::UseLegacyLandlock,
        key: "use_legacy_landlock",
        stage: Stage::Deprecated,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::RequestRule,
        key: "request_rule",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::WindowsSandbox,
        key: "experimental_windows_sandbox",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::WindowsSandboxElevated,
        key: "elevated_windows_sandbox",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::RemoteModels,
        key: "remote_models",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::EnableRequestCompression,
        key: "enable_request_compression",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::NetworkProxy,
        key: "network_proxy",
        stage: Stage::Experimental {
            name: "Network proxy",
            menu_description: "Apply network proxy restrictions to sandboxed sessions that already have network access.",
            announcement: "NEW: Network proxy can now be enabled from /experimental. Restart Codex after enabling it.",
        },
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::RespectSystemProxy,
        key: "respect_system_proxy",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::Collab,
        key: "multi_agent",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::MultiAgentV2,
        key: "multi_agent_v2",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::MultiAgentMode,
        key: "multi_agent_mode",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::SpawnCsv,
        key: "enable_fanout",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::Apps,
        key: "apps",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::EnableMcpApps,
        key: "enable_mcp_apps",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::AppsMcpPathOverride,
        key: "apps_mcp_path_override",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ToolSearch,
        key: "tool_search",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ToolSearchAlwaysDeferMcpTools,
        key: "tool_search_always_defer_mcp_tools",
        stage: Stage::Removed,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::NonPrefixedMcpToolNames,
        key: "non_prefixed_mcp_tool_names",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::UnavailableDummyTools,
        key: "unavailable_dummy_tools",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ToolSuggest,
        key: "tool_suggest",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::Plugins,
        key: "plugins",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::PluginHooks,
        key: "plugin_hooks",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::InAppBrowser,
        key: "in_app_browser",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::BrowserUse,
        key: "browser_use",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::BrowserUseFullCdpAccess,
        key: "browser_use_full_cdp_access",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::BrowserUseExternal,
        key: "browser_use_external",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::ComputerUse,
        key: "computer_use",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::RemotePlugin,
        key: "remote_plugin",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::PluginSharing,
        key: "plugin_sharing",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::ExternalMigration,
        key: "external_migration",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ImageGeneration,
        key: "image_generation",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::ImageGenExt,
        key: "imagegenext",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ResizeAllImages,
        key: "resize_all_images",
        stage: Stage::Removed,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::ItemIds,
        key: "item_ids",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::SkillMcpDependencyInstall,
        key: "skill_mcp_dependency_install",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::SkillEnvVarDependencyPrompt,
        key: "skill_env_var_dependency_prompt",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::MentionsV2,
        key: "mentions_v2",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::Steer,
        key: "steer",
        stage: Stage::Removed,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::DefaultModeRequestUserInput,
        key: "default_mode_request_user_input",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::TerminalVisualizationInstructions,
        key: "terminal_visualization_instructions",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::GuardianApproval,
        key: "guardian_approval",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::Goals,
        key: "goals",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::TokenBudget,
        key: "token_budget",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::RolloutBudget,
        key: "rollout_budget",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::CurrentTimeReminder,
        key: "current_time_reminder",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::CollaborationModes,
        key: "collaboration_modes",
        stage: Stage::Removed,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::ToolCallMcpElicitation,
        key: "tool_call_mcp_elicitation",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::AuthElicitation,
        key: "auth_elicitation",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::Personality,
        key: "personality",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::Artifact,
        key: "artifact",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::FastMode,
        key: "fast_mode",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::RealtimeConversation,
        key: "realtime_conversation",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::RemoteControl,
        key: "remote_control",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ImageDetailOriginal,
        key: "image_detail_original",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::TuiAppServer,
        key: "tui_app_server",
        stage: Stage::Removed,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::PreventIdleSleep,
        key: "prevent_idle_sleep",
        stage: if cfg!(any(
            target_os = "macos",
            target_os = "linux",
            target_os = "windows"
        )) {
            Stage::Experimental {
                name: "Prevent sleep while running",
                menu_description: "Keep your computer awake while Codex is running a thread.",
                announcement: "NEW: Prevent sleep while running is now available in /experimental.",
            }
        } else {
            Stage::UnderDevelopment
        },
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::WorkspaceOwnerUsageNudge,
        key: "workspace_owner_usage_nudge",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ResponsesWebsockets,
        key: "responses_websockets",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::ResponsesWebsocketsV2,
        key: "responses_websockets_v2",
        stage: Stage::Removed,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::RemoteCompactionV2,
        key: "remote_compaction_v2",
        stage: Stage::Stable,
        default_enabled: true,
    },
    FeatureSpec {
        id: Feature::UseAgentIdentity,
        key: "use_agent_identity",
        stage: Stage::UnderDevelopment,
        default_enabled: false,
    },
    FeatureSpec {
        id: Feature::WorkspaceDependencies,
        key: "workspace_dependencies",
        stage: Stage::Stable,
        default_enabled: true,
    },
];

/// 生成一条关于已启用的开发中功能的不稳定警告事件。
///
/// 参数：
/// - `effective_features`：从 TOML 读取的原始功能表
/// - `suppress_unstable_features_warning`：是否抑制不稳定功能警告
/// - `features`：解析后的生效功能集合
/// - `config_path`：配置文件路径，用于在警告消息中提示用户如何抑制
pub fn unstable_features_warning_event(
    effective_features: Option<&Table>,
    suppress_unstable_features_warning: bool,
    features: &Features,
    config_path: &str,
) -> Option<Event> {
    if suppress_unstable_features_warning {
        return None;
    }

    let mut under_development_feature_keys = Vec::new();
    if let Some(table) = effective_features {
        for (key, value) in table {
            let is_enabled = value.as_bool() == Some(true)
                || value
                    .as_table()
                    .and_then(|table| table.get("enabled"))
                    .and_then(toml::Value::as_bool)
                    == Some(true);
            if !is_enabled {
                continue;
            }
            let Some(spec) = FEATURES.iter().find(|spec| spec.key == key.as_str()) else {
                continue;
            };
            if !features.enabled(spec.id) {
                continue;
            }
            if matches!(spec.stage, Stage::UnderDevelopment) {
                under_development_feature_keys.push(spec.key.to_string());
            }
        }
    }

    if under_development_feature_keys.is_empty() {
        return None;
    }

    under_development_feature_keys.sort();
    let under_development_feature_keys = under_development_feature_keys.join(", ");
    let message = format!(
        "Under-development features enabled: {under_development_feature_keys}. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in {config_path}."
    );
    Some(Event {
        id: String::new(),
        msg: EventMsg::Warning(WarningEvent { message }),
    })
}

#[cfg(test)]
mod tests;
