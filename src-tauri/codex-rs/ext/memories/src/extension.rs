//! Memories extension 主实现模块。
//!
//! 该模块实现 [`MemoriesExtension`]，组合以下 extension contributor：
//!
//! - [`ThreadLifecycleContributor`]：thread 启动时捕获配置
//! - [`ConfigContributor`]：配置变更时更新 thread store
//! - [`ContextContributor`]：注入 memory 读取路径 prompt
//! - [`ToolContributor`]：贡献 memories 工具（list/read/search/add_ad_hoc_note）

use std::sync::Arc;

use codex_core::config::Config;
use codex_extension_api::ConfigContributor;
use codex_extension_api::ContextContributor;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::PromptFragment;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::ToolContributor;
use codex_features::Feature;
use codex_otel::MetricsClient;
use codex_utils_absolute_path::AbsolutePathBuf;

use crate::local::LocalMemoriesBackend;
use crate::prompts::build_memory_tool_developer_instructions;
use crate::tools;

/// Memories extension，贡献 memory 读取路径 prompt 和 memory 读取工具。
#[derive(Clone, Default)]
pub(crate) struct MemoriesExtension {
    /// 遥测客户端（可选）
    metrics_client: Option<MetricsClient>,
}

impl MemoriesExtension {
    /// 创建 extension 实例。
    fn new(metrics_client: Option<MetricsClient>) -> Self {
        Self { metrics_client }
    }
}

/// Thread 级 memories 配置，在 thread 启动时从全局配置捕获。
#[derive(Clone, Debug)]
pub(crate) struct MemoriesExtensionConfig {
    /// 是否启用 memories 功能
    pub(crate) enabled: bool,
    /// 是否贡献专用工具（而非内联在 system prompt 中）
    pub(crate) dedicated_tools: bool,
    /// Codex 主目录路径
    pub(crate) codex_home: AbsolutePathBuf,
}

impl MemoriesExtensionConfig {
    /// 从全局配置提取 thread 级配置。
    fn from_config(config: &Config) -> Self {
        Self {
            enabled: config.features.enabled(Feature::MemoryTool) && config.memories.use_memories,
            dedicated_tools: config.memories.dedicated_tools,
            codex_home: config.codex_home.clone(),
        }
    }
}

impl ContextContributor for MemoriesExtension {
    /// 贡献 memory 读取路径 prompt，注入到 developer instructions 中。
    fn contribute_thread_context<'a>(
        &'a self,
        _session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<PromptFragment>> + Send + 'a>> {
        Box::pin(async move {
            let Some(config) = thread_store.get::<MemoriesExtensionConfig>() else {
                return Vec::new();
            };
            if !config.enabled {
                return Vec::new();
            }

            build_memory_tool_developer_instructions(&config.codex_home)
                .await
                .map(PromptFragment::developer_policy)
                .into_iter()
                .collect()
        })
    }
}

impl ThreadLifecycleContributor<Config> for MemoriesExtension {
    /// thread 启动时：从全局配置捕获 thread 级 memories 配置。
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            input
                .thread_store
                .insert(MemoriesExtensionConfig::from_config(input.config));
        })
    }
}

impl ConfigContributor<Config> for MemoriesExtension {
    /// 配置变更时：更新 thread store 中的 memories 配置。
    fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &Config,
        new_config: &Config,
    ) {
        thread_store.insert(MemoriesExtensionConfig::from_config(new_config));
    }
}

impl ToolContributor for MemoriesExtension {
    /// 贡献 memories 工具列表。
    ///
    /// 仅在 `enabled` 和 `dedicated_tools` 均为 `true` 时贡献工具。
    fn tools(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn codex_extension_api::ToolExecutor<codex_extension_api::ToolCall>>> {
        let Some(config) = thread_store.get::<MemoriesExtensionConfig>() else {
            return Vec::new();
        };
        if !config.enabled || !config.dedicated_tools {
            return Vec::new();
        }

        tools::memory_tools(
            LocalMemoriesBackend::from_codex_home(&config.codex_home),
            self.metrics_client.clone(),
        )
    }
}

/// 安装 memories extension contributor 到 extension registry。
///
/// 注册以下 contributor：
/// - `ThreadLifecycleContributor`：thread 启动时捕获配置
/// - `ConfigContributor`：配置变更时更新
/// - `ContextContributor`：注入 memory prompt
/// - `ToolContributor`：贡献 memories 工具
pub fn install(
    registry: &mut ExtensionRegistryBuilder<Config>,
    metrics_client: Option<MetricsClient>,
) {
    let extension = Arc::new(MemoriesExtension::new(metrics_client));
    registry.thread_lifecycle_contributor(extension.clone());
    registry.config_contributor(extension.clone());
    registry.prompt_contributor(extension.clone());
    registry.tool_contributor(extension);
}
