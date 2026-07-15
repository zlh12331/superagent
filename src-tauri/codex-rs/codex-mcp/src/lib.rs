//! MCP（Model Context Protocol）集成核心模块。
//!
//! 本 crate 汇聚了 codex 与 MCP 服务器交互所需的全部公共 API，包括：
//! - 连接管理（`McpConnectionManager`）
//! - 工具发现与可见性控制
//! - 资源读取与分页
//! - OAuth 鉴权与作用域解析
//! - Codex Apps 连接器鉴权 elicitation
//! - 插件 MCP 配置解析
//! - 运行时沙箱状态管理
//!
//! 各子模块通过 `pub use` 重导出关键类型与函数，方便上层 crate 统一引用。

// ========== 连接管理 ==========

/// MCP 连接管理器，负责维护与各 MCP 服务器的连接生命周期。
pub use connection_manager::McpConnectionManager;
/// 判断指定工具是否对模型可见（model-visible）。
pub use connection_manager::tool_is_model_visible;

// ========== Elicitation ==========

/// Elicitation 请求路由器，将 MCP 服务器的 elicitation 请求分发到合适的审核者。
pub use elicitation::ElicitationRequestRouter;
/// Elicitation 审核请求，描述一次需要用户/系统确认的 elicitation。
pub use elicitation::ElicitationReviewRequest;
/// Elicitation 审核者 trait，实现该 trait 可自定义审核行为。
pub use elicitation::ElicitationReviewer;
/// Elicitation 审核者句柄，用于注销审核者或触发回调。
pub use elicitation::ElicitationReviewerHandle;

// ========== 资源客户端 ==========

/// MCP 资源客户端，用于读取 MCP 服务器暴露的资源。
pub use resource_client::McpResourceClient;
/// MCP 资源客户端缓存键，避免对同一资源重复建立客户端。
pub use resource_client::McpResourceClientCacheKey;
/// MCP 资源分页，表示一次资源读取返回的单页内容。
pub use resource_client::McpResourcePage;
/// MCP 资源读取结果，包含资源内容与可能的分页游标。
pub use resource_client::McpResourceReadResult;

// ========== RMCP 客户端 ==========

/// RMCP 沙箱状态元能力标识，用于声明当前会话的沙箱状态。
pub use rmcp_client::MCP_SANDBOX_STATE_META_CAPABILITY;

// ========== 运行时 ==========

/// MCP 运行时上下文，为 MCP 工具调用提供会话级共享状态。
pub use runtime::McpRuntimeContext;
/// 沙箱状态枚举，描述当前执行环境的隔离级别。
pub use runtime::SandboxState;

// ========== 工具 ==========

/// 工具信息，描述单个 MCP 工具的元数据。
pub use tools::ToolInfo;

// ========== 目录（catalog）==========

/// MCP 目录构建器，用于按来源汇总 MCP 服务器配置。
pub use catalog::McpCatalogBuilder;
/// MCP 插件归属信息，标记某个 MCP 服务器来自哪个插件。
pub use catalog::McpPluginAttribution;
/// MCP 服务器冲突，描述两个来源对同一服务器名称的争用。
pub use catalog::McpServerConflict;
/// MCP 服务器冲突处理动作，指示冲突发生时的自动解决策略。
pub use catalog::McpServerConflictAction;
/// MCP 服务器注册项，表示一条待解析的服务器配置。
pub use catalog::McpServerRegistration;
/// MCP 服务器来源，标识配置来自用户、插件还是内置。
pub use catalog::McpServerSource;
/// 已解析的 MCP 目录，包含所有来源合并后的最终服务器列表。
pub use catalog::ResolvedMcpCatalog;
/// 已解析的单个 MCP 服务器配置。
pub use catalog::ResolvedMcpServer;

// ========== MCP 配置 ==========

/// Codex Apps 内置 MCP 服务器名称。
pub use mcp::CODEX_APPS_MCP_SERVER_NAME;
/// MCP 配置根类型，聚合所有 MCP 服务器与工具配置。
pub use mcp::McpConfig;
/// 工具插件来源标记，标识工具是由哪个插件提供的。
pub use mcp::ToolPluginProvenance;
/// 生效的 MCP 服务器配置，已应用合并与覆盖规则后的最终结果。
pub use server::EffectiveMcpServer;

// ========== 鉴权 Elicitation ==========

/// Codex Apps 鉴权 elicitation 请求。
pub use auth_elicitation::CodexAppsAuthElicitation;
/// Codex Apps 鉴权 elicitation 计划，描述需要执行的鉴权步骤。
pub use auth_elicitation::CodexAppsAuthElicitationPlan;
/// Codex Apps 连接器鉴权失败信息。
pub use auth_elicitation::CodexAppsConnectorAuthFailure;
/// 工具元数据中标记 Codex Apps 来源的键名。
pub use auth_elicitation::MCP_TOOL_CODEX_APPS_META_KEY;
/// 获取鉴权 elicitation 的完成结果。
pub use auth_elicitation::auth_elicitation_completed_result;
/// 生成鉴权 elicitation 的唯一标识。
pub use auth_elicitation::auth_elicitation_id;
/// 构建一次 Codex Apps 鉴权 elicitation 请求。
pub use auth_elicitation::build_auth_elicitation;
/// 构建鉴权 elicitation 计划。
pub use auth_elicitation::build_auth_elicitation_plan;
/// 从工具调用结果中提取连接器鉴权失败信息。
pub use auth_elicitation::connector_auth_failure_from_tool_result;

// ========== Codex Apps 工具缓存 ==========

/// Codex Apps 工具缓存，避免重复发现工具。
pub use codex_apps_cache::CodexAppsToolsCache;
/// Codex Apps 工具缓存键。
pub use codex_apps_cache::CodexAppsToolsCacheKey;
/// 构造 Codex Apps 工具缓存键的辅助函数。
pub use codex_apps_cache::codex_apps_tools_cache_key;

// ========== MCP 配置函数 ==========

/// 构造 Codex Apps MCP 服务器配置。
pub use mcp::codex_apps_mcp_server_config;
/// 从配置中收集所有已配置的 MCP 服务器。
pub use mcp::configured_mcp_servers;
/// 计算生效的 MCP 服务器列表。
pub use mcp::effective_mcp_servers;
/// 从已配置服务器列表计算生效服务器列表。
pub use mcp::effective_mcp_servers_from_configured;
/// 判断 host-owned Codex Apps 是否启用。
pub use mcp::host_owned_codex_apps_enabled;
/// 构造宿主插件运行时 MCP 服务器配置。
pub use mcp::hosted_plugin_runtime_mcp_server_config;
/// 解析工具的插件来源标记。
pub use mcp::tool_plugin_provenance;

// ========== 插件 MCP 配置解析 ==========

/// 插件 MCP 配置解析结果。
pub use plugin_config::PluginMcpConfigParseOutcome;
/// 插件 MCP 服务器解析错误。
pub use plugin_config::PluginMcpServerParseError;
/// 解析执行器插件的 MCP 配置。
pub use plugin_config::parse_executor_plugin_mcp_config;
/// 解析插件的 MCP 配置。
pub use plugin_config::parse_plugin_mcp_config;

// ========== MCP 状态快照 ==========

/// MCP 服务器状态快照，用于 UI 展示当前连接状态。
pub use mcp::McpServerStatusSnapshot;
/// MCP 快照详情，包含更细粒度的状态信息。
pub use mcp::McpSnapshotDetail;
/// 收集 MCP 服务器状态快照（带详情）。
pub use mcp::collect_mcp_server_status_snapshot_with_detail;
/// 读取 MCP 资源内容。
pub use mcp::read_mcp_resource;

// ========== OAuth ==========

/// MCP 鉴权状态条目，描述单个服务器的鉴权状态。
pub use mcp::McpAuthStatusEntry;
/// MCP OAuth 登录配置。
pub use mcp::McpOAuthLoginConfig;
/// MCP OAuth 登录支持信息。
pub use mcp::McpOAuthLoginSupport;
/// MCP OAuth 作用域来源。
pub use mcp::McpOAuthScopesSource;
/// 已解析的 MCP OAuth 作用域。
pub use mcp::ResolvedMcpOAuthScopes;
/// 计算各 MCP 服务器的鉴权状态。
pub use mcp::compute_auth_statuses;
/// 发现服务器支持的 OAuth 作用域。
pub use mcp::discover_supported_scopes;
/// 使用自定义 HTTP 客户端发现服务器支持的 OAuth 作用域。
pub use mcp::discover_supported_scopes_with_http_client;
/// 查询服务器的 OAuth 登录支持情况。
pub use mcp::oauth_login_support;
/// 使用自定义 HTTP 客户端查询 OAuth 登录支持情况。
pub use mcp::oauth_login_support_with_http_client;
/// 解析最终生效的 OAuth 作用域。
pub use mcp::resolve_oauth_scopes;
/// 判断是否应在不带作用域的情况下重试鉴权。
pub use mcp::should_retry_without_scopes;

// ========== 权限提示 ==========

/// MCP 权限提示自动批准上下文。
pub use mcp::McpPermissionPromptAutoApproveContext;
/// 判断 MCP 权限提示是否可自动批准。
pub use mcp::mcp_permission_prompt_is_auto_approved;
/// 构造 MCP 工具名的限定前缀。
pub use mcp::qualified_mcp_tool_name_prefix;
/// 声明 OpenAI 文件输入参数的已知名称集合。
pub use tools::declared_openai_file_input_param_names;

// ========== 子模块声明 ==========

pub(crate) mod auth_elicitation;
mod catalog;
pub(crate) mod codex_apps;
pub(crate) mod codex_apps_cache;
pub(crate) mod connection_manager;
pub(crate) mod elicitation;
pub(crate) mod mcp;
mod plugin_config;
mod resource_client;
pub(crate) mod rmcp_client;
pub(crate) mod runtime;
pub(crate) mod server;
pub(crate) mod tools;
