//! 插件系统核心模块。
//!
//! 本 crate 实现 codex 的插件管理全流程，包括：
//! - 插件市场（marketplace）的添加、移除、升级
//! - 插件清单（manifest）解析与校验
//! - 插件加载、安装与卸载
//! - 远程插件与本地插件的支持
//! - 插件工具建议（tool suggest）元数据管理
//! - 启动时的插件状态同步
//!
//! 插件市场名称分为多类：OpenAI 精选（curated）、OpenAI API 精选、
//! OpenAI 内置（bundled）等，通过常量统一管理。

// ========== 子模块声明 ==========

mod app_mcp_routing;
mod discoverable;
/// 已安装市场模块，管理本地已添加的插件市场列表。
pub mod installed_marketplaces;
/// 插件加载器模块，负责从市场或本地路径加载插件。
pub mod loader;
mod manager;
/// 插件清单模块，定义清单文件格式与解析逻辑。
pub mod manifest;
/// 插件市场模块，提供市场查询与浏览功能。
pub mod marketplace;
/// 市场添加模块，实现添加新市场的流程。
pub mod marketplace_add;
mod marketplace_policy;
/// 市场移除模块，实现移除已安装市场的流程。
pub mod marketplace_remove;
/// 市场升级模块，实现市场内容的更新流程。
pub mod marketplace_upgrade;
mod npm_source;
mod plugin_bundle_archive;
mod provider;
/// 远程插件模块，处理远程市场插件的发现与下载。
pub mod remote;
/// 远程 bundle 插件模块，处理 bundle 格式的远程插件。
pub mod remote_bundle;
/// 远程 legacy 插件模块，兼容旧版远程插件格式。
pub mod remote_legacy;
/// 启动同步模块，在应用启动时同步插件状态。
pub mod startup_sync;
/// 插件存储模块，管理插件的本地存储路径与文件。
pub mod store;
#[cfg(test)]
mod test_support;
/// 插件开关模块，管理插件的启用/禁用状态。
pub mod toggles;
mod tool_suggest_metadata;

// ========== 市场名称常量 ==========

/// OpenAI 精选市场名称。
pub const OPENAI_CURATED_MARKETPLACE_NAME: &str = "openai-curated";
/// OpenAI API 精选市场名称。
pub const OPENAI_API_CURATED_MARKETPLACE_NAME: &str = "openai-api-curated";
/// OpenAI 内置市场名称。
pub const OPENAI_BUNDLED_MARKETPLACE_NAME: &str = "openai-bundled";
pub(crate) const OPENAI_BUNDLED_ALPHA_MARKETPLACE_NAME: &str = "openai-bundled-alpha";
pub(crate) const OPENAI_PRIMARY_RUNTIME_MARKETPLACE_NAME: &str = "openai-primary-runtime";

/// 判断给定市场名称是否为 OpenAI 精选市场（curated 或 api-curated）。
pub fn is_openai_curated_marketplace_name(marketplace_name: &str) -> bool {
    marketplace_name == OPENAI_CURATED_MARKETPLACE_NAME
        || marketplace_name == OPENAI_API_CURATED_MARKETPLACE_NAME
}

// ========== 类型别名 ==========

/// 已加载的插件，泛型参数固定为 codex 的 MCP 服务器配置类型。
pub type LoadedPlugin = codex_plugin::LoadedPlugin<codex_config::McpServerConfig>;
/// 插件加载结果，泛型参数固定为 codex 的 MCP 服务器配置类型。
pub type PluginLoadOutcome = codex_plugin::PluginLoadOutcome<codex_config::McpServerConfig>;

// ========== 重导出 ==========

/// 判断 Apps 路由是否可用。
pub use app_mcp_routing::apps_route_available;
/// 可发现插件的工具建议项，用于 tool suggest 流程。
pub use discoverable::ToolSuggestDiscoverablePlugin;
/// 工具建议插件发现的输入参数。
pub use discoverable::ToolSuggestPluginDiscoveryInput;
/// 插件 hook 加载结果。
pub use loader::PluginHookLoadOutcome;
/// 已配置的市场条目。
pub use manager::ConfiguredMarketplace;
/// 已配置市场列表的加载结果。
pub use manager::ConfiguredMarketplaceListOutcome;
/// 已配置市场中的单个插件条目。
pub use manager::ConfiguredMarketplacePlugin;
/// 插件详情。
pub use manager::PluginDetail;
/// 插件详情不可用的原因。
pub use manager::PluginDetailsUnavailableReason;
/// 插件安装错误。
pub use manager::PluginInstallError;
/// 插件安装结果。
pub use manager::PluginInstallOutcome;
/// 插件安装请求。
pub use manager::PluginInstallRequest;
/// 插件列表后台任务选项。
pub use manager::PluginListBackgroundTaskOptions;
/// 插件读取结果。
pub use manager::PluginReadOutcome;
/// 插件读取请求。
pub use manager::PluginReadRequest;
/// 插件卸载错误。
pub use manager::PluginUninstallError;
/// 插件配置输入。
pub use manager::PluginsConfigInput;
/// 插件管理器，提供插件安装/卸载/查询的统一 API。
pub use manager::PluginsManager;
/// 推荐插件候选输入。
pub use manager::RecommendedPluginCandidatesInput;
/// 获取允许配置的市场名称列表。
pub use marketplace_policy::allowed_configured_marketplace_names;
/// 插件市场升级错误（重导出别名）。
pub use marketplace_upgrade::ConfiguredMarketplaceUpgradeError as PluginMarketplaceUpgradeError;
/// 插件市场升级结果（重导出别名）。
pub use marketplace_upgrade::ConfiguredMarketplaceUpgradeOutcome as PluginMarketplaceUpgradeOutcome;
/// 执行器插件提供者。
pub use provider::ExecutorPluginProvider;
/// 执行器插件提供者错误。
pub use provider::ExecutorPluginProviderError;
/// 已解析的执行器插件。
pub use provider::ResolvedExecutorPlugin;
/// 推荐插件。
pub use remote::RecommendedPlugin;
/// 推荐插件模式。
pub use remote::RecommendedPluginsMode;
