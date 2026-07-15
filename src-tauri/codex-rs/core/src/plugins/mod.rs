//! 插件（Plugins）相关能力聚合模块。
//!
//! 本模块汇总插件可发现性、注入、@提及解析与渲染等子模块，
//! 对外暴露统一的插件能力摘要与上下文渲染接口。

mod discoverable;
mod injection;
mod mentions;
mod render;
#[cfg(test)]
pub(crate) mod test_support;

pub(crate) use codex_plugin::PluginCapabilitySummary;

pub(crate) use discoverable::list_tool_suggest_discoverable_plugins;
pub(crate) use injection::build_plugin_injections;
pub(crate) use render::render_explicit_plugin_instructions;

pub(crate) use mentions::build_connector_slug_counts;
pub(crate) use mentions::build_skill_name_counts;
pub(crate) use mentions::collect_explicit_app_ids;
pub(crate) use mentions::collect_explicit_plugin_mentions;
pub(crate) use mentions::collect_tool_mentions_from_messages;
