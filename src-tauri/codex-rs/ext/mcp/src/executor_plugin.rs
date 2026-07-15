//! Executor plugin MCP 贡献模块。
//!
//! 该模块实现 [`SelectedExecutorPluginMcpContributor`]，根据 thread 选中的
//! executor plugin 动态贡献 MCP server 与 connector 声明。
//!
//! ## 缓存策略
//!
//! 每个 selected root 的 metadata 解析结果会被缓存到 thread store，
//! 直到 thread state 被丢弃。环境可用性不会使缓存失效，仅控制缓存的
//! metadata 是否被投影到模型步骤中。

use codex_connectors_extension::ExecutorPluginConnectorProvider;
use codex_core::config::Config;
use codex_core_plugins::ExecutorPluginProvider;
use codex_exec_server::EnvironmentManager;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::McpServerContribution;
use codex_extension_api::McpServerContributionContext;
use codex_extension_api::McpServerContributor;
use codex_protocol::capabilities::CapabilityRootLocation;
use codex_protocol::capabilities::SelectedCapabilityRoot;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use self::provider::ExecutorPluginMcpProvider;

mod provider;

/// 一个选中 package 的冻结 MCP 与 connector 声明。
///
/// 每个 server config 保留稳定的逻辑环境 ID。重连可能替换具体的
/// environment 实例而不改变该 authority。
#[derive(Clone)]
struct SelectedPluginMetadata {
    /// plugin ID（即 selected_root_id）
    plugin_id: String,
    /// plugin 显示名称
    plugin_display_name: String,
    /// MCP server 配置列表（name, config）
    servers: Vec<(String, codex_config::McpServerConfig)>,
    /// connector ID 列表
    connector_ids: Vec<String>,
}

/// Thread 级选中 executor plugin 的 MCP 状态。
///
/// 缓存每个 selected root 的解析结果。
#[derive(Default)]
pub(crate) struct SelectedExecutorPluginMcpState {
    /// 缓存列表（按 selected root 索引）
    cache: Mutex<Vec<CachedSelectedRoot>>,
}

/// 单个 selected root 的缓存条目。
struct CachedSelectedRoot {
    /// 选中的 capability root
    root: SelectedCapabilityRoot,
    /// 解析后的 metadata（None 表示该 root 非 plugin 或无 capabilities）
    metadata: Option<SelectedPluginMetadata>,
}

/// 选中 executor plugin 的 MCP contributor。
///
/// 组合三个 provider：
/// - `plugin_provider`：解析 selected root 对应的 plugin
/// - `mcp_provider`：加载 plugin 的 MCP server 声明
/// - `connector_provider`：加载 plugin 的 connector 声明
pub(crate) struct SelectedExecutorPluginMcpContributor {
    /// plugin 解析 provider
    plugin_provider: ExecutorPluginProvider,
    /// MCP server 加载 provider
    mcp_provider: ExecutorPluginMcpProvider,
    /// connector 加载 provider
    connector_provider: ExecutorPluginConnectorProvider,
}

impl SelectedExecutorPluginMcpContributor {
    /// 创建一个新的 contributor。
    pub(crate) fn new(environment_manager: Arc<EnvironmentManager>) -> Self {
        Self {
            plugin_provider: ExecutorPluginProvider::new(Arc::clone(&environment_manager)),
            mcp_provider: ExecutorPluginMcpProvider,
            connector_provider: ExecutorPluginConnectorProvider,
        }
    }

    /// 返回一个稳定 selected root 的 metadata。
    ///
    /// 成功解析（包括 root 非 plugin 或无 capabilities 的情况）会被缓存
    /// 直到 thread state 被丢弃。环境可用性不会使缓存失效，仅控制缓存的
    /// metadata 是否被投影到模型步骤中。
    async fn metadata_for_root(
        &self,
        state: &SelectedExecutorPluginMcpState,
        selected_root: &SelectedCapabilityRoot,
    ) -> Option<SelectedPluginMetadata> {
        // 先查缓存
        if let Some(cached) = state
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find(|cached| cached.root == *selected_root)
        {
            return cached.metadata.clone();
        }

        // 缓存未命中：解析 selected root 对应的 plugin
        let plugin = match self.plugin_provider.resolve_bound(selected_root).await {
            Ok(plugin) => plugin,
            Err(err) => {
                tracing::warn!(
                    selected_root = selected_root.id,
                    error = %err,
                    "failed to resolve selected executor plugin"
                );
                return None;
            }
        };
        let metadata = match plugin {
            Some(plugin) => {
                // 加载 MCP server 声明
                let servers = self.mcp_provider.load(&plugin).await.unwrap_or_else(|err| {
                    tracing::warn!(
                        selected_root = selected_root.id,
                        error = %err,
                        "failed to load selected executor plugin MCP servers"
                    );
                    Vec::new()
                });
                // 加载 connector 声明
                let connector_ids = self
                    .connector_provider
                    .load(&plugin)
                    .await
                    .unwrap_or_else(|err| {
                        tracing::warn!(
                            selected_root = selected_root.id,
                            error = %err,
                            "failed to load selected executor plugin connectors"
                        );
                        Vec::new()
                    })
                    .into_iter()
                    .map(|declaration| declaration.connector_id.0)
                    .collect();
                Some(SelectedPluginMetadata {
                    plugin_id: plugin.plugin().selected_root_id().to_string(),
                    plugin_display_name: plugin.plugin().manifest().display_name().to_string(),
                    servers,
                    connector_ids,
                })
            }
            None => None,
        };
        // 写入缓存（双重检查，避免并发重复写入）
        let mut cache = state
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cached) = cache.iter().find(|cached| cached.root == *selected_root) {
            return cached.metadata.clone();
        }
        cache.push(CachedSelectedRoot {
            root: selected_root.clone(),
            metadata: metadata.clone(),
        });
        metadata
    }
}

impl McpServerContributor<Config> for SelectedExecutorPluginMcpContributor {
    fn id(&self) -> &'static str {
        "selected_executor_plugin_mcp"
    }

    fn contribute<'a>(
        &'a self,
        context: McpServerContributionContext<'a, Config>,
    ) -> ExtensionFuture<'a, Vec<McpServerContribution>> {
        Box::pin(async move {
            let Some(thread_init) = context.thread_init() else {
                return Vec::new();
            };
            let Some(thread_store) = context.thread_store() else {
                return Vec::new();
            };
            let Some(selected_roots) = thread_init.get::<Vec<SelectedCapabilityRoot>>() else {
                return Vec::new();
            };
            let state = thread_store.get_or_init(SelectedExecutorPluginMcpState::default);
            let mut contributions = Vec::new();

            for (selection_order, selected_root) in selected_roots.iter().enumerate() {
                let CapabilityRootLocation::Environment { environment_id, .. } =
                    &selected_root.location;
                // 跳过不可用的 environment
                if context
                    .available_environment_ids()
                    .is_some_and(|available| {
                        !available
                            .iter()
                            .any(|available| available == environment_id)
                    })
                {
                    continue;
                }
                let Some(plugin) = self.metadata_for_root(&state, selected_root).await else {
                    continue;
                };
                // 合并 plugin 声明的 server 与 config 中的 server requirements
                let mut servers = plugin.servers.iter().cloned().collect::<HashMap<_, _>>();
                context
                    .config()
                    .apply_plugin_mcp_server_requirements(&plugin.plugin_id, &mut servers);
                // 按名称排序以保证稳定输出
                let mut servers = servers.into_iter().collect::<Vec<_>>();
                servers.sort_unstable_by(|left, right| left.0.cmp(&right.0));
                contributions.extend(servers.into_iter().map(|(name, config)| {
                    McpServerContribution::SelectedPlugin {
                        name,
                        plugin_id: plugin.plugin_id.clone(),
                        plugin_display_name: plugin.plugin_display_name.clone(),
                        selection_order,
                        config: Box::new(config),
                    }
                }));
                // 若 plugin 声明了 connector，添加 connector 贡献
                if !plugin.connector_ids.is_empty() {
                    contributions.push(McpServerContribution::SelectedPluginConnectors {
                        plugin_id: plugin.plugin_id,
                        plugin_display_name: plugin.plugin_display_name,
                        connector_ids: plugin.connector_ids,
                    });
                }
            }

            contributions
        })
    }
}
