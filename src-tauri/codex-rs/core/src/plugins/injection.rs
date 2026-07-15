//! 插件上下文注入逻辑。
//!
//! 本模块将显式 @提及的插件转换为可注入对话上下文的 `ResponseItem`，
//! 为模型提供该插件可用的 MCP server、app 与 skill 前缀指引。

use std::collections::BTreeSet;

use codex_connectors::metadata::connector_display_label;
use codex_protocol::models::ResponseItem;

use crate::connectors;
use crate::context::ContextualUserFragment;
use crate::context::PluginInstructions;
use crate::plugins::PluginCapabilitySummary;
use crate::plugins::render_explicit_plugin_instructions;
use codex_mcp::CODEX_APPS_MCP_SERVER_NAME;
use codex_mcp::ToolInfo;

/// 构建插件注入项列表。
///
/// 对每个显式 @提及的插件，收集其在当前会话中可用的 MCP server 与 app，
/// 渲染为指引文本后封装为 `ResponseItem` 注入上下文。
/// 若 `mentioned_plugins` 为空，返回空列表。
pub(crate) fn build_plugin_injections(
    mentioned_plugins: &[PluginCapabilitySummary],
    mcp_tools: &[ToolInfo],
    available_connectors: &[connectors::AppInfo],
) -> Vec<ResponseItem> {
    if mentioned_plugins.is_empty() {
        return Vec::new();
    }

    // 将每个显式 @提及的插件转换为 developer hint，
    // 指引模型使用该插件可见的 MCP server、已启用的 app 与 skill 前缀。
    mentioned_plugins
        .iter()
        .filter_map(|plugin| {
            let available_mcp_servers = mcp_tools
                .iter()
                .filter(|tool| {
                    tool.server_name != CODEX_APPS_MCP_SERVER_NAME
                        && tool
                            .plugin_display_names
                            .iter()
                            .any(|plugin_name| plugin_name == &plugin.display_name)
                })
                .map(|tool| tool.server_name.clone())
                .collect::<BTreeSet<String>>()
                .into_iter()
                .collect::<Vec<_>>();
            let available_apps = available_connectors
                .iter()
                .filter(|connector| {
                    connector.is_enabled
                        && connector
                            .plugin_display_names
                            .iter()
                            .any(|plugin_name| plugin_name == &plugin.display_name)
                })
                .map(connector_display_label)
                .collect::<BTreeSet<String>>()
                .into_iter()
                .collect::<Vec<_>>();
            render_explicit_plugin_instructions(plugin, &available_mcp_servers, &available_apps)
                .map(PluginInstructions::new)
                .map(ContextualUserFragment::into)
        })
        .collect()
}
