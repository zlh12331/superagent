//! MCP extension 模块。
//!
//! 该模块提供 codex 内置的 MCP（Model Context Protocol）server 贡献：
//!
//! - **HostedPluginRuntimeExtension**：codex apps MCP server，根据 `apps` feature
//!   开关动态添加/移除
//! - **SelectedExecutorPluginMcpContributor**：根据 thread 选中的 executor plugin
//!   动态贡献 MCP server 与 connector 声明

use codex_core::config::Config;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::McpServerContribution;
use codex_extension_api::McpServerContributionContext;
use codex_extension_api::McpServerContributor;
use codex_mcp::CODEX_APPS_MCP_SERVER_NAME;
use codex_mcp::hosted_plugin_runtime_mcp_server_config;

mod executor_plugin;

/// Hosted plugin runtime extension。
///
/// 根据 `apps` feature 开关动态贡献或移除 codex apps MCP server。
struct HostedPluginRuntimeExtension;

impl McpServerContributor<Config> for HostedPluginRuntimeExtension {
    fn id(&self) -> &'static str {
        "hosted_plugin_runtime"
    }

    fn contribute<'a>(
        &'a self,
        context: McpServerContributionContext<'a, Config>,
    ) -> ExtensionFuture<'a, Vec<McpServerContribution>> {
        Box::pin(async move {
            let config = context.config();
            let name = CODEX_APPS_MCP_SERVER_NAME.to_string();
            // apps feature 未启用时移除 MCP server
            if !config.features.enabled(codex_features::Feature::Apps) {
                return vec![McpServerContribution::Remove { name }];
            }

            // apps feature 启用时添加/更新 MCP server 配置
            vec![McpServerContribution::Set {
                name,
                config: Box::new(hosted_plugin_runtime_mcp_server_config(
                    &config.chatgpt_base_url,
                    config.apps_mcp_product_sku.as_deref(),
                )),
            }]
        })
    }
}

/// 安装 hosted plugin runtime MCP contributor。
pub fn install(builder: &mut ExtensionRegistryBuilder<Config>) {
    builder.mcp_server_contributor(std::sync::Arc::new(HostedPluginRuntimeExtension));
}

/// 安装 thread 选中的 executor plugin 的 MCP server 发现 contributor。
///
/// 该 contributor 会根据 thread 选中的 executor plugin 动态贡献
/// MCP server 与 connector 声明。
pub fn install_executor_plugins(
    builder: &mut ExtensionRegistryBuilder<Config>,
    environment_manager: std::sync::Arc<codex_exec_server::EnvironmentManager>,
) {
    builder.mcp_server_contributor(std::sync::Arc::new(
        executor_plugin::SelectedExecutorPluginMcpContributor::new(environment_manager),
    ));
}
